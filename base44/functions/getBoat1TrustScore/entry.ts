import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// BOAT WORKS 1号艇信頼スコア計算（フル版・DB履歴データ使用）
//
// 目的: 1号艇の信頼度を0-100点で算出し、内訳・買える理由・不安材料を実データから生成する。
//
// データソース:
// - RaceEntry: 当日出走表（national/local/motor/ST/F/c1等）
// - RaceResult: 過去レース結果（boat1_registration_numberで絞り込み・1着率を計算）
// - AppSettings: スコア重み
//
// スコア構成:
// A. 選手基本力 (max 20) - 全国勝率・級別・2連率
// B. 1コース信頼性 (max 20) - 過去の1号艇時1着率（場別・全体）+ エントリーc1_win_rate
// C. 当地相性 (max 15) - 当地勝率・当地2連率
// D. ST評価 (max 10) - 平均ST
// E. モーター評価 (max 10) - モーター2連率・3連率
// H. リスク減点 (max -15) - F数・低調モーター・当地苦手・ST遅い
//
// データ不足項目は0点扱いせず分母から除外して換算。

function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }

function gradeToScore(grade: string | null | undefined): number | null {
  if (!grade) return null;
  const g = String(grade).toUpperCase();
  if (g === "A1") return 1.0;
  if (g === "A2") return 0.85;
  if (g === "B1") return 0.65;
  if (g === "B2") return 0.45;
  return 0.5;
}

function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

export default async function(req: any) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceId = body.race_id;
    if (!raceId) return Response.json({ status: "error", message: "race_id が必要です" }, { status: 400 });

    // Race + Entries
    const race = await base44.asServiceRole.entities.Race.get(raceId).catch(() => null);
    if (!race) return Response.json({ status: "error", message: "レースが見つかりません" }, { status: 404 });

    const entries = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: raceId }, "boat_number", 6);
    const boat1 = entries.find((e: any) => e.boat_number === 1);
    if (!boat1) return Response.json({ status: "error", message: "1号艇データがありません" }, { status: 400 });

    // Settings
    const settingsList = await base44.asServiceRole.entities.AppSettings.filter({ is_active_config: true });
    const settings = settingsList[0] || {};

    const w = {
      basic: settings.trust_weight_basic ?? 20,
      lane1: settings.trust_weight_lane1 ?? 20,
      venue: settings.trust_weight_venue ?? 15,
      st: settings.trust_weight_st ?? 10,
      motor: settings.trust_weight_motor ?? 10,
    };

    const regNum = boat1.registration_number;
    const venueCode = race.venue_code;
    const venueName = race.venue_name || venueCode;

    // === 過去1号艇実績をDBから取得 ===
    let venueWinRate: number | null = null;
    let venueTotal = 0;
    let venueWins = 0;
    let overallWinRate: number | null = null;
    let overallTotal = 0;
    let overallWins = 0;

    if (regNum) {
      // この場での1号艇成績
      const venueResults = await base44.asServiceRole.entities.RaceResult.filter({
        data_source: "official", boat1_registration_number: regNum, venue_code: venueCode
      }, "-race_date", 500).catch(() => []);
      venueTotal = venueResults.length;
      venueWins = venueResults.filter((r: any) => r.result_1 === 1).length;
      venueWinRate = venueTotal > 0 ? venueWins / venueTotal : null;

      // 全場での1号艇成績
      const allResults = await base44.asServiceRole.entities.RaceResult.filter({
        data_source: "official", boat1_registration_number: regNum
      }, "-race_date", 500).catch(() => []);
      overallTotal = allResults.length;
      overallWins = allResults.filter((r: any) => r.result_1 === 1).length;
      overallWinRate = overallTotal > 0 ? overallWins / overallTotal : null;
    }

    // === スコア計算 ===
    const components: any[] = [];
    const reasons: any[] = [];
    const concerns: any[] = [];
    let rawScore = 0;
    let rawMax = 0;

    // A. 選手基本力
    {
      const max = w.basic;
      const nwr = boat1.national_win_rate;
      const n2r = boat1.national_2rate;
      const gs = gradeToScore(boat1.grade_class);
      if (nwr != null || n2r != null || gs != null) {
        let s = 0, wt = 0;
        if (nwr != null) { s += clamp(nwr / 8, 0, 1) * 50; wt += 50; }
        if (n2r != null) { s += clamp(n2r / 60, 0, 1) * 20; wt += 20; }
        if (gs != null) { s += gs * 30; wt += 30; }
        const norm = wt > 0 ? s / wt : 0;
        const points = Math.round(norm * max);
        components.push({ key: "basic", label: "選手基本力", points, max, evaluated: true });
        rawScore += points; rawMax += max;
        if (nwr != null && nwr >= 6) reasons.push({ label: `全国勝率 ${fmtNum(nwr, 2)}`, strength: points });
        if (gs != null && gs >= 0.8 && boat1.grade_class) reasons.push({ label: `級別 ${boat1.grade_class}`, strength: Math.round(gs * max * 0.3) });
      }
    }

    // B. 1コース信頼性（歴史データ優先・エントリーc1補完）
    {
      const max = w.lane1;
      let s = 0, wt = 0;
      let evaluated = false;

      // 場別歴史1着率（n>=5）
      if (venueWinRate != null && venueTotal >= 5) {
        s += clamp(venueWinRate / 0.7, 0, 1) * 45; wt += 45;
        evaluated = true;
        reasons.push({
          label: `${venueName}1号艇で過去${venueTotal}走 1着率${(venueWinRate * 100).toFixed(0)}%`,
          strength: Math.round(clamp(venueWinRate / 0.7, 0, 1) * max * 0.45)
        });
      } else if (overallWinRate != null && overallTotal >= 10) {
        s += clamp(overallWinRate / 0.7, 0, 1) * 35; wt += 35;
        evaluated = true;
        reasons.push({
          label: `1号艇過去${overallTotal}走 1着率${(overallWinRate * 100).toFixed(0)}%`,
          strength: Math.round(clamp(overallWinRate / 0.7, 0, 1) * max * 0.35)
        });
      }

      // エントリーc1_win_rate
      const c1 = boat1.c1_win_rate;
      const c12 = boat1.c1_2rate;
      if (c1 != null) { s += clamp(c1 / 70, 0, 1) * 35; wt += 35; evaluated = true; }
      if (c12 != null) { s += clamp(c12 / 90, 0, 1) * 20; wt += 20; evaluated = true; }
      if (c1 != null && c1 >= 55) {
        reasons.push({ label: `1コース1着率 ${fmtNum(c1, 1)}%`, strength: Math.round(clamp(c1 / 70, 0, 1) * max * 0.3) });
      } else if (c12 != null && c12 >= 80) {
        reasons.push({ label: `1コース2連率 ${fmtNum(c12, 1)}%`, strength: Math.round(clamp(c12 / 90, 0, 1) * max * 0.2) });
      }

      if (evaluated) {
        const norm = wt > 0 ? s / wt : 0;
        const points = Math.round(norm * max);
        components.push({ key: "lane1", label: "1コース信頼性", points, max, evaluated: true, sample: venueTotal || overallTotal });
        rawScore += points; rawMax += max;
      }
    }

    // C. 当地相性
    {
      const max = w.venue;
      const lwr = boat1.local_win_rate;
      const l2r = boat1.local_2rate;
      if (lwr != null || l2r != null) {
        let s = 0, wt = 0;
        if (lwr != null) { s += clamp(lwr / 8, 0, 1) * 50; wt += 50; }
        if (l2r != null) { s += clamp(l2r / 60, 0, 1) * 50; wt += 50; }
        const norm = wt > 0 ? s / wt : 0;
        const points = Math.round(norm * max);
        components.push({ key: "venue", label: "当地相性", points, max, evaluated: true });
        rawScore += points; rawMax += max;
        if (lwr != null && lwr >= 6) reasons.push({ label: `当地勝率 ${fmtNum(lwr, 2)}`, strength: points });
      }
    }

    // D. ST評価
    {
      const max = w.st;
      const st = boat1.avg_st;
      if (st != null && st > 0) {
        const norm = clamp((0.25 - st) / 0.20, 0, 1);
        const points = Math.round(norm * max);
        components.push({ key: "st", label: "平均ST", points, max, evaluated: true });
        rawScore += points; rawMax += max;
        if (st <= 0.13) reasons.push({ label: `平均ST ${fmtNum(st, 2)}`, strength: points });
      }
    }

    // E. モーター評価
    {
      const max = w.motor;
      const m2r = boat1.motor_2rate;
      const m3r = boat1.motor_3rate;
      if (m2r != null || m3r != null) {
        let s = 0, wt = 0;
        if (m2r != null) { s += clamp(m2r / 50, 0, 1) * 60; wt += 60; }
        if (m3r != null) { s += clamp(m3r / 70, 0, 1) * 40; wt += 40; }
        const norm = wt > 0 ? s / wt : 0;
        const points = Math.round(norm * max);
        components.push({ key: "motor", label: "モーター", points, max, evaluated: true });
        rawScore += points; rawMax += max;
        if (m2r != null && m2r >= 40) reasons.push({ label: `モーター2連率 ${fmtNum(m2r, 1)}%`, strength: points });
      }
    }

    // H. リスク減点
    {
      const fc = boat1.f_count || 0;
      if (fc > 0) {
        const penalty = Math.min(fc * 4, 15);
        components.push({ key: "risk", label: "Fリスク", points: -penalty, max: 0, evaluated: true, isRisk: true });
        rawScore -= penalty;
        concerns.push({ label: `F${fc}持ち`, severity: penalty });
      }
    }
    if (boat1.motor_2rate != null && boat1.motor_2rate < 28) {
      concerns.push({ label: `モーター2連率 ${fmtNum(boat1.motor_2rate, 1)}%`, severity: 6 });
    }
    if (boat1.local_win_rate != null && boat1.local_win_rate < 3.5) {
      concerns.push({ label: `当地勝率 ${fmtNum(boat1.local_win_rate, 2)}`, severity: 5 });
    }
    if (boat1.avg_st != null && boat1.avg_st > 0.18) {
      concerns.push({ label: `平均ST ${fmtNum(boat1.avg_st, 2)}（やや遅い）`, severity: 4 });
    }

    // === 換算スコア ===
    const adjustedScore = rawMax > 0 ? Math.round(rawScore / rawMax * 100) : 0;

    // === 信頼度（サンプル数ベース） ===
    const sampleSize = venueTotal + overallTotal;
    let reliability = "D";
    const ra = settings.reliability_a_threshold || 500;
    const rb = settings.reliability_b_threshold || 250;
    const rc = settings.reliability_c_threshold || 100;
    if (sampleSize >= ra) reliability = "A";
    else if (sampleSize >= rb) reliability = "B";
    else if (sampleSize >= rc) reliability = "C";

    // === 条件一致度（簡易版: venue + grade + motor range） ===
    const conditionMatch = computeConditionMatch(boat1, venueWinRate, venueTotal, overallWinRate, overallTotal);

    // 理由を強さ順
    reasons.sort((a, b) => b.strength - a.strength);

    return Response.json({
      status: "success",
      score: adjustedScore,
      raw_score: rawScore,
      max_possible: rawMax,
      reliability,
      sample_size: sampleSize,
      venue_stats: { total: venueTotal, wins: venueWins, win_rate: venueWinRate },
      overall_stats: { total: overallTotal, wins: overallWins, win_rate: overallWinRate },
      components,
      reasons: reasons.slice(0, 7),
      concerns,
      condition_match: conditionMatch,
      evaluated_count: components.filter(c => c.evaluated && !c.isRisk).length,
      total_components: 5,
      boat1_name: boat1.racer_name,
      boat1_grade_class: boat1.grade_class,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}

function computeConditionMatch(boat1: any, venueWinRate: number | null, venueTotal: number, overallWinRate: number | null, overallTotal: number) {
  // 利用可能な条件項目をチェックし、一致度を算出
  const conditions: any[] = [];
  let matched = 0;
  let total = 0;

  // 1. 当該場で1号艇1着率 >= 60% (n>=5)
  if (venueWinRate != null && venueTotal >= 5) {
    total++;
    if (venueWinRate >= 0.6) { matched++; conditions.push({ label: `${boat1.grade_class || ""}当地1号艇1着率${(venueWinRate * 100).toFixed(0)}%`, matched: true }); }
    else conditions.push({ label: `当地1号艇1着率${(venueWinRate * 100).toFixed(0)}%`, matched: false });
  }

  // 2. 全体1号艇1着率 >= 55% (n>=10)
  if (overallWinRate != null && overallTotal >= 10) {
    total++;
    if (overallWinRate >= 0.55) { matched++; conditions.push({ label: `全体1号艇1着率${(overallWinRate * 100).toFixed(0)}%`, matched: true }); }
    else conditions.push({ label: `全体1号艇1着率${(overallWinRate * 100).toFixed(0)}%`, matched: false });
  }

  // 3. 全国勝率 >= 6.0
  if (boat1.national_win_rate != null) {
    total++;
    if (boat1.national_win_rate >= 6.0) { matched++; conditions.push({ label: `全国勝率${fmtNum(boat1.national_win_rate, 2)}`, matched: true }); }
    else conditions.push({ label: `全国勝率${fmtNum(boat1.national_win_rate, 2)}`, matched: false });
  }

  // 4. 当地勝率 >= 6.0
  if (boat1.local_win_rate != null) {
    total++;
    if (boat1.local_win_rate >= 6.0) { matched++; conditions.push({ label: `当地勝率${fmtNum(boat1.local_win_rate, 2)}`, matched: true }); }
    else conditions.push({ label: `当地勝率${fmtNum(boat1.local_win_rate, 2)}`, matched: false });
  }

  // 5. 平均ST <= 0.13
  if (boat1.avg_st != null && boat1.avg_st > 0) {
    total++;
    if (boat1.avg_st <= 0.13) { matched++; conditions.push({ label: `平均ST ${fmtNum(boat1.avg_st, 2)}`, matched: true }); }
    else conditions.push({ label: `平均ST ${fmtNum(boat1.avg_st, 2)}`, matched: false });
  }

  // 6. モーター2連率 >= 40%
  if (boat1.motor_2rate != null) {
    total++;
    if (boat1.motor_2rate >= 40) { matched++; conditions.push({ label: `モーター2連率${fmtNum(boat1.motor_2rate, 1)}%`, matched: true }); }
    else conditions.push({ label: `モーター2連率${fmtNum(boat1.motor_2rate, 1)}%`, matched: false });
  }

  // 7. 1コース1着率 >= 55%
  if (boat1.c1_win_rate != null) {
    total++;
    if (boat1.c1_win_rate >= 55) { matched++; conditions.push({ label: `1コース1着率${fmtNum(boat1.c1_win_rate, 1)}%`, matched: true }); }
    else conditions.push({ label: `1コース1着率${fmtNum(boat1.c1_win_rate, 1)}%`, matched: false });
  }

  // 8. F0
  if (boat1.f_count != null) {
    total++;
    if (boat1.f_count === 0) { matched++; conditions.push({ label: `F0`, matched: true }); }
    else conditions.push({ label: `F${boat1.f_count}持ち`, matched: false });
  }

  const score = total > 0 ? Math.round(matched / total * 100) : 0;
  return { score, matched, total, conditions };
}
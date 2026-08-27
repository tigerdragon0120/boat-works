// BOAT WORKS 共通分析ロジック（一括分析・単レース分析で共有）
// メモリ上の履歴データを受け取り、レース分析・信頼スコア・判定を計算する。

import { UICHI_COMBOS, gradeBoat1, syntheticOdds, expectedValue } from "./uichi.js";

// 分析ロジックバージョン（ロジック変更時のみインクリメント）
export const ANALYSIS_VERSION = "v2";

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function fmtNum(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function gradeToScore(grade) {
  if (!grade) return null;
  const g = String(grade).toUpperCase();
  if (g === "A1") return 1.0;
  if (g === "A2") return 0.85;
  if (g === "B1") return 0.65;
  if (g === "B2") return 0.45;
  return 0.5;
}

function reliabilityGradeFromSample(n, settings) {
  const a = settings?.reliability_a_threshold || 500;
  const b = settings?.reliability_b_threshold || 250;
  const c = settings?.reliability_c_threshold || 100;
  if (n >= a) return "A";
  if (n >= b) return "B";
  if (n >= c) return "C";
  return "D";
}

function judgeWithSample(ev, similarCount, settings) {
  if (ev == null) return "PENDING";
  const minBuy = settings?.min_buy_sample || 100;
  if (similarCount < minBuy) {
    if (ev >= (settings?.buy_threshold || 110)) return "WATCH";
    if (ev >= (settings?.watch_threshold || 100)) return "WATCH";
    return "SKIP";
  }
  if (ev >= (settings?.buy_threshold || 110)) return "BUY";
  if (ev >= (settings?.watch_threshold || 100)) return "WATCH";
  return "SKIP";
}

// 詳細類似度スコア（boatService.analyzeRacePureと同一ロジック）
function detailedSimilarityScore(target, past) {
  let s = 0;
  if (past.venue_code === target.venue_code) s += 25;
  if (past.boat1_grade_class && past.boat1_grade_class === target.boat1_grade_class) s += 15;
  s += 15 * (1 - Math.abs((target.national_win_rate || 0) - (past.boat1_national_win_rate || 0)) / 8);
  s += 10 * (1 - Math.abs((target.local_win_rate || 0) - (past.boat1_local_win_rate || 0)) / 8);
  s += 10 * (1 - Math.abs((target.avg_st || 0.2) - (past.boat1_avg_st || 0.2)) / 0.15);
  const fDiff = Math.abs((target.f_count || 0) - (past.boat1_f_count || 0));
  s += 5 * Math.max(0, 1 - fDiff / 3);
  s += 10 * (1 - Math.abs((target.motor_2rate || 35) - (past.boat1_motor_2rate || 35)) / 30);
  s += 10 * (1 - Math.abs((target.motor_3rate || 50) - (past.boat1_motor_3rate || 50)) / 30);
  return s;
}

// 条件一致度計算（getBoat1TrustScoreと同一ロジック）
function computeConditionMatch(boat1, venueWinRate, venueTotal, overallWinRate, overallTotal) {
  const conditions = [];
  let matched = 0, total = 0;

  if (venueWinRate != null && venueTotal >= 5) {
    total++;
    if (venueWinRate >= 0.6) { matched++; conditions.push({ label: `当地1号艇1着率${(venueWinRate * 100).toFixed(0)}%`, matched: true }); }
    else conditions.push({ label: `当地1号艇1着率${(venueWinRate * 100).toFixed(0)}%`, matched: false });
  }
  if (overallWinRate != null && overallTotal >= 10) {
    total++;
    if (overallWinRate >= 0.55) { matched++; conditions.push({ label: `全体1号艇1着率${(overallWinRate * 100).toFixed(0)}%`, matched: true }); }
    else conditions.push({ label: `全体1号艇1着率${(overallWinRate * 100).toFixed(0)}%`, matched: false });
  }
  if (boat1?.national_win_rate != null) {
    total++;
    if (boat1.national_win_rate >= 6.0) { matched++; conditions.push({ label: `全国勝率${fmtNum(boat1.national_win_rate, 2)}`, matched: true }); }
    else conditions.push({ label: `全国勝率${fmtNum(boat1.national_win_rate, 2)}`, matched: false });
  }
  if (boat1?.local_win_rate != null) {
    total++;
    if (boat1.local_win_rate >= 6.0) { matched++; conditions.push({ label: `当地勝率${fmtNum(boat1.local_win_rate, 2)}`, matched: true }); }
    else conditions.push({ label: `当地勝率${fmtNum(boat1.local_win_rate, 2)}`, matched: false });
  }
  if (boat1?.avg_st != null && boat1.avg_st > 0) {
    total++;
    if (boat1.avg_st <= 0.13) { matched++; conditions.push({ label: `平均ST ${fmtNum(boat1.avg_st, 2)}`, matched: true }); }
    else conditions.push({ label: `平均ST ${fmtNum(boat1.avg_st, 2)}`, matched: false });
  }
  if (boat1?.motor_2rate != null) {
    total++;
    if (boat1.motor_2rate >= 40) { matched++; conditions.push({ label: `モーター2連率${fmtNum(boat1.motor_2rate, 1)}%`, matched: true }); }
    else conditions.push({ label: `モーター2連率${fmtNum(boat1.motor_2rate, 1)}%`, matched: false });
  }
  if (boat1?.c1_win_rate != null) {
    total++;
    if (boat1.c1_win_rate >= 55) { matched++; conditions.push({ label: `1コース1着率${fmtNum(boat1.c1_win_rate, 1)}%`, matched: true }); }
    else conditions.push({ label: `1コース1着率${fmtNum(boat1.c1_win_rate, 1)}%`, matched: false });
  }
  if (boat1?.f_count != null) {
    total++;
    if (boat1.f_count === 0) { matched++; conditions.push({ label: `F0`, matched: true }); }
    else conditions.push({ label: `F${boat1.f_count}持ち`, matched: false });
  }
  const score = total > 0 ? Math.round(matched / total * 100) : 0;
  return { score, matched, total, conditions };
}

// 1号艇信頼スコア（履歴データから計算・getBoat1TrustScoreと同一ロジック）
// venueResults: この場・この選手の過去RaceResult[]
// overallResults: 全場・この選手の過去RaceResult[]
export function computeTrustScoreFromHistory(boat1, venueResults, overallResults, settings, venueName) {
  if (!boat1) return null;
  const w = {
    basic: settings?.trust_weight_basic ?? 20,
    lane1: settings?.trust_weight_lane1 ?? 20,
    venue: settings?.trust_weight_venue ?? 15,
    st: settings?.trust_weight_st ?? 10,
    motor: settings?.trust_weight_motor ?? 10,
  };

  const venueTotal = venueResults.length;
  const venueWins = venueResults.filter(r => r.result_1 === 1).length;
  const venueWinRate = venueTotal > 0 ? venueWins / venueTotal : null;
  const overallTotal = overallResults.length;
  const overallWins = overallResults.filter(r => r.result_1 === 1).length;
  const overallWinRate = overallTotal > 0 ? overallWins / overallTotal : null;

  const components = [];
  const reasons = [];
  const concerns = [];
  let rawScore = 0, rawMax = 0;

  // A. 選手基本力
  {
    const max = w.basic;
    const nwr = boat1.national_win_rate, n2r = boat1.national_2rate, gs = gradeToScore(boat1.grade_class);
    if (nwr != null || n2r != null || gs != null) {
      let s = 0, wt = 0;
      if (nwr != null) { s += clamp(nwr / 8, 0, 1) * 50; wt += 50; }
      if (n2r != null) { s += clamp(n2r / 60, 0, 1) * 20; wt += 20; }
      if (gs != null) { s += gs * 30; wt += 30; }
      const points = Math.round((wt > 0 ? s / wt : 0) * max);
      components.push({ key: "basic", label: "選手基本力", points, max, evaluated: true });
      rawScore += points; rawMax += max;
      if (nwr != null && nwr >= 6) reasons.push({ label: `全国勝率 ${fmtNum(nwr, 2)}`, strength: points });
      if (gs != null && gs >= 0.8 && boat1.grade_class) reasons.push({ label: `級別 ${boat1.grade_class}`, strength: Math.round(gs * max * 0.3) });
    }
  }
  // B. 1コース信頼性
  {
    const max = w.lane1;
    let s = 0, wt = 0, evaluated = false;
    if (venueWinRate != null && venueTotal >= 5) {
      s += clamp(venueWinRate / 0.7, 0, 1) * 45; wt += 45; evaluated = true;
      reasons.push({ label: `${venueName || ""}1号艇で過去${venueTotal}走 1着率${(venueWinRate * 100).toFixed(0)}%`, strength: Math.round(clamp(venueWinRate / 0.7, 0, 1) * max * 0.45) });
    } else if (overallWinRate != null && overallTotal >= 10) {
      s += clamp(overallWinRate / 0.7, 0, 1) * 35; wt += 35; evaluated = true;
      reasons.push({ label: `1号艇過去${overallTotal}走 1着率${(overallWinRate * 100).toFixed(0)}%`, strength: Math.round(clamp(overallWinRate / 0.7, 0, 1) * max * 0.35) });
    }
    const c1 = boat1.c1_win_rate, c12 = boat1.c1_2rate;
    if (c1 != null) { s += clamp(c1 / 70, 0, 1) * 35; wt += 35; evaluated = true; }
    if (c12 != null) { s += clamp(c12 / 90, 0, 1) * 20; wt += 20; evaluated = true; }
    if (c1 != null && c1 >= 55) reasons.push({ label: `1コース1着率 ${fmtNum(c1, 1)}%`, strength: Math.round(clamp(c1 / 70, 0, 1) * max * 0.3) });
    else if (c12 != null && c12 >= 80) reasons.push({ label: `1コース2連率 ${fmtNum(c12, 1)}%`, strength: Math.round(clamp(c12 / 90, 0, 1) * max * 0.2) });
    if (evaluated) {
      const points = Math.round((wt > 0 ? s / wt : 0) * max);
      components.push({ key: "lane1", label: "1コース信頼性", points, max, evaluated: true, sample: venueTotal || overallTotal });
      rawScore += points; rawMax += max;
    }
  }
  // C. 当地相性
  {
    const max = w.venue;
    const lwr = boat1.local_win_rate, l2r = boat1.local_2rate;
    if (lwr != null || l2r != null) {
      let s = 0, wt = 0;
      if (lwr != null) { s += clamp(lwr / 8, 0, 1) * 50; wt += 50; }
      if (l2r != null) { s += clamp(l2r / 60, 0, 1) * 50; wt += 50; }
      const points = Math.round((wt > 0 ? s / wt : 0) * max);
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
      const points = Math.round(clamp((0.25 - st) / 0.20, 0, 1) * max);
      components.push({ key: "st", label: "平均ST", points, max, evaluated: true });
      rawScore += points; rawMax += max;
      if (st <= 0.13) reasons.push({ label: `平均ST ${fmtNum(st, 2)}`, strength: points });
    }
  }
  // E. モーター評価
  {
    const max = w.motor;
    const m2r = boat1.motor_2rate, m3r = boat1.motor_3rate;
    if (m2r != null || m3r != null) {
      let s = 0, wt = 0;
      if (m2r != null) { s += clamp(m2r / 50, 0, 1) * 60; wt += 60; }
      if (m3r != null) { s += clamp(m3r / 70, 0, 1) * 40; wt += 40; }
      const points = Math.round((wt > 0 ? s / wt : 0) * max);
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
  if (boat1.motor_2rate != null && boat1.motor_2rate < 28) concerns.push({ label: `モーター2連率 ${fmtNum(boat1.motor_2rate, 1)}%`, severity: 6 });
  if (boat1.local_win_rate != null && boat1.local_win_rate < 3.5) concerns.push({ label: `当地勝率 ${fmtNum(boat1.local_win_rate, 2)}`, severity: 5 });
  if (boat1.avg_st != null && boat1.avg_st > 0.18) concerns.push({ label: `平均ST ${fmtNum(boat1.avg_st, 2)}（やや遅い）`, severity: 4 });

  const adjustedScore = rawMax > 0 ? Math.round(rawScore / rawMax * 100) : 0;
  const sampleSize = venueTotal + overallTotal;
  let reliability = "D";
  const ra = settings?.reliability_a_threshold || 500, rb = settings?.reliability_b_threshold || 250, rc = settings?.reliability_c_threshold || 100;
  if (sampleSize >= ra) reliability = "A";
  else if (sampleSize >= rb) reliability = "B";
  else if (sampleSize >= rc) reliability = "C";

  const conditionMatch = computeConditionMatch(boat1, venueWinRate, venueTotal, overallWinRate, overallTotal);
  reasons.sort((a, b) => b.strength - a.strength);

  return {
    score: adjustedScore,
    raw_score: rawScore,
    max_possible: rawMax,
    components,
    reasons: reasons.slice(0, 7),
    concerns,
    condition_match: conditionMatch,
    reliability,
    sample_size: sampleSize,
    venue_stats: { total: venueTotal, wins: venueWins, win_rate: venueWinRate },
    overall_stats: { total: overallTotal, wins: overallWins, win_rate: overallWinRate },
  };
}

// レース完全分析（メモリ上の履歴インデックスを使用）
// history: { byVenue: {venue_code: RaceResult[]}, byRegVenue: {"venue_reg": []}, byReg: {reg: []}, totalDone, totalAll }
export function computeRaceAnalysis(race, entries, odds, history, settings, stage) {
  const boat1 = entries.find(e => e.boat_number === 1);
  const boat1Grade = gradeBoat1(boat1);

  const venueResults = history.byVenue[race.venue_code] || [];
  const target = {
    venue_code: race.venue_code,
    boat1_grade_class: boat1?.grade_class,
    national_win_rate: boat1?.national_win_rate,
    local_win_rate: boat1?.local_win_rate,
    avg_st: boat1?.avg_st,
    f_count: boat1?.f_count,
    motor_2rate: boat1?.motor_2rate,
    motor_3rate: boat1?.motor_3rate,
  };
  const similar = venueResults.filter(p => {
    if (p.data_source && p.data_source !== "official") return false;
    if (p.boat1_detail_status && p.boat1_detail_status !== "done") return false;
    if (!p.boat1_detail_status && !p.boat1_racer_name) return false;
    return detailedSimilarityScore(target, p) >= 55;
  });
  const similarCount = similar.length;
  const uichiHits = similar.filter(p => p.is_uichi).length;
  const appearanceRate = similarCount > 0 ? uichiHits / similarCount : 0;

  let synthOdds = 0, oddsValues = [];
  if (odds && stage !== "pre") {
    oddsValues = UICHI_COMBOS.map(c => odds["odds_" + c.replace(/-/g, "_")]);
    synthOdds = syntheticOdds(oddsValues);
  }
  const ev = stage === "pre" ? null : expectedValue(appearanceRate, synthOdds);
  const minOk = similarCount >= (settings?.min_similar_races || 30);

  // 信頼スコア
  const regNum = boat1?.registration_number;
  const trustVenueResults = regNum ? (history.byRegVenue[`${race.venue_code}_${regNum}`] || []) : [];
  const trustOverallResults = regNum ? (history.byReg[regNum] || []) : [];
  const trust = computeTrustScoreFromHistory(boat1, trustVenueResults, trustOverallResults, settings, race.venue_name);

  const totalPool = history.totalAll || 0;
  const validPool = history.totalDone || 0;
  const sufficiency = totalPool > 0 ? validPool / totalPool : 0;
  const reliability = reliabilityGradeFromSample(similarCount, settings);

  let judgment = "PENDING";
  if (stage === "pre") judgment = "PENDING";
  else if (minOk) judgment = judgeWithSample(ev, similarCount, settings);

  // 前日評価等級
  let preGrade = null;
  if (stage === "pre") {
    const ar = appearanceRate * 100;
    const ts = trust?.score || 0;
    const preThr = settings?.pre_alert_rate || 15;
    if (ar >= preThr && ts >= 75) preGrade = "S";
    else if (ar >= preThr * 0.85 && ts >= 65) preGrade = "A";
    else if (ar >= preThr * 0.7) preGrade = "B";
    else preGrade = "C";
  }

  const weightedProbability = appearanceRate * (0.5 + (trust?.score || 0) / 200);

  return {
    race_id: race.id, stage,
    boat1_grade: boat1Grade,
    similar_count: similarCount,
    uichi_hits: uichiHits,
    appearance_rate: appearanceRate,
    synthetic_odds: synthOdds,
    expected_value: ev,
    judgment,
    min_similar_ok: minOk,
    total_pool: totalPool,
    valid_pool: validPool,
    data_sufficiency: sufficiency,
    reliability,
    boat1_trust: trust,
    boat1_trust_score: trust?.score ?? 0,
    condition_match_score: trust?.condition_match?.score ?? 0,
    weighted_probability: weightedProbability,
    pre_grade: preGrade,
    reasons: trust?.reasons || [],
    concerns: trust?.concerns || [],
    condition_matches: trust?.condition_match?.conditions || [],
    boat1,
    odds_values: oddsValues,
    analysis_version: ANALYSIS_VERSION,
  };
}

// Alert生成判定
export function shouldGenerateAlert(analysis, settings, stage) {
  if (stage === "pre") {
    return analysis.pre_grade === "S" || analysis.pre_grade === "A";
  }
  return analysis.judgment === "BUY" || analysis.judgment === "WATCH";
}
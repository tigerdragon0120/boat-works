// BOAT WORKS 共通分析ロジック（集計Entityベース・v3）
// RaceResult全件を読まず、RacerStats/RacerVenueStats/VenueRaceStats等の集計済みEntityから分析する。
// データ量が増えても分析時間は増えない。

import { UICHI_COMBOS, gradeBoat1, syntheticOdds, expectedValue } from "./uichi.js";
import { windSpeedGroup } from "./aggregation.js";

// 分析ロジックバージョン（ロジック変更時のみインクリメント）
export const ANALYSIS_VERSION = "v7";

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

// 5・6号艇の「3着へ食い込む穴期待度」。勝つ強さより、3着を拾う材料を重視する。
function computeOuterBoatPotential(entries) {
  const scoreOne = (e) => {
    if (!e) return { score: 0, reasons: [] };
    let score = 0;
    const reasons = [];

    const gs = gradeToScore(e.grade_class);
    if (gs != null) {
      const p = Math.round(gs * 15);
      score += p;
      if (p >= 10) reasons.push({ label: `級別 ${e.grade_class}`, strength: p });
    }

    if (e.national_3rate != null) {
      const p = Math.round(clamp(e.national_3rate / 65, 0, 1) * 25);
      score += p;
      if (e.national_3rate >= 45) reasons.push({ label: `全国3連率 ${fmtNum(e.national_3rate, 1)}%`, strength: p });
    }
    if (e.local_3rate != null) {
      const p = Math.round(clamp(e.local_3rate / 65, 0, 1) * 20);
      score += p;
      if (e.local_3rate >= 45) reasons.push({ label: `当地3連率 ${fmtNum(e.local_3rate, 1)}%`, strength: p });
    }
    if (e.motor_3rate != null) {
      const p = Math.round(clamp(e.motor_3rate / 60, 0, 1) * 20);
      score += p;
      if (e.motor_3rate >= 40) reasons.push({ label: `モーター3連率 ${fmtNum(e.motor_3rate, 1)}%`, strength: p });
    }
    if (e.motor_2rate != null) {
      const p = Math.round(clamp(e.motor_2rate / 45, 0, 1) * 10);
      score += p;
      if (e.motor_2rate >= 35) reasons.push({ label: `モーター2連率 ${fmtNum(e.motor_2rate, 1)}%`, strength: p });
    }
    if (e.avg_st != null && e.avg_st > 0) {
      const p = Math.round(clamp((0.23 - e.avg_st) / 0.15, 0, 1) * 10);
      score += p;
      if (e.avg_st <= 0.16) reasons.push({ label: `平均ST ${fmtNum(e.avg_st, 2)}`, strength: p });
    }

    return { score: clamp(Math.round(score), 0, 100), reasons: reasons.sort((a, b) => b.strength - a.strength).slice(0, 4) };
  };

  const b5 = entries.find(e => e.boat_number === 5);
  const b6 = entries.find(e => e.boat_number === 6);
  const s5 = scoreOne(b5);
  const s6 = scoreOne(b6);
  const best = s6.score > s5.score ? { boat: b6, ...s6 } : { boat: b5, ...s5 };
  return {
    score: best.score,
    boat_number: best.boat?.boat_number ?? null,
    racer_name: best.boat?.racer_name ?? null,
    reasons: best.reasons,
    boat5_score: s5.score,
    boat6_score: s6.score,
  };
}

function computeUichiDirection(entries, trustScore, vrs, outerThirdScore, outerSecondScore) {
  const b = n => entries.find(e => e.boat_number === n);

  const secondScore = (e) => {
    if (!e) return 0;
    const grade = (gradeToScore(e.grade_class) ?? 0.5) * 10;
    const nat2 = clamp((e.national_2rate || 0) / 60, 0, 1) * 28;
    const loc2 = clamp((e.local_2rate || 0) / 60, 0, 1) * 18;
    const motor2 = clamp((e.motor_2rate || 0) / 50, 0, 1) * 22;
    const boat2 = clamp((e.boat_2rate || 0) / 50, 0, 1) * 10;
    const st = clamp((0.23 - (e.avg_st || 0.23)) / 0.15, 0, 1) * 12;
    return clamp(Math.round(grade + nat2 + loc2 + motor2 + boat2 + st), 0, 100);
  };

  const thirdScore = (e) => {
    if (!e) return 0;
    const grade = (gradeToScore(e.grade_class) ?? 0.5) * 8;
    const nat3 = clamp((e.national_3rate || 0) / 70, 0, 1) * 30;
    const loc3 = clamp((e.local_3rate || 0) / 70, 0, 1) * 18;
    const motor3 = clamp((e.motor_3rate || 0) / 65, 0, 1) * 24;
    const boat3 = clamp((e.boat_3rate || 0) / 65, 0, 1) * 10;
    const st = clamp((0.24 - (e.avg_st || 0.24)) / 0.16, 0, 1) * 10;
    return clamp(Math.round(grade + nat3 + loc3 + motor3 + boat3 + st), 0, 100);
  };

  const mids = [b(2), b(3), b(4)];
  const outers = [b(5), b(6)];
  const midSecondScores = mids.map(secondScore);
  const midThirdScores = mids.map(thirdScore);
  const outerSecondScores = outers.map(secondScore);
  const outerThirdScores = outers.map(thirdScore);

  // 本線は234の誰かが2着＋56の誰かが3着。裏は逆。
  // 1艇だけ突出するケースも拾うため max と平均を混ぜる。
  const pool = arr => Math.round(Math.max(...arr, 0) * 0.62 + (arr.reduce((a,c)=>a+c,0) / Math.max(arr.length,1)) * 0.38);
  const midSecond = pool(midSecondScores);
  const midThird = pool(midThirdScores);
  const outerSecond = Math.round(pool(outerSecondScores) * 0.70 + outerSecondScore * 0.30);
  const outerThird = Math.round(pool(outerThirdScores) * 0.55 + outerThirdScore * 0.45);

  // 場×Rの過去差はサンプル数で縮小。100走未満の極端値をそのまま信じない。
  const n = vrs?.total_races || 0;
  const shrink = clamp(n / (n + 100), 0, 0.75);
  const histMainRate = vrs?.uichi_rate || 0;
  const histUraRate = vrs?.ura_uichi_rate || 0;
  const histDirection = clamp((histMainRate - histUraRate) * 500 * shrink, -30, 30);
  const histStrength = clamp(((histMainRate + histUraRate) / 0.32) * 100, 0, 100);

  // 1号艇は両パターン共通の軸。高すぎても低すぎても方向には効かせず、適性の土台に使う。
  const axisGate = clamp(((trustScore || 0) - 50) / 35, 0, 1);
  const mainStructure = clamp(midSecond * 0.52 + outerThird * 0.48, 0, 100);
  const uraStructure = clamp(outerSecond * 0.56 + midThird * 0.44, 0, 100);

  const mainSuitability = Math.round(clamp(
    (35 + mainStructure * 0.65) * (0.72 + axisGate * 0.28) + Math.max(histDirection, 0), 0, 100
  ));
  const uraSuitability = Math.round(clamp(
    (35 + uraStructure * 0.65) * (0.72 + axisGate * 0.28) + Math.max(-histDirection, 0), 0, 100
  ));

  const rawDiff = mainSuitability - uraSuitability;
  const directionIndex = Math.round(clamp(rawDiff * 2.5, -100, 100));
  const structureStrength = Math.max(mainSuitability, uraSuitability);
  const confidence = Math.round(clamp(
    Math.abs(directionIndex) * 0.55 + structureStrength * 0.25 + histStrength * 0.20,
    0, 100
  ));

  let label = "中立";
  if (directionIndex >= 60 && confidence >= 60) label = "本線ういち濃厚";
  else if (directionIndex >= 25) label = "本線ういち寄り";
  else if (directionIndex <= -60 && confidence >= 60) label = "裏ういち濃厚";
  else if (directionIndex <= -25) label = "裏ういち寄り";

  const reasons = [];
  if (midSecond >= 65) reasons.push({ label: `2〜4号艇の2着力 ${midSecond}`, score: midSecond, side: "main" });
  if (outerThird >= 65) reasons.push({ label: `5・6号艇の3着力 ${outerThird}`, score: outerThird, side: "main" });
  if (outerSecond >= 65) reasons.push({ label: `5・6号艇の2着突っ込み力 ${outerSecond}`, score: outerSecond, side: "ura" });
  if (midThird >= 65) reasons.push({ label: `2〜4号艇の3着残り ${midThird}`, score: midThird, side: "ura" });
  if (Math.abs(histDirection) >= 8) reasons.push({ label: `場×R過去傾向 ${histDirection > 0 ? "本線" : "裏"}寄り`, score: Math.abs(histDirection) + 50, side: histDirection > 0 ? "main" : "ura" });

  return {
    direction_index: directionIndex,
    label,
    confidence,
    main_suitability: mainSuitability,
    ura_suitability: uraSuitability,
    main_structure: Math.round(mainStructure),
    ura_structure: Math.round(uraStructure),
    mid_second_score: midSecond,
    mid_third_score: midThird,
    outer_second_score: outerSecond,
    outer_third_score: outerThird,
    historical_direction: Math.round(histDirection),
    reasons: reasons.sort((a,b)=>b.score-a.score).slice(0,5),
  };
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

// 1号艇信頼スコア（集計Entityから計算）
// racerVenueStat: RacerVenueStats record (この場の1号艇成績)
// racerStat: RacerStats record (全体1号艇成績)
// weatherStat: RacerWeatherStats record (天候一致・n>=5時のみ)
export function computeTrustScoreFromAggregates(boat1, racerVenueStat, racerStat, settings, venueName, weatherStat) {
  if (!boat1) return null;
  const w = {
    basic: settings?.trust_weight_basic ?? 20,
    lane1: settings?.trust_weight_lane1 ?? 20,
    venue: settings?.trust_weight_venue ?? 15,
    st: settings?.trust_weight_st ?? 10,
    motor: settings?.trust_weight_motor ?? 10,
    weather: settings?.trust_weight_weather ?? 10,
  };

  const venueWinRate = racerVenueStat?.boat1_win_rate ?? null;
  const venueTotal = racerVenueStat?.boat1_races ?? 0;
  const venueWins = racerVenueStat?.boat1_wins ?? 0;
  const overallWinRate = racerStat?.boat1_win_rate ?? null;
  const overallTotal = racerStat?.boat1_races ?? 0;
  const overallWins = racerStat?.boat1_wins ?? 0;

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
  // B. 1コース信頼性（集計データ優先）
  {
    const max = w.lane1;
    let s = 0, wt = 0, evaluated = false;
    if (venueWinRate != null && venueTotal >= 5) {
      s += clamp(venueWinRate / 0.7, 0, 1) * 45; wt += 45; evaluated = true;
      reasons.push({ label: `${venueName || ""}1号艇 過去${venueTotal}走 1着${venueWins}回 (${(venueWinRate * 100).toFixed(0)}%)`, strength: Math.round(clamp(venueWinRate / 0.7, 0, 1) * max * 0.45) });
    } else if (overallWinRate != null && overallTotal >= 10) {
      s += clamp(overallWinRate / 0.7, 0, 1) * 35; wt += 35; evaluated = true;
      reasons.push({ label: `1号艇 過去${overallTotal}走 1着${overallWins}回 (${(overallWinRate * 100).toFixed(0)}%)`, strength: Math.round(clamp(overallWinRate / 0.7, 0, 1) * max * 0.35) });
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
  // F. 天候相性（集計データ・n>=5時のみ評価対象）
  if (weatherStat && weatherStat.races >= 5) {
    const max = w.weather;
    const wr = weatherStat.win_rate;
    const points = Math.round(clamp(wr / 0.7, 0, 1) * max);
    const wlabel = `${weatherStat.weather || ""} ${weatherStat.wind_speed_group || ""}m`;
    components.push({ key: "weather", label: `天候相性(${wlabel})`, points, max, evaluated: true, sample: weatherStat.races });
    rawScore += points; rawMax += max;
    if (wr >= 0.6) reasons.push({ label: `${wlabel}時 1号艇${weatherStat.races}走 1着${weatherStat.wins}回 (${(wr * 100).toFixed(0)}%)`, strength: points });
  }
  // G. 直近調子（recent_resultsから・理由表示のみ）
  if (racerStat?.recent_results?.length >= 5) {
    const recent = racerStat.recent_results.slice(0, 10);
    const rWins = recent.filter(r => r.won).length;
    const rRate = rWins / recent.length;
    if (rRate >= 0.5) {
      reasons.push({ label: `直近${recent.length}走で${rWins}勝 (${(rRate * 100).toFixed(0)}%)`, strength: Math.round(rRate * 10) });
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

// レース完全分析（集計Entityベース）
// stats: { venueRaceStats, racerStats, racerVenueStats, racerWeatherStats, venueStats, totalRaces }
export function computeRaceAnalysis(race, entries, odds, stats, settings, stage) {
  const boat1 = entries.find(e => e.boat_number === 1);
  const boat1Grade = gradeBoat1(boat1);
  const reg = boat1?.registration_number;
  const venue = race.venue_code;
  const rnum = race.race_number;

  // 集計データルックアップ
  const vrs = stats.venueRaceStats?.[venue]?.[rnum];
  const vs = stats.venueStats?.[venue];
  const rvst = reg ? stats.racerVenueStats?.[reg]?.[venue] : null;
  const rst = reg ? stats.racerStats?.[reg] : null;

  // ういち出現率計算（レーサー調整済み）
  // P(uichi) = P(boat1 wins) × P(uichi | boat1 wins)
  const baseUichiRate = vrs?.uichi_rate ?? vs?.uichi_rate ?? 0;
  const venueBoat1WinRate = vrs?.boat1_win_rate ?? (vs?.c1_win_rate ? vs.c1_win_rate / 100 : 0.5);
  const racerBoat1WinRate = rvst?.boat1_win_rate ?? rst?.boat1_win_rate ?? venueBoat1WinRate;

  let appearanceRate;
  if (venueBoat1WinRate > 0.05 && (rvst || rst)) {
    appearanceRate = racerBoat1WinRate * (baseUichiRate / venueBoat1WinRate);
  } else {
    appearanceRate = baseUichiRate;
  }
  appearanceRate = clamp(appearanceRate, 0, 0.95);

  // 裏ういち 1-56-234。過去の場×R出現率を土台に、1号艇信頼と5/6号艇の
  // 『2着まで突っ込める力』で補正する。集計未構築時は0として誤表示しない。
  const baseUraRate = vrs?.ura_uichi_rate ?? 0;

  const similarCount = vrs?.total_races ?? 0;
  const uichiHits = vrs?.uichi_hits ?? 0;

  // オッズ + EV
  let synthOdds = 0, oddsValues = [];
  if (odds && stage !== "pre") {
    oddsValues = UICHI_COMBOS.map(c => odds["odds_" + c.replace(/-/g, "_")]);
    synthOdds = syntheticOdds(oddsValues);
  }
  const ev = stage === "pre" ? null : expectedValue(appearanceRate, synthOdds);
  const minOk = similarCount >= (settings?.min_similar_races || 30);

  // 天候一致stat検索
  let weatherStat = null;
  if (reg && race.weather) {
    const wsg = windSpeedGroup(race.wind_speed);
    const wList = stats.racerWeatherStats?.[reg]?.[venue];
    if (wList) weatherStat = wList.find(w => w.weather === race.weather && w.wind_speed_group === wsg);
  }

  // 1号艇信頼スコア + 5/6号艇の穴期待度
  const trust = computeTrustScoreFromAggregates(boat1, rvst, rst, settings, race.venue_name, weatherStat);
  const outer = computeOuterBoatPotential(entries);
  const b5 = entries.find(e => e.boat_number === 5);
  const b6 = entries.find(e => e.boat_number === 6);
  const outerSecondScore = Math.max(
    b5 ? Math.round(clamp(((b5.national_2rate || 0) * 0.35 + (b5.local_2rate || 0) * 0.25 + (b5.motor_2rate || 0) * 0.25 + clamp((0.22 - (b5.avg_st || 0.22)) / 0.12, 0, 1) * 100 * 0.15), 0, 100)) : 0,
    b6 ? Math.round(clamp(((b6.national_2rate || 0) * 0.35 + (b6.local_2rate || 0) * 0.25 + (b6.motor_2rate || 0) * 0.25 + clamp((0.22 - (b6.avg_st || 0.22)) / 0.12, 0, 1) * 100 * 0.15), 0, 100)) : 0
  );
  const uraUichiRate = baseUraRate > 0
    ? clamp(baseUraRate * (0.65 + (trust?.score || 0) / 400 + outerSecondScore / 500), 0, 0.95)
    : 0;

  const uichiDirection = computeUichiDirection(entries, trust?.score || 0, vrs, outer?.score || 0, outerSecondScore);

  const totalPool = stats.totalRaces ?? 0;
  const validPool = totalPool;
  const sufficiency = totalPool > 0 ? 1 : 0;
  const reliability = reliabilityGradeFromSample(similarCount, settings);

  let judgment = "PENDING";
  if (stage === "pre") {
    judgment = "PENDING";
  } else if (minOk) {
    judgment = judgeWithSample(ev, similarCount, settings);
  } else {
    // final/day判定時に必要サンプル数へ届かない場合でもPENDINGを残さない。
    // データ不足のため安全側にSKIP確定とする。
    judgment = "SKIP";
  }

  let preGrade = null;
  if (stage === "pre") {
    const ar = appearanceRate * 100;
    const ts = trust?.score || 0;
    const cm = trust?.condition_match?.score || 0;
    const os = outer?.score || 0;
    const preThr = settings?.pre_alert_rate ?? 20;
    const minTrust = settings?.pre_min_boat1_trust ?? 75;
    const minOuter = settings?.pre_min_outer_score ?? 55;
    const strongOuter = settings?.pre_strong_outer_score ?? 65;

    // ういち買い専用の厳選条件。
    // 出現率だけではアラートにしない。1号艇の逃げ信頼 + 5/6号艇の3着穴期待を必須にする。
    if (ar >= preThr + 2 && ts >= Math.max(minTrust + 5, 80) && os >= strongOuter && cm >= 60) preGrade = "S";
    else if (ar >= preThr && ts >= minTrust && os >= minOuter && cm >= 40) preGrade = "A";
    else if (ar >= preThr) preGrade = "B"; // 出現率は高いが、ういち向き条件が足りないので通知しない
    else preGrade = "C";
  }

  // ランキングも「出現率 + 1号艇 + 5/6号艇」の3要素で並べる。
  const weightedProbability = appearanceRate * (0.45 + (trust?.score || 0) / 300 + (outer?.score || 0) / 600);

  return {
    race_id: race.id, stage,
    boat1_grade: boat1Grade,
    similar_count: similarCount,
    uichi_hits: uichiHits,
    appearance_rate: appearanceRate,
    ura_uichi_hits: vrs?.ura_uichi_hits ?? 0,
    ura_uichi_rate: uraUichiRate,
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
    outer_boat_score: outer?.score ?? 0,
    outer_boat_number: outer?.boat_number ?? null,
    outer_boat_name: outer?.racer_name ?? null,
    outer_boat_reasons: outer?.reasons || [],
    uichi_direction_index: uichiDirection.direction_index,
    uichi_direction_label: uichiDirection.label,
    uichi_main_suitability: uichiDirection.main_suitability,
    uichi_ura_suitability: uichiDirection.ura_suitability,
    uichi_direction_reasons: uichiDirection.reasons,
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
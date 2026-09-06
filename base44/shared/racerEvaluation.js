// BOAT WORKS ういち目・裏ういち目特化型 選手評価システム
// 共通評価ロジック: 期間別集計・スコア計算・タイプ分類・レース構成

export const EVALUATION_VERSION = "REVAL_V1.0.0";

// ─── 期間日付計算 ──────────────────────────────────────────
export function getPeriodDates(referenceDate) {
  const ref = new Date(referenceDate);
  const pad = (d) => String(d).padStart(2, "0");
  const fmt = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

  const end = fmt(ref);
  const m6 = new Date(ref); m6.setMonth(m6.getMonth() - 6);
  const y1 = new Date(ref); y1.setFullYear(y1.getFullYear() - 1);
  const y3 = new Date(ref); y3.setFullYear(y3.getFullYear() - 3);

  return {
    "6m": { start: fmt(m6), end },
    "1y": { start: fmt(y1), end },
    "3y": { start: fmt(y3), end },
  };
}

// race_key "YYYY-MM-DD_VV_RR" から日付を抽出
export function extractDateFromRaceKey(raceKey) {
  if (!raceKey || raceKey.length < 10) return null;
  const d = raceKey.substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d;
}

// ─── ST解析 ────────────────────────────────────────────────
export function parseST(stStr) {
  if (stStr == null) return null;
  const s = String(stStr).trim();
  if (!s || s === "F" || s === "L" || s === ".F" || s === ".L" || s === "S" || s === "S0" || s === "S1" || s === "S2") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 && n < 5 ? n : null;
}

export function isFL(stStr) {
  if (stStr == null) return { isF: false, isL: false };
  const s = String(stStr).trim().toUpperCase();
  return { isF: s.includes("F"), isL: s.includes("L") };
}

// ─── コース別統計集計 ──────────────────────────────────────
// entries: OfficialRaceEntryResultV2 の配列
// 戻り値: { 1: {race_count, win_rate, ...}, 2: {...}, ... }
export function aggregateCourseStats(entries) {
  const courseMap = {};
  for (let c = 1; c <= 6; c++) {
    courseMap[c] = {
      race_count: 0,
      finish_1: 0, finish_2: 0, finish_3: 0, finish_4: 0, finish_5: 0, finish_6: 0,
      st_sum: 0, st_count: 0, f_count: 0, l_count: 0,
      finish_order_sum: 0, finish_order_count: 0,
      finish_orders: [],
    };
  }

  for (const entry of entries) {
    if (entry.is_absent) continue;
    const course = entry.start_course;
    if (!course || course < 1 || course > 6) continue;

    const cs = courseMap[course];
    cs.race_count++;

    const fo = entry.finish_order;
    if (fo != null && fo >= 1 && fo <= 6) {
      cs[`finish_${fo}`]++;
      cs.finish_order_sum += fo;
      cs.finish_order_count++;
      cs.finish_orders.push(fo);
    }

    const st = parseST(entry.start_timing);
    if (st != null) { cs.st_sum += st; cs.st_count++; }
    const { isF, isL } = isFL(entry.start_timing);
    if (isF) cs.f_count++;
    if (isL) cs.l_count++;
  }

  for (let c = 1; c <= 6; c++) {
    const cs = courseMap[c];
    const rc = cs.race_count;
    if (rc === 0) { cs.has_data = false; continue; }
    cs.has_data = true;
    cs.win_rate = cs.finish_1 / rc;
    cs.second_rate = cs.finish_2 / rc;
    cs.third_rate = cs.finish_3 / rc;
    cs.top2_rate = (cs.finish_1 + cs.finish_2) / rc;
    cs.top3_rate = (cs.finish_1 + cs.finish_2 + cs.finish_3) / rc;
    cs.avg_finish_order = cs.finish_order_count > 0 ? cs.finish_order_sum / cs.finish_order_count : null;
    cs.avg_st = cs.st_count > 0 ? cs.st_sum / cs.st_count : null;
    if (cs.finish_orders.length > 0) {
      const mean = cs.finish_order_sum / cs.finish_order_count;
      const variance = cs.finish_orders.reduce((s, fo) => s + (fo - mean) ** 2, 0) / cs.finish_orders.length;
      cs.finish_order_std = Math.sqrt(variance);
    } else {
      cs.finish_order_std = null;
    }
  }

  return courseMap;
}

// 複数コースの統計を加重平均で統合
export function aggregateMultiCourse(courseStatsArray) {
  const valid = (courseStatsArray || []).filter(s => s && s.has_data && s.race_count > 0);
  if (valid.length === 0) return null;
  const totalRaces = valid.reduce((sum, s) => sum + s.race_count, 0);
  if (totalRaces === 0) return null;
  const wAvg = (key) => {
    let sum = 0;
    for (const s of valid) sum += (s[key] || 0) * s.race_count;
    return sum / totalRaces;
  };
  return {
    race_count: totalRaces,
    win_rate: wAvg("win_rate"),
    second_rate: wAvg("second_rate"),
    third_rate: wAvg("third_rate"),
    top2_rate: wAvg("top2_rate"),
    top3_rate: wAvg("top3_rate"),
    avg_finish_order: wAvg("avg_finish_order"),
    avg_st: wAvg("avg_st"),
    f_count: valid.reduce((s, x) => s + (x.f_count || 0), 0),
    l_count: valid.reduce((s, x) => s + (x.l_count || 0), 0),
    finish_order_std: wAvg("finish_order_std"),
  };
}

// ─── サンプル補正（回帰平均）──────────────────────────────
function sampleCorrect(rawScore, raceCount, minSample) {
  const confidence = Math.min(1, raceCount / minSample);
  return 50 + (rawScore - 50) * confidence;
}
function clamp(x) { return Math.max(0, Math.min(100, Math.round(x))); }

// ─── IN_STRENGTH_SCORE (1号艇イン逃げ能力) ──────────────────
export function computeInStrength(course1Stats) {
  if (!course1Stats || !course1Stats.has_data) return null;
  const { win_rate, top2_rate, top3_rate, avg_st, f_count, l_count, race_count, avg_finish_order } = course1Stats;
  let score = 40 + win_rate * 60 + (top2_rate - win_rate) * 30;
  if (avg_st != null) {
    if (avg_st < 0.10) score += 10;
    else if (avg_st < 0.13) score += 7;
    else if (avg_st < 0.16) score += 5;
    else if (avg_st < 0.20) score += 2;
  }
  score += Math.min(10, (top3_rate || 0) * 20);
  score -= (f_count || 0) * 2 + (l_count || 0) * 1;
  return clamp(sampleCorrect(score, race_count, 30));
}

// ─── MID_SECOND_SCORE (中枠2着能力, 2-4コース) ──────────────
export function computeMidSecond(course2to4Stats) {
  const agg = aggregateMultiCourse(course2to4Stats);
  if (!agg) return null;
  const { win_rate, second_rate, top2_rate, avg_finish_order, race_count } = agg;
  let score = 30 + second_rate * 80 + (top2_rate - second_rate - win_rate) * 30;
  if (win_rate > 0.15) score -= (win_rate - 0.15) * 200;
  if (avg_finish_order != null) {
    if (avg_finish_order < 2.5) score += 5;
    else if (avg_finish_order < 3.0) score += 3;
  }
  return clamp(sampleCorrect(score, race_count, 30));
}

// ─── MID_THIRD_SCORE (中枠3着能力, 2-4コース) ───────────────
export function computeMidThird(course2to4Stats) {
  const agg = aggregateMultiCourse(course2to4Stats);
  if (!agg) return null;
  const { third_rate, top3_rate, avg_finish_order, race_count } = agg;
  let score = 30 + third_rate * 80 + (top3_rate - third_rate) * 30;
  if (avg_finish_order != null && avg_finish_order < 3.0) score += 5;
  return clamp(sampleCorrect(score, race_count, 30));
}

// ─── OUTSIDE_THIRD_SCORE (外枠3着進出能力, 5-6コース) ────────
export function computeOutsideThird(course5to6Stats) {
  const agg = aggregateMultiCourse(course5to6Stats);
  if (!agg) return null;
  const { third_rate, top3_rate, avg_finish_order, avg_st, race_count } = agg;
  let score = 25 + third_rate * 100 + (top3_rate - third_rate) * 30;
  if (avg_finish_order != null) {
    if (avg_finish_order < 3.5) score += 10;
    else if (avg_finish_order < 4.0) score += 7;
    else if (avg_finish_order < 4.5) score += 3;
  }
  if (avg_st != null && avg_st < 0.15) score += 5;
  return clamp(sampleCorrect(score, race_count, 20));
}

// ─── OUTSIDE_SECOND_SCORE (外枠2着進出能力, 5-6コース) ───────
export function computeOutsideSecond(course5to6Stats) {
  const agg = aggregateMultiCourse(course5to6Stats);
  if (!agg) return null;
  const { second_rate, top2_rate, avg_finish_order, race_count } = agg;
  let score = 20 + second_rate * 120 + (top2_rate - second_rate) * 30;
  if (avg_finish_order != null) {
    if (avg_finish_order < 3.5) score += 10;
    else if (avg_finish_order < 4.0) score += 5;
  }
  return clamp(sampleCorrect(score, race_count, 20));
}

// ─── 期間別スコア計算 ──────────────────────────────────────
export function computePeriodScores(courseStats) {
  const c1 = courseStats[1];
  const c2to4 = [courseStats[2], courseStats[3], courseStats[4]];
  const c5to6 = [courseStats[5], courseStats[6]];
  return {
    in_strength: computeInStrength(c1),
    mid_second: computeMidSecond(c2to4),
    mid_third: computeMidThird(c2to4),
    outside_third: computeOutsideThird(c5to6),
    outside_second: computeOutsideSecond(c5to6),
  };
}

// ─── 期間ブレンド（現在評価）──────────────────────────────
export function blendPeriodScores(periodScores, periodSampleCounts, scoreKey) {
  const w = { "6m": 0.50, "1y": 0.30, "3y": 0.20 };
  const minSample = scoreKey === "in_strength" ? 10 : 8;
  let aw = {}, totalW = 0;
  for (const p of ["6m", "1y", "3y"]) {
    const count = periodSampleCounts[p]?.[scoreKey] || 0;
    const adjW = count >= minSample ? w[p] : w[p] * Math.max(0.1, count / minSample);
    aw[p] = adjW;
    totalW += adjW;
  }
  if (totalW === 0) return null;
  let blended = 0;
  for (const p of ["6m", "1y", "3y"]) {
    const s = periodScores[p]?.[scoreKey];
    if (s != null) blended += s * aw[p];
  }
  return clamp(blended / totalW);
}

// ─── 選手タイプ分類 ────────────────────────────────────────
export function classifyPlayerTypes(currentScores, periodData) {
  const types = [];
  const c1_1y = periodData["1y"]?.courses?.[1];
  const mid_1y = aggregateMultiCourse([periodData["1y"]?.courses?.[2], periodData["1y"]?.courses?.[3], periodData["1y"]?.courses?.[4]]);
  const outside_1y = aggregateMultiCourse([periodData["1y"]?.courses?.[5], periodData["1y"]?.courses?.[6]]);
  const all_1y = aggregateMultiCourse([1, 2, 3, 4, 5, 6].map(c => periodData["1y"]?.courses?.[c]));

  if (currentScores.in_strength != null && currentScores.in_strength >= 75 && (c1_1y?.race_count || 0) >= 20) types.push("IN_SPECIALIST");
  if (currentScores.mid_second != null && currentScores.mid_second >= 70 && (mid_1y?.race_count || 0) >= 20) types.push("MID_SECOND_SPECIALIST");
  if (currentScores.mid_third != null && currentScores.mid_third >= 70 && (mid_1y?.race_count || 0) >= 20) types.push("MID_THIRD_SPECIALIST");
  if (currentScores.outside_third != null && currentScores.outside_third >= 65 && (currentScores.outside_second || 0) < 55) types.push("UICHI_OUTSIDE_SPECIALIST");
  if (currentScores.outside_second != null && currentScores.outside_second >= 65) types.push("URA_UICHI_OUTSIDE_SPECIALIST");
  if (outside_1y && outside_1y.win_rate > 0.08 && outside_1y.race_count >= 20) types.push("OUTSIDE_DANGER");
  if (all_1y && all_1y.finish_order_std > 1.8 && all_1y.race_count >= 20) types.push("UNSTABLE");

  return types;
}

// ─── 最も得意なコース ──────────────────────────────────────
export function findBestCourse(periodData) {
  let best = null;
  let bestScore = -1;
  for (const p of ["6m", "1y", "3y"]) {
    const courses = periodData[p]?.courses;
    if (!courses) continue;
    for (let c = 1; c <= 6; c++) {
      const cs = courses[c];
      if (!cs || !cs.has_data || cs.race_count < 5) continue;
      // コース別の「適性スコア」を簡易計算
      let s;
      if (c === 1) s = (cs.win_rate || 0) * 100;
      else if (c <= 4) s = (cs.top2_rate || 0) * 80;
      else s = (cs.top3_rate || 0) * 100;
      if (s > bestScore) { bestScore = s; best = c; }
    }
  }
  return best;
}

// ─── レース構成スコア計算 ──────────────────────────────────
// boatEvaluations: [{ boat_number, in_strength, mid_second, mid_third, outside_second, outside_third, player_types }]
export function computeRaceStructure(boatEvaluations) {
  const byBoat = {};
  for (const b of boatEvaluations) byBoat[b.boat_number] = b;

  const boat1 = byBoat[1];
  const inStrength = boat1?.in_strength ?? 50;

  // ういち: 1-234-56
  const midBoats = [byBoat[2], byBoat[3], byBoat[4]].filter(Boolean);
  const outsideBoats = [byBoat[5], byBoat[6]].filter(Boolean);

  const midSecondCandidates = midBoats
    .map(b => ({ boat_number: b.boat_number, registration_number: b.registration_number, racer_name: b.racer_name, score: b.mid_second }))
    .filter(x => x.score != null)
    .sort((a, b) => b.score - a.score);
  const outsideThirdCandidates = outsideBoats
    .map(b => ({ boat_number: b.boat_number, registration_number: b.registration_number, racer_name: b.racer_name, score: b.outside_third }))
    .filter(x => x.score != null)
    .sort((a, b) => b.score - a.score);

  const bestMidSecond = midSecondCandidates[0]?.score ?? 50;
  const bestOutsideThird = outsideThirdCandidates[0]?.score ?? 50;

  let uichiScore = inStrength * 0.40 + bestMidSecond * 0.30 + bestOutsideThird * 0.30;
  const uichiRisks = [];
  for (const b of outsideBoats) {
    if (b.player_types?.includes("OUTSIDE_DANGER")) { uichiScore -= 5; uichiRisks.push({ boat: b.boat_number, type: "OUTSIDE_DANGER", penalty: 5 }); }
  }
  for (const b of midBoats) {
    if (b.player_types?.includes("UNSTABLE")) { uichiScore -= 3; uichiRisks.push({ boat: b.boat_number, type: "UNSTABLE", penalty: 3 }); }
  }
  if (bestMidSecond < 60) { uichiScore -= 10; uichiRisks.push({ type: "NO_MID_SECOND_CANDIDATE", penalty: 10 }); }
  if (bestOutsideThird < 55) { uichiScore -= 10; uichiRisks.push({ type: "NO_OUTSIDE_THIRD_CANDIDATE", penalty: 10 }); }

  // 裏ういち: 1-56-234
  const outsideSecondCandidates = outsideBoats
    .map(b => ({ boat_number: b.boat_number, registration_number: b.registration_number, racer_name: b.racer_name, score: b.outside_second }))
    .filter(x => x.score != null)
    .sort((a, b) => b.score - a.score);
  const midThirdCandidates = midBoats
    .map(b => ({ boat_number: b.boat_number, registration_number: b.registration_number, racer_name: b.racer_name, score: b.mid_third }))
    .filter(x => x.score != null)
    .sort((a, b) => b.score - a.score);

  const bestOutsideSecond = outsideSecondCandidates[0]?.score ?? 50;
  const bestMidThird = midThirdCandidates[0]?.score ?? 50;

  let uraScore = inStrength * 0.40 + bestOutsideSecond * 0.35 + bestMidThird * 0.25;
  const uraRisks = [];
  if (bestOutsideSecond < 55) { uraScore -= 15; uraRisks.push({ type: "NO_OUTSIDE_SECOND_CANDIDATE", penalty: 15 }); }
  if (bestMidThird < 55) { uraScore -= 10; uraRisks.push({ type: "NO_MID_THIRD_CANDIDATE", penalty: 10 }); }

  return {
    uichi_player_structure_score: clamp(uichiScore),
    ura_uichi_player_structure_score: clamp(uraScore),
    uichi_breakdown: {
      in_strength: inStrength,
      mid_second_candidates: midSecondCandidates,
      outside_third_candidates: outsideThirdCandidates,
      risk_factors: uichiRisks,
    },
    ura_uichi_breakdown: {
      in_strength: inStrength,
      outside_second_candidates: outsideSecondCandidates,
      mid_third_candidates: midThirdCandidates,
      risk_factors: uraRisks,
    },
  };
}
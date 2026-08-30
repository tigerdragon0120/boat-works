// BOAT WORKS 共通分析ロジック（集計Entityベース・v3）
// RaceResult全件を読まず、RacerStats/RacerVenueStats/VenueRaceStats等の集計済みEntityから分析する。
// データ量が増えても分析時間は増えない。

import { UICHI_COMBOS, URA_UICHI_COMBOS, gradeBoat1, syntheticOdds, expectedValue } from "./uichi.js";
import { windSpeedGroup } from "./aggregation.js";

// 分析ロジックバージョン（ロジック変更時のみインクリメント）
export const ANALYSIS_VERSION = "v10";

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

// v8 番組意図エンジン。
// 第1層はモーターを見ず、枠配置・級別・基本力・場×Rの癖から「何を狙った番組か」を仮説化する。
function computeProgramIntent(entries, vrs) {
  const b = n => entries.find(e => e.boat_number === n);
  const baseStrength = (e) => {
    if (!e) return 0;
    const grade = (gradeToScore(e.grade_class) ?? 0.5) * 55;
    const win = clamp((e.national_win_rate || 0) / 8, 0, 1) * 30;
    const nat2 = clamp((e.national_2rate || 0) / 60, 0, 1) * 15;
    return clamp(Math.round(grade + win + nat2), 0, 100);
  };
  const s1 = baseStrength(b(1));
  const mids = [2,3,4].map(n => baseStrength(b(n)));
  const outers = [5,6].map(n => baseStrength(b(n)));
  const avg = a => a.reduce((x,y)=>x+y,0) / Math.max(a.length,1);
  const midAvg = avg(mids), outerAvg = avg(outers);
  const outerMax = Math.max(...outers, 0), midMax = Math.max(...mids, 0);

  // 1号艇を軸に置いた度合い。弱い選手の1枠なら意図があっても成立性は後段で落とす。
  const axisPlacement = clamp(45 + (s1 - avg([...mids, ...outers])) * 0.9, 0, 100);
  // 本線意図: 234を相手本命、56をヒモ穴として置いた形。
  const mainShape = clamp(55 + (midAvg - outerAvg) * 0.85 + Math.max(0, outerMax - 45) * 0.25, 0, 100);
  // 裏意図: 56に「外なのに強い」配置があり、234は3着に残せる程度の厚みがある形。
  const uraShape = clamp(45 + (outerMax - midAvg) * 1.15 + Math.max(0, midAvg - 45) * 0.30, 0, 100);

  const n = vrs?.total_races || 0;
  const shrink = clamp(n / (n + 120), 0, 0.70);
  const histMain = vrs?.uichi_rate || 0;
  const histUra = vrs?.ura_uichi_rate || 0;
  const habit = clamp((histMain - histUra) * 420 * shrink, -24, 24);

  const mainIntent = Math.round(clamp(axisPlacement * 0.35 + mainShape * 0.50 + Math.max(habit,0), 0, 100));
  const uraIntent = Math.round(clamp(axisPlacement * 0.35 + uraShape * 0.50 + Math.max(-habit,0), 0, 100));
  const diff = mainIntent - uraIntent;
  let hypothesis = "NEUTRAL";
  if (diff >= 10) hypothesis = "MAIN";
  else if (diff <= -10) hypothesis = "URA";
  const confidence = Math.round(clamp(Math.abs(diff) * 2.4 + Math.max(mainIntent, uraIntent) * 0.45 + Math.abs(habit) * 0.8, 0, 100));
  const reasons = [];
  if (axisPlacement >= 65) reasons.push({ label: `1号艇を軸に置く番組構成 ${Math.round(axisPlacement)}`, side: "axis", score: axisPlacement });
  if (mainShape >= 65) reasons.push({ label: `2〜4号艇を相手本線に置く配置 ${Math.round(mainShape)}`, side: "main", score: mainShape });
  if (uraShape >= 65) reasons.push({ label: `5・6号艇に外枠以上の強さを配置 ${Math.round(uraShape)}`, side: "ura", score: uraShape });
  if (Math.abs(habit) >= 6) reasons.push({ label: `この場×Rの番組結果は${habit > 0 ? "本線" : "裏"}寄り`, side: habit > 0 ? "main" : "ura", score: 50 + Math.abs(habit) });
  return { hypothesis, main_intent: mainIntent, ura_intent: uraIntent, confidence, axis_placement: Math.round(axisPlacement), historical_habit: Math.round(habit), reasons };
}

// 第2層: 番組意図を選手が実現できるか。モーターは見ない。
function computeRacerExecution(entries, boat1Trust) {
  const b = n => entries.find(e => e.boat_number === n);
  const second = e => {
    if (!e) return 0;
    return Math.round(clamp((gradeToScore(e.grade_class) ?? .5)*12 + clamp((e.national_2rate||0)/60,0,1)*32 + clamp((e.local_2rate||0)/60,0,1)*22 + clamp((.23-(e.avg_st||.23))/.15,0,1)*20 + clamp((e.national_win_rate||0)/8,0,1)*14, 0, 100));
  };
  const third = e => {
    if (!e) return 0;
    return Math.round(clamp((gradeToScore(e.grade_class) ?? .5)*10 + clamp((e.national_3rate||0)/70,0,1)*36 + clamp((e.local_3rate||0)/70,0,1)*25 + clamp((.24-(e.avg_st||.24))/.16,0,1)*17 + clamp((e.national_win_rate||0)/8,0,1)*12, 0, 100));
  };
  const pool = arr => Math.round(Math.max(...arr,0)*.62 + arr.reduce((a,c)=>a+c,0)/Math.max(arr.length,1)*.38);
  const midSecond = pool([2,3,4].map(n=>second(b(n))));
  const midThird = pool([2,3,4].map(n=>third(b(n))));
  const outerSecond = pool([5,6].map(n=>second(b(n))));
  const outerThird = pool([5,6].map(n=>third(b(n))));
  const boat1 = b(1);
  // trustにはモーターが混じるため、1号艇実行力は選手項目を中心に再計算しtrustは補助に留める。
  const escape = Math.round(clamp(
    clamp((boat1?.c1_win_rate||0)/70,0,1)*36 + clamp((boat1?.national_win_rate||0)/8,0,1)*20 + clamp((boat1?.local_win_rate||0)/8,0,1)*18 + clamp((.24-(boat1?.avg_st||.24))/.16,0,1)*18 + ((boat1?.f_count||0)===0?8:0), 0, 100));
  const mainExecution = Math.round(clamp(escape*.40 + midSecond*.32 + outerThird*.28, 0, 100));
  const uraExecution = Math.round(clamp(escape*.40 + outerSecond*.34 + midThird*.26, 0, 100));
  return { escape, main_execution: mainExecution, ura_execution: uraExecution, mid_second: midSecond, mid_third: midThird, outer_second: outerSecond, outer_third: outerThird, trust_reference: boat1Trust || 0 };
}

// 第3層: モーターが番組仮説を後押しするか、壊すか。
function computeMotorSupport(entries) {
  const b = n => entries.find(e => e.boat_number === n);
  const m2 = e => e ? Math.round(clamp((e.motor_2rate||0)/50,0,1)*70 + clamp((e.boat_2rate||0)/50,0,1)*30) : 0;
  const m3 = e => e ? Math.round(clamp((e.motor_3rate||0)/65,0,1)*70 + clamp((e.boat_3rate||0)/65,0,1)*30) : 0;
  const pool = arr => Math.round(Math.max(...arr,0)*.60 + arr.reduce((a,c)=>a+c,0)/Math.max(arr.length,1)*.40);
  const boat1Motor = Math.round(m2(b(1))*.70 + m3(b(1))*.30);
  const midSecond = pool([2,3,4].map(n=>m2(b(n))));
  const midThird = pool([2,3,4].map(n=>m3(b(n))));
  const outerSecond = pool([5,6].map(n=>m2(b(n))));
  const outerThird = pool([5,6].map(n=>m3(b(n))));
  return {
    boat1_motor: boat1Motor,
    main_support: Math.round(clamp(boat1Motor*.35 + midSecond*.35 + outerThird*.30,0,100)),
    ura_support: Math.round(clamp(boat1Motor*.35 + outerSecond*.38 + midThird*.27,0,100)),
  };
}

// v9 直前展示ゲート。
// 事前の選手評価とは分離し、最終段階だけ「今このレースで1号艇が逃げられるか」を判定する。
function computeExhibitionGate(race, entries, racerEscape, motorBoat1, weatherStat, stage) {
  if (stage === "pre") {
    return { status: "PRE", score: null, exhibition_score: null, weather_score: null, reasons: [], ready: false };
  }

  const b1 = entries.find(e => e.boat_number === 1);
  const active = entries.filter(e => !e.is_scratched && e.exhibition_time != null);
  const startActive = entries.filter(e => !e.is_scratched && e.exhibition_st != null);
  const ready = race?.exhibition_ready === true && !!b1 && b1.exhibition_time != null && startActive.length >= 3;
  if (!ready) {
    return { status: "MISSING", score: null, exhibition_score: null, weather_score: null, reasons: [{ label: "展示情報未取得", score: 0, layer: "exhibition" }], ready: false };
  }

  const reasons = [];
  const times = active.map(e => e.exhibition_time).filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
  const bestTime = times[0] ?? b1.exhibition_time;
  const worstTime = times[times.length - 1] ?? b1.exhibition_time;
  const rank = b1.exhibition_rank || (times.indexOf(b1.exhibition_time) + 1);
  const timeSpread = Math.max(worstTime - bestTime, 0.01);
  const relativeTimeScore = clamp(100 - ((b1.exhibition_time - bestTime) / timeSpread) * 80, 20, 100);
  const rankScore = clamp(110 - rank * 15, 20, 100);

  // 展示STは絶対値だけでなく他艇との差を見る。F展示は本番で踏み込みを下げる可能性もあるため過大評価しない。
  const validSt = startActive.map(e => e.exhibition_st).filter(v => Number.isFinite(v));
  const fieldAvgSt = validSt.length ? validSt.reduce((a,b)=>a+b,0) / validSt.length : 0.15;
  const b1St = b1.exhibition_st;
  let stScore = b1St == null ? 50 : clamp(55 + (fieldAvgSt - b1St) * 220, 20, 95);
  if (String(b1.exhibition_st_raw || "").startsWith("F")) stScore = Math.min(stScore, 68);

  const courseScore = b1.entry_course === 1 ? 100 : b1.entry_course === 2 ? 35 : 10;
  const exhibitionScore = Math.round(clamp(relativeTimeScore*.38 + rankScore*.22 + stScore*.25 + courseScore*.15, 0, 100));

  // 同じ晴/雨・風速帯での1着実績。サンプル不足なら中立50として扱い、推測で加点しない。
  let weatherScore = 50;
  if (weatherStat?.races >= 5 && weatherStat?.win_rate != null) {
    weatherScore = Math.round(clamp(weatherStat.win_rate / 0.70 * 100, 0, 100));
    reasons.push({ label: `同天候${weatherStat.races}走 1着率${Math.round(weatherStat.win_rate*100)}%`, score: weatherScore, layer: "weather" });
  }

  const score = Math.round(clamp(
    (racerEscape || 0)*.38 + (motorBoat1 || 0)*.17 + weatherScore*.15 + exhibitionScore*.30,
    0, 100
  ));

  reasons.push({ label: `1号艇 展示${rank}位 ${b1.exhibition_time.toFixed(2)}`, score: Math.round(relativeTimeScore), layer: "exhibition" });
  reasons.push({ label: `展示ST ${b1.exhibition_st_raw || "—"}`, score: Math.round(stScore), layer: "exhibition" });
  reasons.push({ label: `展示進入 ${b1.entry_course || "—"}コース`, score: courseScore, layer: "exhibition" });

  let status = "PASS";
  if (b1.entry_course !== 1 || score < 52 || exhibitionScore < 42) status = "FAIL";
  else if (score < 62 || exhibitionScore < 55) status = "CAUTION";

  return {
    status, score, exhibition_score: exhibitionScore, weather_score: weatherScore,
    exhibition_rank: rank, exhibition_time: b1.exhibition_time,
    exhibition_st: b1.exhibition_st, exhibition_st_raw: b1.exhibition_st_raw || null,
    entry_course: b1.entry_course || null,
    ready: true, reasons,
  };
}

function computeSeriesRaceContext(race, entries, stats) {
  const points = stats?.seriesPointsBySeries?.[race?.series_key] || {};
  const byBoat = {};
  for (const e of entries) if (e?.registration_number) byBoat[e.boat_number] = points[e.registration_number] || null;
  const b1 = byBoat[1];
  const b1Runs = Number(b1?.races_run || 0);
  const b1Score = b1Runs > 0 ? Number(b1?.series_score ?? 50) : 50;
  const pressure = Number(b1?.rank_pressure_score ?? 50);
  const phase = race?.race_phase || 'OTHER';
  const grade = race?.grade || 'GENERAL';
  const previousDate = (() => {
    if (!race?.race_date) return null;
    const d = new Date(`${race.race_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0,10);
  })();
  // 2日目以降は「前日全レース終了後のsnapshot」が必須。
  // 18時台に翌日表が先に公開されても、古いシリーズ状態でアラートを確定しない。
  const snapshotReady = Number(race?.series_day || 1) <= 1 || (!!b1 && b1.as_of_date === previousDate);

  const routineOuter = [5,6].filter(n => {
    const e = entries.find(x=>Number(x.boat_number)===n);
    const p = byBoat[n];
    if (!e || e.grade_class !== 'B2') return false;
    return p?.alert_exclusion === true || (Number(p?.races_run||0) >= 2 && Number(p?.avg_lane||0) >= 4.5 && Number(p?.inner_lane_count||0) === 0);
  });
  const outerB2 = [5,6].filter(n => entries.find(x=>Number(x.boat_number)===n)?.grade_class === 'B2');
  const routineOuterExclusion = grade === 'GENERAL' && (
    routineOuter.length >= 2 ||
    (routineOuter.length >= 1 && outerB2.length >= 2)
  );

  // 予選ボーダー付近で翌日1号艇を与えられた場合は「軸配置の意図」の補強材料。
  // 能力そのものへの大加点はせず、番組意図の信頼度だけを上げる。
  const placementSignal = phase === 'QUALIFYING' && pressure >= 80 && (
    Number(b1?.avg_lane || 0) >= 3.3 || Number(b1?.inner_lane_count || 0) <= 1
  );

  const scoreAdj = b1Runs >= 2 ? clamp((b1Score - 50) * 0.20, -8, 8) : 0;
  const weakSeries = b1Runs >= 2 && b1Score < 35;
  const reasons = [];
  const concerns = [];
  if (b1Runs > 0) reasons.push({ label:`今節指数 ${Math.round(b1Score)} (${b1?.series_label || '—'})`, strength:Math.round(50 + Math.abs(b1Score-50)/2), layer:'series' });
  if (b1?.rank != null && b1?.point_rate != null) reasons.push({ label:`得点率${Number(b1.point_rate).toFixed(2)} / ${b1.rank}位 / 勝負度${Math.round(pressure)}`, strength:Math.round(pressure), layer:'series' });
  if (placementSignal) reasons.push({ label:'勝負がけ圏で翌日1号艇の番組配置', strength:88, layer:'series' });
  if (!snapshotReady) concerns.push({ label:'前日全結果・今節ポイントの確定待ち', severity:30, layer:'series' });
  if (routineOuterExclusion) concerns.push({ label:'一般戦のB2外枠通常配置（偽シグナル）', severity:20, layer:'series' });
  if (weakSeries) concerns.push({ label:`1号艇 今節指数${Math.round(b1Score)}で低調`, severity:10, layer:'series' });

  return {
    by_boat:byBoat, boat1:b1 || null, boat1_score:b1Score, boat1_runs:b1Runs,
    pressure, score_adjustment:scoreAdj, placement_signal:placementSignal,
    snapshot_ready:snapshotReady,
    routine_outer_exclusion:routineOuterExclusion, weak_series:weakSeries,
    reasons, concerns,
  };
}

function computeUichiDirection(entries, trustScore, vrs, seriesCtx = null) {
  const intent = computeProgramIntent(entries, vrs);
  const racer = computeRacerExecution(entries, trustScore);
  if (seriesCtx && seriesCtx.boat1_runs >= 2) {
    const adj = seriesCtx.score_adjustment || 0;
    racer.escape = Math.round(clamp(racer.escape + adj, 0, 100));
    racer.main_execution = Math.round(clamp(racer.main_execution + adj * 0.7, 0, 100));
    racer.ura_execution = Math.round(clamp(racer.ura_execution + adj * 0.7, 0, 100));
  }
  const motor = computeMotorSupport(entries);

  // 番組意図が主役。選手は「そのシナリオを実現できるか」、モーターは最後の裏付け。
  // 意図と選手が逆方向なら大きく減衰し、モーターだけでは方向を反転させない。
  const mainIntentGate = .55 + intent.main_intent/220;
  const uraIntentGate = .55 + intent.ura_intent/220;
  const mainSuitability = Math.round(clamp((intent.main_intent*.50 + racer.main_execution*.32 + motor.main_support*.18) * mainIntentGate, 0, 100));
  const uraSuitability = Math.round(clamp((intent.ura_intent*.50 + racer.ura_execution*.32 + motor.ura_support*.18) * uraIntentGate, 0, 100));

  let directionIndex = Math.round(clamp((mainSuitability - uraSuitability)*2.6, -100, 100));
  // 番組意図が中立なら、選手・モーターだけで強い方向判定を出さない。
  if (intent.hypothesis === "NEUTRAL") directionIndex = Math.round(directionIndex*.55);
  const chosenExecution = directionIndex >= 0 ? racer.main_execution : racer.ura_execution;
  const chosenMotor = directionIndex >= 0 ? motor.main_support : motor.ura_support;

  // 番組側の意図が見えても、1号艇が逃げ切れない選手なら「番組意図不成立」。
  // モーターだけが弱い場合は方向を反転させず、信頼度を落として見送り寄りにする。
  let scenarioStatus = "VALID";
  let scenarioLabel = "番組意図成立";
  let scenarioPenalty = 0;
  if (intent.hypothesis === "NEUTRAL") {
    scenarioStatus = "NEUTRAL";
    scenarioLabel = "番組意図不明瞭";
    scenarioPenalty = 25;
  } else if (racer.escape < 52 || chosenExecution < 52) {
    scenarioStatus = "PLAYER_BREAK";
    scenarioLabel = "番組意図不成立（選手）";
    scenarioPenalty = 40;
    directionIndex = Math.round(directionIndex * 0.35);
  } else if (chosenMotor < 38) {
    scenarioStatus = "MOTOR_BREAK";
    scenarioLabel = "番組意図弱化（モーター）";
    scenarioPenalty = 22;
    directionIndex = Math.round(directionIndex * 0.72);
  }
  if (seriesCtx?.placement_signal) {
    intent.axis_placement = Math.round(clamp(intent.axis_placement + 8, 0, 100));
    intent.confidence = Math.round(clamp(intent.confidence + 6, 0, 100));
    intent.main_intent = Math.round(clamp(intent.main_intent + 4, 0, 100));
    intent.ura_intent = Math.round(clamp(intent.ura_intent + 4, 0, 100));
  }
  const confidence = Math.round(clamp(intent.confidence*.50 + chosenExecution*.32 + chosenMotor*.18 - scenarioPenalty, 0, 100));

  let label = "中立";
  if (directionIndex >= 60 && confidence >= 60) label = "本線ういち濃厚";
  else if (directionIndex >= 25) label = "本線ういち寄り";
  else if (directionIndex <= -60 && confidence >= 60) label = "裏ういち濃厚";
  else if (directionIndex <= -25) label = "裏ういち寄り";

  const reasons = [
    ...intent.reasons.map(r=>({...r, layer:"program"})),
    { label:`1号艇 選手逃げ実行力 ${racer.escape}`, score:racer.escape, layer:"racer", side:"axis" },
    directionIndex >= 0
      ? { label:`選手で本線成立 ${racer.main_execution}`, score:racer.main_execution, layer:"racer", side:"main" }
      : { label:`選手で裏成立 ${racer.ura_execution}`, score:racer.ura_execution, layer:"racer", side:"ura" },
    directionIndex >= 0
      ? { label:`モーター本線支援 ${motor.main_support}`, score:motor.main_support, layer:"motor", side:"main" }
      : { label:`モーター裏支援 ${motor.ura_support}`, score:motor.ura_support, layer:"motor", side:"ura" },
  ].sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,7);

  return {
    direction_index: directionIndex,
    label,
    confidence,
    main_suitability: mainSuitability,
    ura_suitability: uraSuitability,
    main_structure: racer.main_execution,
    ura_structure: racer.ura_execution,
    mid_second_score: racer.mid_second,
    mid_third_score: racer.mid_third,
    outer_second_score: racer.outer_second,
    outer_third_score: racer.outer_third,
    historical_direction: intent.historical_habit,
    program_hypothesis: intent.hypothesis,
    program_main_intent: intent.main_intent,
    program_ura_intent: intent.ura_intent,
    program_intent_confidence: intent.confidence,
    program_axis_placement: intent.axis_placement,
    racer_escape_execution: racer.escape,
    racer_main_execution: racer.main_execution,
    racer_ura_execution: racer.ura_execution,
    motor_main_support: motor.main_support,
    motor_ura_support: motor.ura_support,
    motor_boat1_support: motor.boat1_motor,
    program_scenario_status: scenarioStatus,
    program_scenario_label: scenarioLabel,
    program_scenario_penalty: scenarioPenalty,
    reasons,
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

  // まず場×Rの実績を基準値にする。最終的な出現率は番組構成を計算した後で校正する。
  let appearanceRate = baseUichiRate;

  // 裏ういち 1-56-234。過去の場×R出現率を土台に、1号艇信頼と5/6号艇の
  // 『2着まで突っ込める力』で補正する。集計未構築時は0として誤表示しない。
  const baseUraRate = vrs?.ura_uichi_rate ?? 0;

  const similarCount = vrs?.total_races ?? 0;
  const uichiHits = vrs?.uichi_hits ?? 0;

  // オッズ。最終EVは本線/裏の推奨方向が決まってから計算する。
  let synthOdds = 0, oddsValues = [], mainSynthOdds = 0, uraSynthOdds = 0;
  if (odds && stage !== "pre") {
    const allOdds = odds.all_trifecta_odds || {};
    const mainValues = UICHI_COMBOS.map(c => odds["odds_" + c.replace(/-/g, "_")] ?? allOdds[c]);
    const uraValues = URA_UICHI_COMBOS.map(c => allOdds[c]);
    mainSynthOdds = syntheticOdds(mainValues);
    uraSynthOdds = syntheticOdds(uraValues);
  }
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
  const seriesContext = computeSeriesRaceContext(race, entries, stats);
  const uichiDirection = computeUichiDirection(entries, trust?.score || 0, vrs, seriesContext);
  const exhibitionGate = computeExhibitionGate(
    race, entries,
    uichiDirection.racer_escape_execution,
    uichiDirection.motor_boat1_support,
    weatherStat,
    stage
  );

  // v8: 出現率の暴走を抑える校正。
  // 場×Rの実測を土台に、1号艇の相対信頼と番組構成を緩やかに掛ける。
  // 以前のように venueBoat1WinRate が小さい時に95%まで跳ねる比率補正は使わない。
  const racerEscapeAdj = venueBoat1WinRate > 0.05
    ? clamp(racerBoat1WinRate / venueBoat1WinRate, 0.75, 1.25)
    : 1;
  const trustAdj = clamp(0.88 + (trust?.score || 0) / 650, 0.88, 1.04);
  const mainStructureAdj = clamp(0.78 + uichiDirection.main_structure / 300, 0.78, 1.12);
  const uraStructureAdj = clamp(0.78 + uichiDirection.ura_structure / 300, 0.78, 1.12);

  appearanceRate = baseUichiRate > 0
    ? clamp(baseUichiRate * racerEscapeAdj * trustAdj * mainStructureAdj, 0, 0.45)
    : 0;
  const uraUichiRate = baseUraRate > 0
    ? clamp(baseUraRate * racerEscapeAdj * trustAdj * uraStructureAdj, 0, 0.45)
    : 0;

  const totalPool = stats.totalRaces ?? 0;
  const validPool = totalPool;
  const sufficiency = totalPool > 0 ? 1 : 0;
  const reliability = reliabilityGradeFromSample(similarCount, settings);

  // 方向指数から狙う型を決める。中立は無理に買い方向を付けない。
  let recommendedPattern = "NEUTRAL";
  if (uichiDirection.direction_index >= 20) recommendedPattern = "MAIN";
  else if (uichiDirection.direction_index <= -20) recommendedPattern = "URA";
  const recommendedRate = recommendedPattern === "URA" ? uraUichiRate : recommendedPattern === "MAIN" ? appearanceRate : Math.max(appearanceRate, uraUichiRate);
  const recommendedStructure = recommendedPattern === "URA" ? uichiDirection.ura_structure : recommendedPattern === "MAIN" ? uichiDirection.main_structure : Math.max(uichiDirection.main_structure, uichiDirection.ura_structure);

  // v8: 最終判定も推奨方向の6点オッズを使う。裏推奨時に本線オッズでEVを出さない。
  if (stage !== "pre") {
    if (recommendedPattern === "URA") {
      synthOdds = uraSynthOdds;
      oddsValues = URA_UICHI_COMBOS.map(c => odds?.all_trifecta_odds?.[c]);
    } else if (recommendedPattern === "MAIN") {
      synthOdds = mainSynthOdds;
      oddsValues = UICHI_COMBOS.map(c => odds?.["odds_" + c.replace(/-/g, "_")] ?? odds?.all_trifecta_odds?.[c]);
    } else {
      synthOdds = 0;
      oddsValues = [];
    }
  }
  let ev = stage === "pre" || recommendedPattern === "NEUTRAL" ? null : expectedValue(recommendedRate, synthOdds);

  const scratchedBoats = Array.isArray(odds?.scratched_boats) ? odds.scratched_boats : [];
  const hasScratch = scratchedBoats.length > 0 || odds?.has_scratch === true;
  if (hasScratch && stage !== "pre") {
    // 欠場レースは期待値・合成オッズ自体を買い判断に使わせない。
    synthOdds = 0;
    ev = null;
    oddsValues = [];
  }

  let judgment = "PENDING";
  if (stage === "pre") judgment = "PENDING";
  else if (hasScratch) judgment = "SKIP";
  else if (recommendedPattern === "NEUTRAL") judgment = "SKIP";
  // v9: 最終BUYは展示後の「逃げゲート」を必ず通す。
  // 展示未取得・進入崩れ・逃げスコア不足は、高EVでも買わない。
  else if (exhibitionGate.status === "MISSING" || exhibitionGate.status === "FAIL") judgment = "SKIP";
  else if (minOk) {
    judgment = judgeWithSample(ev, similarCount, settings);
    // 注意域はBUYまで上げずWATCH止まり。PASSだけがBUY可能。
    if (exhibitionGate.status === "CAUTION" && judgment === "BUY") judgment = "WATCH";
  }
  else judgment = "SKIP";

  let preGrade = null;
  if (stage === "pre") {
    const ar = recommendedRate * 100;
    const preThr = settings?.pre_alert_rate ?? 20;
    const conf = uichiDirection.confidence || 0;
    const intentConf = uichiDirection.program_intent_confidence || 0;
    const escape = uichiDirection.racer_escape_execution || 0;
    const motorSupport = recommendedPattern === "URA" ? uichiDirection.motor_ura_support : uichiDirection.motor_main_support;
    const scenarioOk = uichiDirection.program_scenario_status === "VALID";

    // v8: 順序を固定。
    // ①番組意図が明確 → ②その意図を選手が実現可能 → ③モーターが否定していない、の順で候補化する。
    if (scenarioOk && recommendedPattern !== "NEUTRAL" && ar >= preThr + 2 && intentConf >= 60 && escape >= 70 && recommendedStructure >= 70 && motorSupport >= 55 && conf >= 62) preGrade = "S";
    else if (scenarioOk && recommendedPattern !== "NEUTRAL" && ar >= preThr && intentConf >= 50 && escape >= 60 && recommendedStructure >= 62 && motorSupport >= 45 && conf >= 52) preGrade = "A";
    else if (ar >= preThr) preGrade = "B";
    else preGrade = "C";

    // v10: 一般戦でB2が普段通り5/6枠に置かれているだけの構成は番組意図として扱わない。
    // また1号艇が今節明確に低調ならS/Aアラートへ上げない。
    if (!seriesContext.snapshot_ready) preGrade = "C";
    else if (seriesContext.routine_outer_exclusion) preGrade = "C";
    else if (seriesContext.weak_series && (preGrade === "S" || preGrade === "A")) preGrade = "B";
  }

  // ランキングは推奨側の出現率・構造・方向信頼度で並べる。
  const weightedProbability = recommendedRate * (0.55 + (trust?.score || 0) / 400 + recommendedStructure / 500 + (uichiDirection.confidence || 0) / 1000);

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
    has_scratch: hasScratch,
    scratched_boats: scratchedBoats,
    recommended_pattern: recommendedPattern,
    recommended_rate: recommendedRate,
    recommended_structure: recommendedStructure,
    pre_grade: preGrade,
    reasons: [...(seriesContext.reasons || []), ...(trust?.reasons || [])].slice(0, 9),
    concerns: [...(seriesContext.concerns || []), ...(trust?.concerns || [])].slice(0, 9),
    condition_matches: trust?.condition_match?.conditions || [],
    outer_boat_score: outer?.score ?? 0,
    outer_boat_number: outer?.boat_number ?? null,
    outer_boat_name: outer?.racer_name ?? null,
    outer_boat_reasons: outer?.reasons || [],
    uichi_direction_index: uichiDirection.direction_index,
    uichi_direction_label: uichiDirection.label,
    uichi_direction_confidence: uichiDirection.confidence,
    uichi_main_suitability: uichiDirection.main_suitability,
    uichi_ura_suitability: uichiDirection.ura_suitability,
    uichi_main_structure: uichiDirection.main_structure,
    uichi_ura_structure: uichiDirection.ura_structure,
    mid_second_score: uichiDirection.mid_second_score,
    mid_third_score: uichiDirection.mid_third_score,
    outer_second_score: uichiDirection.outer_second_score,
    outer_third_score: uichiDirection.outer_third_score,
    historical_direction: uichiDirection.historical_direction,
    program_hypothesis: uichiDirection.program_hypothesis,
    program_main_intent: uichiDirection.program_main_intent,
    program_ura_intent: uichiDirection.program_ura_intent,
    program_intent_confidence: uichiDirection.program_intent_confidence,
    program_axis_placement: uichiDirection.program_axis_placement,
    racer_escape_execution: uichiDirection.racer_escape_execution,
    racer_main_execution: uichiDirection.racer_main_execution,
    racer_ura_execution: uichiDirection.racer_ura_execution,
    motor_main_support: uichiDirection.motor_main_support,
    motor_ura_support: uichiDirection.motor_ura_support,
    motor_boat1_support: uichiDirection.motor_boat1_support,
    program_scenario_status: uichiDirection.program_scenario_status,
    program_scenario_label: uichiDirection.program_scenario_label,
    program_scenario_penalty: uichiDirection.program_scenario_penalty,
    exhibition_gate_status: exhibitionGate.status,
    final_escape_score: exhibitionGate.score,
    exhibition_score: exhibitionGate.exhibition_score,
    weather_escape_score: exhibitionGate.weather_score,
    exhibition_rank: exhibitionGate.exhibition_rank ?? null,
    exhibition_time: exhibitionGate.exhibition_time ?? null,
    exhibition_st: exhibitionGate.exhibition_st ?? null,
    exhibition_st_raw: exhibitionGate.exhibition_st_raw ?? null,
    exhibition_entry_course: exhibitionGate.entry_course ?? null,
    exhibition_ready: exhibitionGate.ready === true,
    exhibition_reasons: exhibitionGate.reasons || [],
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
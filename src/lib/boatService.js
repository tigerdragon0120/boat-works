// BOAT WORKS データサービス層
// UIとデータ取得を分離。現状はサンプルデータ生成＋DB永続化。
// 実データ連携は base44/functions/fetchRaceData を差し替えれば適用可能。
import { base44 } from "@/api/base44Client";
import { VENUES, UICHI_COMBOS, syntheticOdds, expectedValue, judgeFromEV, gradeBoat1 } from "./boat";

function todayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const GRADE_CLASSES = ["A1", "A2", "B1", "B2"];
const BRANCHES = ["東京", "大阪", "愛知", "福岡", "静岡", "広島", "兵庫", "香川", "徳山", "尼崎"];
const RACER_NAMES = ["山田", "佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "加藤", "吉田", "山本", "中村", "小林", "清水", "松本", "井上", "木村", "林", "斎藤", "山口", "森"];

function genRacer(boatNum) {
  const nationalWinRate = boatNum === 1 ? rand(5.5, 7.8) : boatNum <= 3 ? rand(4.5, 6.5) : rand(3.0, 5.5);
  return {
    boat_number: boatNum,
    registration_number: String(randInt(4000, 4999)),
    racer_name: pick(RACER_NAMES) + " " + pick(RACER_NAMES),
    grade_class: boatNum === 1 ? pick(["A1", "A2"]) : pick(GRADE_CLASSES),
    branch: pick(BRANCHES),
    age: randInt(24, 48),
    weight: rand(49, 56),
    national_win_rate: Number(nationalWinRate.toFixed(2)),
    national_2rate: Number((nationalWinRate * 2.2 + rand(-3, 3)).toFixed(1)),
    national_3rate: Number((nationalWinRate * 3.1 + rand(-2, 4)).toFixed(1)),
    local_win_rate: Number((nationalWinRate + rand(-1.5, 1.5)).toFixed(2)),
    local_2rate: Number((nationalWinRate * 2.2 + rand(-3, 3)).toFixed(1)),
    local_3rate: Number((nationalWinRate * 3.1 + rand(-2, 4)).toFixed(1)),
    c1_win_rate: boatNum === 1 ? Number(rand(48, 68).toFixed(1)) : Number(rand(5, 25).toFixed(1)),
    c1_2rate: boatNum === 1 ? Number(rand(70, 85).toFixed(1)) : Number(rand(15, 40).toFixed(1)),
    c1_3rate: boatNum === 1 ? Number(rand(80, 92).toFixed(1)) : Number(rand(25, 50).toFixed(1)),
    avg_st: Number(rand(0.12, 0.22).toFixed(2)),
    f_count: Math.random() < 0.15 ? randInt(1, 2) : 0,
    l_count: Math.random() < 0.1 ? 1 : 0,
    motor_number: randInt(1, 70),
    motor_2rate: Number(rand(25, 55).toFixed(1)),
    motor_3rate: Number(rand(40, 70).toFixed(1)),
    boat_number_id: randInt(1, 100),
    boat_2rate: Number(rand(25, 55).toFixed(1)),
    boat_3rate: Number(rand(40, 70).toFixed(1)),
    season_record: `${randInt(1, 6)}-${randInt(0, 4)}-${randInt(0, 3)}`,
    entry_course: boatNum,
    exhibition_time: Number(rand(6.4, 6.9).toFixed(2)),
    tilt: Number(rand(-0.5, 0.5).toFixed(1)),
  };
}

function genOddsForUichi() {
  // 6点の3連単オッズ
  const odds = {};
  UICHI_COMBOS.forEach((c) => {
    odds["odds_" + c.replace(/-/g, "_")] = Number(rand(6, 45).toFixed(1));
  });
  return odds;
}

function genResult() {
  // 3連単結果。ういち買いが約15%で出現するよう偏らせる
  const isUichi = Math.random() < 0.15;
  let trifecta;
  if (isUichi) {
    trifecta = pick(UICHI_COMBOS);
  } else {
    const first = 1;
    const second = randInt(2, 6);
    let third = randInt(2, 6);
    while (third === second) third = randInt(2, 6);
    trifecta = `${first}-${second}-${third}`;
  }
  const [a, b, c] = trifecta.split("-").map(Number);
  return { trifecta, is_uichi: UICHI_COMBOS.includes(trifecta), result_1: a, result_2: b, result_3: c, payout: Number(rand(800, 18000).toFixed(0)) };
}

let seeding = false;
export async function seedIfNeeded() {
  if (seeding) return;
  seeding = true;
  try {
    const existing = await base44.entities.Race.filter({ race_date: todayStr(0) });
    if (existing.length > 0) return; // already seeded today

    // 1. VenueStats
    const venueStatsExist = await base44.entities.VenueStats.list(1);
    if (venueStatsExist.length === 0) {
      const vstats = VENUES.map((v) => ({
        venue_code: v.code,
        venue_name: v.name,
        c1_win_rate: Number(rand(50, 66).toFixed(1)),
        c2_sashi_rate: Number(rand(8, 18).toFixed(1)),
        c3_makuri_rate: Number(rand(5, 14).toFixed(1)),
        c4_makuri_rate: Number(rand(6, 16).toFixed(1)),
        c5_3rate: Number(rand(8, 20).toFixed(1)),
        c6_3rate: Number(rand(4, 14).toFixed(1)),
        uichi_rate: Number(rand(0.1, 0.2).toFixed(3)),
        sample_count: randInt(120, 300),
        last_updated: new Date().toISOString(),
      }));
      await base44.entities.VenueStats.bulkCreate(vstats);
    }

    // 2. Settings
    const settingsExist = await base44.entities.AppSettings.filter({ is_active_config: true });
    if (settingsExist.length === 0) {
      await base44.entities.AppSettings.create({
        buy_threshold: 110,
        watch_threshold: 100,
        pre_alert_rate: 15,
        min_similar_races: 30,
        analysis_period_months: 6,
        odds_update_interval: 60,
        notification_on: true,
        venues_enabled: VENUES.map((v) => v.code),
        is_active_config: true,
      });
    }

    // 3. Historical RaceResults (過去6か月分のサンプル)
    const resultsExist = await base44.entities.RaceResult.list(1);
    if (resultsExist.length === 0) {
      const results = [];
      for (let i = 0; i < 240; i++) {
        const v = pick(VENUES);
        const daysAgo = randInt(1, 180);
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        const r = genResult();
        const b1wr = Number(rand(5.5, 7.5).toFixed(2));
        results.push({
          race_id: `hist_${i}`,
          race_date: d.toISOString().slice(0, 10),
          venue_code: v.code,
          venue_name: v.name,
          race_number: randInt(1, 12),
          result_1: r.result_1,
          result_2: r.result_2,
          result_3: r.result_3,
          trifecta: r.trifecta,
          is_uichi: r.is_uichi,
          uichi_combo: r.is_uichi ? r.trifecta : null,
          payout_trifecta: r.payout,
          boat1_grade_class: pick(["A1", "A2", "B1"]),
          boat1_national_win_rate: b1wr,
          boat1_local_win_rate: Number((b1wr + rand(-1, 1)).toFixed(2)),
          boat1_avg_st: Number(rand(0.13, 0.21).toFixed(2)),
        });
      }
      await base44.entities.RaceResult.bulkCreate(results);
    }

    // 4. Today's & Tomorrow's races (batched)
    const raceObjs = [];
    for (const offset of [0, 1]) {
      const date = todayStr(offset);
      const activeVenues = VENUES.filter(() => Math.random() < 0.33).slice(0, 6);
      for (const v of activeVenues) {
        const raceCount = randInt(10, 12);
        for (let r = 1; r <= raceCount; r++) {
          const baseHour = offset === 0 ? (r <= 4 ? 8 : r <= 8 ? 11 : 14) : 9;
          const deadline = new Date(`${date}T${String(baseHour + Math.floor(r / 3)).padStart(2, "0")}:${String((r * 7) % 60).padStart(2, "0")}:00`);
          raceObjs.push({
            race_date: date,
            venue_code: v.code,
            venue_name: v.name,
            race_number: r,
            race_name: r <= 4 ? "モーニング" : r <= 8 ? "一般" : "特別選",
            grade: "一般",
            deadline: deadline.toISOString(),
            time_slot: r <= 4 ? "morning" : r <= 8 ? "day" : "night",
            weather: pick(["晴", "曇", "雨"]),
            wind_dir: pick(["北", "南", "東", "西"]),
            wind_speed: Number(rand(1, 8).toFixed(1)),
            wave_height: Number(rand(2, 8).toFixed(1)),
            status: "scheduled",
            data_source: "sample",
            last_updated: new Date().toISOString(),
          });
        }
      }
    }
    const createdRaces = await base44.entities.Race.bulkCreate(raceObjs);

    // entries + odds (batched)
    const allEntries = [];
    const allOdds = [];
    for (const race of createdRaces) {
      for (let b = 1; b <= 6; b++) {
        const e = genRacer(b);
        e.race_id = race.id;
        e.race_date = race.race_date;
        e.venue_code = race.venue_code;
        e.race_number = race.race_number;
        allEntries.push(e);
      }
      if (race.race_date === todayStr(0)) {
        const od = genOddsForUichi();
        od.race_id = race.id;
        od.race_date = race.race_date;
        od.captured_at = new Date().toISOString();
        od.stage = "initial";
        od.synthetic_odds = syntheticOdds(UICHI_COMBOS.map((c) => od["odds_" + c.replace(/-/g, "_")]));
        allOdds.push(od);
      }
    }
    if (allEntries.length) await base44.entities.RaceEntry.bulkCreate(allEntries);
    if (allOdds.length) await base44.entities.OddsSnapshot.bulkCreate(allOdds);

    // 5. Pre-day alerts for tomorrow's high-rate races
    const tomorrowRaces = createdRaces.filter((r) => r.race_date === todayStr(1));
    const alertObjs = tomorrowRaces.slice(0, 6).map((race) => {
      const rate = Number(rand(0.14, 0.19).toFixed(3));
      const grade = rate >= 0.17 ? "S" : rate >= 0.15 ? "A" : rate >= 0.13 ? "B" : "C";
      return {
        race_id: race.id,
        race_date: race.race_date,
        venue_code: race.venue_code,
        venue_name: race.venue_name,
        race_number: race.race_number,
        deadline: race.deadline,
        pre_appearance_rate: rate,
        pre_grade: grade,
        final_judgment: "PENDING",
        notified: false,
        status: "active",
      };
    });
    if (alertObjs.length) await base44.entities.Alert.bulkCreate(alertObjs);
  } finally {
    seeding = false;
  }
}

export async function getSettings() {
  const list = await base44.entities.AppSettings.filter({ is_active_config: true });
  if (list.length > 0) return list[0];
  return {
    buy_threshold: 110, watch_threshold: 100, pre_alert_rate: 15,
    min_similar_races: 30, analysis_period_months: 6, odds_update_interval: 60,
    notification_on: true, venues_enabled: VENUES.map((v) => v.code),
  };
}

export async function getRacesByDate(dateStr) {
  return base44.entities.Race.filter({ race_date: dateStr }, "race_number", 200);
}

export async function getEntries(raceId) {
  return base44.entities.RaceEntry.filter({ race_id: raceId }, "boat_number", 6);
}

export async function getLatestOdds(raceId) {
  const list = await base44.entities.OddsSnapshot.filter({ race_id: raceId }, "-captured_at", 6);
  return list[0] || null;
}

export async function getOddsHistory(raceId) {
  return base44.entities.OddsSnapshot.filter({ race_id: raceId }, "captured_at", 10);
}

// 指定日の全オッズを取得しrace_idごとに最新を返す
export async function getLatestOddsByDate(dateStr) {
  const all = await base44.entities.OddsSnapshot.filter({ race_date: dateStr }, "-captured_at", 300);
  const map = {};
  for (const o of all) {
    if (!map[o.race_id]) map[o.race_id] = o; // already sorted desc
  }
  return map;
}

export async function getAlerts(dateStr) {
  return base44.entities.Alert.filter({ race_date: dateStr }, "deadline", 100);
}

// 純粋関数版（過去結果を外部から渡す・バッチ計算用）
// pastResults は official のみを使用（data_source === "official" のみ類似判定）
export function analyzeRacePure(race, entries, odds, pastResults, settings, stage = "day") {
  const boat1 = entries.find((e) => e.boat_number === 1);
  const boat1Grade = gradeBoat1(boat1);

  const similar = pastResults.filter((p) => {
    if (p.data_source && p.data_source !== "official") return false;
    let s = 0;
    if (p.venue_code === race.venue_code) s += 25;
    if (p.boat1_grade_class && p.boat1_grade_class === boat1?.grade_class) s += 15;
    s += 15 * (1 - Math.abs((boat1?.national_win_rate || 0) - (p.boat1_national_win_rate || 0)) / 8);
    s += 10 * (1 - Math.abs((boat1?.local_win_rate || 0) - (p.boat1_local_win_rate || 0)) / 8);
    s += 10 * (1 - Math.abs((boat1?.avg_st || 0.2) - (p.boat1_avg_st || 0.2)) / 0.15);
    // F数（少ないほど良い）
    const fDiff = Math.abs((boat1?.f_count || 0) - (p.boat1_f_count || 0));
    s += 5 * Math.max(0, 1 - fDiff / 3);
    // モーター2連率
    s += 10 * (1 - Math.abs((boat1?.motor_2rate || 35) - (p.boat1_motor_2rate || 35)) / 30);
    // モーター3連率
    s += 10 * (1 - Math.abs((boat1?.motor_3rate || 50) - (p.boat1_motor_3rate || 50)) / 30);
    return s >= 55;
  });
  return _finishAnalysis(race, entries, odds, similar, stage, settings, boat1Grade);
}

function _finishAnalysis(race, entries, odds, similar, stage, settings, boat1Grade) {
  const boat1 = entries.find((e) => e.boat_number === 1);
  const similarCount = similar.length;
  const uichiHits = similar.filter((p) => p.is_uichi).length;
  const appearanceRate = similarCount > 0 ? uichiHits / similarCount : 0;

  let synthOdds = 0;
  let oddsValues = [];
  if (odds && stage !== "pre") {
    oddsValues = UICHI_COMBOS.map((c) => odds["odds_" + c.replace(/-/g, "_")]);
    synthOdds = syntheticOdds(oddsValues);
  }
  const ev = stage === "pre" ? null : expectedValue(appearanceRate, synthOdds);
  const minOk = similarCount >= (settings.min_similar_races || 30);

  let judgment = "PENDING";
  if (stage === "pre") {
    judgment = "PENDING";
  } else if (minOk) {
    judgment = judgeFromEV(ev, settings);
  }

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
    boat1,
    odds_values: oddsValues,
  };
}

// 1件分（DBから過去結果を取得・officialのみ）
export async function analyzeRace(race, entries, odds, settings, stage = "day") {
  const past = await getAllResults();
  return analyzeRacePure(race, entries, odds, past, settings, stage);
}

export async function getVenueStats() {
  return base44.entities.VenueStats.list("venue_name", 24);
}

// official の過去結果を取得（ページネーション対応）
export async function getAllResults() {
  let all = [];
  let skip = 0;
  while (skip < 20000) {
    const batch = await base44.entities.RaceResult.filter(
      { data_source: "official" }, "-race_date", 500, skip
    );
    if (!batch || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 500) break;
    skip += 500;
  }
  return all;
}

export async function getAllAnalyses() {
  return base44.entities.UichiAnalysis.list("-captured_at", 500);
}

export async function updateSettings(id, data) {
  return base44.entities.AppSettings.update(id, data);
}

// 公式サイト実データ取得（バックエンド関数経由）
export async function fetchOfficialRace(raceDate, jcd, raceNumber) {
  const res = await base44.functions.invoke("fetchRaceData", {
    race_date: raceDate,
    jcd: String(jcd).padStart(2, "0"),
    race_number: Number(raceNumber),
  });
  return res.data;
}

// 過去レース結果取得（1日1場分）
export async function fetchHistoricalResults(raceDate, jcd) {
  const res = await base44.functions.invoke("fetchHistoricalResults", {
    race_date: raceDate,
    jcd: String(jcd).padStart(2, "0"),
  });
  return res.data;
}

// 競艇場統計再計算
export async function recalcVenueStats() {
  const res = await base44.functions.invoke("recalcVenueStats", {});
  return res.data;
}

// 過去データ取得進捗を取得
export async function getFetchProgress() {
  return base44.entities.FetchProgress.list("-processed_at", 5000);
}

// 過去データ取得のサマリー
export async function getHistoricalSummary() {
  const all = await base44.entities.FetchProgress.list("-processed_at", 5000);
  const done = all.filter((p) => p.status === "done");
  const errors = all.filter((p) => p.status === "error");
  const noRaces = all.filter((p) => p.status === "no_races");
  const totalRaces = done.reduce((s, p) => s + (p.race_count || 0), 0);
  const totalUichi = done.reduce((s, p) => s + (p.uichi_hits || 0), 0);
  const lastProcessed = all[0]?.processed_at || null;
  return {
    total_days: all.length,
    done_days: done.length,
    error_count: errors.length,
    no_races_days: noRaces.length,
    total_races: totalRaces,
    total_uichi: totalUichi,
    overall_rate: totalRaces > 0 ? totalUichi / totalRaces : 0,
    last_processed: lastProcessed,
    errors: errors.slice(0, 10),
  };
}
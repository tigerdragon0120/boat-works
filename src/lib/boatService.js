// BOAT WORKS データサービス層
// UIとデータ取得を分離。本番運用：officialデータのみ使用・sampleデータは除外・自動生成停止。
import { base44 } from "@/api/base44Client";
import { VENUES, UICHI_COMBOS, syntheticOdds, expectedValue, judgeFromEV, gradeBoat1 } from "./boat";

// 短時間キャッシュ（同一画面内の重複DBクエリ防止・ページ遷移時の再取得削減）
const _cache = new Map();
function cached(key, ttl, fetcher) {
  const e = _cache.get(key);
  if (e && Date.now() - e.t < ttl) return Promise.resolve(e.v);
  if (e && e.p) return e.p;
  const p = fetcher().then(v => {
    _cache.set(key, { v, t: Date.now(), p: null });
    return v;
  }).catch(err => {
    if (_cache.get(key)?.p === p) _cache.delete(key);
    throw err;
  });
  _cache.set(key, { v: e?.v, t: e?.t || 0, p });
  return p;
}

export function invalidateCache(key) {
  if (key) _cache.delete(key);
  else _cache.clear();
}

function todayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export async function seedIfNeeded() {
  // 本番運用: sampleデータ自動生成は停止。AppSettings初期値のみseed。
  try {
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
  } catch {}
}

export function getSettings() {
  return cached("settings", 60000, async () => {
    const list = await base44.entities.AppSettings.filter({ is_active_config: true });
    if (list.length > 0) return list[0];
    return {
      buy_threshold: 110, watch_threshold: 100, pre_alert_rate: 15,
      min_similar_races: 30, analysis_period_months: 6, odds_update_interval: 60,
      notification_on: true, venues_enabled: VENUES.map((v) => v.code),
    };
  });
}

export function getRacesByDate(dateStr) {
  return cached(`races_${dateStr}`, 30000, () =>
    base44.entities.Race.filter({ race_date: dateStr, data_source: "official" }, "race_number", 200)
  );
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

export function getAlerts(dateStr) {
  return cached(`alerts_${dateStr}`, 30000, () =>
    base44.entities.Alert.filter({ race_date: dateStr }, "deadline", 100)
  );
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

// 類似候補をDB側で絞って取得（venue_code + official限定・最大500件・過去のみ）
// getAllResults()の代替：RaceResult全件取得ではなくDB側フィルタで候補を限定
export async function getSimilarResultsForRace(race, boat1, settings) {
  if (!race?.venue_code) return [];
  const candidates = await base44.entities.RaceResult.filter(
    { data_source: "official", venue_code: race.venue_code },
    "-race_date", 500
  );
  // 過去のみ対象（当日・未来のレースは除外）
  return candidates.filter(p => p.race_date < race.race_date);
}

// 1件分（類似候補をDB側で絞って取得・officialのみ・getAllResults不使用）
export async function analyzeRaceWithSimilar(race, entries, odds, settings, stage = "day") {
  const boat1 = entries.find(e => e.boat_number === 1);
  const similar = await getSimilarResultsForRace(race, boat1, settings);
  return analyzeRacePure(race, entries, odds, similar, settings, stage);
}

export function getVenueStats() {
  return cached("venueStats", 60000, () =>
    base44.entities.VenueStats.filter({ data_source: "official" }, "venue_name", 24)
  );
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

// Analysis画面用集計データ（バックエンド関数経由・RaceResult全件をクライアントに読み込まない）
export async function getAnalysisStats() {
  const res = await base44.functions.invoke("getAnalysisStats", {});
  return res.data;
}

export async function updateSettings(id, data) {
  const res = await base44.entities.AppSettings.update(id, data);
  invalidateCache("settings");
  return res;
}

// 1日分の開催スケジュール取得（軽量・raceindexページから締切時刻のみ）
export async function fetchDaySchedule(raceDate, jcd) {
  const res = await base44.functions.invoke("fetchDaySchedule", {
    race_date: raceDate,
    jcd: String(jcd).padStart(2, "0"),
  });
  return res.data;
}

// 本日の開催データを自動取得・キャッシュ（公式サイト）
// 1. fetchDailyVenues で本日の開催場一覧を取得
// 2. 各場の fetchDaySchedule でレース一覧（番号・締切）を取得してRace保存
// 3. 出走表・オッズは個別レース画面でon-demand取得
export async function autoFetchTodayRaces() {
  const today = todayStr(0);
  let activeJcds = [];
  try {
    activeJcds = await getDailyVenues(today);
  } catch {
    return { status: "error", message: "開催場一覧取得失敗", venues: 0, races: 0 };
  }
  if (!activeJcds.length) return { status: "no_venues", venues: 0, races: 0 };

  const allVenues = VENUES.map((v, i) => ({ jcd: String(i + 1).padStart(2, "0"), name: v.name }));
  let totalRaces = 0;
  const results = [];
  for (const jcd of activeJcds) {
    const v = allVenues.find((x) => x.jcd === jcd);
    try {
      const res = await fetchDaySchedule(today, jcd);
      if (res?.status === "success") {
        totalRaces += res.races || 0;
        results.push({ jcd, name: v?.name || jcd, status: "success", races: res.races });
      } else {
        results.push({ jcd, name: v?.name || jcd, status: res?.status || "skip", races: 0 });
      }
    } catch (e) {
      results.push({ jcd, name: v?.name || jcd, status: "error", races: 0 });
    }
  }
  return { status: "success", venues: activeJcds.length, races: totalRaces, results };
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

// 過去レース結果取得（第1段階・結果のみ高速取得）
export async function fetchHistoricalResults(raceDate, jcd, options = {}) {
  const res = await base44.functions.invoke("fetchHistoricalResults", {
    race_date: raceDate,
    jcd: String(jcd).padStart(2, "0"),
    timeout_ms: options.timeout_ms || null,
  });
  return res.data;
}

// エラー場専用再取得（FetchProgress result_fetch_status="error"のみ対象）
// 1日ずつ処理・最大3場並列・タイムアウト20s・最大2回リトライ（3-5s待機）
// 既存のfetchHistoricalResultsを再利用（race_id重複防止・FetchProgress重複防止・heartbeat・stale lock・ういち判定は関数内で処理）
export async function retryErrorFetches(onProgress, abortRef) {
  const allProgress = await base44.entities.FetchProgress.list("-processed_at", 5000);
  const errorRecords = allProgress.filter(p => p.result_fetch_status === "error" && p.venue_code !== "00");

  if (errorRecords.length === 0) {
    return { total: 0, processed: 0, success: 0, failed: 0 };
  }

  // 日付ごとにグループ化（日付の並列処理は行わない）
  const byDate = {};
  for (const p of errorRecords) {
    if (!byDate[p.race_date]) byDate[p.race_date] = [];
    byDate[p.race_date].push(p);
  }

  const dates = Object.keys(byDate).sort();
  const total = errorRecords.length;
  let processed = 0, success = 0, failed = 0;

  for (const date of dates) {
    if (abortRef?.aborted) break;

    const dayRecords = byDate[date];
    // 最大3場並列
    for (let i = 0; i < dayRecords.length; i += 3) {
      if (abortRef?.aborted) break;

      const batch = dayRecords.slice(i, i + 3);
      const batchNames = batch.map(p => p.venue_name || p.venue_code).join(" / ");

      if (onProgress) onProgress({
        total, processed, success, failed,
        currentDate: date,
        currentVenues: batchNames,
        remaining: total - processed,
        status: "loading",
      });

      const results = await Promise.all(batch.map(async (p) => {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (abortRef?.aborted) return { success: false, error: "aborted" };
          try {
            const res = await Promise.race([
              base44.functions.invoke("fetchHistoricalResults", {
                race_date: p.race_date,
                jcd: String(p.venue_code).padStart(2, "0"),
                timeout_ms: 20000,
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("client_timeout")), 25000))
            ]);
            if (res.data?.status === "success" || res.data?.status === "no_races") {
              return { success: true, races: res.data?.races || 0 };
            }
            lastError = res.data?.message || res.data?.status || "error";
          } catch (e) {
            lastError = e?.message || "error";
          }
          // 1回目失敗時のみ3-5秒待機してリトライ
          if (attempt === 0) await new Promise(r => setTimeout(r, 4000));
        }
        return { success: false, error: lastError };
      }));

      for (const r of results) {
        processed++;
        if (r.success) success++;
        else failed++;
      }

      if (onProgress) onProgress({
        total, processed, success, failed,
        currentDate: date,
        currentVenues: batchNames,
        remaining: total - processed,
        status: "done",
      });
    }
  }

  return { total, processed, success, failed };
}

// エラー場数を取得
export async function getErrorFetchCount() {
  const all = await base44.entities.FetchProgress.list("-processed_at", 5000);
  return all.filter(p => p.result_fetch_status === "error" && p.venue_code !== "00").length;
}

// 1号艇詳細補完（第2段階・1場分）
export async function enrichBoat1Details(raceDate, jcd, options = {}) {
  const res = await base44.functions.invoke("enrichBoat1Details", {
    race_date: raceDate,
    jcd: String(jcd).padStart(2, "0"),
    race_numbers: options.race_numbers || null,
    limit: options.limit || 12,
  });
  return res.data;
}

// 1号艇詳細オンデマンド補完（分析時に必要なレースのみ）
export async function enrichRaceResultsOnDemand(raceIds) {
  // race_id形式: YYYY-MM-DD_JC_NN → 日付+場ごとにグループ化
  const groups = {};
  for (const id of raceIds) {
    const parts = id.split("_");
    const date = parts[0];
    const jcd = parts[1];
    const num = parseInt(parts[2], 10);
    const key = `${date}_${jcd}`;
    if (!groups[key]) groups[key] = { race_date: date, jcd, race_numbers: [] };
    groups[key].race_numbers.push(num);
  }
  const results = [];
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    try {
      const res = await enrichBoat1Details(g.race_date, g.jcd, {
        race_numbers: g.race_numbers,
        limit: g.race_numbers.length,
      });
      results.push(res);
    } catch (e) {
      results.push({ status: "error", message: e?.message });
    }
  }
  return results;
}

// 競艇場統計再計算
export async function recalcVenueStats() {
  const res = await base44.functions.invoke("recalcVenueStats", {});
  return res.data;
}

// 1日分の全24場取得（逐次・公式サイト負荷配慮）
export async function fetchHistoricalDay(raceDate, onProgress) {
  const venues = VENUES.map((v, i) => ({ jcd: String(i + 1).padStart(2, "0"), name: v.name }));
  let done = 0, errors = 0, totalRaces = 0, totalUichi = 0;
  const results = [];
  for (const v of venues) {
    if (onProgress) onProgress({ venue: v, done, total: venues.length, status: "loading" });
    try {
      const res = await fetchHistoricalResults(raceDate, v.jcd);
      const races = res?.races || 0;
      const uichi = res?.uichi_hits || 0;
      results.push({ venue: v, status: res?.status || "ok", races, uichi });
      if (res?.status === "success") {
        totalRaces += races;
        totalUichi += uichi;
      }
    } catch (e) {
      errors++;
      results.push({ venue: v, status: "error", error: e?.message || "error" });
    }
    done++;
    if (onProgress) onProgress({ venue: v, done, total: venues.length, status: "done", errors, totalRaces, totalUichi });
  }
  return { done, errors, totalRaces, totalUichi, results };
}

// 指定日のofficialサマリー
export async function getDaySummary(raceDate) {
  const [results, progress] = await Promise.all([
    base44.entities.RaceResult.filter({ race_date: raceDate, data_source: "official" }, "-race_number", 500),
    base44.entities.FetchProgress.filter({ race_date: raceDate }, "-processed_at", 100),
  ]);
  const officialCount = results.length;
  const uichiHits = results.filter((r) => r.is_uichi).length;
  const errorCount = progress.filter((p) => p.status === "error").length;
  const doneCount = progress.filter((p) => p.status === "done").length;
  const noRacesCount = progress.filter((p) => p.status === "no_races").length;
  return { officialCount, uichiHits, errorCount, doneCount, noRacesCount, totalVenues: 24 };
}

// 1日の開催場一覧取得（軽量・公式トップページ）
export async function getDailyVenues(raceDate) {
  const res = await base44.functions.invoke("fetchDailyVenues", { race_date: raceDate });
  return res.data?.venues || [];
}

// 過去データ取得のheartbeatを更新（クライアント側から・venue_code="00"のmetaレコード）
export async function updateImportHeartbeat(phase, currentDate) {
  const now = new Date().toISOString();
  const existing = await base44.entities.FetchProgress.filter({ race_date: currentDate, venue_code: "00" });
  if (existing.length > 0) {
    await base44.entities.FetchProgress.update(existing[0].id, { last_heartbeat: now, error_msg: phase });
  } else {
    await base44.entities.FetchProgress.create({
      race_date: currentDate, venue_code: "00", venue_name: "—",
      last_heartbeat: now, error_msg: phase,
    });
  }
  return now;
}

// 期間分の開催場を取得（V3高速化: 2日同時×5場並列=最大10並列・error_pending後回し・最後再取得）
// 第1段階：結果のみ高速取得。1号艇詳細は第2段階で別途補完。
// フリーズ防止: 10sタイムアウト(リトライなし)・クライアント側30sタイムアウト・stale processing解除
// error_pending: 1回目失敗はerror_pendingに記録して次へ進む。全体終了後に最大2回再取得。
export async function fetchHistoricalRange(startDate, endDate, onProgress, abortRef) {
  const dates = enumerateDates(startDate, endDate);
  const totalDays = dates.length;
  const allVenues = VENUES.map((v, i) => ({ jcd: String(i + 1).padStart(2, "0"), name: v.name }));
  const CONCURRENT_DAYS = 2;
  const CONCURRENT_VENUES = 5;

  let completedDays = 0, current = 0, total = 0, dayErrors = 0, totalRaces = 0, totalUichi = 0;
  const errorPending = [];

  const emit = (p) => {
    if (!onProgress) return;
    onProgress({
      ...p,
      completedDays, totalDays, current, total,
      errors: dayErrors + errorPending.length,
      totalRaces, totalUichi,
      concurrentDays: CONCURRENT_DAYS, concurrentVenues: CONCURRENT_VENUES,
      errorPendingCount: errorPending.length,
    });
  };

  // === 日付を2日ずつ同時処理 ===
  for (let di = 0; di < dates.length; di += CONCURRENT_DAYS) {
    if (abortRef?.aborted) return { aborted: true, completedDays, totalDays, current, total, errors: dayErrors + errorPending.length, totalRaces, totalUichi, errorPending: errorPending.length };

    const datePair = dates.slice(di, di + CONCURRENT_DAYS);

    // heartbeat
    for (const date of datePair) {
      try { await updateImportHeartbeat("venue_discovery", date); } catch {}
    }

    emit({ phase: "venue_discovery", currentDate: datePair.join(" / "), venueName: "", status: "loading", currentDates: datePair, currentVenues: [] });

    // === 開催場一覧を2日並列取得 ===
    const venueResults = await Promise.all(datePair.map(async (date) => {
      let jcds = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (abortRef?.aborted) return { date, jcds: null };
        try {
          jcds = await getDailyVenues(date);
          if (jcds && jcds.length > 0) break;
        } catch (e) {}
        if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
      }
      return { date, jcds };
    }));

    // heartbeat
    for (const date of datePair) {
      try { await updateImportHeartbeat("result_fetch", date); } catch {}
    }

    // === done/no_races判定を先にまとめて取得（不要なAPIアクセス回避） ===
    const doneSetResults = await Promise.all(datePair.map(async (date) => {
      try {
        const dayProgress = await base44.entities.FetchProgress.filter(
          { race_date: date, venue_code: { $ne: "00" } }, "venue_code", 50
        );
        return new Set(
          dayProgress.filter((p) =>
            (p.result_fetch_status === "done" || p.result_fetch_status === "no_races") ||
            (!p.result_fetch_status && (p.status === "done" || p.status === "no_races"))
          ).map((p) => p.venue_code)
        );
      } catch {
        return new Set();
      }
    }));

    // === 各日の未処理場を収集 ===
    const pendingByDate = datePair.map((date, i) => {
      const jcds = venueResults[i].jcds;
      if (!jcds || jcds.length === 0) return { date, venues: [], failed: true };
      const doneSet = doneSetResults[i];
      const activeVenues = jcds.map((jcd) => allVenues.find((v) => v.jcd === jcd)).filter(Boolean);
      total += activeVenues.length;
      const pending = activeVenues.filter((v) => !doneSet.has(v.jcd));
      // done/no_races場をスキップカウント
      for (const v of activeVenues) {
        if (doneSet.has(v.jcd)) {
          current++;
          emit({ phase: "result_fetch", currentDate: date, venueName: v.name, status: "skipped", venueStatus: "done", currentDates: datePair, currentVenues: [] });
        }
      }
      return { date, venues: pending, failed: false };
    });

    // 全場完了済み → 2日とも完了扱い
    const allEmpty = pendingByDate.every((p) => p.venues.length === 0);
    if (allEmpty) {
      for (const p of pendingByDate) {
        if (p.failed) dayErrors++;
        completedDays++;
      }
      for (const date of datePair) {
        try { await updateImportHeartbeat("day_complete", date); } catch {}
      }
      emit({ phase: "day_complete", currentDate: datePair.join(" / "), venueName: "", status: "done", currentDates: [], currentVenues: [] });
      continue;
    }

    // === 未処理場を5場ずつ並列取得（2日同時 = 最大10並列HTTP） ===
    await Promise.all(pendingByDate.map(async (p) => {
      if (p.venues.length === 0) return;

      for (let i = 0; i < p.venues.length; i += CONCURRENT_VENUES) {
        if (abortRef?.aborted) return;
        const batch = p.venues.slice(i, i + CONCURRENT_VENUES);
        const batchNames = batch.map(v => v.name).join(" / ");

        emit({ phase: "result_fetch", currentDate: p.date, venueName: batchNames, status: "loading", currentDates: datePair, currentVenues: batch });

        const batchResults = await Promise.all(batch.map(async (v) => {
          try {
            const res = await Promise.race([
              fetchHistoricalResults(p.date, v.jcd),
              new Promise((_, reject) => setTimeout(() => reject(new Error("client_timeout")), 30000))
            ]);
            return { v, res, status: res?.status || "ok" };
          } catch (e) {
            return { v, res: null, status: "error", errorMsg: e?.message || "error" };
          }
        }));

        for (const { v, res, status } of batchResults) {
          current++;
          if (res?.status === "success") {
            totalRaces += res.races || 0;
            totalUichi += res.uichi_hits || 0;
          } else if (status === "error" || res?.status === "error") {
            // その場でリトライせず error_pending に記録して次へ
            errorPending.push({ date: p.date, jcd: v.jcd, venue: v });
          }
          emit({ phase: "result_fetch", currentDate: p.date, venueName: v.name, status: "done", venueStatus: status, currentDates: datePair, currentVenues: batch });
        }
      }
    }));

    // 日完了
    for (const p of pendingByDate) {
      if (p.failed) dayErrors++;
      completedDays++;
    }
    for (const date of datePair) {
      try { await updateImportHeartbeat("day_complete", date); } catch {}
    }
    emit({ phase: "day_complete", currentDate: datePair.join(" / "), venueName: "", status: "done", currentDates: [], currentVenues: [] });
  }

  // === error_pending 再取得フェーズ（最大2回） ===
  for (let retryRound = 0; retryRound < 2 && errorPending.length > 0; retryRound++) {
    if (abortRef?.aborted) break;

    const toRetry = [...errorPending];
    errorPending.length = 0;

    emit({ phase: "error_retry", currentDate: `エラー再取得 (${retryRound + 1}/2)`, venueName: `${toRetry.length}場`, status: "loading", currentDates: [], currentVenues: [] });

    // 5場並列で再取得
    for (let i = 0; i < toRetry.length; i += CONCURRENT_VENUES) {
      if (abortRef?.aborted) break;
      const batch = toRetry.slice(i, i + CONCURRENT_VENUES);
      const batchResults = await Promise.all(batch.map(async (item) => {
        try {
          const res = await Promise.race([
            fetchHistoricalResults(item.date, item.jcd),
            new Promise((_, reject) => setTimeout(() => reject(new Error("client_timeout")), 30000))
          ]);
          return { item, res, status: res?.status || "ok" };
        } catch (e) {
          return { item, res: null, status: "error", errorMsg: e?.message || "error" };
        }
      }));

      for (const { item, res, status } of batchResults) {
        if (res?.status === "success") {
          totalRaces += res.races || 0;
          totalUichi += res.uichi_hits || 0;
        } else if (status === "error" || res?.status === "error") {
          errorPending.push(item);
        }
      }

      emit({ phase: "error_retry", currentDate: `エラー再取得 (${retryRound + 1}/2)`, venueName: `${errorPending.length}場残り`, status: "loading", currentDates: [], currentVenues: [] });
    }
  }

  const errors = dayErrors + errorPending.length;

  // VenueStats再計算
  if (!abortRef?.aborted) {
    try { await recalcVenueStats(); } catch {}
    try { await updateImportHeartbeat("completed", dates[dates.length - 1] || startDate); } catch {}
  }

  return { completedDays, totalDays, current, total, errors, totalRaces, totalUichi, errorPending: errorPending.length };
}

// 第2段階: 1号艇詳細補完（期間一括・優先順位付き）
// 優先順位: 1.直近30日 2.ういち的中レース 3.残り
export async function enrichBoat1DetailsBatch(startDate, endDate, onProgress, abortRef) {
  const allProgress = await base44.entities.FetchProgress.list("-processed_at", 5000);
  const inRange = allProgress.filter((p) => p.race_date >= startDate && p.race_date <= endDate && p.venue_code !== "00");
  const doneResults = inRange.filter((p) =>
    p.result_fetch_status === "done" || (!p.result_fetch_status && p.status === "done")
  );
  const pending = doneResults.filter((p) =>
    p.detail_fetch_status !== "done" && p.detail_fetch_status !== "skip"
  );

  // 優先順位ソート: 1.直近30日 2.ういち的中 3.残り（同日内はういち的中優先）
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  pending.sort((a, b) => {
    const aRecent = a.race_date >= thirtyDaysAgo ? 0 : 1;
    const bRecent = b.race_date >= thirtyDaysAgo ? 0 : 1;
    if (aRecent !== bRecent) return aRecent - bRecent;
    // 同グループ内は日付降順（新しい順）
    if (a.race_date !== b.race_date) return b.race_date.localeCompare(a.race_date);
    // 同日内はういち的中優先
    const aUichi = (a.uichi_hits || 0) > 0 ? 0 : 1;
    const bUichi = (b.uichi_hits || 0) > 0 ? 0 : 1;
    return aUichi - bUichi;
  });

  let current = 0, total = pending.length, enriched = 0, errors = 0;
  for (const p of pending) {
    if (abortRef?.aborted) return { aborted: true, current, total, enriched, errors };
    if (onProgress) onProgress({ current, total, venue: p.venue_name, date: p.race_date, status: "loading", enriched, errors });
    try {
      const res = await enrichBoat1Details(p.race_date, p.venue_code, { limit: 12 });
      enriched += res?.enriched || 0;
      errors += res?.errors || 0;
    } catch {
      errors++;
    }
    current++;
    if (onProgress) onProgress({ current, total, venue: p.venue_name, date: p.race_date, status: "done", enriched, errors });
  }
  return { current, total, enriched, errors };
}

// 期間サマリー（FetchProgressから集計・2段階対応）
export async function getRangeSummary(startDate, endDate) {
  const allProgress = await base44.entities.FetchProgress.list("-processed_at", 5000);
  const inRange = allProgress.filter((p) => p.race_date >= startDate && p.race_date <= endDate && p.venue_code !== "00");
  const done = inRange.filter((p) => p.result_fetch_status === "done" || (!p.result_fetch_status && p.status === "done"));
  const errors = inRange.filter((p) => p.result_fetch_status === "error" || (!p.result_fetch_status && p.status === "error"));
  const noRaces = inRange.filter((p) => p.result_fetch_status === "no_races" || (!p.result_fetch_status && p.status === "no_races"));
  const totalRaces = done.reduce((s, p) => s + (p.race_count || 0), 0);
  const totalUichi = done.reduce((s, p) => s + (p.uichi_hits || 0), 0);
  const dates = new Set(inRange.map((p) => p.race_date));
  const overallRate = totalRaces > 0 ? totalUichi / totalRaces : 0;
  const lastProcessed = inRange[0]?.processed_at || null;
  const detailDone = inRange.filter((p) => p.detail_fetch_status === "done").length;
  const detailPending = inRange.filter((p) => !p.detail_fetch_status || p.detail_fetch_status === "pending").length;
  // 完了日数: その日の全場がdone/no_racesの日をカウント
  const byDate = {};
  for (const p of inRange) {
    if (!byDate[p.race_date]) byDate[p.race_date] = [];
    byDate[p.race_date].push(p);
  }
  let completedDays = 0;
  for (const records of Object.values(byDate)) {
    const allDone = records.length > 0 && records.every(p =>
      p.result_fetch_status === "done" || p.result_fetch_status === "no_races" ||
      (!p.result_fetch_status && (p.status === "done" || p.status === "no_races"))
    );
    if (allDone) completedDays++;
  }
  const totalCalendarDays = enumerateDates(startDate, endDate).length;
  return {
    totalDays: dates.size,
    totalCalendarDays,
    completedDays,
    doneVenues: done.length,
    noRacesVenues: noRaces.length,
    totalRaces,
    totalUichi,
    overallRate,
    errorCount: errors.length,
    lastProcessed,
    detailDone,
    detailPending,
  };
}

// 過去データ取得のheartbeat（最新のlast_heartbeat）を取得
export async function getImportHeartbeat() {
  const list = await base44.entities.FetchProgress.list("-processed_at", 20);
  let latest = null;
  for (const p of list) {
    if (p.last_heartbeat) {
      if (!latest || p.last_heartbeat > latest) latest = p.last_heartbeat;
    }
  }
  return latest;
}

// 1号艇詳細補完統計（RaceResultから集計）
export async function getBoat1DetailStats(startDate, endDate) {
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
  const inRange = all.filter((r) => (!startDate || r.race_date >= startDate) && (!endDate || r.race_date <= endDate));
  const total = inRange.length;
  const enriched = inRange.filter((r) => r.boat1_detail_status === "done" || (!r.boat1_detail_status && r.boat1_racer_name)).length;
  const pending = inRange.filter((r) => !r.boat1_detail_status || r.boat1_detail_status === "pending").length;
  const errorCount = inRange.filter((r) => r.boat1_detail_status === "error").length;
  return { total, enriched, pending, errorCount, rate: total > 0 ? enriched / total : 0 };
}

function enumerateDates(start, end) {
  const dates = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const s = Date.UTC(sy, sm - 1, sd);
  const e = Date.UTC(ey, em - 1, ed);
  for (let t = s; t <= e; t += 86400000) {
    const d = new Date(t);
    dates.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return dates;
}

// 過去データ取得進捗を取得
export async function getFetchProgress() {
  return base44.entities.FetchProgress.list("-processed_at", 5000);
}

// 過去データ取得のサマリー
export async function getHistoricalSummary() {
  const all = (await base44.entities.FetchProgress.list("-processed_at", 5000)).filter((p) => p.venue_code !== "00");
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
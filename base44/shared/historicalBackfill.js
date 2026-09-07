// BOAT WORKS 2002年〜現在 個別レース結果バックフィル共通ロジック
// runHistoricalRaceBackfill と controlHistoricalBackfill で共有使用

import { VENUE_NAMES, parseResultList, parseRaceResultDetail, parseRacelist, parseSeriesContext, fetchWithRetry, sleep } from './scraper.js';

const RESULT_BASE = 'https://boatrace.jp/owpc/pc/race';

// 24場の開催場コードを正しい順序で定義
// (Object.keysは整数インデックスキーを先にソートする仕様があるため、
//  "10"-"24"が"01"-"09"より前に来てしまう問題を回避)
export const VENUE_JCDS_SORTED = [
  '01','02','03','04','05','06','07','08','09','10',
  '11','12','13','14','15','16','17','18','19','20',
  '21','22','23','24'
];

// レース自然キー: race_date_venuecode_racenum
export function raceNaturalKey(raceDate, jcd, raceNumber) {
  return `${raceDate}_${jcd}_${String(raceNumber).padStart(2, '0')}`;
}

// 選手結果キー: race_natural_key_boatnum
export function racerResultKey(raceDate, jcd, raceNumber, boatNumber) {
  return `${raceNaturalKey(raceDate, jcd, raceNumber)}_${boatNumber}`;
}

// 日付加算
export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 2つの日付間の日数
export function daysBetween(startStr, endStr) {
  const s = new Date(`${startStr}T00:00:00Z`);
  const e = new Date(`${endStr}T00:00:00Z`);
  return Math.round((e - s) / (24 * 60 * 60 * 1000));
}

// 進捗レコード取得(シングルトン)
export async function getProgress(base44) {
  const rows = await base44.asServiceRole.entities.HistoricalBackfillProgress.filter(
    { config_id: 'main' }, '-updated_date', 5
  ).catch(() => []);
  return rows[0] || null;
}

// 進捗レコード初期化
export async function initProgress(base44, startDate, endDate) {
  const existing = await getProgress(base44);
  const totalDays = Math.max(0, daysBetween(startDate, endDate)) + 1;
  const fields = {
    config_id: 'main',
    target_start_date: startDate,
    target_end_date: endDate,
    current_processing_date: startDate,
    current_venue_index: 0,
    last_completed_date: null,
    processed_race_count: 0,
    processed_racer_result_count: 0,
    success_count: 0,
    failure_count: 0,
    skip_count: 0,
    last_run_at: new Date().toISOString(),
    status: 'IDLE',
    last_error: null,
    current_batch_label: startDate,
    total_target_days: totalDays,
    completed_dates: 0,
    error_dates: [],
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    await base44.asServiceRole.entities.HistoricalBackfillProgress.update(existing.id, fields);
    return { ...existing, ...fields, id: existing.id };
  }
  const created = await base44.asServiceRole.entities.HistoricalBackfillProgress.create(fields);
  return created;
}

// 進捗レコード更新
export async function updateProgress(base44, progressId, fields) {
  await base44.asServiceRole.entities.HistoricalBackfillProgress.update(progressId, {
    ...fields,
    updated_at: new Date().toISOString(),
  });
}

// 1開催場・1日分のレース結果を取得して保存する
// 既存HistoricalRaceResultがあれば上書きしない(冪等性)
// 戻り値: { races, racerResults, errors, skipped }
export async function backfillVenueDate(base44, raceDate, jcd) {
  const venueName = VENUE_NAMES[jcd] || jcd;
  const hd = raceDate.replace(/-/g, '');
  const now = new Date().toISOString();
  const errors = [];
  let raceCount = 0;
  let racerResultCount = 0;
  let skipped = 0;

  // 1) 結果一覧取得
  let raceResults = [];
  let seriesCtx = null;
  try {
    const resultListUrl = `${RESULT_BASE}/resultlist?jcd=${jcd}&hd=${hd}`;
    const rlRes = await fetchWithRetry(resultListUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 2);
    const rlHtml = await rlRes.text();
    const noRaces = rlHtml.includes('予期せぬエラーが発生しました') || rlHtml.includes('データがありません');
    raceResults = noRaces ? [] : parseResultList(rlHtml);

    // シリーズ情報
    if (raceResults.length > 0) {
      try {
        const idxRes = await fetchWithRetry(`${RESULT_BASE}/raceindex?jcd=${jcd}&hd=${hd}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 1);
        const idxHtml = await idxRes.text();
        seriesCtx = parseSeriesContext(idxHtml, raceDate);
      } catch {}
    }
  } catch (e) {
    errors.push({ phase: 'resultlist', message: e?.message || String(e) });
    return { races: 0, racerResults: 0, errors, skipped: 0 };
  }

  if (raceResults.length === 0) {
    return { races: 0, racerResults: 0, errors, skipped: 1 };
  }

  // 2) 既存HistoricalRaceResultを取得
  const existingRaces = await base44.asServiceRole.entities.HistoricalRaceResult.filter(
    { race_date: raceDate, venue_code: jcd }, 'race_number', 20
  ).catch(() => []);
  const existingRaceMap = new Map(existingRaces.map(r => [r.race_natural_key, r]));

  // 3) 各レースの詳細を取得して保存
  for (const rr of raceResults) {
    const natKey = raceNaturalKey(raceDate, jcd, rr.race_number);
    try {
      // 3a) 出走表を取得して6艇の基準データを確保
      // 結果ページだけでは欠場・失格艇が抜けるため、出走表を先に取得する
      let entryMap = new Map(); // boat_number → {registration_number, racer_name, ...}
      try {
        const racelistUrl = `${RESULT_BASE}/racelist?rno=${rr.race_number}&jcd=${jcd}&hd=${hd}`;
        const rlRes = await fetchWithRetry(racelistUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 2);
        const rlHtml = await rlRes.text();
        const rlParsed = parseRacelist(rlHtml, rr.race_number, raceDate);
        for (const e of (rlParsed.entries || [])) {
          if (e.boat_number >= 1 && e.boat_number <= 6) {
            entryMap.set(Number(e.boat_number), e);
          }
        }
      } catch (e) {
        errors.push({ phase: 'racelist', race_number: rr.race_number, message: e?.message || '出走表取得失敗' });
      }

      // 3b) 結果詳細ページ取得
      const detailUrl = `${RESULT_BASE}/raceresult?rno=${rr.race_number}&jcd=${jcd}&hd=${hd}`;
      const detailRes = await fetchWithRetry(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 12000, 2);
      const detailHtml = await detailRes.text();
      const detail = parseRaceResultDetail(detailHtml);

      // レース基本情報
      const raceFields = {
        race_natural_key: natKey,
        race_date: raceDate,
        venue_code: jcd,
        venue_name: venueName,
        race_number: rr.race_number,
        series_day_number: seriesCtx?.series_day || null,
        race_name: null,
        race_grade: seriesCtx?.grade || 'GENERAL',
        series_title: seriesCtx?.event_name || null,
        deadline_time: null,
        weather: detail?.weather || null,
        air_temperature: detail?.air_temperature || null,
        water_temperature: detail?.water_temperature || null,
        wind_direction: detail?.wind_dir || null,
        wind_speed: detail?.wind_speed || null,
        wave_height: detail?.wave_height || null,
        winning_method: detail?.winning_method || null,
        first_place_boat: rr.result_1,
        second_place_boat: rr.result_2,
        third_place_boat: rr.result_3,
        trifecta_result: rr.trifecta,
        trifecta_payout: rr.payout_trifecta,
        race_time_1_seconds: detail?.race_time_1_seconds || null,
        race_time_2_seconds: detail?.race_time_2_seconds || null,
        race_time_3_seconds: detail?.race_time_3_seconds || null,
        margin_1_2_seconds: detail?.margin_1_2_seconds || null,
        margin_1_3_seconds: detail?.margin_1_3_seconds || null,
        race_status: 'CONFIRMED',
        data_source: 'official',
        imported_at: now,
      };

      // 既存レースがあれば更新、なければ作成
      const exRace = existingRaceMap.get(natKey);
      if (exRace) {
        await base44.asServiceRole.entities.HistoricalRaceResult.update(exRace.id, raceFields);
      } else {
        await base44.asServiceRole.entities.HistoricalRaceResult.create(raceFields);
      }
      raceCount++;

      // 3c) 既存Raceエンティティとの統合(欠損補完のみ・上書き禁止)
      await integrateWithExistingRace(base44, raceDate, jcd, rr.race_number, seriesCtx);

      // 4) 各艇の個別結果を保存
      // 出走表の6艇を基準とし、結果詳細を重ね合わせる
      // これにより欠場・失格・転覆等の特殊結果艇もレコードが作成される

      // 結果詳細のfinisherをboat_numberでマップ
      const finisherMap = new Map();
      if (detail?.finishers) {
        for (const f of detail.finishers) {
          finisherMap.set(Number(f.boat_number), f);
        }
      }

      // スタート情報をboat_numberでマップ(進入コース含む)
      const stMap = new Map();
      if (detail?.start_info) {
        for (const si of detail.start_info) {
          stMap.set(Number(si.boat_number), si);
        }
      }

      // 既存racer結果を取得
      const existingRacerResults = await base44.asServiceRole.entities.HistoricalRacerResult.filter(
        { race_natural_key: natKey }, 'boat_number', 10
      ).catch(() => []);
      const existingRacerMap = new Map(existingRacerResults.map(r => [r.result_key, r]));

      // 6艇すべてを保存(出走表基準 + 結果オーバーレイ)
      for (let boatNum = 1; boatNum <= 6; boatNum++) {
        const rKey = racerResultKey(raceDate, jcd, rr.race_number, boatNum);
        const entry = entryMap.get(boatNum) || {};
        const finisher = finisherMap.get(boatNum) || {};
        const stInfo = stMap.get(boatNum) || {};

        const stRaw = stInfo.st_raw || null;
        let stVal = stInfo.st != null ? Number(stInfo.st) : null;
        const startCourse = stInfo.start_course != null ? Number(stInfo.start_course) : null;

        // finish_status + 事故フラグ判定
        let finishStatus = finisher.finish_status || 'PENDING';
        let finishOrder = finisher.finish != null ? Number(finisher.finish) : null;
        const officialFinishRaw = finisher.finish_raw || null;
        const specialFlag = finisher.special_flag || null;

        // 結果ページにいない艇 = 欠場または出走なし
        if (!finisher.boat_number) {
          finishStatus = 'ABSENT';
        }

        const isFoul = specialFlag === 'is_foul' || (stRaw != null && /^F/i.test(stRaw)) || finishStatus === 'FOUL';
        const isLate = specialFlag === 'is_late' || (stRaw != null && /^L/i.test(stRaw)) || finishStatus === 'LATE';
        const isCapsized = specialFlag === 'is_capsized' || finishStatus === 'CAPSIZED';
        const isFell = specialFlag === 'is_fell' || finishStatus === 'FELL';
        const isDisqualified = specialFlag === 'is_disqualified' || finishStatus === 'DISQUALIFIED';
        const isAbsent = specialFlag === 'is_absent' || finishStatus === 'ABSENT';
        const isReturned = specialFlag === 'is_returned' || finishStatus === 'RETURNED';
        const isIncomplete = specialFlag === 'is_incomplete' || finishStatus === 'INCOMPLETE';

        const racerFields = {
          result_key: rKey,
          race_natural_key: natKey,
          race_date: raceDate,
          venue_code: jcd,
          race_number: rr.race_number,
          boat_number: boatNum,
          frame_number: boatNum,
          registration_number: finisher.registration_number || entry.registration_number || null,
          racer_name: finisher.racer_name || entry.racer_name || null,
          finish_order: finishOrder,
          official_finish_raw: officialFinishRaw,
          finish_status: finishStatus,
          start_timing: stVal,
          start_timing_raw: stRaw,
          start_course: startCourse,
          race_time_raw: finisher.race_time_raw || null,
          race_time_seconds: finisher.race_time_seconds || null,
          winning_method: finishOrder === 1 ? (detail?.winning_method || null) : null,
          is_foul: isFoul,
          is_late: isLate,
          is_capsized: isCapsized,
          is_fell: isFell,
          is_disqualified: isDisqualified,
          is_absent: isAbsent,
          is_returned: isReturned,
          is_incomplete: isIncomplete,
          imported_at: now,
        };

        const exRacer = existingRacerMap.get(rKey);
        if (exRacer) {
          await base44.asServiceRole.entities.HistoricalRacerResult.update(exRacer.id, racerFields);
        } else {
          await base44.asServiceRole.entities.HistoricalRacerResult.create(racerFields);
        }
        racerResultCount++;
      }
      await sleep(300);
    } catch (e) {
      errors.push({ phase: 'race_detail', race_number: rr.race_number, message: e?.message || String(e) });
    }
  }

  return { races: raceCount, racerResults: racerResultCount, errors, skipped };
}

// 既存Raceエンティティへの安全な統合(欠損補完のみ・上書き禁止)
export async function integrateWithExistingRace(base44, raceDate, jcd, raceNumber, seriesCtx) {
  const venueName = VENUE_NAMES[jcd] || jcd;
  const existing = await base44.asServiceRole.entities.Race.filter(
    { race_date: raceDate, venue_code: jcd, race_number: Number(raceNumber), data_source: 'official' },
    '-created_date', 3
  ).catch(() => []);

  if (existing.length > 0) {
    return existing[0].id;
  }

  // 存在しない場合のみ作成(展示・オッズ・出走表はnullのまま、当日処理が後で埋める)
  try {
    const created = await base44.asServiceRole.entities.Race.create({
      race_date: raceDate,
      venue_code: jcd,
      venue_name: venueName,
      race_number: Number(raceNumber),
      grade: seriesCtx?.grade || 'GENERAL',
      event_name: seriesCtx?.event_name || null,
      series_key: `${jcd}_${seriesCtx?.series_start_date || raceDate}`,
      series_start_date: seriesCtx?.series_start_date || raceDate,
      series_end_date: seriesCtx?.series_end_date || raceDate,
      series_total_days: seriesCtx?.series_total_days || 1,
      series_day: seriesCtx?.series_day || 1,
      is_final_day: seriesCtx?.is_final_day === true,
      status: 'finished',
      data_source: 'official',
      last_updated: new Date().toISOString(),
    });
    return created.id;
  } catch {
    return null;
  }
}
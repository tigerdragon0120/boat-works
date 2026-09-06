// BOAT WORKS VenueDayReadiness 即時再計算モジュール
// DBの実データから正規RaceとRaceEntryを再取得して再計算する。
// キャッシュ値ではなく、常に最新のDB状態を反映する。
//
// 【状態定義】
// PRE_RACE_COMPLETE (開始前完了): 以下7工程すべて完了（翌日データ用）
//   1. 翌日出走表 (Race 12R + RaceEntry 6艇)
//   2. 基本情報 (race_name, deadline, series_key)
//   3. 前日結果・節間ポイント (SeriesRacerPoint)
//   4. 選手評価 6m/1y/3y (RacerEvaluation)
//   5. ういち選手配置指数 (RacePlayerStructure)
//   6. 裏ういち選手配置指数 (RacePlayerStructure)
//   7. 翌日事前アラート (UichiAnalysis stage=pre)
//
// COMPLETE (全工程完了): PRE_RACE_COMPLETE + 展示 + 直前オッズ + 最終判定（当日用）

import { VENUE_NAMES } from './scraper.js';

const CORE_ENTRY_FIELDS = ['registration_number', 'racer_name', 'grade_class'];

// 指定場のVenueDayReadinessを事前取得データから再計算（内部関数）
async function _recalcWithData(base44, raceDate, jcd, venueRaces, venueEntries, venueStructures, venueAnalysesPre, venueAnalysesFinal, venueRegNumbers, venueEvalCount, seriesPoints, venueOddsRaceIds) {
  const venueName = VENUE_NAMES[jcd] || jcd;

  // 論理キーでグループ化（重複Raceがあれば最初のものを正規とする）
  const byLogical = new Map();
  for (const r of venueRaces) {
    const key = Number(r.race_number);
    if (!byLogical.has(key)) byLogical.set(key, r);
  }
  const canonicalRaces = [...byLogical.values()];
  const raceIds = new Set(canonicalRaces.map(r => r.id));
  const raceNumberSet = new Set(canonicalRaces.map(r => Number(r.race_number)));

  // RaceEntryをrace_idでグループ化
  const entryByRace = new Map();
  for (const e of venueEntries) {
    if (!raceIds.has(e.race_id)) continue;
    if (!entryByRace.has(e.race_id)) entryByRace.set(e.race_id, []);
    entryByRace.get(e.race_id).push(e);
  }

  // 各指標を計算
  let racesCollected = 0;
  let completeEntryRaces = 0;
  let coreCompleteRaces = 0;

  for (const r of canonicalRaces) {
    const raceEntries = entryByRace.get(r.id) || [];
    const boatNumbers = new Set(raceEntries.map(e => Number(e.boat_number)));
    const hasAllBoats = [1, 2, 3, 4, 5, 6].every(bn => boatNumbers.has(bn));

    racesCollected++;

    if (hasAllBoats) {
      completeEntryRaces++;
      let coreOk = true;
      for (const e of raceEntries) {
        for (const f of CORE_ENTRY_FIELDS) {
          if (e[f] == null) { coreOk = false; break; }
        }
        if (!coreOk) break;
      }
      if (coreOk) coreCompleteRaces++;
    }
  }

  // 既存レコードを取得
  const existing = await base44.asServiceRole.entities.VenueDayReadiness.filter({
    race_date: raceDate, venue_code: jcd
  }, '-updated_date', 1).catch(() => []);

  const expectedRaces = existing[0]?.expected_races || 12;
  const firstDeadline = canonicalRaces[0]?.deadline || existing[0]?.first_deadline || null;
  const timeSlot = existing[0]?.time_slot || (() => {
    if (!firstDeadline) return 'day';
    const h = new Date(firstDeadline).getHours();
    if (h < 10) return 'morning';
    if (h >= 14) return 'night';
    return 'day';
  })();

  // missing_races
  const missingRaces = [];
  for (let rn = 1; rn <= expectedRaces; rn++) {
    if (!raceNumberSet.has(rn)) missingRaces.push(rn);
  }

  // === 7つの事前工程チェック ===
  // 1. 翌日出走表
  const racesComplete = missingRaces.length === 0 && completeEntryRaces === expectedRaces;

  // 2. 基本情報
  const coreComplete = coreCompleteRaces === expectedRaces;

  // 3. 前日結果・節間ポイント
  const seriesKeys = [...new Set(canonicalRaces.map(r => r.series_key).filter(Boolean))];
  const seriesPointsReady = canonicalRaces.every(r => Number(r.series_day || 1) <= 1) ||
    (seriesKeys.length > 0 && seriesPoints.some(p => seriesKeys.includes(p.series_key)));

  // 4. 選手評価
  const racerEvaluationsTotal = venueRegNumbers.length;
  const racerEvaluationsCount = venueEvalCount;
  const racerEvaluationsReady = racerEvaluationsTotal > 0 && racerEvaluationsCount === racerEvaluationsTotal;

  // 5+6. ういち/裏ういち選手配置指数
  const playerStructuresCount = venueStructures.filter(s => raceIds.has(s.race_id)).length;
  const playerStructuresReady = playerStructuresCount === expectedRaces && expectedRaces > 0;

  // 7. 翌日事前アラート
  const preAlertsCount = venueAnalysesPre.filter(a => raceIds.has(a.race_id)).length;
  const preAlertsReady = preAlertsCount === expectedRaces && expectedRaces > 0;

  // 開始前完了 = 7工程すべて完了
  const preRaceReady = racesComplete && coreComplete && seriesPointsReady &&
    racerEvaluationsReady && playerStructuresReady && preAlertsReady;

  // === 当日工程チェック（全工程完了用）===
  const exhibitionReadyRaces = canonicalRaces.filter(r => r.exhibition_ready === true).length;
  const finalJudgmentRaces = venueAnalysesFinal.filter(a => raceIds.has(a.race_id)).length;
  const oddsReadyRaces = venueOddsRaceIds.size;
  const fullComplete = preRaceReady &&
    exhibitionReadyRaces === expectedRaces &&
    oddsReadyRaces === expectedRaces &&
    finalJudgmentRaces === expectedRaces && expectedRaces > 0;

  // collection_status決定
  let collectionStatus;
  if (canonicalRaces.length === 0) {
    collectionStatus = 'WAITING';
  } else if (fullComplete) {
    collectionStatus = existing[0]?.collection_status === 'BASELINE_CAPTURED' ? 'BASELINE_CAPTURED' : 'COMPLETE';
  } else if (preRaceReady) {
    collectionStatus = 'PRE_RACE_COMPLETE';
  } else {
    collectionStatus = 'WAITING';
  }

  const now = new Date().toISOString();
  const data = {
    race_date: raceDate,
    venue_code: jcd,
    venue_name: venueName,
    time_slot: timeSlot,
    first_deadline: firstDeadline,
    expected_races: expectedRaces,
    races_collected: racesCollected,
    complete_entry_races: completeEntryRaces,
    core_complete_races: coreCompleteRaces,
    series_points_ready: seriesPointsReady,
    racer_evaluations_ready: racerEvaluationsReady,
    racer_evaluations_count: racerEvaluationsCount,
    racer_evaluations_total: racerEvaluationsTotal,
    player_structures_ready: playerStructuresReady,
    player_structures_count: playerStructuresCount,
    pre_alerts_ready: preAlertsReady,
    pre_alerts_count: preAlertsCount,
    pre_race_ready: preRaceReady,
    pre_race_completed_at: preRaceReady ? (existing[0]?.pre_race_completed_at || now) : null,
    exhibition_ready_races: exhibitionReadyRaces,
    odds_ready_races: oddsReadyRaces,
    final_judgment_races: finalJudgmentRaces,
    full_complete: fullComplete,
    collection_status: collectionStatus,
    missing_races: missingRaces,
    last_checked_at: now,
  };

  if (existing.length > 0) {
    const updateData = { ...data };
    delete updateData.collection_completed_at;
    delete updateData.baseline_captured_at;
    await base44.asServiceRole.entities.VenueDayReadiness.update(existing[0].id, updateData);
    return { ...data, id: existing[0].id, updated: true };
  } else {
    const created = await base44.asServiceRole.entities.VenueDayReadiness.create(data);
    return { ...data, id: created.id, updated: false };
  }
}

// 指定日の全場のVenueDayReadinessを再計算（一括事前取得版）
export async function recalcAllVenuesForDate(base44, raceDate) {
  // 全データを一括取得
  const [races, entries, structures, analysesPre, analysesFinal, seriesPoints, oddsSnapshots] = await Promise.all([
    base44.asServiceRole.entities.Race.filter({ race_date: raceDate, data_source: { $ne: 'sample' } }, 'race_number', 500).catch(() => []),
    base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []),
    base44.asServiceRole.entities.RacePlayerStructure.filter({ race_date: raceDate }, 'race_number', 500).catch(() => []),
    base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate, stage: 'pre' }, 'race_number', 500).catch(() => []),
    base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate, stage: 'final' }, 'race_number', 500).catch(() => []),
    base44.asServiceRole.entities.SeriesRacerPoint.list('-as_of_date', 1000).catch(() => []),
    base44.asServiceRole.entities.OddsSnapshot.filter({ race_date: raceDate }, '-captured_at', 5000).catch(() => []),
  ]);

  // 全参加選手の登録番号
  const regNumbers = [...new Set(entries.map(e => e.registration_number).filter(Boolean))];

  // 選手評価をバッチ取得
  const evalRegNumbers = new Set();
  for (let i = 0; i < regNumbers.length; i += 200) {
    const chunk = regNumbers.slice(i, i + 200);
    const evals = await base44.asServiceRole.entities.RacerEvaluation.filter(
      { registration_number: { $in: chunk } }, null, 500
    ).catch(() => []);
    for (const e of evals) evalRegNumbers.add(e.registration_number);
  }

  // 場ごとにグループ化
  const venueCodes = [...new Set(races.map(r => String(r.venue_code).padStart(2, '0')))];
  const results = [];

  for (const jcd of venueCodes) {
    const venueRaceIds = new Set(
      races.filter(r => String(r.venue_code).padStart(2, '0') === jcd).map(r => r.id)
    );
    const venueRaces = races.filter(r => venueRaceIds.has(r.id));
    const venueEntries = entries.filter(e => venueRaceIds.has(e.race_id));
    const venueStructures = structures.filter(s => venueRaceIds.has(s.race_id));
    const venueAnalysesPre = analysesPre.filter(a => venueRaceIds.has(a.race_id));
    const venueAnalysesFinal = analysesFinal.filter(a => venueRaceIds.has(a.race_id));
    const venueOddsRaceIds = new Set(
      oddsSnapshots.filter(o => venueRaceIds.has(o.race_id)).map(o => o.race_id)
    );
    const venueRegNumbers = [...new Set(venueEntries.map(e => e.registration_number).filter(Boolean))];
    const venueEvalCount = venueRegNumbers.filter(rn => evalRegNumbers.has(rn)).length;

    try {
      const result = await _recalcWithData(
        base44, raceDate, jcd, venueRaces, venueEntries,
        venueStructures, venueAnalysesPre, venueAnalysesFinal,
        venueRegNumbers, venueEvalCount, seriesPoints, venueOddsRaceIds
      );
      results.push({ venue_code: jcd, venue_name: result.venue_name, ...result });
    } catch (e) {
      results.push({ venue_code: jcd, error: e?.message || String(e) });
    }
  }

  return results;
}

// 単一場の再計算（後方互換用）
export async function recalcVenueDayReadiness(base44, raceDate, venueCode) {
  const jcd = String(venueCode).padStart(2, '0');

  const [races, entries, structures, analysesPre, analysesFinal, seriesPoints, oddsSnapshots] = await Promise.all([
    base44.asServiceRole.entities.Race.filter({ race_date: raceDate, venue_code: jcd, data_source: { $ne: 'sample' } }, 'race_number', 100).catch(() => []),
    base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate, venue_code: jcd }, 'boat_number', 1000).catch(() => []),
    base44.asServiceRole.entities.RacePlayerStructure.filter({ race_date: raceDate, venue_code: jcd }, 'race_number', 100).catch(() => []),
    base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate, venue_code: jcd, stage: 'pre' }, 'race_number', 100).catch(() => []),
    base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate, venue_code: jcd, stage: 'final' }, 'race_number', 100).catch(() => []),
    base44.asServiceRole.entities.SeriesRacerPoint.list('-as_of_date', 1000).catch(() => []),
    base44.asServiceRole.entities.OddsSnapshot.filter({ race_date: raceDate, venue_code: jcd }, '-captured_at', 1000).catch(() => []),
  ]);

  const regNumbers = [...new Set(entries.map(e => e.registration_number).filter(Boolean))];
  const evalRegNumbers = new Set();
  for (let i = 0; i < regNumbers.length; i += 200) {
    const chunk = regNumbers.slice(i, i + 200);
    const evals = await base44.asServiceRole.entities.RacerEvaluation.filter(
      { registration_number: { $in: chunk } }, null, 500
    ).catch(() => []);
    for (const e of evals) evalRegNumbers.add(e.registration_number);
  }
  const venueEvalCount = regNumbers.filter(rn => evalRegNumbers.has(rn)).length;
  const venueOddsRaceIds = new Set(oddsSnapshots.map(o => o.race_id));

  return _recalcWithData(
    base44, raceDate, jcd, races, entries,
    structures, analysesPre, analysesFinal,
    regNumbers, venueEvalCount, seriesPoints, venueOddsRaceIds
  );
}
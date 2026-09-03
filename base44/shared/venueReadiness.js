// BOAT WORKS VenueDayReadiness 即時再計算モジュール
// DBの実データから正規RaceとRaceEntryを再取得して再計算する。
// キャッシュ値ではなく、常に最新のDB状態を反映する。

import { VENUE_NAMES } from './scraper.js';

// 必須選手情報フィールド（core_complete判定用）
const CORE_ENTRY_FIELDS = ['registration_number', 'racer_name', 'grade_class'];

// 指定日・指定場のVenueDayReadinessを実データから再計算
export async function recalcVenueDayReadiness(base44, raceDate, venueCode) {
  const jcd = String(venueCode).padStart(2, '0');
  const venueName = VENUE_NAMES[jcd] || jcd;

  // 正規Raceを取得（sample除外）
  const races = await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate, venue_code: jcd, data_source: { $ne: 'sample' }
  }, 'race_number', 100).catch(() => []);

  // 論理キーでグループ化（重複Raceがあれば最も完全なものを正規とする）
  const byLogical = new Map();
  for (const r of races) {
    const key = Number(r.race_number);
    if (!byLogical.has(key)) byLogical.set(key, []);
    byLogical.get(key).push(r);
  }

  // 各Rの正規Raceを決定（エントリ数が多いものを優先）
  const canonicalRaces = [];
  for (const [raceNum, group] of byLogical) {
    if (group.length === 1) {
      canonicalRaces.push(group[0]);
    } else {
      // 重複がある場合は後でraceUpsert.normalizeRaceDuplicatesForVenueが正規化する
      // ここでは最初のものを暫定正規とする
      canonicalRaces.push(group[0]);
    }
  }

  const raceIds = canonicalRaces.map(r => r.id);
  const raceNumberSet = new Set(canonicalRaces.map(r => Number(r.race_number)));

  // RaceEntryを取得（race_idの$inで効率的に）
  const allEntries = [];
  for (let i = 0; i < raceIds.length; i += 200) {
    const batch = raceIds.slice(i, i + 200);
    const ents = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: { $in: batch } }, 'boat_number', 1000).catch(() => []);
    allEntries.push(...ents);
  }

  // Race IDごとにエントリをグループ化
  const entryByRace = new Map();
  for (const e of allEntries) {
    if (!entryByRace.has(e.race_id)) entryByRace.set(e.race_id, []);
    entryByRace.get(e.race_id).push(e);
  }

  // 各指標を計算
  let racesCollected = 0;
  let completeEntryRaces = 0;
  let coreCompleteRaces = 0;
  const missingRaces = [];

  for (const r of canonicalRaces) {
    const raceEntries = entryByRace.get(r.id) || [];
    const boatNumbers = new Set(raceEntries.map(e => Number(e.boat_number)));
    const hasAllBoats = [1, 2, 3, 4, 5, 6].every(bn => boatNumbers.has(bn));

    racesCollected++;

    if (hasAllBoats) {
      completeEntryRaces++;
      // 必須選手情報が揃っているか確認
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

  // expected_racesは既存レコードから取得、なければ12をデフォルト
  const existing = await base44.asServiceRole.entities.VenueDayReadiness.filter({
    race_date: raceDate, venue_code: jcd
  }, '-updated_date', 1).catch(() => []);

  const expectedRaces = existing[0]?.expected_races || 12;
  const firstDeadline = canonicalRaces[0]?.deadline || existing[0]?.first_deadline || null;
  const timeSlot = existing[0]?.time_slot || null;

  // missing_races: expected_racesのうちDBに存在しないR番号
  for (let rn = 1; rn <= expectedRaces; rn++) {
    if (!raceNumberSet.has(rn)) missingRaces.push(rn);
  }

  // collection_status決定
  let collectionStatus;
  if (racesCollected === 0) {
    collectionStatus = 'WAITING';
  } else if (missingRaces.length === 0 && completeEntryRaces === expectedRaces) {
    collectionStatus = existing[0]?.collection_status === 'BASELINE_CAPTURED' ? 'BASELINE_CAPTURED' : 'COMPLETE';
  } else if (missingRaces.length === 0 && completeEntryRaces < expectedRaces) {
    collectionStatus = 'WAITING';
  } else {
    collectionStatus = 'WAITING';
  }

  // 既存レコードを更新 or 新規作成
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
    collection_status: collectionStatus,
    missing_races: missingRaces,
    last_checked_at: now,
  };

  if (existing.length > 0) {
    // baseline_captured_at と collection_completed_at は既存値を保持
    const updateData = { ...data };
    await base44.asServiceRole.entities.VenueDayReadiness.update(existing[0].id, updateData);
    return { ...data, id: existing[0].id, updated: true };
  } else {
    const created = await base44.asServiceRole.entities.VenueDayReadiness.create(data);
    return { ...data, id: created.id, updated: false };
  }
}

// 指定日の全場のVenueDayReadinessを再計算
export async function recalcAllVenuesForDate(base44, raceDate) {
  const races = await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate, data_source: { $ne: 'sample' }
  }, 'venue_code', 500).catch(() => []);

  const venueCodes = [...new Set(races.map(r => String(r.venue_code).padStart(2, '0')))];
  const results = [];

  for (const jcd of venueCodes) {
    try {
      const result = await recalcVenueDayReadiness(base44, raceDate, jcd);
      results.push({ venue_code: jcd, venue_name: result.venue_name, ...result });
    } catch (e) {
      results.push({ venue_code: jcd, error: e?.message || String(e) });
    }
  }

  return results;
}
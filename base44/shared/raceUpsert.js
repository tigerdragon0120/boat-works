// BOAT WORKS Race一意性保証モジュール
// race_date + venue_code + race_number を論理一意キーとし、
// すべてのRace作成をこのモジュール経由で安全に行う。
//
// Base44にはDBレベルのUNIQUE制約や原子upsertがないため、
// 「find → update or create → post-create dedup」パターンで競合を吸収する。
// 2ワーカーが同時にcreateしても、post-create再確認で必ず1件に正規化される。

import { VENUE_NAMES } from './scraper.js';

const RACE_MERGE_FIELDS = [
  'race_name', 'grade', 'event_name', 'series_key', 'series_start_date',
  'series_end_date', 'series_total_days', 'series_day', 'is_final_day',
  'race_phase', 'deadline', 'time_slot', 'weather', 'wind_dir', 'wind_speed',
  'wave_height', 'air_temperature', 'water_temperature', 'beforeinfo_fetched_at',
  'exhibition_ready', 'scratched_boats', 'status', 'result_trifecta',
  'is_uichi', 'payout_trifecta', 'last_updated', 'entries_fetched_at', 'odds_fetched_at'
];

// Race完全度スコア（正規Race選定用）
// RaceEntry揃い > 展示済み > 結果あり > メタデータ充実
export function raceCompletenessScore(r, entryCount, analysisCount, alertCount, oddsCount) {
  let s = 0;
  s += (entryCount || 0) * 100;
  s += (analysisCount || 0) * 30;
  s += (alertCount || 0) * 20;
  s += (oddsCount || 0) * 5;
  for (const k of RACE_MERGE_FIELDS) {
    if (r?.[k] != null) s += 3;
  }
  if (r?.exhibition_ready === true) s += 20;
  if (r?.status === 'finished') s += 10;
  return s;
}

// 論理一意キーで既存Raceを検索
async function findRacesByLogicalKey(base44, raceDate, venueCode, raceNumber) {
  const jcd = String(venueCode).padStart(2, '0');
  return await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate,
    venue_code: jcd,
    race_number: Number(raceNumber),
    data_source: 'official'
  }, '-updated_date', 10).catch(() => []);
}

// 重複Raceの子データを正規Raceへ移行
async function moveChildrenToCanonical(base44, canonicalId, dupIds, raceDate) {
  if (!dupIds.length) return 0;
  let moved = 0;

  // RaceEntry: 正規側を保持、重複側は削除（再構築しない）
  for (const id of dupIds) {
    await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: id }).catch(() => {});
  }

  // その他の子データはrace_idを付け替え
  for (const id of dupIds) {
    const analyses = await base44.asServiceRole.entities.UichiAnalysis.filter({ race_id: id }, null, 100).catch(() => []);
    for (const a of analyses) {
      await base44.asServiceRole.entities.UichiAnalysis.update(a.id, { race_id: canonicalId }).catch(() => {});
      moved++;
    }
    const alerts = await base44.asServiceRole.entities.Alert.filter({ race_id: id }, null, 10).catch(() => []);
    for (const a of alerts) {
      await base44.asServiceRole.entities.Alert.update(a.id, { race_id: canonicalId }).catch(() => {});
      moved++;
    }
    const odds = await base44.asServiceRole.entities.OddsSnapshot.filter({ race_id: id }, null, 50).catch(() => []);
    for (const o of odds) {
      await base44.asServiceRole.entities.OddsSnapshot.update(o.id, { race_id: canonicalId }).catch(() => {});
      moved++;
    }
    const results = await base44.asServiceRole.entities.RaceResult.filter({ race_id: id }, null, 10).catch(() => []);
    for (const r of results) {
      await base44.asServiceRole.entities.RaceResult.update(r.id, { race_id: canonicalId }).catch(() => {});
      moved++;
    }
    const learning = await base44.asServiceRole.entities.UichiLearningSample.filter({ race_id: id }, null, 100).catch(() => []);
    for (const l of learning) {
      await base44.asServiceRole.entities.UichiLearningSample.update(l.id, { race_id: canonicalId }).catch(() => {});
      moved++;
    }
  }

  return moved;
}

// 重複Raceの非null項目を正規Raceへマージ
async function mergeRaceFields(base44, canonical, duplicates, newData) {
  const merged = {};
  // newDataの非null項目を最優先
  for (const [k, v] of Object.entries(newData || {})) {
    if (v != null) merged[k] = v;
  }
  // canonicalの既存項目を保持
  for (const k of RACE_MERGE_FIELDS) {
    if (merged[k] == null && canonical?.[k] != null) merged[k] = canonical[k];
  }
  // 重複Raceから欠損項目を補完
  for (const r of duplicates) {
    for (const k of RACE_MERGE_FIELDS) {
      if (merged[k] == null && r?.[k] != null) merged[k] = r[k];
    }
  }
  // 差分がある項目だけupdate
  const updateFields = {};
  for (const [k, v] of Object.entries(merged)) {
    if (canonical?.[k] !== v) updateFields[k] = v;
  }
  if (Object.keys(updateFields).length > 0) {
    await base44.asServiceRole.entities.Race.update(canonical.id, updateFields);
  }
}

// 重複グループを正規化：正規Race選定→子データ移行→重複削除
async function deduplicateRaceGroup(base44, group, raceDate) {
  if (group.length <= 1) return { deleted: 0, moved: 0 };

  // 子データ数を取得してスコア計算
  const canonicalId = group[0].id;
  const allIds = group.map(r => r.id);
  const [entries, analyses, alerts, odds] = await Promise.all([
    base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []),
    base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate }, '-captured_at', 5000).catch(() => []),
    base44.asServiceRole.entities.Alert.filter({ race_date: raceDate }, '-updated_date', 5000).catch(() => []),
    base44.asServiceRole.entities.OddsSnapshot.filter({ race_date: raceDate }, '-captured_at', 5000).catch(() => []),
  ]);
  const entryCount = new Map();
  for (const e of entries) entryCount.set(e.race_id, (entryCount.get(e.race_id) || 0) + 1);
  const analysisCount = new Map();
  for (const a of analyses) analysisCount.set(a.race_id, (analysisCount.get(a.race_id) || 0) + 1);
  const alertCount = new Map();
  for (const a of alerts) alertCount.set(a.race_id, (alertCount.get(a.race_id) || 0) + 1);
  const oddsCount = new Map();
  for (const o of odds) oddsCount.set(o.race_id, (oddsCount.get(o.race_id) || 0) + 1);

  const sorted = [...group].sort((a, b) =>
    raceCompletenessScore(b, entryCount.get(b.id), analysisCount.get(b.id), alertCount.get(b.id), oddsCount.get(b.id)) -
    raceCompletenessScore(a, entryCount.get(a.id), analysisCount.get(a.id), alertCount.get(a.id), oddsCount.get(a.id))
  );
  const canonical = sorted[0];
  const dups = sorted.slice(1);
  const dupIds = dups.map(r => r.id);

  await mergeRaceFields(base44, canonical, dups, {});
  const moved = await moveChildrenToCanonical(base44, canonical.id, dupIds, raceDate);

  let deleted = 0;
  for (const d of dups) {
    await base44.asServiceRole.entities.Race.delete(d.id).catch(() => {});
    deleted++;
  }

  return { deleted, moved };
}

// === メインAPI: 安全なRace upsert ===
// すべてのRace作成箇所から呼ばれる共通関数。
// 既存Raceがあれば更新、なければ作成、作成後に重複があれば即座に正規化。
export async function upsertRace(base44, raceData) {
  const raceDate = raceData.race_date;
  const jcd = String(raceData.venue_code).padStart(2, '0');
  const raceNumber = Number(raceData.race_number);

  // 1. 既存Race検索
  let existing = await findRacesByLogicalKey(base44, raceDate, jcd, raceNumber);

  if (existing.length >= 1) {
    const canonical = existing[0];
    const updated = await base44.asServiceRole.entities.Race.update(canonical.id, raceData);

    // 既存の重複があれば即座に正規化
    if (existing.length > 1) {
      const dups = existing.slice(1);
      const dupIds = dups.map(r => r.id);
      await mergeRaceFields(base44, canonical, dups, raceData);
      await moveChildrenToCanonical(base44, canonical.id, dupIds, raceDate);
      for (const d of dups) {
        await base44.asServiceRole.entities.Race.delete(d.id).catch(() => {});
      }
    }
    return updated;
  }

  // 2. 新規作成
  const created = await base44.asServiceRole.entities.Race.create(raceData);

  // 3. post-create再確認（TOCTOU競合検出）
  const postCheck = await findRacesByLogicalKey(base44, raceDate, jcd, raceNumber);

  if (postCheck.length <= 1) {
    return created;
  }

  // 4. 競合発生 → 正規化
  const result = await deduplicateRaceGroup(base44, postCheck, raceDate);
  const canonical = postCheck.find(r => r.id !== created.id) ? postCheck.sort((a, b) => raceCompletenessScore(b) - raceCompletenessScore(a))[0] : created;

  // 自分が作成したRaceが正規でなければ、正規Raceを返す
  if (canonical.id !== created.id) {
    // 作成したRaceが削除された場合、正規RaceにnewDataを反映済み
    return canonical;
  }
  return created;
}

// === 場単位の重複Race正規化 ===
// 収集処理完了後や重複整理後に呼び出し、実データから正規化する。
export async function normalizeRaceDuplicatesForVenue(base44, raceDate, venueCode) {
  const jcd = String(venueCode).padStart(2, '0');
  const races = await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate, venue_code: jcd, data_source: 'official'
  }, '-updated_date', 100).catch(() => []);

  const groups = new Map();
  for (const r of races) {
    const key = Number(r.race_number);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let totalDeleted = 0, totalMoved = 0, dupGroups = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    dupGroups++;
    const result = await deduplicateRaceGroup(base44, group, raceDate);
    totalDeleted += result.deleted;
    totalMoved += result.moved;
  }

  return { duplicate_groups: dupGroups, races_deleted: totalDeleted, children_moved: totalMoved };
}

// === 日付全体の重複Race正規化 ===
export async function normalizeRaceDuplicatesForDate(base44, raceDate) {
  const races = await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate, data_source: 'official'
  }, '-updated_date', 500).catch(() => []);

  const groups = new Map();
  for (const r of races) {
    const key = `${String(r.venue_code).padStart(2, '0')}_${Number(r.race_number)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let totalDeleted = 0, totalMoved = 0, dupGroups = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    dupGroups++;
    const result = await deduplicateRaceGroup(base44, group, raceDate);
    totalDeleted += result.deleted;
    totalMoved += result.moved;
  }

  return { duplicate_groups: dupGroups, races_deleted: totalDeleted, children_moved: totalMoved };
}
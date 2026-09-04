// BOAT WORKS Race一意性保証モジュール（安全版）
// race_date + venue_code + race_number を論理一意キーとし、
// すべてのRace作成をこのモジュール経由で安全に行う。
//
// Base44にはDBレベルのUNIQUE制約や原子upsertがないため、
// 「find → update or create → post-create dedup」パターンで競合を吸収する。
//
// 【安全原則】
// 1. RaceEntryは重複Race側を削除せず、正規Raceへ移行（艇番1-6で最も完全な1件を統合）
// 2. 正規Raceは完成度スコアで選定（entries > analysis > alert > odds > メタデータ）
// 3. 子データ移行に1件でも失敗があれば、重複Raceを削除しない
// 4. exhibition_ready, beforeinfo_fetched_at, 展示情報, 結果情報をnullで上書きしない
// 5. 削除後は正規RaceをDBから再取得して返す

import { VENUE_NAMES } from './scraper.js';

// Race更新時に上書き禁止のフィールド（既存値がnullでない場合）
const PROTECTED_RACE_FIELDS = new Set([
  'exhibition_ready', 'beforeinfo_fetched_at',
  'weather', 'wind_dir', 'wind_speed', 'wave_height', 'air_temperature', 'water_temperature',
  'result_trifecta', 'is_uichi', 'payout_trifecta', 'scratched_boats',
  'entries_fetched_at', 'odds_fetched_at'
]);

const RACE_MERGE_FIELDS = [
  'race_name', 'grade', 'event_name', 'series_key', 'series_start_date',
  'series_end_date', 'series_total_days', 'series_day', 'is_final_day',
  'race_phase', 'deadline', 'time_slot', 'weather', 'wind_dir', 'wind_speed',
  'wave_height', 'air_temperature', 'water_temperature', 'beforeinfo_fetched_at',
  'exhibition_ready', 'scratched_boats', 'status', 'result_trifecta',
  'is_uichi', 'payout_trifecta', 'last_updated', 'entries_fetched_at', 'odds_fetched_at'
];

// RaceEntryの完全度比較用フィールド
const ENTRY_COMPARE_FIELDS = [
  'registration_number', 'racer_name', 'grade_class', 'branch', 'age', 'weight',
  'national_win_rate', 'national_2rate', 'national_3rate',
  'local_win_rate', 'local_2rate', 'local_3rate',
  'c1_win_rate', 'c1_2rate', 'c1_3rate',
  'avg_st', 'f_count', 'l_count',
  'motor_number', 'motor_2rate', 'motor_3rate',
  'boat_number_id', 'boat_2rate', 'boat_3rate',
  'season_record', 'entry_course', 'exhibition_time', 'tilt',
  'exhibition_st', 'exhibition_st_raw', 'exhibition_rank', 'is_scratched'
];

// Race完全度スコア（正規Race選定用）
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

function entryCompletenessScore(entry) {
  let s = 0;
  for (const f of ENTRY_COMPARE_FIELDS) {
    if (entry?.[f] != null) s++;
  }
  return s;
}

// 論理一意キーで既存Raceを検索（sampleデータを除外、null/未設定のdata_sourceも含む）
async function findRacesByLogicalKey(base44, raceDate, venueCode, raceNumber) {
  const jcd = String(venueCode).padStart(2, '0');
  return await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate,
    venue_code: jcd,
    race_number: Number(raceNumber),
    data_source: { $ne: 'sample' }
  }, '-updated_date', 10).catch(() => []);
}

// 安全な更新フィールド構築：nullで上書きしない、保護フィールドを尊重
function filterSafeUpdateFields(existing, newData) {
  const safe = {};
  for (const [k, v] of Object.entries(newData || {})) {
    if (v == null) continue;
    if (PROTECTED_RACE_FIELDS.has(k) && existing?.[k] != null) continue;
    if (k === 'status' && existing?.[k] === 'finished' && v !== 'finished') continue;
    safe[k] = v;
  }
  return safe;
}

// 重複Raceの非null項目を正規Raceへマージ
async function mergeRaceFields(base44, canonical, duplicates, newData) {
  const merged = {};
  for (const [k, v] of Object.entries(newData || {})) {
    if (v != null) merged[k] = v;
  }
  for (const k of RACE_MERGE_FIELDS) {
    if (merged[k] == null && canonical?.[k] != null) merged[k] = canonical[k];
  }
  for (const r of duplicates) {
    for (const k of RACE_MERGE_FIELDS) {
      if (merged[k] == null && r?.[k] != null) merged[k] = r[k];
    }
  }
  const updateFields = {};
  for (const [k, v] of Object.entries(merged)) {
    if (canonical?.[k] !== v) updateFields[k] = v;
  }
  if (Object.keys(updateFields).length > 0) {
    await base44.asServiceRole.entities.Race.update(canonical.id, updateFields);
  }
}

// RaceEntryを正規Raceへ移行：艇番1-6ごとに最も完全な1件を選択し非null項目を統合
async function migrateEntriesToCanonical(base44, canonicalId, dupIds, raceDate, jcd, raceNumber) {
  const allIds = [canonicalId, ...dupIds];
  const allEntries = [];
  for (const id of allIds) {
    const ents = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: id }, 'boat_number', 20).catch(() => []);
    allEntries.push(...ents);
  }

  // 艇番ごとにグループ化
  const byBoat = new Map();
  for (const e of allEntries) {
    const bn = Number(e.boat_number);
    if (!bn || bn < 1 || bn > 6) continue;
    if (!byBoat.has(bn)) byBoat.set(bn, []);
    byBoat.get(bn).push(e);
  }

  // 各艇番について最も完全なエントリをベースに非null項目を統合
  const mergedEntries = [];
  for (let bn = 1; bn <= 6; bn++) {
    const candidates = byBoat.get(bn) || [];
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => entryCompletenessScore(b) - entryCompletenessScore(a));
    const base = { ...candidates[0] };
    delete base.id;
    delete base.created_date;
    delete base.updated_date;
    delete base.created_by_id;

    for (const c of candidates.slice(1)) {
      for (const [k, v] of Object.entries(c)) {
        if (['id', 'created_date', 'updated_date', 'created_by_id', 'race_id', 'race_date', 'venue_code', 'race_number'].includes(k)) continue;
        if (base[k] == null && v != null) base[k] = v;
      }
    }

    base.race_id = canonicalId;
    base.race_date = raceDate;
    base.venue_code = jcd;
    base.race_number = raceNumber;
    mergedEntries.push(base);
  }

  // 全Race IDのエントリを削除してから正規Raceへ再作成
  for (const id of allIds) {
    await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: id }).catch(() => {});
  }
  if (mergedEntries.length > 0) {
    await base44.asServiceRole.entities.RaceEntry.bulkCreate(mergedEntries);
  }

  // 正規Raceに1-6号艇が各1件揃ったか再取得して確認
  const verify = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: canonicalId }, 'boat_number', 20).catch(() => []);
  const boatSet = new Set(verify.map(e => Number(e.boat_number)));
  const complete = [1, 2, 3, 4, 5, 6].every(bn => boatSet.has(bn));

  return { saved: mergedEntries.length, verified: verify.length, complete };
}

// その他の子データを正規Raceへ移行（race_id付け替え）
async function migrateOtherChildren(base44, canonicalId, dupIds) {
  let moved = 0, failed = 0;
  const entityNames = ['UichiAnalysis', 'Alert', 'OddsSnapshot', 'RaceResult', 'UichiLearningSample'];

  for (const entityName of entityNames) {
    for (const id of dupIds) {
      const children = await base44.asServiceRole.entities[entityName].filter({ race_id: id }, null, 100).catch(() => []);
      for (const child of children) {
        try {
          await base44.asServiceRole.entities[entityName].update(child.id, { race_id: canonicalId });
          moved++;
        } catch {
          failed++;
        }
      }
    }
  }

  return { moved, failed };
}

// 重複グループを正規化：正規Race選定→子データ移行→移行成功確認→重複削除
// 移行失敗が1件でもあれば重複Raceを削除しない
async function deduplicateRaceGroup(base44, group, raceDate) {
  if (group.length <= 1) return { deleted: 0, moved: 0, failed: 0, entry_complete: true };

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

  // 完成度スコアで正規Raceを選定
  const sorted = [...group].sort((a, b) =>
    raceCompletenessScore(b, entryCount.get(b.id), analysisCount.get(b.id), alertCount.get(b.id), oddsCount.get(b.id)) -
    raceCompletenessScore(a, entryCount.get(a.id), analysisCount.get(a.id), alertCount.get(a.id), oddsCount.get(a.id))
  );
  const canonical = sorted[0];
  const dups = sorted.slice(1);
  const dupIds = dups.map(r => r.id);

  // Race本体の非null項目を正規Raceへ補完
  await mergeRaceFields(base44, canonical, dups, {});

  // RaceEntryを正規Raceへ移行
  const jcd = String(canonical.venue_code).padStart(2, '0');
  const entryResult = await migrateEntriesToCanonical(base44, canonical.id, dupIds, raceDate, jcd, Number(canonical.race_number));

  // その他の子データを移行
  const childResult = await migrateOtherChildren(base44, canonical.id, dupIds);
  let moved = childResult.moved;
  let failed = childResult.failed;

  // 子データ移行に失敗がなければ重複Raceを削除する。
  // 出走表取得前はRaceEntryが0件/未完成でも正常なため、entry_completeを削除条件にすると
  // 同時実行で生まれた空Raceが残り続ける。利用可能なRaceEntryは上で正規Raceへ統合済みなので、
  // 完全性は後続のintegrity workerで補修し、重複本体はここで確実に除去する。
  let deleted = 0;
  if (failed === 0) {
    for (const d of dups) {
      try {
        await base44.asServiceRole.entities.Race.delete(d.id);
        deleted++;
      } catch {
        failed++;
      }
    }
  }

  return { deleted, moved, failed, entry_complete: entryResult.complete, entry_saved: entryResult.saved };
}

// === メインAPI: 安全なRace upsert ===
export async function upsertRace(base44, raceData) {
  const raceDate = raceData.race_date;
  const jcd = String(raceData.venue_code).padStart(2, '0');
  const raceNumber = Number(raceData.race_number);

  // 1. 既存Race検索
  let existing = await findRacesByLogicalKey(base44, raceDate, jcd, raceNumber);

  if (existing.length >= 1) {
    // 完成度スコアで正規Raceを選定（updated_date順ではない）
    if (existing.length === 1) {
      const canonical = existing[0];
      const safeData = filterSafeUpdateFields(canonical, raceData);
      if (Object.keys(safeData).length > 0) {
        await base44.asServiceRole.entities.Race.update(canonical.id, safeData);
      }
      // DBから再取得して返す
      return await base44.asServiceRole.entities.Race.get(canonical.id);
    }

    // 複数既存 → 正規化してから正規Raceを返す
    await deduplicateRaceGroup(base44, existing, raceDate);
    const refetched = await findRacesByLogicalKey(base44, raceDate, jcd, raceNumber);
    if (refetched.length > 0) {
      const canonical = refetched[0];
      const safeData = filterSafeUpdateFields(canonical, raceData);
      if (Object.keys(safeData).length > 0) {
        await base44.asServiceRole.entities.Race.update(canonical.id, safeData);
      }
      return await base44.asServiceRole.entities.Race.get(canonical.id);
    }
  }

  // 2. 新規作成
  const created = await base44.asServiceRole.entities.Race.create(raceData);

  // 3. post-create再確認（TOCTOU競合検出）
  const postCheck = await findRacesByLogicalKey(base44, raceDate, jcd, raceNumber);

  if (postCheck.length <= 1) {
    return created;
  }

  // 4. 競合発生 → 正規化
  await deduplicateRaceGroup(base44, postCheck, raceDate);

  // 5. 正規RaceをDBから再取得して返す
  const finalCheck = await findRacesByLogicalKey(base44, raceDate, jcd, raceNumber);
  return finalCheck[0] || created;
}

// === 場単位の重複Race正規化 ===
export async function normalizeRaceDuplicatesForVenue(base44, raceDate, venueCode) {
  const jcd = String(venueCode).padStart(2, '0');
  const races = await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate, venue_code: jcd, data_source: { $ne: 'sample' }
  }, '-updated_date', 100).catch(() => []);

  const groups = new Map();
  for (const r of races) {
    const key = Number(r.race_number);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let totalDeleted = 0, totalMoved = 0, totalFailed = 0, dupGroups = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    dupGroups++;
    const result = await deduplicateRaceGroup(base44, group, raceDate);
    totalDeleted += result.deleted;
    totalMoved += result.moved;
    totalFailed += result.failed;
  }

  return { duplicate_groups: dupGroups, races_deleted: totalDeleted, children_moved: totalMoved, children_failed: totalFailed };
}

// === 日付全体の重複Race正規化 ===
export async function normalizeRaceDuplicatesForDate(base44, raceDate) {
  const races = await base44.asServiceRole.entities.Race.filter({
    race_date: raceDate, data_source: { $ne: 'sample' }
  }, '-updated_date', 500).catch(() => []);

  const groups = new Map();
  for (const r of races) {
    const key = `${String(r.venue_code).padStart(2, '0')}_${Number(r.race_number)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let totalDeleted = 0, totalMoved = 0, totalFailed = 0, dupGroups = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    dupGroups++;
    const result = await deduplicateRaceGroup(base44, group, raceDate);
    totalDeleted += result.deleted;
    totalMoved += result.moved;
    totalFailed += result.failed;
  }

  return { duplicate_groups: dupGroups, races_deleted: totalDeleted, children_moved: totalMoved, children_failed: totalFailed };
}
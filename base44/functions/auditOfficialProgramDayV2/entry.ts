import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 公式データ取込V2 日次監査
// 指定日のOfficialRaceCoreV2/OfficialRaceEntryV2の整合性を集計する。
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { race_date } = body;
    if (!race_date) {
      return Response.json({ status: 'error', message: 'race_dateが必要です' }, { status: 400 });
    }

    const races = await base44.asServiceRole.entities.OfficialRaceCoreV2.filter(
      { race_date }, 'race_number', 500
    ).catch(() => []);
    const entries = await base44.asServiceRole.entities.OfficialRaceEntryV2.filter(
      { race_date }, 'boat_number', 5000
    ).catch(() => []);
    const batches = await base44.asServiceRole.entities.OfficialImportBatchV2.filter(
      { source_date: race_date, status: 'COMPLETED' }, '-completed_at', 10
    ).catch(() => []);

    // race_key重複
    const raceKeyMap = {};
    for (const r of races) raceKeyMap[r.race_key] = (raceKeyMap[r.race_key] || 0) + 1;
    const raceKeyDuplicates = Object.entries(raceKeyMap).filter(([, v]) => v > 1).map(([k, v]) => ({ race_key: k, count: v }));

    // entry_key重複
    const entryKeyMap = {};
    for (const e of entries) entryKeyMap[e.entry_key] = (entryKeyMap[e.entry_key] || 0) + 1;
    const entryKeyDuplicates = Object.entries(entryKeyMap).filter(([, v]) => v > 1).map(([k, v]) => ({ entry_key: k, count: v }));

    // 欠落チェック
    const missingVenue = races.filter((r) => !r.venue_code).length;
    const missingRaceNum = races.filter((r) => !r.race_number).length;
    const missingBoat = entries.filter((e) => !e.boat_number).length;
    const missingReg = entries.filter((e) => !e.registration_number).length;

    // 孤立Entry(対応Raceがない)
    const raceKeySet = new Set(races.map((r) => r.race_key));
    const orphanEntries = entries.filter((e) => !raceKeySet.has(e.race_key));

    // 会場別集計
    const venueMap = {};
    for (const r of races) {
      if (!venueMap[r.venue_code]) {
        venueMap[r.venue_code] = { venue_code: r.venue_code, venue_name: r.venue_name, race_count: 0, entry_count: 0 };
      }
      venueMap[r.venue_code].race_count++;
    }
    for (const e of entries) {
      if (venueMap[e.venue_code]) venueMap[e.venue_code].entry_count++;
    }

    // レース別選手数
    const raceEntryCounts = {};
    for (const e of entries) {
      raceEntryCounts[e.race_key] = (raceEntryCounts[e.race_key] || 0) + 1;
    }

    const lastBatchKey = batches.length > 0 ? batches[0].batch_key : null;

    const allChecks = [
      raceKeyDuplicates.length === 0,
      entryKeyDuplicates.length === 0,
      missingVenue === 0,
      missingRaceNum === 0,
      missingBoat === 0,
      missingReg === 0,
      orphanEntries.length === 0,
    ];
    const overall = races.length === 0 ? 'EMPTY' : allChecks.every((c) => c) ? 'PASS' : 'FAIL';

    return Response.json({
      status: 'success',
      race_date,
      venue_count: Object.keys(venueMap).length,
      race_count: races.length,
      entry_count: entries.length,
      venues: Object.values(venueMap),
      race_entry_counts: raceEntryCounts,
      race_key_duplicates: raceKeyDuplicates,
      entry_key_duplicates: entryKeyDuplicates,
      missing_venue_code: missingVenue,
      missing_race_number: missingRaceNum,
      missing_boat_number: missingBoat,
      missing_registration_number: missingReg,
      orphan_entries: orphanEntries.length,
      last_completed_batch_key: lastBatchKey,
      overall,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
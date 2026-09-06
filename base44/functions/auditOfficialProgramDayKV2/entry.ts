import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 公式競走成績K 日次監査
// 指定日のOfficialRaceResultV2/OfficialRaceEntryResultV2/OfficialRacePayoutV2の整合性を集計する。
// B番組表(OfficialRaceCoreV2/OfficialRaceEntryV2)との照合も行う。
// 当日未終了レースはエラーとして扱わない。
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

    const results = await base44.asServiceRole.entities.OfficialRaceResultV2.filter(
      { source_date: race_date }, 'race_number', 500
    ).catch(() => []);

    const raceKeys = results.map(r => r.race_key);
    const raceKeySet = new Set(raceKeys);

    const allEntryResults = await base44.asServiceRole.entities.OfficialRaceEntryResultV2.list('-created_date', 5000).catch(() => []);
    const entryResults = allEntryResults.filter(e => raceKeySet.has(e.race_key));

    const allPayouts = await base44.asServiceRole.entities.OfficialRacePayoutV2.list('-created_date', 5000).catch(() => []);
    const payouts = allPayouts.filter(p => raceKeySet.has(p.race_key));

    const bRaces = await base44.asServiceRole.entities.OfficialRaceCoreV2.filter(
      { race_date: race_date }, 'race_number', 500
    ).catch(() => []);
    const bRaceKeySet = new Set(bRaces.map((r) => r.race_key));

    const bEntries = await base44.asServiceRole.entities.OfficialRaceEntryV2.filter(
      { race_date: race_date }, 'boat_number', 5000
    ).catch(() => []);
    const bEntryMap = {};
    for (const e of bEntries) {
      bEntryMap[e.entry_key] = { registration_number: e.registration_number, boat_number: e.boat_number };
    }

    const batches = await base44.asServiceRole.entities.OfficialResultImportBatchV2.filter(
      { source_date: race_date }, '-completed_at', 10
    ).catch(() => []);

    // 重複チェック
    const resultMap = {};
    for (const r of results) resultMap[r.result_key] = (resultMap[r.result_key] || 0) + 1;
    const resultKeyDuplicates = Object.entries(resultMap).filter(([, v]) => v > 1).map(([k, v]) => ({ result_key: k, count: v }));

    const entryResultMap = {};
    for (const e of entryResults) entryResultMap[e.entry_result_key] = (entryResultMap[e.entry_result_key] || 0) + 1;
    const entryResultKeyDuplicates = Object.entries(entryResultMap).filter(([, v]) => v > 1).map(([k, v]) => ({ entry_result_key: k, count: v }));

    const payoutMap = {};
    for (const p of payouts) payoutMap[p.payout_key] = (payoutMap[p.payout_key] || 0) + 1;
    const payoutKeyDuplicates = Object.entries(payoutMap).filter(([, v]) => v > 1).map(([k, v]) => ({ payout_key: k, count: v }));

    // 欠落チェック
    const missingVenue = results.filter((r) => !r.venue_code).length;
    const missingRaceNum = results.filter((r) => !r.race_number).length;
    const missingBoat = entryResults.filter((e) => !e.boat_number).length;
    const missingReg = entryResults.filter((e) => !e.registration_number).length;

    // B番組表に存在しない結果
    const resultsNotInB = results.filter((r) => !bRaceKeySet.has(r.race_key));

    // B出走選手に一致しない選手結果
    const entryMismatches = entryResults.filter((e) => {
      const bEntry = bEntryMap[e.entry_key];
      if (!bEntry) return true;
      return bEntry.registration_number !== e.registration_number || bEntry.boat_number !== e.boat_number;
    });

    // Bに存在する6艇がK結果にもすべて存在することを確認する。
    // 欠場艇もK1等の公式コードからABSENTとして1件保持される必要がある。
    const entryResultKeySet = new Set(entryResults.map((e) => e.entry_key));
    const bEntriesMissingInK = bEntries.filter((e) => !entryResultKeySet.has(e.entry_key));

    // 確定レースの決まり手欠落
    const missingWinningMethod = results.filter((r) => r.official_confirmed === true && !r.winning_method);

    // 着順重複・1着不在チェック
    const finishByRace = {};
    for (const e of entryResults) {
      if (!finishByRace[e.race_key]) finishByRace[e.race_key] = [];
      if (e.finish_status === 'FINISHED') finishByRace[e.race_key].push(e);
    }
    const finishDuplicates = [];
    const missingFirst = [];
    for (const [rk, entries] of Object.entries(finishByRace)) {
      const orders = entries.map(e => e.finish_order);
      const orderSet = new Set();
      for (const o of orders) {
        if (orderSet.has(o)) finishDuplicates.push({ race_key: rk, finish_order: o });
        orderSet.add(o);
      }
      if (!orders.includes(1) && entries.length > 0) missingFirst.push(rk);
    }

    // 結果確定済みなのに選手結果がないレース
    const confirmedWithoutEntries = results.filter((r) => {
      if (r.official_confirmed !== true) return false;
      const raceEntries = entryResults.filter(e => e.race_key === r.race_key);
      return raceEntries.length === 0;
    });

    // 正式結果から未確定への逆戻り
    const regressionRaces = results.filter((r) => r.official_confirmed === true && r.result_status === 'PENDING');

    // 取込途中のバッチ
    const stuckBatches = batches.filter((b) => b.status === 'IMPORTING');

    const confirmedRaces = results.filter((r) => r.official_confirmed === true);
    const pendingRaces = results.filter((r) => r.official_confirmed !== true);

    // 会場別集計
    const venueMap = {};
    for (const r of results) {
      if (!venueMap[r.venue_code]) {
        venueMap[r.venue_code] = { venue_code: r.venue_code, venue_name: r.venue_name, race_count: 0, entry_count: 0, confirmed: 0, pending: 0 };
      }
      venueMap[r.venue_code].race_count++;
      if (r.official_confirmed === true) venueMap[r.venue_code].confirmed++;
      else venueMap[r.venue_code].pending++;
    }
    for (const e of entryResults) {
      const vc = e.race_key.split('_')[1];
      if (venueMap[vc]) venueMap[vc].entry_count++;
    }

    const lastBatchKey = batches.length > 0 ? batches[0].batch_key : null;
    const lastBatchStatus = batches.length > 0 ? batches[0].status : null;

    const allChecks = [
      resultKeyDuplicates.length === 0,
      entryResultKeyDuplicates.length === 0,
      payoutKeyDuplicates.length === 0,
      resultsNotInB.length === 0,
      entryMismatches.length === 0,
      bEntriesMissingInK.length === 0,
      missingWinningMethod.length === 0,
      missingVenue === 0,
      missingRaceNum === 0,
      missingBoat === 0,
      missingReg === 0,
      finishDuplicates.length === 0,
      confirmedWithoutEntries.length === 0,
      regressionRaces.length === 0,
      stuckBatches.length === 0,
    ];

    const overall = results.length === 0 ? 'EMPTY' : allChecks.every((c) => c) ? 'PASS' : 'FAIL';

    return Response.json({
      status: 'success',
      race_date,
      venue_count: Object.keys(venueMap).length,
      race_count: results.length,
      confirmed_race_count: confirmedRaces.length,
      pending_race_count: pendingRaces.length,
      entry_result_count: entryResults.length,
      payout_count: payouts.length,
      venues: Object.values(venueMap),
      result_key_duplicates: resultKeyDuplicates,
      entry_result_key_duplicates: entryResultKeyDuplicates,
      payout_key_duplicates: payoutKeyDuplicates,
      results_not_in_b: resultsNotInB.map(r => r.race_key),
      entry_mismatches: entryMismatches.map(e => e.entry_result_key),
      b_entries_missing_in_k: bEntriesMissingInK.map(e => e.entry_key),
      missing_winning_method: missingWinningMethod.map(r => r.race_key),
      absent_entry_count: entryResults.filter(e => e.is_absent === true).length,
      returned_entry_count: entryResults.filter(e => e.is_returned === true).length,
      missing_venue_code: missingVenue,
      missing_race_number: missingRaceNum,
      missing_boat_number: missingBoat,
      missing_registration_number: missingReg,
      finish_duplicates: finishDuplicates,
      missing_first: missingFirst,
      confirmed_without_entries: confirmedWithoutEntries.map(r => r.race_key),
      regression_races: regressionRaces.map(r => r.race_key),
      stuck_batches: stuckBatches.map(b => b.batch_key),
      last_completed_batch_key: lastBatchKey,
      last_batch_status: lastBatchStatus,
      overall,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  decodeShiftJIS,
  parseProgramK,
  validateKParseResult,
  computeSHA256,
  K_PARSER_VERSION,
} from '../../shared/programKParser.js';
import { isSameRecord, bulkChunked } from '../../shared/importUtils.js';

// 公式競走成績Kファイル 確定取込
// プレビューと同じファイルを再検証し、result_key/entry_result_key/payout_keyで冪等upsertする。
// 全件成功時のみCOMPLETED + is_publishable=true。失敗時はFAILED。
// 既存の確定値をnullや未確定で上書きしない。

const RESULT_COMPARE_FIELDS = [
  'race_name', 'winning_method', 'weather', 'wind_direction', 'wind_speed', 'wave_height',
];
const ENTRY_RESULT_COMPARE_FIELDS = [
  'registration_number', 'racer_name', 'finish_order', 'finish_status',
  'start_course', 'start_timing', 'race_time',
];
const PAYOUT_COMPARE_FIELDS = ['payout_amount', 'popularity', 'is_refund'];

// K専用: official_confirmed/result_statusの逆戻り防止付きsafe update
function buildSafeUpdate(payload, existing) {
  const update = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null && existing[key] != null) continue;
    if (key === 'official_confirmed' && existing[key] === true && value === false) continue;
    if (key === 'result_status' && existing[key] === 'CONFIRMED' && value !== 'CONFIRMED') continue;
    update[key] = value;
  }
  return update;
}

function normalizeCombination(comb) {
  return String(comb || '').replace(/\s/g, '');
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { file_url, file_name, expected_checksum } = body;
    if (!file_url || !file_name) {
      return Response.json({ status: 'error', message: 'file_urlとfile_nameが必要です' }, { status: 400 });
    }

    const response = await fetch(file_url);
    if (!response.ok) {
      return Response.json({ status: 'error', message: `ファイル取得失敗: HTTP ${response.status}` }, { status: 502 });
    }
    const arrayBuffer = await response.arrayBuffer();
    const checksum = await computeSHA256(arrayBuffer);

    if (expected_checksum && checksum !== expected_checksum) {
      return Response.json({
        status: 'error',
        message: 'チェックサム不一致: プレビュー時とファイルが異なります',
        checksum,
      }, { status: 400 });
    }

    const text = decodeShiftJIS(arrayBuffer);
    const parsed = parseProgramK(text, file_name);
    const validation = validateKParseResult(parsed, file_name);

    const sourceDate = parsed.source_date;
    if (!sourceDate) {
      return Response.json({ status: 'error', message: '開催日が特定できません' }, { status: 400 });
    }

    // B番組表との照合
    const bRaces = await base44.asServiceRole.entities.OfficialRaceCoreV2.filter(
      { race_date: sourceDate }, 'race_number', 500
    ).catch(() => []);
    const bRaceKeySet = new Set(bRaces.map((r) => r.race_key));

    const bEntries = await base44.asServiceRole.entities.OfficialRaceEntryV2.filter(
      { race_date: sourceDate }, 'boat_number', 5000
    ).catch(() => []);
    const bEntryMap = {};
    for (const e of bEntries) {
      bEntryMap[e.entry_key] = { registration_number: e.registration_number, boat_number: e.boat_number };
    }

    const bMismatch = parsed.races.filter((r) => !bRaceKeySet.has(r.race_key));
    if (bMismatch.length > 0) {
      return Response.json({
        status: 'error',
        message: `B番組表未登録レースが${bMismatch.length}件あります。取込を中止しました。`,
        b_mismatch_race_keys: bMismatch.map((r) => r.race_key).slice(0, 50),
        checksum,
      }, { status: 400 });
    }

    const entryMismatches = [];
    for (const entry of parsed.entry_results) {
      const bEntry = bEntryMap[entry.entry_key];
      if (bEntry && (bEntry.registration_number !== entry.registration_number || bEntry.boat_number !== entry.boat_number)) {
        entryMismatches.push(entry.entry_key);
      }
    }
    if (entryMismatches.length > 0) {
      return Response.json({
        status: 'error',
        message: `選手照合不一致が${entryMismatches.length}件あります。取込を中止しました。`,
        entry_mismatch_keys: entryMismatches.slice(0, 50),
        checksum,
      }, { status: 400 });
    }

    if (!validation.is_importable) {
      return Response.json({
        status: 'error',
        message: '検証エラーのため取込を中止しました',
        errors: validation.fatal_errors,
        checksum,
      }, { status: 400 });
    }

    const batchKey = `PROGRAM_K_${sourceDate}_${checksum.substring(0, 12)}`;
    const now = new Date().toISOString();

    const existingBatches = await base44.asServiceRole.entities.OfficialResultImportBatchV2.filter(
      { batch_key: batchKey }, '-completed_at', 5
    ).catch(() => []);

    if (existingBatches.length > 0 && existingBatches[0].status === 'COMPLETED') {
      return Response.json({
        status: 'already_imported',
        batch_key: batchKey,
        message: 'このファイルは既に取込済みです',
        checksum,
      });
    }

    let batchId;
    if (existingBatches.length > 0) {
      batchId = existingBatches[0].id;
      await base44.asServiceRole.entities.OfficialResultImportBatchV2.update(batchId, {
        status: 'IMPORTING',
        started_at: now,
        is_publishable: false,
        venue_count: parsed.venues.length,
        race_count: parsed.races.length,
        entry_result_count: parsed.entry_results.length,
        payout_count: parsed.payouts.length,
        file_name,
        file_hash: checksum,
        file_size: arrayBuffer.byteLength,
        parser_version: K_PARSER_VERSION,
      });
    } else {
      const created = await base44.asServiceRole.entities.OfficialResultImportBatchV2.create({
        batch_key: batchKey,
        file_name,
        file_size: arrayBuffer.byteLength,
        file_hash: checksum,
        source_date: sourceDate,
        status: 'IMPORTING',
        venue_count: parsed.venues.length,
        race_count: parsed.races.length,
        entry_result_count: parsed.entry_results.length,
        payout_count: parsed.payouts.length,
        created_count: 0,
        updated_count: 0,
        unchanged_count: 0,
        error_count: 0,
        warning_count: validation.warnings.length,
        is_publishable: false,
        parser_version: K_PARSER_VERSION,
        started_at: now,
        error_details: [],
      });
      batchId = created.id;
    }

    // 既存Result取得
    const existingResults = await base44.asServiceRole.entities.OfficialRaceResultV2.filter(
      { source_date: sourceDate }, 'race_number', 500
    ).catch(() => []);
    const existingResultMap = {};
    for (const r of existingResults) {
      if (!existingResultMap[r.result_key]) existingResultMap[r.result_key] = [];
      existingResultMap[r.result_key].push(r);
    }

    // 既存EntryResult取得(全件list→race_keyでフィルタ)
    const raceKeySet = new Set(parsed.races.map(r => r.race_key));
    const allEntryResults = await base44.asServiceRole.entities.OfficialRaceEntryResultV2.list('-created_date', 5000).catch(() => []);
    const existingEntryResults = allEntryResults.filter(e => raceKeySet.has(e.race_key));
    const existingEntryResultMap = {};
    for (const e of existingEntryResults) {
      if (!existingEntryResultMap[e.entry_result_key]) existingEntryResultMap[e.entry_result_key] = [];
      existingEntryResultMap[e.entry_result_key].push(e);
    }

    // 既存Payout取得(全件list→race_keyでフィルタ)
    const allPayouts = await base44.asServiceRole.entities.OfficialRacePayoutV2.list('-created_date', 5000).catch(() => []);
    const existingPayouts = allPayouts.filter(p => raceKeySet.has(p.race_key));
    const existingPayoutMap = {};
    for (const p of existingPayouts) {
      if (!existingPayoutMap[p.payout_key]) existingPayoutMap[p.payout_key] = [];
      existingPayoutMap[p.payout_key].push(p);
    }

    // Result分類
    const resultsToCreate = [];
    const resultsToUpdate = [];
    let resultUnchanged = 0;
    let errorCount = 0;
    const errorDetails = [];

    for (const race of parsed.races) {
      const existing = existingResultMap[race.race_key];
      if (existing && existing.length > 1) {
        errorCount++;
        errorDetails.push({ result_key: race.race_key, message: `result_key重複: ${existing.length}件` });
        continue;
      }
      const payload = {
        result_key: race.race_key,
        race_key: race.race_key,
        source_date: race.source_date,
        venue_code: race.venue_code,
        venue_name: race.venue_name,
        race_number: race.race_number,
        race_name: race.race_name,
        winning_method: race.winning_method,
        weather: race.weather,
        wind_direction: race.wind_direction,
        wind_speed: race.wind_speed,
        wave_height: race.wave_height,
        air_temperature: null,
        water_temperature: null,
        result_status: race.result_status,
        official_confirmed: race.official_confirmed,
        source_batch_key: batchKey,
        source_file_name: file_name,
        parser_version: K_PARSER_VERSION,
        validation_status: 'VALID',
      };
      if (!existing || existing.length === 0) {
        resultsToCreate.push(payload);
      } else if (isSameRecord(existing[0], payload, RESULT_COMPARE_FIELDS)) {
        resultUnchanged++;
      } else {
        const updateData = buildSafeUpdate(payload, existing[0]);
        updateData.id = existing[0].id;
        resultsToUpdate.push(updateData);
      }
    }

    // EntryResult分類
    const entryResultsToCreate = [];
    const entryResultsToUpdate = [];
    let entryResultUnchanged = 0;

    for (const entry of parsed.entry_results) {
      const existing = existingEntryResultMap[entry.entry_result_key];
      if (existing && existing.length > 1) {
        errorCount++;
        errorDetails.push({ entry_result_key: entry.entry_result_key, message: `entry_result_key重複: ${existing.length}件` });
        continue;
      }
      const payload = {
        entry_result_key: entry.entry_result_key,
        entry_key: entry.entry_key,
        race_key: entry.race_key,
        boat_number: entry.boat_number,
        registration_number: entry.registration_number,
        racer_name: entry.racer_name,
        finish_order: entry.finish_order,
        finish_status: entry.finish_status,
        start_course: entry.start_course,
        start_timing: entry.start_timing,
        race_time: entry.race_time,
        is_absent: entry.is_absent,
        is_disqualified: entry.is_disqualified,
        is_returned: entry.is_returned,
        source_batch_key: batchKey,
        validation_status: 'VALID',
      };
      if (!existing || existing.length === 0) {
        entryResultsToCreate.push(payload);
      } else if (isSameRecord(existing[0], payload, ENTRY_RESULT_COMPARE_FIELDS)) {
        entryResultUnchanged++;
      } else {
        const updateData = buildSafeUpdate(payload, existing[0]);
        updateData.id = existing[0].id;
        entryResultsToUpdate.push(updateData);
      }
    }

    // Payout分類
    const payoutsToCreate = [];
    const payoutsToUpdate = [];
    let payoutUnchanged = 0;

    for (const payout of parsed.payouts) {
      const normComb = normalizeCombination(payout.combination);
      const payoutKey = `${payout.race_key}_${payout.bet_type}_${normComb}`;
      const existing = existingPayoutMap[payoutKey];
      if (existing && existing.length > 1) {
        errorCount++;
        errorDetails.push({ payout_key: payoutKey, message: `payout_key重複: ${existing.length}件` });
        continue;
      }
      const payload = {
        payout_key: payoutKey,
        race_key: payout.race_key,
        bet_type: payout.bet_type,
        combination: normComb,
        payout_amount: payout.payout_amount,
        popularity: payout.popularity,
        is_refund: payout.is_refund,
        source_batch_key: batchKey,
        validation_status: 'VALID',
      };
      if (!existing || existing.length === 0) {
        payoutsToCreate.push(payload);
      } else if (isSameRecord(existing[0], payload, PAYOUT_COMPARE_FIELDS)) {
        payoutUnchanged++;
      } else {
        const updateData = buildSafeUpdate(payload, existing[0]);
        updateData.id = existing[0].id;
        payoutsToUpdate.push(updateData);
      }
    }

    let createdCount = 0, updatedCount = 0;
    try {
      if (resultsToCreate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceResultV2', 'bulkCreate', resultsToCreate);
        createdCount += resultsToCreate.length;
      }
      if (resultsToUpdate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceResultV2', 'bulkUpdate', resultsToUpdate);
        updatedCount += resultsToUpdate.length;
      }
      if (entryResultsToCreate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceEntryResultV2', 'bulkCreate', entryResultsToCreate);
        createdCount += entryResultsToCreate.length;
      }
      if (entryResultsToUpdate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceEntryResultV2', 'bulkUpdate', entryResultsToUpdate);
        updatedCount += entryResultsToUpdate.length;
      }
      if (payoutsToCreate.length > 0) {
        await bulkChunked(base44, 'OfficialRacePayoutV2', 'bulkCreate', payoutsToCreate);
        createdCount += payoutsToCreate.length;
      }
      if (payoutsToUpdate.length > 0) {
        await bulkChunked(base44, 'OfficialRacePayoutV2', 'bulkUpdate', payoutsToUpdate);
        updatedCount += payoutsToUpdate.length;
      }
    } catch (e) {
      errorCount++;
      errorDetails.push({ message: `DB書き込みエラー: ${e?.message || String(e)}` });
    }

    const unchangedCount = resultUnchanged + entryResultUnchanged + payoutUnchanged;
    const completedAt = new Date().toISOString();

    if (errorCount === 0) {
      await base44.asServiceRole.entities.OfficialResultImportBatchV2.update(batchId, {
        status: 'COMPLETED',
        completed_at: completedAt,
        created_count: createdCount,
        updated_count: updatedCount,
        unchanged_count: unchangedCount,
        error_count: 0,
        is_publishable: true,
      });
    } else {
      await base44.asServiceRole.entities.OfficialResultImportBatchV2.update(batchId, {
        status: 'FAILED',
        completed_at: completedAt,
        created_count: createdCount,
        updated_count: updatedCount,
        unchanged_count: unchangedCount,
        error_count: errorCount,
        error_details: errorDetails.slice(0, 100),
        is_publishable: false,
      });
    }

    return Response.json({
      status: errorCount === 0 ? 'success' : 'partial_error',
      batch_key: batchKey,
      checksum,
      source_date: sourceDate,
      venue_count: parsed.venues.length,
      race_count: parsed.races.length,
      entry_result_count: parsed.entry_results.length,
      payout_count: parsed.payouts.length,
      created_count: createdCount,
      updated_count: updatedCount,
      unchanged_count: unchangedCount,
      error_count: errorCount,
      errors: errorDetails.slice(0, 100),
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
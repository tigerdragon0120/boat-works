import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  decodeShiftJIS,
  parseProgramB,
  validateParseResult,
  computeSHA256,
  PARSER_VERSION,
} from '../../shared/programBParser.js';

// 公式番組表Bファイル 確定取込
// プレビューと同じファイルを再検証し、race_key/entry_keyで冪等upsertする。
// 全件成功時のみCOMPLETED + is_publishable=true。失敗時はFAILED。

const RACE_COMPARE_FIELDS = [
  'race_name', 'race_distance', 'deadline_time', 'series_title', 'series_day_number', 'venue_name',
];
const ENTRY_COMPARE_FIELDS = [
  'registration_number', 'racer_name', 'age', 'branch', 'weight', 'class',
  'national_win_rate', 'national_top2_rate', 'local_win_rate', 'local_top2_rate',
  'motor_number', 'motor_top2_rate', 'boat_number_official', 'boat_top2_rate',
  'series_results_raw', 'early_race_number',
];

function isSameRecord(existing, payload, fields) {
  for (const f of fields) {
    const a = existing[f] ?? null;
    const b = payload[f] ?? null;
    if (a !== b) return false;
  }
  return true;
}

// nullで既存の非null値を上書きしない更新ペイロードを構築する
function buildSafeUpdate(payload, existing) {
  const update = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null && existing[key] != null) continue;
    update[key] = value;
  }
  return update;
}

async function bulkChunked(base44, entityName, method, records, chunkSize = 400) {
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    await base44.asServiceRole.entities[entityName][method](chunk);
  }
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

    // ファイル取得
    const response = await fetch(file_url);
    if (!response.ok) {
      return Response.json({ status: 'error', message: `ファイル取得失敗: HTTP ${response.status}` }, { status: 502 });
    }
    const arrayBuffer = await response.arrayBuffer();
    const checksum = await computeSHA256(arrayBuffer);

    // checksum一致確認(プレビュー時と同じファイルか)
    if (expected_checksum && checksum !== expected_checksum) {
      return Response.json({
        status: 'error',
        message: 'チェックサム不一致: プレビュー時とファイルが異なります',
        checksum,
      }, { status: 400 });
    }

    // デコード・解析・検証
    const text = decodeShiftJIS(arrayBuffer);
    const parsed = parseProgramB(text, file_name);
    const validation = validateParseResult(parsed, file_name);

    if (!validation.is_importable) {
      return Response.json({
        status: 'error',
        message: '検証エラーのため取込を中止しました',
        errors: validation.fatal_errors,
        checksum,
        venue_count: parsed.venues.length,
        race_count: parsed.races.length,
        entry_count: parsed.entries.length,
      }, { status: 400 });
    }

    const sourceDate = parsed.source_date;
    if (!sourceDate) {
      return Response.json({ status: 'error', message: '開催日が特定できません' }, { status: 400 });
    }

    const batchKey = `PROGRAM_B_${sourceDate}_${checksum.substring(0, 12)}`;
    const now = new Date().toISOString();

    // 既存バッチ確認
    const existingBatches = await base44.asServiceRole.entities.OfficialImportBatchV2.filter(
      { batch_key }, '-completed_at', 5
    ).catch(() => []);

    if (existingBatches.length > 0 && existingBatches[0].status === 'COMPLETED') {
      return Response.json({
        status: 'already_imported',
        batch_key: batchKey,
        message: 'このファイルは既に取込済みです',
        checksum,
      });
    }

    // バッチ作成/更新(IMPORTING)
    let batchId;
    if (existingBatches.length > 0) {
      batchId = existingBatches[0].id;
      await base44.asServiceRole.entities.OfficialImportBatchV2.update(batchId, {
        status: 'IMPORTING',
        started_at: now,
        is_publishable: false,
        venue_count: parsed.venues.length,
        race_count: parsed.races.length,
        entry_count: parsed.entries.length,
        file_name,
        file_checksum_sha256: checksum,
        byte_size: arrayBuffer.byteLength,
        parser_version: PARSER_VERSION,
      });
    } else {
      const created = await base44.asServiceRole.entities.OfficialImportBatchV2.create({
        batch_key: batchKey,
        file_name,
        file_checksum_sha256: checksum,
        source_type: 'PROGRAM_B',
        source_date: sourceDate,
        encoding: 'shift_jis',
        byte_size: arrayBuffer.byteLength,
        status: 'IMPORTING',
        venue_count: parsed.venues.length,
        race_count: parsed.races.length,
        entry_count: parsed.entries.length,
        created_count: 0,
        updated_count: 0,
        unchanged_count: 0,
        error_count: 0,
        warning_count: validation.warnings.length,
        errors: [],
        warnings: validation.warnings,
        started_at: now,
        is_publishable: false,
        parser_version: PARSER_VERSION,
      });
      batchId = created.id;
    }

    // 既存Race/Entryを一括取得しマップ化(個別queryを回避)
    const existingRaces = await base44.asServiceRole.entities.OfficialRaceCoreV2.filter(
      { race_date: sourceDate }, 'race_number', 500
    ).catch(() => []);
    const existingRaceMap = {};
    for (const r of existingRaces) {
      if (!existingRaceMap[r.race_key]) existingRaceMap[r.race_key] = [];
      existingRaceMap[r.race_key].push(r);
    }

    const existingEntries = await base44.asServiceRole.entities.OfficialRaceEntryV2.filter(
      { race_date: sourceDate }, 'boat_number', 5000
    ).catch(() => []);
    const existingEntryMap = {};
    for (const e of existingEntries) {
      if (!existingEntryMap[e.entry_key]) existingEntryMap[e.entry_key] = [];
      existingEntryMap[e.entry_key].push(e);
    }

    // Race分類
    const racesToCreate = [];
    const racesToUpdate = [];
    let raceUnchanged = 0;
    let errorCount = 0;
    const errorDetails = [];

    for (const race of parsed.races) {
      const existing = existingRaceMap[race.race_key];
      if (existing && existing.length > 1) {
        errorCount++;
        errorDetails.push({ race_key: race.race_key, message: `race_key重複: ${existing.length}件存在(自動削除せず停止)` });
        continue;
      }
      const payload = {
        race_key: race.race_key,
        race_date: race.race_date,
        venue_code: race.venue_code,
        venue_name: race.venue_name,
        race_number: race.race_number,
        race_name: race.race_name,
        race_distance: race.race_distance,
        deadline_time: race.deadline_time,
        series_title: race.series_title,
        series_day_number: race.series_day_number,
        source_batch_key: batchKey,
        source_file_name: file_name,
        source_checksum: checksum,
        official_updated_at: now,
        record_status: 'VALID',
        parser_version: PARSER_VERSION,
      };
      if (!existing || existing.length === 0) {
        racesToCreate.push(payload);
      } else if (isSameRecord(existing[0], payload, RACE_COMPARE_FIELDS)) {
        raceUnchanged++;
      } else {
        const updateData = buildSafeUpdate(payload, existing[0]);
        updateData.id = existing[0].id;
        racesToUpdate.push(updateData);
      }
    }

    // Entry分類
    const entriesToCreate = [];
    const entriesToUpdate = [];
    let entryUnchanged = 0;

    for (const entry of parsed.entries) {
      const existing = existingEntryMap[entry.entry_key];
      if (existing && existing.length > 1) {
        errorCount++;
        errorDetails.push({ entry_key: entry.entry_key, message: `entry_key重複: ${existing.length}件存在(自動削除せず停止)` });
        continue;
      }
      const payload = {
        entry_key: entry.entry_key,
        race_key: entry.race_key,
        race_date: entry.race_date,
        venue_code: entry.venue_code,
        race_number: entry.race_number,
        boat_number: entry.boat_number,
        registration_number: entry.registration_number,
        racer_name: entry.racer_name,
        age: entry.age,
        branch: entry.branch,
        weight: entry.weight,
        class: entry.class,
        national_win_rate: entry.national_win_rate,
        national_top2_rate: entry.national_top2_rate,
        local_win_rate: entry.local_win_rate,
        local_top2_rate: entry.local_top2_rate,
        motor_number: entry.motor_number,
        motor_top2_rate: entry.motor_top2_rate,
        boat_number_official: entry.boat_number_official,
        boat_top2_rate: entry.boat_top2_rate,
        series_results_raw: entry.series_results_raw,
        early_race_number: entry.early_race_number,
        source_batch_key: batchKey,
        source_file_name: file_name,
        official_updated_at: now,
        record_status: 'VALID',
        parser_version: PARSER_VERSION,
      };
      if (!existing || existing.length === 0) {
        entriesToCreate.push(payload);
      } else if (isSameRecord(existing[0], payload, ENTRY_COMPARE_FIELDS)) {
        entryUnchanged++;
      } else {
        const updateData = buildSafeUpdate(payload, existing[0]);
        updateData.id = existing[0].id;
        entriesToUpdate.push(updateData);
      }
    }

    // DB書き込み(バルク・チャンク)
    let createdCount = 0, updatedCount = 0;
    try {
      if (racesToCreate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceCoreV2', 'bulkCreate', racesToCreate);
        createdCount += racesToCreate.length;
      }
      if (racesToUpdate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceCoreV2', 'bulkUpdate', racesToUpdate);
        updatedCount += racesToUpdate.length;
      }
      if (entriesToCreate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceEntryV2', 'bulkCreate', entriesToCreate);
        createdCount += entriesToCreate.length;
      }
      if (entriesToUpdate.length > 0) {
        await bulkChunked(base44, 'OfficialRaceEntryV2', 'bulkUpdate', entriesToUpdate);
        updatedCount += entriesToUpdate.length;
      }
    } catch (e) {
      errorCount++;
      errorDetails.push({ message: `DB書き込みエラー: ${e?.message || String(e)}` });
    }

    const unchangedCount = raceUnchanged + entryUnchanged;
    const completedAt = new Date().toISOString();

    if (errorCount === 0) {
      await base44.asServiceRole.entities.OfficialImportBatchV2.update(batchId, {
        status: 'COMPLETED',
        completed_at: completedAt,
        created_count: createdCount,
        updated_count: updatedCount,
        unchanged_count: unchangedCount,
        error_count: 0,
        is_publishable: true,
      });
    } else {
      await base44.asServiceRole.entities.OfficialImportBatchV2.update(batchId, {
        status: 'FAILED',
        completed_at: completedAt,
        created_count: createdCount,
        updated_count: updatedCount,
        unchanged_count: unchangedCount,
        error_count: errorCount,
        errors: errorDetails.slice(0, 100),
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
      entry_count: parsed.entries.length,
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
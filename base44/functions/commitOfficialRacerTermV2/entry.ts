import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  parseRacerTermFile,
  validateRacerTermResult,
  computeSHA256,
  PARSER_VERSION,
} from '../../shared/racerTermParser.js';
import { isSameRecord, buildSafeUpdate, bulkChunked } from '../../shared/importUtils.js';

// 公式選手期別成績ファイル 確定取込
// プレビューと同じファイルを再検証し、racer_term_keyで冪等upsertする。
// 全件成功時のみCOMPLETED。失敗時はFAILED。

const COMPARE_FIELDS = [
  'term_code', 'term_label', 'term_start_date', 'term_end_date',
  'registration_number', 'racer_name', 'racer_name_kana', 'branch', 'birthplace',
  'gender', 'age', 'weight', 'racer_class', 'previous_class',
  'win_rate', 'second_place_rate', 'third_place_rate', 'top2_rate', 'top3_rate',
  'average_start_timing', 'race_count', 'first_place_count', 'second_place_count',
  'third_place_count', 'start_accident_count', 'late_count', 'accident_rate',
  'ability_index', 'championship_entries', 'championship_wins',
];

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

    // checksum一致確認
    if (expected_checksum && checksum !== expected_checksum) {
      return Response.json({
        status: 'error',
        message: 'チェックサム不一致: プレビュー時とファイルが異なります',
        checksum,
      }, { status: 400 });
    }

    // 解析・検証
    const parsed = parseRacerTermFile(arrayBuffer, file_name);
    const validation = validateRacerTermResult(parsed, file_name);

    if (!validation.is_importable) {
      return Response.json({
        status: 'error',
        message: '検証エラーのため取込を中止しました',
        errors: validation.errors.slice(0, 50),
        checksum,
        term_code: validation.term_code,
        racer_count: validation.racer_count,
        error_count: validation.error_count,
      }, { status: 400 });
    }

    const termCode = validation.term_code;
    const batchKey = `${checksum.substring(0, 12)}_${PARSER_VERSION}`;
    const now = new Date().toISOString();

    // 既存バッチ確認
    const existingBatches = await base44.asServiceRole.entities.RacerTermImportBatchV2.filter(
      { batch_key: batchKey }, '-completed_at', 5
    ).catch(() => []);

    if (existingBatches.length > 0 && existingBatches[0].status === 'COMPLETED') {
      return Response.json({
        status: 'already_imported',
        batch_key: batchKey,
        message: 'このファイルは既に取込済みです',
        checksum,
        term_code: termCode,
      });
    }

    // バッチ作成/更新(IMPORTING)
    let batchId;
    const batchData = {
      source_file_name: file_name,
      source_checksum: checksum,
      term_code: termCode,
      term_label: validation.term_label,
      parser_version: PARSER_VERSION,
      encoding: 'shift_jis',
      file_size: arrayBuffer.byteLength,
      parsed_row_count: validation.racer_count,
      status: 'IMPORTING',
      started_at: now,
      errors: [],
    };

    if (existingBatches.length > 0) {
      batchId = existingBatches[0].id;
      await base44.asServiceRole.entities.RacerTermImportBatchV2.update(batchId, batchData);
    } else {
      const created = await base44.asServiceRole.entities.RacerTermImportBatchV2.create({
        batch_key: batchKey,
        ...batchData,
        inserted_count: 0,
        updated_count: 0,
        unchanged_count: 0,
        error_count: 0,
      });
      batchId = created.id;
    }

    // 既存RacerTermStatV2を一括取得
    const existingRecords = await base44.asServiceRole.entities.RacerTermStatV2.filter(
      { term_code: termCode }, 'registration_number', 5000
    ).catch(() => []);
    const existingMap = {};
    for (const r of existingRecords) {
      if (!existingMap[r.racer_term_key]) existingMap[r.racer_term_key] = [];
      existingMap[r.racer_term_key].push(r);
    }

    // 分類
    const toCreate = [];
    const toUpdate = [];
    let unchangedCount = 0;
    let errorCount = 0;
    const errorDetails = [];

    for (const racer of parsed.racers) {
      const existing = existingMap[racer.racer_term_key];
      if (existing && existing.length > 1) {
        errorCount++;
        errorDetails.push({
          racer_term_key: racer.racer_term_key,
          message: `racer_term_key重複: ${existing.length}件存在`,
        });
        continue;
      }

      const payload = {
        racer_term_key: racer.racer_term_key,
        term_code: racer.term_code,
        term_label: racer.term_label,
        term_start_date: racer.term_start_date,
        term_end_date: racer.term_end_date,
        registration_number: racer.registration_number,
        racer_name: racer.racer_name,
        racer_name_kana: racer.racer_name_kana,
        branch: racer.branch,
        birthplace: racer.birthplace,
        gender: racer.gender,
        age: racer.age,
        weight: racer.weight,
        racer_class: racer.racer_class,
        previous_class: racer.previous_class,
        win_rate: racer.win_rate,
        second_place_rate: racer.second_place_rate,
        third_place_rate: racer.third_place_rate,
        top2_rate: racer.top2_rate,
        top3_rate: racer.top3_rate,
        average_start_timing: racer.average_start_timing,
        race_count: racer.race_count,
        first_place_count: racer.first_place_count,
        second_place_count: racer.second_place_count,
        third_place_count: racer.third_place_count,
        start_accident_count: racer.start_accident_count,
        late_count: racer.late_count,
        accident_rate: racer.accident_rate,
        ability_index: racer.ability_index,
        championship_entries: racer.championship_entries,
        championship_wins: racer.championship_wins,
        source_file_name: file_name,
        source_checksum: checksum,
        parser_version: PARSER_VERSION,
        imported_at: now,
        raw_line: racer.raw_line,
      };

      if (!existing || existing.length === 0) {
        toCreate.push(payload);
      } else if (isSameRecord(existing[0], payload, COMPARE_FIELDS)) {
        unchangedCount++;
      } else {
        const updateData = buildSafeUpdate(payload, existing[0]);
        updateData.id = existing[0].id;
        toUpdate.push(updateData);
      }
    }

    // DB書き込み
    let insertedCount = 0, updatedCount = 0;
    try {
      if (toCreate.length > 0) {
        await bulkChunked(base44, 'RacerTermStatV2', 'bulkCreate', toCreate);
        insertedCount = toCreate.length;
      }
      if (toUpdate.length > 0) {
        await bulkChunked(base44, 'RacerTermStatV2', 'bulkUpdate', toUpdate);
        updatedCount = toUpdate.length;
      }
    } catch (e) {
      errorCount++;
      errorDetails.push({ message: `DB書き込みエラー: ${e?.message || String(e)}` });
    }

    const completedAt = new Date().toISOString();
    const finalErrorCount = errorCount + validation.error_count;

    if (finalErrorCount === 0) {
      await base44.asServiceRole.entities.RacerTermImportBatchV2.update(batchId, {
        status: 'COMPLETED',
        completed_at: completedAt,
        inserted_count: insertedCount,
        updated_count: updatedCount,
        unchanged_count: unchangedCount,
        error_count: 0,
      });
    } else {
      await base44.asServiceRole.entities.RacerTermImportBatchV2.update(batchId, {
        status: 'FAILED',
        completed_at: completedAt,
        inserted_count: insertedCount,
        updated_count: updatedCount,
        unchanged_count: unchangedCount,
        error_count: finalErrorCount,
        errors: errorDetails.slice(0, 100),
      });
    }

    return Response.json({
      status: finalErrorCount === 0 ? 'success' : 'partial_error',
      batch_key: batchKey,
      checksum,
      term_code: termCode,
      term_label: validation.term_label,
      racer_count: validation.racer_count,
      inserted_count: insertedCount,
      updated_count: updatedCount,
      unchanged_count: unchangedCount,
      error_count: finalErrorCount,
      errors: errorDetails.slice(0, 50),
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  parseRacerTermFile,
  validateRacerTermResult,
  computeSHA256,
  PARSER_VERSION,
} from '../../shared/racerTermParser.js';

// 公式選手期別成績ファイル プレビュー
// ファイルを解析・検証し、DBを一切更新せずに結果を返す。

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { file_url, file_name } = body;
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
    const batchKey = `${checksum.substring(0, 12)}_${PARSER_VERSION}`;

    // 解析
    const parsed = parseRacerTermFile(arrayBuffer, file_name);
    const validation = validateRacerTermResult(parsed, file_name);

    // 既存バッチ確認
    const existingBatches = await base44.asServiceRole.entities.RacerTermImportBatchV2.filter(
      { batch_key: batchKey }, '-completed_at', 5
    ).catch(() => []);

    const alreadyImported = existingBatches.length > 0 && existingBatches[0].status === 'COMPLETED';

    // エラー行の詳細（行番号・理由・原文）
    const errorDetails = validation.errors.slice(0, 50).map((e) => ({
      line: e.line,
      message: e.message,
      raw: e.raw || '',
    }));

    return Response.json({
      status: 'success',
      file_name,
      checksum,
      batch_key: batchKey,
      parser_version: PARSER_VERSION,
      encoding: validation.encoding,
      file_size: arrayBuffer.byteLength,
      term_code: validation.term_code,
      term_label: validation.term_label,
      term_start_date: validation.term_start_date,
      term_end_date: validation.term_end_date,
      line_count: parsed.line_count,
      racer_count: validation.racer_count,
      error_count: validation.error_count,
      warning_count: validation.warning_count,
      duplicate_reg_num_count: validation.duplicate_reg_num_count,
      has_mojibake: validation.has_mojibake,
      is_importable: validation.is_importable,
      already_imported: alreadyImported,
      existing_batch_key: alreadyImported ? existingBatches[0].batch_key : null,
      errors: errorDetails,
      warnings: validation.warnings.slice(0, 20),
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
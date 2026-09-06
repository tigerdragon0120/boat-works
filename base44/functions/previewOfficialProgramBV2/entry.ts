import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  decodeShiftJIS,
  parseProgramB,
  validateParseResult,
  computeSHA256,
  PARSER_VERSION,
} from '../../shared/programBParser.js';

// 公式番組表Bファイル プレビュー
// ファイルを取得・解析・検証し、DB書き込みせずにプレビュー結果を返す。
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

    // デコード・解析
    const text = decodeShiftJIS(arrayBuffer);
    const parsed = parseProgramB(text, file_name);
    const validation = validateParseResult(parsed, file_name);

    // 既存COMPLETEDバッチ確認(同checksum)
    const existingBatches = await base44.asServiceRole.entities.OfficialImportBatchV2.filter(
      { file_checksum_sha256: checksum, status: 'COMPLETED' },
      '-completed_at',
      5
    ).catch(() => []);
    const alreadyImported = existingBatches.length > 0;

    return Response.json({
      status: 'success',
      file_name,
      checksum,
      source_date: parsed.source_date,
      encoding: 'shift_jis',
      byte_size: arrayBuffer.byteLength,
      parser_version: PARSER_VERSION,
      venue_count: parsed.venues.length,
      race_count: parsed.races.length,
      entry_count: parsed.entries.length,
      venues: parsed.venues.map((v) => ({
        venue_code: v.venue_code,
        venue_name: v.venue_name,
        race_count: parsed.races.filter((r) => r.venue_code === v.venue_code).length,
        series_title: v.series_title,
        series_day_number: v.series_day_number,
      })),
      errors: validation.fatal_errors,
      warnings: validation.warnings,
      is_importable: validation.is_importable,
      already_imported: alreadyImported,
      existing_batch_key: alreadyImported ? existingBatches[0].batch_key : null,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
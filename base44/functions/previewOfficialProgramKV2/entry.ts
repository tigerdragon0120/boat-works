import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  decodeShiftJIS,
  parseProgramK,
  validateKParseResult,
  computeSHA256,
  K_PARSER_VERSION,
} from '../../shared/programKParser.js';

// 公式競走成績Kファイル プレビュー
// ファイルを取得・解析・検証し、DB書き込みせずにプレビュー結果を返す。
// B番組表(OfficialRaceCoreV2/OfficialRaceEntryV2)との照合も行う。
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

    const response = await fetch(file_url);
    if (!response.ok) {
      return Response.json({ status: 'error', message: `ファイル取得失敗: HTTP ${response.status}` }, { status: 502 });
    }
    const arrayBuffer = await response.arrayBuffer();
    const checksum = await computeSHA256(arrayBuffer);

    const text = decodeShiftJIS(arrayBuffer);
    const parsed = parseProgramK(text, file_name);
    const validation = validateKParseResult(parsed, file_name);

    const sourceDate = parsed.source_date;
    let bMatchCount = 0;
    let bMismatchCount = 0;
    let entryMismatchCount = 0;
    const bMismatchDetails = [];
    const entryMismatchDetails = [];

    if (sourceDate) {
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

      for (const race of parsed.races) {
        if (bRaceKeySet.has(race.race_key)) {
          bMatchCount++;
        } else {
          bMismatchCount++;
          bMismatchDetails.push({ race_key: race.race_key, message: 'B番組表未登録' });
        }
      }

      for (const entry of parsed.entry_results) {
        const bEntry = bEntryMap[entry.entry_key];
        if (!bEntry) continue;
        if (bEntry.registration_number !== entry.registration_number ||
            bEntry.boat_number !== entry.boat_number) {
          entryMismatchCount++;
          entryMismatchDetails.push({
            entry_key: entry.entry_key,
            k_registration: entry.registration_number,
            k_boat: entry.boat_number,
            b_registration: bEntry.registration_number,
            b_boat: bEntry.boat_number,
            message: '選手照合不一致',
          });
        }
      }
    }

    const criticalErrors = [...validation.fatal_errors];
    if (bMismatchCount > 0) {
      criticalErrors.push({ line: 0, severity: "FATAL", message: `B番組表未登録レース: ${bMismatchCount}件`, raw: "" });
    }
    if (entryMismatchCount > 0) {
      criticalErrors.push({ line: 0, severity: "ERROR", message: `選手照合不一致: ${entryMismatchCount}件`, raw: "" });
    }

    const existingBatches = await base44.asServiceRole.entities.OfficialResultImportBatchV2.filter(
      { file_hash: checksum, status: 'COMPLETED' }, '-completed_at', 5
    ).catch(() => []);
    const alreadyImported = existingBatches.length > 0;

    const isImportable = criticalErrors.length === 0 && validation.is_importable;

    return Response.json({
      status: 'success',
      file_name,
      checksum,
      source_date: sourceDate,
      encoding: 'shift_jis',
      byte_size: arrayBuffer.byteLength,
      parser_version: K_PARSER_VERSION,
      venue_count: parsed.venues.length,
      race_count: parsed.races.length,
      entry_result_count: parsed.entry_results.length,
      payout_count: parsed.payouts.length,
      b_match_count: bMatchCount,
      b_mismatch_count: bMismatchCount,
      entry_mismatch_count: entryMismatchCount,
      unparsed_line_count: parsed.unparsed_lines?.length || 0,
      unparsed_lines: (parsed.unparsed_lines || []).slice(0, 50),
      venues: parsed.venues.map((v) => ({
        venue_code: v.venue_code,
        venue_name: v.venue_name,
        race_count: parsed.races.filter((r) => r.venue_code === v.venue_code).length,
      })),
      errors: criticalErrors,
      warnings: validation.warnings,
      is_importable: isImportable,
      already_imported: alreadyImported,
      existing_batch_key: alreadyImported ? existingBatches[0].batch_key : null,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
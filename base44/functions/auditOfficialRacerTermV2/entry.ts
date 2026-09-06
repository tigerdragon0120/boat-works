import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 公式選手期別成績 監査
// 指定期のRacerTermStatV2レコード整合性を検証する。

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { term_code } = body;
    if (!term_code) {
      return Response.json({ status: 'error', message: 'term_codeが必要です' }, { status: 400 });
    }

    // データ取得
    const records = await base44.asServiceRole.entities.RacerTermStatV2.filter(
      { term_code }, 'registration_number', 5000
    ).catch(() => []);

    const batches = await base44.asServiceRole.entities.RacerTermImportBatchV2.filter(
      { term_code }, '-completed_at', 20
    ).catch(() => []);

    // 重複チェック
    const keySet = new Set();
    const keyDuplicates = [];
    const regNumMap = {};
    const regNumDuplicates = [];

    let missingRegNum = 0;
    let missingRacerName = 0;
    let missingTermCode = 0;
    let missingRacerClass = 0;
    let numericErrors = 0;
    const nameMismatches = [];

    for (const r of records) {
      // racer_term_key重複
      if (keySet.has(r.racer_term_key)) {
        keyDuplicates.push(r.racer_term_key);
      } else {
        keySet.add(r.racer_term_key);
      }

      // 登録番号欠落
      if (!r.registration_number) missingRegNum++;
      else {
        if (regNumMap[r.registration_number]) {
          regNumMap[r.registration_number].push(r);
          if (regNumMap[r.registration_number].length === 2) {
            regNumDuplicates.push(r.registration_number);
          }
        } else {
          regNumMap[r.registration_number] = [r];
        }
      }

      // 選手名欠落
      if (!r.racer_name) missingRacerName++;

      // 期コード欠落
      if (!r.term_code) missingTermCode++;

      // 級別欠落
      if (!r.racer_class) missingRacerClass++;

      // 数値変換エラー（必須数値項目がnull）
      if (r.win_rate == null || r.race_count == null || r.first_place_count == null) {
        numericErrors++;
      }
    }

    // 同一登録番号の氏名不一致
    for (const regNum of regNumDuplicates) {
      const group = regNumMap[regNum];
      const names = new Set(group.map((r) => r.racer_name));
      if (names.size > 1) {
        nameMismatches.push({
          registration_number: regNum,
          names: Array.from(names),
        });
      }
    }

    // 取込途中バッチ
    const stuckBatches = batches.filter((b) => b.status === 'IMPORTING');

    // 最新バッチ
    const completedBatches = batches.filter((b) => b.status === 'COMPLETED');
    const latestBatch = completedBatches[0] || null;

    const criticalErrors =
      keyDuplicates.length +
      missingRegNum +
      missingTermCode +
      numericErrors +
      stuckBatches.length;

    const overall = records.length === 0 ? 'EMPTY' : criticalErrors === 0 ? 'PASS' : 'FAIL';

    return Response.json({
      status: 'success',
      term_code,
      racer_count: records.length,
      racer_term_key_duplicates: keyDuplicates,
      missing_registration_number: missingRegNum,
      missing_racer_name: missingRacerName,
      missing_term_code: missingTermCode,
      missing_racer_class: missingRacerClass,
      numeric_conversion_errors: numericErrors,
      name_mismatches: nameMismatches,
      stuck_batches: stuckBatches.map((b) => ({ batch_key: b.batch_key, status: b.status })),
      latest_batch_file_name: latestBatch?.source_file_name || null,
      latest_parser_version: latestBatch?.parser_version || null,
      latest_batch_completed_at: latestBatch?.completed_at || null,
      overall,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
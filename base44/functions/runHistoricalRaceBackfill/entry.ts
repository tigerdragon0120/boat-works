import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  VENUE_JCDS_SORTED,
  getProgress,
  initProgress,
  updateProgress,
  backfillVenueDate,
  addDays,
  daysBetween,
} from '../../shared/historicalBackfill.js';

// BOAT WORKS 2002年〜現在 個別レース結果バックフィルエンジン
// 1回の呼び出しで1開催場・1日分を処理する(再開可能・冪等)
// 進捗はHistoricalBackfillProgressで管理され、最後に完了した地点から再開する

function jstDate(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const t0 = Date.now();

    // 手動モード: 特定日付・場を直接処理
    if (body.race_date && body.venue_code) {
      const jcd = String(body.venue_code).padStart(2, '0');
      const result = await backfillVenueDate(base44, body.race_date, jcd);
      return Response.json({
        status: result.errors.length === 0 ? 'success' : 'partial',
        mode: 'manual',
        race_date: body.race_date,
        venue_code: jcd,
        ...result,
        elapsed_ms: Date.now() - t0,
      });
    }

    // 自動モード: 進捗レコードから次の処理対象を決定
    let progress = await getProgress(base44);

    // 初回起動時は進捗レコードを初期化
    if (!progress) {
      const startDate = body.start_date || '2002-01-01';
      const endDate = body.end_date || jstDate(-1);
      progress = await initProgress(base44, startDate, endDate);
    }

    // statusチェック
    if (progress.status === 'PAUSED') {
      return Response.json({ status: 'paused', message: 'バックフィルは一時停止中です', progress });
    }
    if (progress.status === 'COMPLETED') {
      return Response.json({ status: 'completed', message: 'バックフィルは完了しています', progress });
    }

    // RUNNINGに設定(初回または再開時)
    if (progress.status !== 'RUNNING') {
      await updateProgress(base44, progress.id, {
        status: 'RUNNING',
        last_run_at: new Date().toISOString(),
        last_error: null,
      });
    }

    // 処理対象の日付と場インデックスを決定
    let currentDate = progress.current_processing_date || progress.target_start_date;
    let venueIndex = progress.current_venue_index || 0;

    // 終了判定: target_end_dateを超えていたらCOMPLETED
    if (currentDate > progress.target_end_date) {
      await updateProgress(base44, progress.id, {
        status: 'COMPLETED',
        last_run_at: new Date().toISOString(),
      });
      return Response.json({
        status: 'completed',
        message: '全期間のバックフィルが完了しました',
        progress: { ...progress, status: 'COMPLETED' },
      });
    }

    // 当日以降は処理しない(当日処理は既存ワークフローが担当)
    const today = jstDate(0);
    if (currentDate >= today) {
      await updateProgress(base44, progress.id, {
        status: 'COMPLETED',
        last_run_at: new Date().toISOString(),
        current_batch_label: `${currentDate} (当日以降・完了)`,
      });
      return Response.json({
        status: 'completed',
        message: '当日以降の日付に到達したためバックフィルを完了しました',
        progress: { ...progress, status: 'COMPLETED' },
      });
    }

    const jcd = VENUE_JCDS_SORTED[venueIndex];
    if (!jcd) {
      // 全場完了 → 次の日付へ
      const nextDate = addDays(currentDate, 1);
      const completedDates = (progress.completed_dates || 0) + 1;
      await updateProgress(base44, progress.id, {
        current_processing_date: nextDate,
        current_venue_index: 0,
        last_completed_date: currentDate,
        completed_dates: completedDates,
        current_batch_label: nextDate,
        last_run_at: new Date().toISOString(),
      });
      return Response.json({
        status: 'date_complete',
        race_date: currentDate,
        next_date: nextDate,
        completed_dates: completedDates,
        total_target_days: progress.total_target_days,
        elapsed_ms: Date.now() - t0,
      });
    }

    // 1開催場・1日分を処理
    let result;
    try {
      result = await backfillVenueDate(base44, currentDate, jcd);
    } catch (e) {
      result = { races: 0, racerResults: 0, errors: [{ phase: 'venue', message: e?.message || String(e) }], skipped: 0 };
    }

    // 進捗更新
    const newRaceCount = (progress.processed_race_count || 0) + result.races;
    const newRacerResultCount = (progress.processed_racer_result_count || 0) + result.racerResults;
    const newSuccess = (progress.success_count || 0) + (result.errors.length === 0 ? 1 : 0);
    const newFailure = (progress.failure_count || 0) + (result.errors.length > 0 ? 1 : 0);
    const newSkip = (progress.skip_count || 0) + result.skipped;

    // エラー記録(最大50件まで保持)
    let errorDates = progress.error_dates || [];
    if (result.errors.length > 0) {
      errorDates.push({
        date: currentDate,
        venue_code: jcd,
        message: result.errors[0]?.message || 'unknown',
        attempts: 1,
        timestamp: new Date().toISOString(),
      });
      errorDates = errorDates.slice(-50);
    }

    const nextVenueIndex = venueIndex + 1;
    await updateProgress(base44, progress.id, {
      current_venue_index: nextVenueIndex,
      processed_race_count: newRaceCount,
      processed_racer_result_count: newRacerResultCount,
      success_count: newSuccess,
      failure_count: newFailure,
      skip_count: newSkip,
      last_run_at: new Date().toISOString(),
      last_error: result.errors.length > 0 ? `${currentDate}_${jcd}: ${result.errors[0]?.message}` : null,
      error_dates: errorDates,
      current_batch_label: `${currentDate}_${jcd}`,
    });

    return Response.json({
      status: result.errors.length === 0 ? 'success' : 'partial',
      mode: 'auto',
      race_date: currentDate,
      venue_code: jcd,
      venue_index: venueIndex,
      next_venue_index: nextVenueIndex,
      races_saved: result.races,
      racer_results_saved: result.racerResults,
      errors: result.errors.slice(0, 10),
      skipped: result.skipped,
      cumulative: {
        processed_race_count: newRaceCount,
        processed_racer_result_count: newRacerResultCount,
        success_count: newSuccess,
        failure_count: newFailure,
        skip_count: newSkip,
        completed_dates: progress.completed_dates || 0,
        total_target_days: progress.total_target_days,
      },
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
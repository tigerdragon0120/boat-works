import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  getProgress,
  initProgress,
  updateProgress,
  preFlightCheck,
  backfillIncrementalDate,
  computeETA,
  recalculateCompletedDates,
  cleanupDuplicateDayStatus,
} from '../../shared/historicalBackfill.js';

// バックフィル操作関数(高速化版対応)
// action: start | pause | resume | stop | retry_errors | view_errors | status | incremental | preflight | reset_metrics

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
    const action = body.action || 'status';

    let progress = await getProgress(base44);

    switch (action) {
      case 'start': {
        const preFlight = await preFlightCheck(base44);
        if (!preFlight.passed) {
          const failedChecks = preFlight.checks.filter(c => !c.passed);
          return Response.json({
            status: 'error',
            action: 'start',
            message: 'プレフライトチェック失敗',
            pre_flight: preFlight,
            failed_checks: failedChecks,
          }, { status: 400 });
        }

        const startDate = body.start_date || '2002-01-01';
        const endDate = body.end_date || jstDate(-1);

        if (!progress) {
          progress = await initProgress(base44, startDate, endDate);
        } else {
          const currentPos = progress.current_processing_date || startDate;
          const alreadyAdvanced = currentPos > startDate;
          await updateProgress(base44, progress.id, {
            target_start_date: startDate,
            target_end_date: endDate,
            status: 'RUNNING',
            last_run_at: new Date().toISOString(),
            last_error: null,
            worker_heartbeat: null,
            ...(alreadyAdvanced ? {} : {
              current_processing_date: startDate,
              current_venue_index: 0,
              current_venue_list: [],
              current_venue_position: 0,
            }),
          });
        }
        return Response.json({
          status: 'success',
          action: 'start',
          message: 'プレフライトチェック合格・バックフィルを開始しました',
          pre_flight: preFlight,
          progress: { ...progress, status: 'RUNNING', target_start_date: startDate, target_end_date: endDate },
        });
      }

      case 'pause': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        await updateProgress(base44, progress.id, {
          status: 'PAUSED',
          last_run_at: new Date().toISOString(),
          worker_heartbeat: null,
        });
        return Response.json({
          status: 'success',
          action: 'pause',
          message: 'バックフィルを一時停止しました',
          progress: { ...progress, status: 'PAUSED' },
        });
      }

      case 'resume': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        await updateProgress(base44, progress.id, {
          status: 'RUNNING',
          last_run_at: new Date().toISOString(),
          last_error: null,
          worker_heartbeat: null,
        });
        return Response.json({
          status: 'success',
          action: 'resume',
          message: `バックフィルを再開しました(${progress.current_processing_date} ${progress.current_venue_list?.length || 0}場中${progress.current_venue_position || 0}場目から)`,
          progress: { ...progress, status: 'RUNNING' },
        });
      }

      case 'stop': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        await updateProgress(base44, progress.id, {
          status: 'IDLE',
          last_run_at: new Date().toISOString(),
          worker_heartbeat: null,
        });
        return Response.json({
          status: 'success',
          action: 'stop',
          message: 'バックフィルを停止しました(進捗は保持・Startで再開)',
          progress: { ...progress, status: 'IDLE' },
        });
      }

      case 'retry_errors': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        const errorDates = progress.error_dates || [];
        const retryable = errorDates.filter(e => (e.attempts || 0) < 3);
        const permanent = errorDates.filter(e => (e.attempts || 0) >= 3);

        await updateProgress(base44, progress.id, {
          error_dates: permanent,
          last_error: null,
          status: 'RUNNING',
          last_run_at: new Date().toISOString(),
          consecutive_errors: 0,
          worker_heartbeat: null,
        });
        return Response.json({
          status: 'success',
          action: 'retry_errors',
          message: `エラー記録をクリアして再開しました(再試行対象${retryable.length}件・恒久エラー${permanent.length}件)`,
          progress: { ...progress, error_dates: permanent, status: 'RUNNING' },
          retryable_count: retryable.length,
          permanent_count: permanent.length,
        });
      }

      case 'view_errors': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        const errorDates = progress.error_dates || [];
        return Response.json({
          status: 'success',
          action: 'view_errors',
          error_dates: errorDates,
          total_errors: errorDates.length,
          retryable: errorDates.filter(e => (e.attempts || 0) < 3).length,
          permanent: errorDates.filter(e => (e.attempts || 0) >= 3).length,
        });
      }

      case 'incremental': {
        const targetDate = body.race_date || jstDate(-1);
        const result = await backfillIncrementalDate(base44, targetDate);
        return Response.json({
          status: 'success',
          action: 'incremental',
          race_date: targetDate,
          races_added: result.races,
          racer_results_added: result.racerResults,
          venues_processed: result.venues_processed,
          venues_skipped: result.venues_skipped,
          errors: result.errors.slice(0, 20),
        });
      }

      case 'preflight': {
        const preFlight = await preFlightCheck(base44);
        return Response.json({
          status: preFlight.passed ? 'success' : 'error',
          action: 'preflight',
          pre_flight: preFlight,
        });
      }

      case 'reset_metrics': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        await updateProgress(base44, progress.id, {
          consecutive_errors: 0,
          consecutive_successes: 0,
          recent_durations: [],
          average_venue_duration_ms: null,
          phase: 1,
        });
        return Response.json({
          status: 'success',
          action: 'reset_metrics',
          message: 'パフォーマンス指標をリセットしました(Phase 1に戻ります)',
          progress: { ...progress, consecutive_errors: 0, phase: 1 },
        });
      }

      case 'recalculate': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        // DBから実データを再計算
        const completedDates = await recalculateCompletedDates(base44);
        
        // processed_race_count, processed_racer_result_countも再計算
        const raceCountResult = await base44.asServiceRole.entities.HistoricalRaceResult.list(1).catch(() => ({ total: 0 }));
        const racerResultCountResult = await base44.asServiceRole.entities.HistoricalRacerResult.list(1).catch(() => ({ total: 0 }));
        
        // 全件取得はできないため、DayStatusから集計
        let totalRaces = 0;
        let totalRacerResults = 0;
        let skip = 0;
        while (true) {
          const batch = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.filter(
            { status: { $in: ['COMPLETED', 'PARTIAL'] } }, 'race_date', 500, skip
          ).catch(() => []);
          if (batch.length === 0) break;
          for (const ds of batch) {
            totalRaces += ds.race_count || 0;
            totalRacerResults += ds.racer_result_count || 0;
          }
          skip += batch.length;
          if (batch.length < 500) break;
        }
        
        await updateProgress(base44, progress.id, {
          completed_dates: completedDates,
          processed_race_count: totalRaces,
          processed_racer_result_count: totalRacerResults,
          updated_at: new Date().toISOString(),
        });
        
        return Response.json({
          status: 'success',
          action: 'recalculate',
          message: `進捗を再計算しました: completed_dates=${completedDates}, races=${totalRaces}, racer_results=${totalRacerResults}`,
          progress: { ...progress, completed_dates: completedDates, processed_race_count: totalRaces, processed_racer_result_count: totalRacerResults },
        });
      }

      case 'cleanup_duplicates': {
        const result = await cleanupDuplicateDayStatus(base44);
        return Response.json({
          status: 'success',
          action: 'cleanup_duplicates',
          message: `DayStatus重複をクリーンアップしました: ${result.deleted_count}件削除`,
          ...result,
        });
      }

      case 'rollback': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });

        // 事故防止: 通常の修正・再検証では本線カーソルを巻き戻さない。
        // 明示的に force=true が指定された管理操作だけを許可する。
        if (body.force !== true) {
          return Response.json({
            status: 'blocked',
            action: 'rollback',
            message: '本線バックフィルの巻き戻しを安全装置が拒否しました。修正・再検証は現在位置を維持したまま行ってください。どうしても巻き戻す場合のみ force=true を明示してください。',
            progress: {
              current_processing_date: progress.current_processing_date,
              current_venue_position: progress.current_venue_position || 0,
              status: progress.status,
              completed_dates: progress.completed_dates || 0,
            },
          }, { status: 409 });
        }

        const targetDate = body.target_date || progress.current_processing_date;
        await updateProgress(base44, progress.id, {
          current_processing_date: targetDate,
          current_venue_list: [],
          current_venue_position: 0,
          status: 'IDLE',
          worker_heartbeat: null,
          last_error: null,
          consecutive_errors: 0,
          current_batch_label: `${targetDate} (FORCED_ROLLBACK)`,
          updated_at: new Date().toISOString(),
        });
        return Response.json({
          status: 'success',
          action: 'rollback',
          message: `強制指定により進捗を${targetDate}に巻き戻しました。既存Historicalデータは削除していません。`,
          progress: { ...progress, current_processing_date: targetDate, status: 'IDLE' },
        });
      }

      case 'status':
      default: {
        if (!progress) {
          return Response.json({
            status: 'success',
            action: 'status',
            progress: { message: '進捗レコードがありません。startで初期化してください。' },
          });
        }
        const eta = computeETA(progress);
        return Response.json({
          status: 'success',
          action: 'status',
          progress: { ...progress, ...eta },
        });
      }
    }
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
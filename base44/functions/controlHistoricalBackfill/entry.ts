import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getProgress, initProgress, updateProgress, preFlightCheck, backfillIncrementalDate } from '../../shared/historicalBackfill.js';

// バックフィル操作関数: 開始・一時停止・再開・停止・エラー再試行・エラー確認・ステータス
// action: start | pause | resume | stop | retry_errors | view_errors | status | incremental

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
        // プレフライトチェック: 全条件を満たす場合のみRUNNINGへ移行
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
          // 既存進捗がある場合:
          // - current_processing_dateが既に進んでいる場合はそのまま続き
          // - まだ初期位置の場合は日付範囲のみ更新
          const currentPos = progress.current_processing_date || startDate;
          const alreadyAdvanced = currentPos > startDate;
          await updateProgress(base44, progress.id, {
            target_start_date: startDate,
            target_end_date: endDate,
            status: 'RUNNING',
            last_run_at: new Date().toISOString(),
            last_error: null,
            // 既に進んでいる場合はcurrent_processing_dateをリセットしない
            ...(alreadyAdvanced ? {} : { current_processing_date: startDate, current_venue_index: 0 }),
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
        // 現在処理中の1単位が完了した後に安全に停止(次回呼び出し時にPAUSEDを検知してスキップ)
        await updateProgress(base44, progress.id, {
          status: 'PAUSED',
          last_run_at: new Date().toISOString(),
        });
        return Response.json({
          status: 'success',
          action: 'pause',
          message: 'バックフィルを一時停止しました(現在処理中の1単位完了後に停止)',
          progress: { ...progress, status: 'PAUSED' },
        });
      }

      case 'resume': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        // current_processing_dateとcurrent_venue_indexから続きを開始(2002年に戻らない)
        await updateProgress(base44, progress.id, {
          status: 'RUNNING',
          last_run_at: new Date().toISOString(),
          last_error: null,
        });
        return Response.json({
          status: 'success',
          action: 'resume',
          message: `バックフィルを再開しました(${progress.current_processing_date}_${progress.current_venue_index}から)`,
          progress: { ...progress, status: 'RUNNING' },
        });
      }

      case 'stop': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        // Stop = IDLEに設定(進捗は保持・Resume時はStartで再開)
        await updateProgress(base44, progress.id, {
          status: 'IDLE',
          last_run_at: new Date().toISOString(),
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
        // エラー日付リストをクリアして再実行可能にする
        // attemptsが3以上の対象は自動再試行対象外
        const errorDates = progress.error_dates || [];
        const retryable = errorDates.filter(e => (e.attempts || 0) < 3);
        const permanent = errorDates.filter(e => (e.attempts || 0) >= 3);

        await updateProgress(base44, progress.id, {
          error_dates: permanent,
          last_error: null,
          status: 'RUNNING',
          last_run_at: new Date().toISOString(),
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
        // 日次差分更新: 指定日付(デフォルト前日)の未登録レース結果を補完
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

      case 'status':
      default: {
        return Response.json({
          status: 'success',
          action: 'status',
          progress: progress || { message: '進捗レコードがありません。startで初期化してください。' },
        });
      }
    }
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getProgress, initProgress, updateProgress } from '../../shared/historicalBackfill.js';

// バックフィル操作関数: 開始・一時停止・再開・エラー再試行・リセット
// action: start | pause | resume | retry_errors | reset | status

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
        const startDate = body.start_date || '2002-01-01';
        const endDate = body.end_date || jstDate(-1);
        if (!progress) {
          progress = await initProgress(base44, startDate, endDate);
        } else {
          // 既存進捗の日付範囲を更新
          await updateProgress(base44, progress.id, {
            target_start_date: startDate,
            target_end_date: endDate,
            status: 'RUNNING',
            last_run_at: new Date().toISOString(),
            last_error: null,
          });
        }
        return Response.json({
          status: 'success',
          action: 'start',
          message: 'バックフィルを開始しました',
          progress: { ...progress, status: 'RUNNING', target_start_date: startDate, target_end_date: endDate },
        });
      }

      case 'pause': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        await updateProgress(base44, progress.id, {
          status: 'PAUSED',
          last_run_at: new Date().toISOString(),
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
        });
        return Response.json({
          status: 'success',
          action: 'resume',
          message: 'バックフィルを再開しました',
          progress: { ...progress, status: 'RUNNING' },
        });
      }

      case 'retry_errors': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        // エラー日付リストをクリアして再実行可能にする
        await updateProgress(base44, progress.id, {
          error_dates: [],
          last_error: null,
          status: 'RUNNING',
          last_run_at: new Date().toISOString(),
        });
        return Response.json({
          status: 'success',
          action: 'retry_errors',
          message: 'エラー記録をクリアして再開しました',
          progress: { ...progress, error_dates: [], status: 'RUNNING' },
        });
      }

      case 'reset': {
        if (!progress) return Response.json({ status: 'error', message: '進捗レコードがありません' }, { status: 400 });
        // 進捗リセット(データは削除しない・最初から取り直すわけではない)
        // current_processing_dateをtarget_start_dateに戻すだけ
        await updateProgress(base44, progress.id, {
          current_processing_date: progress.target_start_date,
          current_venue_index: 0,
          last_completed_date: null,
          processed_race_count: 0,
          processed_racer_result_count: 0,
          success_count: 0,
          failure_count: 0,
          skip_count: 0,
          completed_dates: 0,
          error_dates: [],
          last_error: null,
          status: 'IDLE',
          current_batch_label: progress.target_start_date,
          last_run_at: new Date().toISOString(),
        });
        return Response.json({
          status: 'success',
          action: 'reset',
          message: '進捗をリセットしました(保存済みデータは保持)',
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
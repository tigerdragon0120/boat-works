import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  getProgress,
  initProgress,
  updateProgress,
  getOrCreateDayStatus,
  updateDayStatus,
  checkVenueDayComplete,
  acquireVenueLock,
  releaseVenueLock,
  determineMode,
  computeAdaptiveBatchSize,
  updatePerformanceMetrics,
  computeETA,
  backfillVenueDate,
  backfillIncrementalDate,
  addDays,
  preFlightCheck,
  checkDailyPriority,
} from '../../shared/historicalBackfill.js';

// BOAT WORKS 2002年〜現在 個別レース結果バックフィルエンジン(高速化版)
// 
// 高速化設計:
// - 1 invocation = 複数venue-day(Adaptive Batch)
// - 開催場のみ取得(24場総当たり廃止)
// - 夜間Turbo Mode(00:30-05:00 JST)
// - Cursor方式(current_venue_list + current_venue_position)
// - SKIP_COMPLETE(既存データ完全なら再取得省略)
// - Processing Lock(同一venue-day同時処理防止)
// - タイムバジェット(45s超過でcheckpoint保存)
// - 段階的Phase高速化(Phase1→2→3)
// - Safety Brake(エラー急増で自動減速)

const TIME_BUDGET_MS = 45000; // 45秒
const HEARTBEAT_TTL_MS = 50000; // 50秒(同時実行防止)

function jstDate(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function generateWorkerId() {
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

    // === 手動モード: 特定日付・場を直接処理 ===
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

    // === 自動モード: Adaptive Batch処理 ===
    let progress = await getProgress(base44);

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
    if (progress.status === 'ERROR') {
      return Response.json({ status: 'error_stopped', message: 'バックフィルはエラー停止中です。retry_errorsで再開', progress });
    }
    if (progress.status === 'IDLE') {
      return Response.json({ status: 'idle', message: 'バックフィルは未開始です。controlHistoricalBackfillでstartしてください', progress });
    }
    if (progress.status !== 'RUNNING') {
      return Response.json({ status: 'skipped', message: `status=${progress.status}のため処理スキップ`, progress });
    }

    // === Heartbeat mutex(同時実行防止) ===
    const heartbeatAge = progress.worker_heartbeat
      ? Date.now() - new Date(progress.worker_heartbeat).getTime()
      : Infinity;
    if (heartbeatAge < HEARTBEAT_TTL_MS) {
      return Response.json({
        status: 'skipped_heartbeat',
        message: `別ワーカー実行中(heartbeat ${Math.round(heartbeatAge / 1000)}s前)`,
        progress,
        elapsed_ms: Date.now() - t0,
      });
    }

    // === モード判定 ===
    const mode = determineMode();

    // === 通常収集優先ガード ===
    const priority = await checkDailyPriority(base44);
    if (priority.busy) {
      const eta = computeETA(progress);
      await updateProgress(base44, progress.id, {
        current_mode: 'DEFERRED',
        last_run_at: new Date().toISOString(),
        ...eta,
      });
      return Response.json({
        status: 'deferred',
        message: `通常収集優先: ${priority.reason}のため今回スキップ`,
        mode: 'DEFERRED',
        progress: { ...progress, current_mode: 'DEFERRED' },
        priority,
        elapsed_ms: Date.now() - t0,
      });
    }

    // === Adaptive Batch Size計算 ===
    const batchSize = computeAdaptiveBatchSize(progress, mode);
    const workerId = generateWorkerId();

    // Heartbeat更新
    await updateProgress(base44, progress.id, {
      worker_heartbeat: new Date().toISOString(),
      current_mode: mode,
      current_batch_size: batchSize,
      last_run_at: new Date().toISOString(),
    });

    // === バッチ処理ループ ===
    let processed = 0;
    let totalRaces = 0;
    let totalRacerResults = 0;
    let totalErrors = [];
    let totalMissingBoats = 0;
    let skipCompleteCount = 0;
    let hadAnyError = false;
    let hadAnyMissingBoats = false;
    let currentDate = progress.current_processing_date;
    let venueList = progress.current_venue_list || [];
    let venuePos = progress.current_venue_position || 0;
    let datesCompleted = 0;

    while (processed < batchSize) {
      // === タイムバジェットチェック ===
      const elapsed = Date.now() - t0;
      if (elapsed > TIME_BUDGET_MS) {
        break; // 時間上限到達 → checkpoint保存して終了
      }

      // === 当日以降処理ガード ===
      const today = jstDate(0);
      if (currentDate >= today) {
        await updateProgress(base44, progress.id, {
          status: 'COMPLETED',
          current_batch_label: `${currentDate} (当日以降・完了)`,
          last_run_at: new Date().toISOString(),
        });
        return Response.json({
          status: 'completed',
          message: '当日以降の日付に到達したためバックフィルを完了しました',
          mode,
          batch_size: batchSize,
          processed_venue_days: processed,
          elapsed_ms: Date.now() - t0,
        });
      }

      // === 終了判定 ===
      if (currentDate > progress.target_end_date) {
        await updateProgress(base44, progress.id, {
          status: 'COMPLETED',
          last_run_at: new Date().toISOString(),
        });
        return Response.json({
          status: 'completed',
          message: '全期間のバックフィルが完了しました',
          mode,
          batch_size: batchSize,
          processed_venue_days: processed,
          elapsed_ms: Date.now() - t0,
        });
      }

      // === 開催場リスト取得(キャッシュ) ===
      if (!venueList || venueList.length === 0) {
        let dayStatus;
        try {
          dayStatus = await getOrCreateDayStatus(base44, currentDate);
        } catch (e) {
          // 開催場一覧取得失敗 → エラー記録して次の日付へ
          totalErrors.push({ phase: 'day_status', date: currentDate, message: e?.message || String(e) });
          hadAnyError = true;
          const nextDate = addDays(currentDate, 1);
          currentDate = nextDate;
          venueList = [];
          venuePos = 0;
          datesCompleted++;
          await updateProgress(base44, progress.id, {
            current_processing_date: nextDate,
            current_venue_list: [],
            current_venue_position: 0,
            completed_dates: (progress.completed_dates || 0) + 1,
            current_batch_label: nextDate,
          });
          progress.completed_dates = (progress.completed_dates || 0) + 1;
          continue;
        }

        if (dayStatus.status === 'NO_RACE') {
          // 開催なし日(NO_RACE_CONFIRMED) → 即日完了(24場調査しない)
          const nextDate = addDays(currentDate, 1);
          datesCompleted++;
          currentDate = nextDate;
          venueList = [];
          venuePos = 0;
          await updateProgress(base44, progress.id, {
            current_processing_date: nextDate,
            current_venue_list: [],
            current_venue_position: 0,
            completed_dates: (progress.completed_dates || 0) + 1,
            last_completed_date: addDays(currentDate, -1),
            current_batch_label: `${addDays(currentDate, -1)} (NO_RACE)`,
          });
          progress.completed_dates = (progress.completed_dates || 0) + 1;
          continue;
        }

        if (dayStatus.status === 'UNKNOWN') {
          // 開催場一覧取得失敗(UNKNOWN) → completed_datesに含めず次へ(後で再調査)
          const nextDate = addDays(currentDate, 1);
          currentDate = nextDate;
          venueList = [];
          venuePos = 0;
          await updateProgress(base44, progress.id, {
            current_processing_date: nextDate,
            current_venue_list: [],
            current_venue_position: 0,
            current_batch_label: `${currentDate} (UNKNOWN)`,
          });
          continue;
        }

        if (dayStatus.status === 'COMPLETED' || dayStatus.status === 'PARTIAL') {
          // 既に完了日 → 次の日付へ
          const nextDate = addDays(currentDate, 1);
          datesCompleted++;
          currentDate = nextDate;
          venueList = [];
          venuePos = 0;
          await updateProgress(base44, progress.id, {
            current_processing_date: nextDate,
            current_venue_list: [],
            current_venue_position: 0,
            completed_dates: (progress.completed_dates || 0) + 1,
            current_batch_label: nextDate,
          });
          progress.completed_dates = (progress.completed_dates || 0) + 1;
          continue;
        }

        venueList = dayStatus.venue_codes || [];
        venuePos = 0;
        await updateProgress(base44, progress.id, {
          current_venue_list: venueList,
          current_venue_position: 0,
          current_batch_label: `${currentDate}_venue_list`,
        });
      }

      // === 全場完了チェック ===
      if (venuePos >= venueList.length) {
        // この日の全場完了 → 次の日付へ
        const nextDate = addDays(currentDate, 1);
        datesCompleted++;
        const dayStatusRecords = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.filter(
          { race_date: currentDate }, '-updated_date', 1
        ).catch(() => []);
        if (dayStatusRecords.length > 0) {
          await updateDayStatus(base44, dayStatusRecords[0].id, {
            status: 'COMPLETED',
            completed_at: new Date().toISOString(),
          });
        }
        currentDate = nextDate;
        venueList = [];
        venuePos = 0;
        await updateProgress(base44, progress.id, {
          current_processing_date: nextDate,
          current_venue_list: [],
          current_venue_position: 0,
          completed_dates: (progress.completed_dates || 0) + 1,
          last_completed_date: addDays(nextDate, -1),
          current_batch_label: nextDate,
        });
        progress.completed_dates = (progress.completed_dates || 0) + 1;
        continue;
      }

      // === 対象venue-day取得 ===
      const jcd = venueList[venuePos];

      // === SKIP_COMPLETE判定 ===
      let skipComplete = false;
      try {
        const completeness = await checkVenueDayComplete(base44, currentDate, jcd);
        if (completeness.complete) {
          skipComplete = true;
          skipCompleteCount++;
        }
      } catch {
        // 完全性チェック失敗 → 安全側で処理続行
      }

      if (skipComplete) {
        // 既存データ完全 → 再取得スキップ
        venuePos++;
        await updateProgress(base44, progress.id, {
          current_venue_position: venuePos,
          skip_complete_count: (progress.skip_complete_count || 0) + 1,
        });
        progress.skip_complete_count = (progress.skip_complete_count || 0) + 1;
        continue;
      }

      // === Processing Lock取得 ===
      let lockResult;
      try {
        lockResult = await acquireVenueLock(base44, currentDate, jcd, workerId);
      } catch (e) {
        totalErrors.push({ phase: 'lock', date: currentDate, venue: jcd, message: e?.message || String(e) });
        hadAnyError = true;
        venuePos++;
        continue;
      }

      if (!lockResult.acquired) {
        // Lock取得失敗(別ワーカーが処理中) → 次へ
        venuePos++;
        continue;
      }

      // === venue-day処理 ===
      const vdStart = Date.now();
      let result;
      try {
        result = await backfillVenueDate(base44, currentDate, jcd);
      } catch (e) {
        result = {
          races: 0,
          racerResults: 0,
          errors: [{ phase: 'venue', message: e?.message || String(e) }],
          skipped: 0,
          missingBoatsRaces: [],
        };
      }
      const vdDuration = Date.now() - vdStart;

      // === Lock解除 ===
      try {
        await releaseVenueLock(base44, currentDate, jcd, result);
      } catch {}

      totalRaces += result.races || 0;
      totalRacerResults += result.racerResults || 0;
      processed++;

      const venueHadError = (result.errors?.length || 0) > 0;
      const venueHadMissingBoats = (result.missingBoatsRaces?.length || 0) > 0;

      if (venueHadError) {
        hadAnyError = true;
        totalErrors.push(...(result.errors || []).map(e => ({ ...e, date: currentDate, venue: jcd })));
      }
      if (venueHadMissingBoats) {
        hadAnyMissingBoats = true;
        totalMissingBoats += result.missingBoatsRaces.length;
      }

      // === パフォーマンス指標更新 ===
      const metrics = updatePerformanceMetrics(progress, vdDuration, venueHadError, venueHadMissingBoats);

      // === エラー記録(最大50件) ===
      let errorDates = progress.error_dates || [];
      if (venueHadError) {
        const existingErr = errorDates.find(e => e.date === currentDate && e.venue_code === jcd);
        if (existingErr) {
          existingErr.attempts = (existingErr.attempts || 0) + 1;
          existingErr.message = result.errors[0]?.message || 'unknown';
          existingErr.timestamp = new Date().toISOString();
        } else {
          errorDates.push({
            date: currentDate,
            venue_code: jcd,
            message: result.errors[0]?.message || 'unknown',
            attempts: 1,
            timestamp: new Date().toISOString(),
          });
        }
        errorDates = errorDates.slice(-50);
      }

      // === Progress更新 ===
      const newRaceCount = (progress.processed_race_count || 0) + (result.races || 0);
      const newRacerResultCount = (progress.processed_racer_result_count || 0) + (result.racerResults || 0);
      const newSuccess = (progress.success_count || 0) + (venueHadError ? 0 : 1);
      const newFailure = (progress.failure_count || 0) + (venueHadError ? 1 : 0);

      venuePos++;

      const progressFields = {
        current_venue_position: venuePos,
        processed_race_count: newRaceCount,
        processed_racer_result_count: newRacerResultCount,
        success_count: newSuccess,
        failure_count: newFailure,
        skip_count: (progress.skip_count || 0) + (result.skipped || 0),
        last_run_at: new Date().toISOString(),
        last_error: venueHadError ? `${currentDate}_${jcd}: ${result.errors[0]?.message}` : null,
        error_dates: errorDates,
        current_batch_label: `${currentDate}_${jcd}`,
        worker_heartbeat: new Date().toISOString(),
        ...metrics,
      };

      await updateProgress(base44, progress.id, progressFields);

      // ローカルのprogressも更新(次イテレーション用)
      progress = { ...progress, ...progressFields };

      // === Safety Brake: 連続エラー3回以上でPAUSED ===
      if (metrics.consecutive_errors >= 5) {
        await updateProgress(base44, progress.id, {
          status: 'PAUSED',
          last_error: `Safety Brake: 連続エラー${metrics.consecutive_errors}回で自動一時停止`,
        });
        return Response.json({
          status: 'safety_brake',
          message: `Safety Brake発動: 連続エラー${metrics.consecutive_errors}回で自動一時停止`,
          mode,
          batch_size: batchSize,
          processed_venue_days: processed,
          races_saved: totalRaces,
          racer_results_saved: totalRacerResults,
          errors: totalErrors.slice(0, 10),
          elapsed_ms: Date.now() - t0,
        });
      }
    }

    // === ETA計算 ===
    const eta = computeETA(progress);
    await updateProgress(base44, progress.id, {
      ...eta,
      worker_heartbeat: null, // 処理完了 → heartbeatクリア
    });

    return Response.json({
      status: totalErrors.length === 0 ? 'success' : 'partial',
      mode,
      batch_size: batchSize,
      phase: progress.phase || 1,
      processed_venue_days: processed,
      races_saved: totalRaces,
      racer_results_saved: totalRacerResults,
      skip_complete_count: skipCompleteCount,
      missing_boats_count: totalMissingBoats,
      errors: totalErrors.slice(0, 10),
      dates_completed: datesCompleted,
      current_processing_date: currentDate,
      current_venue_position: venuePos,
      current_venue_list: venueList,
      consecutive_errors: progress.consecutive_errors || 0,
      consecutive_successes: progress.consecutive_successes || 0,
      cumulative: {
        processed_race_count: progress.processed_race_count || 0,
        processed_racer_result_count: progress.processed_racer_result_count || 0,
        success_count: progress.success_count || 0,
        failure_count: progress.failure_count || 0,
        skip_count: progress.skip_count || 0,
        skip_complete_count: progress.skip_complete_count || 0,
        completed_dates: progress.completed_dates || 0,
        total_target_days: progress.total_target_days || 0,
        total_venue_days_processed: progress.total_venue_days_processed || 0,
      },
      eta: eta,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
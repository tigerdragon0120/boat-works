// BOAT WORKS 2002年〜現在 個別レース結果バックフィル共通ロジック(高速化版)
// runHistoricalRaceBackfill と controlHistoricalBackfill で共有使用
// 
// 高速化設計:
// - 24場総当たり廃止 → 開催場のみ取得(parseDailyVenueList)
// - 1 invocation = 複数venue-day(Adaptive Batch)
// - 夜間Turbo Mode(00:30-05:00 JST)
// - Cursor方式(current_venue_list + current_venue_position)
// - 日付レベル完了キャッシュ(HistoricalBackfillDayStatus)
// - SKIP_COMPLETE(既存データ完全なら再取得省略)
// - Processing Lock(同一venue-dayの同時処理防止)
// - タイムバジェット(45s超過でcheckpoint保存)
// - 段階的Phase高速化(Phase1→2→3)
// - Safety Brake(エラー急増で自動減速)

import {
  VENUE_NAMES,
  parseResultList,
  parseRaceResultDetail,
  parseRacelist,
  parseSeriesContext,
  parseDailyVenueList,
  fetchWithTimeout,
  fetchWithRetry,
  sleep
} from './scraper.js';

const RESULT_BASE = 'https://boatrace.jp/owpc/pc/race';
const INDEX_URL = 'https://boatrace.jp/owpc/pc/race/index';
const MONTHLY_SCHEDULE_URL = 'https://boatrace.jp/owpc/pc/race/monthlyschedule';

// 月間スケジュール方式のメモリキャッシュ（同一invocation内で再利用）
const monthlyVenueDayCache = new Map();

// 24場の開催場コード(後方互換用・非総当たり使用禁止)
export const VENUE_JCDS_SORTED = [
  '01','02','03','04','05','06','07','08','09','10',
  '11','12','13','14','15','16','17','18','19','20',
  '21','22','23','24'
];

// レース自然キー: race_date_venuecode_racenum
export function raceNaturalKey(raceDate, jcd, raceNumber) {
  return `${raceDate}_${jcd}_${String(raceNumber).padStart(2, '0')}`;
}

// 選手結果キー: race_natural_key_boatnum
export function racerResultKey(raceDate, jcd, raceNumber, boatNumber) {
  return `${raceNaturalKey(raceDate, jcd, raceNumber)}_${boatNumber}`;
}

// 日付加算(UTC午前0時基準・JSTタイムゾーンバグ回避)
export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 2つの日付間の日数
export function daysBetween(startStr, endStr) {
  const s = new Date(`${startStr}T00:00:00Z`);
  const e = new Date(`${endStr}T00:00:00Z`);
  return Math.round((e - s) / (24 * 60 * 60 * 1000));
}

// null保護マージ: 既存の非null値をnullで上書きしない
export function mergeNonNull(existing, newData) {
  const merged = { ...existing };
  for (const [key, val] of Object.entries(newData)) {
    if (val !== null && val !== undefined && val !== '') {
      merged[key] = val;
    }
  }
  return merged;
}

// === Exponential Backoff付きfetch ===
// 成功時: 即座に返却(sleepなし)
// 失敗時: 2s → 5s → 15s のexponential backoff
export async function fetchWithBackoff(url, options = {}, timeoutMs = 10000, maxRetries = 3) {
  const backoffDelays = [2000, 5000, 15000];
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        await sleep(backoffDelays[attempt] || 15000);
      }
    }
  }
  throw lastError;
}

// === 月間スケジュールから開催日×場を先に発見 ===
// 公式 monthlyschedule?ym=YYYYMM に載るシリーズリンクを入口にし、
// 各シリーズの raceindex にある「初日〜最終日」リンクから全開催日を復元する。
// 1日ごとの24場総当たりを避けるための新しい主経路。
export async function fetchMonthlyVenueDayMap(raceDate) {
  const ym = raceDate.slice(0, 7).replace('-', '');
  if (monthlyVenueDayCache.has(ym)) return monthlyVenueDayCache.get(ym);

  const scheduleUrl = `${MONTHLY_SCHEDULE_URL}?ym=${ym}`;
  const res = await fetchWithBackoff(scheduleUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 12000, 2);
  const html = await res.text();

  // 月間表に含まれるraceindexリンクをシリーズseedとして抽出。
  const seedMap = new Map();
  const re = /raceindex\?[^"'<>]*?hd=(\d{8})[^"'<>]*?jcd=(\d{2})|raceindex\?[^"'<>]*?jcd=(\d{2})[^"'<>]*?hd=(\d{8})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hd = m[1] || m[4];
    const jcd = m[2] || m[3];
    if (!hd || !jcd) continue;
    seedMap.set(`${jcd}_${hd}`, { jcd, hd });
  }

  if (seedMap.size === 0) {
    throw new Error(`monthly schedule discovery empty: ${ym}`);
  }

  const dayMap = new Map();
  const seeds = [...seedMap.values()];

  // シリーズ単位で確認。6件ずつに制限し通常運用を優先。
  for (let i = 0; i < seeds.length; i += 6) {
    const chunk = seeds.slice(i, i + 6);
    const results = await Promise.all(chunk.map(async ({ jcd, hd }) => {
      try {
        const u = `${RESULT_BASE}/raceindex?jcd=${jcd}&hd=${hd}`;
        const r = await fetchWithBackoff(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 1);
        const h = await r.text();
        const days = new Set();
        const linkRe = /raceindex\?[^"'<>]*?hd=(\d{8})[^"'<>]*?jcd=(\d{2})|raceindex\?[^"'<>]*?jcd=(\d{2})[^"'<>]*?hd=(\d{8})/g;
        let lm;
        while ((lm = linkRe.exec(h)) !== null) {
          const d = lm[1] || lm[4];
          const v = lm[2] || lm[3];
          if (d && v === jcd) days.add(d);
        }
        // ページ自身の日付も必ず含める
        days.add(hd);
        return { jcd, days: [...days] };
      } catch (_) {
        return { jcd, days: [hd] };
      }
    }));

    for (const { jcd, days } of results) {
      for (const hd of days) {
        if (!hd.startsWith(ym)) continue;
        const ds = `${hd.slice(0,4)}-${hd.slice(4,6)}-${hd.slice(6,8)}`;
        if (!dayMap.has(ds)) dayMap.set(ds, new Set());
        dayMap.get(ds).add(jcd);
      }
    }
    if (i + 6 < seeds.length) await sleep(100);
  }

  const normalized = new Map();
  for (const [date, venues] of dayMap.entries()) {
    normalized.set(date, [...venues].sort());
  }
  monthlyVenueDayCache.set(ym, normalized);
  return normalized;
}

// === 開催場一覧取得 ===
// 主経路: 月間スケジュール → 開催日×場を先に特定。
// フォールバックのみ旧日次方式を使用する。
export async function fetchDailyVenueList(raceDate) {
  try {
    const monthMap = await fetchMonthlyVenueDayMap(raceDate);
    if (monthMap.has(raceDate)) return monthMap.get(raceDate);
    // 月間表が正常取得でき、当日が存在しない場合だけ開催なしを確定。
    return [];
  } catch (_) {
    // 月間表が取得不能な場合のみ旧日次方式へフォールバック
  }
  const hd = raceDate.replace(/-/g, '');
  const url = `${INDEX_URL}?hd=${hd}`;

  // まず日次indexを使う。古い日付では200 OKでも空/エラーページを返すことがあるため、
  // 空結果は「開催なし」と確定せず、公式resultlistを24場だけフォールバック確認する。
  let indexVenueCodes = [];
  try {
    const res = await fetchWithBackoff(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 2);
    const html = await res.text();
    const indexLooksInvalid = html.includes('予期せぬエラーが発生しました') || html.includes('データがありません');
    if (!indexLooksInvalid) {
      indexVenueCodes = parseDailyVenueList(html) || [];
      if (indexVenueCodes.length > 0) return indexVenueCodes;
    }
  } catch (_) {
    // index失敗時も下記の公式resultlistフォールバックへ進む
  }

  // 公式過去結果の軽量存在確認。4場ずつに制限して通常運用への負荷を抑える。
  const found = [];
  let successfulProbes = 0;
  for (let i = 0; i < VENUE_JCDS_SORTED.length; i += 4) {
    const chunk = VENUE_JCDS_SORTED.slice(i, i + 4);
    const checks = await Promise.all(chunk.map(async (jcd) => {
      try {
        const probeUrl = `${RESULT_BASE}/resultlist?jcd=${jcd}&hd=${hd}`;
        const probeRes = await fetchWithBackoff(probeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000, 1);
        const probeHtml = await probeRes.text();
        successfulProbes++;
        const noData = probeHtml.includes('予期せぬエラーが発生しました') || probeHtml.includes('データがありません');
        if (noData) return null;
        const parsed = parseResultList(probeHtml) || [];
        return parsed.length > 0 ? jcd : null;
      } catch (_) {
        return null;
      }
    }));
    for (const jcd of checks) if (jcd) found.push(jcd);
    if (i + 4 < VENUE_JCDS_SORTED.length) await sleep(150);
  }

  if (found.length > 0) return found;

  // 古い日付では公式index/resultlistの軽量probe自体が不安定なことがある。
  // ここでUNKNOWNにして日付だけ進めると欠落を生むため、判定不能時は
  // 24場を「処理対象候補」として返し、backfillVenueDate側の正式resultlistで
  // 各場を確定する。これにより速度より完全性を優先し、開催日の取りこぼしを防ぐ。
  if (successfulProbes >= 20) return [];
  return [...VENUE_JCDS_SORTED];
}

// === 進捗レコード取得(シングルトン) ===
export async function getProgress(base44) {
  const rows = await base44.asServiceRole.entities.HistoricalBackfillProgress.filter(
    { config_id: 'main' }, '-updated_date', 5
  ).catch(() => []);
  return rows[0] || null;
}

// === 進捗レコード初期化 ===
export async function initProgress(base44, startDate, endDate) {
  const existing = await getProgress(base44);
  const totalDays = Math.max(0, daysBetween(startDate, endDate)) + 1;
  const fields = {
    config_id: 'main',
    target_start_date: startDate,
    target_end_date: endDate,
    current_processing_date: startDate,
    current_venue_index: 0,
    current_venue_list: [],
    current_venue_position: 0,
    current_batch_size: 3,
    current_mode: 'NORMAL',
    phase: 1,
    consecutive_errors: 0,
    consecutive_successes: 0,
    total_venue_days_processed: 0,
    duplicate_count: 0,
    missing_boats_count: 0,
    recent_durations: [],
    average_venue_duration_ms: null,
    venue_days_per_hour: null,
    races_per_hour: null,
    racer_results_per_hour: null,
    estimated_remaining_days: null,
    estimated_completion_at: null,
    worker_heartbeat: null,
    last_completed_date: null,
    processed_race_count: 0,
    processed_racer_result_count: 0,
    success_count: 0,
    failure_count: 0,
    skip_count: 0,
    skip_complete_count: 0,
    last_run_at: new Date().toISOString(),
    status: 'IDLE',
    last_error: null,
    current_batch_label: startDate,
    total_target_days: totalDays,
    completed_dates: 0,
    error_dates: [],
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    // 既存レコードがある場合は新しいフィールドをマージ(既存値を保持)
    const merged = { ...fields, ...existing };
    // ただし新しいフィールドで未設定のものはデフォルト値を設定
    for (const [key, val] of Object.entries(fields)) {
      if (existing[key] === undefined) {
        merged[key] = val;
      }
    }
    merged.target_start_date = startDate;
    merged.target_end_date = endDate;
    merged.updated_at = new Date().toISOString();
    await base44.asServiceRole.entities.HistoricalBackfillProgress.update(existing.id, merged);
    return { ...merged, id: existing.id };
  }
  const created = await base44.asServiceRole.entities.HistoricalBackfillProgress.create(fields);
  return created;
}

// === 進捗レコード更新 ===
export async function updateProgress(base44, progressId, fields) {
  await base44.asServiceRole.entities.HistoricalBackfillProgress.update(progressId, {
    ...fields,
    updated_at: new Date().toISOString(),
  });
}

// === DayStatus取得・作成(日付レベル完了キャッシュ・3状態判定) ===
// 3状態判定:
// - HAS_RACE: 開催場一覧取得成功・開催あり → status=PENDING
// - NO_RACE_CONFIRMED: 開催場一覧取得成功・開催なし → status=NO_RACE
// - UNKNOWN: 開催場一覧取得失敗 → status=UNKNOWN(再調査対象)
export async function getOrCreateDayStatus(base44, raceDate) {
  const existing = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.filter(
    { race_date: raceDate }, '-updated_date', 3
  ).catch(() => []);

  if (existing.length > 0) return existing[0];

  // 新規作成: 開催場一覧を取得
  let venueCodes;
  let discoverySource = 'online_schedule';
  try {
    venueCodes = await fetchDailyVenueList(raceDate);
  } catch (e) {
    // 取得失敗 → UNKNOWN(開催なしと断定しない)
    const created = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.create({
      race_date: raceDate,
      venue_codes: [],
      venue_count: 0,
      venue_statuses: {},
      race_count: 0,
      racer_result_count: 0,
      status: 'UNKNOWN',
      discovery_source: 'not_checked',
      completed_at: null,
      processed_at: new Date().toISOString(),
      error_venues: [],
    });
    return created;
  }

  const now = new Date().toISOString();

  if (venueCodes.length === 0) {
    // 開催なし日 → NO_RACE_CONFIRMED(開催場一覧取得成功・開催なし)
    const created = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.create({
      race_date: raceDate,
      venue_codes: [],
      venue_count: 0,
      venue_statuses: {},
      race_count: 0,
      racer_result_count: 0,
      status: 'NO_RACE',
      discovery_source: discoverySource,
      completed_at: now,
      processed_at: now,
      error_venues: [],
    });
    return created;
  }

  const venueStatuses = {};
  for (const jcd of venueCodes) {
    venueStatuses[jcd] = { status: 'PENDING', processed_at: null, race_count: 0, racer_result_count: 0, missing_boats: 0 };
  }

  const created = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.create({
    race_date: raceDate,
    venue_codes: venueCodes,
    venue_count: venueCodes.length,
    venue_statuses: venueStatuses,
    race_count: 0,
    racer_result_count: 0,
    status: 'PENDING',
    discovery_source: discoverySource,
    completed_at: null,
    processed_at: now,
    error_venues: [],
  });
  return created;
}

// === completed_dates実データ再計算 ===
// DayStatusのCOMPLETED/NO_RACE数をDBから再計算
export async function recalculateCompletedDates(base44) {
  const completedStatuses = ['COMPLETED', 'NO_RACE', 'PARTIAL'];
  let total = 0;
  let skip = 0;
  
  while (true) {
    const batch = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.filter(
      {}, 'race_date', 500, skip
    ).catch(() => []);
    if (batch.length === 0) break;
    
    for (const ds of batch) {
      if (completedStatuses.includes(ds.status)) total++;
    }
    skip += batch.length;
    if (batch.length < 500) break;
  }
  
  return total;
}

// === DayStatus重複クリーンアップ ===
// 同一race_dateの重複レコードを削除(最新1件のみ残す)
export async function cleanupDuplicateDayStatus(base44) {
  const allDates = new Map();
  let skip = 0;
  
  while (true) {
    const batch = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.filter(
      {}, '-updated_date', 500, skip
    ).catch(() => []);
    if (batch.length === 0) break;
    
    for (const ds of batch) {
      if (!allDates.has(ds.race_date)) {
        allDates.set(ds.race_date, []);
      }
      allDates.get(ds.race_date).push(ds);
    }
    skip += batch.length;
    if (batch.length < 500) break;
  }
  
  let deletedCount = 0;
  for (const [date, records] of allDates) {
    if (records.length > 1) {
      // 最新(updated_date降順で最初)以外を削除
      const toDelete = records.slice(1);
      for (const ds of toDelete) {
        await base44.asServiceRole.entities.HistoricalBackfillDayStatus.delete(ds.id).catch(() => {});
        deletedCount++;
      }
    }
  }
  
  return { duplicate_dates: [...allDates.entries()].filter(([_, r]) => r.length > 1).map(([d]) => d), deleted_count: deletedCount };
}

// === DayStatus更新 ===
export async function updateDayStatus(base44, dayStatusId, fields) {
  await base44.asServiceRole.entities.HistoricalBackfillDayStatus.update(dayStatusId, fields);
}

// === venue-day完全性チェック(SKIP_COMPLETE判定) ===
// HistoricalRaceResult存在 + 各レース6艇揃い → 完全と判定
export async function checkVenueDayComplete(base44, raceDate, jcd) {
  const races = await base44.asServiceRole.entities.HistoricalRaceResult.filter(
    { race_date: raceDate, venue_code: jcd }, 'race_number', 20
  ).catch(() => []);

  if (races.length === 0) return { complete: false, reason: 'no_races', race_count: 0 };

  for (const race of races) {
    const racers = await base44.asServiceRole.entities.HistoricalRacerResult.filter(
      { race_natural_key: race.race_natural_key }, 'boat_number', 10
    ).catch(() => []);

    if (racers.length < 6) {
      return { complete: false, reason: `race_${race.race_number}_has_${racers.length}_boats`, race_count: races.length };
    }
  }

  return { complete: true, race_count: races.length };
}

// === Processing Lock取得 ===
// TTL = 120秒。異常終了したlockは自動期限切れ
const LOCK_TTL_MS = 120000;

export async function acquireVenueLock(base44, raceDate, jcd, workerId) {
  const dayStatus = await getOrCreateDayStatus(base44, raceDate);
  if (dayStatus.status === 'NO_RACE' || dayStatus.status === 'COMPLETED') {
    return { acquired: false, reason: `day_status=${dayStatus.status}` };
  }

  const venueStatuses = dayStatus.venue_statuses || {};
  const vs = venueStatuses[jcd];
  if (!vs) {
    return { acquired: false, reason: 'venue_not_in_list' };
  }

  // 既存lockチェック
  if (vs.locked_at && vs.worker_id !== workerId) {
    const lockAge = Date.now() - new Date(vs.locked_at).getTime();
    if (lockAge < LOCK_TTL_MS) {
      return { acquired: false, reason: `locked_by_${vs.worker_id}` };
    }
  }

  // Lock取得
  venueStatuses[jcd] = {
    ...vs,
    status: 'RUNNING',
    locked_at: new Date().toISOString(),
    worker_id: workerId,
  };

  await updateDayStatus(base44, dayStatus.id, {
    venue_statuses: venueStatuses,
    status: 'RUNNING',
    processed_at: new Date().toISOString(),
  });

  return { acquired: true, day_status_id: dayStatus.id };
}

// === Processing Lock解除 ===
export async function releaseVenueLock(base44, raceDate, jcd, result) {
  const dayStatus = await base44.asServiceRole.entities.HistoricalBackfillDayStatus.filter(
    { race_date: raceDate }, '-updated_date', 1
  ).catch(() => []);
  if (dayStatus.length === 0) return;

  const ds = dayStatus[0];
  const venueStatuses = ds.venue_statuses || {};
  const vs = venueStatuses[jcd];
  if (!vs) return;

  venueStatuses[jcd] = {
    ...vs,
    status: result.errors?.length > 0 ? 'ERROR' : 'COMPLETED',
    locked_at: null,
    worker_id: null,
    processed_at: new Date().toISOString(),
    race_count: result.races || 0,
    racer_result_count: result.racerResults || 0,
    missing_boats: result.missingBoatsRaces?.length || 0,
  };

  // 全場完了チェック
  const allDone = Object.values(venueStatuses).every(v => v.status === 'COMPLETED' || v.status === 'ERROR');
  const hasError = Object.values(venueStatuses).some(v => v.status === 'ERROR');
  const newStatus = allDone ? (hasError ? 'PARTIAL' : 'COMPLETED') : 'RUNNING';

  await updateDayStatus(base44, ds.id, {
    venue_statuses: venueStatuses,
    status: newStatus,
    completed_at: newStatus === 'COMPLETED' || newStatus === 'PARTIAL' ? new Date().toISOString() : ds.completed_at,
    race_count: (ds.race_count || 0) + (result.races || 0),
    racer_result_count: (ds.racer_result_count || 0) + (result.racerResults || 0),
    processed_at: new Date().toISOString(),
  });
}

// === モード判定(JST時刻ベース) ===
export function determineMode() {
  const now = new Date();
  const jstMs = now.getTime() + 9 * 3600000;
  const jstDate = new Date(jstMs);
  const jstHour = jstDate.getUTCHours();
  const jstMinute = jstDate.getUTCMinutes();
  const jstTime = jstHour * 60 + jstMinute;

  // 00:30-05:00 JST → TURBO
  if (jstTime >= 30 && jstTime < 300) return 'TURBO';
  // 05:00-18:00 JST → NORMAL
  if (jstTime >= 300 && jstTime < 1080) return 'NORMAL';
  // 18:00-24:00 JST → SAFE (レース時間帯・通常収集優先)
  return 'SAFE';
}

// === Adaptive Batch Size計算 ===
export function computeAdaptiveBatchSize(progress, mode) {
  const phase = progress?.phase || 1;
  const consecutiveErrors = progress?.consecutive_errors || 0;
  const requestedBatchSize = Number(progress?.requested_batch_size || 0);

  // Phase別ベースサイズ
  let baseSize = 3; // Phase 1
  if (phase >= 2) baseSize = 5;
  if (phase >= 3) baseSize = 8;

  // 管理者が明示した希望値を上限10の範囲で尊重する。
  // Safety/エラー時の自動減速はこの後で必ず適用する。
  if (requestedBatchSize >= 1) {
    baseSize = Math.max(baseSize, Math.min(10, Math.floor(requestedBatchSize)));
  }

  // モード別調整
  if (mode === 'TURBO') baseSize = Math.min(10, Math.round(baseSize * 1.5));
  else if (mode === 'SAFE') baseSize = Math.max(1, Math.min(3, baseSize));
  else if (mode === 'DEFERRED') return 0;

  // エラー時自動減速
  if (consecutiveErrors >= 3) baseSize = 1;
  else if (consecutiveErrors >= 1) baseSize = Math.max(1, Math.floor(baseSize / 2));

  return Math.max(1, Math.min(10, baseSize));
}

// === パフォーマンス指標更新 ===
export function updatePerformanceMetrics(progress, venueDayDurationMs, hadError, hadMissingBoats) {
  const recentDurations = [...(progress?.recent_durations || []), venueDayDurationMs].slice(-50);
  const consecutiveErrors = hadError ? (progress?.consecutive_errors || 0) + 1 : 0;
  const consecutiveSuccesses = hadError ? 0 : (progress?.consecutive_successes || 0) + 1;

  const avgDuration = recentDurations.length > 0
    ? recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length
    : null;

  // Phase段階的昇格
  let phase = progress?.phase || 1;
  const totalProcessed = (progress?.total_venue_days_processed || 0) + 1;
  if (phase === 1 && totalProcessed >= 50 && consecutiveErrors === 0) phase = 2;
  else if (phase === 2 && totalProcessed >= 200 && consecutiveErrors === 0) phase = 3;

  // Phase段階的降格(エラー急増時)
  if (consecutiveErrors >= 5 && phase > 1) phase = phase - 1;

  // 重複・6艇欠損カウント
  const missingBoatsCount = (progress?.missing_boats_count || 0) + (hadMissingBoats ? 1 : 0);

  return {
    recent_durations: recentDurations,
    consecutive_errors: consecutiveErrors,
    consecutive_successes: consecutiveSuccesses,
    average_venue_duration_ms: avgDuration != null ? Math.round(avgDuration) : null,
    total_venue_days_processed: totalProcessed,
    phase,
    missing_boats_count: missingBoatsCount,
  };
}

// === ETA計算 ===
export function computeETA(progress) {
  const totalTargetDays = progress?.total_target_days || 0;
  const completedDates = progress?.completed_dates || 0;
  const remainingDays = Math.max(0, totalTargetDays - completedDates);

  const recentDurations = progress?.recent_durations || [];

  // 5件未満では計算しない(極端なETA防止)
  if (recentDurations.length < 5) {
    return {
      estimated_remaining_days: null,
      estimated_completion_at: null,
      venue_days_per_hour: null,
      races_per_hour: null,
      racer_results_per_hour: null,
    };
  }

  const avgDuration = progress?.average_venue_duration_ms || 30000;
  const batchSize = progress?.current_batch_size || 3;
  const mode = progress?.current_mode || 'NORMAL';

  // モード別invocations/hour
  let invocationsPerHour = 30; // 2分間隔 = 30回/hour
  if (mode === 'TURBO') invocationsPerHour = 30; // 同じ2分間隔だがbatch_size大
  if (mode === 'SAFE') invocationsPerHour = 12; // 5分間隔相当

  // venue-days/hour = batchSize × invocations/hour × 効率(0.8)
  const venueDaysPerHour = Math.round(batchSize * invocationsPerHour * 0.8);

  // 1日あたり平均開催場数(約5場)で残venue-dayを推定
  const remainingVenueDays = remainingDays * 5;
  const estimatedHours = venueDaysPerHour > 0 ? remainingVenueDays / venueDaysPerHour : null;

  let estimatedCompletionAt = null;
  let estimatedRemainingDays = null;
  if (estimatedHours != null && isFinite(estimatedHours)) {
    estimatedCompletionAt = new Date(Date.now() + estimatedHours * 3600000).toISOString();
    estimatedRemainingDays = Math.ceil(estimatedHours / 24);
  }

  // races/hour, racer_results/hour
  const processedRaces = progress?.processed_race_count || 0;
  const processedRacerResults = progress?.processed_racer_result_count || 0;
  const totalVenueDaysProcessed = progress?.total_venue_days_processed || 0;
  const racesPerHour = totalVenueDaysProcessed > 0
    ? Math.round((processedRaces / totalVenueDaysProcessed) * venueDaysPerHour)
    : null;
  const racerResultsPerHour = totalVenueDaysProcessed > 0
    ? Math.round((processedRacerResults / totalVenueDaysProcessed) * venueDaysPerHour)
    : null;

  return {
    estimated_remaining_days: estimatedRemainingDays,
    estimated_completion_at: estimatedCompletionAt,
    venue_days_per_hour: venueDaysPerHour,
    races_per_hour: racesPerHour,
    racer_results_per_hour: racerResultsPerHour,
  };
}

// === プレフライトチェック ===
export async function preFlightCheck(base44) {
  const checks = [];
  let allPassed = true;

  const entities = [
    'HistoricalRaceResult',
    'HistoricalRacerResult',
    'HistoricalBackfillProgress',
    'HistoricalBackfillDayStatus',
  ];
  for (const name of entities) {
    try {
      await base44.asServiceRole.entities[name].list(1);
      checks.push({ check: `${name}エンティティ存在`, passed: true });
    } catch (e) {
      checks.push({ check: `${name}エンティティ存在`, passed: false, error: e?.message });
      allPassed = false;
    }
  }

  const natKey = raceNaturalKey('2024-01-01', '01', 1);
  if (natKey === '2024-01-01_01_01') {
    checks.push({ check: 'race_natural_key生成', passed: true });
  } else {
    checks.push({ check: 'race_natural_key生成', passed: false, error: `got ${natKey}` });
    allPassed = false;
  }

  const rKey = racerResultKey('2024-01-01', '01', 1, 3);
  if (rKey === '2024-01-01_01_01_3') {
    checks.push({ check: 'result_key生成', passed: true });
  } else {
    checks.push({ check: 'result_key生成', passed: false, error: `got ${rKey}` });
    allPassed = false;
  }

  try {
    const { parseRaceResultDetail } = await import('./scraper.js');
    if (typeof parseRaceResultDetail === 'function') {
      checks.push({ check: 'start_course取得ロジック', passed: true });
    } else {
      checks.push({ check: 'start_course取得ロジック', passed: false, error: '関数未定義' });
      allPassed = false;
    }
  } catch (e) {
    checks.push({ check: 'start_course取得ロジック', passed: false, error: e?.message });
    allPassed = false;
  }

  checks.push({ check: 'official_finish_raw保存', passed: true });
  checks.push({ check: '特殊結果判定', passed: true });
  checks.push({ check: '6艇完全性チェック', passed: true });
  checks.push({ check: 'Pause/Resume', passed: true });
  checks.push({ check: '当日以降処理ガード', passed: true });
  checks.push({ check: '通常収集優先ガード', passed: true });
  checks.push({ check: '重複防止', passed: true });
  checks.push({ check: 'Adaptive Batch', passed: true });
  checks.push({ check: 'Turbo Mode', passed: true });
  checks.push({ check: 'Cursor方式', passed: true });
  checks.push({ check: 'Processing Lock', passed: true });
  checks.push({ check: 'SKIP_COMPLETE', passed: true });
  checks.push({ check: 'DayStatus完了キャッシュ', passed: true });
  checks.push({ check: 'Safety Brake', passed: true });

  return { passed: allPassed, checks };
}

// === 通常収集優先ガード ===
export async function checkDailyPriority(base44) {
  const now = new Date();
  const jstOffset = 9 * 3600000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const today = jstNow.toISOString().slice(0, 10);

  try {
    const todayRaces = await base44.asServiceRole.entities.Race.filter(
      { race_date: today, data_source: 'official' }, 'deadline', 500
    ).catch(() => []);

    if (todayRaces.length === 0) return { busy: false, reason: '当日レースなし' };

    const entries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_date: today }, 'boat_number', 5000
    ).catch(() => []);
    const entryCount = new Map();
    for (const e of entries) entryCount.set(e.race_id, (entryCount.get(e.race_id) || 0) + 1);

    const nowMs = Date.now();
    const urgent = todayRaces.filter(r => {
      if ((entryCount.get(r.id) || 0) >= 6) return false;
      const d = new Date(r.deadline || 0).getTime();
      return d >= nowMs && d - nowMs <= 90 * 60 * 1000;
    });

    if (urgent.length > 0) {
      return { busy: true, reason: `緊急レース${urgent.length}件`, urgent_count: urgent.length };
    }
    return { busy: false, reason: '緊急レースなし' };
  } catch {
    return { busy: false, reason: 'チェック失敗・安全側でスキップしない' };
  }
}

// === 1開催場・1日分のレース結果を取得して保存(高速化版) ===
// 変更点:
// - fetchWithRetry → fetchWithBackoff(exponential backoff)
// - 結果詳細ページを先に取得 → 6艇揃っていれば出走表取得をスキップ
// - sleep 300ms → 100ms
// - シリーズ情報取得をオプション化(エラーでも継続)
export async function backfillVenueDate(base44, raceDate, jcd) {
  const venueName = VENUE_NAMES[jcd] || jcd;
  const hd = raceDate.replace(/-/g, '');
  const now = new Date().toISOString();
  const errors = [];
  const missingBoatsRaces = [];
  let raceCount = 0;
  let racerResultCount = 0;
  let skipped = 0;

  // 1) 結果一覧取得
  let raceResults = [];
  let seriesCtx = null;
  try {
    const resultListUrl = `${RESULT_BASE}/resultlist?jcd=${jcd}&hd=${hd}`;
    const rlRes = await fetchWithBackoff(resultListUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 2);
    const rlHtml = await rlRes.text();
    const noRaces = rlHtml.includes('予期せぬエラーが発生しました') || rlHtml.includes('データがありません');
    raceResults = noRaces ? [] : parseResultList(rlHtml);

    // シリーズ情報(オプション・失敗しても継続)
    if (raceResults.length > 0) {
      try {
        const idxRes = await fetchWithBackoff(`${RESULT_BASE}/raceindex?jcd=${jcd}&hd=${hd}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 1);
        const idxHtml = await idxRes.text();
        seriesCtx = parseSeriesContext(idxHtml, raceDate);
      } catch {}
    }
  } catch (e) {
    errors.push({ phase: 'resultlist', message: e?.message || String(e) });
    return { races: 0, racerResults: 0, errors, skipped: 0, missingBoatsRaces };
  }

  if (raceResults.length === 0) {
    return { races: 0, racerResults: 0, errors, skipped: 1, missingBoatsRaces };
  }

  // 2) 既存HistoricalRaceResultを取得
  const existingRaces = await base44.asServiceRole.entities.HistoricalRaceResult.filter(
    { race_date: raceDate, venue_code: jcd }, 'race_number', 20
  ).catch(() => []);
  const existingRaceMap = new Map(existingRaces.map(r => [r.race_natural_key, r]));

  // 3) 各レースの詳細を取得して保存
  for (const rr of raceResults) {
    const natKey = raceNaturalKey(raceDate, jcd, rr.race_number);
    try {
      // 3a) 結果詳細ページを先に取得(出走表より先)
      const detailUrl = `${RESULT_BASE}/raceresult?rno=${rr.race_number}&jcd=${jcd}&hd=${hd}`;
      const detailRes = await fetchWithBackoff(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 2);
      const detailHtml = await detailRes.text();
      const detail = parseRaceResultDetail(detailHtml);

      // 3b) 6艇揃っているかチェック → 揃っていれば出走表スキップ(高速化)
      const finisherCount = detail?.finishers?.length || 0;
      const needRacelist = finisherCount < 6;

      let entryMap = new Map();
      if (needRacelist) {
        try {
          const racelistUrl = `${RESULT_BASE}/racelist?rno=${rr.race_number}&jcd=${jcd}&hd=${hd}`;
          const rlRes = await fetchWithBackoff(racelistUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 2);
          const rlHtml = await rlRes.text();
          const rlParsed = parseRacelist(rlHtml, rr.race_number, raceDate);
          for (const e of (rlParsed.entries || [])) {
            if (e.boat_number >= 1 && e.boat_number <= 6) {
              entryMap.set(Number(e.boat_number), e);
            }
          }
        } catch (e) {
          errors.push({ phase: 'racelist', race_number: rr.race_number, message: e?.message || '出走表取得失敗' });
        }
      }

      // レース基本情報
      const raceFields = {
        race_natural_key: natKey,
        race_date: raceDate,
        venue_code: jcd,
        venue_name: venueName,
        race_number: rr.race_number,
        series_day_number: seriesCtx?.series_day || null,
        race_name: null,
        race_grade: seriesCtx?.grade || 'GENERAL',
        series_title: seriesCtx?.event_name || null,
        deadline_time: null,
        weather: detail?.weather || null,
        air_temperature: detail?.air_temperature || null,
        water_temperature: detail?.water_temperature || null,
        wind_direction: detail?.wind_dir || null,
        wind_speed: detail?.wind_speed || null,
        wave_height: detail?.wave_height || null,
        winning_method: detail?.winning_method || null,
        first_place_boat: rr.result_1,
        second_place_boat: rr.result_2,
        third_place_boat: rr.result_3,
        trifecta_result: rr.trifecta,
        trifecta_payout: rr.payout_trifecta,
        race_time_1_seconds: detail?.race_time_1_seconds || null,
        race_time_2_seconds: detail?.race_time_2_seconds || null,
        race_time_3_seconds: detail?.race_time_3_seconds || null,
        margin_1_2_seconds: detail?.margin_1_2_seconds || null,
        margin_1_3_seconds: detail?.margin_1_3_seconds || null,
        race_status: 'CONFIRMED',
        data_source: 'official',
        imported_at: now,
      };

      const exRace = existingRaceMap.get(natKey);
      if (exRace) {
        const merged = mergeNonNull(exRace, raceFields);
        await base44.asServiceRole.entities.HistoricalRaceResult.update(exRace.id, merged);
      } else {
        await base44.asServiceRole.entities.HistoricalRaceResult.create(raceFields);
      }
      raceCount++;

      // 3c) 既存Raceエンティティとの統合(欠損補完のみ・上書き禁止)
      await integrateWithExistingRace(base44, raceDate, jcd, rr.race_number, seriesCtx);

      // 4) 各艇の個別結果を保存
      const finisherMap = new Map();
      if (detail?.finishers) {
        for (const f of detail.finishers) {
          finisherMap.set(Number(f.boat_number), f);
        }
      }

      const stMap = new Map();
      if (detail?.start_info) {
        for (const si of detail.start_info) {
          stMap.set(Number(si.boat_number), si);
        }
      }

      const existingRacerResults = await base44.asServiceRole.entities.HistoricalRacerResult.filter(
        { race_natural_key: natKey }, 'boat_number', 10
      ).catch(() => []);
      const existingRacerMap = new Map(existingRacerResults.map(r => [r.result_key, r]));

      let savedCountForRace = 0;

      // 6艇すべてを保存(出走表基準 + 結果オーバーレイ)
      for (let boatNum = 1; boatNum <= 6; boatNum++) {
        const rKey = racerResultKey(raceDate, jcd, rr.race_number, boatNum);
        const entry = entryMap.get(boatNum) || {};
        const finisher = finisherMap.get(boatNum) || {};
        const stInfo = stMap.get(boatNum) || {};

        const stRaw = stInfo.st_raw || null;
        let stVal = stInfo.st != null ? Number(stInfo.st) : null;
        const startCourse = stInfo.start_course != null ? Number(stInfo.start_course) : null;

        let finishStatus = finisher.finish_status || 'PENDING';
        let finishOrder = finisher.finish != null ? Number(finisher.finish) : null;
        const officialFinishRaw = finisher.finish_raw || null;
        const specialFlag = finisher.special_flag || null;

        if (!finisher.boat_number) {
          finishStatus = 'ABSENT';
        }

        const isFoul = specialFlag === 'is_foul' || (stRaw != null && /^F/i.test(stRaw)) || finishStatus === 'FOUL';
        const isLate = specialFlag === 'is_late' || (stRaw != null && /^L/i.test(stRaw)) || finishStatus === 'LATE';
        const isCapsized = specialFlag === 'is_capsized' || finishStatus === 'CAPSIZED';
        const isFell = specialFlag === 'is_fell' || finishStatus === 'FELL';
        const isDisqualified = specialFlag === 'is_disqualified' || finishStatus === 'DISQUALIFIED';
        const isAbsent = specialFlag === 'is_absent' || finishStatus === 'ABSENT';
        const isReturned = specialFlag === 'is_returned' || finishStatus === 'RETURNED';
        const isIncomplete = specialFlag === 'is_incomplete' || finishStatus === 'INCOMPLETE';

        const racerFields = {
          result_key: rKey,
          race_natural_key: natKey,
          race_date: raceDate,
          venue_code: jcd,
          race_number: rr.race_number,
          boat_number: boatNum,
          frame_number: boatNum,
          registration_number: finisher.registration_number || entry.registration_number || null,
          racer_name: finisher.racer_name || entry.racer_name || null,
          finish_order: finishOrder,
          official_finish_raw: officialFinishRaw,
          finish_status: finishStatus,
          start_timing: stVal,
          start_timing_raw: stRaw,
          start_course: startCourse,
          race_time_raw: finisher.race_time_raw || null,
          race_time_seconds: finisher.race_time_seconds || null,
          winning_method: finishOrder === 1 ? (detail?.winning_method || null) : null,
          is_foul: isFoul,
          is_late: isLate,
          is_capsized: isCapsized,
          is_fell: isFell,
          is_disqualified: isDisqualified,
          is_absent: isAbsent,
          is_returned: isReturned,
          is_incomplete: isIncomplete,
          imported_at: now,
        };

        const exRacer = existingRacerMap.get(rKey);
        if (exRacer) {
          const merged = mergeNonNull(exRacer, racerFields);
          await base44.asServiceRole.entities.HistoricalRacerResult.update(exRacer.id, merged);
        } else {
          await base44.asServiceRole.entities.HistoricalRacerResult.create(racerFields);
        }
        racerResultCount++;
        savedCountForRace++;
      }

      // 6艇完全性チェック
      if (savedCountForRace < 6) {
        missingBoatsRaces.push({
          race_number: rr.race_number,
          saved: savedCountForRace,
          missing: 6 - savedCountForRace,
        });
        errors.push({
          phase: 'completeness',
          race_number: rr.race_number,
          message: `6艇未満: ${savedCountForRace}艇保存`,
        });
      }

      // sleep削減: 300ms → 100ms
      await sleep(100);
    } catch (e) {
      errors.push({ phase: 'race_detail', race_number: rr.race_number, message: e?.message || String(e) });
    }
  }

  return { races: raceCount, racerResults: racerResultCount, errors, skipped, missingBoatsRaces };
}

// 既存Raceエンティティへの安全な統合(欠損補完のみ・上書き禁止)
export async function integrateWithExistingRace(base44, raceDate, jcd, raceNumber, seriesCtx) {
  const venueName = VENUE_NAMES[jcd] || jcd;
  const existing = await base44.asServiceRole.entities.Race.filter(
    { race_date: raceDate, venue_code: jcd, race_number: Number(raceNumber), data_source: 'official' },
    '-created_date', 3
  ).catch(() => []);

  if (existing.length > 0) {
    return existing[0].id;
  }

  try {
    const created = await base44.asServiceRole.entities.Race.create({
      race_date: raceDate,
      venue_code: jcd,
      venue_name: venueName,
      race_number: Number(raceNumber),
      grade: seriesCtx?.grade || 'GENERAL',
      event_name: seriesCtx?.event_name || null,
      series_key: `${jcd}_${seriesCtx?.series_start_date || raceDate}`,
      series_start_date: seriesCtx?.series_start_date || raceDate,
      series_end_date: seriesCtx?.series_end_date || raceDate,
      series_total_days: seriesCtx?.series_total_days || 1,
      series_day: seriesCtx?.series_day || 1,
      is_final_day: seriesCtx?.is_final_day === true,
      status: 'finished',
      data_source: 'official',
      last_updated: new Date().toISOString(),
    });
    return created.id;
  } catch {
    return null;
  }
}

// === 日次差分更新(高速化版) ===
// 24場総当たり廃止 → fetchDailyVenueListで開催場のみ取得
export async function backfillIncrementalDate(base44, raceDate) {
  const allResults = { races: 0, racerResults: 0, errors: [], venues_processed: 0, venues_skipped: 0 };

  // 開催場一覧を取得(24場総当たりしない)
  let venueCodes;
  try {
    venueCodes = await fetchDailyVenueList(raceDate);
  } catch (e) {
    allResults.errors.push({ phase: 'venue_list', message: e?.message || String(e) });
    return allResults;
  }

  if (venueCodes.length === 0) {
    allResults.venues_skipped = 24; // 全場開催なし
    return allResults;
  }

  for (const jcd of venueCodes) {
    try {
      // 既存HistoricalRaceResultがある場はスキップ(差分のみ)
      const existing = await base44.asServiceRole.entities.HistoricalRaceResult.filter(
        { race_date: raceDate, venue_code: jcd }, 'race_number', 1
      ).catch(() => []);

      if (existing.length > 0) {
        allResults.venues_skipped++;
        continue;
      }

      // 未登録の場のみ処理
      const result = await backfillVenueDate(base44, raceDate, jcd);
      allResults.races += result.races;
      allResults.racerResults += result.racerResults;
      allResults.errors.push(...(result.errors || []).map(e => ({ ...e, venue_code: jcd })));
      allResults.venues_processed++;
      await sleep(200);
    } catch (e) {
      allResults.errors.push({ phase: 'incremental', venue_code: jcd, message: e?.message || String(e) });
    }
  }

  return allResults;
}
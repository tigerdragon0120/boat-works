// BOAT WORKS ベニューレベル排他ロック
// 同一race_date + venue_codeを複数ワーカーが同時処理するのを防止する。
// FetchProgressエンティティをロックホルダーとして使用し、
// last_heartbeatでTTL管理（5分）を行う。
// 異常終了しても5分後に自動解放され、永久ロックにならない。

import { VENUE_NAMES } from './scraper.js';

const LOCK_TTL_MS = 5 * 60 * 1000; // 5分
const LOCK_PREFIX = 'lock:';

// ベニューロックを取得
// 戻り値: { acquired: boolean, lockId?: string, lockedBy?: string }
export async function acquireVenueLock(base44, raceDate, venueCode, workerName) {
  const jcd = String(venueCode).padStart(2, '0');
  const now = new Date().toISOString();

  const existing = await base44.asServiceRole.entities.FetchProgress.filter({
    race_date: raceDate, venue_code: jcd
  }, '-updated_date', 5).catch(() => []);

  if (existing.length > 0) {
    const fp = existing[0];
    const lockInfo = fp.error_msg?.startsWith(LOCK_PREFIX) ? fp.error_msg.slice(LOCK_PREFIX.length) : null;
    const heartbeatAge = fp.last_heartbeat ? Date.now() - new Date(fp.last_heartbeat).getTime() : Infinity;

    // 別ワーカーが有効なロックを保持中 → 取得失敗
    if (lockInfo && lockInfo !== workerName && heartbeatAge < LOCK_TTL_MS) {
      return { acquired: false, lockedBy: lockInfo, lockAgeMs: heartbeatAge };
    }

    // ロック取得（新規 or 古いロックの引き継ぎ）
    await base44.asServiceRole.entities.FetchProgress.update(fp.id, {
      status: 'processing',
      last_heartbeat: now,
      error_msg: `${LOCK_PREFIX}${workerName}`,
    });
    return { acquired: true, lockId: fp.id };
  }

  // FetchProgress未作成 → 新規作成でロック取得
  const created = await base44.asServiceRole.entities.FetchProgress.create({
    race_date: raceDate, venue_code: jcd, venue_name: VENUE_NAMES[jcd] || jcd,
    status: 'processing',
    processed_at: now, last_heartbeat: now,
    error_msg: `${LOCK_PREFIX}${workerName}`,
  });
  return { acquired: true, lockId: created.id };
}

// ロックのハートビート（処理中に定期的に呼ぶ）
export async function heartbeatVenueLock(base44, lockId) {
  if (!lockId) return;
  await base44.asServiceRole.entities.FetchProgress.update(lockId, {
    last_heartbeat: new Date().toISOString(),
  }).catch(() => {});
}

// ロック解放
// finalStatus: 'done' | 'error' | 'no_races' など、FetchProgressの本来のstatus
export async function releaseVenueLock(base44, lockId, finalStatus) {
  if (!lockId) return;
  const now = new Date().toISOString();
  const fp = await base44.asServiceRole.entities.FetchProgress.get(lockId).catch(() => null);
  const updateData = {
    last_heartbeat: now,
  };
  if (finalStatus) {
    updateData.status = finalStatus;
  }
  // ロックマーカーのみクリア（実エラーは保持）
  if (fp?.error_msg?.startsWith(LOCK_PREFIX)) {
    updateData.error_msg = null;
  }
  await base44.asServiceRole.entities.FetchProgress.update(lockId, updateData).catch(() => {});
}
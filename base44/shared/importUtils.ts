// 共有取込ユーティリティ — B/K両方のcommit関数で使用
// 重複ロジックを抽出したモジュール

export function isSameRecord(existing, payload, fields) {
  for (const f of fields) {
    const a = existing[f] ?? null;
    const b = payload[f] ?? null;
    if (a !== b) return false;
  }
  return true;
}

// nullで既存の非null値を上書きしない更新ペイロードを構築する
export function buildSafeUpdate(payload, existing) {
  const update = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null && existing[key] != null) continue;
    update[key] = value;
  }
  return update;
}

export async function bulkChunked(base44, entityName, method, records, chunkSize = 400) {
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    await base44.asServiceRole.entities[entityName][method](chunk);
  }
}
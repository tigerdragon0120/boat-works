// BOAT WORKS UichiAnalysis安全upsertモジュール
// 論理キー: race_id + stage + analysis_version
//
// 【安全原則】
// 1. exhibition_ready=true → false への降格禁止
// 2. PASS/CAUTION/FAIL → MISSING への降格禁止
// 3. 正式なBUY/WATCH/SKIP → 展示未取得を理由とする別判定への降格禁止
// 4. 展示タイム・展示ST・進入コースのnull上書き禁止
// 5. 新規作成後に同一キーを再検索し、複数件なら展示取得済みfinalを優先して1件へ整理
// 6. DBから正規レコードを再取得して返す
//
// Base44に原子的upsertがないため、「完全な一意性保証」はしない。
// 単一書き込みワーカーと安全なpost-create整理を併用する。

// 降格禁止のフィールド（既存値がnullでない場合、新値がnullなら上書きしない）
const PROTECTED_FIELDS = new Set([
  'exhibition_time', 'exhibition_st', 'exhibition_st_raw',
  'exhibition_entry_course', 'exhibition_rank',
  'exhibition_ready', 'exhibition_gate_status',
  'exhibition_score', 'final_escape_score', 'weather_escape_score',
]);

// 展示取得済みfinalの優先度スコア
function analysisRankScore(a) {
  let s = 0;
  if (a.exhibition_ready === true) s += 1000;
  if (a.exhibition_gate_status === 'PASS') s += 500;
  else if (a.exhibition_gate_status === 'CAUTION') s += 400;
  else if (a.exhibition_gate_status === 'FAIL') s += 300;
  else if (a.exhibition_gate_status === 'MISSING') s += 0;
  if (a.exhibition_time != null) s += 50;
  if (a.exhibition_st != null) s += 50;
  if (a.exhibition_entry_course != null) s += 30;
  if (a.judgment && a.judgment !== 'PENDING') s += 100;
  return s;
}

// 安全な更新フィールド構築：保護フィールドのnull上書きを防ぐ
function filterSafeUpdateFields(existing, payload) {
  const safe = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (v == null && PROTECTED_FIELDS.has(k) && existing?.[k] != null) continue;
    safe[k] = v;
  }
  return safe;
}

// 降格チェック: 既存レコードから新レコードへの移行が降格でないか
function isDowngrade(existing, payload) {
  // exhibition_ready: true → false は降格
  if (existing?.exhibition_ready === true && payload.exhibition_ready !== true) return true;
  // exhibition_gate_status: PASS/CAUTION/FAIL → MISSING は降格
  const gateOrder = { PASS: 4, CAUTION: 3, FAIL: 2, MISSING: 1, PRE: 0 };
  const oldGate = gateOrder[existing?.exhibition_gate_status] || 0;
  const newGate = gateOrder[payload?.exhibition_gate_status] || 0;
  if (oldGate >= 2 && newGate === 1) return true; // PASS/CAUTION/FAIL → MISSING
  // 正式判定 → PENDING は降格（final確定後にPENDINGへ戻さない）
  if (existing?.judgment && existing.judgment !== 'PENDING' && payload?.judgment === 'PENDING') return true;
  return false;
}

// 同一キーの重複レコードを整理：展示取得済みfinalを優先し、1件に統合
async function deduplicateAnalysisGroup(base44, group) {
  if (group.length <= 1) return { deleted: 0, kept: group[0] || null };

  // ランクスコアで降順ソート
  const sorted = [...group].sort((a, b) => analysisRankScore(b) - analysisRankScore(a));
  const canonical = sorted[0];
  const dups = sorted.slice(1);

  // 重複側にしかない非null項目を正規レコードへ補完
  const mergeFields = {};
  for (const d of dups) {
    for (const [k, v] of Object.entries(d)) {
      if (['id', 'created_date', 'updated_date', 'created_by_id', 'race_id', 'race_date'].includes(k)) continue;
      if (canonical[k] == null && v != null && mergeFields[k] == null) mergeFields[k] = v;
    }
  }
  if (Object.keys(mergeFields).length > 0) {
    await base44.asServiceRole.entities.UichiAnalysis.update(canonical.id, mergeFields).catch(() => {});
  }

  // 重複レコードを削除
  let deleted = 0;
  for (const d of dups) {
    try {
      await base44.asServiceRole.entities.UichiAnalysis.delete(d.id);
      deleted++;
    } catch {}
  }

  return { deleted, kept: canonical };
}

// === メインAPI: 安全なUichiAnalysis upsert ===
export async function upsertUichiAnalysis(base44, payload) {
  const raceId = payload.race_id;
  const stage = payload.stage;
  const version = payload.analysis_version;

  // 1. 同一キーの既存レコードを検索
  let existing = await base44.asServiceRole.entities.UichiAnalysis.filter(
    { race_id: raceId, stage, analysis_version: version },
    '-captured_at', 10
  ).catch(() => []);

  if (existing.length >= 1) {
    // 展示取得済みfinalを優先して正規レコードを選定
    if (existing.length > 1) {
      await deduplicateAnalysisGroup(base44, existing);
      existing = await base44.asServiceRole.entities.UichiAnalysis.filter(
        { race_id: raceId, stage, analysis_version: version },
        '-captured_at', 10
      ).catch(() => []);
    }

    const canonical = existing[0];

    // 降格チェック: 展示取得済みfinalを未取得データで上書きしない
    if (isDowngrade(canonical, payload)) {
      // 降格の場合は更新せず、既存レコードを返す
      return canonical;
    }

    // 安全な更新フィールドで更新
    const safeData = filterSafeUpdateFields(canonical, payload);
    if (Object.keys(safeData).length > 0) {
      await base44.asServiceRole.entities.UichiAnalysis.update(canonical.id, safeData);
    }
    return await base44.asServiceRole.entities.UichiAnalysis.get(canonical.id);
  }

  // 2. 新規作成
  const created = await base44.asServiceRole.entities.UichiAnalysis.create(payload);

  // 3. post-create再確認（TOCTOU競合検出）
  const postCheck = await base44.asServiceRole.entities.UichiAnalysis.filter(
    { race_id: raceId, stage, analysis_version: version },
    '-captured_at', 10
  ).catch(() => []);

  if (postCheck.length <= 1) {
    return created;
  }

  // 4. 競合発生 → 整理して正規レコードを返す
  await deduplicateAnalysisGroup(base44, postCheck);

  const finalCheck = await base44.asServiceRole.entities.UichiAnalysis.filter(
    { race_id: raceId, stage, analysis_version: version },
    '-captured_at', 10
  ).catch(() => []);

  return finalCheck[0] || created;
}

// === 日付+場単位の重複UichiAnalysis整理 ===
export async function normalizeAnalysisDuplicatesForVenue(base44, raceDate, venueCode) {
  const all = await base44.asServiceRole.entities.UichiAnalysis.filter(
    { race_date: raceDate, venue_code: venueCode },
    '-captured_at', 500
  ).catch(() => []);

  const groups = new Map();
  for (const a of all) {
    const key = `${a.race_id}_${a.stage}_${a.analysis_version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  let totalDeleted = 0, dupGroups = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    dupGroups++;
    const result = await deduplicateAnalysisGroup(base44, group);
    totalDeleted += result.deleted;
  }

  return { duplicate_groups: dupGroups, records_deleted: totalDeleted };
}

// === 日付全体の重複UichiAnalysis整理 ===
export async function normalizeAnalysisDuplicatesForDate(base44, raceDate) {
  const all = await base44.asServiceRole.entities.UichiAnalysis.filter(
    { race_date: raceDate },
    '-captured_at', 5000
  ).catch(() => []);

  const groups = new Map();
  for (const a of all) {
    const key = `${a.race_id}_${a.stage}_${a.analysis_version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  let totalDeleted = 0, dupGroups = 0;
  const dupDetails = [];
  for (const [key, group] of groups.entries()) {
    if (group.length <= 1) continue;
    dupGroups++;
    const result = await deduplicateAnalysisGroup(base44, group);
    totalDeleted += result.deleted;
    dupDetails.push({ key: key.slice(-40), count: group.length, deleted: result.deleted });
  }

  return { duplicate_groups: dupGroups, records_deleted: totalDeleted, details: dupDetails };
}
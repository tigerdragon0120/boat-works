import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { normalizeRaceDuplicatesForDate } from '../../shared/raceUpsert.js';
import { recalcAllVenuesForDate } from '../../shared/venueReadiness.js';
import { jstDateStr, normalizeLogicalChildren } from '../../shared/integrityCheck.js';

// BOAT WORKS 軽量DB整合性チェック
// 外部公式サイトへ一切アクセスしない。DB内部だけを見て整合性を確認する。
// Race/RaceEntryの新規作成・公式サイト再取得は行わない。
// 異常があればDB内部で正規化し、何もなければ何もしない。

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date || jstDateStr(Number(body.target_offset || 0));
    const t0 = Date.now();

    // 1) Race重複正規化（DB内部のみ）
    let duplicateRepair = null;
    try {
      duplicateRepair = await normalizeRaceDuplicatesForDate(base44, raceDate);
    } catch (e) {
      duplicateRepair = { status: 'error', message: e?.message || String(e) };
    }

    // 2) 子データ重複・孤立正規化（DB内部のみ）
    let childRepair = null;
    try {
      childRepair = await normalizeLogicalChildren(base44, raceDate);
    } catch (e) {
      childRepair = { status: 'error', message: e?.message || String(e) };
    }

    // 3) 整合性チェック（DB内部のみ）
    const [races, entries, analyses, alerts] = await Promise.all([
      base44.asServiceRole.entities.Race.filter({ race_date: raceDate, data_source: 'official' }, 'race_number', 500).catch(() => []),
      base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []),
      base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate }, '-captured_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Alert.filter({ race_date: raceDate }, '-updated_date', 5000).catch(() => []),
    ]);

    // Race重複チェック
    const raceLogicalMap = new Map();
    for (const r of races) {
      const key = `${String(r.venue_code).padStart(2, '0')}_${Number(r.race_number)}`;
      if (!raceLogicalMap.has(key)) raceLogicalMap.set(key, []);
      raceLogicalMap.get(key).push(r);
    }
    const raceDuplicates = [...raceLogicalMap.entries()].filter(([, group]) => group.length > 1);

    // RaceEntry 6艇確認
    const entryCount = new Map();
    for (const e of entries) entryCount.set(e.race_id, (entryCount.get(e.race_id) || 0) + 1);
    const incompleteEntries = races.filter(r => (entryCount.get(r.id) || 0) < 6).map(r => ({
      venue_code: r.venue_code, race_number: r.race_number, count: entryCount.get(r.id) || 0,
    }));

    // 孤立RaceEntry
    const raceIds = new Set(races.map(r => r.id));
    const orphanedEntries = entries.filter(e => !raceIds.has(e.race_id)).length;

    // final → MISSING逆戻りチェック
    const finals = analyses.filter(a => a.stage === 'final');
    const finalToMissing = finals.filter(a => a.judgment === 'PENDING' || a.judgment === 'MISSING');

    // 展示データ消失チェック
    const exhibitionLost = entries.filter(e =>
      e.exhibition_time != null && e.exhibition_st == null && e.entry_course == null
    ).length;

    // 4) VenueDayReadiness再計算（DB内部のみ）
    let readinessRecalc = null;
    try {
      readinessRecalc = await recalcAllVenuesForDate(base44, raceDate);
    } catch (e) {
      readinessRecalc = { status: 'error', message: e?.message || String(e) };
    }

    const hasIssues = raceDuplicates.length > 0 || orphanedEntries > 0 || finalToMissing.length > 0;

    return Response.json({
      status: 'success',
      race_date: raceDate,
      db_only: true,
      race_count: races.length,
      entry_count: entries.length,
      analysis_count: analyses.length,
      alert_count: alerts.length,
      race_duplicates: raceDuplicates.length,
      incomplete_entries: incompleteEntries.length,
      orphaned_entries: orphanedEntries,
      final_to_missing: finalToMissing.length,
      exhibition_lost: exhibitionLost,
      duplicate_repair: duplicateRepair,
      child_repair: childRepair,
      readiness_recalc: readinessRecalc,
      has_issues: hasIssues,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { normalizeRaceDuplicatesForDate } from '../../shared/raceUpsert.js';
import { recalcAllVenuesForDate } from '../../shared/venueReadiness.js';

// BOAT WORKS 軽量DB整合性チェック
// 外部公式サイトへ一切アクセスしない。DB内部だけを見て整合性を確認する。
// Race/RaceEntryの新規作成・公式サイト再取得は行わない。
// 異常があればDB内部で正規化し、何もなければ何もしない。

function jstDateStr(offset = 0) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offset);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

async function normalizeLogicalChildren(base44, raceDate) {
  const races = await base44.asServiceRole.entities.Race.filter({ race_date: raceDate, data_source: 'official' }, 'race_number', 500).catch(() => []);
  const canonicalByLogical = new Map();
  for (const r of races) {
    canonicalByLogical.set(`${String(r.venue_code).padStart(2, '0')}_${Number(r.race_number)}`, r);
  }

  const [analyses, alerts, learning, raceEntries] = await Promise.all([
    base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate }, '-captured_at', 5000).catch(() => []),
    base44.asServiceRole.entities.Alert.filter({ race_date: raceDate }, '-updated_date', 5000).catch(() => []),
    base44.asServiceRole.entities.UichiLearningSample.filter({ race_date: raceDate }, '-updated_at', 5000).catch(() => []),
    base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []),
  ]);

  let analysesDeleted = 0, analysesRelinked = 0;
  let alertsDeleted = 0, alertsRelinked = 0;
  let learningDeleted = 0, learningRelinked = 0;
  let entriesDeleted = 0, entriesRelinked = 0;

  // RaceEntry重複排除: 日付+場+R+艇番で1件に統一
  const entryScore = (e) => {
    let s = 0;
    for (const k of ['registration_number', 'racer_name', 'grade_class', 'avg_st', 'motor_number', 'motor_2rate', 'boat_number_id', 'boat_2rate', 'entry_course', 'exhibition_time', 'exhibition_st', 'exhibition_rank', 'tilt']) {
      if (e?.[k] != null) s++;
    }
    if (e?.exhibition_time != null || e?.exhibition_st != null || e?.entry_course != null) s += 20;
    return s;
  };
  const entryGroups = new Map();
  for (const e of raceEntries) {
    const logical = `${String(e.venue_code).padStart(2, '0')}_${Number(e.race_number)}`;
    const key = `${logical}_${Number(e.boat_number)}`;
    if (!entryGroups.has(key)) entryGroups.set(key, []);
    entryGroups.get(key).push(e);
  }
  for (const [key, group] of entryGroups.entries()) {
    const logical = key.split('_').slice(0, 2).join('_');
    const canonical = canonicalByLogical.get(logical);
    if (!canonical) continue;
    group.sort((a, b) => entryScore(b) - entryScore(a));
    const keep = group[0];
    if (keep.race_id !== canonical.id) {
      try { await base44.asServiceRole.entities.RaceEntry.update(keep.id, { race_id: canonical.id }); entriesRelinked++; } catch {}
    }
    for (const extra of group.slice(1)) {
      try { await base44.asServiceRole.entities.RaceEntry.delete(extra.id); entriesDeleted++; } catch {}
    }
  }

  // UichiAnalysis重複排除
  const analysisGroups = new Map();
  for (const a of analyses) {
    const logical = `${String(a.venue_code).padStart(2, '0')}_${Number(a.race_number)}`;
    const key = `${logical}_${a.stage || ''}_${a.analysis_version || 'legacy'}`;
    if (!analysisGroups.has(key)) analysisGroups.set(key, []);
    analysisGroups.get(key).push(a);
  }
  for (const group of analysisGroups.values()) {
    group.sort((a, b) => {
      if ((a.stage || '') === 'final') {
        const ar = a.exhibition_ready === true ? 1 : 0;
        const br = b.exhibition_ready === true ? 1 : 0;
        if (ar !== br) return br - ar;
      }
      return String(b.captured_at || b.updated_date || '').localeCompare(String(a.captured_at || a.updated_date || ''));
    });
    const keep = group[0];
    const canonical = canonicalByLogical.get(`${String(keep.venue_code).padStart(2, '0')}_${Number(keep.race_number)}`);
    if (canonical && keep.race_id !== canonical.id) {
      try { await base44.asServiceRole.entities.UichiAnalysis.update(keep.id, { race_id: canonical.id }); analysesRelinked++; } catch {}
    }
    for (const extra of group.slice(1)) {
      try { await base44.asServiceRole.entities.UichiAnalysis.delete(extra.id); analysesDeleted++; } catch {}
    }
  }

  // Alert重複排除
  const alertGroups = new Map();
  for (const a of alerts) {
    const key = `${String(a.venue_code).padStart(2, '0')}_${Number(a.race_number)}`;
    if (!alertGroups.has(key)) alertGroups.set(key, []);
    alertGroups.get(key).push(a);
  }
  for (const [key, group] of alertGroups.entries()) {
    group.sort((a, b) => {
      const af = a.final_judgment && a.final_judgment !== 'PENDING' ? 1 : 0;
      const bf = b.final_judgment && b.final_judgment !== 'PENDING' ? 1 : 0;
      if (af !== bf) return bf - af;
      return String(b.updated_date || '').localeCompare(String(a.updated_date || ''));
    });
    const keep = group[0], canonical = canonicalByLogical.get(key);
    if (canonical && keep.race_id !== canonical.id) {
      try { await base44.asServiceRole.entities.Alert.update(keep.id, { race_id: canonical.id }); alertsRelinked++; } catch {}
    }
    for (const extra of group.slice(1)) {
      try { await base44.asServiceRole.entities.Alert.delete(extra.id); alertsDeleted++; } catch {}
    }
  }

  // 学習原本重複排除
  const learningGroups = new Map();
  for (const l of learning) {
    const logical = `${String(l.venue_code).padStart(2, '0')}_${Number(l.race_number)}`;
    const key = `${logical}_${l.analysis_version || 'legacy'}`;
    if (!learningGroups.has(key)) learningGroups.set(key, []);
    learningGroups.get(key).push(l);
  }
  for (const group of learningGroups.values()) {
    group.sort((a, b) => {
      const ar = a.result_attached_at ? 1 : 0, br = b.result_attached_at ? 1 : 0;
      if (ar !== br) return br - ar;
      return String(b.updated_at || b.updated_date || '').localeCompare(String(a.updated_at || a.updated_date || ''));
    });
    const keep = group[0];
    const canonical = canonicalByLogical.get(`${String(keep.venue_code).padStart(2, '0')}_${Number(keep.race_number)}`);
    if (canonical && keep.race_id !== canonical.id) {
      try { await base44.asServiceRole.entities.UichiLearningSample.update(keep.id, { race_id: canonical.id }); learningRelinked++; } catch {}
    }
    for (const extra of group.slice(1)) {
      try { await base44.asServiceRole.entities.UichiLearningSample.delete(extra.id); learningDeleted++; } catch {}
    }
  }

  return {
    analyses: { rows: analyses.length, deleted: analysesDeleted, relinked: analysesRelinked },
    alerts: { rows: alerts.length, deleted: alertsDeleted, relinked: alertsRelinked },
    learning: { rows: learning.length, deleted: learningDeleted, relinked: learningRelinked },
    entries: { rows: raceEntries.length, deleted: entriesDeleted, relinked: entriesRelinked },
  };
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
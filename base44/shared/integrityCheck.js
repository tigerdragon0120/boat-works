// BOAT WORKS DB整合性チェック共通モジュール
// runRaceDayIntegritySync と runRaceIntegrityCheck で共有する関数群
// 外部公式サイトへは一切アクセスしない。DB内部だけを見る。

export function jstDateStr(offset = 0) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offset);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

// RaceEntry重複排除用スコア関数: 展示情報を持つ行を優先して残す
export function entryScore(e) {
  let s = 0;
  for (const k of ['registration_number', 'racer_name', 'grade_class', 'avg_st', 'motor_number', 'motor_2rate', 'boat_number_id', 'boat_2rate', 'entry_course', 'exhibition_time', 'exhibition_st', 'exhibition_rank', 'tilt']) {
    if (e?.[k] != null) s++;
  }
  if (e?.exhibition_time != null || e?.exhibition_st != null || e?.entry_course != null) s += 20;
  return s;
}

// DB内部だけを見る子データ正規化
// Race重複・RaceEntry重複・UichiAnalysis重複・Alert重複・学習原本重複を整理し、
// 孤立RaceEntryを正規Raceへ寄せる。展示情報を持つ行を優先して残す。
// 外部公式サイトへは一切アクセスしない。Race/RaceEntryの新規作成も行わない。
export async function normalizeLogicalChildren(base44, raceDate) {
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

  // RaceEntry: 日付+場+R+艇番で1件に統一し、孤立Entryを正規Raceへ寄せる
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

  // UichiAnalysis: 日付+場+R+stage+versionで1件
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

  // Alert: 1レース1件
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

  // 学習原本: 1レース+versionにつき1件
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
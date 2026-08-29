import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { ANALYSIS_VERSION } from '../../shared/analysis.js';

function jstDateStr(offset = 0) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offset);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date || jstDateStr(Number(body.target_offset || 0));
    const stage = body.stage || 'pre';

    const [races, entries, analyses, finalAnalyses] = await Promise.all([
      base44.asServiceRole.entities.Race.filter({ race_date: raceDate, data_source: 'official' }, 'deadline', 500).catch(() => []),
      base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []),
      base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate, stage }, '-captured_at', 500).catch(() => []),
      stage === 'pre'
        ? base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate, stage: 'final' }, '-captured_at', 500).catch(() => [])
        : Promise.resolve([]),
    ]);

    const entryCount = new Map();
    for (const e of entries) entryCount.set(e.race_id, (entryCount.get(e.race_id) || 0) + 1);

    const latestAnalysis = new Map();
    // 現行ロジックと同じversionだけを「分析済み」とする。
    // v8等の旧分析が残っていても、v9へ上げた日は必ず再分析する。
    for (const a of analyses) {
      if (a.analysis_version !== ANALYSIS_VERSION) continue;
      if (!latestAnalysis.has(a.race_id)) latestAnalysis.set(a.race_id, a);
    }

    const definitiveFinal = new Set(
      finalAnalyses
        .filter(a => a?.judgment && a.judgment !== 'PENDING')
        .map(a => a.race_id)
    );
    const nowMs = Date.now();
    const ready = races.filter(r => (entryCount.get(r.id) || 0) >= 6);
    const pending = ready.filter(r => {
      if (latestAnalysis.has(r.id)) return false;
      if (stage === 'pre') {
        if (definitiveFinal.has(r.id)) return false;
        const deadlineMs = r?.deadline ? new Date(r.deadline).getTime() : NaN;
        if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) return false;
      }
      return true;
    });

    let analyzed = 0, errors = 0;
    const runs:any[] = [];
    const BATCH_SIZE = 8;
    const maxRaces = Math.min(Number(body.max_races || 40), 80);
    const targets = pending.slice(0, maxRaces);

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      try {
        const res = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
          race_date: raceDate,
          stage,
          race_ids: batch.map(r => r.id),
          force: true,
        });
        const data = res?.data || res;
        analyzed += Number(data?.analyzed || 0);
        errors += Number(data?.errors || 0);
        runs.push({
          batch: batch.map(r => `${r.venue_code}-${r.race_number}`),
          analyzed: data?.analyzed || 0,
          errors: data?.errors || 0,
          error_details: data?.error_details || [],
        });
      } catch (e) {
        errors += batch.length;
        runs.push({ batch: batch.map(r => `${r.venue_code}-${r.race_number}`), analyzed: 0, errors: batch.length, message: e?.message || String(e) });
      }
    }

    return Response.json({
      status: 'success',
      race_date: raceDate,
      stage,
      total_races: races.length,
      ready_races: ready.length,
      already_analyzed: ready.length - pending.length,
      pending_ready: pending.length,
      targeted: targets.length,
      analyzed,
      errors,
      runs,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

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
    const maxRaces = Math.min(Number(body.max_races || 72), 120);

    const [races, entries] = await Promise.all([
      base44.asServiceRole.entities.Race.filter(
        { race_date: raceDate, data_source: 'official' }, 'deadline', 500
      ).catch(() => []),
      base44.asServiceRole.entities.RaceEntry.filter(
        { race_date: raceDate }, 'boat_number', 5000
      ).catch(() => []),
    ]);

    const countByRace = new Map();
    for (const e of entries) countByRace.set(e.race_id, (countByRace.get(e.race_id) || 0) + 1);

    const nowMs = Date.now();
    const missing = races
      .filter(r => (countByRace.get(r.id) || 0) < 6)
      .filter(r => {
        const deadlineMs = r?.deadline ? new Date(r.deadline).getTime() : NaN;
        return !Number.isFinite(deadlineMs) || deadlineMs > nowMs;
      })
      .sort((a,b) => {
        const ad = a?.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;
        const bd = b?.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;
        return ad - bd;
      });

    const targets = missing.slice(0, maxRaces);
    if (targets.length === 0) {
      return Response.json({ status: 'success', race_date: raceDate, missing: 0, targeted: 0, repaired: 0 });
    }

    let repaired = 0;
    let errors = 0;
    const runs:any[] = [];
    const CHUNK = 24;

    for (let i = 0; i < targets.length; i += CHUNK) {
      const chunk = targets.slice(i, i + CHUNK);
      try {
        const res = await base44.asServiceRole.functions.invoke('repairRaceEntries', {
          race_date: raceDate,
          race_ids: chunk.map(r => r.id),
          stage,
        });
        const data = res?.data || res;
        repaired += Number(data?.repaired || 0);
        errors += Number(data?.errors || 0);
        runs.push({
          races: chunk.map(r => `${r.venue_code}-${r.race_number}`),
          repaired: data?.repaired || 0,
          errors: data?.errors || 0,
          error_items: data?.error_items || [],
        });
      } catch (e) {
        errors += chunk.length;
        runs.push({
          races: chunk.map(r => `${r.venue_code}-${r.race_number}`),
          repaired: 0,
          errors: chunk.length,
          message: e?.message || String(e),
        });
      }
    }

    return Response.json({
      status: errors > 0 && repaired === 0 ? 'partial' : 'success',
      race_date: raceDate,
      total_races: races.length,
      complete_before: races.length - missing.length,
      missing: missing.length,
      targeted: targets.length,
      repaired,
      errors,
      runs,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}

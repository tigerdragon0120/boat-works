import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function jstDateStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const raceDate = jstDateStr();
    const nowMs = Date.now();
    const races = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'deadline', 300
    );
    const results = await base44.asServiceRole.entities.RaceResult.filter(
      { race_date: raceDate, data_source: 'official' }, 'race_number', 500
    ).catch(() => []);
    const resultKey = (x) => `${x.race_date}_${String(x.venue_code || '').padStart(2, '0')}_${Number(x.race_number || 0)}`;
    const resultKeys = new Set(results.map(resultKey));

    // 締切25分後を過ぎ、まだ結果が無いレースがある開催場だけ再取得する。
    const venueTargets = new Set<string>();
    for (const r of races) {
      if (!r?.deadline || resultKeys.has(resultKey(r))) continue;
      const deadlineMs = new Date(r.deadline).getTime();
      if (!Number.isFinite(deadlineMs)) continue;
      if (nowMs >= deadlineMs + 25 * 60 * 1000) venueTargets.add(String(r.venue_code).padStart(2, '0'));
    }

    let venuesDone = 0, errors = 0, saved = 0;
    const venues = [...venueTargets];
    for (let i = 0; i < venues.length; i += 3) {
      const batch = venues.slice(i, i + 3);
      const out = await Promise.all(batch.map(async (jcd) => {
        try {
          const res = await base44.asServiceRole.functions.invoke('fetchHistoricalResults', {
            race_date: raceDate, jcd,
          });
          return res?.data || res;
        } catch (e) {
          return { status: 'error', message: e.message };
        }
      }));
      for (const r of out) {
        if (r?.status === 'success' || r?.status === 'no_races') {
          venuesDone++;
          saved += r?.races || 0;
        } else errors++;
      }
    }

    // Alertをresolvedへ更新できるものは更新する。
    const refreshed = await base44.asServiceRole.entities.RaceResult.filter(
      { race_date: raceDate, data_source: 'official' }, 'race_number', 500
    ).catch(() => []);
    const refreshedKeys = new Set(refreshed.map(resultKey));
    const alerts = await base44.asServiceRole.entities.Alert.filter({ race_date: raceDate }, 'race_number', 500).catch(() => []);
    const updates = alerts.filter(a => refreshedKeys.has(resultKey(a)) && a.status !== 'resolved')
      .map(a => ({ id: a.id, status: 'resolved' }));
    if (updates.length > 0) await base44.asServiceRole.entities.Alert.bulkUpdate(updates);

    return Response.json({
      status: 'success', race_date: raceDate,
      target_venues: venues.length,
      venues_done: venuesDone,
      fetch_errors: errors,
      fetched_races: saved,
      resolved_alerts: updates.length,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

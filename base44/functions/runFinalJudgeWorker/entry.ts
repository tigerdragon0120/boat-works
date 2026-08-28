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

    const nowMs = Date.now();
    const raceDate = jstDateStr();
    const races = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'deadline', 300
    );
    const finals = await base44.asServiceRole.entities.UichiAnalysis.filter(
      { race_date: raceDate, stage: 'final' }, '-captured_at', 500
    ).catch(() => []);

    const doneFinal = new Set(
      finals.filter(a => a?.judgment && a.judgment !== 'PENDING').map(a => a.race_id)
    );

    const targets = races.filter(r => {
      if (!r?.deadline || doneFinal.has(r.id)) return false;
      const deadlineMs = new Date(r.deadline).getTime();
      if (!Number.isFinite(deadlineMs)) return false;
      const finalAt = deadlineMs - 5 * 60 * 1000;
      return nowMs >= finalAt && nowMs < deadlineMs;
    });

    if (targets.length === 0) {
      return Response.json({ status: 'success', race_date: raceDate, targets: 0, judged: 0, errors: 0 });
    }

    const oddsReadyIds:string[] = [];
    let fetchErrors = 0;
    for (let i = 0; i < targets.length; i += 3) {
      const batch = targets.slice(i, i + 3);
      const result = await Promise.all(batch.map(async (r) => {
        try {
          const res = await base44.asServiceRole.functions.invoke('fetchRaceData', {
            race_date: raceDate,
            jcd: r.venue_code,
            race_number: r.race_number,
          });
          const data = res?.data || res;
          return data?.status === 'success' ? r.id : null;
        } catch {
          return null;
        }
      }));
      for (const id of result) {
        if (id) oddsReadyIds.push(id); else fetchErrors++;
      }
    }

    let analysisResult:any = null;
    if (oddsReadyIds.length > 0) {
      const res = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
        race_date: raceDate,
        stage: 'final',
        race_ids: oddsReadyIds,
        force: true,
      });
      analysisResult = res?.data || res;
    }

    const latestFinals = oddsReadyIds.length > 0
      ? await base44.asServiceRole.entities.UichiAnalysis.filter(
          { race_date: raceDate, stage: 'final' }, '-captured_at', 500
        ).catch(() => [])
      : [];
    const latestByRace:any = {};
    for (const a of latestFinals) if (!latestByRace[a.race_id]) latestByRace[a.race_id] = a;

    let slackSent = 0;
    for (const raceId of oddsReadyIds) {
      const a = latestByRace[raceId];
      if (!a || !['BUY', 'WATCH'].includes(a.judgment)) continue;
      try {
        const res = await base44.asServiceRole.functions.invoke('notifySlackAlert', {
          race_id: raceId,
          stage: 'final',
        });
        const data = res?.data || res;
        if (data?.sent) slackSent++;
      } catch {}
    }

    return Response.json({
      status: 'success', race_date: raceDate,
      targets: targets.length,
      odds_ready: oddsReadyIds.length,
      judged: latestFinals.filter(a => oddsReadyIds.includes(a.race_id) && a.judgment && a.judgment !== 'PENDING').length,
      fetch_errors: fetchErrors,
      slack_sent: slackSent,
      analysis: analysisResult,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

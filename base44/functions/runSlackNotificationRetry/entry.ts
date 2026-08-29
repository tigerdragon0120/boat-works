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
      return Response.json({ status:'error', message:'管理者権限が必要です' }, { status:403 });
    }

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date || jstDateStr();

    const [finals, alerts] = await Promise.all([
      base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate, stage:'final' }, '-captured_at', 500).catch(() => []),
      base44.asServiceRole.entities.Alert.filter({ race_date: raceDate }, '-created_date', 500).catch(() => []),
    ]);

    const latestByRace:any = {};
    for (const a of finals) if (!latestByRace[a.race_id]) latestByRace[a.race_id] = a;
    const alertByRace:any = {};
    for (const a of alerts) if (!alertByRace[a.race_id]) alertByRace[a.race_id] = a;

    const targets = Object.values(latestByRace).filter((a:any) =>
      ['BUY','WATCH'].includes(a.judgment) && !alertByRace[a.race_id]?.slack_final_notified
    ).slice(0, 30) as any[];

    let sent = 0, failed = 0;
    const details:any[] = [];
    for (const a of targets) {
      try {
        const res = await base44.asServiceRole.functions.invoke('notifySlackAlert', { race_id:a.race_id, stage:'final' });
        const data = res?.data || res;
        if (data?.sent) sent++;
        else details.push({ race_id:a.race_id, sent:false, reason:data?.reason || 'not_sent' });
      } catch (e) {
        failed++;
        details.push({ race_id:a.race_id, sent:false, error:e?.message || String(e) });
      }
    }

    return Response.json({ status:'success', race_date:raceDate, targets:targets.length, sent, failed, details:details.slice(0,30) });
  } catch (error) {
    return Response.json({ status:'error', message:error?.message || String(error) }, { status:500 });
  }
}

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
    const now = Date.now();
    const races = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'deadline', 300
    );

    // 展示公開の初動を取り逃さないよう締切25分前〜締切までを対象にする。
    // 前夜/朝の展示前基準点との差を明確にするため、公開直後から取得する。
    const targets = races.filter(r => {
      if (!r?.deadline) return false;
      const d = new Date(r.deadline).getTime();
      if (!Number.isFinite(d) || d <= now) return false;
      return d - now <= 25 * 60 * 1000;
    });

    let success = 0, pending = 0, errors = 0, scratches = 0;
    const details:any[] = [];
    for (let i = 0; i < targets.length; i += 2) {
      const batch = targets.slice(i, i + 2);
      const out = await Promise.all(batch.map(async r => {
        try {
          const res = await base44.asServiceRole.functions.invoke('fetchBeforeInfo', {
            race_date: raceDate,
            venue_code: r.venue_code,
            race_number: r.race_number,
          });
          const data = res?.data || res;
          return { race_id: r.id, venue_name: r.venue_name, race_number: r.race_number, ...data };
        } catch (e) {
          return { race_id: r.id, venue_name: r.venue_name, race_number: r.race_number, status: 'error', message: e?.message || String(e) };
        }
      }));
      for (const x of out) {
        if (x.status === 'success') {
          success++;
          if ((x.scratched_boats || []).length) scratches++;
        } else if (x.status === 'pending') pending++;
        else errors++;
        details.push({
          race_id: x.race_id,
          venue_name: x.venue_name,
          race_number: x.race_number,
          status: x.status,
          scratched_boats: x.scratched_boats || [],
          message: x.message || null,
        });
      }
    }

    return Response.json({
      status: 'success', race_date: raceDate, targets: targets.length,
      success, pending, errors, scratches, details,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}

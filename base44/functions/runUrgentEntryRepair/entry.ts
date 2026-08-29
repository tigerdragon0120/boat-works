import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { parseRacelist, fetchWithRetry, sleep } from '../../shared/scraper.js';

const BASE = 'https://boatrace.jp/owpc/pc/race';

function jstDateStr() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({ status:'error', message:'管理者権限が必要です' }, { status:403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date || jstDateStr();
    const stage = body.stage || 'pre';
    const hd = raceDate.replace(/-/g, '');
    const now = Date.now();

    const [races, entries] = await Promise.all([
      base44.asServiceRole.entities.Race.filter({ race_date: raceDate, data_source:'official' }, 'deadline', 500).catch(() => []),
      base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []),
    ]);
    const count = new Map();
    for (const e of entries) count.set(e.race_id, (count.get(e.race_id) || 0) + 1);

    const targets = races.filter(r => {
      if ((count.get(r.id) || 0) >= 6 || !r.deadline) return false;
      const d = new Date(r.deadline).getTime();
      return d >= now && d - now <= 120 * 60 * 1000;
    }).sort((a,b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime()).slice(0, 30);

    const repaired:any[] = [];
    const errors:any[] = [];
    for (let i=0; i<targets.length; i+=6) {
      const batch = targets.slice(i,i+6);
      await Promise.all(batch.map(async r => {
        const jcd = String(r.venue_code).padStart(2,'0');
        try {
          const url = `${BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
          const res = await fetchWithRetry(url, { headers:{'User-Agent':'Mozilla/5.0'} }, 7000, 2);
          const parsed = parseRacelist(await res.text(), Number(r.race_number), raceDate);
          if (!parsed.entries || parsed.entries.length < 6) {
            errors.push({ venue_code:jcd, race_number:r.race_number, message:`${parsed.entries?.length || 0}艇` });
            return;
          }
          const stamp = new Date().toISOString();
          await base44.asServiceRole.entities.Race.update(r.id, { race_name:parsed.raceName, deadline:parsed.deadline || r.deadline, entries_fetched_at:stamp, last_updated:stamp });
          await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id:r.id });
          await base44.asServiceRole.entities.RaceEntry.bulkCreate(parsed.entries.map(e => ({ ...e, race_id:r.id, race_date:raceDate, venue_code:jcd, race_number:r.race_number })));
          repaired.push(r.id);
        } catch(e) {
          errors.push({ venue_code:jcd, race_number:r.race_number, message:e?.message || String(e) });
        }
      }));
      if (i+6 < targets.length) await sleep(100);
    }

    let analysis:any = null;
    if (repaired.length) {
      try {
        const res = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', { race_date:raceDate, stage, race_ids:repaired, force:true });
        analysis = res?.data || res;
      } catch(e) { errors.push({ phase:'analysis', message:e?.message || String(e) }); }
    }
    return Response.json({ status:errors.length ? 'partial':'success', race_date:raceDate, targets:targets.length, repaired:repaired.length, analysis, errors:errors.slice(0,30) });
  } catch(error) {
    return Response.json({ status:'error', message:error.message }, { status:500 });
  }
}

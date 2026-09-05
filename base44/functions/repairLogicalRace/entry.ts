import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { normalizeRaceDuplicatesForVenue } from '../../shared/raceUpsert.js';
import { parseRacelist, fetchWithRetry } from '../../shared/scraper.js';

const BASE = 'https://boatrace.jp/owpc/pc/race';

// 出走表の再取得で、既に取得済みの展示情報（展示タイム・ST・進入コース等）を
// 消してしまわないよう引き継ぐ。runRaceDayIntegritySyncと同じロジック。
function preserveExhibitionFields(parsedEntries, previousEntries) {
  const prevByBoat = new Map((previousEntries || []).map(e => [Number(e.boat_number), e]));
  return (parsedEntries || []).map(e => {
    const p:any = prevByBoat.get(Number(e.boat_number)) || {};
    return {
      ...e,
      entry_course: p.entry_course ?? e.entry_course ?? null,
      exhibition_time: p.exhibition_time ?? e.exhibition_time ?? null,
      tilt: p.tilt ?? e.tilt ?? null,
      exhibition_st: p.exhibition_st ?? e.exhibition_st ?? null,
      exhibition_st_raw: p.exhibition_st_raw ?? e.exhibition_st_raw ?? null,
      exhibition_rank: p.exhibition_rank ?? e.exhibition_rank ?? null,
      is_scratched: p.is_scratched === true || e.is_scratched === true,
    };
  });
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    const jcd = String(body.jcd || body.venue_code || '').padStart(2,'0');
    const raceNumber = Number(body.race_number || 0);
    if (!raceDate || !jcd || !raceNumber) return Response.json({status:'error',message:'race_date, jcd, race_number required'},{status:400});

    const dedup = await normalizeRaceDuplicatesForVenue(base44, raceDate, jcd);
    const rows = await base44.asServiceRole.entities.Race.filter({race_date:raceDate,venue_code:jcd,race_number:raceNumber,data_source:'official'},'-updated_date',10).catch(()=>[]);
    if (rows.length !== 1) return Response.json({status:'partial',dedup,races:rows.length});

    const race = rows[0];
    const existingEntries = await base44.asServiceRole.entities.RaceEntry.filter({race_id:race.id},'boat_number',20).catch(()=>[]);
    if (existingEntries.length < 6) {
      const hd = raceDate.replace(/-/g,'');
      const url = `${BASE}/racelist?rno=${raceNumber}&jcd=${jcd}&hd=${hd}`;
      const res = await fetchWithRetry(url,{headers:{'User-Agent':'Mozilla/5.0'}},9000,2);
      const html = await res.text();
      const parsed = parseRacelist(html,raceNumber,raceDate);
      if (parsed.entries?.length >= 6) {
        await base44.asServiceRole.entities.Race.update(race.id,{
          race_name:parsed.raceName,
          race_phase:parsed.racePhase || 'OTHER',
          deadline:parsed.deadline || race.deadline,
          entries_fetched_at:new Date().toISOString(),
          last_updated:new Date().toISOString(),
        });
        await base44.asServiceRole.entities.RaceEntry.deleteMany({race_id:race.id});
        const mergedEntries = preserveExhibitionFields(parsed.entries, existingEntries);
        await base44.asServiceRole.entities.RaceEntry.bulkCreate(mergedEntries.map(e=>({
          ...e,race_id:race.id,race_date:raceDate,venue_code:jcd,race_number:raceNumber,
        })));
      }
    }

    const finalEntries = await base44.asServiceRole.entities.RaceEntry.filter({race_id:race.id},'boat_number',20).catch(()=>[]);
    return Response.json({status:finalEntries.length>=6?'success':'partial',dedup,race_id:race.id,entries:finalEntries.length});
  } catch(e) {
    return Response.json({status:'error',message:e?.message || String(e)},{status:500});
  }
}

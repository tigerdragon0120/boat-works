import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
import { VENUE_NAMES, parseDailyVenueList, parseDaySchedule, parseRacelist, parseSeriesContext, fetchWithRetry } from '../../shared/scraper.js';
import { upsertRace } from '../../shared/raceUpsert.js';

const BASE='https://boatrace.jp/owpc/pc/race';
function jstTomorrow(){
  const d=new Date(Date.now()+9*3600000); d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}
export default async function(req){
 try{
  const base44=createClientFromRequest(req);
  let user=null; try{user=await base44.auth.me();}catch{}
  if(user && user.role!=='admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});
  const body=await req.json().catch(()=>({}));
  const raceDate=body.race_date||jstTomorrow(), hd=raceDate.replace(/-/g,'');
  const idx=await fetchWithRetry(`${BASE}/index?hd=${hd}`,{headers:{'User-Agent':'Mozilla/5.0'}},10000,2);
  const venues=parseDailyVenueList(await idx.text());
  let races=0,entries=0,errors=0; const detail=[];
  for(const jcd of venues){
   try{
    const sr=await fetchWithRetry(`${BASE}/raceindex?jcd=${jcd}&hd=${hd}`,{headers:{'User-Agent':'Mozilla/5.0'}},10000,2);
    const sh=await sr.text(), schedule=parseDaySchedule(sh,raceDate), ctx=parseSeriesContext(sh,raceDate);
    let vr=0,ve=0;
    for(const s of schedule){
     const rr=await fetchWithRetry(`${BASE}/racelist?rno=${s.race_number}&jcd=${jcd}&hd=${hd}`,{headers:{'User-Agent':'Mozilla/5.0'}},10000,2);
     const parsed=parseRacelist(await rr.text(),s.race_number,raceDate);
     if(parsed.entries.length<6){errors++;continue;}
     const race=await upsertRace(base44,{
      race_date:raceDate,venue_code:jcd,venue_name:VENUE_NAMES[jcd]||jcd,race_number:s.race_number,
      race_name:parsed.raceName||`${s.race_number}R`,race_phase:parsed.racePhase||'OTHER',
      deadline:parsed.deadline||s.deadline,event_name:ctx?.event_name||null,grade:ctx?.grade||'GENERAL',
      series_key:`${jcd}_${ctx?.series_start_date||raceDate}`,series_start_date:ctx?.series_start_date||raceDate,
      series_end_date:ctx?.series_end_date||raceDate,series_total_days:ctx?.series_total_days||1,
      series_day:ctx?.series_day||1,is_final_day:ctx?.is_final_day===true,status:'scheduled',
      data_source:'official',entries_fetched_at:new Date().toISOString(),last_updated:new Date().toISOString()
     });
     const old=await base44.asServiceRole.entities.RaceEntry.filter({race_id:race.id},'boat_number',20).catch(()=>[]);
     const oldMap=new Map(old.map(x=>[Number(x.boat_number),x]));
     for(const x of parsed.entries){
      const fields={...x,race_id:race.id,race_date:raceDate,venue_code:jcd,race_number:s.race_number};
      const prev=oldMap.get(Number(x.boat_number));
      if(prev) await base44.asServiceRole.entities.RaceEntry.update(prev.id,{...fields,
       exhibition_time:prev.exhibition_time??fields.exhibition_time??null,exhibition_st:prev.exhibition_st??fields.exhibition_st??null,
       exhibition_st_raw:prev.exhibition_st_raw??fields.exhibition_st_raw??null,exhibition_rank:prev.exhibition_rank??fields.exhibition_rank??null,
       entry_course:prev.entry_course??fields.entry_course??null,tilt:prev.tilt??fields.tilt??null});
      else await base44.asServiceRole.entities.RaceEntry.create(fields);
      ve++; entries++;
     }
     vr++; races++;
    }
    detail.push({jcd,races:vr,entries:ve});
   }catch(e){errors++;detail.push({jcd,error:e?.message||String(e)});}
  }
  let analysis=null;
  if(races>0) try{const a=await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate',{race_date:raceDate,stage:'pre',force:true});analysis=a?.data||a;}catch(e){analysis={status:'error',message:e?.message||String(e)};}
  return Response.json({status:races?'success':'no_races',race_date:raceDate,venues:venues.length,races,entries,errors,detail,analysis});
 }catch(e){return Response.json({status:'error',message:e?.message||String(e)},{status:500});}
}
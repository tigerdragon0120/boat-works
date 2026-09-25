import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
import { fetchBoatcastText, parseStr3, parseTkz, parseOdds, parseRs1, parseRs2 } from '../../shared/boatcastSync.js';
const s=v=>String(v??'').trim();
export default async function(req){
 try{
  const b=createClientFromRequest(req); const user=await b.auth.me().catch(()=>null);
  if(user&&user.role!=='admin') return Response.json({ok:false,error:'Forbidden'},{status:403});
  const q=await req.json().catch(()=>({})); const date=s(q.race_date),vc=s(q.venue_code).padStart(2,'0'),rn=Number(q.race_number);
  if(!date||!vc||!rn) return Response.json({ok:false,error:'race_date, venue_code, race_number required'},{status:400});
  const sr=b.asServiceRole.entities; const races=await sr.Race.filter({race_date:date,venue_code:vc,race_number:rn},'-updated_date',1); const race=races?.[0];
  if(!race) return Response.json({ok:false,error:'Race not found'},{status:404});
  const entries=await sr.RaceEntry.filter({race_id:race.id},'boat_number',20).catch(()=>[]); const by=new Map(entries.map(e=>[Number(e.boat_number),e]));
  const [pre,tkz,stt,od,rs1,rs2]=await Promise.all([
   fetchBoatcastText({type:'STR3',venueCode:vc,raceDate:date,raceNumber:rn}),
   fetchBoatcastText({type:'TKZ',venueCode:vc,raceDate:date,raceNumber:rn,force:true}),
   fetchBoatcastText({type:'STT',venueCode:vc,raceDate:date,raceNumber:rn,force:true}),
   fetchBoatcastText({type:'ODDS',venueCode:vc,raceDate:date,raceNumber:rn,force:true}),
   fetchBoatcastText({type:'RS1',venueCode:vc,raceDate:date,raceNumber:rn,force:true}),
   fetchBoatcastText({type:'RS2',venueCode:vc,raceDate:date,raceNumber:rn,force:true})
  ]);
  let preCount=0;
  if(pre.ok) for(const x of parseStr3(pre.text)){const old=by.get(x.boat_number);if(old)await sr.RaceEntry.update(old.id,x);else{const z=await sr.RaceEntry.create({...x,race_id:race.id,race_date:date,venue_code:vc,race_number:rn});by.set(x.boat_number,z);}preCount++;}
  let exCount=0;
  if(tkz.ok) for(const x of parseTkz(tkz.text)){const old=by.get(x.boat_number);if(!old)continue;const u={};for(const [k,v] of Object.entries(x))if(k!=='boat_number'&&v!=null)u[k]=v;if(Object.keys(u).length){await sr.RaceEntry.update(old.id,u);exCount++;}}
  let om={};
  if(od.ok){om=parseOdds(od.text);if(Object.keys(om).length===120){const latest=await sr.OddsSnapshot.filter({race_id:race.id},'-captured_at',1).catch(()=>[]);const last=latest?.[0];if(!last||Date.now()-new Date(last.captured_at).getTime()>120000)await sr.OddsSnapshot.create({race_id:race.id,race_date:date,captured_at:new Date().toISOString(),stage:'5min',all_trifecta_odds:om});}}
  const result=rs1.ok?parseRs1(rs1.text):null; const payout=rs2.ok?parseRs2(rs2.text):null; const now=new Date().toISOString();
  const u={last_updated:now}; if(preCount)u.entries_fetched_at=now;if(exCount){u.exhibition_ready=exCount>=Math.max(1,6-(race.scratched_boats?.length||0));u.beforeinfo_fetched_at=now;}if(Object.keys(om).length===120)u.odds_fetched_at=now;
  if(result?.trifecta){u.status='finished';u.result_trifecta=result.trifecta;if(payout?.trifectaPayout!=null)u.payout_trifecta=payout.trifectaPayout;if(result.weather)u.weather=result.weather;if(result.windSpeed!=null)u.wind_speed=result.windSpeed;if(result.waveHeight!=null)u.wave_height=result.waveHeight;if(result.windDir)u.wind_dir=result.windDir;}
  await sr.Race.update(race.id,u);
  return Response.json({ok:true,source:'BOATCAST',race_id:race.id,pre_race:preCount,exhibition:exCount,odds:Object.keys(om).length,result:result?.trifecta||null,payout:payout?.trifectaPayout??null,stt_ok:stt.ok});
 }catch(e){return Response.json({ok:false,error:e.message},{status:500});}
}
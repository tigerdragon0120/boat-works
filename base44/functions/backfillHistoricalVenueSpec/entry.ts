import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { VENUE_NAMES, parseDaySchedule, parseRacelist, parseSeriesContext, parseBeforeInfo, fetchWithRetry, sleep } from '../../shared/scraper.js';

const BASE='https://www.boatrace.jp/owpc/pc/race';

export default async function(req){
  try{
    const base44=createClientFromRequest(req);
    let user=null; try{user=await base44.auth.me();}catch{}
    if(user && user.role!=='admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});
    const body=await req.json().catch(()=>({}));
    const raceDate=body.race_date;
    const jcd=String(body.jcd||body.venue_code||'').padStart(2,'0');
    if(!raceDate||!jcd) return Response.json({status:'error',message:'race_date,jcd が必要です'},{status:400});
    const hd=raceDate.replace(/-/g,'');
    const now=new Date().toISOString();
    const venueName=VENUE_NAMES[jcd]||jcd;

    const oldProg=(await base44.asServiceRole.entities.HistoricalSpecProgress.filter({race_date:raceDate,venue_code:jcd},'-updated_date',5).catch(()=>[]))[0];
    let progressId=oldProg?.id||null;
    const setProgress=async(data:any)=>{
      if(progressId) return base44.asServiceRole.entities.HistoricalSpecProgress.update(progressId,data);
      const created=await base44.asServiceRole.entities.HistoricalSpecProgress.create({race_date:raceDate,venue_code:jcd,venue_name:venueName,...data});
      progressId=created.id; return created;
    };
    await setProgress({overall_status:'PROCESSING',last_checked_at:now,error_msg:null});

    // 1) 既存の結果一覧を、現在仕様の詳細結果へ格上げする。
    const basicResults=await base44.asServiceRole.entities.RaceResult.filter({race_date:raceDate,venue_code:jcd,data_source:'official'},'race_number',50).catch(()=>[]);
    let detailResult:any={status:'skipped'};
    if(basicResults.length){
      try{ const r=await base44.asServiceRole.functions.invoke('enrichRaceResultDetails',{race_date:raceDate,jcd,force:true}); detailResult=r?.data||r; }
      catch(e:any){ detailResult={status:'error',message:e?.message||String(e)}; }
    }

    // 2) 過去raceindex/racelistを読み、Race + 全6艇RaceEntry + シリーズ文脈を保存。
    let schedule:any[]=[]; let ctx:any=null; let indexError:any=null;
    try{
      const ir=await fetchWithRetry(`${BASE}/raceindex?jcd=${jcd}&hd=${hd}`,{headers:{'User-Agent':'Mozilla/5.0'}},10000,2);
      const html=await ir.text();
      schedule=parseDaySchedule(html,raceDate);
      ctx=parseSeriesContext(html,raceDate);
    }catch(e:any){indexError=e?.message||String(e);}

    const oldRaces=await base44.asServiceRole.entities.Race.filter({race_date:raceDate,venue_code:jcd,data_source:'official'},'race_number',50).catch(()=>[]);
    const raceMap=new Map(oldRaces.map((r:any)=>[Number(r.race_number),r]));
    const saved:any[]=[];
    const seriesKey=`${jcd}_${ctx?.series_start_date||raceDate}`;
    for(const s of schedule){
      const payload:any={
        race_date:raceDate,venue_code:jcd,venue_name:venueName,race_number:Number(s.race_number),deadline:s.deadline,
        event_name:ctx?.event_name||null,grade:ctx?.grade||'GENERAL',series_key:seriesKey,
        series_start_date:ctx?.series_start_date||raceDate,series_end_date:ctx?.series_end_date||raceDate,
        series_total_days:ctx?.series_total_days||1,series_day:ctx?.series_day||1,is_final_day:ctx?.is_final_day===true,
        status:'finished',data_source:'official',last_updated:now,
      };
      const old=raceMap.get(Number(s.race_number));
      try{
        let r;
        if(old) r=await base44.asServiceRole.entities.Race.update(old.id,payload);
        else {
          const dup=await base44.asServiceRole.entities.Race.filter({race_date:raceDate,venue_code:jcd,race_number:Number(s.race_number),data_source:'official'},'-updated_date',5).catch(()=>[]);
          r=dup.length?await base44.asServiceRole.entities.Race.update(dup[0].id,payload):await base44.asServiceRole.entities.Race.create(payload);
        }
        saved.push(r); raceMap.set(Number(s.race_number),r);
      }catch{}
    }

    let entryRaceCount=0;
    for(let i=0;i<saved.length;i+=3){
      const batch=saved.slice(i,i+3);
      await Promise.all(batch.map(async(r:any)=>{
        try{
          const rr=await fetchWithRetry(`${BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`,{headers:{'User-Agent':'Mozilla/5.0'}},10000,2);
          const html=await rr.text(); const p=parseRacelist(html,Number(r.race_number),raceDate);
          if(!p.entries||p.entries.length<6) return;
          await base44.asServiceRole.entities.Race.update(r.id,{race_name:p.raceName,race_phase:p.racePhase||'OTHER',deadline:p.deadline||r.deadline,entries_fetched_at:now,last_updated:now});
          const prevEntries=await base44.asServiceRole.entities.RaceEntry.filter({race_id:r.id},'boat_number',20).catch(()=>[]);
          const prevByBoat=Object.fromEntries(prevEntries.map((e:any)=>[Number(e.boat_number),e]));
          await base44.asServiceRole.entities.RaceEntry.deleteMany({race_id:r.id});
          await base44.asServiceRole.entities.RaceEntry.bulkCreate(p.entries.map((e:any)=>{
            const prev:any=prevByBoat[Number(e.boat_number)]||{};
            return {
              ...e,
              entry_course:prev.entry_course??e.entry_course??null,
              exhibition_time:prev.exhibition_time??e.exhibition_time??null,
              exhibition_rank:prev.exhibition_rank??e.exhibition_rank??null,
              exhibition_st:prev.exhibition_st??e.exhibition_st??null,
              exhibition_st_raw:prev.exhibition_st_raw??e.exhibition_st_raw??null,
              tilt:prev.tilt??e.tilt??null,
              is_scratched:prev.is_scratched===true||e.is_scratched===true,
              race_id:r.id,race_date:raceDate,venue_code:jcd,race_number:r.race_number,
            };
          }));
          entryRaceCount++;
        }catch{}
      }));
      await sleep(250);
    }

    // 3) シリーズ文脈・ポイント表も可能な範囲で過去日に復元。
    let seriesReady=false;
    if(ctx && schedule.length){
      try{
        const sr=await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd});
        const sd=sr?.data||sr; seriesReady=sd?.status==='success'||sd?.status==='partial';
      }catch{}
    }

    // 4) 過去beforeinfoが残っている場合だけ展示まで復元。最初の有効レースで可否を判定し、
    //    公式が返さない場合はUNAVAILABLEとして永久pendingにしない。
    let exhibitionStatus='PENDING'; let exhibitionRaceCount=0;
    if(saved.length){
      let historicalAvailable=false;
      try{
        const probe=saved[0];
        const br=await fetchWithRetry(`${BASE}/beforeinfo?rno=${probe.race_number}&jcd=${jcd}&hd=${hd}`,{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}},10000,1);
        const bh=await br.text(); const bp=parseBeforeInfo(bh);
        historicalAvailable=bp?.exhibition_ready===true;
      }catch{}
      if(!historicalAvailable){ exhibitionStatus='UNAVAILABLE'; }
      else{
        exhibitionStatus='AVAILABLE';
        for(let i=0;i<saved.length;i+=2){
          const batch=saved.slice(i,i+2);
          await Promise.all(batch.map(async(r:any)=>{
            try{
              const br=await fetchWithRetry(`${BASE}/beforeinfo?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`,{headers:{'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'}},10000,1);
              const bp=parseBeforeInfo(await br.text()); if(!bp?.exhibition_ready) return;
              await base44.asServiceRole.entities.Race.update(r.id,{weather:bp.weather,wind_dir:bp.wind_dir,wind_speed:bp.wind_speed,wave_height:bp.wave_height,air_temperature:bp.air_temperature,water_temperature:bp.water_temperature,beforeinfo_fetched_at:now,exhibition_ready:true,scratched_boats:bp.scratched_boats||[],last_updated:now});
              const es=await base44.asServiceRole.entities.RaceEntry.filter({race_id:r.id},'boat_number',20).catch(()=>[]); const by=Object.fromEntries(es.map((e:any)=>[Number(e.boat_number),e]));
              for(const e of bp.entries||[]){ const cur=by[e.boat_number]; if(cur) await base44.asServiceRole.entities.RaceEntry.update(cur.id,{entry_course:e.entry_course,exhibition_time:e.exhibition_time,exhibition_rank:e.exhibition_rank,exhibition_st:e.exhibition_st,exhibition_st_raw:e.exhibition_st_raw,tilt:e.tilt,is_scratched:e.is_scratched===true}); }
              exhibitionRaceCount++;
            }catch{}
          }));
          await sleep(250);
        }
        exhibitionStatus=exhibitionRaceCount>0?'DONE':'ERROR';
      }
    }

    const finalResults=await base44.asServiceRole.entities.RaceResult.filter({race_date:raceDate,venue_code:jcd,data_source:'official'},'race_number',50).catch(()=>[]);
    const detailCount=finalResults.filter((r:any)=>r.detail_fetched_at && Array.isArray(r.start_info) && r.start_info.length>0 && r.winning_method).length;
    const actualResults=finalResults.length;
    // 中止等で結果数が12未満の日もあるため「保存された実結果が全て詳細化」を完了条件とする。
    const resultReady=actualResults>0;
    const detailReady=resultReady && detailCount===actualResults;
    const entryReady=schedule.length>0 && entryRaceCount===schedule.length;
    const seriesContextReady=!!ctx && seriesReady;
    const recoverableComplete=resultReady&&detailReady&&entryReady&&seriesContextReady&&(exhibitionStatus==='DONE'||exhibitionStatus==='UNAVAILABLE');
    const payload={
      result_ready:resultReady,result_detail_ready:detailReady,entry_context_ready:entryReady,series_context_ready:seriesContextReady,
      exhibition_status:exhibitionStatus,results_count:actualResults,detail_count:detailCount,entry_race_count:entryRaceCount,
      series_context_count:seriesContextReady?1:0,exhibition_race_count:exhibitionRaceCount,
      overall_status:recoverableComplete?'COMPLETE':'PARTIAL',last_checked_at:new Date().toISOString(),completed_at:recoverableComplete?new Date().toISOString():null,
      error_msg:indexError||detailResult?.message||null,
    };
    await setProgress(payload);
    return Response.json({status:recoverableComplete?'complete':'partial',race_date:raceDate,venue_code:jcd,venue_name:venueName,...payload,detail_result:detailResult});
  }catch(error:any){ return Response.json({status:'error',message:error?.message||String(error)},{status:500}); }
}

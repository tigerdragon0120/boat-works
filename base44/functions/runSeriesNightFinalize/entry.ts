import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { sleep } from '../../shared/scraper.js';

function jstDateStr(offset=0) {
  const d = new Date(Date.now() + 9*60*60*1000);
  d.setUTCDate(d.getUTCDate()+offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// v10 前夜確定処理。
// 役割を翌日出走表取得から分離し、当日の全結果→詳細→シリーズ指数を先に場単位で確定する。
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user=null; try { user=await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});
    const body = await req.json().catch(()=>({}));
    const raceDate = body.race_date || jstDateStr(Number(body.target_offset || 0));
    const t0=Date.now();

    const venueRes = await base44.asServiceRole.functions.invoke('fetchDailyVenues',{race_date:raceDate});
    const venues = venueRes?.data?.venues || venueRes?.venues || [];
    const outputs:any[]=[];
    let complete=0, partial=0, error=0;

    for (let i=0;i<venues.length;i+=3) {
      const batch=venues.slice(i,i+3);
      const rows=await Promise.all(batch.map(async (jcd)=>{
        let result:any=null, detail:any=null, series:any=null;
        try {
          const r=await base44.asServiceRole.functions.invoke('fetchHistoricalResults',{race_date:raceDate,jcd});
          result=r?.data||r;
          if (result?.status !== 'success' && result?.status !== 'no_races') throw new Error(result?.message||'結果取得失敗');
          const d=await base44.asServiceRole.functions.invoke('enrichRaceResultDetails',{race_date:raceDate,jcd,force:true});
          detail=d?.data||d;
          const s=await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd});
          series=s?.data||s;
          const expected=Number(result?.races||0);
          const enriched=Number(detail?.enriched||0)+Number(detail?.skipped||0);
          const ok = expected===0 || enriched>=expected;
          return {jcd,status:ok?'complete':'partial',result,detail,series};
        } catch(e) {
          return {jcd,status:'error',message:e?.message||String(e),result,detail,series};
        }
      }));
      outputs.push(...rows);
      if (i+3<venues.length) await sleep(250);
    }

    // 一度失敗/不足した場だけ再試行する。成功した場は触らない。
    for (const row of outputs.filter(x=>x.status!=='complete')) {
      try {
        const r=await base44.asServiceRole.functions.invoke('fetchHistoricalResults',{race_date:raceDate,jcd:row.jcd});
        const result=r?.data||r;
        const d=await base44.asServiceRole.functions.invoke('enrichRaceResultDetails',{race_date:raceDate,jcd:row.jcd,force:true});
        const detail=d?.data||d;
        const s=await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd:row.jcd});
        const series=s?.data||s;
        const expected=Number(result?.races||0);
        const enriched=Number(detail?.enriched||0)+Number(detail?.skipped||0);
        row.result=result; row.detail=detail; row.series=series;
        row.status=(expected===0||enriched>=expected)?'complete':'partial';
      } catch(e) { row.status='error'; row.message=e?.message||String(e); }
      await sleep(200);
    }

    for (const r of outputs) {
      if (r.status==='complete') complete++;
      else if (r.status==='partial') partial++;
      else error++;
    }
    return Response.json({
      status:error===0&&partial===0?'complete':'partial',
      race_date:raceDate, venues:venues.length, complete, partial, errors:error,
      venues_detail:outputs,
      elapsed_ms:Date.now()-t0,
    });
  } catch(error) {
    return Response.json({status:'error',message:error?.message||String(error)},{status:500});
  }
}

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
          const scheduled = await base44.asServiceRole.entities.Race.filter({ race_date:raceDate, venue_code:jcd, data_source:'official' }, 'race_number', 50).catch(()=>[]);
          const cancelledCount = scheduled.filter(x=>x.status==='cancelled').length;
          const expected = Math.max(0, scheduled.length - cancelledCount);

          const r=await base44.asServiceRole.functions.invoke('fetchHistoricalResults',{race_date:raceDate,jcd});
          result=r?.data||r;
          if (result?.status !== 'success' && result?.status !== 'no_races') throw new Error(result?.message||'結果取得失敗');
          const d=await base44.asServiceRole.functions.invoke('enrichRaceResultDetails',{race_date:raceDate,jcd,force:true});
          detail=d?.data||d;

          // 今日の展示データも学習資産として残す。過去のオッズ更新で消えた展示欄もここで復元する。
          let beforeinfoRestored=0, beforeinfoErrors=0;
          for (const race of scheduled) {
            try {
              const b=await base44.asServiceRole.functions.invoke('fetchBeforeInfo',{race_date:raceDate,jcd,race_number:race.race_number});
              const bd=b?.data||b;
              if (bd?.status==='success') beforeinfoRestored++;
              else beforeinfoErrors++;
            } catch { beforeinfoErrors++; }
          }

          const detailRows = await base44.asServiceRole.entities.RaceResult.filter({ race_date:raceDate, venue_code:jcd, data_source:'official' }, 'race_number', 50).catch(()=>[]);
          const detailed = detailRows.filter(x => Array.isArray(x.finishers) && x.finishers.length >= 3 && Array.isArray(x.start_info) && x.start_info.length >= 3 && x.race_time_1_seconds != null && !!x.winning_method).length;
          const resultCount = detailRows.length;
          const ok = expected > 0 && resultCount >= expected && detailed >= expected;

          // 節間ポイントはその場の今日分が完全に揃ってからだけ作る。
          if (ok) {
            const s=await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd});
            series=s?.data||s;
          } else {
            series={ status:'waiting', reason:'today_collection_incomplete' };
          }
          return {jcd,status:ok?'complete':'partial',expected_races:expected,result_count:resultCount,detailed_count:detailed,beforeinfo_restored:beforeinfoRestored,beforeinfo_errors:beforeinfoErrors,result,detail,series};
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
        const scheduled = await base44.asServiceRole.entities.Race.filter({ race_date:raceDate, venue_code:row.jcd, data_source:'official' }, 'race_number', 50).catch(()=>[]);
        const cancelledCount = scheduled.filter(x=>x.status==='cancelled').length;
        const expected=Math.max(0,scheduled.length-cancelledCount);
        const r=await base44.asServiceRole.functions.invoke('fetchHistoricalResults',{race_date:raceDate,jcd:row.jcd});
        const result=r?.data||r;
        const d=await base44.asServiceRole.functions.invoke('enrichRaceResultDetails',{race_date:raceDate,jcd:row.jcd,force:true});
        const detail=d?.data||d;
        let beforeinfoRestored=0, beforeinfoErrors=0;
        for (const race of scheduled) {
          try {
            const b=await base44.asServiceRole.functions.invoke('fetchBeforeInfo',{race_date:raceDate,jcd:row.jcd,race_number:race.race_number});
            const bd=b?.data||b;
            if (bd?.status==='success') beforeinfoRestored++;
            else beforeinfoErrors++;
          } catch { beforeinfoErrors++; }
        }
        const detailRows = await base44.asServiceRole.entities.RaceResult.filter({ race_date:raceDate, venue_code:row.jcd, data_source:'official' }, 'race_number', 50).catch(()=>[]);
        const detailed = detailRows.filter(x => Array.isArray(x.finishers) && x.finishers.length >= 3 && Array.isArray(x.start_info) && x.start_info.length >= 3 && x.race_time_1_seconds != null && !!x.winning_method).length;
        const resultCount=detailRows.length;
        const ok=expected>0 && resultCount>=expected && detailed>=expected;
        let series:any={status:'waiting',reason:'today_collection_incomplete'};
        if (ok) {
          const s=await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd:row.jcd});
          series=s?.data||s;
        }
        row.expected_races=expected; row.result_count=resultCount; row.detailed_count=detailed; row.beforeinfo_restored=beforeinfoRestored; row.beforeinfo_errors=beforeinfoErrors;
        row.result=result; row.detail=detail; row.series=series;
        row.status=ok?'complete':'partial';
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

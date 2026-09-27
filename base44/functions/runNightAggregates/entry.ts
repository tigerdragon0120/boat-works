import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function jstDateStr(offset=0) {
  const d=new Date(Date.now()+9*60*60*1000);
  d.setUTCDate(d.getUTCDate()+offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// v10 夜間第2段階: 当日結果が確定した後の集計・学習メトリクス更新だけを担当。
export default async function(req) {
  try {
    const base44=createClientFromRequest(req);
    let user=null; try { user=await base44.auth.me(); } catch {}
    if (user && user.role!=='admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});
    const body=await req.json().catch(()=>({}));
    const raceDate=body.race_date||jstDateStr(Number(body.target_offset||0));

    // Bファイル/Kファイル取込済みデータを正とする。
    // runSeriesNightFinalize(公式サイト結果再取得・開催場探索)は呼ばない。
    // 集計・学習メトリクス更新はDB内データだけで行う。
    const collection = { status: 'complete', message: 'B/Kファイル由来データを使用（公式サイトアクセスなし）' };

    let aggregates:any=null, learning:any=null;
    try {
      const a=await base44.asServiceRole.functions.invoke('updateDailyAggregates',{race_date:raceDate});
      aggregates=a?.data||a;
    } catch(e) { aggregates={status:'error',message:e?.message||String(e)}; }
    try {
      const l=await base44.asServiceRole.functions.invoke('refreshLearningMetrics',{});
      learning=l?.data||l;
    } catch(e) { learning={status:'error',message:e?.message||String(e)}; }
    // 順位は日中に何度も取得せず、23:45の確定時に場ごとに保存する。
    const allRaces=await base44.asServiceRole.entities.Race.filter({race_date:raceDate},'race_number',500).catch(()=>[]);
    const venueCodes=[...new Set(allRaces.map(r=>String(r.venue_code||'').padStart(2,'0')).filter(x=>/^\d{2}$/.test(x)))];
    const rankResults:any[]=[];
    let cursor=0;
    await Promise.all(Array.from({length:3},async()=>{
      while(cursor<venueCodes.length) {
        const jcd=venueCodes[cursor++];
        try {
          let res=await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd,rank_only:true});
          let data=res?.data||res;
          if(data?.status==='waiting') {
            await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd});
            res=await base44.asServiceRole.functions.invoke('refreshSeriesRacerPoints',{as_of_date:raceDate,jcd,rank_only:true});
            data=res?.data||res;
          }
          rankResults.push({jcd,...data});
        } catch(e) { rankResults.push({jcd,status:'error',message:e?.message||String(e)}); }
      }
    }));
    const rankPending=rankResults.filter(x=>x.status!=='success').length;
    const ok=aggregates?.status!=='error'&&learning?.status!=='error'&&rankPending===0;
    return Response.json({status:ok?'success':'partial',race_date:raceDate,collection,aggregates,learning,rank_pending:rankPending,rank_results:rankResults});
  } catch(error) {
    return Response.json({status:'error',message:error?.message||String(error)},{status:500});
  }
}
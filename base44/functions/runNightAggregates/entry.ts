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

    // 今日の全場収集と節間ポイントが揃うまで、集計・学習へ進まない。
    let collection:any=null;
    try {
      const c=await base44.asServiceRole.functions.invoke('runSeriesNightFinalize',{race_date:raceDate});
      collection=c?.data||c;
    } catch(e) {
      collection={status:'error',message:e?.message||String(e)};
    }
    if (collection?.status !== 'complete') {
      return Response.json({status:'waiting_today_collection',race_date:raceDate,collection});
    }

    let aggregates:any=null, learning:any=null;
    try {
      const a=await base44.asServiceRole.functions.invoke('updateDailyAggregates',{race_date:raceDate});
      aggregates=a?.data||a;
    } catch(e) { aggregates={status:'error',message:e?.message||String(e)}; }
    try {
      const l=await base44.asServiceRole.functions.invoke('refreshLearningMetrics',{});
      learning=l?.data||l;
    } catch(e) { learning={status:'error',message:e?.message||String(e)}; }
    const ok=aggregates?.status!=='error'&&learning?.status!=='error';
    return Response.json({status:ok?'success':'partial',race_date:raceDate,collection,aggregates,learning});
  } catch(error) {
    return Response.json({status:'error',message:error?.message||String(error)},{status:500});
  }
}

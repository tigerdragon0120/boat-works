import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';

// BOATCAST経由で翌日分の出走表を事前取得する。
// 旧boatrace.jpスクレイピングはガードで弾かれるため、syncBoatcastDay(target_offset=1)に委譲する。
export default async function(req){
  try{
    const base44=createClientFromRequest(req);
    let user=null; try{user=await base44.auth.me();}catch{}
    if(user && user.role!=='admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});

    const body=await req.json().catch(()=>({}));
    const targetOffset=body.target_offset ?? 1;

    const sync=await base44.asServiceRole.functions.invoke('syncBoatcastDay',{
      target_offset: targetOffset,
      sync_details: false,
    }).catch(e=>({data:{ok:false,error:e?.message||String(e)}}));
    const d=sync?.data||sync;

    let analysis=null;
    if(d?.ok && (d.races_created>0 || d.races_updated>0)) {
      const raceDate=d.date;
      try{
        const a=await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate',{
          race_date: raceDate, stage:'pre', force:true,
        });
        analysis=a?.data||a;
      }catch(e){ analysis={status:'error',message:e?.message||String(e)}; }
    }

    return Response.json({
      status: d?.ok ? (d.venues>0 ? 'success' : 'no_races') : 'error',
      race_date: d?.date || null,
      venues: d?.venues || 0,
      races: (d?.races_created||0) + (d?.races_updated||0),
      entries: (d?.entries_created||0) + (d?.entries_updated||0),
      races_created: d?.races_created || 0,
      entries_created: d?.entries_created || 0,
      analysis,
      error: d?.error || null,
    });
  }catch(e){
    return Response.json({status:'error',message:e?.message||String(e)},{status:500});
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function jstDate(offset=0){const d=new Date(Date.now()+9*3600000);d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);}
function monthsAgo(n){const d=new Date(Date.now()+9*3600000);d.setUTCMonth(d.getUTCMonth()-n);return d.toISOString().slice(0,10);}

export default async function(req){
  try{
    const base44=createClientFromRequest(req);
    let user=null;try{user=await base44.auth.me();}catch{}
    if(user&&user.role!=='admin')return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});
    const body=await req.json().catch(()=>({}));
    const limit=Math.max(1,Math.min(Number(body.limit||4),8));
    const from=body.from_date||monthsAgo(6);
    const to=body.to_date||jstDate(-1);
    const progress=await base44.asServiceRole.entities.FetchProgress.list('-race_date',5000).catch(()=>[]);
    const spec=await base44.asServiceRole.entities.HistoricalSpecProgress.list('-race_date',5000).catch(()=>[]);
    const done=new Set(spec.filter((x:any)=>x.overall_status==='COMPLETE').map((x:any)=>`${x.race_date}_${x.venue_code}`));
    const processing=new Set(spec.filter((x:any)=>x.overall_status==='PROCESSING'&&x.last_checked_at&&Date.now()-new Date(x.last_checked_at).getTime()<45*60*1000).map((x:any)=>`${x.race_date}_${x.venue_code}`));
    const unique=new Map();
    for(const p of progress){
      if(p.venue_code==='00'||!p.race_date||p.race_date<from||p.race_date>to)continue;
      if(!(p.result_fetch_status==='done'||p.status==='done'))continue;
      const k=`${p.race_date}_${p.venue_code}`;
      if(done.has(k)||processing.has(k)||unique.has(k))continue;
      unique.set(k,p);
    }
    // 最近のデータから先に現在仕様へ揃え、分析に効く期間を早く厚くする。
    const candidates=[...unique.values()].sort((a:any,b:any)=>String(b.race_date).localeCompare(String(a.race_date))).slice(0,limit);
    let complete=0,partial=0,errors=0;const details:any[]=[];
    for(const p of candidates){
      try{
        const r=await base44.asServiceRole.functions.invoke('backfillHistoricalVenueSpec',{race_date:p.race_date,jcd:p.venue_code});
        const d=r?.data||r;
        if(d?.status==='complete')complete++;else if(d?.status==='partial')partial++;else errors++;
        details.push({race_date:p.race_date,venue_code:p.venue_code,status:d?.status,results:d?.results_count||0,details:d?.detail_count||0,entries:d?.entry_race_count||0,exhibition:d?.exhibition_status});
      }catch(e:any){errors++;details.push({race_date:p.race_date,venue_code:p.venue_code,status:'error',message:e?.message||String(e)});}
    }
    const remaining=Math.max(0,unique.size-candidates.length);
    return Response.json({status:'success',range:{from,to},processed:candidates.length,complete,partial,errors,remaining_estimate:remaining,details});
  }catch(error:any){return Response.json({status:'error',message:error?.message||String(error)},{status:500});}
}

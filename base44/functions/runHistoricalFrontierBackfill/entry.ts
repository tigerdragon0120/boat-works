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
    // 当日・翌日のライブ収集との競合を防止：過去日のみ処理
    const today=jstDate(0);
    const to=body.to_date||jstDate(-1);
    const safeTo=String(to)<String(today)?to:today;
    const progress=await base44.asServiceRole.entities.FetchProgress.list('-race_date',5000).catch(()=>[]);
    const spec=await base44.asServiceRole.entities.HistoricalSpecProgress.list('-race_date',5000).catch(()=>[]);
    const done=new Set(spec.filter((x:any)=>x.overall_status==='COMPLETE').map((x:any)=>`${x.race_date}_${x.venue_code}`));
    const processing=new Set(spec.filter((x:any)=>x.overall_status==='PROCESSING'&&x.last_checked_at&&Date.now()-new Date(x.last_checked_at).getTime()<45*60*1000).map((x:any)=>`${x.race_date}_${x.venue_code}`));
    const unique=new Map();
    for(const p of progress){
      if(p.venue_code==='00'||!p.race_date||p.race_date<from||p.race_date>safeTo)continue;
      if(!(p.result_fetch_status==='done'||p.status==='done'))continue;
      const k=`${p.race_date}_${p.venue_code}`;
      if(done.has(k)||processing.has(k)||unique.has(k))continue;
      unique.set(k,p);
    }

    // Raceの最古日を前線に固定し、その日を開催場単位で埋め切ってから1日前へ進む。
    const oldestRace=(await base44.asServiceRole.entities.Race.filter(
      {data_source:'official',race_date:{$gte:from,$lte:safeTo}},'race_date',1
    ).catch(()=>[]))[0];
    const frontier=oldestRace?.race_date||safeTo;
    const eligible=[...unique.values()].filter((p:any)=>String(p.race_date)<=String(frontier));
    const dates=[...new Set(eligible.map((p:any)=>String(p.race_date)))].sort((a:any,b:any)=>String(b).localeCompare(String(a)));
    const targetDate=dates.includes(String(frontier))?String(frontier):(dates.find((d:any)=>String(d)<String(frontier))||null);
    const candidates=targetDate
      ? eligible.filter((p:any)=>String(p.race_date)===targetDate).sort((a:any,b:any)=>String(a.venue_code).localeCompare(String(b.venue_code))).slice(0,limit)
      : [];

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
    return Response.json({status:'success',mode:'frontier',range:{from,to},frontier_date:frontier,target_date:targetDate,processed:candidates.length,complete,partial,errors,remaining_estimate:remaining,details});
  }catch(error:any){return Response.json({status:'error',message:error?.message||String(error)},{status:500});}
}
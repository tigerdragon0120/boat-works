import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
function jstDate(){return new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
export default async function(req){
 try{
  const b=createClientFromRequest(req); const user=await b.auth.me().catch(()=>null);
  if(user&&user.role!=='admin') return Response.json({ok:false,error:'Forbidden'},{status:403});
  const body=await req.json().catch(()=>({})); const raceDate=body.race_date||jstDate(); const sr=b.asServiceRole;
  const races=await sr.entities.Race.filter({race_date:raceDate},'deadline',500).catch(()=>[]);
  const now=Date.now();
  const targets=races.filter(r=>{
    const d=r.deadline?new Date(r.deadline).getTime():NaN;
    return Number.isFinite(d)&&d<=now&&(!r.result_trifecta||r.payout_trifecta==null||!r.exhibition_ready);
  }).sort((a,b)=>new Date(a.deadline).getTime()-new Date(b.deadline).getTime()).slice(0,60);
  let ok=0,failed=0,withResult=0,withExhibition=0;
  for(let i=0;i<targets.length;i+=6){
    const batch=targets.slice(i,i+6);
    const rr=await Promise.all(batch.map(r=>sr.functions.invoke('syncBoatcastRace',{race_date:raceDate,venue_code:String(r.venue_code).padStart(2,'0'),race_number:Number(r.race_number)}).catch(e=>({error:e.message}))));
    for(const x of rr){const d=x?.data||x;if(d?.ok){ok++;if(d.result)withResult++;if(d.exhibition>0)withExhibition++;}else failed++;}
  }
  return Response.json({ok:true,race_date:raceDate,candidates:targets.length,synced:ok,failed,with_result:withResult,with_exhibition:withExhibition});
 }catch(e){return Response.json({ok:false,error:e.message},{status:500});}
}
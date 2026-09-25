import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
function jstDate(){return new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
export default async function(req){
 try{
  const base44=createClientFromRequest(req); let user=null; try{user=await base44.auth.me();}catch{}
  if(user&&user.role!=='admin')return Response.json({ok:false,error:'管理者権限が必要です'},{status:403});
  const raceDate=jstDate();
  // まず出走表/Raceを軽量同期。展示等は下で個別同期する。
  await base44.asServiceRole.functions.invoke('syncBoatcastDay',{target_offset:0,sync_details:false}).catch(()=>null);
  const races=await base44.asServiceRole.entities.Race.filter({race_date:raceDate},'deadline',500).catch(()=>[]);
  const now=Date.now(), horizon=now+90*60*1000;
  // 展示欠落・結果未反映を最優先。締切90分前までのレースを対象にし、毎回最大36Rを回復。
  const targets=races.filter(r=>{
   const d=r.deadline?new Date(r.deadline).getTime():NaN;
   if(!Number.isFinite(d)) return !r.exhibition_ready;
   return d<=horizon && (!r.exhibition_ready || r.status!=='finished' || !r.result_trifecta);
  }).sort((a,b)=>{
   const ap=!a.exhibition_ready?0:1,bp=!b.exhibition_ready?0:1;if(ap!==bp)return ap-bp;
   return new Date(a.deadline||0).getTime()-new Date(b.deadline||0).getTime();
  }).slice(0,36);
  let ok=0,failed=0;
  for(let i=0;i<targets.length;i+=6){
   const batch=targets.slice(i,i+6);
   const rr=await Promise.all(batch.map(r=>base44.asServiceRole.functions.invoke('syncBoatcastRace',{race_date:raceDate,venue_code:String(r.venue_code).padStart(2,'0'),race_number:Number(r.race_number)}).catch(e=>({error:e.message}))));
   for(const x of rr){const d=x?.data||x;if(d?.ok)ok++;else failed++;}
  }
  return Response.json({ok:true,race_date:raceDate,races:races.length,targets:targets.length,synced:ok,failed});
 }catch(e){return Response.json({ok:false,error:e.message},{status:500});}
}
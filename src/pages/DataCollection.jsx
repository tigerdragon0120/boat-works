import { useEffect, useMemo, useState } from "react";
import { Database, RefreshCw, CheckCircle2, Clock3, XCircle, Sunrise, Sun, Moon, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";

function jstDate(offset=0){ const d=new Date(Date.now()+9*3600000); d.setUTCDate(d.getUTCDate()+offset); return d.toISOString().slice(0,10); }
function fmt(v){ if(!v) return "—"; try{return new Intl.DateTimeFormat("ja-JP",{hour:"2-digit",minute:"2-digit",month:"numeric",day:"numeric",timeZone:"Asia/Tokyo"}).format(new Date(v));}catch{return "—";} }
const slotMeta={morning:{label:"モーニング",Icon:Sunrise},day:{label:"通常",Icon:Sun},night:{label:"ナイター",Icon:Moon}};

export default function DataCollection(){
  const [tab,setTab]=useState("tomorrow");
  const [loading,setLoading]=useState(true);
  const [rows,setRows]=useState([]);
  const [races,setRaces]=useState([]);
  const [analyses,setAnalyses]=useState([]);
  const [series,setSeries]=useState([]);
  const [error,setError]=useState("");
  const date=tab==="today"?jstDate(0):jstDate(1);

  async function load(){
    setLoading(true); setError("");
    try{
      const [rd,rr,aa,sp]=await Promise.all([
        base44.entities.VenueDayReadiness.filter({race_date:date},"first_deadline",100).catch(()=>[]),
        base44.entities.Race.filter({race_date:date,data_source:"official"},"deadline",300).catch(()=>[]),
        base44.entities.UichiAnalysis.filter({race_date:date,stage:"pre"},"race_number",500).catch(()=>[]),
        base44.entities.SeriesRacerPoint.filter({as_of_date:{"$lt":date}},"-as_of_date",1000).catch(()=>[]),
      ]);
      setRows(rd); setRaces(rr); setAnalyses(aa); setSeries(sp);
    }catch(e){setError(e?.message||"取得に失敗しました");}
    finally{setLoading(false);}
  }
  useEffect(()=>{load(); const t=setInterval(load,30000); return()=>clearInterval(t);},[date]);

  const venues=useMemo(()=>{
    const by={};
    for(const r of races){
      if(!by[r.venue_code]) by[r.venue_code]={venue_code:r.venue_code,venue_name:r.venue_name,races:[],first_deadline:r.deadline};
      by[r.venue_code].races.push(r);
      if(r.deadline && (!by[r.venue_code].first_deadline || new Date(r.deadline)<new Date(by[r.venue_code].first_deadline))) by[r.venue_code].first_deadline=r.deadline;
    }
    const readyMap=Object.fromEntries(rows.map(x=>[x.venue_code,x]));
    const anCount={}; for(const a of analyses) anCount[a.venue_code]=(anCount[a.venue_code]||0)+1;
    return Object.values(by).map(v=>{
      const rd=readyMap[v.venue_code]||{};
      const nums=new Set(v.races.map(r=>Number(r.race_number)));
      const racesComplete=v.races.length===12 && Array.from({length:12},(_,i)=>i+1).every(n=>nums.has(n));
      const coreComplete=v.races.filter(r=>r.race_name&&r.deadline&&r.series_key).length;
      const slot=rd.time_slot || (()=>{const h=new Date(v.first_deadline).getHours(); return h<10?"morning":h>=14?"night":"day";})();
      const seriesKeys=[...new Set(v.races.map(r=>r.series_key).filter(Boolean))];
      const seriesReady=v.races.every(r=>Number(r.series_day||1)<=1) || series.some(p=>seriesKeys.includes(p.series_key));
      const alertsComplete=(anCount[v.venue_code]||0)>=12;
      const previousDone=rd.series_points_ready===true || seriesReady;
      const complete=racesComplete&&coreComplete===12&&previousDone&&alertsComplete;
      const missing=[];
      if(!racesComplete) missing.push(`翌日出走表 ${v.races.length}/12R`);
      if(coreComplete<12) missing.push(`レース基本情報 ${coreComplete}/12R`);
      if(!previousDone) missing.push("前日結果・節間ポイント");
      if(!alertsComplete) missing.push(`翌日アラート分析 ${anCount[v.venue_code]||0}/12R`);
      return {...v,...rd,time_slot:slot,racesComplete,coreComplete,seriesReady:previousDone,analysisCount:anCount[v.venue_code]||0,alertsComplete,complete,missing};
    }).sort((a,b)=>new Date(a.first_deadline)-new Date(b.first_deadline));
  },[rows,races,analyses,series]);

  const done=venues.filter(v=>v.complete).length;
  const morning=venues.filter(v=>v.time_slot==="morning");
  const beforeStartOk=venues.filter(v=>v.complete && new Date(v.baseline_captured_at||v.collection_completed_at||0)<new Date(v.first_deadline)).length;

  return <div className="space-y-5">
    <div className="flex items-center gap-2"><Database className="w-5 h-5 text-primary"/><div><h1 className="text-xl font-bold">データ収集状況</h1><p className="text-xs text-muted-foreground">競艇場ごとに「レース開始前に必要データが揃ったか」を監視します</p></div><button onClick={load} className="ml-auto p-2 rounded-xl border border-border bg-card"><RefreshCw className={cn("w-4 h-4",loading&&"animate-spin")}/></button></div>

    <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-card border border-border">
      <button onClick={()=>setTab("today")} className={cn("py-2.5 rounded-xl text-sm font-bold",tab==="today"?"bg-primary text-white":"text-muted-foreground")}>今日</button>
      <button onClick={()=>setTab("tomorrow")} className={cn("py-2.5 rounded-xl text-sm font-bold",tab==="tomorrow"?"bg-primary text-white":"text-muted-foreground")}>明日</button>
    </div>

    {error&&<div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-sm text-rose-600">{error}</div>}
    <div className="grid grid-cols-3 gap-2">
      <Summary label="開催場" value={`${venues.length}場`}/><Summary label="全工程完了" value={`${done}/${venues.length}`} good={done===venues.length&&venues.length>0}/><Summary label="開始前完了" value={`${beforeStartOk}/${venues.length}`} good={beforeStartOk===venues.length&&venues.length>0}/>
    </div>

    {morning.length>0&&morning.some(v=>!v.complete)&&<div className="flex gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="w-5 h-5 shrink-0"/><div><b>モーニング場を最優先で収集中</b><div className="text-xs mt-0.5">{morning.filter(v=>!v.complete).map(v=>v.venue_name).join("・")} がまだ全工程完了していません。</div></div></div>}

    <div className="space-y-3">
      {venues.map(v=><VenueCard key={v.venue_code} v={v}/>) }
      {!loading&&venues.length===0&&<div className="p-8 text-center border border-dashed rounded-2xl text-muted-foreground">この日の開催データはまだありません</div>}
    </div>
    <div className="text-[11px] text-muted-foreground text-center">30秒ごとに自動更新</div>
  </div>;
}

function VenueCard({v}){ const meta=slotMeta[v.time_slot]||slotMeta.day; const Icon=meta.Icon; return <div className={cn("rounded-2xl border bg-card p-4",v.complete?"border-emerald-300":"border-amber-200")}>
  <div className="flex items-start gap-3"><div className={cn("w-10 h-10 rounded-xl flex items-center justify-center",v.complete?"bg-emerald-50 text-emerald-600":"bg-amber-50 text-amber-600")}><Icon className="w-5 h-5"/></div><div className="flex-1"><div className="flex items-center gap-2"><h2 className="font-bold">{v.venue_name}</h2><span className="text-[10px] px-2 py-0.5 rounded-full bg-muted">{meta.label}</span><span className="text-xs text-muted-foreground">1R {fmt(v.first_deadline)}</span></div><div className={cn("text-xs font-bold mt-1",v.complete?"text-emerald-600":"text-amber-600")}>{v.complete?"✓ レース開始前データ準備完了":"収集中・未完了あり"}</div></div></div>
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
    <Step label="翌日出走表" ok={v.racesComplete} sub={`${v.races.length}/12R`}/>
    <Step label="基本情報" ok={v.coreComplete===12} sub={`${v.coreComplete}/12R`}/>
    <Step label="前日結果・節間P" ok={v.seriesReady} sub={v.seriesReady?"完了":"未完了"}/>
    <Step label="翌日アラート" ok={v.alertsComplete} sub={`${v.analysisCount}/12R`}/>
  </div>
  {v.missing?.length>0&&<div className="mt-3 rounded-xl bg-rose-50/70 px-3 py-2 text-xs text-rose-700"><b>未取得：</b>{v.missing.join(" ／ ")}</div>}
  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground"><span>収集完了 {fmt(v.collection_completed_at)}</span><span>展示前基準点 {fmt(v.baseline_captured_at)}</span><span>最終確認 {fmt(v.last_checked_at)}</span></div>
</div> }
function Step({label,ok,sub}){return <div className={cn("rounded-xl border p-2.5",ok?"border-emerald-200 bg-emerald-50/60":"border-rose-200 bg-rose-50/60")}><div className="flex items-center gap-1.5 text-xs font-semibold">{ok?<CheckCircle2 className="w-3.5 h-3.5 text-emerald-600"/>:<XCircle className="w-3.5 h-3.5 text-rose-500"/>}{label}</div><div className={cn("mt-1 text-xs tabular-nums",ok?"text-emerald-700":"text-rose-600")}>{sub}</div></div>}
function Summary({label,value,good}){return <div className="rounded-2xl border border-border bg-card p-3"><div className="text-[10px] text-muted-foreground">{label}</div><div className={cn("text-xl font-bold mt-1",good&&"text-emerald-600")}>{value}</div></div>}

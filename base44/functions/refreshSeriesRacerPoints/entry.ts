import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { VENUE_NAMES, fetchBoatcastText, parseStr3 } from '../../shared/boatcastSync.js';
import { computeSeriesRacerScore, computeRankPressureScore, SERIES_SCORE_VERSION } from '../../shared/seriesScore.js';

function parseScoreRate(text) {
  const lines=String(text||'').split(/\r?\n/).filter(x=>x.trim());
  if(lines[0]==='data=') lines.shift();
  if(lines[0]!=='1') return [];
  return lines.slice(1,7).map(line=>{
    const p=line.split('\t');
    const rank=/^\d+$/.test(p[6]||'') ? Number(p[6]) : null;
    const point_rate=/^\d+(?:\.\d+)?$/.test(p[5]||'') ? Number(p[5]) : null;
    return /^\d{4}$/.test(p[2]||'') ? {registration_number:p[2],rank:rank>0?rank:null,point_rate} : null;
  }).filter(Boolean);
}
async function fetchScoreRate(jcd,date,raceNumber) {
  const day=date.replace(/-/g,'');
  const url=`https://race.boatcast.jp/hp_txt/${jcd}/bc_j_tokuten_hayami_${day}_${jcd}_${raceNumber}.txt`;
  const res=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(10000)});
  if(!res.ok) throw new Error(`得点率早見 HTTP ${res.status}`);
  return parseScoreRate(await res.text());
}

// STR3の今節成績を使用。日程を推定せず、日付別スナップショットとして保存する。
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({ status:'error', message:'管理者権限が必要です' }, { status:403 });
    const body = await req.json().catch(() => ({}));
    const asOfDate = body.as_of_date;
    const captureRank = body.capture_rank === true;
    const jcd = String(body.jcd || '').padStart(2,'0');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate || '') || !VENUE_NAMES[jcd])
      return Response.json({ status:'error', message:'as_of_date と jcd が必要です' }, { status:400 });
    const races = await base44.asServiceRole.entities.Race.filter({race_date:asOfDate,venue_code:jcd},'race_number',100);
    const raceNumbers = [...new Set(races.map(r=>Number(r.race_number)).filter(n=>n>=1 && n<=12))];
    if (!raceNumbers.length) throw new Error('本日の開催データがありません');
    const byReg = new Map();
    const failed = [];
    const standings = new Map();
    let standingsAvailable = 0;
    const standingsErrors = [];
    let next = 0;
    await Promise.all(Array.from({length:3},async()=>{
      while(next < raceNumbers.length) {
        const rn = raceNumbers[next++];
        try {
          const source = await fetchBoatcastText({type:'STR3',venueCode:jcd,raceDate:asOfDate,raceNumber:rn,force:true});
          if (!source.ok) throw new Error('出走表取得失敗');
          const entries = parseStr3(source.text);
          if (!entries.length) throw new Error('出走表なし');
          for(const entry of entries) {
            if (!/^\d{4}$/.test(entry.registration_number)) continue;
            let racer = byReg.get(entry.registration_number);
            if (!racer) { racer={entry,history:new Map()};byReg.set(entry.registration_number,racer); }
            // 空欄の走も残っているため、2枠を1日として今節何日目かを識別できる。
            for(const [index,raw] of String(entry.season_record || '').split('|').entries()) {
              const fields=raw.split(',');
              if(fields.length!==5) continue;
              const [race,lane,course,stRaw,finishRaw]=fields.map(x=>x.trim());
              const finish=Number(finishRaw.replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0)));
              if(!(Number(race)>=1 && Number(race)<=12 && Number(lane)>=1 && Number(lane)<=6 && finish>=1 && finish<=6)) continue;
              const st=/^\.?\d+$/.test(stRaw) ? Number(stRaw) : null;
              const day=Math.floor(index/2)+1;
              racer.history.set(day+'_'+race,{
                series_day:day,race_number:Number(race),lane:Number(lane),finish,
                start_course:Number(course)||null,st,st_raw:stRaw,
                racer_name:entry.racer_name,
              });
            }
          }
        } catch { failed.push(rn); }
        if (captureRank) try {
          const rows=await fetchScoreRate(jcd,asOfDate,rn);
          if(rows.length) {
            standingsAvailable++;
            for(const row of rows) if(row.rank!=null || row.point_rate!=null) standings.set(row.registration_number,row);
          }
        } catch (error) { standingsErrors.push(`${rn}R: ${error?.message || error}`); } // 出走表の集計と独立して取得
      }
    }));
    if (!byReg.size) throw new Error('BOATCASTの今節成績を取得できませんでした');
    const fields = new Map();
    for(const racer of byReg.values()) for(const h of racer.history.values()) {
      const key=h.series_day+'_'+h.race_number;
      if(!fields.has(key)) fields.set(key,new Map());
      fields.get(key).set(h.lane,h.st);
    }
    const key='boatcast_'+jcd+'_'+asOfDate;
    const now=new Date().toISOString();
    const existing=await base44.asServiceRole.entities.SeriesRacerPoint.filter({series_key:key,as_of_date:asOfDate},'registration_number',100);
    const existingByReg=new Map(existing.map(x=>[String(x.registration_number),x]));
    let saved=0;
    const toCreate=[];
    const toUpdate=[];
    for(const [reg,racer] of byReg) {
      const hist=[...racer.history.values()].sort((a,b)=>a.series_day-b.series_day || a.race_number-b.race_number);
      for(const h of hist) {
        const field=fields.get(h.series_day+'_'+h.race_number);
        const starts=[...field.values()].filter(x=>x!=null && x>=0);
        const avg=field.size===6 && starts.length===6 ? starts.reduce((a,b)=>a+b,0)/6 : null;
        h.field_avg_st=avg;h.st_advantage=avg!=null && h.st!=null ? Math.round((avg-h.st)*1000)/1000 : null;
      }
      const score=computeSeriesRacerScore({laneFinishHistory:hist});
      const payload={
        series_key:key,venue_code:jcd,venue_name:VENUE_NAMES[jcd],as_of_date:asOfDate,
        registration_number:reg,racer_name:racer.entry.racer_name,grade_class:racer.entry.grade_class,
        races_run:hist.length,lane_history:hist.map(h=>h.lane),finish_history:hist.map(h=>h.finish),
        lane_finish_history:hist,...score,
        score_reasons:[...score.score_reasons,'BOATCAST今節成績で集計（着差・公式得点率は未取得）',...(failed.length?['一部の出走表未取得・暫定集計']:[])],
        snapshot_at:now,algorithm_version:SERIES_SCORE_VERSION+'-boatcast',
      };
      const old=existingByReg.get(reg);
      const official=standings.get(reg);
      if(official?.rank!=null) { payload.rank=official.rank; payload.rank_snapshot_at=now; }
      else if(old?.rank!=null) { payload.rank=old.rank; if(old.rank_snapshot_at) payload.rank_snapshot_at=old.rank_snapshot_at; }
      if(official?.point_rate!=null) payload.point_rate=official.point_rate;
      else if(old?.point_rate!=null) payload.point_rate=old.point_rate;
      if(payload.rank!=null) {
        payload.rank_pressure_score=computeRankPressureScore({rank:payload.rank,qualifyingCut:18});
        payload.score_reasons=payload.score_reasons.filter(x=>!x.includes('公式得点率は未取得'));
        payload.score_reasons.push(official ? 'BOATCAST得点率早見の公式順位' : '前回取得した公式順位（今回未更新）');
      }
      if(old) toUpdate.push({id:old.id,...payload});
      else toCreate.push(payload);
      saved++;
    }
    if(toUpdate.length) await base44.asServiceRole.entities.SeriesRacerPoint.bulkUpdate(toUpdate);
    if(toCreate.length) await base44.asServiceRole.entities.SeriesRacerPoint.bulkCreate(toCreate);
    return Response.json({status:failed.length || (captureRank && standingsAvailable<raceNumbers.length)?'partial':'success',missing_details:failed.length,capture_rank:captureRank,
      racers:saved,ranked_racers:[...standings.values()].filter(x=>x.rank!=null).length,standings_races:standingsAvailable,standings_errors:standingsErrors.slice(0,12),series_key:key,as_of_date:asOfDate,venue_code:jcd,venue_name:VENUE_NAMES[jcd], implementation:'boatcast-series-20260927'});
  } catch(error) {
    return Response.json({status:'error',message:error?.message || String(error),implementation:'boatcast-series-20260927'},{status:500});
  }
});
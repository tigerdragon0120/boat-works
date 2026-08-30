import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function jstDateStr(offset=0) {
  const d=new Date(Date.now()+9*60*60*1000);
  d.setUTCDate(d.getUTCDate()+offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function timeSlotFromDeadline(deadline) {
  if (!deadline) return 'day';
  const d=new Date(deadline);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',hour:'2-digit',hour12:false}).formatToParts(d);
  const hour=Number(parts.find(x=>x.type==='hour')?.value || 12);
  // 第1R締切基準。モーニングは概ね8〜9時台、通常は10〜13時台、ナイターは14時以降開始。
  if (hour < 10) return 'morning';
  if (hour < 14) return 'day';
  return 'night';
}

function coreEntryOk(e) {
  return !!e && Number(e.boat_number) >= 1 && Number(e.boat_number) <= 6
    && /^\d{4}$/.test(String(e.registration_number || ''))
    && !!e.racer_name && e.motor_number != null;
}

export default async function(req) {
  try {
    const base44=createClientFromRequest(req);
    let user=null; try { user=await base44.auth.me(); } catch {}
    if (user && user.role!=='admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});

    const body=await req.json().catch(()=>({}));
    const targetOffset=Number(body.target_offset ?? 0);
    const raceDate=body.race_date || jstDateStr(targetOffset);
    const t0=Date.now();

    // まず対象日のRace/出走表を徹底収集。ここでは分析を一切しない。
    const sync=await base44.asServiceRole.functions.invoke('runRaceDayIntegritySync',{
      race_date:raceDate, stage:'pre', collect_only:true,
    }).catch(e=>({data:{status:'error',message:e?.message||String(e)}}));
    const syncData=sync?.data||sync;

    const [races,entries,preAnalyses,seriesPoints,readinessRows]=await Promise.all([
      base44.asServiceRole.entities.Race.filter({race_date:raceDate,data_source:'official'},'deadline',500).catch(()=>[]),
      base44.asServiceRole.entities.RaceEntry.filter({race_date:raceDate},'boat_number',5000).catch(()=>[]),
      base44.asServiceRole.entities.UichiAnalysis.filter({race_date:raceDate,stage:'pre'},'-captured_at',500).catch(()=>[]),
      base44.asServiceRole.entities.SeriesRacerPoint.filter({as_of_date:{$lt:raceDate}},'-as_of_date',3000).catch(()=>[]),
      base44.asServiceRole.entities.VenueDayReadiness.filter({race_date:raceDate},'venue_code',100).catch(()=>[]),
    ]);

    const entriesByRace=new Map();
    for (const e of entries) {
      if (!entriesByRace.has(e.race_id)) entriesByRace.set(e.race_id,[]);
      entriesByRace.get(e.race_id).push(e);
    }
    const analysisByRace=new Map();
    for (const a of preAnalyses) if (!analysisByRace.has(a.race_id)) analysisByRace.set(a.race_id,a);
    const readinessByVenue=new Map(readinessRows.map(x=>[String(x.venue_code).padStart(2,'0'),x]));
    const seriesPointKeySet=new Set(seriesPoints.map(x=>x.series_key).filter(Boolean));

    const byVenue=new Map();
    for (const r of races) {
      const jcd=String(r.venue_code).padStart(2,'0');
      if (!byVenue.has(jcd)) byVenue.set(jcd,[]);
      byVenue.get(jcd).push(r);
    }

    const venueStates=[];
    const priority={morning:0,day:1,night:2};
    for (const [jcd,venueRacesRaw] of byVenue.entries()) {
      const venueRaces=[...venueRacesRaw].sort((a,b)=>Number(a.race_number)-Number(b.race_number));
      const first=venueRaces[0];
      const slot=timeSlotFromDeadline(first?.deadline);
      const expected=12;
      let completeEntries=0,coreComplete=0;
      const missing=[];
      for (let rn=1;rn<=expected;rn++) {
        const r=venueRaces.find(x=>Number(x.race_number)===rn);
        if (!r) { missing.push(rn); continue; }
        const es=entriesByRace.get(r.id)||[];
        if (es.length>=6) completeEntries++;
        if (es.length>=6 && es.every(coreEntryOk) && !!r.deadline && !!r.race_name && !!r.series_key) coreComplete++;
        else if (!missing.includes(rn)) missing.push(rn);
      }
      const seriesDay=Number(first?.series_day||1);
      const seriesReady=seriesDay<=1 || (!!first?.series_key && seriesPointKeySet.has(first.series_key));
      const collectionComplete=venueRaces.length===expected && completeEntries===expected && coreComplete===expected && seriesReady;
      const exhibitionAlreadyStarted=venueRaces.some(r=>r.exhibition_ready===true)
        || venueRaces.some(r=>(entriesByRace.get(r.id)||[]).some(e=>e.exhibition_time!=null || e.exhibition_st!=null));
      const existing=readinessByVenue.get(jcd);
      let status=existing?.collection_status || 'WAITING';
      let baselineCapturedAt=existing?.baseline_captured_at || null;
      let collectionCompletedAt=existing?.collection_completed_at || null;
      const notes=[];

      if (collectionComplete && !collectionCompletedAt) collectionCompletedAt=new Date().toISOString();
      if (!collectionComplete) status='WAITING';
      else if (!baselineCapturedAt && exhibitionAlreadyStarted) {
        status='LATE_BASELINE';
        notes.push('展示情報が入る前の完全基準点を作れなかったため、この場は前日アラート対象外');
      } else if (baselineCapturedAt) status='BASELINE_CAPTURED';
      else status='COMPLETE';

      // 全12RのRaceに場区分を付与。モーニング/通常/ナイターを後続処理でも利用する。
      for (const r of venueRaces) {
        if (r.time_slot !== slot) await base44.asServiceRole.entities.Race.update(r.id,{time_slot:slot});
      }

      const payload={
        race_date:raceDate, venue_code:jcd, venue_name:first?.venue_name || jcd,
        time_slot:slot, first_deadline:first?.deadline || null,
        expected_races:expected, races_collected:venueRaces.length,
        complete_entry_races:completeEntries, core_complete_races:coreComplete,
        series_points_ready:seriesReady, collection_status:status,
        collection_completed_at:collectionCompletedAt,
        baseline_captured_at:baselineCapturedAt,
        last_checked_at:new Date().toISOString(), missing_races:missing,
        notes,
      };
      if (existing) await base44.asServiceRole.entities.VenueDayReadiness.update(existing.id,payload);
      else {
        const created=await base44.asServiceRole.entities.VenueDayReadiness.create(payload);
        readinessByVenue.set(jcd,created);
      }

      venueStates.push({jcd,venue_name:first?.venue_name||jcd,slot,collectionComplete,seriesReady,exhibitionAlreadyStarted,status,missing,venueRaces});
    }

    // モーニング→通常→ナイターの順で基準点分析。場の12R全部が揃った場合のみ実行。
    venueStates.sort((a,b)=>priority[a.slot]-priority[b.slot]);
    const analyzedVenues=[];
    for (const v of venueStates) {
      if (!v.collectionComplete || v.status==='LATE_BASELINE' || v.status==='BASELINE_CAPTURED') continue;
      const ids=v.venueRaces.map(r=>r.id);
      try {
        const a=await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate',{
          race_date:raceDate,stage:'pre',race_ids:ids,force:true,venue_complete_required:true,
        });
        const ad=a?.data||a;
        const after=await base44.asServiceRole.entities.UichiAnalysis.filter({race_date:raceDate,venue_code:v.jcd,stage:'pre'},'-captured_at',100).catch(()=>[]);
        const uniq=new Set(after.map(x=>x.race_id));
        if (uniq.size>=12 && Number(ad?.errors||0)===0) {
          const now=new Date().toISOString();
          const rd=readinessByVenue.get(v.jcd) || (await base44.asServiceRole.entities.VenueDayReadiness.filter({race_date:raceDate,venue_code:v.jcd},'-updated_date',5))[0];
          if (rd) await base44.asServiceRole.entities.VenueDayReadiness.update(rd.id,{collection_status:'BASELINE_CAPTURED',baseline_captured_at:now,last_checked_at:now});
          analyzedVenues.push({venue_code:v.jcd,venue_name:v.venue_name,time_slot:v.slot,status:'BASELINE_CAPTURED',analyzed:ad?.analyzed||0});
        } else analyzedVenues.push({venue_code:v.jcd,venue_name:v.venue_name,time_slot:v.slot,status:'ANALYSIS_PARTIAL',detail:ad});
      } catch(e) {
        analyzedVenues.push({venue_code:v.jcd,venue_name:v.venue_name,time_slot:v.slot,status:'ERROR',message:e?.message||String(e)});
      }
    }

    const finalReadiness=await base44.asServiceRole.entities.VenueDayReadiness.filter({race_date:raceDate},'first_deadline',100).catch(()=>[]);
    return Response.json({
      status:'success', race_date:raceDate,
      sync:syncData,
      venues:finalReadiness.length,
      morning:finalReadiness.filter(x=>x.time_slot==='morning').length,
      day:finalReadiness.filter(x=>x.time_slot==='day').length,
      night:finalReadiness.filter(x=>x.time_slot==='night').length,
      baseline_captured:finalReadiness.filter(x=>x.collection_status==='BASELINE_CAPTURED').length,
      waiting:finalReadiness.filter(x=>x.collection_status==='WAITING').length,
      late_baseline:finalReadiness.filter(x=>x.collection_status==='LATE_BASELINE').length,
      venue_status:finalReadiness.map(x=>({venue_code:x.venue_code,venue_name:x.venue_name,time_slot:x.time_slot,status:x.collection_status,races:x.races_collected,entries:x.complete_entry_races,core:x.core_complete_races,series_points_ready:x.series_points_ready,first_deadline:x.first_deadline,missing_races:x.missing_races||[]})),
      analyzed_venues:analyzedVenues,
      elapsed_ms:Date.now()-t0,
    });
  } catch(error) {
    return Response.json({status:'error',message:error?.message||String(error)},{status:500});
  }
}

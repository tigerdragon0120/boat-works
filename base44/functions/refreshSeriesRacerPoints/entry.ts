import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { VENUE_NAMES, parseSeriesContext, parsePointRank, fetchWithRetry } from '../../shared/scraper.js';
import { computeSeriesRacerScore, computeRankPressureScore, SERIES_SCORE_VERSION } from '../../shared/seriesScore.js';

const BASE = 'https://www.boatrace.jp/owpc/pc/race';
const CONTEXT_VERSION = 'v10';

function isBetween(date, start, end) { return date >= start && date <= end; }

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({ status:'error', message:'管理者権限が必要です' }, { status:403 });

    const body = await req.json().catch(() => ({}));
    const asOfDate = body.as_of_date;
    const jcd = String(body.jcd || '').padStart(2,'0');
    if (!asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || !/^\d{2}$/.test(jcd)) {
      return Response.json({ status:'error', message:'as_of_date と jcd が必要です' }, { status:400 });
    }

    const hd = asOfDate.replace(/-/g,'');
    const raceIndexRes = await fetchWithRetry(`${BASE}/raceindex?jcd=${jcd}&hd=${hd}`, { headers:{'User-Agent':'Mozilla/5.0'} }, 12000, 2);
    const raceIndexHtml = await raceIndexRes.text();
    const ctx = parseSeriesContext(raceIndexHtml, asOfDate);
    const seriesKey = `${jcd}_${ctx.series_start_date}`;
    const now = new Date().toISOString();

    let pointRank = { available:false, as_of_label:null, standings:[] };
    try {
      const pr = await fetchWithRetry(`${BASE}/pointrank?jcd=${jcd}&hd=${hd}`, { headers:{'User-Agent':'Mozilla/5.0'} }, 10000, 1);
      pointRank = parsePointRank(await pr.text());
    } catch {}

    // 18人準優ボーダーは現時点ではSG/PG1/G1/G2/G3だけ明示的に使う。
    // 一般開催は開催方式が多様なので、公式ルール未確認の18位固定をしない。
    const qualifyingCut = ['SG','PG1','G1','G2','G3'].includes(ctx.grade) && pointRank.standings.length >= 18 ? 18 : null;

    const existingCtx = await base44.asServiceRole.entities.SeriesContext.filter({ series_key:seriesKey, as_of_date:asOfDate }, '-updated_date', 5).catch(()=>[]);
    const contextPayload = {
      series_key:seriesKey, venue_code:jcd, venue_name:VENUE_NAMES[jcd] || jcd,
      event_name:ctx.event_name, grade:ctx.grade,
      series_start_date:ctx.series_start_date, series_end_date:ctx.series_end_date,
      series_dates:ctx.series_dates, series_total_days:ctx.series_total_days,
      as_of_date:asOfDate, series_day:ctx.series_day, is_final_day:ctx.is_final_day,
      point_rank_available:pointRank.available, point_rank_as_of:pointRank.as_of_label,
      qualifying_cut:qualifyingCut, standings_count:pointRank.standings.length,
      refreshed_at:now, context_version:CONTEXT_VERSION,
    };
    if (existingCtx[0]) await base44.asServiceRole.entities.SeriesContext.update(existingCtx[0].id, contextPayload);
    else await base44.asServiceRole.entities.SeriesContext.create(contextPayload);

    // 今節の詳細結果をすべて読む。enrichRaceResultDetailsで全6艇のfinishersが保存されたレースが対象。
    const allResults = await base44.asServiceRole.entities.RaceResult.filter({ venue_code:jcd, data_source:'official' }, 'race_date', 500).catch(()=>[]);
    const results = allResults.filter(r => isBetween(r.race_date, ctx.series_start_date, asOfDate));
    const histories = new Map();
    for (const r of results) {
      const finishers = Array.isArray(r.finishers) ? r.finishers : [];
      const validStarts = Array.isArray(r.start_info) ? r.start_info.map(x=>Number(x.st)).filter(x=>Number.isFinite(x) && x >= 0) : [];
      const fieldAvgSt = validStarts.length ? validStarts.reduce((a,b)=>a+b,0)/validStarts.length : null;
      for (const f of finishers) {
        const reg = String(f.registration_number || '');
        if (!/^\d{4}$/.test(reg)) continue;
        const st = Array.isArray(r.start_info) ? r.start_info.find(x => Number(x.boat_number) === Number(f.boat_number)) : null;
        if (!histories.has(reg)) histories.set(reg, []);
        histories.get(reg).push({
          race_date:r.race_date, race_number:r.race_number,
          lane:Number(f.boat_number), finish:Number(f.finish),
          race_time_seconds:f.race_time_seconds ?? null,
          st:st?.st ?? null, st_raw:st?.st_raw ?? null,
          field_avg_st:fieldAvgSt,
          st_advantage:fieldAvgSt != null && st?.st != null && Number(st.st) >= 0 ? Math.round((fieldAvgSt - Number(st.st)) * 1000) / 1000 : null,
          winning_method:Number(f.finish) === 1 ? (r.winning_method || null) : null,
          margin_1_2_seconds:Number(f.finish) === 1 ? (r.margin_1_2_seconds ?? null) : null,
          weather:r.weather || null, wind_speed:r.wind_speed ?? null, wave_height:r.wave_height ?? null,
          racer_name:f.racer_name || null,
        });
      }
    }
    for (const arr of histories.values()) arr.sort((a,b)=>a.race_date.localeCompare(b.race_date) || Number(a.race_number)-Number(b.race_number));

    const standingByReg = new Map(pointRank.standings.map(s => [String(s.registration_number), s]));
    const regs = new Set([...histories.keys(), ...standingByReg.keys()]);

    // 得点率ページが無い一般開催でも、当日の出走表にいる選手はシリーズ指数の母集団に含める。
    const dayEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_date:asOfDate, venue_code:jcd }, 'race_number', 500).catch(()=>[]);
    const entryByReg = new Map();
    for (const e of dayEntries) {
      if (e.registration_number) { regs.add(String(e.registration_number)); if (!entryByReg.has(String(e.registration_number))) entryByReg.set(String(e.registration_number), e); }
    }

    const existingPoints = await base44.asServiceRole.entities.SeriesRacerPoint.filter({ series_key:seriesKey, as_of_date:asOfDate }, 'registration_number', 500).catch(()=>[]);
    const existingByReg = new Map(existingPoints.map(x => [String(x.registration_number), x]));
    let saved = 0;

    for (const reg of regs) {
      const hist = histories.get(reg) || [];
      const standing = standingByReg.get(reg) || null;
      const entry = entryByReg.get(reg) || null;
      const score = computeSeriesRacerScore({ laneFinishHistory:hist });
      const remainingRaces = [standing?.next_race_1, standing?.next_race_2].filter(Boolean).length;
      const pressure = qualifyingCut && standing?.rank
        ? computeRankPressureScore({ rank:standing.rank, qualifyingCut, remainingRaces, seriesDay:ctx.series_day, totalDays:ctx.series_total_days })
        : 50;
      const gradeClass = standing?.grade_class || entry?.grade_class || null;
      const avgLane = score.avg_lane ?? (hist.length ? hist.reduce((s,x)=>s+x.lane,0)/hist.length : null);
      const routineOuterB2 = ctx.grade === 'GENERAL' && gradeClass === 'B2' && hist.length >= 2 && avgLane >= 4.5 && (score.inner_lane_count || 0) === 0;

      const payload = {
        series_key:seriesKey, venue_code:jcd, venue_name:VENUE_NAMES[jcd] || jcd,
        series_start_date:ctx.series_start_date, series_end_date:ctx.series_end_date,
        series_total_days:ctx.series_total_days, series_day:ctx.series_day, grade:ctx.grade,
        as_of_date:asOfDate, registration_number:reg,
        racer_name:standing?.racer_name || entry?.racer_name || hist[hist.length-1]?.racer_name || null,
        grade_class:gradeClass,
        rank:standing?.rank ?? null, point_rate:standing?.point_rate ?? null,
        total_points:standing?.total_points ?? null, penalty_points:standing?.penalty_points ?? null,
        races_run:hist.length, remaining_races:remainingRaces,
        lane_history:hist.map(x=>x.lane), finish_history:hist.map(x=>x.finish), lane_finish_history:hist,
        avg_lane:score.avg_lane ?? null, inner_lane_count:score.inner_lane_count ?? 0, outer_lane_count:score.outer_lane_count ?? 0,
        lane_difficulty_score:score.lane_difficulty_score, result_quality_score:score.result_quality_score,
        rank_pressure_score:pressure, series_momentum_score:score.series_momentum_score,
        series_score:score.series_score, series_label:score.series_label,
        score_components:score.score_components, score_reasons:score.score_reasons,
        alert_exclusion:routineOuterB2,
        alert_exclusion_reason:routineOuterB2 ? '一般開催で今節も外枠中心のB2（通常配置）' : null,
        snapshot_at:now, algorithm_version:SERIES_SCORE_VERSION,
      };
      const old = existingByReg.get(reg);
      if (old) await base44.asServiceRole.entities.SeriesRacerPoint.update(old.id, payload);
      else await base44.asServiceRole.entities.SeriesRacerPoint.create(payload);
      saved++;
    }

    return Response.json({
      status:'success', venue_code:jcd, venue_name:VENUE_NAMES[jcd] || jcd,
      as_of_date:asOfDate, series_key:seriesKey, event_name:ctx.event_name, grade:ctx.grade,
      series_day:ctx.series_day, series_total_days:ctx.series_total_days,
      point_rank_available:pointRank.available, standings:pointRank.standings.length,
      qualifying_cut:qualifyingCut, detailed_results:results.filter(r=>Array.isArray(r.finishers) && r.finishers.length).length,
      racers:saved, algorithm_version:SERIES_SCORE_VERSION,
    });
  } catch (error) {
    return Response.json({ status:'error', message:error?.message || String(error) }, { status:500 });
  }
}
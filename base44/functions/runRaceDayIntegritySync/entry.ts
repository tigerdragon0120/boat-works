import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { ALL_VENUE_JCDS, VENUE_NAMES, parseDaySchedule, parseRacelist, parseSeriesContext, fetchWithRetry, sleep } from '../../shared/scraper.js';

// BOAT WORKS 当日/翌日の自己修復同期
// - トップページの開催場一覧だけを信用せず、24場の raceindex を直接確認
// - 1場の失敗で全体を止めない
// - Race は全開催場・全Rをupsert
// - RaceEntryは6艇未満のレースだけ再取得
// - 完全なレースだけv8分析へ流す

const BASE = 'https://boatrace.jp/owpc/pc/race';

function jstDateStr(offset = 0) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offset);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

async function mapBatches(items, batchSize, worker, delayMs = 180) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const rows = await Promise.all(batch.map(worker));
    out.push(...rows);
    if (i + batchSize < items.length) await sleep(delayMs);
  }
  return out;
}

function preserveExhibitionFields(parsedEntries, previousEntries) {
  const prevByBoat = new Map((previousEntries || []).map(e => [Number(e.boat_number), e]));
  return (parsedEntries || []).map(e => {
    const p:any = prevByBoat.get(Number(e.boat_number)) || {};
    return {
      ...e,
      entry_course: p.entry_course ?? e.entry_course ?? null,
      exhibition_time: p.exhibition_time ?? e.exhibition_time ?? null,
      tilt: p.tilt ?? e.tilt ?? null,
      exhibition_st: p.exhibition_st ?? e.exhibition_st ?? null,
      exhibition_st_raw: p.exhibition_st_raw ?? e.exhibition_st_raw ?? null,
      exhibition_rank: p.exhibition_rank ?? e.exhibition_rank ?? null,
      is_scratched: p.is_scratched === true || e.is_scratched === true,
    };
  });
}

async function pruneDuplicateAnalyses(base44, raceDate) {
  const rows = await base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate }, '-captured_at', 5000).catch(() => []);
  const groups = new Map();
  for (const a of rows) {
    const key = `${a.race_id}_${a.stage || ''}_${a.analysis_version || 'legacy'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  let deleted = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a,b) => {
      // finalは展示取得済みを最優先。MISSINGの再計算で正式判定を上書きさせない。
      if ((a.stage || '') === 'final') {
        const ar = a.exhibition_ready === true ? 1 : 0;
        const br = b.exhibition_ready === true ? 1 : 0;
        if (ar !== br) return br - ar;
      }
      return String(b.captured_at || b.updated_date || '').localeCompare(String(a.captured_at || a.updated_date || ''));
    });
    for (const extra of group.slice(1)) {
      try { await base44.asServiceRole.entities.UichiAnalysis.delete(extra.id); deleted++; } catch {}
    }
  }
  return { rows: rows.length, deleted };
}

function completenessScore(r, entryCount, analysisCount, alertCount, oddsCount) {
  let s = (entryCount || 0) * 100 + (analysisCount || 0) * 30 + (alertCount || 0) * 20 + (oddsCount || 0) * 5;
  for (const k of ['entries_fetched_at','event_name','series_key','series_start_date','series_end_date','series_day','race_phase','deadline','beforeinfo_fetched_at']) {
    if (r?.[k] != null) s += 3;
  }
  if (r?.exhibition_ready === true) s += 20;
  if (r?.status === 'finished') s += 10;
  return s;
}

async function normalizeDuplicateRaces(base44, raceDate) {
  const races = await base44.asServiceRole.entities.Race.filter({ race_date: raceDate, data_source: 'official' }, '-updated_date', 500).catch(() => []);
  const groups = new Map();
  for (const r of races) {
    const key = `${String(r.venue_code).padStart(2,'0')}_${Number(r.race_number)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const dupGroups = [...groups.values()].filter(g => g.length > 1);
  if (!dupGroups.length) return { duplicate_groups:0, races_deleted:0, children_moved:0 };

  const [entries, analyses, alerts, odds, results, learning] = await Promise.all([
    base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(()=>[]),
    base44.asServiceRole.entities.UichiAnalysis.filter({ race_date: raceDate }, '-captured_at', 5000).catch(()=>[]),
    base44.asServiceRole.entities.Alert.filter({ race_date: raceDate }, '-updated_date', 5000).catch(()=>[]),
    base44.asServiceRole.entities.OddsSnapshot.filter({ race_date: raceDate }, '-captured_at', 5000).catch(()=>[]),
    base44.asServiceRole.entities.RaceResult.filter({ race_date: raceDate }, '-updated_date', 5000).catch(()=>[]),
    base44.asServiceRole.entities.UichiLearningSample.filter({ race_date: raceDate }, '-updated_date', 5000).catch(()=>[]),
  ]);
  const countBy = (rows) => {
    const m = new Map();
    for (const x of rows) m.set(x.race_id, (m.get(x.race_id)||0)+1);
    return m;
  };
  const ec=countBy(entries), ac=countBy(analyses), alc=countBy(alerts), oc=countBy(odds);
  let racesDeleted=0, childrenMoved=0;

  for (const group of dupGroups) {
    const sorted=[...group].sort((a,b)=>
      completenessScore(b,ec.get(b.id),ac.get(b.id),alc.get(b.id),oc.get(b.id)) - completenessScore(a,ec.get(a.id),ac.get(a.id),alc.get(a.id),oc.get(a.id))
    );
    const canonical=sorted[0];
    const dupIds=sorted.slice(1).map(r=>r.id);
    const allIds=new Set(group.map(r=>r.id));

    // Race本体は、各重複レコードの非null値を正規Raceへ補完する。
    const merged:any = {};
    const mergeFields=['race_name','grade','event_name','series_key','series_start_date','series_end_date','series_total_days','series_day','is_final_day','race_phase','deadline','time_slot','weather','wind_dir','wind_speed','wave_height','air_temperature','water_temperature','beforeinfo_fetched_at','exhibition_ready','scratched_boats','status','result_trifecta','is_uichi','payout_trifecta','last_updated','entries_fetched_at','odds_fetched_at'];
    for (const f of mergeFields) {
      for (const r of sorted) { if (r?.[f] != null) { merged[f]=r[f]; break; } }
    }
    if (Object.keys(merged).length) await base44.asServiceRole.entities.Race.update(canonical.id, merged);

    // 正規Raceはスコア上、6艇揃ったレコードが最優先になる。
    // RaceEntryは正規側をそのまま保持し、重複Race側だけ削除する。再構築による検証エラーを避ける。
    for (const id of dupIds) {
      try { await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id:id }); } catch {}
    }

    // 子データは消さず、重複Race IDから正規Race IDへ付け替える。
    // 個別失敗があってもRace全体の正規化を止めない。
    for (const a of analyses.filter(x=>allIds.has(x.race_id) && x.race_id!==canonical.id)) {
      try { await base44.asServiceRole.entities.UichiAnalysis.update(a.id,{ race_id:canonical.id }); childrenMoved++; } catch {}
    }
    for (const a of alerts.filter(x=>allIds.has(x.race_id) && x.race_id!==canonical.id)) {
      try { await base44.asServiceRole.entities.Alert.update(a.id,{ race_id:canonical.id }); childrenMoved++; } catch {}
    }
    for (const o of odds.filter(x=>allIds.has(x.race_id) && x.race_id!==canonical.id)) {
      try { await base44.asServiceRole.entities.OddsSnapshot.update(o.id,{ race_id:canonical.id }); childrenMoved++; } catch {}
    }
    for (const r of results.filter(x=>allIds.has(x.race_id) && x.race_id!==canonical.id)) {
      try { await base44.asServiceRole.entities.RaceResult.update(r.id,{ race_id:canonical.id }); childrenMoved++; } catch {}
    }
    for (const l of learning.filter(x=>allIds.has(x.race_id) && x.race_id!==canonical.id)) {
      try { await base44.asServiceRole.entities.UichiLearningSample.update(l.id,{ race_id:canonical.id }); childrenMoved++; } catch {}
    }

    // 最後に重複Race本体を削除。子データ移動の一部が失敗しても、表示・収集判定を壊す重複Raceを優先して除去する。
    for (const id of dupIds) {
      try { await base44.asServiceRole.entities.Race.delete(id); racesDeleted++; } catch {}
    }
  }
  return { duplicate_groups:dupGroups.length, races_deleted:racesDeleted, children_moved:childrenMoved };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date || jstDateStr(Number(body.target_offset || 0));
    const stage = body.stage || 'pre';
    const collectOnly = body.collect_only === true;
    const hd = raceDate.replace(/-/g, '');
    const t0 = Date.now();
    const errors:any[] = [];

    // 0) まず既存の重複Raceを正規化する。子データを正規Raceへ寄せてから重複本体を削除。
    let duplicateRepair:any = null;
    try {
      duplicateRepair = await normalizeDuplicateRaces(base44, raceDate);
    } catch (e) {
      duplicateRepair = { status:'error', message:e?.message || String(e) };
      errors.push({ phase:'duplicate_normalize', message:e?.message || '重複Race正規化失敗' });
    }
    let analysisDuplicateRepair:any = null;
    try {
      analysisDuplicateRepair = await pruneDuplicateAnalyses(base44, raceDate);
    } catch (e) {
      analysisDuplicateRepair = { status:'error', message:e?.message || String(e) };
      errors.push({ phase:'analysis_duplicate_prune', message:e?.message || '重複分析整理失敗' });
    }

    // 0) DB上ですでに判明している「締切90分以内の未取得レース」を最初に救済する。
    // 24場スキャンを待っている間に締切を迎える事故を防ぐため、最短経路で先にracelistを取得する。
    const knownRaces = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'deadline', 500
    ).catch(() => []);
    const knownEntries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_date: raceDate }, 'boat_number', 5000
    ).catch(() => []);
    const knownEntryCount = new Map();
    for (const e of knownEntries) knownEntryCount.set(e.race_id, (knownEntryCount.get(e.race_id) || 0) + 1);
    const urgentNow = Date.now();
    const urgentMissing = knownRaces
      .filter(r => {
        if ((knownEntryCount.get(r.id) || 0) >= 6) return false;
        const d = new Date(r.deadline || 0).getTime();
        return d >= urgentNow && d - urgentNow <= 90 * 60 * 1000;
      })
      .sort((a,b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
      .slice(0, 24);
    const urgentRepairedIds:any[] = [];
    await mapBatches(urgentMissing, 6, async (r) => {
      try {
        const jcd = String(r.venue_code).padStart(2, '0');
        const url = `${BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
        const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 7000, 2);
        const html = await res.text();
        const parsed = parseRacelist(html, Number(r.race_number), raceDate);
        if (!parsed.entries || parsed.entries.length < 6) {
          errors.push({ phase: 'urgent_entry_fetch', jcd, race_number: r.race_number, message: `${parsed.entries?.length || 0}艇` });
          return null;
        }
        await base44.asServiceRole.entities.Race.update(r.id, {
          race_name: parsed.raceName,
          race_phase: parsed.racePhase || 'OTHER',
          deadline: parsed.deadline || r.deadline,
          entries_fetched_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        });
        const prevEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: r.id }, 'boat_number', 20).catch(() => []);
        const mergedEntries = preserveExhibitionFields(parsed.entries, prevEntries);
        await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: r.id });
        await base44.asServiceRole.entities.RaceEntry.bulkCreate(mergedEntries.map(e => ({
          ...e, race_id: r.id, race_date: raceDate, venue_code: jcd, race_number: r.race_number,
        })));
        urgentRepairedIds.push(r.id);
        return r.id;
      } catch (e) {
        errors.push({ phase: 'urgent_entry_fetch', jcd: r.venue_code, race_number: r.race_number, message: e?.message || '緊急取得失敗' });
        return null;
      }
    }, 100);
    if (!collectOnly && urgentRepairedIds.length > 0) {
      try {
        await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
          race_date: raceDate, stage, race_ids: urgentRepairedIds, force: true,
        });
      } catch (e) {
        errors.push({ phase: 'urgent_analysis', message: e?.message || '緊急分析失敗' });
      }
    }

    // 1) 24場を直接確認。トップページの開催場抽出失敗に依存しない。
    const venueScans = await mapBatches(ALL_VENUE_JCDS, 4, async (jcd) => {
      try {
        const url = `${BASE}/raceindex?jcd=${jcd}&hd=${hd}`;
        const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 9000, 1);
        const html = await res.text();
        if (html.includes('不正なURLへのリクエスト') || html.includes('予期せぬエラーが発生しました')) {
          return { jcd, schedule: [] };
        }
        const schedule = parseDaySchedule(html, raceDate);
        const seriesCtx = schedule.length > 0 ? parseSeriesContext(html, raceDate) : null;
        return { jcd, schedule, seriesCtx };
      } catch (e) {
        errors.push({ phase: 'venue_scan', jcd, message: e?.message || '取得失敗' });
        return { jcd, schedule: [] };
      }
    });

    const activeVenues = venueScans.filter(v => v.schedule.length > 0);
    const expectedRaceCount = activeVenues.reduce((n, v) => n + v.schedule.length, 0);

    // 2) 既存Raceを日付で一括取得しupsert用Map化。
    let raceCreated = 0, raceUpdated = 0;
    const allRaceRows:any[] = [];

    // 場単位で完全分離。全日500件上限の影響を受けないよう、既存Raceも必ず場ごとに取得する。
    for (const venue of activeVenues) {
      const jcd = venue.jcd;
      const venueName = VENUE_NAMES[jcd] || jcd;
      const seriesCtx = venue.seriesCtx || {};
      const venueExisting = await base44.asServiceRole.entities.Race.filter(
        { race_date: raceDate, venue_code: jcd, data_source: 'official' }, '-updated_date', 100
      ).catch(() => []);
      const raceMap = new Map();
      for (const r of venueExisting) {
        const key = `${jcd}_${Number(r.race_number)}`;
        if (!raceMap.has(key)) raceMap.set(key, r); // updated_date降順なので先頭を正規Raceにする
      }
      for (const s of venue.schedule) {
        const key = `${jcd}_${Number(s.race_number)}`;
        const old = raceMap.get(key);
        const data = {
          race_date: raceDate,
          venue_code: jcd,
          venue_name: venueName,
          race_number: s.race_number,
          deadline: s.deadline || old?.deadline || null,
          event_name: seriesCtx.event_name || old?.event_name || null,
          grade: seriesCtx.grade || old?.grade || 'GENERAL',
          series_key: `${jcd}_${seriesCtx.series_start_date || old?.series_start_date || raceDate}`,
          series_start_date: seriesCtx.series_start_date || old?.series_start_date || raceDate,
          series_end_date: seriesCtx.series_end_date || old?.series_end_date || raceDate,
          series_total_days: seriesCtx.series_total_days || old?.series_total_days || 1,
          series_day: seriesCtx.series_day || old?.series_day || 1,
          is_final_day: seriesCtx.is_final_day === true,
          status: 'scheduled',
          data_source: 'official',
          last_updated: new Date().toISOString(),
        };
        try {
          let saved;
          if (old) {
            saved = await base44.asServiceRole.entities.Race.update(old.id, data);
            raceUpdated++;
          } else {
            // 並行ワーカーが同時に同じRaceを作るケースを防ぐため、create直前に再確認する。
            const dup = await base44.asServiceRole.entities.Race.filter({
              race_date: raceDate,
              venue_code: jcd,
              race_number: Number(s.race_number),
              data_source: 'official',
            }, '-updated_date', 5).catch(() => []);
            if (dup.length > 0) {
              saved = await base44.asServiceRole.entities.Race.update(dup[0].id, data);
              raceUpdated++;
            } else {
              saved = await base44.asServiceRole.entities.Race.create(data);
              raceCreated++;
            }
          }
          raceMap.set(key, saved);
          allRaceRows.push(saved);
        } catch (e) {
          errors.push({ phase: 'race_upsert', jcd, race_number: s.race_number, message: e?.message || '保存失敗' });
        }
      }
    }

    // 3) 出走表の完全性を一括確認。
    const entries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_date: raceDate }, 'boat_number', 5000
    ).catch(() => []);
    const entryCount = new Map();
    for (const e of entries) entryCount.set(e.race_id, (entryCount.get(e.race_id) || 0) + 1);

    const alreadyCompleteIds = allRaceRows.filter(r => (entryCount.get(r.id) || 0) >= 6).map(r => r.id);
    const missing = allRaceRows.filter(r => (entryCount.get(r.id) || 0) < 6);
    let repaired = 0;
    let refreshedChanged = 0;
    const changedIds:any[] = [];
    let initialAnalysis = null;

    if (!collectOnly && alreadyCompleteIds.length > 0) {
      try {
        const preRes = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
          race_date: raceDate,
          stage,
          race_ids: alreadyCompleteIds,
          force: true,
        });
        initialAnalysis = preRes?.data || preRes;
      } catch (e) {
        initialAnalysis = { status: 'error', message: e?.message || '先行分析失敗' };
        errors.push({ phase: 'initial_analysis', message: e?.message || '先行分析失敗' });
      }
    }

    // 部分取得済みの場を最優先に修復する。
    // 例: 唐津で1R/3Rだけ取れている場合、他場の未取得群より先に残りRを埋める。
    const venueEntryCounts = new Map();
    for (const r of allRaceRows) {
      const jcd = String(r.venue_code).padStart(2, '0');
      venueEntryCounts.set(jcd, (venueEntryCounts.get(jcd) || 0) + (entryCount.get(r.id) || 0));
    }
    const nowMs = Date.now();
    const repairTargets = [...missing]
      .sort((a, b) => {
        const ad = new Date(a.deadline || '2999-12-31').getTime();
        const bd = new Date(b.deadline || '2999-12-31').getTime();
        const aSoon = ad >= nowMs && ad - nowMs <= 90 * 60 * 1000 ? 1 : 0;
        const bSoon = bd >= nowMs && bd - nowMs <= 90 * 60 * 1000 ? 1 : 0;
        // 締切90分以内の未取得レースを最優先。直前レースを後回しにしない。
        if (aSoon !== bSoon) return bSoon - aSoon;
        if (aSoon && bSoon && ad !== bd) return ad - bd;

        const aj = String(a.venue_code).padStart(2, '0');
        const bj = String(b.venue_code).padStart(2, '0');
        const aPartial = (venueEntryCounts.get(aj) || 0) > 0 ? 1 : 0;
        const bPartial = (venueEntryCounts.get(bj) || 0) > 0 ? 1 : 0;
        if (aPartial !== bPartial) return bPartial - aPartial;
        return ad - bd;
      })
      .slice(0, 48);
    await mapBatches(repairTargets, 6, async (r) => {
      try {
        const jcd = String(r.venue_code).padStart(2, '0');
        const url = `${BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
        const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 9000, 2);
        const html = await res.text();
        const parsed = parseRacelist(html, Number(r.race_number), raceDate);
        if (!parsed.entries || parsed.entries.length < 6) {
          errors.push({ phase: 'entry_fetch', jcd, race_number: r.race_number, message: `${parsed.entries?.length || 0}艇` });
          return null;
        }
        await base44.asServiceRole.entities.Race.update(r.id, {
          race_name: parsed.raceName,
          race_phase: parsed.racePhase || 'OTHER',
          deadline: parsed.deadline || r.deadline,
          entries_fetched_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        });
        const prevEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: r.id }, 'boat_number', 20).catch(() => []);
        const mergedEntries = preserveExhibitionFields(parsed.entries, prevEntries);
        await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: r.id });
        await base44.asServiceRole.entities.RaceEntry.bulkCreate(mergedEntries.map(e => ({
          ...e,
          race_id: r.id,
          race_date: raceDate,
          venue_code: jcd,
          race_number: r.race_number,
        })));
        repaired++;
        return r.id;
      } catch (e) {
        errors.push({ phase: 'entry_fetch', jcd: r.venue_code, race_number: r.race_number, message: e?.message || '取得失敗' });
        return null;
      }
    }, 220);

    // 4) すでに6艇揃っているレースも定期的に再取得し、出走表更新を検知する。
    // 登録番号・級別・ST・モーター/艇成績のいずれかが変われば、そのレースだけ再保存→再分析する。
    const entryRowsByRace = new Map();
    for (const e of entries) {
      if (!entryRowsByRace.has(e.race_id)) entryRowsByRace.set(e.race_id, []);
      entryRowsByRace.get(e.race_id).push(e);
    }
    const signature = (rows:any[]) => [...(rows || [])]
      .sort((a,b) => Number(a.boat_number) - Number(b.boat_number))
      .map(e => [e.boat_number,e.registration_number,e.grade_class,e.avg_st,e.f_count,e.motor_number,e.motor_2rate,e.motor_3rate,e.boat_number_id,e.boat_2rate,e.boat_3rate].join(':'))
      .join('|');

    const refreshTargets = allRaceRows
      .filter(r => (entryCount.get(r.id) || 0) >= 6)
      .sort((a,b) => new Date(a.deadline || '2999-12-31').getTime() - new Date(b.deadline || '2999-12-31').getTime())
      .slice(0, 36);

    await mapBatches(refreshTargets, 6, async (r) => {
      try {
        const jcd = String(r.venue_code).padStart(2, '0');
        const url = `${BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
        const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 9000, 1);
        const html = await res.text();
        const parsed = parseRacelist(html, Number(r.race_number), raceDate);
        if (!parsed.entries || parsed.entries.length < 6) return null;
        const oldSig = signature(entryRowsByRace.get(r.id) || []);
        const newSig = signature(parsed.entries);
        if (oldSig === newSig) return null;

        await base44.asServiceRole.entities.Race.update(r.id, {
          race_name: parsed.raceName,
          race_phase: parsed.racePhase || 'OTHER',
          deadline: parsed.deadline || r.deadline,
          entries_fetched_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        });
        await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: r.id });
        await base44.asServiceRole.entities.RaceEntry.bulkCreate(parsed.entries.map(e => ({
          ...e, race_id: r.id, race_date: raceDate, venue_code: jcd, race_number: r.race_number,
        })));
        refreshedChanged++;
        changedIds.push(r.id);
        return r.id;
      } catch (e) {
        errors.push({ phase: 'entry_refresh', jcd: r.venue_code, race_number: r.race_number, message: e?.message || '更新確認失敗' });
        return null;
      }
    }, 180);

    if (!collectOnly && changedIds.length > 0) {
      try {
        await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
          race_date: raceDate, stage, race_ids: changedIds, force: true,
        });
      } catch (e) {
        errors.push({ phase: 'changed_entry_analysis', message: e?.message || '更新レース再分析失敗' });
      }
    }

    // 5) 修復後に再度完全性を数える。
    const finalEntries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_date: raceDate }, 'boat_number', 5000
    ).catch(() => []);
    const finalCount = new Map();
    for (const e of finalEntries) finalCount.set(e.race_id, (finalCount.get(e.race_id) || 0) + 1);
    const completeIds = allRaceRows.filter(r => (finalCount.get(r.id) || 0) >= 6).map(r => r.id);
    const incompleteRows = allRaceRows.filter(r => (finalCount.get(r.id) || 0) < 6);
    const initialSet = new Set(alreadyCompleteIds);
    const newlyCompleteIds = completeIds.filter(id => !initialSet.has(id));

    let analysis = collectOnly ? { status: 'skipped', reason: 'collect_only' } : initialAnalysis;
    if (!collectOnly && newlyCompleteIds.length > 0) {
      try {
        const res = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
          race_date: raceDate,
          stage,
          race_ids: newlyCompleteIds,
          force: true,
        });
        analysis = { initial: initialAnalysis, repaired: res?.data || res };
      } catch (e) {
        analysis = { initial: initialAnalysis, repaired: { status: 'error', message: e?.message || '追加分析失敗' } };
        errors.push({ phase: 'analysis_after_repair', message: e?.message || '追加分析失敗' });
      }
    }

    const dbRaces = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'race_number', 500
    ).catch(() => []);

    return Response.json({
      status: incompleteRows.length === 0 ? 'success' : 'partial',
      race_date: raceDate,
      venues_found: activeVenues.length,
      venue_codes: activeVenues.map(v => v.jcd),
      expected_races: expectedRaceCount,
      db_races: dbRaces.length,
      duplicate_repair: duplicateRepair,
      analysis_duplicate_repair: analysisDuplicateRepair,
      urgent_missing_before_scan: urgentMissing.length,
      urgent_repaired_before_scan: urgentRepairedIds.length,
      race_created: raceCreated,
      race_updated: raceUpdated,
      missing_entries_before: missing.length,
      repair_targets_this_run: repairTargets.length,
      repaired_entries: repaired,
      refresh_checked: refreshTargets.length,
      refreshed_changed: refreshedChanged,
      already_complete_before_repair: alreadyCompleteIds.length,
      newly_complete_after_repair: newlyCompleteIds.length,
      complete_races: completeIds.length,
      incomplete_races: incompleteRows.map(r => ({ venue_code: r.venue_code, venue_name: r.venue_name, race_number: r.race_number })),
      collect_only: collectOnly,
      analysis,
      errors: errors.slice(0, 50),
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

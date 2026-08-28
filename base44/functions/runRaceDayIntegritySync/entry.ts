import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { ALL_VENUE_JCDS, VENUE_NAMES, parseDaySchedule, parseRacelist, fetchWithRetry, sleep } from '../../shared/scraper.js';

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
    const hd = raceDate.replace(/-/g, '');
    const t0 = Date.now();
    const errors:any[] = [];

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
        return { jcd, schedule };
      } catch (e) {
        errors.push({ phase: 'venue_scan', jcd, message: e?.message || '取得失敗' });
        return { jcd, schedule: [] };
      }
    });

    const activeVenues = venueScans.filter(v => v.schedule.length > 0);
    const expectedRaceCount = activeVenues.reduce((n, v) => n + v.schedule.length, 0);

    // 2) 既存Raceを日付で一括取得しupsert用Map化。
    const existingRaces = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: 'official' }, 'race_number', 500
    ).catch(() => []);
    const raceMap = new Map(existingRaces.map(r => [`${String(r.venue_code).padStart(2, '0')}_${Number(r.race_number)}`, r]));

    let raceCreated = 0, raceUpdated = 0;
    const allRaceRows:any[] = [];

    // 場単位で完全分離。1場のDBエラーでも他場を継続。
    for (const venue of activeVenues) {
      const jcd = venue.jcd;
      const venueName = VENUE_NAMES[jcd] || jcd;
      for (const s of venue.schedule) {
        const key = `${jcd}_${Number(s.race_number)}`;
        const old = raceMap.get(key);
        const data = {
          race_date: raceDate,
          venue_code: jcd,
          venue_name: venueName,
          race_number: s.race_number,
          deadline: s.deadline || old?.deadline || null,
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
            saved = await base44.asServiceRole.entities.Race.create(data);
            raceCreated++;
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
    let initialAnalysis = null;

    if (alreadyCompleteIds.length > 0) {
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

    const repairTargets = missing.slice(0, 30);
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
          deadline: parsed.deadline || r.deadline,
          entries_fetched_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        });
        await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: r.id });
        await base44.asServiceRole.entities.RaceEntry.bulkCreate(parsed.entries.map(e => ({
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

    // 4) 修復後に再度完全性を数える。
    const finalEntries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_date: raceDate }, 'boat_number', 5000
    ).catch(() => []);
    const finalCount = new Map();
    for (const e of finalEntries) finalCount.set(e.race_id, (finalCount.get(e.race_id) || 0) + 1);
    const completeIds = allRaceRows.filter(r => (finalCount.get(r.id) || 0) >= 6).map(r => r.id);
    const incompleteRows = allRaceRows.filter(r => (finalCount.get(r.id) || 0) < 6);

    // 5) 完全なレースのみ分析。forceで旧v7/v8途中データも最新v8へ更新。
    let analysis = null;
    if (completeIds.length > 0) {
      try {
        const res = await base44.asServiceRole.functions.invoke('analyzeAllRacesForDate', {
          race_date: raceDate,
          stage,
          race_ids: completeIds,
          force: true,
        });
        analysis = res?.data || res;
      } catch (e) {
        analysis = { status: 'error', message: e?.message || '分析失敗' };
        errors.push({ phase: 'analysis', message: e?.message || '分析失敗' });
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
      race_created: raceCreated,
      race_updated: raceUpdated,
      missing_entries_before: missing.length,
      repaired_entries: repaired,
      complete_races: completeIds.length,
      incomplete_races: incompleteRows.map(r => ({ venue_code: r.venue_code, venue_name: r.venue_name, race_number: r.race_number })),
      analysis,
      errors: errors.slice(0, 50),
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

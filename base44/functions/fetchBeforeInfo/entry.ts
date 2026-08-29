import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { parseBeforeInfo } from '../../shared/scraper.js';

const BASE = 'https://www.boatrace.jp/owpc/pc/race';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    const jcd = String(body.jcd || body.venue_code || '').padStart(2, '0');
    const raceNumber = Number(body.race_number);
    if (!raceDate || !jcd || !raceNumber) {
      return Response.json({ status: 'error', message: 'race_date, jcd, race_number が必要です' }, { status: 400 });
    }

    const races = await base44.asServiceRole.entities.Race.filter({
      race_date: raceDate, venue_code: jcd, race_number: raceNumber, data_source: 'official'
    });
    const race = races[0];
    if (!race) return Response.json({ status: 'error', message: 'Raceが見つかりません' }, { status: 404 });

    const hd = raceDate.replace(/-/g, '');
    const url = `${BASE}/beforeinfo?rno=${raceNumber}&jcd=${jcd}&hd=${hd}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) return Response.json({ status: 'error', message: `直前情報取得失敗 (HTTP ${res.status})` }, { status: 502 });
    const html = await res.text();
    if (html.includes('予期せぬエラーが発生しました')) {
      return Response.json({ status: 'pending', message: '直前情報はまだ公開されていません' });
    }

    const parsed = parseBeforeInfo(html);
    if (!parsed.exhibition_ready) {
      return Response.json({ status: 'pending', message: '展示情報はまだ揃っていません', parsed });
    }

    const now = new Date().toISOString();
    await base44.asServiceRole.entities.Race.update(race.id, {
      weather: parsed.weather,
      wind_dir: parsed.wind_dir,
      wind_speed: parsed.wind_speed,
      wave_height: parsed.wave_height,
      air_temperature: parsed.air_temperature,
      water_temperature: parsed.water_temperature,
      beforeinfo_fetched_at: now,
      exhibition_ready: true,
      scratched_boats: parsed.scratched_boats || [],
      last_updated: now,
    });

    const existingEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: race.id }, 'boat_number', 20);
    const byBoat = Object.fromEntries(existingEntries.map(e => [Number(e.boat_number), e]));
    for (const e of parsed.entries) {
      const current = byBoat[e.boat_number];
      if (!current) continue;
      await base44.asServiceRole.entities.RaceEntry.update(current.id, {
        entry_course: e.entry_course,
        exhibition_time: e.exhibition_time,
        exhibition_rank: e.exhibition_rank,
        exhibition_st: e.exhibition_st,
        exhibition_st_raw: e.exhibition_st_raw,
        tilt: e.tilt,
        is_scratched: e.is_scratched === true,
      });
    }

    return Response.json({
      status: 'success',
      race_id: race.id,
      race_date: raceDate,
      venue_code: jcd,
      race_number: raceNumber,
      fetched_at: now,
      ...parsed,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}

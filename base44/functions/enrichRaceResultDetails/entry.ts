import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { parseRaceResultDetail, fetchWithRetry, sleep } from '../../shared/scraper.js';

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
    const venueCode = body.jcd ? String(body.jcd).padStart(2, '0') : null;
    if (!raceDate) return Response.json({ status: 'error', message: 'race_date が必要です' }, { status: 400 });

    const query:any = { race_date: raceDate, data_source: 'official' };
    if (venueCode) query.venue_code = venueCode;
    const rows = await base44.asServiceRole.entities.RaceResult.filter(query, 'race_number', 500).catch(() => []);
    const hd = raceDate.replace(/-/g, '');
    const targets = body.force === true ? rows : rows.filter(r => !r.detail_fetched_at);

    let enriched = 0, errors = 0, skipped = 0;
    const error_items:any[] = [];
    const BATCH = 4;

    for (let i = 0; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      await Promise.all(batch.map(async (r) => {
        try {
          const jcd = String(r.venue_code).padStart(2, '0');
          const url = `${BASE}/raceresult?rno=${Number(r.race_number)}&jcd=${jcd}&hd=${hd}`;
          const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000, 2);
          const html = await res.text();
          const detail = parseRaceResultDetail(html);
          if (!detail || !detail.finishers || detail.finishers.length < 3) {
            skipped++;
            return;
          }

          const now = new Date().toISOString();
          await base44.asServiceRole.entities.RaceResult.update(r.id, {
            ...detail,
            detail_fetched_at: now,
          });

          // Race側にも「そのレースが実際に行われた自然条件」を確定値として残す。
          const races = await base44.asServiceRole.entities.Race.filter({
            race_date: raceDate,
            venue_code: jcd,
            race_number: Number(r.race_number),
            data_source: 'official',
          }, '-created_date', 5).catch(() => []);
          if (races.length > 0) {
            await base44.asServiceRole.entities.Race.update(races[0].id, {
              status: 'finished',
              result_trifecta: r.trifecta,
              payout_trifecta: r.payout_trifecta,
              weather: detail.weather ?? races[0].weather ?? null,
              wind_dir: detail.wind_dir ?? races[0].wind_dir ?? null,
              wind_speed: detail.wind_speed ?? races[0].wind_speed ?? null,
              wave_height: detail.wave_height ?? races[0].wave_height ?? null,
              air_temperature: detail.air_temperature ?? races[0].air_temperature ?? null,
              water_temperature: detail.water_temperature ?? races[0].water_temperature ?? null,
              last_updated: now,
            });
          }
          enriched++;
        } catch (e) {
          errors++;
          error_items.push({ venue_code: r.venue_code, race_number: r.race_number, message: e?.message || String(e) });
        }
      }));
      if (i + BATCH < targets.length) await sleep(250);
    }

    return Response.json({
      status: errors === 0 ? 'success' : 'partial',
      race_date: raceDate,
      venue_code: venueCode,
      total_results: rows.length,
      targets: targets.length,
      enriched,
      skipped,
      errors,
      error_items: error_items.slice(0, 30),
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

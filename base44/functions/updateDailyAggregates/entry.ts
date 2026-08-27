import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  newAccumulator, accumulateResults, finalizeAccumulator,
  mergeRacerStats, mergeRacerVenueStats, mergeRacerLaneStats, mergeVenueRaceStats, mergeRacerWeatherStats,
  STATS_VERSION,
} from "../../shared/aggregation.js";

// BOAT WORKS 日次差分集計更新
// 指定日のRaceResultのみを読み込み、既存集計Entityに差分マージする。
// bulkUpdate/bulkCreateでDB呼び出しを最小化。

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") return Response.json({ status: "error", message: "管理者権限が必要です" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    if (!raceDate) return Response.json({ status: "error", message: "race_date が必要です" }, { status: 400 });

    const t0 = Date.now();

    // その日のRaceResult取得
    const results = await base44.asServiceRole.entities.RaceResult.filter(
      { race_date: raceDate, data_source: "official" }, "-race_number", 500
    );
    if (results.length === 0) return Response.json({ status: "no_results", race_date: raceDate, elapsed_ms: Date.now() - t0 });

    // その日のRace天候取得
    const races = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate, data_source: "official" }, "race_number", 300
    );
    const raceWeatherMap = {};
    for (const r of races) {
      raceWeatherMap[r.id] = { weather: r.weather, wind_dir: r.wind_dir, wind_speed: r.wind_speed };
    }

    // 蓄積 → 差分レコード生成
    const acc = newAccumulator();
    accumulateResults(results, raceWeatherMap, acc);
    const dayOut = finalizeAccumulator(acc);

    // 影響を受けるregistration_numberリスト
    const regList = [...new Set(dayOut.racerStats.map(r => r.registration_number))];
    const venueList = [...new Set(dayOut.venueRaceStats.map(v => v.venue_code))];

    // === 既存レコード取得（逐次・レートリミット配慮） ===
    const exRS = regList.length ? await base44.asServiceRole.entities.RacerStats.filter({ registration_number: { $in: regList } }, "registration_number", 3000) : [];
    const exRVS = regList.length ? await base44.asServiceRole.entities.RacerVenueStats.filter({ registration_number: { $in: regList } }, "registration_number", 10000) : [];
    const exRLS = regList.length ? await base44.asServiceRole.entities.RacerLaneStats.filter({ registration_number: { $in: regList }, lane: 1 }, "registration_number", 3000) : [];
    const exVRS = venueList.length ? await base44.asServiceRole.entities.VenueRaceStats.filter({ venue_code: { $in: venueList } }, "venue_code", 500) : [];
    const exRWS = regList.length ? await base44.asServiceRole.entities.RacerWeatherStats.filter({ registration_number: { $in: regList } }, "registration_number", 10000) : [];

    const exRSMap = {}; for (const r of exRS) exRSMap[r.registration_number] = r;
    const exRVSMap = {}; for (const r of exRVS) exRVSMap[`${r.registration_number}_${r.venue_code}`] = r;
    const exRLSMap = {}; for (const r of exRLS) exRLSMap[`${r.registration_number}_${r.lane}`] = r;
    const exVRSMap = {}; for (const r of exVRS) exVRSMap[`${r.venue_code}_${r.race_number}`] = r;
    const exRWSMap = {}; for (const r of exRWS) exRWSMap[`${r.registration_number}_${r.venue_code}_${r.weather}_${r.wind_speed_group}`] = r;

    // === マージ（メモリ上） ===
    const updates = { RacerStats: [], RacerVenueStats: [], RacerLaneStats: [], VenueRaceStats: [], RacerWeatherStats: [] };
    const creates = { RacerStats: [], RacerVenueStats: [], RacerLaneStats: [], VenueRaceStats: [], RacerWeatherStats: [] };

    for (const day of dayOut.racerStats) {
      const ex = exRSMap[day.registration_number];
      if (ex) updates.RacerStats.push(mergeRacerStats(ex, day));
      else creates.RacerStats.push(day);
    }
    for (const day of dayOut.racerVenueStats) {
      const ex = exRVSMap[`${day.registration_number}_${day.venue_code}`];
      if (ex) updates.RacerVenueStats.push(mergeRacerVenueStats(ex, day));
      else creates.RacerVenueStats.push(day);
    }
    for (const day of dayOut.racerLaneStats) {
      const ex = exRLSMap[`${day.registration_number}_${day.lane}`];
      if (ex) updates.RacerLaneStats.push(mergeRacerLaneStats(ex, day));
      else creates.RacerLaneStats.push(day);
    }
    for (const day of dayOut.venueRaceStats) {
      const ex = exVRSMap[`${day.venue_code}_${day.race_number}`];
      if (ex) updates.VenueRaceStats.push(mergeVenueRaceStats(ex, day));
      else creates.VenueRaceStats.push(day);
    }
    for (const day of dayOut.racerWeatherStats) {
      const ex = exRWSMap[`${day.registration_number}_${day.venue_code}_${day.weather}_${day.wind_speed_group}`];
      if (ex) updates.RacerWeatherStats.push(mergeRacerWeatherStats(ex, day));
      else creates.RacerWeatherStats.push(day);
    }

    // === 一括保存（bulkUpdate/bulkCreate・500件ずつ） ===
    let updatedCount = 0, createdCount = 0;
    for (const name of Object.keys(updates)) {
      if (updates[name].length > 0) {
        for (let i = 0; i < updates[name].length; i += 500) {
          await base44.asServiceRole.entities[name].bulkUpdate(updates[name].slice(i, i + 500));
        }
        updatedCount += updates[name].length;
      }
      if (creates[name].length > 0) {
        for (let i = 0; i < creates[name].length; i += 500) {
          await base44.asServiceRole.entities[name].bulkCreate(creates[name].slice(i, i + 500));
        }
        createdCount += creates[name].length;
      }
    }

    // Meta更新
    const metaList = await base44.asServiceRole.entities.AggregationMeta.filter({ config_id: "main" });
    if (metaList[0]) {
      const prevTotal = metaList[0].total_races_processed || 0;
      await base44.asServiceRole.entities.AggregationMeta.update(metaList[0].id, {
        last_aggregated_date: raceDate, status: "idle",
        total_races_processed: prevTotal + results.length,
        updated_at: new Date().toISOString(),
      });
    }

    return Response.json({
      status: "success",
      race_date: raceDate,
      results_processed: results.length,
      records_updated: updatedCount,
      records_created: createdCount,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { newAccumulator, accumulateResults, finalizeAccumulator, STATS_VERSION } from "../../shared/aggregation.js";

// BOAT WORKS 集計DB初期構築（管理者専用・一回限り）
// 全RaceResult(原本)を読み込み、5集計Entityを構築する。
// RaceResultは削除しない。集計Entityはキャッシュ。

export default async function(req) {
  let base44;
  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    // 管理画面からの直接実行はadminのみ。Workflow/サービス実行（user=null）は許可する。
    if (user && user.role !== "admin") return Response.json({ status: "error", message: "管理者権限が必要です" }, { status: 403 });

    const t0 = Date.now();

    // Meta更新: building
    const metaList = await base44.asServiceRole.entities.AggregationMeta.filter({ config_id: "main" });
    const metaId = metaList[0]?.id;
    const metaUpdate = { status: "building", updated_at: new Date().toISOString(), stats_version: STATS_VERSION, error_msg: "" };
    if (metaId) await base44.asServiceRole.entities.AggregationMeta.update(metaId, metaUpdate);
    else await base44.asServiceRole.entities.AggregationMeta.create({ config_id: "main", ...metaUpdate });

    // === Race天候マップ構築（全件・weatherがあるもののみ） ===
    const raceWeatherMap = {};
    let raceSkip = 0;
    while (raceSkip < 1000000) {
      const races = await base44.asServiceRole.entities.Race.filter({ data_source: "official" }, "race_date", 500, raceSkip);
      if (!races || races.length === 0) break;
      for (const r of races) {
        if (r.weather || r.wind_speed != null) {
          raceWeatherMap[r.id] = { weather: r.weather, wind_dir: r.wind_dir, wind_speed: r.wind_speed };
        }
      }
      if (races.length < 500) break;
      raceSkip += 500;
    }

    // === RaceResult全件読み込み + 蓄積 ===
    const acc = newAccumulator();
    let skip = 0, totalResults = 0;
    while (skip < 1000000) {
      const batch = await base44.asServiceRole.entities.RaceResult.filter({ data_source: "official" }, "-race_date", 500, skip);
      if (!batch || batch.length === 0) break;
      accumulateResults(batch, raceWeatherMap, acc);
      totalResults += batch.length;
      if (batch.length < 500) break;
      skip += 500;
    }

    // === レート計算 ===
    const out = finalizeAccumulator(acc);

    // === 既存集計レコード全削除 ===
    await base44.asServiceRole.entities.RacerStats.deleteMany({});
    await base44.asServiceRole.entities.RacerVenueStats.deleteMany({});
    await base44.asServiceRole.entities.RacerLaneStats.deleteMany({});
    await base44.asServiceRole.entities.RacerWeatherStats.deleteMany({});
    await base44.asServiceRole.entities.VenueRaceStats.deleteMany({});

    // === 一括保存（500件ずつ） ===
    async function bulkSave(name, records) {
      for (let i = 0; i < records.length; i += 500) {
        await base44.asServiceRole.entities[name].bulkCreate(records.slice(i, i + 500));
      }
    }
    await bulkSave("RacerStats", out.racerStats);
    await bulkSave("RacerVenueStats", out.racerVenueStats);
    await bulkSave("RacerLaneStats", out.racerLaneStats);
    await bulkSave("RacerWeatherStats", out.racerWeatherStats);
    await bulkSave("VenueRaceStats", out.venueRaceStats);

    // Meta更新: idle
    const today = new Date().toISOString().slice(0, 10);
    const metaList2 = await base44.asServiceRole.entities.AggregationMeta.filter({ config_id: "main" });
    if (metaList2[0]) {
      await base44.asServiceRole.entities.AggregationMeta.update(metaList2[0].id, {
        status: "idle", last_aggregated_date: today, total_races_processed: totalResults,
        stats_version: STATS_VERSION, updated_at: new Date().toISOString(),
      });
    }

    return Response.json({
      status: "success",
      total_results: totalResults,
      racer_stats: out.racerStats.length,
      racer_venue_stats: out.racerVenueStats.length,
      racer_lane_stats: out.racerLaneStats.length,
      racer_weather_stats: out.racerWeatherStats.length,
      venue_race_stats: out.venueRaceStats.length,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    if (base44) {
      try {
        const ml = await base44.asServiceRole.entities.AggregationMeta.filter({ config_id: "main" });
        if (ml[0]) await base44.asServiceRole.entities.AggregationMeta.update(ml[0].id, { status: "error", error_msg: String(error.message || error).slice(0, 500) });
      } catch {}
    }
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
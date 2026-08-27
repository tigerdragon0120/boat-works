import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { computeTrustScoreFromAggregates } from "../../shared/analysis.js";
import { windSpeedGroup } from "../../shared/aggregation.js";

// BOAT WORKS 1号艇信頼スコア計算（集計Entityベース・v3）
// RaceResultを直接読まず、RacerStats/RacerVenueStats/RacerWeatherStatsから計算。

export default async function(req: any) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceId = body.race_id;
    if (!raceId) return Response.json({ status: "error", message: "race_id が必要です" }, { status: 400 });

    const race = await base44.asServiceRole.entities.Race.get(raceId).catch(() => null);
    if (!race) return Response.json({ status: "error", message: "レースが見つかりません" }, { status: 404 });

    const entries = await base44.asServiceRole.entities.RaceEntry.filter({ race_id: raceId }, "boat_number", 6);
    const boat1 = entries.find((e: any) => e.boat_number === 1);
    if (!boat1) return Response.json({ status: "error", message: "1号艇データがありません" }, { status: 400 });

    const settingsList = await base44.asServiceRole.entities.AppSettings.filter({ is_active_config: true });
    const settings = settingsList[0] || {};

    const regNum = boat1.registration_number;
    const venueCode = race.venue_code;

    // 集計Entityから取得
    let racerStat = null, racerVenueStat = null, weatherStat = null;

    if (regNum) {
      const rsList = await base44.asServiceRole.entities.RacerStats.filter({ registration_number: regNum }, "registration_number", 5).catch(() => []);
      racerStat = rsList[0] || null;

      const rvsList = await base44.asServiceRole.entities.RacerVenueStats.filter({ registration_number: regNum, venue_code: venueCode }, "registration_number", 5).catch(() => []);
      racerVenueStat = rvsList[0] || null;

      // 天候一致stat
      if (race.weather) {
        const wsg = windSpeedGroup(race.wind_speed);
        const rwsList = await base44.asServiceRole.entities.RacerWeatherStats.filter(
          { registration_number: regNum, venue_code: venueCode, weather: race.weather, wind_speed_group: wsg },
          "registration_number", 10
        ).catch(() => []);
        weatherStat = rwsList[0] || null;
      }
    }

    const trust = computeTrustScoreFromAggregates(boat1, racerVenueStat, racerStat, settings, race.venue_name, weatherStat);

    return Response.json({
      status: "success",
      ...trust,
      boat1_name: boat1.racer_name,
      boat1_grade_class: boat1.grade_class,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
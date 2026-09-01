import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS, gradeBoat1, syntheticOdds, expectedValue, judge, similarityScore } from "../../shared/uichi.js";

// BOAT WORKS 旧単発分析関数（互換用）
// 現行v10の正式分析は analyzeAllRacesForDate が唯一の保存経路。
// この関数は旧UI等から呼ばれてもv10分析を上書きしない。

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { race_id, stage = "pre", odds } = body;
    if (!race_id) return Response.json({ error: "race_id required" }, { status: 400 });

    // レース・出走表取得
    let race;
    try {
      race = await base44.asServiceRole.entities.Race.get(race_id);
    } catch {
      return Response.json({ error: "race not found" }, { status: 404 });
    }

    const entries = await base44.asServiceRole.entities.RaceEntry.filter({ race_id });
    const boat1 = entries.find((e) => e.boat_number === 1);
    const boat1Grade = gradeBoat1(boat1);

    // 設定取得
    const settingsList = await base44.asServiceRole.entities.AppSettings.filter({ is_active_config: true });
    const settings = settingsList[0] || { buy_threshold: 110, watch_threshold: 100, min_similar_races: 30 };

    // 過去結果から類似レース抽出
    const pastResults = await base44.asServiceRole.entities.RaceResult.list("-race_date", 500);
    const target = {
      venue_code: race.venue_code,
      boat1_grade: boat1Grade,
      boat1_national_win_rate: boat1?.national_win_rate,
      boat1_local_win_rate: boat1?.local_win_rate,
      boat1_avg_st: boat1?.avg_st,
    };
    const similar = pastResults.filter((p) => similarityScore(target, p) >= 55);
    const similarCount = similar.length;
    const uichiHits = similar.filter((p) => p.is_uichi).length;
    const appearanceRate = similarCount > 0 ? uichiHits / similarCount : 0;

    // 合成オッズ
    let synthOdds = 0;
    let oddsArr = [];
    if (odds && stage !== "pre") {
      oddsArr = UICHI_COMBOS.map((c) => {
        const key = "odds_" + c.replace(/-/g, "_");
        return odds[key];
      });
      synthOdds = syntheticOdds(oddsArr);
    }

    const ev = stage === "pre" ? null : expectedValue(appearanceRate, synthOdds);
    const minOk = similarCount >= (settings.min_similar_races || 30);

    let judgment = "PENDING";
    if (stage === "pre") {
      // 前日評価は出現率ベースの等級
      judgment = "PENDING";
    } else if (minOk) {
      judgment = judge(ev, settings);
    } else {
      judgment = "PENDING";
    }

    // v10正式分析が既にある場合は旧ロジックで上書きしない。
    const v10Rows = await base44.asServiceRole.entities.UichiAnalysis.filter({ race_id, stage, analysis_version: "v10" }, "-captured_at", 1).catch(() => []);
    if (v10Rows.length > 0) {
      return Response.json({ status: "delegated", race_id, stage, analysis_id: v10Rows[0].id, message: "v10正式分析を保持" });
    }

    // 旧互換分析結果保存。同一race_id/stageは1件だけ。
    const payload = {
      race_id,
      race_date: race.race_date,
      venue_code: race.venue_code,
      venue_name: race.venue_name,
      race_number: race.race_number,
      stage,
      similar_count: similarCount,
      uichi_hits: uichiHits,
      appearance_rate: appearanceRate,
      synthetic_odds: synthOdds,
      expected_value: ev,
      judgment,
      boat1_grade: boat1Grade,
      boat1_score: boat1 ? boat1.national_win_rate || 0 : 0,
      min_similar_ok: minOk,
      captured_at: new Date().toISOString(),
    };
    const existing = await base44.asServiceRole.entities.UichiAnalysis.filter({ race_id, stage }, "-captured_at", 5).catch(() => []);
    const analysis = existing.length > 0
      ? await base44.asServiceRole.entities.UichiAnalysis.update(existing[0].id, payload)
      : await base44.asServiceRole.entities.UichiAnalysis.create(payload);

    return Response.json({
      status: "ok",
      race_id,
      stage,
      boat1_grade: boat1Grade,
      similar_count: similarCount,
      uichi_hits: uichiHits,
      appearance_rate: appearanceRate,
      synthetic_odds: synthOdds,
      expected_value: ev,
      judgment,
      min_similar_ok: minOk,
      analysis_id: analysis.id,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
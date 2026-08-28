import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { computeRaceAnalysis, shouldGenerateAlert, ANALYSIS_VERSION } from "../../shared/analysis.js";

// BOAT WORKS 翌日全場一括事前分析（集計Entityベース・v3）
// RaceResult全件を読まず、RacerStats/RacerVenueStats/VenueRaceStats等から分析。
// データ量に依存せず数分以内に完了。
//
// 入力: { race_date, stage?: "pre"|"final", race_ids?: string[], force?: boolean }
// ワークフロー/管理者から呼出可能。

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") return Response.json({ status: "error", message: "管理者権限が必要です" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { race_date, stage = "pre", race_ids = null, force = false } = body;
    if (!race_date) return Response.json({ status: "error", message: "race_date が必要です" }, { status: 400 });

    const t0 = Date.now();

    // 設定
    const settingsList = await base44.asServiceRole.entities.AppSettings.filter({ is_active_config: true });
    const settings = settingsList[0] || {};
    const settingsVersion = settings.settings_version || 1;

    // 対象レース取得
    const races = await base44.asServiceRole.entities.Race.filter({ race_date, data_source: "official" }, "race_number", 300);
    let targetRaces = races;
    if (race_ids && Array.isArray(race_ids) && race_ids.length > 0) {
      const idSet = new Set(race_ids);
      targetRaces = races.filter(r => idSet.has(r.id));
    }
    if (targetRaces.length === 0) {
      return Response.json({ status: "no_races", race_date, analyzed: 0, elapsed_ms: Date.now() - t0 });
    }

    // 出走表一括取得
    const allEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_date }, "boat_number", 2000);
    const entriesByRace = {};
    for (const e of allEntries) (entriesByRace[e.race_id] = entriesByRace[e.race_id] || []).push(e);

    // オッズ一括取得（final時のみ）
    let oddsByRace = {};
    if (stage !== "pre") {
      const allOdds = await base44.asServiceRole.entities.OddsSnapshot.filter({ race_date }, "-captured_at", 500);
      for (const o of allOdds) { if (!oddsByRace[o.race_id]) oddsByRace[o.race_id] = o; }
    }

    // 既存キャッシュ確認
    const existing = await base44.asServiceRole.entities.UichiAnalysis.filter(
      { race_date, stage, analysis_version: ANALYSIS_VERSION }, "-captured_at", 500
    );
    const existingMap = {};
    for (const a of existing) {
      if (!force && a.settings_version === settingsVersion) existingMap[a.race_id] = a;
    }

    // === 集計データ一括取得（RaceResult不使用・固定クエリ数） ===
    // 1. VenueRaceStats全件
    const allVRS = await base44.asServiceRole.entities.VenueRaceStats.list("venue_code", 500);
    const venueRaceStats = {};
    for (const v of allVRS) (venueRaceStats[v.venue_code] = venueRaceStats[v.venue_code] || {})[v.race_number] = v;

    // 2. VenueStats
    const allVS = await base44.asServiceRole.entities.VenueStats.filter({ data_source: "official" }, "venue_code", 50);
    const venueStats = {};
    for (const v of allVS) venueStats[v.venue_code] = v;

    // 3. 対象レースの1号艇登録番号リスト
    const boat1Regs = new Set();
    for (const r of targetRaces) {
      const b1 = (entriesByRace[r.id] || []).find(e => e.boat_number === 1);
      if (b1?.registration_number) boat1Regs.add(b1.registration_number);
    }
    const regList = [...boat1Regs];

    const racerStats = {};
    const racerVenueStats = {};
    const racerWeatherStats = {};

    if (regList.length > 0) {
      // RacerStats
      const allRS = await base44.asServiceRole.entities.RacerStats.filter({ registration_number: { $in: regList } }, "registration_number", 500);
      for (const r of allRS) racerStats[r.registration_number] = r;

      // RacerVenueStats
      const allRVS = await base44.asServiceRole.entities.RacerVenueStats.filter({ registration_number: { $in: regList } }, "registration_number", 5000);
      for (const r of allRVS) (racerVenueStats[r.registration_number] = racerVenueStats[r.registration_number] || {})[r.venue_code] = r;

      // RacerWeatherStats
      const allRWS = await base44.asServiceRole.entities.RacerWeatherStats.filter({ registration_number: { $in: regList } }, "registration_number", 5000);
      for (const r of allRWS) {
        (racerWeatherStats[r.registration_number] = racerWeatherStats[r.registration_number] || {});
        (racerWeatherStats[r.registration_number][r.venue_code] = racerWeatherStats[r.registration_number][r.venue_code] || []).push(r);
      }
    }

    // AggregationMeta
    const metaList = await base44.asServiceRole.entities.AggregationMeta.filter({ config_id: "main" });
    const totalRaces = metaList[0]?.total_races_processed ?? 0;

    const stats = { venueRaceStats, racerStats, racerVenueStats, racerWeatherStats, venueStats, totalRaces };

    // 既存Alert一括取得
    const existingAlerts = await base44.asServiceRole.entities.Alert.filter({ race_date, status: "active" }, "race_id", 500);
    const alertByRace = {};
    for (const al of existingAlerts) alertByRace[al.race_id] = al;

    // === 分析実行（8レース並列バッチ） ===
    let analyzed = 0, skipped = 0, errors = 0, alertCandidates = 0;
    const BATCH = 8;
    const now = new Date().toISOString();

    for (let i = 0; i < targetRaces.length; i += BATCH) {
      const batchRaces = targetRaces.slice(i, i + BATCH);
      await Promise.all(batchRaces.map(async (r) => {
        try {
          if (!force && existingMap[r.id]) { skipped++; return; }
          const entries = entriesByRace[r.id] || [];
          if (entries.length === 0) { errors++; return; }
          const odds = stage === "pre" ? null : (oddsByRace[r.id] || null);
          const a = computeRaceAnalysis(r, entries, odds, stats, settings, stage);

          const payload = {
            race_id: r.id, race_date: r.race_date, venue_code: r.venue_code, venue_name: r.venue_name,
            race_number: r.race_number, stage,
            similar_count: a.similar_count, uichi_hits: a.uichi_hits, appearance_rate: a.appearance_rate,
            ura_uichi_hits: a.ura_uichi_hits, ura_uichi_rate: a.ura_uichi_rate,
            synthetic_odds: a.synthetic_odds, expected_value: a.expected_value, judgment: a.judgment,
            boat1_grade: a.boat1_grade, boat1_score: a.boat1?.national_win_rate || 0, min_similar_ok: a.min_similar_ok,
            captured_at: now, analyzed_at: now,
            reliability: a.reliability, data_sufficiency: a.data_sufficiency,
            boat1_trust_score: a.boat1_trust_score, condition_match_score: a.condition_match_score,
            weighted_probability: a.weighted_probability, pre_grade: a.pre_grade,
            analysis_version: ANALYSIS_VERSION, settings_version: settingsVersion,
            reasons: a.reasons, concerns: a.concerns, condition_matches: a.condition_matches,
            trust_components: a.boat1_trust?.components || [],
            outer_boat_score: a.outer_boat_score, outer_boat_number: a.outer_boat_number,
            outer_boat_name: a.outer_boat_name, outer_boat_reasons: a.outer_boat_reasons || [],
            boat1_registration_number: a.boat1?.registration_number,
            boat1_racer_name: a.boat1?.racer_name, boat1_grade_class: a.boat1?.grade_class,
            total_pool: a.total_pool, valid_pool: a.valid_pool,
          };

          if (existingMap[r.id]) {
            await base44.asServiceRole.entities.UichiAnalysis.update(existingMap[r.id].id, payload);
          } else {
            await base44.asServiceRole.entities.UichiAnalysis.create(payload);
          }
          analyzed++;

          if (shouldGenerateAlert(a, settings, stage)) {
            alertCandidates++;
            await ensureAlert(base44, r, a, stage, settings, alertByRace);

            // 翌日preのS/A候補はSlackへ1回だけ通知。
            // Slack側の重複防止はnotifySlackAlertのslack_pre_notifiedで管理する。
            if (stage === "pre" && settings.slack_notification_on !== false && settings.slack_pre_notify !== false) {
              try {
                await base44.asServiceRole.functions.invoke("notifySlackAlert", {
                  race_id: r.id,
                  stage: "pre",
                });
              } catch (_) { /* Slack失敗で分析本体を止めない */ }
            }
          } else if (stage === "pre" && alertByRace[r.id]) {
            // v4再分析でS/Aから外れた旧候補はHome/Slack対象から外す。
            await base44.asServiceRole.entities.Alert.update(alertByRace[r.id].id, { status: "filtered_out" });
          }
        } catch (e) { errors++; }
      }));
    }

    return Response.json({
      status: "success",
      race_date, stage,
      analysis_version: ANALYSIS_VERSION, settings_version: settingsVersion,
      total: targetRaces.length, analyzed, skipped, errors, alert_candidates: alertCandidates,
      total_races_aggregated: totalRaces,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}

async function ensureAlert(base44, race, analysis, stage, settings, alertByRace) {
  const existing = alertByRace[race.id];
  const common = {
    race_date: race.race_date, venue_code: race.venue_code, venue_name: race.venue_name,
    race_number: race.race_number, deadline: race.deadline, status: "active", notified: false,
  };
  if (stage === "pre") {
    const payload = { ...common, pre_appearance_rate: analysis.appearance_rate, pre_grade: analysis.pre_grade };
    if (existing) await base44.asServiceRole.entities.Alert.update(existing.id, payload);
    else await base44.asServiceRole.entities.Alert.create({ ...payload, race_id: race.id });
  } else {
    const payload = { ...common, final_judgment: analysis.judgment, final_expected_value: analysis.expected_value, synthetic_odds: analysis.synthetic_odds };
    if (existing) await base44.asServiceRole.entities.Alert.update(existing.id, payload);
    else await base44.asServiceRole.entities.Alert.create({ ...payload, race_id: race.id });
  }
}
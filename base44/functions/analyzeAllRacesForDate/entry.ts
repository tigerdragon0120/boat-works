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
    const rebuildBaseline = body.rebuild_baseline === true;
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

    // pre分析は「場の全12R・各6艇」が揃った後だけ許可する。
    // 1Rずつ先に分析すると展示前基準点が不揃いになるため、中央関数でも場単位ゲートを掛ける。
    if (stage === "pre") {
      const racesByVenue = {};
      for (const r of races) (racesByVenue[r.venue_code] = racesByVenue[r.venue_code] || []).push(r);
      const completeVenues = new Set();
      for (const [jcd, rows] of Object.entries(racesByVenue)) {
        const nums = new Set(rows.map(r => Number(r.race_number)));
        const all12 = rows.length === 12 && Array.from({length:12},(_,i)=>i+1).every(n=>nums.has(n));
        const entries12 = all12 && rows.every(r => (entriesByRace[r.id] || []).length >= 6);
        if (entries12) completeVenues.add(jcd);
      }
      targetRaces = targetRaces.filter(r => completeVenues.has(r.venue_code));
      if (targetRaces.length === 0) {
        return Response.json({ status:"waiting_venue_complete", race_date, stage, analyzed:0, message:"場の全12R・各6艇が揃うまでpre分析を開始しません", elapsed_ms:Date.now()-t0 });
      }
    }

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
      // force=trueでも既存レコードは更新対象として必ず保持する。
      // これを外すと再分析のたびに同一race_id/stage/versionが重複作成される。
      if (!existingMap[a.race_id]) existingMap[a.race_id] = a;
    }

    // 学習用原本。pre時点の特徴量を固定保存し、final/結果で後から追記する。
    const learningRows = await base44.asServiceRole.entities.UichiLearningSample.filter(
      { race_date }, "race_number", 500
    ).catch(() => []);
    const learningByRace = {};
    for (const row of learningRows) learningByRace[row.race_id] = row;

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

    // v10: 前夜確定したシリーズ選手ポイント。予想対象日より前の最新snapshotだけ使い、未来情報を混ぜない。
    const seriesKeys = [...new Set(targetRaces.map(r=>r.series_key).filter(Boolean))];
    const seriesPointsBySeries = {};
    if (seriesKeys.length > 0) {
      const allSP = await base44.asServiceRole.entities.SeriesRacerPoint.filter({ series_key: { $in: seriesKeys } }, '-as_of_date', 3000).catch(()=>[]);
      for (const p of allSP) {
        if (!p.series_key || !p.registration_number || !p.as_of_date || p.as_of_date >= race_date) continue;
        seriesPointsBySeries[p.series_key] = seriesPointsBySeries[p.series_key] || {};
        if (!seriesPointsBySeries[p.series_key][p.registration_number]) seriesPointsBySeries[p.series_key][p.registration_number] = p;
      }
    }

    // AggregationMeta
    const metaList = await base44.asServiceRole.entities.AggregationMeta.filter({ config_id: "main" });
    const totalRaces = metaList[0]?.total_races_processed ?? 0;

    const stats = { venueRaceStats, racerStats, racerVenueStats, racerWeatherStats, venueStats, totalRaces, seriesPointsBySeries };

    // 既存Alert一括取得。
    // resolved/filtered_outも含めてrace_id単位で再利用し、再分析のたびに重複Alertを作らない。
    const existingAlerts = await base44.asServiceRole.entities.Alert.filter({ race_date }, "-updated_date", 500);
    const alertByRace = {};
    for (const al of existingAlerts) {
      const cur = alertByRace[al.race_id];
      if (!cur) {
        alertByRace[al.race_id] = al;
        continue;
      }
      const curFinal = cur.final_judgment && cur.final_judgment !== "PENDING";
      const alFinal = al.final_judgment && al.final_judgment !== "PENDING";
      // final確定済みAlertを優先。両方同条件ならupdated_dateが新しい方（取得順の先頭）を維持。
      if (alFinal && !curFinal) alertByRace[al.race_id] = al;
    }

    // === 分析実行（8レース並列バッチ） ===
    let analyzed = 0, skipped = 0, errors = 0, alertCandidates = 0;
    const errorDetails = [];
    const BATCH = 8;
    const now = new Date().toISOString();

    for (let i = 0; i < targetRaces.length; i += BATCH) {
      const batchRaces = targetRaces.slice(i, i + BATCH);
      await Promise.all(batchRaces.map(async (r) => {
        try {
          // 展示前基準点(pre)は一度作ったら通常処理では上書きしない。
          // 明示的rebuild_baseline=trueの場合も、展示情報が既に入ったレースは基準点再作成を禁止する。
          if (stage === "pre" && existingMap[r.id]) {
            if (!rebuildBaseline || r.exhibition_ready === true || (entriesByRace[r.id] || []).some(e => e.exhibition_time != null || e.exhibition_st != null)) {
              skipped++; return;
            }
          } else if (!force && existingMap[r.id] && existingMap[r.id].settings_version === settingsVersion) { skipped++; return; }
          const entries = entriesByRace[r.id] || [];
          if (entries.length < 6) {
            errors++;
            errorDetails.push({ race_id: r.id, venue_code: r.venue_code, race_number: r.race_number, phase: "entries", message: `${entries.length}艇のため分析対象外` });
            return;
          }
          const odds = stage === "pre" ? null : (oddsByRace[r.id] || null);
          // 2日目以降は前日までの節間ポイントが無い状態でpre分析しない。
          if (stage === "pre" && Number(r.series_day || 1) > 1) {
            const bySeries = seriesPointsBySeries[r.series_key] || {};
            if (Object.keys(bySeries).length === 0) {
              skipped++;
              errorDetails.push({ race_id:r.id, venue_code:r.venue_code, race_number:r.race_number, phase:"series_points", message:"前日までの節間ポイント未確定のためpre分析待機" });
              return;
            }
          }
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
            weighted_probability: a.weighted_probability,
            has_scratch: a.has_scratch === true,
            scratched_boats: a.scratched_boats || [],
            recommended_pattern: a.recommended_pattern, recommended_rate: a.recommended_rate,
            recommended_structure: a.recommended_structure, pre_grade: a.pre_grade,
            analysis_version: ANALYSIS_VERSION, settings_version: settingsVersion,
            reasons: a.reasons, concerns: a.concerns, condition_matches: a.condition_matches,
            trust_components: a.boat1_trust?.components || [],
            outer_boat_score: a.outer_boat_score, outer_boat_number: a.outer_boat_number,
            outer_boat_name: a.outer_boat_name, outer_boat_reasons: a.outer_boat_reasons || [],
            uichi_direction_index: a.uichi_direction_index,
            uichi_direction_label: a.uichi_direction_label,
            uichi_direction_confidence: a.uichi_direction_confidence,
            uichi_main_suitability: a.uichi_main_suitability,
            uichi_ura_suitability: a.uichi_ura_suitability,
            uichi_main_structure: a.uichi_main_structure,
            uichi_ura_structure: a.uichi_ura_structure,
            mid_second_score: a.mid_second_score,
            mid_third_score: a.mid_third_score,
            outer_second_score: a.outer_second_score,
            outer_third_score: a.outer_third_score,
            historical_direction: a.historical_direction,
            program_hypothesis: a.program_hypothesis,
            program_main_intent: a.program_main_intent,
            program_ura_intent: a.program_ura_intent,
            program_intent_confidence: a.program_intent_confidence,
            program_axis_placement: a.program_axis_placement,
            racer_escape_execution: a.racer_escape_execution,
            racer_main_execution: a.racer_main_execution,
            racer_ura_execution: a.racer_ura_execution,
            motor_main_support: a.motor_main_support,
            motor_ura_support: a.motor_ura_support,
            motor_boat1_support: a.motor_boat1_support,
            program_scenario_status: a.program_scenario_status,
            program_scenario_label: a.program_scenario_label,
            program_scenario_penalty: a.program_scenario_penalty,
            exhibition_gate_status: a.exhibition_gate_status,
            final_escape_score: a.final_escape_score,
            exhibition_score: a.exhibition_score,
            weather_escape_score: a.weather_escape_score,
            exhibition_rank: a.exhibition_rank,
            exhibition_time: a.exhibition_time,
            exhibition_st: a.exhibition_st,
            exhibition_st_raw: a.exhibition_st_raw,
            exhibition_entry_course: a.exhibition_entry_course,
            exhibition_ready: a.exhibition_ready === true,
            exhibition_reasons: a.exhibition_reasons || [],
            uichi_direction_reasons: a.uichi_direction_reasons || [],
            boat1_registration_number: a.boat1?.registration_number,
            boat1_racer_name: a.boat1?.racer_name, boat1_grade_class: a.boat1?.grade_class,
            total_pool: a.total_pool, valid_pool: a.valid_pool,
          };

          if (existingMap[r.id]) {
            await base44.asServiceRole.entities.UichiAnalysis.update(existingMap[r.id].id, payload);
          } else {
            await base44.asServiceRole.entities.UichiAnalysis.create(payload);
          }

          // 学習用スナップショットはpreで元データまで固定。finalではEV/判定だけ追記する。
          const currentLearning = learningByRace[r.id];
          if (stage === "pre") {
            const learningPayload = {
              race_id: r.id, race_date: r.race_date, venue_code: r.venue_code, venue_name: r.venue_name,
              race_number: r.race_number, analysis_version: ANALYSIS_VERSION,
              captured_at: now, updated_at: now,
              program_hypothesis: a.program_hypothesis,
              program_main_intent: a.program_main_intent,
              program_ura_intent: a.program_ura_intent,
              program_intent_confidence: a.program_intent_confidence,
              program_axis_placement: a.program_axis_placement,
              racer_escape_execution: a.racer_escape_execution,
              racer_main_execution: a.racer_main_execution,
              racer_ura_execution: a.racer_ura_execution,
              motor_main_support: a.motor_main_support,
              motor_ura_support: a.motor_ura_support,
              motor_boat1_support: a.motor_boat1_support,
              program_scenario_status: a.program_scenario_status,
              direction_index: a.uichi_direction_index,
              direction_confidence: a.uichi_direction_confidence,
              recommended_pattern: a.recommended_pattern,
              recommended_rate: a.recommended_rate,
              recommended_structure: a.recommended_structure,
              pre_grade: a.pre_grade,
              boat1_trust_score: a.boat1_trust_score,
              condition_match_score: a.condition_match_score,
              entries_snapshot: snapshotEntries(entries),
              outcome_pattern: currentLearning?.outcome_pattern || "PENDING",
            };
            if (currentLearning) await base44.asServiceRole.entities.UichiLearningSample.update(currentLearning.id, learningPayload);
            else {
              const createdLearning = await base44.asServiceRole.entities.UichiLearningSample.create(learningPayload);
              learningByRace[r.id] = createdLearning;
            }
          } else if (currentLearning) {
            await base44.asServiceRole.entities.UichiLearningSample.update(currentLearning.id, {
              updated_at: now,
              final_judgment: a.judgment,
              final_expected_value: a.expected_value,
              final_synthetic_odds: a.synthetic_odds,
              recommended_pattern: a.recommended_pattern,
              recommended_rate: a.recommended_rate,
              recommended_structure: a.recommended_structure,
              direction_index: a.uichi_direction_index,
              direction_confidence: a.uichi_direction_confidence,
            });
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
            // final確定後はpre再分析でAlert状態を絶対に上書きしない。
            const existingAlert = alertByRace[r.id];
            const hasDefinitiveFinal = existingAlert?.final_judgment && existingAlert.final_judgment !== "PENDING";
            if (!hasDefinitiveFinal) {
              // v4再分析でS/Aから外れた旧候補はHome/Slack対象から外す。
              await base44.asServiceRole.entities.Alert.update(existingAlert.id, { status: "filtered_out" });
            }
          } else if (stage === "final" && alertByRace[r.id]) {
            // 欠場などで一度のBUY/WATCHがSKIPへ変わった場合も、Alertの最終判定を必ず同期する。
            await ensureAlert(base44, r, a, stage, settings, alertByRace);
          }
        } catch (e) {
          errors++;
          errorDetails.push({
            race_id: r.id,
            venue_code: r.venue_code,
            race_number: r.race_number,
            phase: "analysis",
            message: e?.message || String(e),
          });
        }
      }));
    }

    return Response.json({
      status: "success",
      race_date, stage,
      analysis_version: ANALYSIS_VERSION, settings_version: settingsVersion,
      total: targetRaces.length, analyzed, skipped, errors, alert_candidates: alertCandidates,
      error_details: errorDetails.slice(0, 50),
      total_races_aggregated: totalRaces,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}

function snapshotEntries(entries) {
  return [...entries].sort((a,b) => Number(a.boat_number) - Number(b.boat_number)).map(e => ({
    boat_number: e.boat_number,
    registration_number: e.registration_number,
    racer_name: e.racer_name,
    grade_class: e.grade_class,
    national_win_rate: e.national_win_rate,
    national_2rate: e.national_2rate,
    national_3rate: e.national_3rate,
    local_win_rate: e.local_win_rate,
    local_2rate: e.local_2rate,
    local_3rate: e.local_3rate,
    c1_win_rate: e.c1_win_rate,
    c1_2rate: e.c1_2rate,
    c1_3rate: e.c1_3rate,
    avg_st: e.avg_st,
    f_count: e.f_count,
    motor_number: e.motor_number,
    motor_2rate: e.motor_2rate,
    motor_3rate: e.motor_3rate,
    boat_2rate: e.boat_2rate,
    boat_3rate: e.boat_3rate,
  }));
}

async function ensureAlert(base44, race, analysis, stage, settings, alertByRace) {
  const existing = alertByRace[race.id];
  const common = {
    race_date: race.race_date, venue_code: race.venue_code, venue_name: race.venue_name,
    race_number: race.race_number, deadline: race.deadline, status: "active", notified: false,
  };
  if (stage === "pre") {
    // final確定後のAlertはロック。後からpreが来てもBUY/WATCH/SKIPを壊さない。
    if (existing?.final_judgment && existing.final_judgment !== "PENDING") return;
    const payload = {
      ...common,
      pre_appearance_rate: analysis.recommended_rate ?? analysis.appearance_rate,
      pre_grade: analysis.pre_grade,
      recommended_pattern: analysis.recommended_pattern,
      direction_index: analysis.uichi_direction_index,
      direction_confidence: analysis.uichi_direction_confidence,
    };
    if (existing) await base44.asServiceRole.entities.Alert.update(existing.id, payload);
    else await base44.asServiceRole.entities.Alert.create({ ...payload, race_id: race.id });
  } else {
    const payload = { ...common, final_judgment: analysis.judgment, final_expected_value: analysis.expected_value, synthetic_odds: analysis.synthetic_odds };
    if (existing) await base44.asServiceRole.entities.Alert.update(existing.id, payload);
    else await base44.asServiceRole.entities.Alert.create({ ...payload, race_id: race.id });
  }
}
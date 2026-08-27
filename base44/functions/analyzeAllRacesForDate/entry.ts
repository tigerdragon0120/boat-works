import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { computeRaceAnalysis, shouldGenerateAlert, ANALYSIS_VERSION } from "../../shared/analysis.js";

// BOAT WORKS 翌日全場一括事前分析
// 指定日の全レースを一括分析し、UichiAnalysisへ保存・Alert生成する。
// メモリ上で履歴データを再利用し、レースごとのDB全検索を禁止。
//
// 入力: { race_date, stage?: "pre"|"final", race_ids?: string[], force?: boolean }
// stage=pre: 前日分析（オッズなし・BUY確定しない）
// stage=final: 直前分析（最新オッズ使用・BUY/WATCH/SKIP判定）
//
// 管理者専用。

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    // ワークフローからの呼び出し(ユーザーなし)は許可。HTTP呼び出しは管理者のみ。
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

    // 既存キャッシュ確認（race_id + stage + analysis_version + settings_version）
    const existing = await base44.asServiceRole.entities.UichiAnalysis.filter(
      { race_date, stage, analysis_version: ANALYSIS_VERSION }, "-captured_at", 500
    );
    const existingMap = {};
    for (const a of existing) {
      if (!force && a.settings_version === settingsVersion) existingMap[a.race_id] = a;
    }

    // === 履歴データ一括取得（一度だけ・インデックス構築） ===
    const byVenue = {};
    const byRegVenue = {};
    const byReg = {};
    let totalDone = 0, totalAll = 0;
    let skip = 0;
    while (skip < 20000) {
      const batch = await base44.asServiceRole.entities.RaceResult.filter({ data_source: "official" }, "-race_date", 500, skip);
      if (!batch || batch.length === 0) break;
      for (const p of batch) {
        totalAll++;
        const isDone = p.boat1_detail_status === "done" || (!p.boat1_detail_status && p.boat1_racer_name);
        if (!isDone) continue;
        totalDone++;
        (byVenue[p.venue_code] = byVenue[p.venue_code] || []).push(p);
        if (p.boat1_registration_number) {
          const k = `${p.venue_code}_${p.boat1_registration_number}`;
          (byRegVenue[k] = byRegVenue[k] || []).push(p);
          (byReg[p.boat1_registration_number] = byReg[p.boat1_registration_number] || []).push(p);
        }
      }
      if (batch.length < 500) break;
      skip += 500;
    }
    const history = { byVenue, byRegVenue, byReg, totalDone, totalAll };

    // 既存Alert一括取得（重複防止）
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
          if (!force && existingMap[r.id]) {
            skipped++;
            return;
          }
          const entries = entriesByRace[r.id] || [];
          if (entries.length === 0) { errors++; return; }
          const odds = stage === "pre" ? null : (oddsByRace[r.id] || null);
          const a = computeRaceAnalysis(r, entries, odds, history, settings, stage);

          const payload = {
            race_id: r.id,
            race_date: r.race_date,
            venue_code: r.venue_code,
            venue_name: r.venue_name,
            race_number: r.race_number,
            stage,
            similar_count: a.similar_count,
            uichi_hits: a.uichi_hits,
            appearance_rate: a.appearance_rate,
            synthetic_odds: a.synthetic_odds,
            expected_value: a.expected_value,
            judgment: a.judgment,
            boat1_grade: a.boat1_grade,
            boat1_score: a.boat1?.national_win_rate || 0,
            min_similar_ok: a.min_similar_ok,
            captured_at: now,
            analyzed_at: now,
            reliability: a.reliability,
            data_sufficiency: a.data_sufficiency,
            boat1_trust_score: a.boat1_trust_score,
            condition_match_score: a.condition_match_score,
            weighted_probability: a.weighted_probability,
            pre_grade: a.pre_grade,
            analysis_version: ANALYSIS_VERSION,
            settings_version: settingsVersion,
            reasons: a.reasons,
            concerns: a.concerns,
            condition_matches: a.condition_matches,
            trust_components: a.boat1_trust?.components || [],
            boat1_registration_number: a.boat1?.registration_number,
            boat1_racer_name: a.boat1?.racer_name,
            boat1_grade_class: a.boat1?.grade_class,
            total_pool: a.total_pool,
            valid_pool: a.valid_pool,
          };

          if (existingMap[r.id]) {
            await base44.asServiceRole.entities.UichiAnalysis.update(existingMap[r.id].id, payload);
          } else {
            await base44.asServiceRole.entities.UichiAnalysis.create(payload);
          }
          analyzed++;

          // Alert生成
          if (shouldGenerateAlert(a, settings, stage)) {
            alertCandidates++;
            await ensureAlert(base44, r, a, stage, settings, alertByRace);
          }
        } catch (e) {
          errors++;
        }
      }));
    }

    const elapsed = Date.now() - t0;
    return Response.json({
      status: "success",
      race_date,
      stage,
      analysis_version: ANALYSIS_VERSION,
      settings_version: settingsVersion,
      total: targetRaces.length,
      analyzed,
      skipped,
      errors,
      alert_candidates: alertCandidates,
      history_size: totalAll,
      history_done: totalDone,
      elapsed_ms: elapsed,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}

async function ensureAlert(base44, race, analysis, stage, settings, alertByRace) {
  const existing = alertByRace[race.id];
  const common = {
    race_date: race.race_date,
    venue_code: race.venue_code,
    venue_name: race.venue_name,
    race_number: race.race_number,
    deadline: race.deadline,
    status: "active",
    notified: false,
  };
  if (stage === "pre") {
    const payload = {
      ...common,
      pre_appearance_rate: analysis.appearance_rate,
      pre_grade: analysis.pre_grade,
    };
    if (existing) {
      await base44.asServiceRole.entities.Alert.update(existing.id, payload);
    } else {
      await base44.asServiceRole.entities.Alert.create({ ...payload, race_id: race.id });
    }
  } else {
    const payload = {
      ...common,
      final_judgment: analysis.judgment,
      final_expected_value: analysis.expected_value,
      synthetic_odds: analysis.synthetic_odds,
    };
    if (existing) {
      await base44.asServiceRole.entities.Alert.update(existing.id, payload);
    } else {
      await base44.asServiceRole.entities.Alert.create({ ...payload, race_id: race.id });
    }
  }
}
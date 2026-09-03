import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';
import { VENUE_NAMES } from "../../shared/scraper.js";

// BOAT WORKS 2 への読み取り専用データ提供API
// ・Bearer APIキー認証（BOAT_WORKS_2_API_KEY）
// ・指定日の公式データのみを一括取得し race_key で紐付け
// ・Entityへの書き込み（create/update/delete）は一切行わない（READ ONLY）
// ・N+1回避：日付単位でまとめて取得し Map で race_id -> race_key 変換

const RACE_FIELDS = [
  "race_date","venue_code","venue_name","race_number","race_name","grade","event_name",
  "series_key","series_start_date","series_end_date","series_total_days","series_day","is_final_day",
  "race_phase","deadline","time_slot","weather","wind_dir","wind_speed","wave_height",
  "air_temperature","water_temperature","beforeinfo_fetched_at","exhibition_ready",
  "scratched_boats","status","result_trifecta","is_uichi","payout_trifecta",
];

const ENTRY_FIELDS = [
  "race_date","venue_code","race_number","boat_number","registration_number","racer_name",
  "grade_class","branch","age","weight","national_win_rate","national_2rate","national_3rate",
  "local_win_rate","local_2rate","local_3rate","c1_win_rate","c1_2rate","c1_3rate","avg_st",
  "f_count","l_count","motor_number","motor_2rate","motor_3rate","boat_number_id","boat_2rate","boat_3rate",
  "entry_course","exhibition_time","exhibition_rank","exhibition_st","exhibition_st_raw","tilt","is_scratched",
];

const RESULT_FIELDS = [
  "race_date","venue_code","venue_name","race_number","result_1","result_2","result_3","trifecta",
  "is_uichi","uichi_combo","payout_trifecta","finishers","finish_time_count",
  "race_time_1_raw","race_time_2_raw","race_time_3_raw","race_time_1_seconds","race_time_2_seconds","race_time_3_seconds",
  "margin_1_2_seconds","margin_1_3_seconds","winning_method","start_info",
  "weather","wind_dir","wind_speed","wave_height","air_temperature","water_temperature","detail_fetched_at",
];

const ODDS_FIELDS = [
  "stage","captured_at","odds_1_2_5","odds_1_2_6","odds_1_3_5","odds_1_3_6","odds_1_4_5","odds_1_4_6",
  "synthetic_odds","all_trifecta_odds","scratched_boats","has_scratch",
];

// uichi_features: 判定(judgment/pre_grade/recommended_pattern)は含めない・補助特徴量のみ
const UICHI_FIELDS = [
  "stage","analysis_version","boat1_trust_score","condition_match_score","weighted_probability",
  "program_hypothesis","program_main_intent","program_ura_intent","program_intent_confidence","program_axis_placement",
  "racer_escape_execution","racer_main_execution","racer_ura_execution",
  "motor_main_support","motor_ura_support","motor_boat1_support",
  "program_scenario_status","program_scenario_label","program_scenario_penalty",
  "uichi_direction_index","uichi_direction_confidence","uichi_main_suitability","uichi_ura_suitability",
];

const SERIES_FIELDS = [
  "series_key","venue_code","registration_number","racer_name","grade_class","rank","point_rate",
  "total_points","penalty_points","races_run","remaining_races","lane_history","finish_history",
  "lane_finish_history","avg_lane","inner_lane_count","outer_lane_count","lane_difficulty_score",
  "result_quality_score","rank_pressure_score","series_momentum_score","series_score","raw_series_score",
  "series_sample_confidence","series_label","score_components","score_reasons",
  "alert_exclusion","alert_exclusion_reason","snapshot_at","algorithm_version",
];

const STAGE_PRIORITY = { final: 3, day: 2, pre: 1 };

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f] ?? null;
  return out;
}

function raceKeyOf(r) {
  return `${r.race_date}_${r.venue_code}_${String(r.race_number).padStart(2, "0")}`;
}

// 日付単位でまとめて取得（ページネーション付き・N+1回避）
async function fetchAllByDate(sr, entityName, date, sort, extraQuery = {}) {
  let all = [];
  let skip = 0;
  const pageSize = 500;
  while (true) {
    const batch = await sr[entityName].filter({ race_date: date, ...extraQuery }, sort, pageSize, skip).catch(() => []);
    if (!batch || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
    if (skip > 6000) break;
  }
  return all;
}

export default async function(req) {
  try {
    // === Bearer APIキー認証 ===
    const apiKey = secrets.get("BOAT_WORKS_2_API_KEY");
    if (!apiKey) {
      return Response.json({ status: "error", message: "API key not configured (BOAT_WORKS_2_API_KEY)" }, { status: 500 });
    }
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token || token !== apiKey) {
      return Response.json({ status: "error", message: "Unauthorized" }, { status: 401 });
    }

    // === date パラメータ（query param 優先、なければ JSON body） ===
    const url = new URL(req.url);
    let date = url.searchParams.get("date");
    if (!date) {
      const body = await req.json().catch(() => ({}));
      date = body?.date || null;
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ status: "error", message: "date (YYYY-MM-DD) is required" }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);
    const sr = base44.asServiceRole.entities;
    const warnings = [];
    const errors = [];
    const venueCodeParam = url.searchParams.get("venue_code");
    const venueCode = venueCodeParam ? String(venueCodeParam).padStart(2, "0") : null;
    const manifestOnly = url.searchParams.get("manifest") === "1";

    // 軽量manifest: 開催場一覧だけ返す。BOAT WORKS 2が場単位で分割同期するために使用。
    if (manifestOnly) {
      const manifestRaces = await fetchAllByDate(sr, "Race", date, "race_number");
      const official = manifestRaces.filter(r => r.data_source === "official");
      const venue_codes = [...new Set(official.map(r => String(r.venue_code).padStart(2, "0")))].sort();
      return Response.json({ status: "success", date, generated_at: new Date().toISOString(), venue_codes, race_count: official.length });
    }

    // === Races (official only) ===
    const races = await fetchAllByDate(sr, "Race", date, "race_number", venueCode ? { venue_code: venueCode } : {});
    const officialRaces = races.filter(r => r.data_source === "official");

    // race_key 生成 + 整合性チェック。
    // DB側に同一日・同一場・同一Rの重複が残っていても、exportでは1レースに正規化する。
    // ただし子データが古い重複Race ID側に紐づいている可能性があるため、全duplicate IDを同じrace_keyへマップする。
    const raceMap = {};       // race_id -> { race: canonicalRace, race_key }
    const validRaceIds = new Set();
    const logicalGroups = new Map();
    for (const r of officialRaces) {
      const raceKey = raceKeyOf(r);
      const vc = String(r.venue_code);
      const expectedName = VENUE_NAMES[vc] || VENUE_NAMES[vc.padStart(2, "0")];
      if (!expectedName || expectedName !== r.venue_name) {
        errors.push({
          race_id: r.id, race_key: raceKey, type: "venue_mismatch",
          message: `venue_code=${r.venue_code} venue_name=${r.venue_name} expected=${expectedName || "(unknown code)"}`,
        });
        continue;
      }
      if (r.race_number < 1 || r.race_number > 12) {
        warnings.push({ race_key: raceKey, type: "race_number_out_of_range", message: `race_number=${r.race_number}` });
      }
      if (!logicalGroups.has(raceKey)) logicalGroups.set(raceKey, []);
      logicalGroups.get(raceKey).push(r);
    }

    const validRaces = [];
    for (const [raceKey, group] of logicalGroups.entries()) {
      // 情報量が多いRaceを正規行として出力。並びが同点なら更新日時が新しい方。
      const richness = (r) => [
        "race_name","grade","event_name","series_key","series_start_date","series_end_date","series_day",
        "race_phase","deadline","beforeinfo_fetched_at","entries_fetched_at","odds_fetched_at",
      ].reduce((n, k) => n + (r?.[k] != null ? 1 : 0), 0) + (r?.exhibition_ready === true ? 3 : 0);
      const sorted = [...group].sort((a, b) => {
        const d = richness(b) - richness(a);
        if (d) return d;
        return String(b.updated_date || b.last_updated || "").localeCompare(String(a.updated_date || a.last_updated || ""));
      });
      const canonical = sorted[0];
      validRaces.push(canonical);
      for (const r of group) {
        raceMap[r.id] = { race: canonical, race_key: raceKey };
        validRaceIds.add(r.id);
      }
      if (group.length > 1) {
        warnings.push({ race_key: raceKey, type: "duplicate_race_key_normalized", message: `${group.length}件を1レースとして出力` });
      }
    }

    // === RaceEntry（日付単位一括取得） ===
    const allEntries = await fetchAllByDate(sr, "RaceEntry", date, "boat_number", venueCode ? { venue_code: venueCode } : {});
    const entriesByKey = {};
    for (const e of allEntries) {
      if (!validRaceIds.has(e.race_id)) continue;
      const raceKey = raceMap[e.race_id]?.race_key;
      if (!raceKey) continue;
      (entriesByKey[raceKey] = entriesByKey[raceKey] || []).push(e);
    }

    // entry 整合性チェック + 出力構築。duplicate Raceに分散した艇もrace_key単位で統合する。
    const entriesOut = [];
    for (const r of validRaces) {
      const raceKey = raceMap[r.id].race_key;
      const raceEntries = entriesByKey[raceKey] || [];
      const seenBoats = new Set();
      const filtered = [];
      for (const e of raceEntries) {
        if (e.boat_number == null || e.boat_number < 1 || e.boat_number > 6) {
          warnings.push({ race_key: raceKey, type: "boat_number_out_of_range", message: `boat_number=${e.boat_number}` });
          continue;
        }
        if (seenBoats.has(e.boat_number)) {
          warnings.push({ race_key: raceKey, type: "duplicate_boat", message: `boat_number=${e.boat_number} duplicated` });
          continue;
        }
        seenBoats.add(e.boat_number);
        filtered.push(e);
      }
      if (filtered.length > 6) {
        warnings.push({ race_key: raceKey, type: "too_many_entries", message: `${filtered.length} entries (expected max 6)` });
      }
      for (const e of filtered) {
        entriesOut.push({ race_key: raceKey, ...pick(e, ENTRY_FIELDS) });
      }
    }

    // === RaceResult（結果確定済みのみ） ===
    const allResults = await fetchAllByDate(sr, "RaceResult", date, "race_number", venueCode ? { venue_code: venueCode } : {});
    const resultsOut = [];
    for (const r of allResults) {
      if (!validRaceIds.has(r.race_id)) continue;
      if (r.result_1 == null) continue; // 結果未確定は除外
      resultsOut.push({ race_key: raceMap[r.race_id]?.race_key, ...pick(r, RESULT_FIELDS) });
    }

    // === OddsSnapshot ===
    const allOdds = await fetchAllByDate(sr, "OddsSnapshot", date, "captured_at");
    const oddsOut = [];
    for (const o of allOdds) {
      if (!validRaceIds.has(o.race_id)) continue;
      oddsOut.push({ race_key: raceMap[o.race_id]?.race_key, ...pick(o, ODDS_FIELDS) });
    }

    // === UichiAnalysis（補助特徴量のみ・判定は含めない） ===
    const allAnalyses = await fetchAllByDate(sr, "UichiAnalysis", date, "-captured_at", venueCode ? { venue_code: venueCode } : {});
    const analysisByKey = {};
    for (const a of allAnalyses) {
      if (!validRaceIds.has(a.race_id)) continue;
      const raceKey = raceMap[a.race_id]?.race_key;
      if (!raceKey) continue;
      const cur = analysisByKey[raceKey];
      const pri = STAGE_PRIORITY[a.stage] || 0;
      if (!cur) {
        analysisByKey[raceKey] = a;
      } else if (pri > (STAGE_PRIORITY[cur.stage] || 0)) {
        analysisByKey[raceKey] = a;
      } else if (pri === (STAGE_PRIORITY[cur.stage] || 0) &&
                 new Date(a.captured_at || 0) > new Date(cur.captured_at || 0)) {
        analysisByKey[raceKey] = a;
      }
    }
    const uichiOut = [];
    for (const r of validRaces) {
      const raceKey = raceMap[r.id].race_key;
      const a = analysisByKey[raceKey];
      if (!a) continue;
      uichiOut.push({ race_key: raceKey, ...pick(a, UICHI_FIELDS) });
    }

    // === SeriesRacerPoint（未来データ除外：snapshot_at <= race deadline の最新） ===
    const seriesKeys = [...new Set(validRaces.map(r => r.series_key).filter(Boolean))];
    let seriesAll = [];
    if (seriesKeys.length > 0) {
      for (let i = 0; i < seriesKeys.length; i += 50) {
        const batchKeys = seriesKeys.slice(i, i + 50);
        let sSkip = 0;
        while (true) {
          const batch = await sr.SeriesRacerPoint.filter(
            { series_key: { $in: batchKeys } }, "-snapshot_at", 500, sSkip
          ).catch(() => []);
          if (!batch || batch.length === 0) break;
          seriesAll = seriesAll.concat(batch);
          if (batch.length < 500) break;
          sSkip += 500;
          if (sSkip > 6000) break;
        }
      }
    }
    // (series_key, registration_number) -> snapshots (snapshot_at desc)
    const seriesGroup = {};
    for (const s of seriesAll) {
      const key = `${s.series_key}|${s.registration_number}`;
      (seriesGroup[key] = seriesGroup[key] || []).push(s);
    }
    for (const k of Object.keys(seriesGroup)) {
      seriesGroup[k].sort((a, b) => new Date(b.snapshot_at || 0) - new Date(a.snapshot_at || 0));
    }

    const seriesOut = [];
    for (const r of validRaces) {
      if (!r.series_key) continue;
      const raceKey = raceMap[r.id].race_key;
      const deadlineMs = r.deadline ? new Date(r.deadline).getTime() : Date.now();
      const raceEntries = entriesByKey[raceKey] || [];
      for (const e of raceEntries) {
        if (!e.registration_number) continue;
        const snaps = seriesGroup[`${r.series_key}|${e.registration_number}`];
        if (!snaps || snaps.length === 0) continue;
        // レース日時より後に作られたスナップショットは未来データとして除外
        const latest = snaps.find(s => {
          const t = s.snapshot_at ? new Date(s.snapshot_at).getTime() : 0;
          return t <= deadlineMs;
        });
        if (!latest) continue;
        seriesOut.push({ race_key: raceKey, ...pick(latest, SERIES_FIELDS) });
      }
    }

    // === Races 出力 ===
    const racesOut = validRaces.map(r => ({
      race_key: raceMap[r.id].race_key,
      ...pick(r, RACE_FIELDS),
    }));

    return Response.json({
      status: "success",
      date,
      generated_at: new Date().toISOString(),
      race_count: racesOut.length,
      entry_count: entriesOut.length,
      series_count: seriesOut.length,
      result_count: resultsOut.length,
      odds_count: oddsOut.length,
      uichi_feature_count: uichiOut.length,
      warnings,
      errors,
      races: racesOut,
      entries: entriesOut,
      series: seriesOut,
      results: resultsOut,
      odds: oddsOut,
      uichi_features: uichiOut,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
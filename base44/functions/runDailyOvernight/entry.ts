import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { VENUE_NAMES, parseDailyVenueList, parseDaySchedule, parseRacelist, parseSeriesContext, fetchWithRetry, sleep } from "../../shared/scraper.js";

// BOAT WORKS 日次夜間一括処理（ワークフロー用・サービスロール実行）
// 1. 翌日の開催場一覧取得
// 2. 各場のスケジュール取得 → Race保存
// 3. 各レースの出走表取得 → RaceEntry保存（オッズなし・pre分析用）
// 4. analyzeAllRacesForDate(tomorrow, stage=pre) 呼出で一括分析・Alert生成
//
// ワークフローから呼ばれるためユーザー認証不要。HTTP手動実行は管理者のみ。

const BASE = "https://boatrace.jp/owpc/pc/race";
const INDEX_URL = "https://boatrace.jp/owpc/pc/race/index";

function localDateStr(offset = 0) {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offset);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") return Response.json({ status: "error", message: "管理者権限が必要です" }, { status: 403 });

    const t0 = Date.now();
    const body = await req.json().catch(() => ({}));
    const targetOffset = Number(body.target_offset ?? 1);
    const skipAggregate = body.skip_aggregate === true;

    // 夜間処理では、まず昨日の公式結果を自動保存してから集計を更新する。
    // これにより過去RaceResultは毎日増え続け、手動バックフィル不要になる。
    let yesterdayResultUpdate = null;
    let aggregateUpdate = null;
    let learningMetricsUpdate = null;
    if (!skipAggregate) {
      // 23:50 JST実行なので、その日の全リザルトを当日分として確定する。
      const yStr = localDateStr(0);
      try {
        const venueRes = await base44.asServiceRole.functions.invoke("fetchDailyVenues", { race_date: yStr });
        const yVenues = venueRes?.data?.venues || venueRes?.venues || [];
        let success = 0, errors = 0, races = 0;
        const failedVenues = [];
        for (let i = 0; i < yVenues.length; i += 3) {
          const batch = yVenues.slice(i, i + 3);
          const results = await Promise.all(batch.map(async (jcd) => {
            try {
              const r = await base44.asServiceRole.functions.invoke("fetchHistoricalResults", { race_date: yStr, jcd });
              const data = r?.data || r;
              // 結果一覧だけで終わらせず、詳細ページから全艇着順・レースタイム・ST・決まり手・自然条件まで保存する。
              // この詳細が揃って初めて「ぶっちぎり/接戦」「勝負がけ時のST」「モーター状態」を後で学習できる。
              try {
                const d = await base44.asServiceRole.functions.invoke("enrichRaceResultDetails", { race_date: yStr, jcd });
                data.detail_enrichment = d?.data || d;
              } catch (e) {
                data.detail_enrichment = { status: "error", message: e?.message || String(e) };
              }
              // 場ごとに結果詳細が揃った直後、シリーズ選手ポイントを確定する。
              try {
                const s = await base44.asServiceRole.functions.invoke("refreshSeriesRacerPoints", { as_of_date: yStr, jcd });
                data.series_points = s?.data || s;
              } catch (e) {
                data.series_points = { status: "error", message: e?.message || String(e) };
              }
              return { ...data, _jcd: jcd };
            } catch (e) {
              return { status: "error", message: e.message, _jcd: jcd };
            }
          }));
          for (const r of results) {
            if (r?.status === "success" || r?.status === "no_races") {
              success++;
              races += r?.races || 0;
            } else {
              errors++;
              if (r?._jcd) failedVenues.push(r._jcd);
            }
          }
          await sleep(300);
        }

        // 一時的な公式サイト失敗で前夜スナップショットを欠損させないため、不成功場だけもう1回処理する。
        // 2回目でも失敗した場はpartialとして明示し、成功したふりをしない。
        let retryRecovered = 0;
        for (const jcd of [...new Set(failedVenues)]) {
          try {
            const rr = await base44.asServiceRole.functions.invoke("fetchHistoricalResults", { race_date: yStr, jcd });
            const rd = rr?.data || rr;
            if (rd?.status !== "success" && rd?.status !== "no_races") continue;
            try { await base44.asServiceRole.functions.invoke("enrichRaceResultDetails", { race_date: yStr, jcd }); } catch {}
            try { await base44.asServiceRole.functions.invoke("refreshSeriesRacerPoints", { as_of_date: yStr, jcd }); } catch {}
            retryRecovered++;
            success++;
            errors = Math.max(0, errors - 1);
            races += rd?.races || 0;
          } catch {}
          await sleep(250);
        }
        yesterdayResultUpdate = { status: errors === 0 ? "success" : "partial", venues: yVenues.length, success, errors, races, retry_recovered: retryRecovered };
      } catch (e) {
        yesterdayResultUpdate = { status: "error", message: e.message };
      }

      try {
        const aggRes = await base44.asServiceRole.functions.invoke("updateDailyAggregates", { race_date: yStr });
        aggregateUpdate = aggRes?.data || aggRes;
      } catch (e) {
        aggregateUpdate = { status: "error", message: e.message };
      }

      // 前日結果が揃った後、学習条件別の的中率を再集計する。
      // 100走未満は reliable=false のまま保持し、ロジックへ自動反映しない。
      try {
        const learnRes = await base44.asServiceRole.functions.invoke("refreshLearningMetrics", {});
        learningMetricsUpdate = learnRes?.data || learnRes;
      } catch (e) {
        learningMetricsUpdate = { status: "error", message: e.message };
      }
    }

    const raceDate = localDateStr(targetOffset);
    const hd = raceDate.replace(/-/g, "");

    // === 1. 開催場一覧取得 ===
    const indexRes = await fetchWithRetry(`${INDEX_URL}?hd=${hd}`, { headers: { "User-Agent": "Mozilla/5.0" } }, 10000, 2);
    const indexHtml = await indexRes.text();
    const jcds = parseDailyVenueList(indexHtml);
    if (jcds.length === 0) {
      return Response.json({ status: "no_venues", race_date: raceDate, elapsed_ms: Date.now() - t0 });
    }

    let totalRaces = 0, totalEntries = 0, fetchErrors = 0;
    const raceList = []; // {jcd, race_number, race_id}

    // === 2-3. 各場のスケジュール + 出走表取得 ===
    for (const jcd of jcds) {
      // スケジュール取得
      const schedUrl = `${BASE}/raceindex?jcd=${jcd}&hd=${hd}`;
      let schedule = [];
      try {
        const sRes = await fetchWithRetry(schedUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, 10000, 2);
        const sHtml = await sRes.text();
        schedule = parseDaySchedule(sHtml, raceDate);
        var seriesCtx = parseSeriesContext(sHtml, raceDate);
      } catch { fetchErrors++; continue; }
      if (schedule.length === 0) continue;

      const venueName = VENUE_NAMES[jcd] || jcd;
      const now = new Date().toISOString();

      // 既存Race取得（upsert）
      const existingRaces = await base44.asServiceRole.entities.Race.filter({ race_date: raceDate, venue_code: jcd, data_source: "official" });
      const raceMap = {};
      for (const r of existingRaces) raceMap[r.race_number] = r;

      // Race保存
      const savedRaces = {};
      for (const s of schedule) {
        const raceData = {
          race_date: raceDate, venue_code: jcd, venue_name: venueName,
          race_number: s.race_number, deadline: s.deadline,
          event_name: seriesCtx?.event_name || null,
          grade: seriesCtx?.grade || "GENERAL",
          series_key: `${jcd}_${seriesCtx?.series_start_date || raceDate}`,
          series_start_date: seriesCtx?.series_start_date || raceDate,
          series_end_date: seriesCtx?.series_end_date || raceDate,
          series_total_days: seriesCtx?.series_total_days || 1,
          series_day: seriesCtx?.series_day || 1,
          is_final_day: seriesCtx?.is_final_day === true,
          status: "scheduled", data_source: "official", last_updated: now,
        };
        let r;
        if (raceMap[s.race_number]) {
          r = await base44.asServiceRole.entities.Race.update(raceMap[s.race_number].id, raceData);
        } else {
          r = await base44.asServiceRole.entities.Race.create(raceData);
        }
        savedRaces[s.race_number] = r;
        raceList.push({ jcd, race_number: s.race_number, race_id: r.id });
        totalRaces++;
      }
      await sleep(400);

      // 出走表取得（5レース並列バッチ）
      const races = schedule.map(s => ({ ...s, race_id: savedRaces[s.race_number].id }));
      for (let i = 0; i < races.length; i += 5) {
        const batch = races.slice(i, i + 5);
        await Promise.all(batch.map(async (s) => {
          try {
            const rlUrl = `${BASE}/racelist?rno=${s.race_number}&jcd=${jcd}&hd=${hd}`;
            const rlRes = await fetchWithRetry(rlUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, 10000, 2);
            const rlHtml = await rlRes.text();
            const parsed = parseRacelist(rlHtml, s.race_number, raceDate);
            if (!parsed.entries.length || parsed.entries.length < 6) return;
            // Race更新（race_name, deadline, entries_fetched_at）
            await base44.asServiceRole.entities.Race.update(s.race_id, {
              race_name: parsed.raceName, race_phase: parsed.racePhase || "OTHER",
              deadline: parsed.deadline, entries_fetched_at: new Date().toISOString(),
            });
            // RaceEntry再保存
            await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: s.race_id });
            const records = parsed.entries.map(e => ({
              ...e, race_id: s.race_id, race_date: raceDate, venue_code: jcd, race_number: s.race_number,
            }));
            await base44.asServiceRole.entities.RaceEntry.bulkCreate(records);
            totalEntries += records.length;
          } catch { fetchErrors++; }
        }));
        await sleep(400);
      }
    }

    // === 4. RaceEntry完全性チェック + 欠損だけ再取得 ===
    // 6艇揃っていないレースを分析へ流さない。欠損分だけ最大1回補修する。
    const allEntriesAfterFetch = await base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, "boat_number", 3000);
    const entryCountByRace = {};
    for (const e of allEntriesAfterFetch) entryCountByRace[e.race_id] = (entryCountByRace[e.race_id] || 0) + 1;

    const incomplete = raceList.filter(r => (entryCountByRace[r.race_id] || 0) < 6);
    let repairedEntries = 0;
    for (let i = 0; i < incomplete.length; i += 3) {
      const batch = incomplete.slice(i, i + 3);
      await Promise.all(batch.map(async (r) => {
        try {
          const rlUrl = `${BASE}/racelist?rno=${r.race_number}&jcd=${r.jcd}&hd=${hd}`;
          const rlRes = await fetchWithRetry(rlUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, 10000, 2);
          const rlHtml = await rlRes.text();
          const parsed = parseRacelist(rlHtml, r.race_number, raceDate);
          if (!parsed.entries || parsed.entries.length < 6) { fetchErrors++; return; }
          await base44.asServiceRole.entities.Race.update(r.race_id, {
            race_name: parsed.raceName,
            race_phase: parsed.racePhase || "OTHER",
            deadline: parsed.deadline,
            entries_fetched_at: new Date().toISOString(),
          });
          await base44.asServiceRole.entities.RaceEntry.deleteMany({ race_id: r.race_id });
          const records = parsed.entries.map(e => ({
            ...e, race_id: r.race_id, race_date: raceDate, venue_code: r.jcd, race_number: r.race_number,
          }));
          await base44.asServiceRole.entities.RaceEntry.bulkCreate(records);
          repairedEntries += records.length;
        } catch { fetchErrors++; }
      }));
      await sleep(300);
    }

    // 補修後に6艇揃ったレースIDだけを分析する。
    const finalEntries = await base44.asServiceRole.entities.RaceEntry.filter({ race_date: raceDate }, "boat_number", 3000);
    const finalCountByRace = {};
    for (const e of finalEntries) finalCountByRace[e.race_id] = (finalCountByRace[e.race_id] || 0) + 1;
    const completeRaceIds = raceList.filter(r => (finalCountByRace[r.race_id] || 0) >= 6).map(r => r.race_id);

    // === 5. 完全なレースだけ一括事前分析実行 ===
    let analysisResult = null;
    try {
      const anRes = await base44.asServiceRole.functions.invoke("analyzeAllRacesForDate", {
        // 18時台の暫定分析があっても、23:50に当日全結果→シリーズ指数を確定した後は
        // 必ず全レースをv10で再計算する。前夜確定前の古い番組評価を残さない。
        race_date: raceDate, stage: "pre", race_ids: completeRaceIds, force: true,
      });
      analysisResult = anRes?.data || anRes;
    } catch (e) {
      analysisResult = { status: "error", message: e.message };
    }

    return Response.json({
      status: "success",
      race_date: raceDate,
      venues: jcds.length,
      races: totalRaces,
      entries: totalEntries,
      fetch_errors: fetchErrors,
      yesterday_result_update: yesterdayResultUpdate,
      aggregate_update: aggregateUpdate,
      learning_metrics_update: learningMetricsUpdate,
      analysis: analysisResult,
      elapsed_ms: Date.now() - t0,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
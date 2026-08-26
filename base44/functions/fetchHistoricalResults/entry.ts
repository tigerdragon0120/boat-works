import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS } from "../../shared/uichi.js";
import { VENUE_NAMES, parseResultList } from "../../shared/scraper.js";

// BOAT WORKS 過去レース結果高速取得（第1段階）
// 結果一覧ページ1アクセスのみで1場12R分の結果を保存する。
// 出走表(racelist)取得は行わない → 1号艇詳細は第2段階(enrichBoat1Details)で補完。
// upsert方式で既存データを保持し、重複保存を防止する。

const RESULT_BASE = "https://boatrace.jp/owpc/pc/race";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    const jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");

    if (!raceDate || !jcd) {
      return Response.json({ status: "error", message: "race_date, jcd が必要です" }, { status: 400 });
    }

    const hd = raceDate.replace(/-/g, "");
    const venueName = VENUE_NAMES[jcd] || jcd;
    const now = new Date().toISOString();

    // FetchProgress を processing に更新
    const existingProgress = await base44.asServiceRole.entities.FetchProgress.filter({
      race_date: raceDate, venue_code: jcd
    });
    const prevDetail = existingProgress[0]?.detail_fetch_status || "pending";
    const progressData = {
      race_date: raceDate, venue_code: jcd, venue_name: venueName,
      result_fetch_status: "processing",
      status: "processing",
      detail_fetch_status: prevDetail,
      processed_at: now,
      result_processed_at: now,
    };
    let progressId;
    if (existingProgress.length > 0) {
      await base44.asServiceRole.entities.FetchProgress.update(existingProgress[0].id, progressData);
      progressId = existingProgress[0].id;
    } else {
      const p = await base44.asServiceRole.entities.FetchProgress.create(progressData);
      progressId = p.id;
    }

    // 1. 結果一覧ページ取得（1リクエストのみ・第1段階）
    const resultListUrl = `${RESULT_BASE}/resultlist?jcd=${jcd}&hd=${hd}`;
    const rlRes = await fetch(resultListUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!rlRes.ok) {
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        result_fetch_status: "error", status: "error",
        error_msg: `結果一覧取得失敗 HTTP ${rlRes.status}`, result_processed_at: now
      });
      return Response.json({ status: "error", message: `結果一覧取得失敗 HTTP ${rlRes.status}` }, { status: 502 });
    }
    const rlHtml = await rlRes.text();
    if (rlHtml.includes("予期せぬエラーが発生しました") || rlHtml.includes("データがありません")) {
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        result_fetch_status: "no_races", status: "no_races",
        race_count: 0, uichi_hits: 0, result_processed_at: now
      });
      return Response.json({ status: "no_races", races: 0 });
    }

    const raceResults = parseResultList(rlHtml);
    if (raceResults.length === 0) {
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        result_fetch_status: "no_races", status: "no_races",
        race_count: 0, uichi_hits: 0, result_processed_at: now
      });
      return Response.json({ status: "no_races", races: 0 });
    }

    // 2. 既存RaceResultを取得（upsert・重複防止）
    const existing = await base44.asServiceRole.entities.RaceResult.filter({
      race_date: raceDate, venue_code: jcd, data_source: "official"
    });
    const existingMap = {};
    for (const e of existing) existingMap[e.race_number] = e;

    const toCreate = [];
    const toUpdate = [];
    for (const r of raceResults) {
      const isUichi = UICHI_COMBOS.includes(r.trifecta);
      const baseFields = {
        race_id: `${raceDate}_${jcd}_${r.race_number}`,
        race_date: raceDate,
        venue_code: jcd,
        venue_name: venueName,
        race_number: r.race_number,
        result_1: r.result_1,
        result_2: r.result_2,
        result_3: r.result_3,
        trifecta: r.trifecta,
        is_uichi: isUichi,
        uichi_combo: isUichi ? r.trifecta : null,
        payout_trifecta: r.payout_trifecta,
        data_source: "official",
      };
      const ex = existingMap[r.race_number];
      if (ex) {
        // 結果フィールドのみ更新、boat1フィールド・詳細ステータスは保持
        const detailStatus = ex.boat1_detail_status || (ex.boat1_racer_name ? "done" : "pending");
        toUpdate.push({ id: ex.id, ...baseFields, boat1_detail_status: detailStatus });
      } else {
        toCreate.push({ ...baseFields, boat1_detail_status: "pending" });
      }
    }

    if (toCreate.length > 0) {
      await base44.asServiceRole.entities.RaceResult.bulkCreate(toCreate);
    }
    if (toUpdate.length > 0) {
      await base44.asServiceRole.entities.RaceResult.bulkUpdate(toUpdate);
    }

    const totalRaces = toCreate.length + toUpdate.length;
    const uichiHits = raceResults.filter((r) => UICHI_COMBOS.includes(r.trifecta)).length;

    // 3. FetchProgress を done に更新（第1段階完了）
    await base44.asServiceRole.entities.FetchProgress.update(progressId, {
      result_fetch_status: "done", status: "done",
      race_count: totalRaces,
      uichi_hits: uichiHits,
      error_msg: null,
      result_processed_at: now,
      processed_at: now,
    });

    return Response.json({
      status: "success",
      races: totalRaces,
      uichi_hits: uichiHits,
      venue: venueName,
      date: raceDate,
      created: toCreate.length,
      updated: toUpdate.length,
    });
  } catch (error) {
    try {
      const base44 = createClientFromRequest(req);
      const body = await req.json().catch(() => ({}));
      const raceDate = body.race_date;
      const jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");
      if (raceDate && jcd) {
        const ep = await base44.asServiceRole.entities.FetchProgress.filter({ race_date: raceDate, venue_code: jcd });
        if (ep.length > 0) {
          await base44.asServiceRole.entities.FetchProgress.update(ep[0].id, {
            result_fetch_status: "error", status: "error",
            error_msg: error.message, result_processed_at: new Date().toISOString()
          });
        }
      }
    } catch {}
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
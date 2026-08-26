import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS } from "../../shared/uichi.js";
import { VENUE_NAMES, parseResultList } from "../../shared/scraper.js";

// BOAT WORKS 過去レース結果高速取得（第1段階）
// 結果一覧ページ1アクセスのみで1場12R分の結果を保存する。
// 出走表(racelist)取得は行わない → 1号艇詳細は第2段階(enrichBoat1Details)で補完。
// race_id を一意キーとして重複保存を防止する。

const RESULT_BASE = "https://boatrace.jp/owpc/pc/race";

export default async function(req) {
  let base44;
  let raceDate, jcd, venueName;

  try {
    base44 = createClientFromRequest(req);

    const body = await req.json().catch(() => ({}));
    raceDate = body.race_date;
    jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");

    if (!raceDate || !jcd) {
      return Response.json({ status: "error", message: "race_date, jcd が必要です" }, { status: 400 });
    }

    const hd = raceDate.replace(/-/g, "");
    venueName = VENUE_NAMES[jcd] || jcd;
    const now = new Date().toISOString();

    // === 1. FetchProgress取得 + 重複整理 ===
    // 同一 race_date+venue_code のFetchProgressが複数ある場合は最新1件を残す
    const existingProgress = await base44.asServiceRole.entities.FetchProgress.filter({
      race_date: raceDate, venue_code: jcd
    });

    let progressId = null;
    let currentProgress = null;

    if (existingProgress.length > 1) {
      // processed_at降順で最新を残す
      const sorted = [...existingProgress].sort((a, b) =>
        (b.processed_at || "").localeCompare(a.processed_at || "")
      );
      currentProgress = sorted[0];
      progressId = sorted[0].id;
      // 重複FetchProgressを削除
      for (let i = 1; i < sorted.length; i++) {
        await base44.asServiceRole.entities.FetchProgress.delete(sorted[i].id);
      }
    } else if (existingProgress.length === 1) {
      currentProgress = existingProgress[0];
      progressId = existingProgress[0].id;
    }

    // === 2. 並列二重起動防止: processing中なら早期リターン ===
    if (currentProgress && currentProgress.result_fetch_status === "processing") {
      return Response.json({
        status: "skipped",
        message: "既に処理中です",
        races: currentProgress.race_count || 0,
      });
    }

    const prevDetail = currentProgress?.detail_fetch_status || "pending";

    // === 3. processingロックを即時設定 ===
    if (progressId) {
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        result_fetch_status: "processing", status: "processing",
        error_msg: null, processed_at: now,
      });
    } else {
      const p = await base44.asServiceRole.entities.FetchProgress.create({
        race_date: raceDate, venue_code: jcd, venue_name: venueName,
        result_fetch_status: "processing", status: "processing",
        detail_fetch_status: prevDetail,
        processed_at: now,
      });
      progressId = p.id;
    }

    // === 4. 結果一覧HTTP取得 ===
    const resultListUrl = `${RESULT_BASE}/resultlist?jcd=${jcd}&hd=${hd}`;
    const rlRes = await fetch(resultListUrl, { headers: { "User-Agent": "Mozilla/5.0" } });

    if (!rlRes.ok) {
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        result_fetch_status: "error", status: "error",
        error_msg: `結果一覧取得失敗 HTTP ${rlRes.status}`, result_processed_at: now,
      });
      return Response.json({ status: "error", message: `結果一覧取得失敗 HTTP ${rlRes.status}` }, { status: 502 });
    }

    const rlHtml = await rlRes.text();
    const noRaces = rlHtml.includes("予期せぬエラーが発生しました") || rlHtml.includes("データがありません");

    const raceResults = noRaces ? [] : parseResultList(rlHtml);

    if (raceResults.length === 0) {
      await base44.asServiceRole.entities.FetchProgress.update(progressId, {
        result_fetch_status: "no_races", status: "no_races",
        race_count: 0, uichi_hits: 0, result_processed_at: now,
      });
      return Response.json({ status: "no_races", races: 0 });
    }

    // === 5. 既存RaceResult取得 + race_id重複整理 ===
    const existing = await base44.asServiceRole.entities.RaceResult.filter({
      race_date: raceDate, venue_code: jcd, data_source: "official"
    });

    // race_idでグループ化、重複は1件のみ残す（boat1データありを優先）
    const existingByRaceId = {};
    const duplicateIdsToDelete = [];
    for (const e of existing) {
      const rid = e.race_id || `${e.race_date}_${e.venue_code}_${e.race_number}`;
      if (!existingByRaceId[rid]) {
        existingByRaceId[rid] = e;
      } else {
        const keeper = existingByRaceId[rid];
        // boat1_racer_nameがある方を残す、なければ元を維持
        if (e.boat1_racer_name && !keeper.boat1_racer_name) {
          duplicateIdsToDelete.push(keeper.id);
          existingByRaceId[rid] = e;
        } else {
          duplicateIdsToDelete.push(e.id);
        }
      }
    }

    // 重複RaceResult削除
    for (const dupId of duplicateIdsToDelete) {
      await base44.asServiceRole.entities.RaceResult.delete(dupId);
    }

    // === 6. upsert（race_idをキー） ===
    const toCreate = [];
    const toUpdate = [];
    for (const r of raceResults) {
      const raceId = `${raceDate}_${jcd}_${r.race_number}`;
      const isUichi = UICHI_COMBOS.includes(r.trifecta);
      const baseFields = {
        race_id: raceId,
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
      const ex = existingByRaceId[raceId];
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

    // === 7. FetchProgress を done に更新 ===
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
      duplicates_deleted: duplicateIdsToDelete.length,
    });
  } catch (error) {
    try {
      if (base44 && raceDate && jcd) {
        const ep = await base44.asServiceRole.entities.FetchProgress.filter({
          race_date: raceDate, venue_code: jcd
        });
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
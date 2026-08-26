import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS } from "../../shared/uichi.js";
import { VENUE_NAMES, parseRacelist, parseResultList, sleep } from "../../shared/scraper.js";

// BOAT WORKS 過去レース結果取得関数
// 指定日・指定競艇場の全レース結果を公式サイトから取得しRaceResultへ保存する。
// 1号艇データ（当時の出走表データ）も合わせて保存する。
// 公式サイトへのアクセス間隔を設け、短時間に大量アクセスしない。

const RESULT_BASE = "https://boatrace.jp/owpc/pc/race";
const RACELIST_BASE = "https://boatrace.jp/owpc/pc/race";
const REQUEST_DELAY_MS = 400;

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date; // YYYY-MM-DD
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
    const progressData = {
      race_date: raceDate, venue_code: jcd, venue_name: venueName,
      status: "processing", processed_at: now,
    };
    let progress;
    if (existingProgress.length > 0) {
      progress = await base44.asServiceRole.entities.FetchProgress.update(existingProgress[0].id, progressData);
    } else {
      progress = await base44.asServiceRole.entities.FetchProgress.create(progressData);
    }

    // 1. 結果一覧ページ取得
    const resultListUrl = `${RESULT_BASE}/resultlist?jcd=${jcd}&hd=${hd}`;
    const rlRes = await fetch(resultListUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!rlRes.ok) {
      await base44.asServiceRole.entities.FetchProgress.update(progress.id, {
        status: "error", error_msg: `結果一覧取得失敗 HTTP ${rlRes.status}`, processed_at: now
      });
      return Response.json({ status: "error", message: `結果一覧取得失敗 HTTP ${rlRes.status}` }, { status: 502 });
    }
    const rlHtml = await rlRes.text();
    if (rlHtml.includes("予期せぬエラーが発生しました") || rlHtml.includes("データがありません")) {
      await base44.asServiceRole.entities.FetchProgress.update(progress.id, {
        status: "no_races", race_count: 0, uichi_hits: 0, processed_at: now
      });
      return Response.json({ status: "no_races", races: 0 });
    }

    const raceResults = parseResultList(rlHtml);
    if (raceResults.length === 0) {
      await base44.asServiceRole.entities.FetchProgress.update(progress.id, {
        status: "no_races", race_count: 0, uichi_hits: 0, processed_at: now
      });
      return Response.json({ status: "no_races", races: 0 });
    }

    // 2. 各レースの出走表を取得し1号艇データを抽出
    for (const r of raceResults) {
      await sleep(REQUEST_DELAY_MS);
      const racelistUrl = `${RACELIST_BASE}/racelist?rno=${r.race_number}&jcd=${jcd}&hd=${hd}`;
      try {
        const rcRes = await fetch(racelistUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (rcRes.ok) {
          const rcHtml = await rcRes.text();
          const parsed = parseRacelist(rcHtml, r.race_number, raceDate);
          r.boat1 = parsed.entries.find((e) => e.boat_number === 1) || null;
        }
      } catch {
        r.boat1 = null;
      }
    }

    // 3. RaceResult 保存（既存のofficialデータを削除してから）
    await base44.asServiceRole.entities.RaceResult.deleteMany({
      race_date: raceDate, venue_code: jcd, data_source: "official"
    });

    const records = raceResults.map((r) => {
      const b1 = r.boat1 || {};
      const isUichi = UICHI_COMBOS.includes(r.trifecta);
      return {
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
        boat1_registration_number: b1.registration_number ?? null,
        boat1_racer_name: b1.racer_name ?? null,
        boat1_grade_class: b1.grade_class ?? null,
        boat1_national_win_rate: b1.national_win_rate ?? null,
        boat1_national_2rate: b1.national_2rate ?? null,
        boat1_national_3rate: b1.national_3rate ?? null,
        boat1_local_win_rate: b1.local_win_rate ?? null,
        boat1_local_2rate: b1.local_2rate ?? null,
        boat1_local_3rate: b1.local_3rate ?? null,
        boat1_avg_st: b1.avg_st ?? null,
        boat1_f_count: b1.f_count ?? null,
        boat1_motor_2rate: b1.motor_2rate ?? null,
        boat1_motor_3rate: b1.motor_3rate ?? null,
      };
    });

    await base44.asServiceRole.entities.RaceResult.bulkCreate(records);
    const uichiHits = records.filter((r) => r.is_uichi).length;

    // 4. FetchProgress を done に更新
    await base44.asServiceRole.entities.FetchProgress.update(progress.id, {
      status: "done",
      race_count: records.length,
      uichi_hits: uichiHits,
      error_msg: null,
      processed_at: now,
    });

    return Response.json({
      status: "success",
      races: records.length,
      uichi_hits: uichiHits,
      venue: venueName,
      date: raceDate,
    });
  } catch (error) {
    // FetchProgressをerrorに更新を試みる
    try {
      const base44 = createClientFromRequest(req);
      const body = await req.json().catch(() => ({}));
      const raceDate = body.race_date;
      const jcd = String(body.jcd || body.venue_code || "").padStart(2, "0");
      if (raceDate && jcd) {
        const ep = await base44.asServiceRole.entities.FetchProgress.filter({ race_date: raceDate, venue_code: jcd });
        if (ep.length > 0) {
          await base44.asServiceRole.entities.FetchProgress.update(ep[0].id, {
            status: "error", error_msg: error.message, processed_at: new Date().toISOString()
          });
        }
      }
    } catch {}
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
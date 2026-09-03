import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { VENUE_NAMES, parseDaySchedule, sleep } from "../../shared/scraper.js";
import { upsertRace } from "../../shared/raceUpsert.js";

// BOAT WORKS 1日分の開催スケジュール取得（汎用）
// 公式サイトの raceindex ページから指定日・指定場の全レース番号と締切時刻を取得し、
// Race レコードとして保存（出走表・オッズは未取得・軽量）。
// 任意の日付 + 場コード(jcd) で動作する汎用処理。
// 出走表・3連単オッズ・合成オッズは fetchRaceData で別途取得可能。

const BASE = "https://boatrace.jp/owpc/pc/race";

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
    const url = `${BASE}/raceindex?jcd=${jcd}&hd=${hd}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return Response.json({ status: "error", message: `スケジュール取得失敗 (HTTP ${res.status})` }, { status: 502 });
    const html = await res.text();
    if (html.includes("不正なURLへのリクエスト") || html.includes("予期せぬエラーが発生しました")) {
      return Response.json({ status: "error", message: "スケジュール取得失敗：該当する開催がありません" }, { status: 502 });
    }

    const schedule = parseDaySchedule(html, raceDate);
    if (schedule.length === 0) {
      return Response.json({ status: "no_races", message: "レースが見つかりません", races: 0 });
    }

    const venueName = VENUE_NAMES[jcd] || jcd;
    const now = new Date().toISOString();

    let created = 0, updated = 0;
    for (const s of schedule) {
      const raceData = {
        race_date: raceDate,
        venue_code: jcd,
        venue_name: venueName,
        race_number: s.race_number,
        deadline: s.deadline,
        status: "scheduled",
        data_source: "official",
        last_updated: now,
      };
      // 共通upsert: 既存更新 or 新規作成 + post-create重複正規化
      const before = await base44.asServiceRole.entities.Race.filter({
        race_date: raceDate, venue_code: jcd, race_number: Number(s.race_number), data_source: "official"
      }, "-updated_date", 5).catch(() => []);
      await upsertRace(base44, raceData);
      if (before.length > 0) updated++; else created++;
    }

    await sleep(400);

    return Response.json({
      status: "success",
      race_date: raceDate,
      venue_code: jcd,
      venue_name: venueName,
      races: schedule.length,
      created,
      updated,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
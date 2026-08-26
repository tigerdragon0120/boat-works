import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { parseDailyVenueList } from "../../shared/scraper.js";

// BOAT WORKS 1日の開催場一覧取得
// 公式トップページ（index?hd=YYYYMMDD）からその日開催のjcd一覧を返す。
// 開催していない場の重い処理をスキップするための軽量関数。

const INDEX_URL = "https://boatrace.jp/owpc/pc/race/index";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    if (!raceDate) return Response.json({ status: "error", message: "race_date が必要です" }, { status: 400 });

    const hd = raceDate.replace(/-/g, "");
    const url = `${INDEX_URL}?hd=${hd}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return Response.json({ status: "error", message: `HTTP ${res.status}` }, { status: 502 });

    const html = await res.text();
    const venues = parseDailyVenueList(html);
    return Response.json({ status: "success", race_date: raceDate, venues });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
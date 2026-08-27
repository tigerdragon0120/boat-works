import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// BOAT WORKS バックフィル状況取得
// 直近30日 / 31-90日 / 91-180日（6か月）の3階層でRaceResult補完率を返す
// クライアントに全件読み込ませず、サーバー側で集計してサマリーのみ返す

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

    // 昨日基準で日付範囲を計算（JST）
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstNow = new Date(now.getTime() + jstOffset);
    const yesterday = new Date(jstNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);

    function daysAgoStr(n: number): string {
      const d = new Date(yesterday);
      d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    }

    const p1Start = daysAgoStr(29);
    const p1End = yStr;
    const p2Start = daysAgoStr(89);
    const p2End = daysAgoStr(30);
    const p3Start = daysAgoStr(179);
    const p3End = daysAgoStr(90);

    // 6か月範囲のofficial RaceResultを取得（ページネーション）
    let allResults: any[] = [];
    let skip = 0;
    while (skip < 50000) {
      const batch = await base44.asServiceRole.entities.RaceResult.filter(
        { data_source: "official", race_date: { $gte: p3Start, $lte: p1End } },
        "-race_date", 500, skip
      ).catch(() => []);
      if (!batch || batch.length === 0) break;
      allResults = allResults.concat(batch);
      if (batch.length < 500) break;
      skip += 500;
    }

    function countTier(start: string, end: string) {
      const inRange = allResults.filter(r => r.race_date >= start && r.race_date <= end);
      const total = inRange.length;
      const done = inRange.filter(r =>
        r.boat1_detail_status === "done" || (!r.boat1_detail_status && r.boat1_racer_name)
      ).length;
      const error = inRange.filter(r => r.boat1_detail_status === "error").length;
      const pending = inRange.filter(r =>
        !r.boat1_detail_status || r.boat1_detail_status === "pending"
      ).length;
      const rate = total > 0 ? done / total : 0;
      return { total, done, error, pending, rate, start, end };
    }

    const p1 = countTier(p1Start, p1End);
    const p2 = countTier(p2Start, p2End);
    const p3 = countTier(p3Start, p3End);
    const overall = countTier(p3Start, p1End);

    return Response.json({
      status: "success",
      yesterday: yStr,
      p1, p2, p3, overall,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// ういち買いの出現率・回収率を月別・競艇場別に集計
// RaceResult(official)を元に、過去の傾向を把握するためのトレンドデータを返す
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // 全 official RaceResult を取得（ページネーション）
    let allResults = [];
    let skip = 0;
    const pageSize = 500;
    while (true) {
      const batch = await base44.asServiceRole.entities.RaceResult.filter(
        { data_source: "official" }, "-race_date", pageSize, skip
      ).catch(() => []);
      if (!batch || batch.length === 0) break;
      allResults = allResults.concat(batch);
      if (batch.length < pageSize) break;
      skip += pageSize;
      if (skip > 50000) break;
    }

    if (allResults.length === 0) {
      return Response.json({ byMonth: [], byVenue: [], overall: { total: 0, hits: 0, rate: 0, return_rate: 0 } });
    }

    // 月別集計
    const byMonthMap = {};
    // 競艇場別集計
    const byVenueMap = {};

    for (const r of allResults) {
      const month = String(r.race_date).slice(0, 7);
      const venueKey = r.venue_code || r.venue_name || "unknown";
      const venueName = r.venue_name || r.venue_code || "不明";

      // 月別
      if (!byMonthMap[month]) byMonthMap[month] = { month, total: 0, hits: 0, payout: 0 };
      byMonthMap[month].total++;
      if (r.is_uichi) {
        byMonthMap[month].hits++;
        byMonthMap[month].payout += r.payout_trifecta || 0;
      }

      // 競艇場別
      if (!byVenueMap[venueKey]) byVenueMap[venueKey] = { venue_code: venueKey, venue_name: venueName, total: 0, hits: 0, payout: 0 };
      byVenueMap[venueKey].total++;
      if (r.is_uichi) {
        byVenueMap[venueKey].hits++;
        byVenueMap[venueKey].payout += r.payout_trifecta || 0;
      }
    }

    // 月別: ソート + レート計算
    const byMonth = Object.values(byMonthMap).sort((a, b) => a.month.localeCompare(b.month));
    for (const m of byMonth) {
      m.rate = m.total > 0 ? m.hits / m.total : 0;
      m.investment = m.total * 600; // 6点×100円
      m.return_rate = m.investment > 0 ? m.payout / m.investment : 0;
      m.rate_pct = m.rate * 100;
      m.return_rate_pct = m.return_rate * 100;
    }

    // 競艇場別: 出現率順ソート + レート計算
    const byVenue = Object.values(byVenueMap)
      .filter(v => v.total >= 10) // サンプル不足の会場は除外
      .map(v => {
        v.rate = v.total > 0 ? v.hits / v.total : 0;
        v.investment = v.total * 600;
        v.return_rate = v.investment > 0 ? v.payout / v.investment : 0;
        v.rate_pct = v.rate * 100;
        v.return_rate_pct = v.return_rate * 100;
        return v;
      })
      .sort((a, b) => b.rate - a.rate);

    // 全体
    const overall = {
      total: allResults.length,
      hits: allResults.filter(r => r.is_uichi).length,
      payout: allResults.filter(r => r.is_uichi).reduce((s, r) => s + (r.payout_trifecta || 0), 0),
    };
    overall.rate = overall.total > 0 ? overall.hits / overall.total : 0;
    overall.investment = overall.total * 600;
    overall.return_rate = overall.investment > 0 ? overall.payout / overall.investment : 0;

    return Response.json({ byMonth, byVenue, overall });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
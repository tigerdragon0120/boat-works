import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// BUY判定の過去実績を月別集計
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // final BUY分析を取得
    const analyses = await base44.entities.UichiAnalysis.filter(
      { stage: "final", judgment: "BUY" }, "-race_date", 500
    );

    if (!analyses || analyses.length === 0) {
      return Response.json({
        months: [],
        overall: { total: 0, hits: 0, hit_rate: 0, payout: 0, investment: 0, return_rate: 0 }
      });
    }

    // RaceResultをrace_idの$inで取得（200件ずつ）
    const raceIds = [...new Set(analyses.map(a => a.race_id))];
    const resultMap = {};
    for (let i = 0; i < raceIds.length; i += 200) {
      const batch = raceIds.slice(i, i + 200);
      const results = await base44.entities.RaceResult.filter(
        { race_id: { $in: batch } }, null, 300
      );
      for (const r of results) {
        resultMap[r.race_id] = r;
      }
    }

    // 月別集計
    const byMonth = {};
    for (const a of analyses) {
      const result = resultMap[a.race_id];
      if (!result) continue;
      const month = String(a.race_date).slice(0, 7);
      if (!byMonth[month]) {
        byMonth[month] = { month, total: 0, hits: 0, payout: 0, ev_sum: 0 };
      }
      byMonth[month].total++;
      if (result.is_uichi) {
        byMonth[month].hits++;
        byMonth[month].payout += result.payout_trifecta || 0;
      }
      byMonth[month].ev_sum += a.expected_value || 0;
    }

    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
    for (const m of months) {
      m.hit_rate = m.total > 0 ? m.hits / m.total : 0;
      m.investment = m.total * 100;
      m.return_rate = m.investment > 0 ? m.payout / m.investment : 0;
      m.avg_ev = m.total > 0 ? Math.round(m.ev_sum / m.total) : 0;
    }

    const overall = {
      total: months.reduce((s, m) => s + m.total, 0),
      hits: months.reduce((s, m) => s + m.hits, 0),
      payout: months.reduce((s, m) => s + m.payout, 0),
    };
    overall.investment = overall.total * 100;
    overall.hit_rate = overall.total > 0 ? overall.hits / overall.total : 0;
    overall.return_rate = overall.investment > 0 ? overall.payout / overall.investment : 0;

    return Response.json({ months, overall });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
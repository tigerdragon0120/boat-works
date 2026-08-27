import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 期待値指数(EV)帯別のBUY判定パフォーマンスを集計
// EV帯ごとの的中率・回収率を返し、高期待値のBUYがどれだけ的中しているかを可視化
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
      return Response.json({ bins: [], overall: { total: 0, hits: 0, hit_rate: 0, return_rate: 0 } });
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

    // EV帯の定義
    const EV_BINS = [
      { label: "100-120", min: 100, max: 120 },
      { label: "120-140", min: 120, max: 140 },
      { label: "140-160", min: 140, max: 160 },
      { label: "160-200", min: 160, max: 200 },
      { label: "200+", min: 200, max: Infinity },
    ];

    const bins = EV_BINS.map(b => ({
      label: b.label, min: b.min, max: b.max,
      total: 0, hits: 0, payout: 0, investment: 0,
    }));

    for (const a of analyses) {
      const result = resultMap[a.race_id];
      if (!result) continue;
      const ev = a.expected_value || 0;
      const bin = bins.find(b => ev >= b.min && ev < b.max);
      if (!bin) continue;
      bin.total++;
      bin.investment += 100;
      if (result.is_uichi) {
        bin.hits++;
        bin.payout += result.payout_trifecta || 0;
      }
    }

    // 的中率・回収率計算
    for (const b of bins) {
      b.hit_rate = b.total > 0 ? b.hits / b.total : 0;
      b.return_rate = b.investment > 0 ? b.payout / b.investment : 0;
    }

    const overall = {
      total: bins.reduce((s, b) => s + b.total, 0),
      hits: bins.reduce((s, b) => s + b.hits, 0),
      payout: bins.reduce((s, b) => s + b.payout, 0),
      investment: bins.reduce((s, b) => s + b.investment, 0),
    };
    overall.hit_rate = overall.total > 0 ? overall.hits / overall.total : 0;
    overall.return_rate = overall.investment > 0 ? overall.payout / overall.investment : 0;

    return Response.json({ bins, overall });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
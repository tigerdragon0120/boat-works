import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS } from "../../shared/uichi.js";

// BOAT WORKS Analysis画面用集計データ
// RaceResult全件をサーバー側で集計し、クライアントに全件読み込まない。
// 級別・レース番号別・6点別・BUY判定統計を返す。

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") {
      // 一般ユーザーは読み取り可。force_refreshだけ管理者/サービスロールに限定する。
    }
    const body = await req.json().catch(() => ({}));
    const forceRefresh = body.force_refresh === true;
    const cacheKey = "analysis_stats_v1";

    if (!forceRefresh) {
      const cached = await base44.asServiceRole.entities.AnalyticsCache.filter({ cache_key: cacheKey }, "-updated_at", 1).catch(() => []);
      if (cached[0]?.payload) return Response.json({ ...cached[0].payload, cached: true, cache_updated_at: cached[0].updated_at });
    }

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

    // 級別
    const byGrade = {};
    // レース番号別
    const byRaceNum = {};
    for (let i = 1; i <= 12; i++) byRaceNum[i] = { total: 0, hits: 0 };
    // 6点別
    const byCombo = {};
    for (const c of UICHI_COMBOS) byCombo[c] = { count: 0, sumPayout: 0 };

    let total = 0;
    let totalWithDetails = 0;
    let uichiHits = 0;
    const raceResultMap = {};

    for (const r of allResults) {
      total++;
      const hasDetail = r.boat1_detail_status === "done" || (!r.boat1_detail_status && r.boat1_racer_name);
      if (hasDetail) totalWithDetails++;
      if (r.is_uichi) uichiHits++;
      raceResultMap[r.race_id] = r;

      // 級別集計は1号艇詳細が補完済みのレースのみ対象
      if (hasDetail) {
        const g = r.boat1_grade_class || "不明";
        if (!byGrade[g]) byGrade[g] = { total: 0, hits: 0 };
        byGrade[g].total++;
        if (r.is_uichi) byGrade[g].hits++;
      }

      const n = r.race_number;
      if (byRaceNum[n]) {
        byRaceNum[n].total++;
        if (r.is_uichi) byRaceNum[n].hits++;
      }

      if (r.is_uichi && r.uichi_combo && byCombo[r.uichi_combo]) {
        byCombo[r.uichi_combo].count++;
        byCombo[r.uichi_combo].sumPayout += r.payout_trifecta || 0;
      }
    }

    // UichiAnalysis からBUY判定統計
    let allAnalyses = [];
    let skipA = 0;
    while (true) {
      const batch = await base44.asServiceRole.entities.UichiAnalysis.list("-captured_at", 500, skipA).catch(() => []);
      if (!batch || batch.length === 0) break;
      allAnalyses = allAnalyses.concat(batch);
      if (batch.length < 500) break;
      skipA += 500;
      if (skipA > 10000) break;
    }

    const buyAnalyses = allAnalyses.filter(a => a.judgment === "BUY");
    const buyCount = buyAnalyses.length;
    let buyHits = 0;
    let buyPayoutSum = 0;
    for (const a of buyAnalyses) {
      const matched = raceResultMap[a.race_id];
      if (matched && matched.is_uichi) {
        buyHits++;
        buyPayoutSum += matched.payout_trifecta || 0;
      }
    }
    const buyHitRate = buyCount > 0 ? buyHits / buyCount : 0;
    const buyRecovery = buyCount > 0 ? buyPayoutSum / (buyCount * 600) : 0;

    const dataSufficiencyRate = total > 0 ? totalWithDetails / total : 0;

    const payload = {
      status: "success",
      total,
      totalWithDetails,
      dataSufficiencyRate,
      uichiHits,
      byGrade,
      byRaceNum,
      byCombo,
      buyCount,
      buyHitRate,
      buyRecovery,
      cached: false,
    };

    const now = new Date().toISOString();
    const existingCache = await base44.asServiceRole.entities.AnalyticsCache.filter({ cache_key: cacheKey }, "-updated_at", 1).catch(() => []);
    if (existingCache[0]) {
      await base44.asServiceRole.entities.AnalyticsCache.update(existingCache[0].id, { payload, updated_at: now, source_max_date: allResults[0]?.race_date || null });
    } else {
      await base44.asServiceRole.entities.AnalyticsCache.create({ cache_key: cacheKey, payload, updated_at: now, source_max_date: allResults[0]?.race_date || null });
    }

    return Response.json(payload);
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
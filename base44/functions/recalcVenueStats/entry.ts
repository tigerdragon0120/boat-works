import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { UICHI_COMBOS } from "../../shared/uichi.js";
import { VENUE_NAMES, ALL_VENUE_JCDS } from "../../shared/scraper.js";

// BOAT WORKS 競艇場統計再計算関数
// official の RaceResult から各競艇場の統計を再計算し VenueStats を更新する。

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ status: "error", message: "認証が必要です" }, { status: 401 });

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

    // 競艇場ごとに集計
    const byVenue = {};
    for (const r of allResults) {
      const vc = r.venue_code;
      if (!vc) continue;
      if (!byVenue[vc]) {
        byVenue[vc] = {
          venue_code: vc,
          venue_name: r.venue_name || VENUE_NAMES[vc] || vc,
          total_races: 0,
          c1_wins: 0,
          uichi_hits: 0,
          combo_counts: { "1-2-5": 0, "1-2-6": 0, "1-3-5": 0, "1-3-6": 0, "1-4-5": 0, "1-4-6": 0 },
        };
      }
      const v = byVenue[vc];
      v.total_races++;
      if (r.result_1 === 1) v.c1_wins++;
      if (r.is_uichi) v.uichi_hits++;
      if (r.uichi_combo && v.combo_counts[r.uichi_combo] != null) {
        v.combo_counts[r.uichi_combo]++;
      }
    }

    const now = new Date().toISOString();
    const updated = [];

    for (const jcd of ALL_VENUE_JCDS) {
      const v = byVenue[jcd];
      const existing = await base44.asServiceRole.entities.VenueStats.filter({ venue_code: jcd });
      const total = v ? v.total_races : 0;
      const uichiHits = v ? v.uichi_hits : 0;
      const c1Rate = total > 0 ? v.c1_wins / total : 0;
      const uichiRate = total > 0 ? uichiHits / total : 0;

      const statsData = {
        venue_code: jcd,
        venue_name: VENUE_NAMES[jcd] || jcd,
        total_races: total,
        c1_win_rate: Number(c1Rate.toFixed(4)),
        uichi_hits: uichiHits,
        uichi_rate: Number(uichiRate.toFixed(4)),
        combo_1_2_5_rate: total > 0 ? Number((v?.combo_counts["1-2-5"] || 0) / total).toFixed(4) : 0,
        combo_1_2_6_rate: total > 0 ? Number((v?.combo_counts["1-2-6"] || 0) / total).toFixed(4) : 0,
        combo_1_3_5_rate: total > 0 ? Number((v?.combo_counts["1-3-5"] || 0) / total).toFixed(4) : 0,
        combo_1_3_6_rate: total > 0 ? Number((v?.combo_counts["1-3-6"] || 0) / total).toFixed(4) : 0,
        combo_1_4_5_rate: total > 0 ? Number((v?.combo_counts["1-4-5"] || 0) / total).toFixed(4) : 0,
        combo_1_4_6_rate: total > 0 ? Number((v?.combo_counts["1-4-6"] || 0) / total).toFixed(4) : 0,
        sample_count: total,
        data_source: "official",
        last_updated: now,
      };

      if (existing.length > 0) {
        await base44.asServiceRole.entities.VenueStats.update(existing[0].id, statsData);
      } else {
        await base44.asServiceRole.entities.VenueStats.create(statsData);
      }
      updated.push({ venue: statsData.venue_name, total, uichi: uichiHits, rate: uichiRate });
    }

    return Response.json({
      status: "success",
      total_results: allResults.length,
      venues_updated: updated.length,
      summary: updated,
    });
  } catch (error) {
    return Response.json({ status: "error", message: error.message }, { status: 500 });
  }
}
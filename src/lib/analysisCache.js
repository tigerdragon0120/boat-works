// BOAT WORKS キャッシュ済み分析API
// Home/Alerts/RaceDetailは保存済みUichiAnalysisを読むだけ（再分析しない）
import { base44 } from "@/api/base44Client";

// 指定日のUichiAnalysisを一括取得（race_id→analysis のマップ）
// stage指定時はそのstageのみ。未指定時は final > day > pre の優先順位で最新を採用。
const STAGE_PRIORITY = { final: 3, day: 2, pre: 1 };
export async function getCachedAnalysesByDate(dateStr, stage = null) {
  const query = stage ? { race_date: dateStr, stage } : { race_date: dateStr };
  const list = await base44.entities.UichiAnalysis.filter(query, "-captured_at", 500);
  const map = {};
  for (const a of list) {
    const cur = map[a.race_id];
    if (!cur || (STAGE_PRIORITY[a.stage] || 0) > (STAGE_PRIORITY[cur.stage] || 0)) {
      map[a.race_id] = a;
    }
  }
  return map;
}

// 指定レースの全stage分析を取得（pre + final比較用）
export async function getCachedAnalysesForRace(raceId) {
  const list = await base44.entities.UichiAnalysis.filter({ race_id: raceId }, "-captured_at", 10);
  const byStage = {};
  for (const a of list) {
    if (!byStage[a.stage]) byStage[a.stage] = a;
  }
  return byStage;
}

// 翌日全場一括事前分析（管理者実行・バックエンド関数）
export async function analyzeAllRacesForDate(raceDate, options = {}) {
  const res = await base44.functions.invoke("analyzeAllRacesForDate", {
    race_date: raceDate,
    stage: options.stage || "pre",
    race_ids: options.race_ids || null,
    force: options.force || false,
  });
  return res.data;
}

// 直前分析（締切5分前・単レース・final stage）
export async function analyzeRaceFinal(raceId, raceDate) {
  const res = await base44.functions.invoke("analyzeAllRacesForDate", {
    race_date: raceDate,
    stage: "final",
    race_ids: [raceId],
    force: true,
  });
  return res.data;
}

// 日次分析履歴（管理画面用・UichiAnalysisから集計）
export async function getBatchAnalysisHistory(days = 7) {
  const today = new Date();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const results = [];
  for (const date of dates) {
    const [preList, finalList] = await Promise.all([
      base44.entities.UichiAnalysis.filter({ race_date: date, stage: "pre" }, "-captured_at", 500),
      base44.entities.UichiAnalysis.filter({ race_date: date, stage: "final" }, "-captured_at", 500),
    ]);
    const preGrades = preList.filter(a => a.pre_grade === "S" || a.pre_grade === "A").length;
    const finalBuys = finalList.filter(a => a.judgment === "BUY").length;
    const latest = preList[0]?.analyzed_at || finalList[0]?.analyzed_at;
    results.push({
      race_date: date,
      pre_count: preList.length,
      final_count: finalList.length,
      pre_candidates: preGrades,
      final_buys: finalBuys,
      analyzed_at: latest,
    });
  }
  return results;
}

// キャッシュヒット率計算（Home用）
export function computeCacheHitRate(races, cachedAnalyses) {
  if (!races || races.length === 0) return 0;
  const hit = races.filter(r => cachedAnalyses[r.id]).length;
  return hit / races.length;
}
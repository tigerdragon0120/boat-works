import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 選手配置指数別の実出現率を集計する（過去レース検証）
// RacePlayerStructure × RaceResult を結合し、
// ういち・裏ういち出目の実出現率をスコア帯別に集計する。

const SCORE_RANGES = [
  { label: "90-100", min: 90, max: 100 },
  { label: "80-89", min: 80, max: 89 },
  { label: "70-79", min: 70, max: 79 },
  { label: "60-69", min: 60, max: 69 },
  { label: "0-59", min: 0, max: 59 },
];

function checkUichi(result) {
  // 1-234-56: 1着=1号艇, 2着=2-4号艇, 3着=5-6号艇
  if (!result || result.result_1 == null || result.result_2 == null || result.result_3 == null) return false;
  return result.result_1 === 1 && result.result_2 >= 2 && result.result_2 <= 4 && result.result_3 >= 5 && result.result_3 <= 6;
}

function checkUraUichi(result) {
  // 1-56-234: 1着=1号艇, 2着=5-6号艇, 3着=2-4号艇
  if (!result || result.result_1 == null || result.result_2 == null || result.result_3 == null) return false;
  return result.result_1 === 1 && result.result_2 >= 5 && result.result_2 <= 6 && result.result_3 >= 2 && result.result_3 <= 4;
}

function getRange(score) {
  if (score == null) return null;
  for (const r of SCORE_RANGES) {
    if (score >= r.min && score <= r.max) return r.label;
  }
  return null;
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ status: 'error', message: '認証が必要です' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const startDate = body.start_date;
    const endDate = body.end_date;

    // RacePlayerStructureを取得（期間フィルタ可能）
    let structures;
    if (startDate && endDate) {
      structures = await base44.asServiceRole.entities.RacePlayerStructure.filter(
        { race_date: { $gte: startDate, $lte: endDate } }, '-race_date', 5000
      ).catch(() => []);
    } else {
      structures = await base44.asServiceRole.entities.RacePlayerStructure.list('-race_date', 5000);
    }

    if (!structures || structures.length === 0) {
      return Response.json({
        status: 'success',
        total_races: 0,
        message: 'RacePlayerStructureデータがありません',
      });
    }

    // 対象race_idを収集
    const raceIds = structures.map(s => s.race_id);

    // RaceResultを一括取得
    const resultMap = {};
    for (let i = 0; i < raceIds.length; i += 500) {
      const chunk = raceIds.slice(i, i + 500);
      const results = await base44.asServiceRole.entities.RaceResult.filter(
        { race_id: { $in: chunk } }, 'race_number', 600
      ).catch(() => []);
      for (const r of results) resultMap[r.race_id] = r;
    }

    // スコア帯別に集計
    const uichiBuckets = {};
    const uraBuckets = {};
    for (const r of SCORE_RANGES) {
      uichiBuckets[r.label] = { total: 0, hits: 0, rate: 0 };
      uraBuckets[r.label] = { total: 0, hits: 0, rate: 0 };
    }

    let totalMatched = 0;
    let totalUichi = 0;
    let totalUraUichi = 0;

    for (const s of structures) {
      const result = resultMap[s.race_id];
      if (!result) continue;
      totalMatched++;

      const isUichi = checkUichi(result);
      const isUra = checkUraUichi(result);
      if (isUichi) totalUichi++;
      if (isUra) totalUraUichi++;

      // ういち指数で集計
      const uichiRange = getRange(s.uichi_player_structure_score);
      if (uichiRange) {
        uichiBuckets[uichiRange].total++;
        if (isUichi) uichiBuckets[uichiRange].hits++;
      }

      // 裏ういち指数で集計
      const uraRange = getRange(s.ura_uichi_player_structure_score);
      if (uraRange) {
        uraBuckets[uraRange].total++;
        if (isUra) uraBuckets[uraRange].hits++;
      }
    }

    // 出現率計算
    for (const r of SCORE_RANGES) {
      const ub = uichiBuckets[r.label];
      ub.rate = ub.total > 0 ? (ub.hits / ub.total) : 0;
      const urab = uraBuckets[r.label];
      urab.rate = urab.total > 0 ? (urab.hits / urab.total) : 0;
    }

    return Response.json({
      status: 'success',
      total_structures: structures.length,
      total_matched: totalMatched,
      total_uichi_hits: totalUichi,
      total_ura_uichi_hits: totalUraUichi,
      overall_uichi_rate: totalMatched > 0 ? (totalUichi / totalMatched) : 0,
      overall_ura_uichi_rate: totalMatched > 0 ? (totalUraUichi / totalMatched) : 0,
      uichi_by_score_range: uichiBuckets,
      ura_uichi_by_score_range: uraBuckets,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
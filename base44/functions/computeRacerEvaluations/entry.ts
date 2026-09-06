import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  EVALUATION_VERSION,
  getPeriodDates,
  extractDateFromRaceKey,
  aggregateCourseStats,
  aggregateMultiCourse,
  computePeriodScores,
  blendPeriodScores,
  classifyPlayerTypes,
  findBestCourse,
} from '../../shared/racerEvaluation.js';

// 全選手のういち特化型評価を計算する
// OfficialRaceEntryResultV2から期間別(6m/1y/3y)・コース別統計を集計し、
// 5つの評価スコア + プレイヤータイプを算出してRacerEvaluationに保存する。

const SCORE_KEYS = ["in_strength", "mid_second", "mid_third", "outside_third", "outside_second"];

function getSampleCounts(courseStats) {
  const c1 = courseStats[1];
  const mid = aggregateMultiCourse([courseStats[2], courseStats[3], courseStats[4]]);
  const outside = aggregateMultiCourse([courseStats[5], courseStats[6]]);
  return {
    in_strength: c1?.race_count || 0,
    mid_second: mid?.race_count || 0,
    mid_third: mid?.race_count || 0,
    outside_third: outside?.race_count || 0,
    outside_second: outside?.race_count || 0,
  };
}

async function bulkChunked(base44, entityName, method, records, chunkSize = 400) {
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    await base44.asServiceRole.entities[entityName][method](chunk);
  }
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const referenceDate = body.reference_date || new Date().toISOString();
    const periods = getPeriodDates(referenceDate);
    const now = new Date().toISOString();

    // OfficialRaceEntryResultV2を全件取得（ページネーション）
    const racerMap = new Map();
    let lastDate = null;
    let totalFetched = 0;
    const maxFetch = 200000;
    const batchSize = 5000;

    while (totalFetched < maxFetch) {
      let batch;
      if (lastDate) {
        batch = await base44.asServiceRole.entities.OfficialRaceEntryResultV2.filter(
          { created_date: { $lt: lastDate } }, '-created_date', batchSize
        ).catch(() => []);
      } else {
        batch = await base44.asServiceRole.entities.OfficialRaceEntryResultV2.list('-created_date', batchSize);
      }
      if (!batch || batch.length === 0) break;

      for (const entry of batch) {
        if (!entry.registration_number) continue;
        const raceDate = extractDateFromRaceKey(entry.race_key);
        if (!raceDate) continue;

        if (!racerMap.has(entry.registration_number)) {
          racerMap.set(entry.registration_number, {
            racer_name: entry.racer_name || '',
            entries_6m: [],
            entries_1y: [],
            entries_3y: [],
          });
        }
        const racer = racerMap.get(entry.registration_number);
        if (entry.racer_name && !racer.racer_name) racer.racer_name = entry.racer_name;

        // 3期間のどれに属するか判定
        if (raceDate >= periods["6m"].start) racer.entries_6m.push(entry);
        if (raceDate >= periods["1y"].start) racer.entries_1y.push(entry);
        if (raceDate >= periods["3y"].start) racer.entries_3y.push(entry);
      }

      totalFetched += batch.length;
      lastDate = batch[batch.length - 1].created_date;
      if (batch.length < batchSize) break;
    }

    if (racerMap.size === 0) {
      return Response.json({
        status: 'success',
        message: 'OfficialRaceEntryResultV2にデータがありません',
        racer_count: 0,
        total_fetched: totalFetched,
      });
    }

    // 各選手のスコア計算
    const evaluations = [];
    let computedCount = 0;

    for (const [regNum, racer] of racerMap) {
      const periodData = {};
      const periodScores = {};
      const periodSampleCounts = {};

      for (const [pKey, entries] of [["6m", racer.entries_6m], ["1y", racer.entries_1y], ["3y", racer.entries_3y]]) {
        const courseStats = aggregateCourseStats(entries);
        const scores = computePeriodScores(courseStats);
        const sampleCounts = getSampleCounts(courseStats);
        periodData[pKey] = {
          period_start: periods[pKey].start,
          period_end: periods[pKey].end,
          courses: courseStats,
          scores,
          sample_counts: sampleCounts,
        };
        periodScores[pKey] = scores;
        periodSampleCounts[pKey] = sampleCounts;
      }

      // 現在評価のブレンド
      const currentScores = {};
      for (const key of SCORE_KEYS) {
        currentScores[key] = blendPeriodScores(periodScores, periodSampleCounts, key);
      }

      // いずれのスコアもnullの場合はスキップ
      if (Object.values(currentScores).every(v => v == null)) continue;

      const playerTypes = classifyPlayerTypes(currentScores, periodData);
      const bestCourse = findBestCourse(periodData);

      evaluations.push({
        registration_number: regNum,
        racer_name: racer.racer_name,
        in_strength_score: currentScores.in_strength,
        mid_second_score: currentScores.mid_second,
        mid_third_score: currentScores.mid_third,
        outside_third_score: currentScores.outside_third,
        outside_second_score: currentScores.outside_second,
        player_types: playerTypes,
        period_data: periodData,
        best_course: bestCourse,
        evaluation_version: EVALUATION_VERSION,
        computed_at: now,
      });
      computedCount++;
    }

    // 既存RacerEvaluationを取得
    const existing = await base44.asServiceRole.entities.RacerEvaluation.list('-created_date', 5000).catch(() => []);
    const existingMap = {};
    for (const e of existing) existingMap[e.registration_number] = e;

    const toCreate = [];
    const toUpdate = [];
    for (const ev of evaluations) {
      const ex = existingMap[ev.registration_number];
      if (ex) {
        toUpdate.push({ id: ex.id, ...ev });
      } else {
        toCreate.push(ev);
      }
    }

    let createdCount = 0, updatedCount = 0;
    if (toCreate.length > 0) {
      await bulkChunked(base44, 'RacerEvaluation', 'bulkCreate', toCreate);
      createdCount = toCreate.length;
    }
    if (toUpdate.length > 0) {
      await bulkChunked(base44, 'RacerEvaluation', 'bulkUpdate', toUpdate);
      updatedCount = toUpdate.length;
    }

    return Response.json({
      status: 'success',
      reference_date: referenceDate.slice(0, 10),
      periods,
      total_fetched: totalFetched,
      racer_count: computedCount,
      created_count: createdCount,
      updated_count: updatedCount,
      evaluation_version: EVALUATION_VERSION,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
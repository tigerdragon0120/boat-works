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

    // RaceResult (V1) からも履歴データを補完取得
    // OfficialRaceEntryResultV2にない選手（K未取込の会場・期間）をカバー
    const threeYearsAgo = periods["3y"].start;
    let v1Fetched = 0;
    let v1LastDate = null;
    const v1MaxFetch = 100000;
    const v1BatchSize = 5000;

    while (v1Fetched < v1MaxFetch) {
      let v1Batch;
      if (v1LastDate) {
        v1Batch = await base44.asServiceRole.entities.RaceResult.filter(
          { race_date: { $gte: threeYearsAgo }, created_date: { $lt: v1LastDate } }, '-created_date', v1BatchSize
        ).catch(() => []);
      } else {
        v1Batch = await base44.asServiceRole.entities.RaceResult.filter(
          { race_date: { $gte: threeYearsAgo } }, '-created_date', v1BatchSize
        ).catch(() => []);
      }
      if (!v1Batch || v1Batch.length === 0) break;

      for (const rr of v1Batch) {
        if (!rr.finishers || !Array.isArray(rr.finishers) || rr.finishers.length === 0) continue;
        const raceDate = rr.race_date;
        if (!raceDate) continue;

        // start_infoをboat_numberでマップ
        const stMap = {};
        if (rr.start_info && Array.isArray(rr.start_info)) {
          for (const si of rr.start_info) {
            if (si.boat_number != null) stMap[si.boat_number] = si.st_raw || String(si.st ?? '');
          }
        }

        for (const f of rr.finishers) {
          if (!f.registration_number) continue;
          if (!racerMap.has(f.registration_number)) {
            racerMap.set(f.registration_number, {
              racer_name: f.racer_name || '',
              entries_6m: [],
              entries_1y: [],
              entries_3y: [],
            });
          }
          const racer = racerMap.get(f.registration_number);
          if (f.racer_name && !racer.racer_name) racer.racer_name = f.racer_name;

          const entry = {
            registration_number: f.registration_number,
            racer_name: f.racer_name || '',
            race_key: `${raceDate}_${rr.venue_code}_${String(rr.race_number).padStart(2, '0')}`,
            finish_order: f.finish || null,
            start_course: f.boat_number || null, // V1では進入コースが不明なため艇番を代理使用
            start_timing: stMap[f.boat_number] || null,
            is_absent: false,
          };

          if (raceDate >= periods["6m"].start) racer.entries_6m.push(entry);
          if (raceDate >= periods["1y"].start) racer.entries_1y.push(entry);
          if (raceDate >= periods["3y"].start) racer.entries_3y.push(entry);
        }
      }

      v1Fetched += v1Batch.length;
      v1LastDate = v1Batch[v1Batch.length - 1].created_date;
      if (v1Batch.length < v1BatchSize) break;
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

    // RacerTermStatV2フォールバック: 個別レース結果がない選手の基本評価を生成
    // race_dateが指定された場合、その日の出走選手でracerMapにいない選手を補完
    let fallbackCount = 0;
    if (body.race_date) {
      const raceEntries = await base44.asServiceRole.entities.RaceEntry.filter(
        { race_date: body.race_date }, 'boat_number', 5000
      ).catch(() => []);
      const participantRegs = [...new Set(raceEntries.map(e => e.registration_number).filter(Boolean))];
      const missingRegs = participantRegs.filter(rn => !racerMap.has(rn));

      if (missingRegs.length > 0) {
        // RacerTermStatV2から最新タームデータを取得
        for (let i = 0; i < missingRegs.length; i += 200) {
          const chunk = missingRegs.slice(i, i + 200);
          const termStats = await base44.asServiceRole.entities.RacerTermStatV2.filter(
            { registration_number: { $in: chunk } }, '-term_code', 1000
          ).catch(() => []);

          // 各選手の最新タームのみ保持
          const latestByReg = new Map();
          for (const ts of termStats) {
            if (!ts.registration_number) continue;
            if (!latestByReg.has(ts.registration_number) || ts.term_code > latestByReg.get(ts.registration_number).term_code) {
              latestByReg.set(ts.registration_number, ts);
            }
          }

          // フォールバック評価を生成
          for (const [regNum, ts] of latestByReg) {
            const winRate = ts.win_rate || 0;
            const top2Rate = ts.top2_rate || ts.second_place_rate || 0;
            const avgST = ts.average_start_timing;
            const raceCount = ts.race_count || 0;
            const fCount = ts.start_accident_count || 0;
            const lCount = ts.late_count || 0;

            // in_strength: 全体勝率から推定（1コース勝率の下限として使用）
            let inStrength = 40 + winRate * 100 * 0.6;
            if (avgST != null && avgST < 0.15) inStrength += 5;
            else if (avgST != null && avgST < 0.20) inStrength += 2;
            inStrength -= Math.min(10, fCount * 0.1 + lCount * 0.05);
            inStrength = Math.max(0, Math.min(100, Math.round(inStrength)));

            // mid_second: 2連対率から推定
            let midSecond = 30 + top2Rate * 100 * 0.5;
            midSecond = Math.max(0, Math.min(100, Math.round(midSecond)));

            const racerName = (ts.racer_name || '').replace(/[\s　]+/g, ' ').trim();

            evaluations.push({
              registration_number: regNum,
              racer_name: racerName,
              in_strength_score: inStrength,
              mid_second_score: midSecond,
              mid_third_score: null,
              outside_third_score: null,
              outside_second_score: null,
              player_types: [],
              period_data: {
                fallback: true,
                term_code: ts.term_code,
                term_label: ts.term_label,
                win_rate: winRate,
                top2_rate: top2Rate,
                avg_st: avgST,
                race_count: raceCount,
              },
              best_course: null,
              evaluation_version: EVALUATION_VERSION,
              computed_at: now,
            });
            fallbackCount++;
          }
        }
      }
    }

    // 各選手のスコア計算
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
      v1_fetched: v1Fetched,
      racer_count: computedCount + fallbackCount,
      fallback_count: fallbackCount,
      created_count: createdCount,
      updated_count: updatedCount,
      evaluation_version: EVALUATION_VERSION,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
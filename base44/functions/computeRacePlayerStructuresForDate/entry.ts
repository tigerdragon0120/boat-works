import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  EVALUATION_VERSION,
  computeRaceStructure,
} from '../../shared/racerEvaluation.js';

// 指定日の全レースの選手配置指数を一括計算する
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const raceDate = body.race_date;
    if (!raceDate) {
      return Response.json({ status: 'error', message: 'race_dateが必要です' }, { status: 400 });
    }

    const now = new Date().toISOString();

    // 対象日の全レース取得
    const races = await base44.asServiceRole.entities.Race.filter(
      { race_date: raceDate }, 'race_number', 200
    ).catch(() => []);

    if (!races || races.length === 0) {
      return Response.json({ status: 'success', race_date: raceDate, race_count: 0, computed: 0 });
    }

    // 全レースのRaceEntryを一括取得
    const raceIds = races.map(r => r.id);
    const allEntries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_id: { $in: raceIds } }, 'boat_number', 2000
    ).catch(() => []);

    // レースごとにエントリをグループ化
    const entriesByRace = {};
    for (const e of allEntries) {
      if (!entriesByRace[e.race_id]) entriesByRace[e.race_id] = [];
      entriesByRace[e.race_id].push(e);
    }

    // 全選手の登録番号を収集
    const allRegNums = new Set();
    for (const e of allEntries) {
      if (e.registration_number) allRegNums.add(String(e.registration_number));
    }

    // RacerEvaluationを一括取得（チャンクごと）
    const evalMap = {};
    const regNumArr = [...allRegNums];
    for (let i = 0; i < regNumArr.length; i += 500) {
      const chunk = regNumArr.slice(i, i + 500);
      const evals = await base44.asServiceRole.entities.RacerEvaluation.filter(
        { registration_number: { $in: chunk } }, '-computed_at', 600
      ).catch(() => []);
      for (const e of evals) evalMap[e.registration_number] = e;
    }

    // 既存RacePlayerStructureを一括取得
    const existingStructures = await base44.asServiceRole.entities.RacePlayerStructure.filter(
      { race_id: { $in: raceIds } }, '-created_date', 500
    ).catch(() => []);
    const existingMap = {};
    for (const s of existingStructures) existingMap[s.race_id] = s;

    let computed = 0;
    let skipped = 0;
    const toCreate = [];
    const toUpdate = [];

    for (const race of races) {
      const entries = entriesByRace[race.id] || [];
      if (entries.length < 6) { skipped++; continue; }

      const boatEvaluations = [];
      for (const entry of entries) {
        const ev = evalMap[String(entry.registration_number)];
        boatEvaluations.push({
          boat_number: entry.boat_number,
          registration_number: entry.registration_number,
          racer_name: entry.racer_name || ev?.racer_name || '',
          in_strength: ev?.in_strength_score ?? null,
          mid_second: ev?.mid_second_score ?? null,
          mid_third: ev?.mid_third_score ?? null,
          outside_second: ev?.outside_second_score ?? null,
          outside_third: ev?.outside_third_score ?? null,
          player_types: ev?.player_types || [],
        });
      }

      const structure = computeRaceStructure(boatEvaluations);
      const payload = {
        race_id: race.id,
        race_date: race.race_date,
        venue_code: race.venue_code,
        venue_name: race.venue_name,
        race_number: race.race_number,
        uichi_player_structure_score: structure.uichi_player_structure_score,
        ura_uichi_player_structure_score: structure.ura_uichi_player_structure_score,
        boat_evaluations: boatEvaluations,
        uichi_breakdown: structure.uichi_breakdown,
        ura_uichi_breakdown: structure.ura_uichi_breakdown,
        evaluation_version: EVALUATION_VERSION,
        computed_at: now,
      };

      const existing = existingMap[race.id];
      if (existing) {
        toUpdate.push({ id: existing.id, ...payload });
      } else {
        toCreate.push(payload);
      }
      computed++;
    }

    // バルク保存
    if (toCreate.length > 0) {
      for (let i = 0; i < toCreate.length; i += 200) {
        await base44.asServiceRole.entities.RacePlayerStructure.bulkCreate(toCreate.slice(i, i + 200));
      }
    }
    if (toUpdate.length > 0) {
      for (let i = 0; i < toUpdate.length; i += 200) {
        await base44.asServiceRole.entities.RacePlayerStructure.bulkUpdate(toUpdate.slice(i, i + 200));
      }
    }

    return Response.json({
      status: 'success',
      race_date: raceDate,
      race_count: races.length,
      computed,
      skipped,
      created_count: toCreate.length,
      updated_count: toUpdate.length,
      evaluations_available: Object.keys(evalMap).length,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  EVALUATION_VERSION,
  computeRaceStructure,
} from '../../shared/racerEvaluation.js';

// 指定レースの選手配置指数を計算する
// RaceEntry(1-6艇)の登録番号からRacerEvaluationを取得し、
// ういち・裏ういち選手配置指数を算出してRacePlayerStructureに保存する。

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') {
      return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { race_id, race_date, venue_code, venue_name, race_number } = body;

    if (!race_id) {
      return Response.json({ status: 'error', message: 'race_idが必要です' }, { status: 400 });
    }

    const now = new Date().toISOString();

    // RaceEntryを取得（1-6艇）
    const entries = await base44.asServiceRole.entities.RaceEntry.filter(
      { race_id }, 'boat_number', 10
    ).catch(() => []);

    if (!entries || entries.length === 0) {
      return Response.json({ status: 'error', message: 'RaceEntryが見つかりません' }, { status: 404 });
    }

    // 各艇の登録番号を収集
    const regNums = entries.map(e => e.registration_number).filter(Boolean);
    if (regNums.length === 0) {
      return Response.json({ status: 'error', message: '登録番号が取得できません' }, { status: 400 });
    }

    // RacerEvaluationを一括取得
    const evals = await base44.asServiceRole.entities.RacerEvaluation.filter(
      { registration_number: { $in: regNums } }, '-computed_at', 20
    ).catch(() => []);

    const evalMap = {};
    for (const e of evals) evalMap[e.registration_number] = e;

    // boat_evaluations構築
    const boatEvaluations = [];
    for (const entry of entries) {
      const ev = evalMap[entry.registration_number];
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

    // レース構成スコア計算
    const structure = computeRaceStructure(boatEvaluations);

    const payload = {
      race_id,
      race_date: race_date || entries[0]?.race_date || null,
      venue_code: venue_code || entries[0]?.venue_code || null,
      venue_name: venue_name || null,
      race_number: race_number || entries[0]?.race_number || null,
      uichi_player_structure_score: structure.uichi_player_structure_score,
      ura_uichi_player_structure_score: structure.ura_uichi_player_structure_score,
      boat_evaluations: boatEvaluations,
      uichi_breakdown: structure.uichi_breakdown,
      ura_uichi_breakdown: structure.ura_uichi_breakdown,
      evaluation_version: EVALUATION_VERSION,
      computed_at: now,
    };

    // 既存Record確認
    const existing = await base44.asServiceRole.entities.RacePlayerStructure.filter(
      { race_id }, '-created_date', 5
    ).catch(() => []);

    let result;
    if (existing.length > 0) {
      await base44.asServiceRole.entities.RacePlayerStructure.update(existing[0].id, payload);
      result = { status: 'updated', race_id };
    } else {
      await base44.asServiceRole.entities.RacePlayerStructure.create(payload);
      result = { status: 'created', race_id };
    }

    return Response.json({
      ...result,
      uichi_player_structure_score: structure.uichi_player_structure_score,
      ura_uichi_player_structure_score: structure.ura_uichi_player_structure_score,
      uichi_breakdown: structure.uichi_breakdown,
      ura_uichi_breakdown: structure.ura_uichi_breakdown,
      boat_count: boatEvaluations.length,
      evaluations_found: Object.keys(evalMap).length,
    });
  } catch (error) {
    return Response.json({ status: 'error', message: error.message }, { status: 500 });
  }
}
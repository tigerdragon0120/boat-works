// BOAT WORKS v10 - シリーズ開催中の選手ポイント
// 狙い: 年間勝率とは別に、その節の「今の状態」を0-100で可視化する。
// 重要: 勝負がけ度(rankPressure)は最初はseriesScoreに直接加点しない。
//       プレッシャーで強くなる/弱くなる個人差を、後で学習できるよう分離保存する。

export const SERIES_SCORE_VERSION = 'v10.2';

const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, Number(v) || 0));
const round1 = (v) => Math.round(v * 10) / 10;

// 着順の素点。50を中立に置くため、1走ごとの増減として扱う。
const FINISH_DELTA = { 1: 8, 2: 5, 3: 2, 4: -1, 5: -4, 6: -7 };

// 外枠で好走した価値、内枠で凡走した重さを小さく補正する。
// あくまで初期値。後で実績学習に置き換える前提。
function laneAdjustment(lane, finish) {
  lane = Number(lane);
  finish = Number(finish);
  if (!lane || !finish) return 0;

  if (finish <= 3) {
    // 外から3着以内ほど評価
    return { 1: -1.5, 2: -0.5, 3: 0, 4: 1, 5: 2, 6: 3 }[lane] || 0;
  }
  // 内枠で4着以下は少し重く、外枠凡走は過度に責めない
  return { 1: -3, 2: -2, 3: -1, 4: 0, 5: 0.5, 6: 1 }[lane] || 0;
}

export function computeSeriesRacerScore({ laneFinishHistory = [] } = {}) {
  const valid = laneFinishHistory.filter(x => Number(x?.lane) >= 1 && Number(x?.lane) <= 6 && Number(x?.finish) >= 1 && Number(x?.finish) <= 6);
  if (!valid.length) {
    return {
      series_score: 50,
      raw_series_score: 50,
      series_sample_confidence: 0,
      series_label: 'NEUTRAL',
      result_quality_score: 50,
      lane_difficulty_score: 50,
      series_momentum_score: 50,
      score_components: [],
      score_reasons: ['今節の完走データ不足のため中立'],
      algorithm_version: SERIES_SCORE_VERSION,
    };
  }

  let rawDelta = 0;
  const components = [];
  for (const x of valid) {
    const finishDelta = FINISH_DELTA[Number(x.finish)] || 0;
    const laneDelta = laneAdjustment(x.lane, x.finish);

    // 同一レース内の相対情報だけを初期スコアへ小さく反映。
    // 絶対時計は場・風・波・気温・水温の影響が大きいため、標準化データが貯まるまでは直接加点しない。
    let marginDelta = 0;
    if (Number(x.finish) === 1 && x.margin_1_2_seconds != null) {
      const gap = Number(x.margin_1_2_seconds);
      if (gap >= 1.5) marginDelta = 2.5;
      else if (gap >= 0.8) marginDelta = 1.5;
      else if (gap >= 0.4) marginDelta = 0.75;
    }
    let stDelta = 0;
    if (x.st_advantage != null) {
      const adv = Number(x.st_advantage); // + = 艇群平均より速い
      if (adv >= 0.05) stDelta = 1.25;
      else if (adv >= 0.03) stDelta = 0.75;
      else if (adv <= -0.05) stDelta = -1.0;
      else if (adv <= -0.03) stDelta = -0.5;
    }
    const contentDelta = marginDelta + stDelta;
    rawDelta += finishDelta + laneDelta + contentDelta;
    components.push({
      race_date: x.race_date || null,
      race_number: x.race_number || null,
      lane: Number(x.lane),
      finish: Number(x.finish),
      finish_delta: finishDelta,
      lane_delta: laneDelta,
      margin_delta: round1(marginDelta),
      st_relative_delta: round1(stDelta),
      total_delta: round1(finishDelta + laneDelta + contentDelta),
    });
  }

  // 走数が増えても暴れすぎないよう1走平均を中心に評価。
  const avgDelta = rawDelta / valid.length;
  const resultQuality = clamp(50 + avgDelta * 5);

  const avgLane = valid.reduce((s, x) => s + Number(x.lane), 0) / valid.length;
  // 平均枠3.5を中立、外寄りほど難易度高。
  const laneDifficulty = clamp(50 + (avgLane - 3.5) * 10);

  // 直近最大3走は流れとして別表示。
  const recent = valid.slice(-3);
  const componentMap = new Map(components.map(c => [`${c.race_date || ''}_${c.race_number || ''}_${c.lane}`, c]));
  const recentDelta = recent.reduce((s, x) => {
    const c = componentMap.get(`${x.race_date || ''}_${x.race_number || ''}_${Number(x.lane)}`);
    return s + Number(c?.total_delta || 0);
  }, 0) / recent.length;
  const momentum = clamp(50 + recentDelta * 5);

  // 今節全体70%、直近30%。枠難易度は各走補正済みなので二重加点しない。
  // 1〜2走だけの偶然で指数が極端にならないよう、走数に応じて50へ縮小する。
  const rawScore = clamp(resultQuality * 0.7 + momentum * 0.3);
  const sampleConfidence = clamp(valid.length / (valid.length + 2), 0, 1);
  const score = clamp(50 + (rawScore - 50) * sampleConfidence);
  const label = score >= 75 ? 'HOT' : score >= 60 ? 'UP' : score >= 42 ? 'NEUTRAL' : score >= 28 ? 'DOWN' : 'COLD';

  const reasons = [];
  if (score >= 60) reasons.push('今節は枠番を考慮しても内容が良い');
  if (score < 42) reasons.push('今節は枠番を考慮しても内容が弱い');
  if (momentum >= 65) reasons.push('直近3走の流れが上向き');
  if (momentum < 38) reasons.push('直近3走の流れが下降');
  if (avgLane >= 4.2) reasons.push('外枠を多く消化している');
  if (avgLane <= 2.8) reasons.push('内枠を多く消化している');
  if (valid.some(x => Number(x.finish) === 1 && Number(x.margin_1_2_seconds || 0) >= 1.5)) reasons.push('着差をつけた強い1着がある');
  if (valid.some(x => Number(x.st_advantage || 0) >= 0.05)) reasons.push('艇群平均より大きく速いST実績がある');

  return {
    series_score: round1(score),
    raw_series_score: round1(rawScore),
    series_sample_confidence: round1(sampleConfidence * 100),
    series_label: label,
    result_quality_score: round1(resultQuality),
    lane_difficulty_score: round1(laneDifficulty),
    series_momentum_score: round1(momentum),
    avg_lane: round1(avgLane),
    inner_lane_count: valid.filter(x => Number(x.lane) <= 3).length,
    outer_lane_count: valid.filter(x => Number(x.lane) >= 4).length,
    score_components: components,
    score_reasons: reasons,
    algorithm_version: SERIES_SCORE_VERSION,
  };
}

// 勝負がけ度。シリーズ指数とは分離。
// rank/pointRate/remainingRacesが揃った時だけ算出する。
export function computeRankPressureScore({ rank, qualifyingCut = 18, remainingRaces = 0, seriesDay = 1, totalDays = 1 } = {}) {
  rank = Number(rank);
  if (!rank || rank < 1) return 50;

  const dist = rank - Number(qualifyingCut || 18);
  let score;
  if (dist <= -8) score = 25;       // 上位で余裕
  else if (dist <= -4) score = 40;
  else if (dist <= 0) score = 75;   // 通過圏だがボーダー近辺
  else if (dist <= 3) score = 90;   // 19-21位等、典型的勝負がけ
  else if (dist <= 7) score = 75;
  else score = 45;                  // 大きく下位、条件が厳しすぎる可能性

  // 予選終盤ほど切迫度を上げる。ただし最終日一般戦等は呼び出し側で区分判定する。
  const progress = totalDays > 1 ? (Number(seriesDay || 1) - 1) / (Number(totalDays) - 1) : 0;
  score += progress * 8;
  if (Number(remainingRaces) <= 1) score += 5;

  return round1(clamp(score));
}

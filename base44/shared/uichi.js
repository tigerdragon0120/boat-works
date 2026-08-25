// BOAT WORKS 共通計算ロジック（バックエンド関数間で共有）

// ういち買い6点
export const UICHI_COMBOS = [
  "1-2-5",
  "1-2-6",
  "1-3-5",
  "1-3-6",
  "1-4-5",
  "1-4-6",
];

// 全国24場
export const VENUES = [
  { code: "KRY", name: "桐生" },
  { code: "TDA", name: "戸田" },
  { code: "EDG", name: "江戸川" },
  { code: "HWS", name: "平和島" },
  { code: "TMG", name: "多摩川" },
  { code: "HMN", name: "浜名湖" },
  { code: "GMY", name: "蒲郡" },
  { code: "TKN", name: "常滑" },
  { code: "TSU", name: "津" },
  { code: "MKN", name: "三国" },
  { code: "BWK", name: "びわこ" },
  { code: "SME", name: "住之江" },
  { code: "AMG", name: "尼崎" },
  { code: "NRT", name: "鳴門" },
  { code: "MRE", name: "丸亀" },
  { code: "KJM", name: "児島" },
  { code: "MYS", name: "宮島" },
  { code: "TKY", name: "徳山" },
  { code: "SMN", name: "下関" },
  { code: "WKM", name: "若松" },
  { code: "ASY", name: "芦屋" },
  { code: "FKO", name: "福岡" },
  { code: "KRT", name: "唐津" },
  { code: "OMR", name: "大村" },
];

// 1号艇評価（S/A/B/C/D）
export function gradeBoat1(entry) {
  if (!entry) return "D";
  let score = 0;
  // 全国勝率 (0-8程度) → 最大30点
  score += clamp((entry.national_win_rate || 0) / 8, 0, 1) * 30;
  // 当地勝率 → 最大20点
  score += clamp((entry.local_win_rate || 0) / 8, 0, 1) * 20;
  // 1コース1着率 → 最大25点
  score += clamp((entry.c1_win_rate || 0) / 70, 0, 1) * 25;
  // 平均ST (0.1=速い, 0.25=遅い) → 最大15点
  const st = entry.avg_st || 0.25;
  score += clamp((0.25 - st) / 0.15, 0, 1) * 15;
  // F持ち → -10点
  if ((entry.f_count || 0) > 0) score -= 10;
  // 展示タイムが速い → 最大10点
  if (entry.exhibition_time) {
    score += clamp((6.6 - entry.exhibition_time) / 0.6, 0, 1) * 10;
  }
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  if (score >= 35) return "C";
  return "D";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// 合成オッズ = 1 / Σ(1/odds)
export function syntheticOdds(oddsList) {
  const valid = (oddsList || []).filter((o) => o && o > 1);
  if (valid.length === 0) return 0;
  const sumInv = valid.reduce((s, o) => s + 1 / o, 0);
  return sumInv > 0 ? 1 / sumInv : 0;
}

// 期待値指数 = 出現率(0-1) × 合成オッズ × 100
export function expectedValue(appearanceRate, synthOdds) {
  return (appearanceRate || 0) * (synthOdds || 0) * 100;
}

// 判定
export function judge(expected, settings) {
  if (expected == null || !settings) return "PENDING";
  if (expected >= (settings.buy_threshold || 110)) return "BUY";
  if (expected >= (settings.watch_threshold || 100)) return "WATCH";
  return "SKIP";
}

// 類似レース抽出条件の重み付けスコア（過去レースとの類似度）
export function similarityScore(target, past) {
  let s = 0;
  if (target.venue_code === past.venue_code) s += 30;
  if (target.boat1_grade === past.boat1_grade) s += 20;
  s += 20 * (1 - Math.abs((target.boat1_national_win_rate || 0) - (past.boat1_national_win_rate || 0)) / 8);
  s += 15 * (1 - Math.abs((target.boat1_local_win_rate || 0) - (past.boat1_local_win_rate || 0)) / 8);
  s += 10 * (1 - Math.abs((target.boat1_avg_st || 0.2) - (past.boat1_avg_st || 0.2)) / 0.15);
  return s;
}

// ういち買い的中判定
export function isUichiHit(trifecta) {
  return UICHI_COMBOS.includes(trifecta);
}

export function whichUichiCombo(trifecta) {
  return UICHI_COMBOS.includes(trifecta) ? trifecta : null;
}
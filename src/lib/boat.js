// BOAT WORKS クライアント側定数・ヘルパー

export const UICHI_COMBOS = [
  "1-2-5",
  "1-2-6",
  "1-3-5",
  "1-3-6",
  "1-4-5",
  "1-4-6",
];

export const UICHI_LABEL = "1-234-56";

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

export function venueName(code) {
  const v = VENUES.find((x) => x.code === code);
  return v ? v.name : code;
}

// 判定色（ライトテーマ対応）
export const JUDGMENT_STYLE = {
  BUY: { bg: "bg-emerald-500", text: "text-emerald-600", ring: "ring-emerald-500/30", label: "BUY", glow: "shadow-emerald-500/20" },
  WATCH: { bg: "bg-orange-500", text: "text-orange-600", ring: "ring-orange-500/30", label: "WATCH", glow: "shadow-orange-500/20" },
  SKIP: { bg: "bg-red-500", text: "text-red-600", ring: "ring-red-500/30", label: "SKIP", glow: "shadow-red-500/20" },
  PENDING: { bg: "bg-slate-400", text: "text-slate-500", ring: "ring-slate-400/30", label: "判定待ち", glow: "shadow-slate-400/20" },
};

export const GRADE_STYLE = {
  S: "text-emerald-700 border-emerald-300 bg-emerald-50",
  A: "text-sky-700 border-sky-300 bg-sky-50",
  B: "text-amber-700 border-amber-300 bg-amber-50",
  C: "text-slate-600 border-slate-300 bg-slate-100",
  D: "text-rose-700 border-rose-300 bg-rose-50",
};

// 合成オッズ
export function syntheticOdds(oddsList) {
  const valid = (oddsList || []).filter((o) => o && o > 1);
  if (valid.length === 0) return 0;
  const sumInv = valid.reduce((s, o) => s + 1 / o, 0);
  return sumInv > 0 ? 1 / sumInv : 0;
}

export function expectedValue(rate, odds) {
  return (rate || 0) * (odds || 0) * 100;
}

export function judgeFromEV(ev, settings) {
  if (ev == null) return "PENDING";
  if (ev >= (settings?.buy_threshold || 110)) return "BUY";
  if (ev >= (settings?.watch_threshold || 100)) return "WATCH";
  return "SKIP";
}

// サンプル数を考慮した判定（BUY制限付き）
// n < min_buy_sample の場合、BUYを禁止しWATCHまたはSKIPにする
export function judgeFromEVWithSample(ev, similarCount, settings) {
  if (ev == null) return "PENDING";
  const minBuy = settings?.min_buy_sample || 100;
  if (similarCount < minBuy) {
    // サンプル不足 → BUY禁止
    if (ev >= (settings?.buy_threshold || 110)) return "WATCH";
    if (ev >= (settings?.watch_threshold || 100)) return "WATCH";
    return "SKIP";
  }
  if (ev >= (settings?.buy_threshold || 110)) return "BUY";
  if (ev >= (settings?.watch_threshold || 100)) return "WATCH";
  return "SKIP";
}

// 信頼度ランク（A/B/C/D）を返す
export function reliabilityGrade(n, settings) {
  const a = settings?.reliability_a_threshold || 500;
  const b = settings?.reliability_b_threshold || 250;
  const c = settings?.reliability_c_threshold || 100;
  if (n >= a) return "A";
  if (n >= b) return "B";
  if (n >= c) return "C";
  return "D";
}

// データ充足率を計算（validCount / totalCount）
export function dataSufficiencyRate(validCount, totalCount) {
  if (!totalCount || totalCount === 0) return 0;
  return validCount / totalCount;
}

// 締切までの残り時間（分）
export function minutesUntilDeadline(deadlineIso) {
  if (!deadlineIso) return null;
  const diff = new Date(deadlineIso).getTime() - Date.now();
  return Math.round(diff / 60000);
}

// 5分前判定可能か
export function canFinalJudge(deadlineIso) {
  const m = minutesUntilDeadline(deadlineIso);
  return m != null && m <= 5;
}

export function fmtTime(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDate(iso) {
  if (!iso) return "--/--";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 1号艇評価（S/A/B/C/D）
export function gradeBoat1(entry) {
  if (!entry) return "D";
  let score = 0;
  score += clampScore((entry.national_win_rate || 0) / 8, 0, 1) * 30;
  score += clampScore((entry.local_win_rate || 0) / 8, 0, 1) * 20;
  score += clampScore((entry.c1_win_rate || 0) / 70, 0, 1) * 25;
  const st = entry.avg_st || 0.25;
  score += clampScore((0.25 - st) / 0.15, 0, 1) * 15;
  if ((entry.f_count || 0) > 0) score -= 10;
  if (entry.exhibition_time) score += clampScore((6.6 - entry.exhibition_time) / 0.6, 0, 1) * 10;
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  if (score >= 35) return "C";
  return "D";
}
function clampScore(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function fmtNum(n, digits = 1) {
  if (n == null || isNaN(n)) return "-";
  return Number(n).toFixed(digits);
}

export function fmtPct(n, digits = 1) {
  if (n == null || isNaN(n)) return "-";
  return `${(Number(n) * 100).toFixed(digits)}%`;
}
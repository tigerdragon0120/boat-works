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

// 10分前から最終判定可能か
export function canFinalJudge(deadlineIso) {
  const m = minutesUntilDeadline(deadlineIso);
  return m != null && m <= 10;
}

// 最終判定予定時刻（締切-10分）。購入時間を確保するため10分前を正式な確定時刻とする
export function finalJudgeTime(deadlineIso) {
  if (!deadlineIso) return null;
  const deadline = new Date(deadlineIso);
  return new Date(deadline.getTime() - 10 * 60 * 1000);
}

export function fmtTime(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtTimeSec(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
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

// === 1号艇信頼スコア（クライアントlite版・エントリーデータのみ） ===

export function gradeToScore(grade) {
  if (!grade) return null;
  const g = String(grade).toUpperCase();
  if (g === "A1") return 1.0;
  if (g === "A2") return 0.85;
  if (g === "B1") return 0.65;
  if (g === "B2") return 0.45;
  return 0.5;
}

export function trustScoreLabel(score) {
  if (score == null) return "—";
  if (score >= 90) return "非常に信頼";
  if (score >= 75) return "信頼";
  if (score >= 60) return "やや信頼";
  if (score >= 45) return "普通";
  return "不安";
}

export function trustScoreColor(score) {
  if (score == null) return "text-muted-foreground";
  if (score >= 90) return "text-emerald-600";
  if (score >= 75) return "text-sky-600";
  if (score >= 60) return "text-primary";
  if (score >= 45) return "text-amber-600";
  return "text-rose-600";
}

// 1号艇信頼スコア計算（lite版・DBクエリ不要・RaceCard/Alerts用）
// エントリーデータのみ使用。1コース信頼性はc1_win_rateを使用。
export function computeTrustScoreLite(entry, settings) {
  if (!entry) return null;
  const w = {
    basic: settings?.trust_weight_basic ?? 20,
    lane1: settings?.trust_weight_lane1 ?? 20,
    venue: settings?.trust_weight_venue ?? 15,
    st: settings?.trust_weight_st ?? 10,
    motor: settings?.trust_weight_motor ?? 10,
  };
  const components = [];
  const reasons = [];
  const concerns = [];
  let rawScore = 0;
  let rawMax = 0;

  // A. 選手基本力
  {
    const max = w.basic;
    const nwr = entry.national_win_rate;
    const n2r = entry.national_2rate;
    const gs = gradeToScore(entry.grade_class);
    if (nwr != null || n2r != null || gs != null) {
      let s = 0, wt = 0;
      if (nwr != null) { s += clampScore(nwr / 8, 0, 1) * 50; wt += 50; }
      if (n2r != null) { s += clampScore(n2r / 60, 0, 1) * 20; wt += 20; }
      if (gs != null) { s += gs * 30; wt += 30; }
      const norm = wt > 0 ? s / wt : 0;
      const points = Math.round(norm * max);
      components.push({ key: "basic", label: "選手基本力", points, max, evaluated: true });
      rawScore += points; rawMax += max;
      if (nwr != null && nwr >= 6) reasons.push({ label: `全国勝率 ${fmtNum(nwr, 2)}`, strength: points });
      if (gs != null && gs >= 0.8 && entry.grade_class) reasons.push({ label: `級別 ${entry.grade_class}`, strength: Math.round(gs * max * 0.3) });
    }
  }

  // B. 1コース信頼性（エントリーc1_win_rate使用）
  {
    const max = w.lane1;
    const c1 = entry.c1_win_rate;
    const c12 = entry.c1_2rate;
    if (c1 != null || c12 != null) {
      let s = 0, wt = 0;
      if (c1 != null) { s += clampScore(c1 / 70, 0, 1) * 60; wt += 60; }
      if (c12 != null) { s += clampScore(c12 / 90, 0, 1) * 40; wt += 40; }
      const norm = wt > 0 ? s / wt : 0;
      const points = Math.round(norm * max);
      components.push({ key: "lane1", label: "1コース信頼性", points, max, evaluated: true });
      rawScore += points; rawMax += max;
      if (c1 != null && c1 >= 55) reasons.push({ label: `1コース1着率 ${fmtNum(c1, 1)}%`, strength: points });
      else if (c12 != null && c12 >= 80) reasons.push({ label: `1コース2連率 ${fmtNum(c12, 1)}%`, strength: Math.round(points * 0.7) });
    }
  }

  // C. 当地相性
  {
    const max = w.venue;
    const lwr = entry.local_win_rate;
    const l2r = entry.local_2rate;
    if (lwr != null || l2r != null) {
      let s = 0, wt = 0;
      if (lwr != null) { s += clampScore(lwr / 8, 0, 1) * 50; wt += 50; }
      if (l2r != null) { s += clampScore(l2r / 60, 0, 1) * 50; wt += 50; }
      const norm = wt > 0 ? s / wt : 0;
      const points = Math.round(norm * max);
      components.push({ key: "venue", label: "当地相性", points, max, evaluated: true });
      rawScore += points; rawMax += max;
      if (lwr != null && lwr >= 6) reasons.push({ label: `当地勝率 ${fmtNum(lwr, 2)}`, strength: points });
    }
  }

  // D. ST評価
  {
    const max = w.st;
    const st = entry.avg_st;
    if (st != null && st > 0) {
      const norm = clampScore((0.25 - st) / 0.20, 0, 1);
      const points = Math.round(norm * max);
      components.push({ key: "st", label: "平均ST", points, max, evaluated: true });
      rawScore += points; rawMax += max;
      if (st <= 0.13) reasons.push({ label: `平均ST ${fmtNum(st, 2)}`, strength: points });
    }
  }

  // E. モーター評価
  {
    const max = w.motor;
    const m2r = entry.motor_2rate;
    const m3r = entry.motor_3rate;
    if (m2r != null || m3r != null) {
      let s = 0, wt = 0;
      if (m2r != null) { s += clampScore(m2r / 50, 0, 1) * 60; wt += 60; }
      if (m3r != null) { s += clampScore(m3r / 70, 0, 1) * 40; wt += 40; }
      const norm = wt > 0 ? s / wt : 0;
      const points = Math.round(norm * max);
      components.push({ key: "motor", label: "モーター", points, max, evaluated: true });
      rawScore += points; rawMax += max;
      if (m2r != null && m2r >= 40) reasons.push({ label: `モーター2連率 ${fmtNum(m2r, 1)}%`, strength: points });
    }
  }

  // H. リスク減点
  {
    const fc = entry.f_count || 0;
    if (fc > 0) {
      const penalty = Math.min(fc * 4, 15);
      components.push({ key: "risk", label: "Fリスク", points: -penalty, max: 0, evaluated: true, isRisk: true });
      rawScore -= penalty;
      concerns.push({ label: `F${fc}持ち`, severity: penalty });
    }
  }
  if (entry.motor_2rate != null && entry.motor_2rate < 28) {
    concerns.push({ label: `モーター2連率 ${fmtNum(entry.motor_2rate, 1)}%`, severity: 6 });
  }
  if (entry.local_win_rate != null && entry.local_win_rate < 3.5) {
    concerns.push({ label: `当地勝率 ${fmtNum(entry.local_win_rate, 2)}`, severity: 5 });
  }
  if (entry.avg_st != null && entry.avg_st > 0.18) {
    concerns.push({ label: `平均ST ${fmtNum(entry.avg_st, 2)}（やや遅い）`, severity: 4 });
  }

  const adjustedScore = rawMax > 0 ? Math.round(rawScore / rawMax * 100) : 0;
  reasons.sort((a, b) => b.strength - a.strength);

  return {
    score: adjustedScore,
    raw_score: rawScore,
    max_possible: rawMax,
    components,
    reasons: reasons.slice(0, 7),
    concerns,
    evaluated_count: components.filter(c => c.evaluated && !c.isRisk).length,
    total_components: 5,
  };
}

// === 公式選手写真URL生成 ===
// BOAT RACE公式サイトの選手写真URL規則: https://www.boatrace.jp/racerphoto/{登録番号4桁}.jpg
// 登録番号のみをキーに使用（選手名・支部・級別は不使用・同姓同名問題回避）
export function getOfficialRacerPhotoUrl(registrationNumber) {
  if (!registrationNumber) return null;
  const reg = String(registrationNumber).trim();
  if (!/^\d{4}$/.test(reg)) return null;
  return `https://www.boatrace.jp/racerphoto/${reg}.jpg`;
}
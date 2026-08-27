import { useState } from "react";
import { ChevronDown, ChevronUp, Shield, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { trustScoreLabel, trustScoreColor } from "@/lib/boat";

// 1号艇信頼スコアカード
// trust: { score, raw_score, max_possible, reliability, sample_size, components, condition_match }
export default function TrustScoreCard({ trust, compact = false }) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  if (!trust) return null;

  const label = trustScoreLabel(trust.score);
  const color = trustScoreColor(trust.score);
  const isStrong = trust.score >= 85;

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5">
        <Shield className={cn("w-3.5 h-3.5", color)} />
        <span className="text-xs text-muted-foreground">信頼</span>
        <span className={cn("text-lg font-bold tabular-nums", color)}>{trust.score}</span>
        <span className="text-[10px] text-muted-foreground">/100</span>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-3">
      {/* ヘッダー */}
      <div className="flex items-center gap-2">
        <Shield className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">1号艇信頼スコア</h3>
        {trust.boat1_name && (
          <span className="ml-auto text-xs text-muted-foreground truncate">{trust.boat1_name}</span>
        )}
      </div>

      {/* スコア表示 */}
      <div className="flex items-center gap-4">
        <div className={cn(
          "text-5xl font-bold tabular-nums w-20 text-center rounded-2xl py-2",
          trust.score >= 90 ? "bg-emerald-50 text-emerald-600" :
          trust.score >= 75 ? "bg-sky-50 text-sky-600" :
          trust.score >= 60 ? "bg-primary/10 text-primary" :
          trust.score >= 45 ? "bg-amber-50 text-amber-600" :
          "bg-rose-50 text-rose-600"
        )}>
          {trust.score}
        </div>
        <div className="flex-1 space-y-1">
          <div className={cn("text-lg font-bold", color)}>
            {isStrong && "🔥 "}
            {label}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {trust.raw_score} / {trust.max_possible}点
            {trust.max_possible < 100 && ` （換算${trust.score}点）`}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">信頼度</span>
            <span className={cn(
              "px-1.5 py-0.5 rounded font-bold",
              trust.reliability === "A" ? "bg-emerald-100 text-emerald-700" :
              trust.reliability === "B" ? "bg-sky-100 text-sky-700" :
              trust.reliability === "C" ? "bg-amber-100 text-amber-700" :
              "bg-rose-100 text-rose-700"
            )}>
              {trust.reliability}
            </span>
            <span className="text-muted-foreground tabular-nums">n={trust.sample_size ?? "—"}</span>
          </div>
        </div>
      </div>

      {/* 条件一致度 */}
      {trust.condition_match && trust.condition_match.total > 0 && (
        <div className="rounded-xl bg-background/50 px-3 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">条件一致度</span>
            <span className="font-bold tabular-nums text-primary">
              {trust.condition_match.score}% ({trust.condition_match.matched}/{trust.condition_match.total}条件)
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-background overflow-hidden mt-1.5">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${trust.condition_match.score}%` }} />
          </div>
        </div>
      )}

      {/* 内訳トグル */}
      <button
        onClick={() => setShowBreakdown(!showBreakdown)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground w-full"
      >
        <Info className="w-3.5 h-3.5" />
        {showBreakdown ? "内訳を閉じる" : "なぜこのスコア？"}
        {showBreakdown ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {/* 内訳 */}
      {showBreakdown && (
        <div className="space-y-1.5 pt-1">
          {trust.components?.map((c) => (
            <div key={c.key} className="flex items-center justify-between text-xs">
              <span className={cn("text-muted-foreground", !c.evaluated && "italic opacity-60")}>
                {c.label}
                {!c.evaluated && "（評価対象外）"}
              </span>
              <span className={cn(
                "font-semibold tabular-nums",
                c.isRisk ? "text-rose-600" : c.evaluated ? "text-foreground" : "text-muted-foreground"
              )}>
                {c.points > 0 ? `+${c.points}` : c.points}
                {c.evaluated && !c.isRisk && c.max > 0 && <span className="text-muted-foreground font-normal">/${c.max}</span>}
              </span>
            </div>
          ))}
          <div className="border-t border-border pt-1.5 flex items-center justify-between text-xs font-bold">
            <span>合計</span>
            <span className="tabular-nums">{trust.raw_score} / {trust.max_possible}</span>
          </div>
        </div>
      )}
    </div>
  );
}
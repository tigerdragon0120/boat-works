import { TrendingUp, TrendingDown, Shield, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

// 1号艇評価理由カード
// trust.components（各評価項目のポイント）と trust.reasons（具体的根拠）を
// 視覚的に一覧表示し、スコアがなぜ算出されたかを詳細に説明する
export default function EvaluationReasonCard({ trust }) {
  if (!trust) return null;

  const components = (trust.components || []).filter((c) => c.evaluated);
  const reasons = trust.reasons || [];
  const concerns = trust.concerns || [];

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">評価理由カード</h3>
        <span className="ml-auto text-xs text-muted-foreground">なぜこのスコアか</span>
      </div>

      {/* 評価項目別ポイント（プログレスバー付き） */}
      <div className="space-y-2.5">
        {components.map((c) => {
          const ratio = c.max > 0 ? Math.max(0, c.points) / c.max : 0;
          const isRisk = c.isRisk;
          return (
            <div key={c.key}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">{c.label}</span>
                <span className={cn(
                  "font-bold tabular-nums",
                  isRisk ? "text-rose-600" : c.points >= c.max * 0.7 ? "text-emerald-600" : c.points >= c.max * 0.4 ? "text-amber-600" : "text-muted-foreground"
                )}>
                  {isRisk ? "" : "+"}{c.points}{!isRisk && c.max > 0 && <span className="text-muted-foreground font-normal">/{c.max}</span>}
                </span>
              </div>
              {!isRisk && c.max > 0 && (
                <div className="h-2 rounded-full bg-background overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      ratio >= 0.7 ? "bg-emerald-500" : ratio >= 0.4 ? "bg-amber-500" : "bg-slate-300"
                    )}
                    style={{ width: `${Math.min(100, ratio * 100)}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 合計 */}
      <div className="border-t border-border pt-2 flex items-center justify-between text-sm font-bold">
        <span className="flex items-center gap-1.5"><Shield className="w-4 h-4 text-primary" />合計スコア</span>
        <span className="tabular-nums">{trust.raw_score} / {trust.max_possible}点</span>
      </div>

      {/* 具体的根拠 */}
      {reasons.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-600">
            <TrendingUp className="w-3.5 h-3.5" /> 評価を支える根拠
          </div>
          {reasons.map((r, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg bg-emerald-50/60 px-3 py-1.5">
              <span className="flex-1 text-xs text-foreground">{r.label}</span>
              <span className="text-[10px] font-bold text-emerald-600 tabular-nums shrink-0">+{r.strength}</span>
            </div>
          ))}
        </div>
      )}

      {/* 不安材料 */}
      {concerns.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-600">
            <TrendingDown className="w-3.5 h-3.5" /> 不安材料
          </div>
          {concerns.map((c, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg bg-amber-50/60 px-3 py-1.5">
              <span className="flex-1 text-xs text-foreground">{c.label}</span>
              <span className="text-[10px] font-bold text-amber-600 tabular-nums shrink-0">-{c.severity}</span>
            </div>
          ))}
        </div>
      )}

      {reasons.length === 0 && concerns.length === 0 && components.length === 0 && (
        <div className="text-center text-sm text-muted-foreground py-2">評価データがありません</div>
      )}
    </div>
  );
}
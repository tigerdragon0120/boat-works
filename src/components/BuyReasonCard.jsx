import { CheckCircle, AlertTriangle, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";

// 買える理由カード + 不安材料カード
// trust: { reasons: [{label, strength}], concerns: [{label, severity}] }
export default function BuyReasonCard({ trust }) {
  if (!trust) return null;

  const reasons = trust.reasons || [];
  const concerns = trust.concerns || [];
  const reasonCount = reasons.length;
  const concernCount = concerns.length;
  const totalItems = reasonCount + concernCount;

  return (
    <div className="space-y-3">
      {/* 買える理由 */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <ThumbsUp className="w-4 h-4 text-emerald-600" />
          <h3 className="text-sm font-bold">この1号艇を買える理由</h3>
          <span className="ml-auto text-xs text-muted-foreground">
            信頼材料 <span className="text-emerald-600 font-bold tabular-nums">{reasonCount}</span> / {totalItems}
          </span>
        </div>
        {reasonCount === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-3">
            実データに基づく信頼材料がありません
          </div>
        ) : (
          <div className="space-y-2">
            {reasons.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <span className="flex-1">{r.label}</span>
                {r.strength != null && (
                  <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                    +{r.strength}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 不安材料 */}
      {concernCount > 0 && (
        <div className="rounded-2xl bg-card border border-amber-300/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <h3 className="text-sm font-bold text-amber-700">注意材料</h3>
            <span className="ml-auto text-xs text-muted-foreground">
              <span className="text-amber-600 font-bold tabular-nums">{concernCount}</span>件
            </span>
          </div>
          <div className="space-y-2">
            {concerns.map((c, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <span className="flex-1">{c.label}</span>
                {c.severity != null && (
                  <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                    -{c.severity}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
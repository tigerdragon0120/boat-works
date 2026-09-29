import { ArrowDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PULL_THRESHOLD } from "@/hooks/usePullToRefresh";

export default function PullToRefreshIndicator({ pullDistance = 0, refreshing = false }) {
  const active = refreshing || pullDistance > 0;
  const ready = refreshing || pullDistance >= PULL_THRESHOLD;
  return (
    <div className="flex items-center justify-center overflow-hidden" style={{ height: active ? Math.max(pullDistance, 32) : 0 }}>
      {active && (
        <span className={cn("flex items-center gap-1.5 text-xs font-semibold", ready ? "text-primary" : "text-muted-foreground")}>
          {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDown className={cn("w-3.5 h-3.5 transition-transform", ready && "rotate-180")} />}
          {refreshing ? "再読み込み中…" : ready ? "離して再読み込み" : "下に引っ張って再読み込み"}
        </span>
      )}
    </div>
  );
}
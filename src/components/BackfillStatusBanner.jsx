import { useState, useEffect, useCallback } from "react";
import { CheckCircle, Loader2, AlertCircle, Zap, Clock } from "lucide-react";
import { getBackfillStatus } from "@/lib/boatService";
import { fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

// BOAT WORKS データ準備状況バナー
// 直近30日(P1) / 31-90日(P2) / 91-180日(P3)の補完率を表示
// P1が95%以上で「実用開始可能」、全完了で「基盤完成」を表示

export default function BackfillStatusBanner() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const s = await getBackfillStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) {
    return (
      <div className="rounded-2xl bg-card border border-border p-4 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> データ準備状況を確認中…
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-2xl bg-card border border-border p-4 flex items-center gap-2 text-muted-foreground">
        <AlertCircle className="w-4 h-4" /> バックフィル状況を取得できませんでした
      </div>
    );
  }

  const p1Rate = status.p1?.rate || 0;
  const p2Rate = status.p2?.rate || 0;
  const p3Rate = status.p3?.rate || 0;
  const overallRate = status.overall?.rate || 0;
  const p1Error = status.p1?.error || 0;

  // 実用開始判定
  let readiness;
  let readinessColor;
  let readinessIcon;
  if (p1Rate >= 0.95 && p1Error === 0) {
    readiness = "実用データ準備完了";
    readinessColor = "bg-emerald-50 border-emerald-300 text-emerald-700";
    readinessIcon = <CheckCircle className="w-5 h-5 text-emerald-600" />;
  } else if (p1Rate >= 0.95) {
    readiness = "ほぼ準備完了（エラー要対応）";
    readinessColor = "bg-amber-50 border-amber-300 text-amber-700";
    readinessIcon = <AlertCircle className="w-5 h-5 text-amber-600" />;
  } else if (p1Rate >= 0.90) {
    readiness = "実用データ準備中";
    readinessColor = "bg-amber-50 border-amber-300 text-amber-700";
    readinessIcon = <Clock className="w-5 h-5 text-amber-600" />;
  } else {
    readiness = "バックフィル中";
    readinessColor = "bg-orange-50 border-orange-300 text-orange-700";
    readinessIcon = <Loader2 className="w-5 h-5 text-orange-600 animate-spin" />;
  }

  // 全完了判定
  const allComplete = p1Rate >= 0.99 && p2Rate >= 0.99 && p3Rate >= 0.99 &&
    (status.p1?.error || 0) === 0 && (status.p2?.error || 0) === 0 && (status.p3?.error || 0) === 0;

  return (
    <div className="space-y-3">
      {/* メインステータス */}
      <div className={cn("rounded-2xl border p-4 flex items-center gap-3", readinessColor)}>
        {readinessIcon}
        <div className="flex-1">
          <div className="text-base font-bold">
            {allComplete ? "✅ 過去6か月データ基盤 完成" : `🟢 BOAT WORKS ${readiness}`}
          </div>
          <div className="text-xs opacity-80 mt-0.5">
            {p1Rate >= 0.95 && !allComplete && "BOAT WORKS実用開始可能です。古いデータはバックグラウンドで補完中です。"}
            {p1Rate < 0.95 && "直近30日の詳細補完が完了すると実用開始できます。"}
            {allComplete && "過去6か月分のデータが完全に揃いました。"}
          </div>
        </div>
        <button onClick={load} className="text-xs underline opacity-70 hover:opacity-100">
          更新
        </button>
      </div>

      {/* 3階層プログレスバー */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <TierBar
          label="直近30日"
          rate={p1Rate}
          total={status.p1?.total || 0}
          done={status.p1?.done || 0}
          error={p1Error}
          highlight
        />
        <TierBar
          label="過去90日"
          rate={p2Rate}
          total={status.p2?.total || 0}
          done={status.p2?.done || 0}
          error={status.p2?.error || 0}
        />
        <TierBar
          label="過去6か月"
          rate={overallRate}
          total={status.overall?.total || 0}
          done={status.overall?.done || 0}
          error={status.overall?.error || 0}
        />
      </div>
    </div>
  );
}

function TierBar({ label, rate, total, done, error, highlight }) {
  const pct = Math.round(rate * 100);
  const barColor = rate >= 0.95 ? "bg-emerald-500" : rate >= 0.50 ? "bg-primary" : "bg-amber-500";
  return (
    <div className={cn(
      "rounded-xl bg-card border p-3",
      highlight ? "border-primary/40 ring-1 ring-primary/20" : "border-border"
    )}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-bold text-muted-foreground">{label}</span>
        <span className="text-sm font-bold tabular-nums">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-background overflow-hidden mb-1.5">
        <div className={cn("h-full rounded-full transition-all", barColor)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>1号艇詳細: {done} / {total}</span>
        {error > 0 && <span className="text-rose-600 font-semibold">エラー {error}</span>}
      </div>
    </div>
  );
}
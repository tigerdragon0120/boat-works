import { useState, useEffect, useCallback } from "react";
import { CheckCircle, Loader2, AlertCircle, Clock } from "lucide-react";
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
    const interval = setInterval(load, 300000);
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

  const overallDone = status.overall?.done || 0;
  const overallTotal = status.overall?.total || 0;
  const overallError = status.overall?.error || 0;
  const detailPct = Math.round(overallRate * 100);

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-3">
      <div className="flex items-center gap-3">
        {allComplete ? <CheckCircle className="w-5 h-5 text-emerald-600" /> : <Loader2 className="w-5 h-5 text-primary animate-spin" />}
        <div className="flex-1">
          <div className="font-bold">過去データ状況</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {allComplete ? "必要な過去データは揃っています" : "不足分は自動で補完しています"}
          </div>
        </div>
        <button onClick={load} className="text-xs underline text-muted-foreground">更新</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <SimpleStatus
          label="直近30日"
          ok={p1Rate >= 0.95 && p1Error === 0}
          text={p1Rate >= 0.95 && p1Error === 0 ? "使用可能" : `補完中 ${Math.round(p1Rate * 100)}%`}
        />
        <SimpleStatus
          label="1号艇詳細"
          ok={overallRate >= 0.99 && overallError === 0}
          text={overallRate >= 0.99 && overallError === 0 ? "完了" : `${detailPct}%（${overallDone}/${overallTotal}）`}
        />
        <SimpleStatus
          label="エラー"
          ok={overallError === 0}
          text={overallError === 0 ? "0件" : `${overallError}件`}
        />
      </div>
    </div>
  );
}

function SimpleStatus({ label, ok, text }) {
  return (
    <div className="rounded-xl bg-background/50 border border-border p-3 flex items-center justify-between gap-2">
      <div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-sm font-bold tabular-nums">{text}</div>
      </div>
      {ok ? <CheckCircle className="w-4 h-4 text-emerald-600" /> : <Clock className="w-4 h-4 text-amber-600" />}
    </div>
  );
}
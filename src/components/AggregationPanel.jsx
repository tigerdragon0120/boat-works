import { useEffect, useState } from "react";
import { Database, Loader2, AlertCircle, CheckCircle2, RefreshCw, Zap } from "lucide-react";
import { buildAggregates, updateDailyAggregates, getAggregationMeta } from "@/lib/boatService";
import { cn } from "@/lib/utils";

export default function AggregationPanel() {
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dailyDate, setDailyDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [dailyRunning, setDailyRunning] = useState(false);
  const [dailyResult, setDailyResult] = useState(null);

  const loadMeta = async () => {
    try {
      const m = await getAggregationMeta();
      setMeta(m);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    loadMeta();
    const t = setInterval(loadMeta, 5000);
    return () => clearInterval(t);
  }, []);

  const handleBuild = async () => {
    if (!confirm("全RaceResultから集計DBを再構築します。既存の集計レコードは全て削除され再作成されます。実行しますか？")) return;
    setBuilding(true);
    setError(null);
    setResult(null);
    try {
      const res = await buildAggregates();
      setResult(res);
      loadMeta();
    } catch (e) {
      setError(e?.message || "集計DB構築失敗");
    } finally {
      setBuilding(false);
    }
  };

  const handleDaily = async () => {
    setDailyRunning(true);
    setDailyResult(null);
    try {
      const res = await updateDailyAggregates(dailyDate);
      setDailyResult(res);
      loadMeta();
    } catch (e) {
      setDailyResult({ status: "error", message: e?.message });
    } finally {
      setDailyRunning(false);
    }
  };

  if (loading) return null;

  const isBuilding = meta?.status === "building" || building;

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">集計DB（RacerStats / VenueRaceStats 等）</h3>
      </div>

      {/* 状態表示 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="rounded-xl bg-background/50 px-3 py-2">
          <div className="text-muted-foreground">状態</div>
          <div className={cn("font-bold flex items-center gap-1",
            meta?.status === "building" ? "text-amber-600" :
            meta?.status === "error" ? "text-rose-600" : "text-emerald-600"
          )}>
            {meta?.status === "building" && <Loader2 className="w-3 h-3 animate-spin" />}
            {meta?.status === "idle" && <CheckCircle2 className="w-3 h-3" />}
            {meta?.status === "error" && <AlertCircle className="w-3 h-3" />}
            {meta?.status === "idle" ? "完了" : meta?.status === "building" ? "構築中" : meta?.status || "未構築"}
          </div>
        </div>
        <div className="rounded-xl bg-background/50 px-3 py-2">
          <div className="text-muted-foreground">集計バージョン</div>
          <div className="font-bold tabular-nums">v{meta?.stats_version ?? "—"}</div>
        </div>
        <div className="rounded-xl bg-background/50 px-3 py-2">
          <div className="text-muted-foreground">処理済みRaceResult</div>
          <div className="font-bold tabular-nums">{meta?.total_races_processed?.toLocaleString() ?? "—"}</div>
        </div>
        <div className="rounded-xl bg-background/50 px-3 py-2">
          <div className="text-muted-foreground">最終更新日</div>
          <div className="font-bold tabular-nums">{meta?.last_aggregated_date ?? "—"}</div>
        </div>
      </div>

      {meta?.status === "error" && meta?.error_msg && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span className="break-all">{meta.error_msg}</span>
        </div>
      )}

      {/* 初期構築ボタン */}
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground">
          既存RaceResult全件から集計Entityを構築します。初回のみ使用。集計ロジック変更時(stats_version更新時)にも再構築に使用します。
        </div>
        <button
          onClick={handleBuild}
          disabled={isBuilding}
          className={cn(
            "w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50",
            "bg-gradient-to-r from-primary to-primary/80 text-primary-foreground"
          )}
        >
          {isBuilding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {isBuilding ? "構築中（全件読み込み・数分かかります）…" : "集計DB初期構築"}
        </button>
      </div>

      {result && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 space-y-1">
          <div className="font-bold">構築完了 ({(result.elapsed_ms / 1000).toFixed(1)}秒)</div>
          <div className="text-xs grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span>RaceResult: {result.total_results?.toLocaleString()}件</span>
            <span>RacerStats: {result.racer_stats}件</span>
            <span>RacerVenueStats: {result.racer_venue_stats}件</span>
            <span>RacerLaneStats: {result.racer_lane_stats}件</span>
            <span>RacerWeatherStats: {result.racer_weather_stats}件</span>
            <span>VenueRaceStats: {result.venue_race_stats}件</span>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* 日次差分更新（テスト用） */}
      <div className="border-t border-border pt-3 space-y-2">
        <div className="text-xs font-bold text-muted-foreground">日次差分更新（テスト実行）</div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dailyDate}
            onChange={(e) => setDailyDate(e.target.value)}
            className="px-3 py-2 rounded-lg bg-background border border-border text-sm"
          />
          <button
            onClick={handleDaily}
            disabled={dailyRunning}
            className="px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary font-bold text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            {dailyRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {dailyRunning ? "更新中…" : "差分更新"}
          </button>
        </div>
        {dailyResult && (
          <div className={cn("rounded-xl px-3 py-2 text-xs",
            dailyResult.status === "success" ? "bg-emerald-50 text-emerald-700 border border-emerald-300"
              : "bg-rose-50 text-rose-700 border border-rose-300")}>
            {dailyResult.status === "success"
              ? `${dailyDate}: ${dailyResult.results_processed}件処理・${dailyResult.records_updated}件更新・${dailyResult.records_created}件新規 (${(dailyResult.elapsed_ms / 1000).toFixed(1)}秒)`
              : `${dailyDate}: ${dailyResult.message || dailyResult.status}`}
          </div>
        )}
      </div>
    </div>
  );
}
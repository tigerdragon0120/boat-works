import { useState, useEffect, useCallback } from "react";
import { Database, Loader2, Play, CheckCircle, AlertCircle, RefreshCw, BarChart3 } from "lucide-react";
import { fetchHistoricalRange, getRangeSummary, recalcVenueStats } from "@/lib/boatService";
import { VENUES, fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function HistoricalFetchPanel() {
  const [startDate, setStartDate] = useState("2026-07-25");
  const [endDate, setEndDate] = useState("2026-07-31");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [log, setLog] = useState([]);
  const [recalcState, setRecalcState] = useState(null);

  const loadSummary = useCallback(async () => {
    try {
      const s = await getRangeSummary(startDate, endDate);
      setSummary(s);
    } catch {}
  }, [startDate, endDate]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const run = async () => {
    setRunning(true);
    setLog([]);
    setProgress({ current: 0, total: 0, date: "", venueName: "", status: "start", errors: 0, totalRaces: 0, totalUichi: 0 });
    try {
      await fetchHistoricalRange(startDate, endDate, (p) => {
        setProgress({
          current: p.current,
          total: p.total,
          date: p.date,
          venueName: p.venue.name,
          status: p.status,
          errors: p.errors,
          totalRaces: p.totalRaces,
          totalUichi: p.totalUichi,
        });
        if (p.status === "done") {
          setLog((l) => [...l, { date: p.date, name: p.venue.name, status: p.venueStatus }]);
        }
      });
      await loadSummary();
    } finally {
      setRunning(false);
    }
  };

  const handleRecalc = async () => {
    setRecalcState("loading");
    try {
      await recalcVenueStats();
      setRecalcState("done");
      await loadSummary();
    } catch {
      setRecalcState("error");
    }
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">過去データ取得（期間指定）</h3>
      </div>

      {/* Date range inputs */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-sm text-muted-foreground whitespace-nowrap">対象期間</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          disabled={running}
          className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:border-primary"
        />
        <span className="text-muted-foreground">〜</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          disabled={running}
          className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:border-primary"
        />
        <button
          onClick={run}
          disabled={running || !startDate || !endDate}
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {running ? "取得中…" : "取得開始"}
        </button>
      </div>

      {/* Progress bar */}
      {progress && progress.total > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {running && progress.date ? `${progress.date} ${progress.venueName} 取得中…` : "処理状況"}
            </span>
            <span className="tabular-nums font-semibold">{progress.current}/{progress.total} ({pct}%)</span>
          </div>
          <div className="h-2 rounded-full bg-background overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>保存レース <span className="text-foreground font-semibold tabular-nums">{progress.totalRaces}</span></span>
            <span>ういち的中 <span className="text-emerald-600 font-semibold tabular-nums">{progress.totalUichi}</span></span>
            <span>エラー <span className="text-rose-600 font-semibold tabular-nums">{progress.errors}</span></span>
          </div>
        </div>
      )}

      {/* Range summary */}
      {summary && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryCard label="完了日数" value={`${summary.totalDays}日`} />
            <SummaryCard label="完了競艇場数" value={summary.doneVenues} accent="primary" />
            <SummaryCard label="official保存レース数" value={summary.totalRaces} accent="primary" />
            <SummaryCard label="ういち的中数" value={summary.totalUichi} accent="emerald" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryCard label="全体出現率" value={fmtPct(summary.overallRate, 2)} accent="emerald" />
            <SummaryCard label="開催なし場数" value={summary.noRacesVenues} />
            <SummaryCard label="エラー件数" value={summary.errorCount} accent="rose" />
            <SummaryCard label="最終処理日時" value={summary.lastProcessed ? new Date(summary.lastProcessed).toLocaleString("ja-JP", { hour12: false }) : "—"} small />
          </div>
        </div>
      )}

      {/* Recalc button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleRecalc}
          disabled={recalcState === "loading" || running}
          className="inline-flex items-center gap-1.5 rounded-xl bg-accent border border-border px-3 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50"
        >
          {recalcState === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
          VenueStats再計算
        </button>
        {recalcState === "done" && <span className="text-xs text-emerald-600">再計算完了</span>}
        {recalcState === "error" && <span className="text-xs text-rose-600">再計算エラー</span>}
      </div>

      {/* Venue log */}
      {log.length > 0 && (
        <div className="rounded-xl bg-background/50 border border-border/50 p-3 max-h-48 overflow-y-auto">
          <div className="text-[11px] text-muted-foreground mb-2 tracking-wider">処理ログ（最新順）</div>
          <div className="space-y-1">
            {[...log].reverse().slice(0, 60).map((l, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                {l.status === "success" ? (
                  <CheckCircle className="w-3 h-3 text-emerald-500" />
                ) : l.status === "no_races" ? (
                  <CheckCircle className="w-3 h-3 text-slate-400" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-rose-500" />
                )}
                <span className="tabular-nums text-muted-foreground">{l.date}</span>
                <span className="truncate">{l.name}</span>
                <span className="text-muted-foreground ml-auto">
                  {l.status === "success" ? "OK" : l.status === "no_races" ? "開催なし" : "エラー"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Refresh summary */}
      {!running && (
        <button
          onClick={loadSummary}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="w-3.5 h-3.5" /> サマリー再読込
        </button>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent, small }) {
  const c = {
    primary: "text-primary",
    emerald: "text-emerald-600",
    rose: "text-rose-600",
  };
  return (
    <div className="rounded-xl bg-background/50 px-3 py-2 text-center">
      <div className="text-[10px] text-muted-foreground tracking-wider">{label}</div>
      <div className={cn(small ? "text-xs" : "text-xl font-bold", "tabular-nums mt-0.5", accent && c[accent])}>{value}</div>
    </div>
  );
}
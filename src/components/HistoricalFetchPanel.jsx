import { useState, useEffect, useCallback } from "react";
import { Database, Loader2, Play, CheckCircle, AlertCircle, RefreshCw } from "lucide-react";
import { fetchHistoricalDay, getDaySummary } from "@/lib/boatService";
import { VENUES } from "@/lib/boat";
import { cn } from "@/lib/utils";

const VENUES_JCD = VENUES.map((v, i) => ({ jcd: String(i + 1).padStart(2, "0"), name: v.name }));

export default function HistoricalFetchPanel() {
  const [date, setDate] = useState("2026-07-31");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [log, setLog] = useState([]);

  const loadSummary = useCallback(async () => {
    try {
      const s = await getDaySummary(date);
      setSummary(s);
    } catch {}
  }, [date]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const run = async () => {
    setRunning(true);
    setLog([]);
    setProgress({ current: 0, total: VENUES_JCD.length, venueName: "", status: "start", errors: 0, totalRaces: 0, totalUichi: 0 });
    try {
      await fetchHistoricalDay(date, (p) => {
        setProgress({
          current: p.done,
          total: p.total,
          venueName: p.venue.name,
          status: p.status,
          errors: p.errors,
          totalRaces: p.totalRaces,
          totalUichi: p.totalUichi,
        });
        setLog((l) => [...l, { name: p.venue.name, status: p.status }]);
      });
      await loadSummary();
    } finally {
      setRunning(false);
    }
  };

  const pct = progress ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">過去データ取得（1日分テスト）</h3>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-muted-foreground whitespace-nowrap">対象日</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={running}
          className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:border-primary"
        />
        <button
          onClick={run}
          disabled={running || !date}
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {running ? "取得中…" : "取得開始"}
        </button>
      </div>

      {/* Progress bar */}
      {progress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {running ? `取得中: ${progress.venueName}` : "完了"}
            </span>
            <span className="tabular-nums font-semibold">{progress.current}/{progress.total}場 ({pct}%)</span>
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

      {/* Summary after fetch */}
      {summary && (
        <div className="grid grid-cols-3 gap-2">
          <SummaryCard label="official保存件数" value={summary.officialCount} accent="primary" />
          <SummaryCard label="ういち的中件数" value={summary.uichiHits} accent="emerald" />
          <SummaryCard label="エラー場数" value={summary.errorCount} accent="rose" />
        </div>
      )}

      {/* Venue log */}
      {log.length > 0 && (
        <div className="rounded-xl bg-background/50 border border-border/50 p-3 max-h-48 overflow-y-auto">
          <div className="text-[11px] text-muted-foreground mb-2 tracking-wider">競艇場別結果</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
            {log.map((l, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                {l.status === "loading" ? (
                  <Loader2 className="w-3 h-3 animate-spin text-primary" />
                ) : l.status === "done" ? (
                  <CheckCircle className="w-3 h-3 text-emerald-500" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-rose-500" />
                )}
                <span className="truncate">{l.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Refresh summary */}
      {!running && summary && (
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

function SummaryCard({ label, value, accent }) {
  const c = {
    primary: "text-primary",
    emerald: "text-emerald-600",
    rose: "text-rose-600",
  };
  return (
    <div className="rounded-xl bg-background/50 px-3 py-2 text-center">
      <div className="text-[10px] text-muted-foreground tracking-wider">{label}</div>
      <div className={cn("text-2xl font-bold tabular-nums mt-0.5", c[accent])}>{value}</div>
    </div>
  );
}
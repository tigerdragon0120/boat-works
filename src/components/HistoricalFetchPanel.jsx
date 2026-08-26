import { useState, useEffect, useCallback, useRef } from "react";
import { Database, Loader2, Play, Square, CheckCircle, AlertCircle, RefreshCw, BarChart3, Zap, Clock, Gauge } from "lucide-react";
import {
  fetchHistoricalRange, getRangeSummary, getBoat1DetailStats,
  recalcVenueStats, enrichBoat1DetailsBatch,
} from "@/lib/boatService";
import { fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function HistoricalFetchPanel() {
  const [startDate, setStartDate] = useState("2026-07-25");
  const [endDate, setEndDate] = useState("2026-07-31");
  const [running, setRunning] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [progress, setProgress] = useState(null);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [detailStats, setDetailStats] = useState(null);
  const [log, setLog] = useState([]);
  const [recalcState, setRecalcState] = useState(null);
  const [speed, setSpeed] = useState(null);
  const abortRef = useRef({ aborted: false });
  const enrichAbortRef = useRef({ aborted: false });
  const speedSamplesRef = useRef([]);

  const loadSummary = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        getRangeSummary(startDate, endDate),
        getBoat1DetailStats(startDate, endDate),
      ]);
      setSummary(s);
      setDetailStats(d);
    } catch {}
  }, [startDate, endDate]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const recordSpeedSample = useCallback((totalRaces) => {
    const now = Date.now();
    speedSamplesRef.current.push({ time: now, races: totalRaces });
    speedSamplesRef.current = speedSamplesRef.current.filter(s => now - s.time < 120000);
    if (speedSamplesRef.current.length >= 2) {
      const latest = speedSamplesRef.current[speedSamplesRef.current.length - 1];
      const oldest = speedSamplesRef.current[0];
      const elapsedMin = (latest.time - oldest.time) / 60000;
      if (elapsedMin > 0.05) {
        const racesPerMin = (latest.races - oldest.races) / elapsedMin;
        setSpeed({ racesPerMin: Math.max(0, Math.round(racesPerMin)), hourly: Math.round(racesPerMin * 60) });
      }
    }
  }, []);

  const run = async () => {
    abortRef.current.aborted = false;
    setRunning(true);
    setLog([]);
    setSpeed(null);
    speedSamplesRef.current = [];
    setProgress({ current: 0, total: 0, date: "", venueName: "", status: "start", errors: 0, totalRaces: 0, totalUichi: 0 });
    try {
      await fetchHistoricalRange(startDate, endDate, (p) => {
        setProgress({
          current: p.current, total: p.total, date: p.date, venueName: p.venue?.name || "",
          status: p.status, venueStatus: p.venueStatus, errors: p.errors,
          totalRaces: p.totalRaces, totalUichi: p.totalUichi,
        });
        if (p.totalRaces > 0) recordSpeedSample(p.totalRaces);
        if (p.status === "done" || p.status === "skipped") {
          setLog((l) => [...l, { date: p.date, name: p.venue?.name, status: p.venueStatus || "skipped" }]);
        }
      }, abortRef);
      await loadSummary();
    } finally {
      setRunning(false);
    }
  };

  const stop = () => { abortRef.current.aborted = true; };

  const handleEnrich = async () => {
    enrichAbortRef.current.aborted = false;
    setEnriching(true);
    setEnrichProgress({ current: 0, total: 0, venue: "", date: "", status: "start", enriched: 0, errors: 0 });
    try {
      await enrichBoat1DetailsBatch(startDate, endDate, (p) => {
        setEnrichProgress({
          current: p.current, total: p.total, venue: p.venue || "",
          date: p.date || "", status: p.status,
          enriched: p.enriched, errors: p.errors,
        });
      }, enrichAbortRef);
      await loadSummary();
    } finally {
      setEnriching(false);
    }
  };

  const stopEnrich = () => { enrichAbortRef.current.aborted = true; };

  const handleRecalc = async () => {
    setRecalcState("loading");
    try {
      await recalcVenueStats();
      setRecalcState("done");
      await loadSummary();
    } catch { setRecalcState("error"); }
  };

  const setTestWeek = () => { setStartDate("2026-07-25"); setEndDate("2026-07-31"); };

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const enrichPct = enrichProgress && enrichProgress.total > 0 ? Math.round((enrichProgress.current / enrichProgress.total) * 100) : 0;
  const remainingVenues = progress ? progress.total - progress.current : 0;
  const avgRacesPerVenue = progress && progress.current > 0 ? progress.totalRaces / progress.current : 12;
  const estRemainingMin = speed && speed.racesPerMin > 0 && progress
    ? Math.ceil((remainingVenues * avgRacesPerVenue) / speed.racesPerMin)
    : null;

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">過去データ取得（2段階高速化）</h3>
      </div>

      {/* Date range inputs */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-sm text-muted-foreground whitespace-nowrap">対象期間</label>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={running || enriching}
          className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:border-primary" />
        <span className="text-muted-foreground">〜</span>
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={running || enriching}
          className="px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:border-primary" />
        <button onClick={setTestWeek} disabled={running || enriching}
          className="px-3 py-2 rounded-lg bg-accent border border-border text-xs font-semibold text-accent-foreground disabled:opacity-50">
          1週間テスト
        </button>
        {running ? (
          <button onClick={stop} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-4 py-2 text-sm font-bold text-white">
            <Square className="w-4 h-4" /> 停止
          </button>
        ) : (
          <button onClick={run} disabled={!startDate || !endDate || enriching}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50">
            <Play className="w-4 h-4" /> 第1段階:結果取得
          </button>
        )}
      </div>

      {/* Stage 1 Progress */}
      {progress && progress.total > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {running && progress.date ? `${progress.date} ${progress.venueName} ${progress.status === "loading" ? "取得中…" : "処理中"}` : "処理状況"}
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

      {/* Speed display */}
      {(running || speed) && (
        <div className="rounded-xl bg-accent/40 border border-border/50 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-accent-foreground">
            <Gauge className="w-3.5 h-3.5" /> 速度表示（推定値）
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground">直近1分取得数</div>
              <div className="text-lg font-bold tabular-nums text-primary">{speed?.racesPerMin ?? "—"}<span className="text-xs font-normal text-muted-foreground">/分</span></div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground">1時間換算</div>
              <div className="text-lg font-bold tabular-nums text-primary">{speed?.hourly != null ? speed.hourly.toLocaleString() : "—"}<span className="text-xs font-normal text-muted-foreground">件</span></div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground">推定残り時間</div>
              <div className="text-lg font-bold tabular-nums text-primary">{estRemainingMin != null ? `約${estRemainingMin}分` : "—"}</div>
            </div>
          </div>
        </div>
      )}

      {/* Range summary */}
      {summary && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryCard label="結果取得済み日数" value={`${summary.totalDays}日`} />
            <SummaryCard label="結果取得済み場数" value={summary.doneVenues} accent="primary" />
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

      {/* Stage 2: Detail enrichment */}
      <div className="rounded-xl bg-background/50 border border-border/50 p-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Zap className="w-4 h-4 text-amber-500" />
          <h4 className="text-sm font-bold">第2段階: 1号艇詳細補完</h4>
          {detailStats && (
            <span className="ml-auto text-xs text-muted-foreground">
              補完済み <span className="text-foreground font-semibold tabular-nums">{detailStats.enriched}</span> / {detailStats.total}
              （<span className="text-primary font-semibold">{fmtPct(detailStats.rate, 1)}</span>）
            </span>
          )}
        </div>
        {enrichProgress && enrichProgress.total > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {enriching && enrichProgress.date ? `${enrichProgress.date} ${enrichProgress.venue} 補完中…` : "補完状況"}
              </span>
              <span className="tabular-nums font-semibold">{enrichProgress.current}/{enrichProgress.total}場 ({enrichPct}%)</span>
            </div>
            <div className="h-1.5 rounded-full bg-background overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${enrichPct}%` }} />
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>補完数 <span className="text-foreground font-semibold tabular-nums">{enrichProgress.enriched}</span></span>
              <span>エラー <span className="text-rose-600 font-semibold tabular-nums">{enrichProgress.errors}</span></span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          {enriching ? (
            <button onClick={stopEnrich} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-3 py-2 text-sm font-bold text-white">
              <Square className="w-4 h-4" /> 停止
            </button>
          ) : (
            <button onClick={handleEnrich} disabled={!startDate || !endDate || running}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
              {enriching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              詳細補完開始
            </button>
          )}
          <button onClick={handleRecalc} disabled={recalcState === "loading" || running || enriching}
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent border border-border px-3 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50">
            {recalcState === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
            VenueStats再計算
          </button>
          {recalcState === "done" && <span className="text-xs text-emerald-600">再計算完了</span>}
          {recalcState === "error" && <span className="text-xs text-rose-600">再計算エラー</span>}
        </div>
      </div>

      {/* Venue log */}
      {log.length > 0 && (
        <div className="rounded-xl bg-background/50 border border-border/50 p-3 max-h-64 overflow-y-auto">
          <div className="text-[11px] text-muted-foreground mb-2 tracking-wider">処理ログ（最新順）</div>
          <div className="space-y-1">
            {[...log].reverse().slice(0, 80).map((l, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                {l.status === "success" ? (
                  <CheckCircle className="w-3 h-3 text-emerald-500" />
                ) : l.status === "no_races" ? (
                  <CheckCircle className="w-3 h-3 text-slate-400" />
                ) : l.status === "done" || l.status === "skipped" ? (
                  <CheckCircle className="w-3 h-3 text-sky-500" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-rose-500" />
                )}
                <span className="tabular-nums text-muted-foreground">{l.date}</span>
                <span className="truncate">{l.name}</span>
                <span className="text-muted-foreground ml-auto">
                  {l.status === "success" ? "完了" : l.status === "no_races" ? "開催なし" : l.status === "done" || l.status === "skipped" ? "スキップ(済)" : "エラー"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!running && !enriching && (
        <button onClick={loadSummary} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className="w-3.5 h-3.5" /> サマリー再読込
        </button>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent, small }) {
  const c = { primary: "text-primary", emerald: "text-emerald-600", rose: "text-rose-600" };
  return (
    <div className="rounded-xl bg-background/50 px-3 py-2 text-center">
      <div className="text-[10px] text-muted-foreground tracking-wider">{label}</div>
      <div className={cn(small ? "text-xs" : "text-xl font-bold", "tabular-nums mt-0.5", accent && c[accent])}>{value}</div>
    </div>
  );
}
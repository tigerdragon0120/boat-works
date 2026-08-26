import { useState, useEffect, useCallback, useRef } from "react";
import { Database, Loader2, Play, Square, CheckCircle, AlertCircle, RefreshCw, BarChart3, Zap, Clock, Gauge } from "lucide-react";
import {
  fetchHistoricalRange, getRangeSummary, getBoat1DetailStats,
  recalcVenueStats, enrichBoat1DetailsBatch, getImportHeartbeat,
} from "@/lib/boatService";
import { fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function HistoricalFetchPanel() {
  const [startDate, setStartDate] = useState("2026-02-01");
  const [endDate, setEndDate] = useState("2026-07-31");
  const [running, setRunning] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [progress, setProgress] = useState(null);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [detailStats, setDetailStats] = useState(null);
  const [log, setLog] = useState([]);
  const [recalcState, setRecalcState] = useState(null);
  const [heartbeat, setHeartbeat] = useState(null);
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

  // Heartbeat polling (15s) - DB基準で処理生存確認
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const hb = await getImportHeartbeat();
        if (active) setHeartbeat(hb);
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 15000);
    return () => { active = false; clearInterval(interval); };
  }, [running]);

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
    setProgress({ phase: "start", currentDate: "", completedDays: 0, totalDays: 0, current: 0, total: 0, venueName: "", status: "start", errors: 0, totalRaces: 0, totalUichi: 0, concurrentDays: 2, concurrentVenues: 5, errorPendingCount: 0, currentDates: [], currentVenues: [] });
    try {
      await fetchHistoricalRange(startDate, endDate, (p) => {
        setProgress({
          phase: p.phase, currentDate: p.currentDate, completedDays: p.completedDays, totalDays: p.totalDays,
          current: p.current, total: p.total, venueName: p.venueName || "",
          status: p.status, venueStatus: p.venueStatus, errors: p.errors,
          totalRaces: p.totalRaces, totalUichi: p.totalUichi,
          concurrentDays: p.concurrentDays, concurrentVenues: p.concurrentVenues,
          errorPendingCount: p.errorPendingCount, currentDates: p.currentDates, currentVenues: p.currentVenues,
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
  const setSixMonths = () => { setStartDate("2026-02-01"); setEndDate("2026-07-31"); };

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
        <button onClick={setSixMonths} disabled={running || enriching}
          className="px-3 py-2 rounded-lg bg-primary/10 border border-primary/30 text-xs font-bold text-primary disabled:opacity-50">
          6か月本番
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

      {/* Heartbeat status - DB基準で処理生存判定 */}
      {running && (() => {
        const hbAge = heartbeat ? (Date.now() - new Date(heartbeat).getTime()) / 1000 : null;
        const stale = hbAge !== null && hbAge > 120;
        return (
          <div className={cn("rounded-xl px-3 py-2 flex items-center gap-2 text-xs border", stale ? "bg-rose-50 border-rose-200" : "bg-emerald-50 border-emerald-200")}>
            {stale ? (
              <>
                <AlertCircle className="w-4 h-4 text-rose-500" />
                <span className="font-bold text-rose-600">処理停止の可能性</span>
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 text-emerald-500 animate-pulse" />
                <span className="font-bold text-emerald-600">処理実行中</span>
              </>
            )}
            <span className="text-muted-foreground ml-auto">
              最終heartbeat: {heartbeat ? new Date(heartbeat).toLocaleTimeString("ja-JP") : "—"}
            </span>
          </div>
        );
      })()}

      {/* Stage 1 Progress - 日単位主表示 + V3並列情報 */}
      {progress && (running || progress.totalDays > 0) && progress.totalDays > 0 && (() => {
        const dayPct = progress.totalDays > 0 ? Math.round((progress.completedDays / progress.totalDays) * 100) : 0;
        const venuePct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
        const phaseText = progress.phase === "venue_discovery"
          ? "開催場一覧取得中…"
          : progress.phase === "result_fetch" && progress.status === "loading"
          ? `${progress.venueName} 処理中`
          : progress.phase === "error_retry"
          ? "エラー再取得中…"
          : progress.phase === "day_complete"
          ? "完了"
          : progress.venueName || "処理中";
        return (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground truncate">
                {progress.currentDate ? `${progress.currentDate} ${phaseText}` : "処理状況"}
              </span>
              <span className="tabular-nums font-bold text-primary whitespace-nowrap">{progress.completedDays}/{progress.totalDays}日 ({dayPct}%)</span>
            </div>
            <div className="h-2.5 rounded-full bg-background overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${dayPct}%` }} />
            </div>
            {progress.total > 0 && (
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>開催場進捗</span>
                <span className="tabular-nums">{progress.current}/{progress.total}場 ({venuePct}%)</span>
              </div>
            )}
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>保存レース <span className="text-foreground font-semibold tabular-nums">{progress.totalRaces}</span></span>
              <span>ういち的中 <span className="text-emerald-600 font-semibold tabular-nums">{progress.totalUichi}</span></span>
              <span>エラー <span className="text-rose-600 font-semibold tabular-nums">{progress.errors}</span></span>
            </div>
            {/* V3: 並列・error_pending情報 */}
            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-md bg-primary/10 px-2 py-0.5 text-primary font-semibold">
                {progress.concurrentDays || 2}日 × {progress.concurrentVenues || 5}場 並列
              </span>
              {progress.errorPendingCount > 0 && (
                <span className={cn("rounded-md px-2 py-0.5 font-semibold", progress.phase === "error_retry" ? "bg-amber-200 text-amber-800" : "bg-amber-100 text-amber-700")}>
                  error_pending: {progress.errorPendingCount}場
                </span>
              )}
            </div>
          </div>
        );
      })()}

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
            <SummaryCard label="完了日数 / 対象日数" value={`${summary.completedDays || 0} / ${summary.totalCalendarDays || 0}日`} accent="primary" />
            <SummaryCard label="完了開催場数" value={summary.doneVenues} accent="primary" />
            <SummaryCard label="official保存レース数" value={summary.totalRaces} accent="primary" />
            <SummaryCard label="ういち的中数" value={summary.totalUichi} accent="emerald" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryCard label="ういち出現率" value={fmtPct(summary.overallRate, 2)} accent="emerald" />
            <SummaryCard label="開催なし場数" value={summary.noRacesVenues} />
            <SummaryCard label="エラー件数" value={summary.errorCount} accent="rose" />
            <SummaryCard label="最終処理日時" value={summary.lastProcessed ? new Date(summary.lastProcessed).toLocaleString("ja-JP", { hour12: false }) : "—"} small />
          </div>
          {(running || (progress?.currentDate && progress.totalDays > 0)) && (
            <div className="rounded-xl bg-primary/5 border border-primary/20 px-3 py-2 space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-primary animate-pulse" />
                <span className="text-muted-foreground">処理中:</span>
                <span className="font-bold text-primary tabular-nums">{progress?.currentDate || "—"}</span>
                <span className="text-muted-foreground truncate">{progress?.venueName || "—"}</span>
              </div>
              {progress?.currentDates?.length > 0 && (
                <div className="text-muted-foreground">
                  同時処理日: <span className="text-foreground font-semibold">{progress.currentDates.join(" / ")}</span>
                </div>
              )}
              {progress?.currentVenues?.length > 0 && (
                <div className="text-muted-foreground">
                  同時処理場: <span className="text-foreground font-semibold">{progress.currentVenues.map(v => v.name).join(" / ")}</span>
                </div>
              )}
            </div>
          )}
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
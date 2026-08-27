import { useState, useEffect, useCallback, useRef } from "react";
import { Database, Loader2, Play, Square, CheckCircle, AlertCircle, RefreshCw, BarChart3, Zap, Clock, Gauge } from "lucide-react";
import {
  fetchHistoricalRange, getRangeSummary, getBoat1DetailStats,
  recalcVenueStats, enrichBoat1DetailsBatch, enrichBoat1DetailsErrors, enrichBoat1DetailsPriority,
  getImportHeartbeat, retryErrorFetches,
} from "@/lib/boatService";
import { fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function HistoricalFetchPanel() {
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  })();
  const [startDate, setStartDate] = useState("2026-02-01");
  const [endDate, setEndDate] = useState(yesterday);
  const [running, setRunning] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [progress, setProgress] = useState(null);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [detailStats, setDetailStats] = useState(null);
  const [log, setLog] = useState([]);
  const [recalcState, setRecalcState] = useState(null);
  const [foundationRunning, setFoundationRunning] = useState(false);
  const [foundationStatus, setFoundationStatus] = useState(null);
  const [heartbeat, setHeartbeat] = useState(null);
  const [speed, setSpeed] = useState(null);
  const abortRef = useRef({ aborted: false });
  const enrichAbortRef = useRef({ aborted: false });
  const speedSamplesRef = useRef([]);
  const enrichSpeedRef = useRef([]);
  const [enrichSpeed, setEnrichSpeed] = useState(null);
  const [errorEnriching, setErrorEnriching] = useState(false);
  const [errorEnrichProgress, setErrorEnrichProgress] = useState(null);
  const errorEnrichAbortRef = useRef({ aborted: false });
  const [priorityEnriching, setPriorityEnriching] = useState(false);
  const [priorityProgress, setPriorityProgress] = useState(null);
  const priorityAbortRef = useRef({ aborted: false });

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

  const recordEnrichSpeed = useCallback((enrichedCount) => {
    const now = Date.now();
    enrichSpeedRef.current.push({ time: now, count: enrichedCount });
    enrichSpeedRef.current = enrichSpeedRef.current.filter(s => now - s.time < 180000);
    if (enrichSpeedRef.current.length >= 2) {
      const latest = enrichSpeedRef.current[enrichSpeedRef.current.length - 1];
      const oldest = enrichSpeedRef.current[0];
      const elapsedMin = (latest.time - oldest.time) / 60000;
      if (elapsedMin > 0.05) {
        setEnrichSpeed(Math.max(0, Math.round((latest.count - oldest.count) / elapsedMin)));
      }
    }
  }, []);

  const handleEnrich = async () => {
    enrichAbortRef.current.aborted = false;
    setEnriching(true);
    setEnrichSpeed(null);
    enrichSpeedRef.current = [];
    setEnrichProgress({ current: 0, total: 0, venue: "", date: "", status: "start", enriched: 0, errors: 0, venueConcurrency: 2, raceConcurrency: 3, startTime: Date.now(), pendingCount: 0, httpFetches: 0, cacheCompletes: 0, cacheHitRate: 0 });
    try {
      await enrichBoat1DetailsBatch(startDate, endDate, (p) => {
        setEnrichProgress({
          current: p.current, total: p.total, venue: p.venue || "",
          date: p.date || "", status: p.status,
          enriched: p.enriched, errors: p.errors,
          venueConcurrency: p.venueConcurrency || 2,
          raceConcurrency: p.raceConcurrency || 3,
          startTime: p.startTime || Date.now(),
          pendingCount: p.pendingCount || 0,
          httpFetches: p.httpFetches || 0,
          cacheCompletes: p.cacheCompletes || 0,
          cacheHitRate: p.cacheHitRate || 0,
        });
        if (p.enriched > 0) recordEnrichSpeed(p.enriched);
      }, enrichAbortRef);
      await loadSummary();
    } finally {
      setEnriching(false);
    }
  };

  const stopEnrich = () => { enrichAbortRef.current.aborted = true; };

  const handleEnrichErrors = async () => {
    errorEnrichAbortRef.current.aborted = false;
    setErrorEnriching(true);
    setErrorEnrichProgress({ current: 0, total: 0, venue: "", date: "", status: "start", enriched: 0, errors: 0, httpFetches: 0, cacheCompletes: 0, cacheHitRate: 0 });
    try {
      await enrichBoat1DetailsErrors(startDate, endDate, (p) => {
        setErrorEnrichProgress({
          current: p.current, total: p.total, venue: p.venue || "",
          date: p.date || "", status: p.status,
          enriched: p.enriched, errors: p.errors,
          httpFetches: p.httpFetches || 0,
          cacheCompletes: p.cacheCompletes || 0,
          cacheHitRate: p.cacheHitRate || 0,
        });
      }, errorEnrichAbortRef);
      await loadSummary();
    } finally {
      setErrorEnriching(false);
    }
  };

  const stopEnrichErrors = () => { errorEnrichAbortRef.current.aborted = true; };

  const handlePriorityEnrich = async (priority) => {
    priorityAbortRef.current.aborted = false;
    setPriorityEnriching(true);
    setPriorityProgress({ phase: "start", tier: "", current: 0, total: 0, enriched: 0, errors: 0, pendingCount: 0, httpFetches: 0, cacheCompletes: 0 });
    try {
      await enrichBoat1DetailsPriority(priority, (p) => {
        setPriorityProgress({
          phase: p.phase, tier: p.tier || "", priority: p.priority,
          venue: p.venue || "", date: p.date || "",
          current: p.current || 0, total: p.total || 0,
          enriched: p.enriched || 0, errors: p.errors || 0,
          pendingCount: p.pendingCount || 0,
          httpFetches: p.httpFetches || 0, cacheCompletes: p.cacheCompletes || 0,
          tierEnriched: p.tierEnriched, tierErrors: p.tierErrors,
        });
      }, priorityAbortRef);
      await loadSummary();
    } finally {
      setPriorityEnriching(false);
    }
  };

  const stopPriorityEnrich = () => { priorityAbortRef.current.aborted = true; };

  const handleRecalc = async () => {
    setRecalcState("loading");
    try {
      await recalcVenueStats();
      setRecalcState("done");
      await loadSummary();
    } catch { setRecalcState("error"); }
  };

  const setTestWeek = () => { setStartDate("2026-07-25"); setEndDate("2026-07-31"); };
  const setSixMonths = () => { setStartDate("2026-02-01"); setEndDate(yesterday); };

  const handleCompleteFoundation = async () => {
    if (running || enriching || foundationRunning) return;
    const finalStart = "2026-02-01";
    const finalEnd = yesterday;
    setStartDate(finalStart);
    setEndDate(finalEnd);
    setFoundationRunning(true);
    setFoundationStatus("第1段階：未取得・エラー結果を確認中");
    abortRef.current.aborted = false;
    enrichAbortRef.current.aborted = false;
    try {
      await fetchHistoricalRange(finalStart, finalEnd, () => {}, abortRef);
      setFoundationStatus("残エラーを再取得中");
      await retryErrorFetches(() => {}, abortRef.current);
      setFoundationStatus("第2段階：1号艇詳細を補完中");
      await enrichBoat1DetailsBatch(finalStart, finalEnd, () => {}, enrichAbortRef);
      setFoundationStatus("VenueStatsを再計算中");
      await recalcVenueStats();
      setFoundationStatus("最終チェック中");
      const [s, d] = await Promise.all([
        getRangeSummary(finalStart, finalEnd),
        getBoat1DetailStats(finalStart, finalEnd),
      ]);
      setSummary(s);
      setDetailStats(d);
      const ok = s.errorCount === 0 && d.errorCount === 0 && d.pending === 0;
      setFoundationStatus(ok ? "過去データ基盤 完成" : `要確認：結果エラー${s.errorCount}件 / 詳細未完了${d.pending}件 / 詳細エラー${d.errorCount}件`);
    } catch (e) {
      setFoundationStatus(`基盤完成処理でエラー：${e?.message || "unknown"}`);
    } finally {
      setFoundationRunning(false);
    }
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const enrichPct = enrichProgress && enrichProgress.total > 0 ? Math.round((enrichProgress.current / enrichProgress.total) * 100) : 0;
  const enrichETA = enrichSpeed && enrichSpeed > 0 && enrichProgress?.pendingCount > 0
    ? Math.ceil((enrichProgress.pendingCount * 12) / enrichSpeed) : null;
  const errorEnrichPct = errorEnrichProgress && errorEnrichProgress.total > 0 ? Math.round((errorEnrichProgress.current / errorEnrichProgress.total) * 100) : 0;
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
          <button onClick={run} disabled={!startDate || !endDate || enriching || foundationRunning}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50">
            <Play className="w-4 h-4" /> 第1段階:結果取得
          </button>
        )}
        <button onClick={handleCompleteFoundation} disabled={running || enriching || foundationRunning}
          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          {foundationRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          過去データ基盤完成
        </button>
      </div>

      {foundationStatus && (
        <div className={cn("rounded-xl border px-3 py-2 text-sm font-semibold",
          foundationStatus === "過去データ基盤 完成"
            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
            : foundationStatus.startsWith("要確認") || foundationStatus.includes("エラー")
              ? "bg-amber-50 border-amber-200 text-amber-700"
              : "bg-sky-50 border-sky-200 text-sky-700"
        )}>
          {foundationStatus}
        </div>
      )}

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

      {/* Priority-based backfill buttons */}
      <div className="rounded-xl bg-emerald-50/50 border border-emerald-200 p-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Zap className="w-4 h-4 text-emerald-600" />
          <h4 className="text-sm font-bold text-emerald-800">段階バックフィル（実用開始優先）</h4>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {priorityEnriching ? (
            <button onClick={stopPriorityEnrich} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-4 py-2 text-sm font-bold text-white">
              <Square className="w-4 h-4" /> 停止
            </button>
          ) : (
            <>
              <button
                onClick={() => handlePriorityEnrich(1)}
                disabled={enriching || errorEnriching || foundationRunning}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                {priorityEnriching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                直近30日を最優先完成
              </button>
              <button
                onClick={() => handlePriorityEnrich("all")}
                disabled={enriching || errorEnriching || foundationRunning}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50"
              >
                {priorityEnriching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                バックフィル開始（全期間）
              </button>
            </>
          )}
        </div>

        {/* Priority progress */}
        {priorityProgress && priorityProgress.phase !== "start" && (
          <div className="space-y-2">
            {priorityProgress.tier && (
              <div className="flex items-center gap-2 text-xs">
                <span className={cn(
                  "rounded-md px-2 py-0.5 font-bold",
                  priorityProgress.priority === 1 ? "bg-emerald-200 text-emerald-800" :
                  priorityProgress.priority === 2 ? "bg-sky-200 text-sky-800" :
                  "bg-slate-200 text-slate-700"
                )}>
                  {priorityProgress.tier}
                </span>
                {priorityProgress.phase === "loading" && (
                  <span className="text-muted-foreground">{priorityProgress.date} {priorityProgress.venue} 補完中…</span>
                )}
                {priorityProgress.phase === "tier_complete" && (
                  <span className="text-emerald-600 font-semibold">
                    {priorityProgress.tier}完了: +{priorityProgress.tierEnriched}件
                  </span>
                )}
              </div>
            )}
            {priorityProgress.total > 0 && (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{priorityProgress.tier || ""} 進捗</span>
                  <span className="tabular-nums font-semibold">{priorityProgress.current}/{priorityProgress.total}場</span>
                </div>
                <div className="h-1.5 rounded-full bg-background overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full transition-all" style={{
                    width: `${priorityProgress.total > 0 ? Math.round((priorityProgress.current / priorityProgress.total) * 100) : 0}%`
                  }} />
                </div>
              </>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>補完数 <span className="text-foreground font-semibold tabular-nums">{priorityProgress.enriched}</span></span>
              <span>エラー <span className="text-rose-600 font-semibold tabular-nums">{priorityProgress.errors}</span></span>
              {priorityProgress.httpFetches > 0 && (
                <span>HTTP <span className="text-amber-600 font-semibold tabular-nums">{priorityProgress.httpFetches}</span></span>
              )}
              {priorityProgress.cacheCompletes > 0 && (
                <span>キャッシュ <span className="text-emerald-600 font-semibold tabular-nums">{priorityProgress.cacheCompletes}</span></span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Stage 2: Detail enrichment */}
      <div className="rounded-xl bg-background/50 border border-border/50 p-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Zap className="w-4 h-4 text-amber-500" />
          <h4 className="text-sm font-bold">第2段階: 1号艇詳細補完（期間指定）</h4>
          {detailStats && (
            <span className="ml-auto text-xs text-muted-foreground">
              補完済み <span className="text-foreground font-semibold tabular-nums">{detailStats.enriched}</span> / {detailStats.total}
              （<span className="text-primary font-semibold">{fmtPct(detailStats.rate, 1)}</span>）
            </span>
          )}
        </div>

        {/* RaceResult-level stats grid */}
        {detailStats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <DetailStat label="総対象RaceResult" value={detailStats.total} />
            <DetailStat label="補完済み" value={detailStats.enriched} accent="emerald" />
            <DetailStat label="pending" value={detailStats.pending} accent="amber" />
            <DetailStat label="error" value={detailStats.errorCount} accent="rose" />
          </div>
        )}

        {/* Enrichment progress */}
        {enrichProgress && enrichProgress.total > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground truncate">
                {enriching && enrichProgress.date ? `${enrichProgress.date} ${enrichProgress.venue} 補完中…` : "補完状況"}
              </span>
              <span className="tabular-nums font-semibold whitespace-nowrap">{enrichProgress.current}/{enrichProgress.total}場 ({enrichPct}%)</span>
            </div>
            <div className="h-1.5 rounded-full bg-background overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${enrichPct}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>補完数 <span className="text-foreground font-semibold tabular-nums">{enrichProgress.enriched}</span></span>
              <span>エラー <span className="text-rose-600 font-semibold tabular-nums">{enrichProgress.errors}</span></span>
              <span>並列 <span className="text-primary font-semibold tabular-nums">{enrichProgress.venueConcurrency || 2}場×{enrichProgress.raceConcurrency || 3}R</span></span>
              {enrichSpeed != null && <span>速度 <span className="text-primary font-semibold tabular-nums">{enrichSpeed}</span>件/分</span>}
              {enrichETA != null && <span>推定残り <span className="text-primary font-semibold">約{enrichETA}分</span></span>}
            </div>
            {/* HTTP access stats */}
            {(enrichProgress.httpFetches > 0 || enrichProgress.cacheCompletes > 0) && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                <DetailStat label="HTTP取得回数" value={enrichProgress.httpFetches} accent="amber" />
                <DetailStat label="キャッシュ補完件数" value={enrichProgress.cacheCompletes} accent="emerald" />
                <DetailStat label="HTTP回避件数" value={enrichProgress.cacheCompletes} accent="primary" />
                <DetailStat label="キャッシュヒット率" value={`${enrichProgress.cacheHitRate || 0}%`} accent="emerald" />
              </div>
            )}
          </div>
        )}

        {/* Error retry progress */}
        {errorEnrichProgress && errorEnrichProgress.total > 0 && (
          <div className="space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground truncate">
                {errorEnriching && errorEnrichProgress.date ? `${errorEnrichProgress.date} ${errorEnrichProgress.venue} エラー再取得中…` : "エラー再取得状況"}
              </span>
              <span className="tabular-nums font-semibold whitespace-nowrap">{errorEnrichProgress.current}/{errorEnrichProgress.total}場 ({errorEnrichPct}%)</span>
            </div>
            <div className="h-1.5 rounded-full bg-background overflow-hidden">
              <div className="h-full bg-rose-500 rounded-full transition-all" style={{ width: `${errorEnrichPct}%` }} />
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>成功 <span className="text-emerald-600 font-semibold tabular-nums">{errorEnrichProgress.enriched}</span></span>
              <span>再失敗 <span className="text-rose-600 font-semibold tabular-nums">{errorEnrichProgress.errors}</span></span>
              <span>HTTP <span className="text-amber-600 font-semibold tabular-nums">{errorEnrichProgress.httpFetches || 0}</span></span>
              <span>キャッシュ <span className="text-emerald-600 font-semibold tabular-nums">{errorEnrichProgress.cacheCompletes || 0}</span></span>
              <span>ヒット率 <span className="text-emerald-600 font-semibold tabular-nums">{errorEnrichProgress.cacheHitRate || 0}%</span></span>
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {enriching ? (
            <button onClick={stopEnrich} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-3 py-2 text-sm font-bold text-white">
              <Square className="w-4 h-4" /> 停止
            </button>
          ) : (
            <button onClick={handleEnrich} disabled={!startDate || !endDate || running || errorEnriching}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
              {enriching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              詳細補完開始
            </button>
          )}
          {errorEnriching ? (
            <button onClick={stopEnrichErrors} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-3 py-2 text-sm font-bold text-white">
              <Square className="w-4 h-4" /> 停止
            </button>
          ) : (
            <button onClick={handleEnrichErrors} disabled={!startDate || !endDate || running || enriching || !detailStats || detailStats.errorCount === 0}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
              {errorEnriching ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertCircle className="w-4 h-4" />}
              詳細エラー再取得
            </button>
          )}
          <button onClick={handleRecalc} disabled={recalcState === "loading" || running || enriching || errorEnriching}
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

function DetailStat({ label, value, accent }) {
  const c = { emerald: "text-emerald-600", amber: "text-amber-600", rose: "text-rose-600" };
  return (
    <div className="rounded-lg bg-background px-2.5 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground tracking-wider">{label}</div>
      <div className={cn("text-base font-bold tabular-nums", accent && c[accent])}>{value ?? "—"}</div>
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
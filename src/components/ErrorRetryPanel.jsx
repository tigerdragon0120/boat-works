import { useState, useEffect, useRef, useCallback } from "react";
import { AlertCircle, Play, Square, RefreshCw, Shield } from "lucide-react";
import { retryErrorFetches, retryErrorFetchesFinal, getErrorFetchCount } from "@/lib/boatService";
import { cn } from "@/lib/utils";

export default function ErrorRetryPanel() {
  const [errorCount, setErrorCount] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const abortRef = useRef({ aborted: false });
  const finalAbortRef = useRef({ aborted: false });
  const [finalRunning, setFinalRunning] = useState(false);
  const [finalProgress, setFinalProgress] = useState(null);

  const loadCount = useCallback(async () => {
    try {
      const c = await getErrorFetchCount();
      setErrorCount(c);
    } catch {}
  }, []);

  useEffect(() => { loadCount(); }, [loadCount]);

  const run = async () => {
    abortRef.current.aborted = false;
    setRunning(true);
    setProgress({ total: errorCount || 0, processed: 0, success: 0, failed: 0, currentDate: "", currentVenues: "", remaining: errorCount || 0, status: "start" });
    try {
      await retryErrorFetches((p) => {
        setProgress({ ...p });
      }, abortRef);
      await loadCount();
    } finally {
      setRunning(false);
    }
  };

  const stop = () => { abortRef.current.aborted = true; };

  const runFinal = async () => {
    finalAbortRef.current.aborted = false;
    setFinalRunning(true);
    setFinalProgress({ total: errorCount || 0, processed: 0, success: 0, failed: 0, currentDate: "", currentVenue: "", currentAttempt: 0, maxAttempts: 3, remaining: errorCount || 0, status: "start" });
    try {
      await retryErrorFetchesFinal((p) => {
        setFinalProgress({ ...p });
      }, finalAbortRef);
      await loadCount();
    } finally {
      setFinalRunning(false);
    }
  };

  const stopFinal = () => { finalAbortRef.current.aborted = true; };

  const pct = progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-rose-500" />
        <h3 className="text-sm font-bold">エラー場再取得</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          対象: <span className="text-rose-600 font-bold tabular-nums">{errorCount ?? "—"}</span>件
        </span>
      </div>

      <div className="text-xs text-muted-foreground leading-relaxed">
        FetchProgressの <span className="font-semibold text-foreground">result_fetch_status = "error"</span> のみ再取得。
        1日ずつ処理・最大3場並列・タイムアウト20秒・最大2回リトライ（3-5秒待機）。
      </div>

      {/* Progress */}
      {progress && (running || progress.processed > 0) && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Stat label="再取得対象" value={progress.total} />
            <Stat label="処理済み" value={progress.processed} accent="primary" />
            <Stat label="成功" value={progress.success} accent="emerald" />
            <Stat label="再失敗" value={progress.failed} accent="rose" />
            <Stat label="残り" value={progress.remaining} />
            <Stat label="進捗" value={`${pct}%`} accent="primary" />
          </div>
          <div className="h-2.5 rounded-full bg-background overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          {progress.currentDate && (
            <div className="rounded-xl bg-primary/5 border border-primary/20 px-3 py-2 space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">処理中日付:</span>
                <span className="font-bold text-primary tabular-nums">{progress.currentDate}</span>
              </div>
              {progress.currentVenues && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">処理中場:</span>
                  <span className="font-semibold">{progress.currentVenues}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Button */}
      <div className="flex items-center gap-2">
        {running ? (
          <button onClick={stop} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-4 py-2 text-sm font-bold text-white">
            <Square className="w-4 h-4" /> 停止
          </button>
        ) : (
          <button onClick={run} disabled={!errorCount || errorCount === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50">
            <Play className="w-4 h-4" /> エラー再取得開始
          </button>
        )}
        {!running && (
          <button onClick={loadCount} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <RefreshCw className="w-3.5 h-3.5" /> 件数再確認
          </button>
        )}
      </div>

      {/* 最終回収モード */}
      <div className="border-t border-border pt-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Shield className="w-4 h-4 text-amber-600" />
          <h4 className="text-sm font-bold">最終回収モード</h4>
          <span className="text-[11px] text-muted-foreground">完全直列・30秒タイムアウト・最大3回リトライ（5s/8s待機）</span>
        </div>

        {finalProgress && (finalRunning || finalProgress.processed > 0) && (() => {
          const fPct = finalProgress.total > 0 ? Math.round((finalProgress.processed / finalProgress.total) * 100) : 0;
          return (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Stat label="開始時エラー件数" value={finalProgress.total} />
                <Stat label="処理済み" value={finalProgress.processed} accent="primary" />
                <Stat label="成功" value={finalProgress.success} accent="emerald" />
                <Stat label="失敗" value={finalProgress.failed} accent="rose" />
                <Stat label="残り" value={finalProgress.remaining} />
                <Stat label="進捗" value={`${fPct}%`} accent="primary" />
              </div>
              <div className="h-2.5 rounded-full bg-background overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${fPct}%` }} />
              </div>
              {finalProgress.currentDate && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">日付:</span>
                    <span className="font-bold tabular-nums">{finalProgress.currentDate}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">場:</span>
                    <span className="font-semibold">{finalProgress.currentVenue}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">試行回数:</span>
                    <span className="font-bold text-amber-600 tabular-nums">{finalProgress.currentAttempt}/{finalProgress.maxAttempts}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        <div className="flex items-center gap-2">
          {finalRunning ? (
            <button onClick={stopFinal} className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500 px-4 py-2 text-sm font-bold text-white">
              <Square className="w-4 h-4" /> 停止
            </button>
          ) : (
            <button onClick={runFinal} disabled={!errorCount || errorCount === 0 || running}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              <Play className="w-4 h-4" /> 最終回収モード開始
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  const c = { primary: "text-primary", emerald: "text-emerald-600", rose: "text-rose-600" };
  return (
    <div className="rounded-xl bg-background/50 px-3 py-2 text-center">
      <div className="text-[10px] text-muted-foreground tracking-wider">{label}</div>
      <div className={cn("text-xl font-bold tabular-nums mt-0.5", accent && c[accent])}>{value}</div>
    </div>
  );
}
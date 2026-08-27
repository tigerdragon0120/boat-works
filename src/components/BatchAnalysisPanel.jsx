import { useEffect, useState, useRef } from "react";
import { Loader2, Play, RefreshCw, Trophy, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { analyzeAllRacesForDate, getBatchAnalysisHistory } from "@/lib/analysisCache";
import { cn } from "@/lib/utils";

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function BatchAnalysisPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const abortRef = useRef({ aborted: false });

  useEffect(() => {
    loadHistory();
    return () => { abortRef.current.aborted = true; };
  }, []);

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const h = await getBatchAnalysisHistory(7);
      setHistory(h);
    } catch {}
    setLoadingHistory(false);
  };

  const runBatch = async (stage = "pre", force = false) => {
    if (running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    abortRef.current = { aborted: false };
    try {
      const targetDate = dateStr(1); // 翌日
      const res = await analyzeAllRacesForDate(targetDate, { stage, force });
      if (abortRef.current.aborted) return;
      setResult(res);
      await loadHistory();
    } catch (e) {
      if (!abortRef.current.aborted) setError(e?.message || "実行失敗");
    }
    setRunning(false);
  };

  const fmtElapsed = (ms) => {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}分${sec}秒`;
  };

  return (
    <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Trophy className="w-4 h-4 text-amber-500" />
        <h3 className="text-sm font-bold">翌日一括事前分析</h3>
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>前夜に翌日の全場・全レースを一括分析し、UichiAnalysis・Alertを保存します。</p>
        <p>Home / Alerts は保存済み結果を即表示します（再分析なし）。</p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => runBatch("pre", false)}
          disabled={running}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-60"
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? "実行中…" : "翌日一括分析"}
        </button>
        <button
          onClick={() => runBatch("pre", true)}
          disabled={running}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-100 border border-amber-300 px-3 py-2 text-xs font-bold text-amber-700 disabled:opacity-60"
        >
          <RefreshCw className="w-3.5 h-3.5" /> 強制再分析
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {result && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-300 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-bold text-emerald-700">
            <CheckCircle2 className="w-4 h-4" /> 分析完了 ({result.stage})
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <Stat label="対象" value={`${result.total}R`} />
            <Stat label="分析済" value={`${result.analyzed}R`} accent="emerald" />
            <Stat label="キャッシュ" value={`${result.skipped}R`} />
            <Stat label="Alert候補" value={`${result.alert_candidates}R`} accent="amber" />
            <Stat label="エラー" value={`${result.errors}`} accent={result.errors > 0 ? "rose" : "muted"} />
            <Stat label="処理時間" value={fmtElapsed(result.elapsed_ms)} />
          </div>
          <div className="text-[10px] text-muted-foreground text-center">
            履歴 {result.history_size}件 (詳細補完済 {result.history_done}) / v{result.analysis_version}
          </div>
        </div>
      )}

      {/* 日次処理履歴 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Clock className="w-3.5 h-3.5 text-muted-foreground" />
          <h4 className="text-xs font-bold text-muted-foreground tracking-wider">日次処理履歴（7日分）</h4>
        </div>
        {loadingHistory ? (
          <div className="text-xs text-muted-foreground">読み込み中…</div>
        ) : history.length === 0 ? (
          <div className="text-xs text-muted-foreground">履歴なし</div>
        ) : (
          <div className="space-y-1.5">
            {history.map((h) => (
              <div key={h.race_date} className="flex items-center justify-between rounded-lg bg-background/50 px-3 py-2 text-xs">
                <span className="font-semibold tabular-nums">{h.race_date}</span>
                <div className="flex items-center gap-3 text-muted-foreground tabular-nums">
                  <span>前日分析 <span className="text-foreground font-semibold">{h.pre_count}R</span></span>
                  <span>候補 <span className="text-amber-600 font-semibold">{h.pre_candidates}R</span></span>
                  <span>直前BUY <span className="text-emerald-600 font-semibold">{h.final_buys}R</span></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent = "muted" }) {
  const colors = {
    emerald: "text-emerald-600",
    amber: "text-amber-600",
    rose: "text-rose-600",
    muted: "text-foreground",
  };
  return (
    <div className="rounded-lg bg-background/50 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("font-bold tabular-nums", colors[accent])}>{value}</div>
    </div>
  );
}
import { useEffect, useState, useCallback } from "react";
import { History, Play, Pause, RotateCcw, RefreshCw, AlertTriangle, CheckCircle2, Database, Users, Calendar } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";

export default function HistoricalBackfill() {
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await base44.functions.invoke('controlHistoricalBackfill', { action: 'status' });
      setProgress(res.data?.progress || null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function handleAction(action, extra = {}) {
    setActing(true);
    setError("");
    try {
      const res = await base44.functions.invoke('controlHistoricalBackfill', { action, ...extra });
      if (res.data?.progress) setProgress(res.data.progress);
      else await load();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "操作に失敗しました");
    } finally {
      setActing(false);
    }
  }

  async function handleTestDate(raceDate, venueCode) {
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      const res = await base44.functions.invoke('runHistoricalRaceBackfill', { race_date: raceDate, venue_code: venueCode });
      setTestResult(res.data);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "テスト実行に失敗しました");
    } finally {
      setTesting(false);
    }
  }

  const status = progress?.status || 'IDLE';
  const progressPct = progress?.total_target_days > 0
    ? Math.min(100, Math.round(((progress?.completed_dates || 0) / progress.total_target_days) * 100))
    : 0;

  const statusColor = {
    IDLE: 'bg-slate-100 text-slate-600',
    RUNNING: 'bg-blue-100 text-blue-700',
    PAUSED: 'bg-amber-100 text-amber-700',
    ERROR: 'bg-rose-100 text-rose-700',
    COMPLETED: 'bg-emerald-100 text-emerald-700',
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <History className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-xl font-bold">過去レース結果バックフィル</h1>
          <p className="text-xs text-muted-foreground">2002年〜現在の個別レース結果を蓄積するマスターDB基盤</p>
        </div>
        <button onClick={load} className="ml-auto p-2 rounded-xl border border-border bg-card">
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
        </button>
      </div>

      {error && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-sm text-rose-600 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* ステータスカード */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className={cn("px-3 py-1 rounded-full text-xs font-bold", statusColor[status])}>
              {status}
            </span>
            <span className="text-sm text-muted-foreground">
              {progress?.current_batch_label || '—'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            最終実行: {progress?.last_run_at ? new Date(progress.last_run_at).toLocaleString('ja-JP') : '—'}
          </div>
        </div>

        {/* 進捗バー */}
        <div className="mb-4">
          <div className="flex justify-between text-xs mb-1.5">
            <span className="font-medium">推定進捗率</span>
            <span className="tabular-nums font-bold">{progressPct}%</span>
          </div>
          <div className="h-3 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>{progress?.completed_dates || 0} / {progress?.total_target_days || 0} 日完了</span>
            <span>{progress?.current_processing_date || '—'} → {progress?.target_end_date || '—'}</span>
          </div>
        </div>

        {/* 統計グリッド */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={Database} label="処理済レース数" value={progress?.processed_race_count || 0} color="text-blue-600" />
          <StatCard icon={Users} label="保存済選手結果" value={progress?.processed_racer_result_count || 0} color="text-purple-600" />
          <StatCard icon={CheckCircle2} label="成功" value={progress?.success_count || 0} color="text-emerald-600" />
          <StatCard icon={AlertTriangle} label="失敗" value={progress?.failure_count || 0} color="text-rose-600" />
        </div>

        {progress?.last_error && (
          <div className="mt-3 rounded-xl bg-rose-50/70 px-3 py-2 text-xs text-rose-700">
            <b>最終エラー:</b> {progress.last_error}
          </div>
        )}
      </div>

      {/* 操作ボタン */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="font-bold text-sm mb-3">操作</h2>
        <div className="flex flex-wrap gap-2">
          {status === 'IDLE' && (
            <button
              onClick={() => handleAction('start')}
              disabled={acting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-50"
            >
              <Play className="w-4 h-4" /> 開始
            </button>
          )}
          {status === 'RUNNING' && (
            <button
              onClick={() => handleAction('pause')}
              disabled={acting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 text-white text-sm font-semibold disabled:opacity-50"
            >
              <Pause className="w-4 h-4" /> 一時停止
            </button>
          )}
          {status === 'PAUSED' && (
            <button
              onClick={() => handleAction('resume')}
              disabled={acting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-50"
            >
              <Play className="w-4 h-4" /> 再開
            </button>
          )}
          {status === 'ERROR' && (
            <button
              onClick={() => handleAction('retry_errors')}
              disabled={acting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-50"
            >
              <RotateCcw className="w-4 h-4" /> エラー再試行
            </button>
          )}
          <button
            onClick={() => handleAction('retry_errors')}
            disabled={acting || status === 'IDLE'}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border text-sm font-semibold disabled:opacity-50"
          >
            <RotateCcw className="w-4 h-4" /> エラークリア
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          「全削除して最初からやり直す」操作は意図的に用意していません。保存済みデータは保持されます。
        </p>
      </div>

      {/* テスト実行 */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="font-bold text-sm mb-3">手動テスト実行</h2>
        <p className="text-xs text-muted-foreground mb-3">
          特定の日付・開催場を指定して1件だけ処理します。本格バックフィル開始前にデータ検証に使用します。
        </p>
        <TestForm onTest={handleTestDate} testing={testing} />
        {testResult && (
          <div className="mt-3 rounded-xl bg-muted/50 p-3 text-xs space-y-1">
            <div className="font-bold">{testResult.status === 'success' ? '✓ 成功' : '△ 部分成功'}</div>
            <div>レース数: {testResult.races_saved || 0}</div>
            <div>選手結果数: {testResult.racer_results_saved || 0}</div>
            <div>スキップ: {testResult.skipped || 0}</div>
            {testResult.errors?.length > 0 && (
              <div className="text-rose-600">エラー: {testResult.errors.length}件</div>
            )}
            <div className="text-muted-foreground">処理時間: {testResult.elapsed_ms}ms</div>
          </div>
        )}
      </div>

      {/* エラー履歴 */}
      {progress?.error_dates?.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold text-sm mb-3">エラー履歴 (直近{Math.min(10, progress.error_dates.length)}件)</h2>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {progress.error_dates.slice(-10).reverse().map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-xs border-b border-border/50 pb-1.5">
                <span className="font-mono">{e.date}_{e.venue_code}</span>
                <span className="text-muted-foreground truncate">{e.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[11px] text-muted-foreground text-center">
        15秒ごとに自動更新 · 既存当日処理とは完全分離 · 低優先度バックグラウンド処理
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Icon className={cn("w-3 h-3", color)} />
        {label}
      </div>
      <div className={cn("text-lg font-bold mt-1 tabular-nums", color)}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function TestForm({ onTest, testing }) {
  const [date, setDate] = useState("2024-08-01");
  const [venue, setVenue] = useState("01");

  const venues = [
    ["01","桐生"],["02","戸田"],["03","江戸川"],["04","平和島"],["05","多摩川"],
    ["06","浜名湖"],["07","蒲郡"],["08","常滑"],["09","津"],["10","三国"],
    ["11","びわこ"],["12","住之江"],["13","尼崎"],["14","鳴門"],["15","丸亀"],
    ["16","児島"],["17","宮島"],["18","徳山"],["19","下関"],["20","若松"],
    ["21","芦屋"],["22","福岡"],["23","唐津"],["24","大村"],
  ];

  return (
    <div className="flex flex-wrap gap-2 items-end">
      <div>
        <label className="text-[10px] text-muted-foreground block mb-1">日付</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-2 rounded-xl border border-input bg-background text-sm"
        />
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground block mb-1">開催場</label>
        <select
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          className="px-3 py-2 rounded-xl border border-input bg-background text-sm"
        >
          {venues.map(([code, name]) => (
            <option key={code} value={code}>{code} {name}</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => onTest(date, venue)}
        disabled={testing}
        className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5"
      >
        {testing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        テスト実行
      </button>
    </div>
  );
}
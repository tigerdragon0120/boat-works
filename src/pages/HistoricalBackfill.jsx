import { useEffect, useState, useCallback } from "react";
import { History, Play, Pause, Square, RotateCcw, RefreshCw, AlertTriangle, CheckCircle2, Database, Users, Calendar, Eye, Shield, Zap, Clock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";

export default function HistoricalBackfill() {
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [errorsDetail, setErrorsDetail] = useState(null);
  const [preflight, setPreflight] = useState(null);

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
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function handleAction(action, extra = {}) {
    setActing(true);
    setError("");
    try {
      const res = await base44.functions.invoke('controlHistoricalBackfill', { action, ...extra });
      if (res.data?.progress) setProgress(res.data.progress);
      if (res.data?.pre_flight) setPreflight(res.data.pre_flight);
      if (action === 'start' && !res.data?.pre_flight?.passed) {
        setError(`プレフライトチェック失敗: ${res.data?.failed_checks?.map(c => c.check).join(', ') || ''}`);
      }
      await load();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "操作に失敗しました");
    } finally {
      setActing(false);
    }
  }

  async function handleViewErrors() {
    setShowErrors(true);
    try {
      const res = await base44.functions.invoke('controlHistoricalBackfill', { action: 'view_errors' });
      setErrorsDetail(res.data);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "エラー取得に失敗しました");
    }
  }

  async function handlePreflight() {
    setActing(true);
    try {
      const res = await base44.functions.invoke('controlHistoricalBackfill', { action: 'preflight' });
      setPreflight(res.data?.pre_flight);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "チェックに失敗しました");
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

  const currentVenueName = (() => {
    const venues = [
      ["01","桐生"],["02","戸田"],["03","江戸川"],["04","平和島"],["05","多摩川"],
      ["06","浜名湖"],["07","蒲郡"],["08","常滑"],["09","津"],["10","三国"],
      ["11","びわこ"],["12","住之江"],["13","尼崎"],["14","鳴門"],["15","丸亀"],
      ["16","児島"],["17","宮島"],["18","徳山"],["19","下関"],["20","若松"],
      ["21","芦屋"],["22","福岡"],["23","唐津"],["24","大村"],
    ];
    const idx = progress?.current_venue_index || 0;
    return venues[idx]?.[1] || '—';
  })();

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
          <div className="text-xs text-muted-foreground text-right">
            <div>最終実行: {progress?.last_run_at ? new Date(progress.last_run_at).toLocaleString('ja-JP') : '—'}</div>
            <div>最終成功日: {progress?.last_completed_date || '—'}</div>
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

        {/* 対象期間・現在位置 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-xs">
          <InfoTile icon={Calendar} label="対象開始日" value={progress?.target_start_date || '—'} />
          <InfoTile icon={Calendar} label="対象終了日" value={progress?.target_end_date || '—'} />
          <InfoTile icon={Calendar} label="現在処理日" value={progress?.current_processing_date || '—'} />
          <InfoTile icon={Zap} label="現在の場" value={`${progress?.current_venue_index || 0}/24 ${currentVenueName}`} />
        </div>

        {/* 統計グリッド */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={Database} label="処理済レース数" value={progress?.processed_race_count || 0} color="text-blue-600" />
          <StatCard icon={Users} label="保存済選手結果" value={progress?.processed_racer_result_count || 0} color="text-purple-600" />
          <StatCard icon={CheckCircle2} label="成功数" value={progress?.success_count || 0} color="text-emerald-600" />
          <StatCard icon={AlertTriangle} label="失敗数" value={progress?.failure_count || 0} color="text-rose-600" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <StatCard icon={Eye} label="スキップ数" value={progress?.skip_count || 0} color="text-slate-600" />
          <StatCard icon={AlertTriangle} label="エラー対象数" value={progress?.error_dates?.length || 0} color="text-amber-600" />
          <StatCard icon={Clock} label="完了日数" value={progress?.completed_dates || 0} color="text-cyan-600" />
          <StatCard icon={Calendar} label="全対象日数" value={progress?.total_target_days || 0} color="text-indigo-600" />
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
          {(status === 'IDLE' || status === 'PAUSED' || status === 'ERROR') && (
            <button
              onClick={() => handleAction(status === 'PAUSED' ? 'resume' : 'start')}
              disabled={acting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-50"
            >
              <Play className="w-4 h-4" /> {status === 'PAUSED' ? '再開' : '開始'}
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
          {status !== 'IDLE' && (
            <button
              onClick={() => handleAction('stop')}
              disabled={acting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-600 text-white text-sm font-semibold disabled:opacity-50"
            >
              <Square className="w-4 h-4" /> 停止
            </button>
          )}
          <button
            onClick={() => handleAction('retry_errors')}
            disabled={acting || status === 'IDLE' || (progress?.error_dates || []).length === 0}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border text-sm font-semibold disabled:opacity-50"
          >
            <RotateCcw className="w-4 h-4" /> エラー再試行
          </button>
          <button
            onClick={handleViewErrors}
            disabled={(progress?.error_dates || []).length === 0}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border text-sm font-semibold disabled:opacity-50"
          >
            <Eye className="w-4 h-4" /> エラー確認
          </button>
          <button
            onClick={handlePreflight}
            disabled={acting}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-border text-sm font-semibold disabled:opacity-50"
          >
            <Shield className="w-4 h-4" /> プレフライト
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          「全削除して最初からやり直す」操作は意図的に用意していません。保存済みデータは保持されます。
        </p>
      </div>

      {/* プレフライト結果 */}
      {preflight && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Shield className={cn("w-4 h-4", preflight.passed ? "text-emerald-600" : "text-rose-600")} />
            <h2 className="font-bold text-sm">プレフライトチェック</h2>
            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold", preflight.passed ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>
              {preflight.passed ? 'ALL PASSED' : 'FAILED'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {preflight.checks?.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {c.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />}
                <span className={c.passed ? "" : "text-rose-600"}>{c.check}</span>
                {!c.passed && c.error && <span className="text-muted-foreground">({c.error})</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* エラー詳細モーダル */}
      {showErrors && errorsDetail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowErrors(false)}>
          <div className="bg-card rounded-2xl border border-border p-5 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-sm">エラー詳細</h2>
              <button onClick={() => setShowErrors(false)} className="text-muted-foreground">✕</button>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4 text-xs">
              <div className="rounded-lg bg-muted/50 p-2 text-center">
                <div className="font-bold text-rose-600">{errorsDetail.total_errors || 0}</div>
                <div className="text-muted-foreground">総エラー</div>
              </div>
              <div className="rounded-lg bg-muted/50 p-2 text-center">
                <div className="font-bold text-amber-600">{errorsDetail.retryable || 0}</div>
                <div className="text-muted-foreground">再試行可能</div>
              </div>
              <div className="rounded-lg bg-muted/50 p-2 text-center">
                <div className="font-bold text-slate-600">{errorsDetail.permanent || 0}</div>
                <div className="text-muted-foreground">恒久エラー</div>
              </div>
            </div>
            <div className="space-y-1.5">
              {(errorsDetail.error_dates || []).slice(-30).reverse().map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-xs border-b border-border/50 pb-1.5">
                  <span className="font-mono shrink-0">{e.date}_{e.venue_code}</span>
                  <span className="text-muted-foreground truncate flex-1">{e.message}</span>
                  <span className={cn("px-1.5 py-0.5 rounded text-[10px] shrink-0", (e.attempts || 0) >= 3 ? "bg-slate-200 text-slate-600" : "bg-amber-100 text-amber-700")}>
                    {e.attempts || 0}回
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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
            {testResult.missing_boats_races?.length > 0 && (
              <div className="text-amber-600">6艇未満レース: {testResult.missing_boats_races.length}件</div>
            )}
            {testResult.errors?.length > 0 && (
              <div className="text-rose-600">エラー: {testResult.errors.length}件</div>
            )}
            <div className="text-muted-foreground">処理時間: {testResult.elapsed_ms}ms</div>
          </div>
        )}
      </div>

      <div className="text-[11px] text-muted-foreground text-center">
        10秒ごとに自動更新 · 通常収集優先ガード付き · 3分ごとに1開催場×1日を自動処理
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

function InfoTile({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="font-mono text-xs font-semibold mt-0.5">{value}</div>
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
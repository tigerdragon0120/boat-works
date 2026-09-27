import { useEffect, useMemo, useState } from "react";
import { Activity, Loader2, ShieldAlert, Trophy } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";

const labelStyle = {
  HOT: "bg-emerald-100 text-emerald-700 border-emerald-300",
  UP: "bg-sky-100 text-sky-700 border-sky-300",
  NEUTRAL: "bg-slate-100 text-slate-600 border-slate-300",
  DOWN: "bg-amber-100 text-amber-700 border-amber-300",
  COLD: "bg-rose-100 text-rose-700 border-rose-300",
};

function fmtDate(d) {
  if (!d) return "—";
  const [,m,day] = String(d).split("-");
  return `${Number(m)}/${Number(day)}`;
}

export default function SeriesPoints() {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const [loading, setLoading] = useState(true);
  const [contexts, setContexts] = useState([]);
  const [points, setPoints] = useState([]);
  const [venues, setVenues] = useState([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const races = await base44.entities.Race.filter({ race_date:today }, "venue_code", 500);
        const map = new Map();
        for (const r of races) if (r.venue_code) map.set(r.venue_code, r.venue_name || r.venue_code);
        if (alive) {
          const available = [...map].map(([code, name]) => ({ code, name }));
          setVenues(available);
          setSelected(prev => available.some(v => v.code === prev) ? prev : available[0]?.code || "");
          if (!available.length) setLoading(false);
        }
      } catch { if (alive) { setError("本日の開催場を読み込めませんでした。ページを再読み込みしてください。"); setLoading(false); } }
    })();
    return () => { alive = false; };
  }, [today]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLoading(true);
    setError("");
    setNotice("");
    setContexts([]);
    setPoints([]);
    const readSaved = async () => {
      const p = await base44.entities.SeriesRacerPoint.filter({
        series_key:'boatcast_'+selected+'_'+today, as_of_date:today,
      }, "-snapshot_at", 100);
      if (alive) {
        setContexts([{as_of_date:today,venue_name:venues.find(v=>v.code===selected)?.name || selected}]);
        setPoints(p);
      }
    };
    (async () => {
      try {
        await readSaved();
        const response = await base44.functions.invoke("refreshSeriesRacerPoints", { as_of_date:today, jcd:selected });
        const result = response.data;
        if (!result || result.status === "error") throw new Error(result?.message || "再集計に失敗しました");
        if (alive && result.status === "partial") setNotice(`出走表が${result.missing_details ?? "数"}レース未取得${result.missing_dates?.length ? `、開催表未取得 ${result.missing_dates.join("・")}` : ""}です。表示は取得済み分の暫定値です。「再集計」で続きを取得できます。`);
        await readSaved();
      } catch (e) {
        if (alive) setError(e?.response?.data?.message || e?.message || "更新できませんでした。");
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [selected, today, refresh, venues]);

  const context = contexts[0];
  const racers = useMemo(() => {
    const map = new Map();
    for (const p of points) {
      if (p.as_of_date !== context?.as_of_date) continue;
      const key = String(p.registration_number);
      if (!map.has(key)) map.set(key, p);
    }
    return [...map.values()].filter(r => Number(r.races_run) > 0)
      .sort((a,b) => Number(b.series_score || 0) - Number(a.series_score || 0));
  }, [points, context]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><Activity className="w-5 h-5 text-primary" /><h1 className="text-xl font-bold">節間ポイント</h1></div>
          <p className="text-xs text-muted-foreground mt-1">年間勝率とは別の、BOAT WORKS独自「開催中の今」を見る節間ポイント</p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {venues.map(v => (
          <button key={v.code} onClick={() => setSelected(v.code)} className={cn("shrink-0 rounded-xl border px-3 py-2 text-sm font-bold", selected === v.code ? "border-primary bg-primary/5" : "border-border bg-card")}>{v.name}</button>
        ))}
      </div>
      <button disabled={loading || !selected} onClick={() => setRefresh(x => x + 1)} className="rounded-xl border px-4 py-2 text-sm disabled:opacity-50">{loading ? "集計中…" : "再集計"}</button>
      {loading && <div className="flex items-center text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin mr-2" />BOATCASTの今節成績を確認しています…</div>}
      {error && <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">更新できませんでした：{error} 保存済みデータがあれば表示しています。</div>}
      {notice && <div role="status" className="rounded-xl border border-amber-300 p-3 text-sm">{notice}</div>}
      {!loading && !error && venues.length === 0 && <div className="p-6 text-sm text-muted-foreground">本日の開催データがありません。</div>}

          {context && (
            <div className="rounded-2xl border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold">{context.venue_name}　今節成績</div>
                  <div className="text-xs text-muted-foreground mt-1">BOATCASTの枠・着順・STで集計／順位・得点率は得点率早見から取得（着差は未取得）</div>
                </div>
                <div className="text-right text-xs">
                  <div className="font-bold">集計対象 {fmtDate(context.as_of_date)}</div>
                  <div className="text-muted-foreground">{points[0]?.snapshot_at ? new Date(points[0].snapshot_at).toLocaleTimeString("ja-JP", { timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit" }) + " 更新" : "未集計"}</div>
                </div>
              </div>
            </div>
          )}

          {!loading && racers.length === 0 ? (
            <div className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
              {context ? "採点できる詳細結果がまだありません。結果取得後に再集計してください。" : "今節の開催情報を取得できていません。"}
            </div>
          ) : (
            <div className="space-y-3">
              {racers.map((r, idx) => <RacerSeriesCard key={r.registration_number} racer={r} position={idx + 1} />)}
            </div>
          )}
    </div>
  );
}

function RacerSeriesCard({ racer: r, position }) {
  const hist = Array.isArray(r.lane_finish_history) ? r.lane_finish_history : [];
  const components = Array.isArray(r.score_components) ? r.score_components : [];
  const reasons = Array.isArray(r.score_reasons) ? r.score_reasons : [];
  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground tabular-nums">#{position}</span>
            <span className="font-bold truncate">{r.racer_name || r.registration_number}</span>
            {r.grade_class && <span className="text-[10px] px-1.5 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-700 font-bold">{r.grade_class}</span>}
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-bold", labelStyle[r.series_label] || labelStyle.NEUTRAL)}>{r.series_label || "NEUTRAL"}</span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">登録 {r.registration_number}・今節{r.races_run || 0}走</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-muted-foreground">節間ポイント</div>
          <div className="text-3xl font-bold tabular-nums leading-none">{r.series_score != null ? Number(r.series_score).toFixed(1) : "—"}</div>
          <div className="text-[9px] text-muted-foreground mt-1">信頼度 {r.series_sample_confidence != null ? `${Math.round(r.series_sample_confidence)}%` : "—"}</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Mini label="内容" value={r.result_quality_score != null ? Math.round(r.result_quality_score) : "—"} />
        <Mini label="直近" value={r.series_momentum_score != null ? Math.round(r.series_momentum_score) : "—"} />
        <Mini label="順位" value={r.rank != null ? `${r.rank}位` : "—"} sub={r.point_rate != null ? `得点率 ${Number(r.point_rate).toFixed(2)}` : "公式値なし"} />
        <Mini label="勝負度" value={r.rank != null ? Math.round(r.rank_pressure_score ?? 50) : "—"} sub={r.rank != null ? "順位をもとにした目安" : "未評価"} />
      </div>

      {hist.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground mb-1.5">枠 → 着順（今節）</div>
          <div className="flex gap-1.5 flex-wrap">
            {hist.map((h,i) => (
              <span key={i} className="text-xs font-bold rounded-lg border bg-background px-2 py-1 tabular-nums">
                {h.series_day != null && <span className="text-[9px] text-muted-foreground mr-1">{h.series_day}日目 {h.race_number}R</span>}{h.lane}号艇 → {h.finish}着
                {h.st != null && <span className="text-[9px] text-muted-foreground ml-1">ST {Number(h.st).toFixed(2)}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {components.length > 0 && (
        <div className="rounded-xl bg-background/60 px-3 py-2">
          <div className="text-[10px] text-muted-foreground mb-1">BOAT WORKS 加減点</div>
          <div className="flex gap-x-3 gap-y-1 flex-wrap text-[10px]">
            {components.map((c,i) => <span key={i}>{c.lane}号艇→{c.finish}着 <b className={c.total_delta >= 0 ? "text-emerald-600" : "text-rose-600"}>{c.total_delta >= 0 ? "+" : ""}{c.total_delta}</b></span>)}
          </div>
        </div>
      )}

      {r.alert_exclusion && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
          <ShieldAlert className="w-4 h-4 shrink-0" />アラート除外候補：{r.alert_exclusion_reason}
        </div>
      )}
      {reasons.length > 0 && <div className="text-[10px] text-muted-foreground flex gap-2 flex-wrap">{reasons.map((x,i)=><span key={i}>• {x}</span>)}</div>}
      {hist.some(h=>h.finish === 1 && h.margin_1_2_seconds != null) && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><Trophy className="w-3.5 h-3.5" />勝利時の着差もシリーズ学習データに保存済み</div>
      )}
    </div>
  );
}

function Mini({ label, value, sub }) {
  return <div className="rounded-xl bg-background/50 px-2 py-2 text-center"><div className="text-[9px] text-muted-foreground">{label}</div><div className="text-base font-bold tabular-nums">{value}</div>{sub && <div className="text-[8px] text-muted-foreground truncate">{sub}</div>}</div>;
}

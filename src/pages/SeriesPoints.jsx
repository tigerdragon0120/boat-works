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
  const [loading, setLoading] = useState(true);
  const [contexts, setContexts] = useState([]);
  const [points, setPoints] = useState([]);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [c, p] = await Promise.all([
          base44.entities.SeriesContext.list("-refreshed_at", 200),
          base44.entities.SeriesRacerPoint.list("-snapshot_at", 1000),
        ]);
        if (!alive) return;
        setContexts(c || []);
        setPoints(p || []);
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const latestContexts = useMemo(() => {
    const map = new Map();
    for (const c of contexts) if (!map.has(c.series_key)) map.set(c.series_key, c);
    return [...map.values()].sort((a,b) => `${a.venue_code}`.localeCompare(`${b.venue_code}`));
  }, [contexts]);

  const selectedKey = selected || latestContexts[0]?.series_key || "";
  const context = latestContexts.find(c => c.series_key === selectedKey);

  const racers = useMemo(() => {
    if (!selectedKey) return [];
    const map = new Map();
    for (const p of points) {
      if (p.series_key !== selectedKey) continue;
      const key = String(p.registration_number);
      if (!map.has(key)) map.set(key, p); // snapshot_at descなので最新のみ
    }
    return [...map.values()].sort((a,b) => Number(b.series_score || 0) - Number(a.series_score || 0));
  }, [points, selectedKey]);

  if (loading) return <div className="py-24 flex items-center justify-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" />今節データ読込中…</div>;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><Activity className="w-5 h-5 text-primary" /><h1 className="text-xl font-bold">今節スコア</h1></div>
          <p className="text-xs text-muted-foreground mt-1">年間勝率とは別の、BOAT WORKS独自「開催中の今」を見る指数</p>
        </div>
      </div>

      {latestContexts.length === 0 ? (
        <div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">シリーズデータは次回の夜間処理から作成されます。</div>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {latestContexts.map(c => (
              <button key={c.series_key} onClick={() => setSelected(c.series_key)} className={cn("shrink-0 rounded-xl border px-3 py-2 text-left", selectedKey === c.series_key ? "border-primary bg-primary/5" : "border-border bg-card")}>
                <div className="text-sm font-bold">{c.venue_name}</div>
                <div className="text-[10px] text-muted-foreground">{c.grade} {c.series_day || "—"}/{c.series_total_days || "—"}日</div>
              </button>
            ))}
          </div>

          {context && (
            <div className="rounded-2xl border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold">{context.venue_name}　{context.event_name}</div>
                  <div className="text-xs text-muted-foreground mt-1">{fmtDate(context.series_start_date)}〜{fmtDate(context.series_end_date)}・{context.grade}・{context.series_day}日目 / 全{context.series_total_days}日</div>
                </div>
                <div className="text-right text-xs">
                  <div className="font-bold">前夜確定 {fmtDate(context.as_of_date)}</div>
                  <div className="text-muted-foreground">{context.point_rank_available ? context.point_rank_as_of || "公式得点率あり" : "公式得点率なし"}</div>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {racers.map((r, idx) => <RacerSeriesCard key={`${r.series_key}_${r.registration_number}`} racer={r} position={idx + 1} />)}
          </div>
        </>
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
          <div className="text-[10px] text-muted-foreground">シリーズ指数</div>
          <div className="text-3xl font-bold tabular-nums leading-none">{r.series_score != null ? Number(r.series_score).toFixed(1) : "—"}</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Mini label="内容" value={r.result_quality_score != null ? Math.round(r.result_quality_score) : "—"} />
        <Mini label="直近" value={r.series_momentum_score != null ? Math.round(r.series_momentum_score) : "—"} />
        <Mini label="順位" value={r.rank != null ? `${r.rank}位` : "—"} sub={r.point_rate != null ? `得点率 ${Number(r.point_rate).toFixed(2)}` : "公式値なし"} />
        <Mini label="勝負度" value={r.rank != null ? Math.round(r.rank_pressure_score ?? 50) : "—"} sub={r.rank != null ? "順位文脈" : "未評価"} />
      </div>

      {hist.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground mb-1.5">枠 → 着順（今節）</div>
          <div className="flex gap-1.5 flex-wrap">
            {hist.map((h,i) => (
              <span key={i} className="text-xs font-bold rounded-lg border bg-background px-2 py-1 tabular-nums">
                {h.lane}号艇 → {h.finish}着
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

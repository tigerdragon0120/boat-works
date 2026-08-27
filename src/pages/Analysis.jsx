import { useEffect, useState, useMemo } from "react";
import { BarChart3, Loader2, Target } from "lucide-react";
import { getVenueStats, getAnalysisStats } from "@/lib/boatService";
import { VENUES, UICHI_COMBOS, fmtPct, fmtNum } from "@/lib/boat";
import { cn } from "@/lib/utils";
import EvPerformanceChart from "@/components/EvPerformanceChart";

export default function Analysis() {
  const [loading, setLoading] = useState(true);
  const [venueStats, setVenueStats] = useState([]);
  const [analysisStats, setAnalysisStats] = useState(null);

  useEffect(() => {
    let m = true;
    (async () => {
      setLoading(true);
      try {
        const [vs, as] = await Promise.all([getVenueStats(), getAnalysisStats()]);
        if (m) { setVenueStats(vs); setAnalysisStats(as); }
      } finally {
        if (m) setLoading(false);
      }
    })();
    return () => { m = false; };
  }, []);

  const stats = useMemo(() => {
    if (!analysisStats) {
      return { total: 0, uichiHits: 0, rate: 0, byVenue: {}, byGrade: {}, byCombo: {}, byRaceNum: {}, buyCount: 0, buyHitRate: 0, buyRecovery: 0 };
    }
    const total = analysisStats.total || 0;
    const uichiHits = analysisStats.uichiHits || 0;
    const rate = total > 0 ? uichiHits / total : 0;
    // venue breakdown from VenueStats (集計済みデータ・RaceResult全件不使用)
    const byVenue = {};
    for (const v of venueStats) {
      byVenue[v.venue_code] = { name: v.venue_name, total: v.total_races || 0, hits: v.uichi_hits || 0 };
    }
    return {
      total, uichiHits, rate,
      byVenue,
      byGrade: analysisStats.byGrade || {},
      byCombo: analysisStats.byCombo || {},
      byRaceNum: analysisStats.byRaceNum || {},
      buyCount: analysisStats.buyCount || 0,
      buyHitRate: analysisStats.buyHitRate || 0,
      buyRecovery: analysisStats.buyRecovery || 0,
    };
  }, [venueStats, analysisStats]);

  if (loading) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" />集計中…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BarChart3 className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-bold">データ分析</h1>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card label="全レース数" value={stats.total} />
        <Card label="ういち的中" value={stats.uichiHits} />
        <Card label="出現率" value={fmtPct(stats.rate, 2)} accent="primary" />
        <Card label="BUY判定数" value={stats.buyCount} accent="emerald" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card label="1号艇詳細補完済み" value={stats.totalWithDetails ?? "—"} />
        <Card label="データ充足率" value={fmtPct(stats.dataSufficiencyRate, 0)} accent="primary" />
        <Card label="BUY的中率" value={fmtPct(stats.buyHitRate, 1)} accent="emerald" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Card label="BUY的中率" value={fmtPct(stats.buyHitRate, 1)} accent="emerald" />
        <Card label="BUY回収率" value={fmtNum(stats.buyRecovery * 100, 0) + "%"} accent="amber" />
      </div>

      {/* 期待値指数別パフォーマンス */}
      <Section title="期待値指数別 BUYパフォーマンス">
        <div className="flex items-center gap-1.5 mb-3 text-xs text-muted-foreground">
          <Target className="w-3.5 h-3.5" />
          <span>高期待値のBUY判定がどれだけ的中しているか一目で分かります</span>
        </div>
        <EvPerformanceChart />
      </Section>

      {/* Venue breakdown */}
      <Section title="競艇場別出現率">
        <div className="space-y-1">
          {Object.values(stats.byVenue).filter(v => v.total > 0).sort((a, b) => (b.hits / b.total || 0) - (a.hits / a.total || 0)).map((v) => (
            <Row key={v.name} label={v.name} right={fmtPct(v.hits / v.total, 1)} sub={`${v.hits}/${v.total}`} bar={v.hits / v.total} />
          ))}
        </div>
      </Section>

      {/* Grade breakdown */}
      <Section title="1号艇級別出現率">
        <div className="space-y-1">
          {Object.entries(stats.byGrade).filter(([, v]) => v.total > 0).map(([g, v]) => (
            <Row key={g} label={g} right={fmtPct(v.hits / v.total, 1)} sub={`${v.hits}/${v.total}`} bar={v.hits / v.total} />
          ))}
        </div>
      </Section>

      {/* Race number */}
      <Section title="レース番号別出現率">
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {Object.entries(stats.byRaceNum).map(([n, v]) => (
            <div key={n} className="rounded-lg bg-background/50 px-2 py-2 text-center">
              <div className="text-xs text-muted-foreground">{n}R</div>
              <div className="font-bold tabular-nums text-sm">{v.total > 0 ? fmtPct(v.hits / v.total, 1) : "—"}</div>
              <div className="text-[10px] text-muted-foreground">{v.hits}/{v.total}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Combo breakdown */}
      <Section title="6点別出現分析">
        <div className="space-y-1">
          {UICHI_COMBOS.map((c) => {
            const v = stats.byCombo[c] || { count: 0, sumPayout: 0 };
            const avg = v.count > 0 ? v.sumPayout / v.count : 0;
            return <Row key={c} label={c} right={`${v.count}回`} sub={`平均 ${fmtNum(avg, 0)}円`} bar={v.count / Math.max(stats.uichiHits, 1)} mono />;
          })}
        </div>
      </Section>
    </div>
  );
}

function Card({ label, value, accent = "default" }) {
  const c = { default: "text-foreground", primary: "text-primary", emerald: "text-emerald-600", amber: "text-amber-600" };
  return (
    <div className="rounded-2xl bg-card border border-border p-4">
      <div className="text-[11px] text-muted-foreground tracking-wider">{label}</div>
      <div className={cn("text-2xl font-bold tabular-nums mt-1", c[accent])}>{value}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded-2xl bg-card border border-border p-4">
      <h3 className="text-sm font-bold mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, right, sub, bar, mono }) {
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className={cn("w-16 text-sm", mono && "font-mono font-semibold")}>{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-background overflow-hidden">
        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(bar * 100, 100)}%` }} />
      </div>
      <span className="text-sm font-bold tabular-nums w-14 text-right">{right}</span>
      <span className="text-[11px] text-muted-foreground w-14 text-right tabular-nums">{sub}</span>
    </div>
  );
}
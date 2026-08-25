import { useEffect, useState, useMemo } from "react";
import { BarChart3, Loader2 } from "lucide-react";
import { getAllResults, getAllAnalyses, getVenueStats } from "@/lib/boatService";
import { VENUES, UICHI_COMBOS, fmtPct, fmtNum } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function Analysis() {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [venueStats, setVenueStats] = useState([]);

  useEffect(() => {
    let m = true;
    (async () => {
      setLoading(true);
      try {
        const [r, a, vs] = await Promise.all([getAllResults(), getAllAnalyses(), getVenueStats()]);
        if (m) { setResults(r); setAnalyses(a); setVenueStats(vs); }
      } finally {
        if (m) setLoading(false);
      }
    })();
    return () => { m = false; };
  }, []);

  const stats = useMemo(() => {
    const total = results.length;
    const uichiHits = results.filter((r) => r.is_uichi).length;
    const rate = total > 0 ? uichiHits / total : 0;
    // venue breakdown
    const byVenue = {};
    for (const r of results) {
      byVenue[r.venue_code] = byVenue[r.venue_code] || { name: r.venue_name, total: 0, hits: 0 };
      byVenue[r.venue_code].total++;
      if (r.is_uichi) byVenue[r.venue_code].hits++;
    }
    // grade breakdown
    const byGrade = {};
    for (const r of results) {
      const g = r.boat1_grade_class || "不明";
      byGrade[g] = byGrade[g] || { total: 0, hits: 0 };
      byGrade[g].total++;
      if (r.is_uichi) byGrade[g].hits++;
    }
    // combo breakdown
    const byCombo = {};
    for (const c of UICHI_COMBOS) byCombo[c] = { count: 0, sumPayout: 0 };
    for (const r of results) {
      if (r.is_uichi && r.uichi_combo && byCombo[r.uichi_combo]) {
        byCombo[r.uichi_combo].count++;
        byCombo[r.uichi_combo].sumPayout += r.payout_trifecta || 0;
      }
    }
    // race number breakdown
    const byRaceNum = {};
    for (let i = 1; i <= 12; i++) byRaceNum[i] = { total: 0, hits: 0 };
    for (const r of results) {
      const n = r.race_number;
      if (byRaceNum[n]) { byRaceNum[n].total++; if (r.is_uichi) byRaceNum[n].hits++; }
    }
    // BUY judgment stats
    const buyAnalyses = analyses.filter((a) => a.judgment === "BUY");
    const buyCount = buyAnalyses.length;
    // 勝敗判定は結果と紐づけが難しいので、BUY分析のうち結果がういち的中か
    const buyHits = buyAnalyses.filter((a) => {
      const matched = results.find((r) => r.race_id === a.race_id);
      return matched && matched.is_uichi;
    }).length;
    const buyHitRate = buyCount > 0 ? buyHits / buyCount : 0;
    const buyPayoutSum = buyAnalyses.reduce((s, a) => {
      const matched = results.find((r) => r.race_id === a.race_id);
      return s + (matched && matched.is_uichi ? matched.payout_trifecta || 0 : 0);
    }, 0);
    const buyRecovery = buyCount > 0 ? buyPayoutSum / (buyCount * 100) : 0; // 100円/点×6点=600円/レース想定
    return { total, uichiHits, rate, byVenue, byGrade, byCombo, byRaceNum, buyCount, buyHitRate, buyRecovery };
  }, [results, analyses]);

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
      <div className="grid grid-cols-2 gap-3">
        <Card label="BUY的中率" value={fmtPct(stats.buyHitRate, 1)} accent="emerald" />
        <Card label="BUY回収率" value={fmtNum(stats.buyRecovery * 100, 0) + "%"} accent="amber" />
      </div>

      {/* Venue breakdown */}
      <Section title="競艇場別出現率">
        <div className="space-y-1">
          {Object.values(stats.byVenue).sort((a, b) => (b.hits / b.total || 0) - (a.hits / a.total || 0)).map((v) => (
            <Row key={v.name} label={v.name} right={fmtPct(v.hits / v.total, 1)} sub={`${v.hits}/${v.total}`} bar={v.hits / v.total} />
          ))}
        </div>
      </Section>

      {/* Grade breakdown */}
      <Section title="1号艇級別出現率">
        <div className="space-y-1">
          {Object.entries(stats.byGrade).map(([g, v]) => (
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
              <div className="font-bold tabular-nums text-sm">{fmtPct(v.hits / v.total, 1)}</div>
              <div className="text-[10px] text-muted-foreground">{v.hits}/{v.total}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Combo breakdown */}
      <Section title="6点別出現分析">
        <div className="space-y-1">
          {UICHI_COMBOS.map((c) => {
            const v = stats.byCombo[c];
            const avg = v.count > 0 ? v.sumPayout / v.count : 0;
            return <Row key={c} label={c} right={`${v.count}回`} sub={`平均 ${fmtNum(avg, 0)}円`} bar={v.count / Math.max(stats.uichiHits, 1)} mono />;
          })}
        </div>
      </Section>
    </div>
  );
}

function Card({ label, value, accent = "default" }) {
  const c = { default: "text-foreground", primary: "text-primary", emerald: "text-emerald-400", amber: "text-amber-400" };
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
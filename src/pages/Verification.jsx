import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, XCircle, HelpCircle, Loader2, Target, TrendingUp, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { fmtPct, fmtNum } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function Verification() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const key = "boatworks:alertVerification:v1";
        const cached = sessionStorage.getItem(key);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Date.now() - parsed.t < 5 * 60 * 1000) {
            setData(parsed.v);
            setLoading(false);
            return;
          }
        }
        const res = await base44.functions.invoke("getAlertVerification", { limit: 500 });
        const v = res.data || res;
        setData(v);
        sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v }));
      } catch (e) {
        setError(e?.message || "検証データ取得に失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    if (filter === "hit") return all.filter(r => r.completed && r.is_uichi);
    if (filter === "miss") return all.filter(r => r.completed && !r.is_uichi);
    if (filter === "buy") return all.filter(r => r.final_judgment === "BUY");
    if (filter === "nofinal") return all.filter(r => r.completed && (!r.final_judgment || r.final_judgment === "PENDING"));
    return all;
  }, [data, filter]);

  if (loading) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" />検証結果を集計中…</div>;
  if (error) return <div className="text-center py-24 text-rose-600">{error}</div>;

  const s = data?.summary || {};

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">アラート検証</h1>
        <p className="text-xs text-muted-foreground mt-1">アラートに出たレースの「評価 → 最終判定 → 実際の結果」を答え合わせします。</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Summary label="結果確定" value={`${s.completed_count || 0}件`} icon={Target} />
        <Summary label="候補的中率" value={fmtPct(s.hit_rate || 0, 1)} sub={`${s.hit_count || 0}/${s.completed_count || 0}`} icon={CheckCircle2} accent="emerald" />
        <Summary label="BUY的中率" value={fmtPct(s.buy_hit_rate || 0, 1)} sub={`${s.buy_hit_count || 0}/${s.buy_count || 0}`} icon={TrendingUp} accent="primary" />
        <Summary label="最終判定なし" value={`${s.no_final_count || 0}件`} icon={AlertTriangle} accent={s.no_final_count > 0 ? "amber" : "default"} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>すべて</FilterButton>
        <FilterButton active={filter === "hit"} onClick={() => setFilter("hit")}>○ 的中</FilterButton>
        <FilterButton active={filter === "miss"} onClick={() => setFilter("miss")}>× ハズレ</FilterButton>
        <FilterButton active={filter === "nofinal"} onClick={() => setFilter("nofinal")}>判定なし</FilterButton>
      </div>

      <div className="space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">該当する検証結果はありません</div>
        ) : rows.map(r => <ResultCard key={`${r.race_id}-${r.race_date}`} row={r} />)}
      </div>
    </div>
  );
}

function ResultCard({ row:r }) {
  const pending = !r.completed;
  const hit = r.completed && r.is_uichi;
  const finalNone = r.completed && (!r.final_judgment || r.final_judgment === "PENDING");
  return (
    <div className={cn("rounded-2xl border bg-card p-4", hit ? "border-emerald-300" : pending ? "border-border" : "border-rose-200")}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          {pending ? <HelpCircle className="w-6 h-6 text-muted-foreground" /> : hit ? <CheckCircle2 className="w-6 h-6 text-emerald-600" /> : <XCircle className="w-6 h-6 text-rose-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold">{r.race_date} {r.venue_name} {r.race_number}R</span>
            <Badge text={`事前 ${r.pre_grade || "—"}`} tone="sky" />
            <Badge text={finalNone ? "最終判定なし" : `最終 ${r.final_judgment || "—"}`} tone={r.final_judgment === "BUY" ? "emerald" : r.final_judgment === "WATCH" ? "amber" : "gray"} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3 text-center">
            <Mini label="前日出現率" value={r.pre_appearance_rate != null ? fmtPct(r.pre_appearance_rate, 1) : "—"} />
            <Mini label="1号艇信頼" value={r.boat1_trust_score ?? "—"} />
            <Mini label="期待値" value={r.final_expected_value != null ? `${fmtNum(r.final_expected_value, 0)}%` : "—"} />
            <Mini label="実際の3連単" value={r.result_trifecta || "未確定"} />
            <Mini label="払戻" value={r.payout_trifecta != null ? `${Math.round(r.payout_trifecta).toLocaleString()}円` : "—"} />
          </div>

          <div className={cn("mt-3 text-sm font-bold", pending ? "text-muted-foreground" : hit ? "text-emerald-600" : "text-rose-600")}>
            {pending ? "結果待ち" : hit ? "○ ういち買い的中" : "× ういち買いハズレ"}
          </div>
        </div>
      </div>
    </div>
  );
}

function Summary({ label, value, sub, icon: Icon, accent="default" }) {
  const tones = { default:"text-foreground", emerald:"text-emerald-600", primary:"text-primary", amber:"text-amber-600" };
  return <div className="rounded-2xl bg-card border border-border p-4">
    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-4 h-4" />{label}</div>
    <div className={cn("text-2xl font-bold tabular-nums mt-1", tones[accent])}>{value}</div>
    {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
  </div>;
}
function Mini({ label, value }) { return <div className="rounded-lg bg-background/60 px-2 py-2"><div className="text-[10px] text-muted-foreground">{label}</div><div className="font-bold tabular-nums text-sm mt-0.5">{value}</div></div>; }
function Badge({ text, tone }) { const c={sky:"bg-sky-50 text-sky-700 border-sky-200",emerald:"bg-emerald-50 text-emerald-700 border-emerald-200",amber:"bg-amber-50 text-amber-700 border-amber-200",gray:"bg-slate-50 text-slate-600 border-slate-200"}; return <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full border",c[tone]||c.gray)}>{text}</span>; }
function FilterButton({active,onClick,children}) { return <button onClick={onClick} className={cn("rounded-xl border px-3 py-2 text-sm font-bold",active?"bg-primary text-primary-foreground border-primary":"bg-card border-border text-muted-foreground")}>{children}</button>; }

import { useEffect, useMemo, useState } from "react";
import { HelpCircle, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { fmtPct, fmtNum } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function Verification() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const loadHistory = async () => {
          const res = await base44.functions.invoke("getAlertVerification", { limit: 500 });
          const v = res.data || res;
          if (mounted) setData(v);
          return v;
        };

        // 検証ページは必ず最新DBを読む。結果表示で古いキャッシュは使わない。
        let current = await loadHistory();

        // 終了から25分以上たっているのに結果待ちがあれば、その場で自動回収して再読込する。
        const now = Date.now();
        const stalePending = (current?.rows || []).some((r) => {
          if (r.completed || !r.deadline) return false;
          const d = new Date(r.deadline).getTime();
          return Number.isFinite(d) && now >= d + 25 * 60 * 1000;
        });
        if (stalePending) {
          await base44.functions.invoke("runResultVerificationWorker", {});
          if (mounted) current = await loadHistory();
        }
      } catch (e) {
        if (mounted) setError(e?.message || "アラート履歴の取得に失敗しました");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const rows = useMemo(() => {
    let all = [...(data?.rows || [])];
    if (filter === "buy") all = all.filter(r => r.final_judgment === "BUY");
    if (filter === "watch") all = all.filter(r => r.final_judgment === "WATCH");
    if (filter === "skip") all = all.filter(r => r.final_judgment === "SKIP");
    if (filter === "nofinal") all = all.filter(r => !r.final_judgment || r.final_judgment === "PENDING");

    // 時系列昇順: 古い日付 → 新しい日付、同日は締切の早いレース → 遅いレース。
    // deadlineが無い場合は race_number を補助キーに使う。
    return all.sort((a, b) => {
      const dateCmp = String(a.race_date || "").localeCompare(String(b.race_date || ""));
      if (dateCmp !== 0) return dateCmp;
      const at = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return Number(a.race_number || 0) - Number(b.race_number || 0);
    });
  }, [data, filter]);

  if (loading) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" />アラート履歴を読み込み中…</div>;
  if (error) return <div className="text-center py-24 text-rose-600">{error}</div>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">アラート結果</h1>
        <p className="text-xs text-muted-foreground mt-1">アラートに出たレースが、その後どんな判定になり、実際にどう決着したかを見るページです。</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>すべて</FilterButton>
        <FilterButton active={filter === "buy"} onClick={() => setFilter("buy")}>BUY</FilterButton>
        <FilterButton active={filter === "watch"} onClick={() => setFilter("watch")}>WATCH</FilterButton>
        <FilterButton active={filter === "skip"} onClick={() => setFilter("skip")}>SKIP</FilterButton>
        <FilterButton active={filter === "nofinal"} onClick={() => setFilter("nofinal")}>判定なし</FilterButton>
      </div>

      <div className="space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">該当するアラート履歴はありません</div>
        ) : rows.map(r => <ResultCard key={`${r.race_id}-${r.race_date}`} row={r} />)}
      </div>
    </div>
  );
}

function ResultCard({ row:r }) {
  const judgment = !r.final_judgment || r.final_judgment === "PENDING" ? "判定なし" : r.final_judgment;
  const resultText = r.result_trifecta || "結果待ち";
  const uichiText = !r.completed ? "結果待ち" : r.is_uichi ? "ういち買い該当" : "ういち買い非該当";
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <HelpCircle className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold">{r.race_date} {r.venue_name} {r.race_number}R</span>
            <Badge text={`事前 ${r.pre_grade || "—"}`} tone="sky" />
            <Badge text={judgment} tone={judgment === "BUY" ? "emerald" : judgment === "WATCH" ? "amber" : judgment === "SKIP" ? "rose" : "gray"} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mt-3 text-center">
            <Mini label="事前出現率" value={r.pre_appearance_rate != null ? fmtPct(r.pre_appearance_rate, 1) : "—"} />
            <Mini label="1号艇信頼" value={r.boat1_trust_score ?? "—"} />
            <Mini label="条件一致" value={r.condition_match_score != null ? `${r.condition_match_score}%` : "—"} />
            <Mini label="最終期待値" value={r.final_expected_value != null ? `${fmtNum(r.final_expected_value, 0)}%` : "—"} />
            <Mini label="実際の3連単" value={resultText} />
            <Mini label="払戻" value={r.payout_trifecta != null ? `${Math.round(r.payout_trifecta).toLocaleString()}円` : "—"} />
          </div>

          <div className={cn("mt-3 text-sm font-bold", !r.completed ? "text-muted-foreground" : r.is_uichi ? "text-emerald-600" : "text-slate-600")}>
            {uichiText}
          </div>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value }) { return <div className="rounded-lg bg-background/60 px-2 py-2"><div className="text-[10px] text-muted-foreground">{label}</div><div className="font-bold tabular-nums text-sm mt-0.5">{value}</div></div>; }
function Badge({ text, tone }) { const c={sky:"bg-sky-50 text-sky-700 border-sky-200",emerald:"bg-emerald-50 text-emerald-700 border-emerald-200",amber:"bg-amber-50 text-amber-700 border-amber-200",rose:"bg-rose-50 text-rose-700 border-rose-200",gray:"bg-slate-50 text-slate-600 border-slate-200"}; return <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full border",c[tone]||c.gray)}>{text}</span>; }
function FilterButton({active,onClick,children}) { return <button onClick={onClick} className={cn("rounded-xl border px-3 py-2 text-sm font-bold",active?"bg-primary text-primary-foreground border-primary":"bg-card border-border text-muted-foreground")}>{children}</button>; }

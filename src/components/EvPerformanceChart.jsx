import { useEffect, useState } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Loader2, TrendingUp } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

// 期待値指数帯別の的中率・回収率グラフ
export default function EvPerformanceChart() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await base44.functions.invoke("getEvPerformance", {});
        setData(res.data);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;
  if (!data || data.overall.total === 0) return <div className="text-center py-6 text-sm text-muted-foreground">まだBUY判定の履歴がありません</div>;

  const { bins, overall } = data;
  const chartData = bins.filter(b => b.total > 0).map(b => ({
    label: `EV ${b.label}`,
    ...b,
    hit_rate_pct: b.hit_rate * 100,
    return_rate_pct: b.return_rate * 100,
  }));

  return (
    <div className="space-y-4">
      {/* サマリー */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-background/50 px-3 py-2 text-center">
          <div className="text-[10px] text-muted-foreground tracking-wider">総BUY数</div>
          <div className="text-lg font-bold tabular-nums">{overall.total}</div>
        </div>
        <div className="rounded-xl bg-background/50 px-3 py-2 text-center">
          <div className="text-[10px] text-muted-foreground tracking-wider">全体的中率</div>
          <div className={cn("text-lg font-bold tabular-nums", overall.hit_rate >= 0.3 ? "text-emerald-600" : "text-amber-600")}>{fmtPct(overall.hit_rate, 1)}</div>
        </div>
        <div className="rounded-xl bg-background/50 px-3 py-2 text-center">
          <div className="text-[10px] text-muted-foreground tracking-wider">全体回収率</div>
          <div className={cn("text-lg font-bold tabular-nums", overall.return_rate >= 1 ? "text-emerald-600" : "text-rose-600")}>{fmtPct(overall.return_rate, 1)}</div>
        </div>
      </div>

      {/* グラフ */}
      <div className="rounded-xl bg-background/30 p-3">
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="left" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
            <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value, name) => {
                if (name === "BUY数") return [value, name];
                return [`${value.toFixed(1)}%`, name];
              }}
              contentStyle={{ borderRadius: "0.75rem", border: "1px solid hsl(var(--border))", fontSize: "12px" }}
            />
            <Legend wrapperStyle={{ fontSize: "11px" }} />
            <Bar yAxisId="left" dataKey="total" fill="hsl(var(--chart-3))" name="BUY数" radius={[4, 4, 0, 0]} barSize={28} />
            <Line yAxisId="right" type="monotone" dataKey="hit_rate_pct" stroke="hsl(var(--chart-1))" strokeWidth={2.5} name="的中率" dot={{ r: 5 }} />
            <Line yAxisId="right" type="monotone" dataKey="return_rate_pct" stroke="hsl(var(--chart-2))" strokeWidth={2.5} name="回収率" dot={{ r: 5 }} strokeDasharray="5 5" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 帯別テーブル */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-b">
              <th className="text-left py-1.5 px-2">EV帯</th>
              <th className="text-right py-1.5 px-2">BUY</th>
              <th className="text-right py-1.5 px-2">的中</th>
              <th className="text-right py-1.5 px-2">的中率</th>
              <th className="text-right py-1.5 px-2">回収率</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((b) => (
              <tr key={b.label} className="border-b last:border-0">
                <td className="py-1.5 px-2 font-bold">EV {b.label}</td>
                <td className="text-right py-1.5 px-2 tabular-nums">{b.total}</td>
                <td className="text-right py-1.5 px-2 tabular-nums">{b.hits}</td>
                <td className={cn("text-right py-1.5 px-2 tabular-nums font-semibold", b.hit_rate >= 0.3 ? "text-emerald-600" : b.total > 0 ? "text-amber-600" : "text-muted-foreground")}>
                  {b.total > 0 ? fmtPct(b.hit_rate, 1) : "—"}
                </td>
                <td className={cn("text-right py-1.5 px-2 tabular-nums font-semibold", b.return_rate >= 1 ? "text-emerald-600" : b.total > 0 ? "text-rose-600" : "text-muted-foreground")}>
                  {b.total > 0 ? fmtPct(b.return_rate, 1) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <TrendingUp className="w-3.5 h-3.5" />
        <span>高EV帯ほど的中率・回収率が高ければ、期待値通りの成果が出ています</span>
      </div>
    </div>
  );
}
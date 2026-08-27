import { useEffect, useState } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Loader2, Target, TrendingUp, Award, Wallet } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function Performance() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await base44.functions.invoke("getBuyPerformance", {});
        setData(res.data);
      } catch (e) {
        setError(e?.message || "データ取得に失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="flex items-center justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (error) return <div className="text-center py-24 text-muted-foreground">{error}</div>;
  if (!data || data.overall.total === 0) return <div className="text-center py-24 text-muted-foreground">まだBUY判定の履歴がありません</div>;

  const { months, overall } = data;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">BUY判定パフォーマンス</h1>

      {/* サマリー */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={Target} label="総BUY数" value={overall.total} />
        <SummaryCard icon={Award} label="的中数" value={overall.hits} />
        <SummaryCard icon={TrendingUp} label="的中率" value={fmtPct(overall.hit_rate, 1)} accent="emerald" />
        <SummaryCard icon={Wallet} label="回収率" value={fmtPct(overall.return_rate, 1)} accent={overall.return_rate >= 1 ? "emerald" : "rose"} />
      </div>

      {/* 的中率チャート */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <h2 className="text-sm font-bold mb-3">月別 的中率</h2>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={months}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value, name) => name === "的中率" ? fmtPct(value, 1) : value}
              contentStyle={{ borderRadius: "0.75rem", border: "1px solid hsl(var(--border))" }}
            />
            <Legend />
            <Bar yAxisId="left" dataKey="total" fill="hsl(var(--chart-3))" name="BUY数" radius={[4, 4, 0, 0]} />
            <Bar yAxisId="left" dataKey="hits" fill="hsl(var(--chart-1))" name="的中数" radius={[4, 4, 0, 0]} />
            <Line yAxisId="right" type="monotone" dataKey="hit_rate" stroke="hsl(var(--chart-2))" strokeWidth={2} name="的中率" dot={{ r: 4 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 回収率チャート */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <h2 className="text-sm font-bold mb-3">月別 回収率</h2>
        <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={months}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value, name) => name === "回収率" ? fmtPct(value, 1) : `${Math.round(value).toLocaleString()}円`}
              contentStyle={{ borderRadius: "0.75rem", border: "1px solid hsl(var(--border))" }}
            />
            <Legend />
            <Bar dataKey="payout" fill="hsl(var(--chart-1))" name="回収額" radius={[4, 4, 0, 0]} />
            <Line type="monotone" dataKey="return_rate" stroke="hsl(var(--chart-2))" strokeWidth={2} name="回収率" dot={{ r: 4 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 月別詳細テーブル */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <h2 className="text-sm font-bold mb-3">月別詳細</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b">
                <th className="text-left py-2 px-2">月</th>
                <th className="text-right py-2 px-2">BUY</th>
                <th className="text-right py-2 px-2">的中</th>
                <th className="text-right py-2 px-2">的中率</th>
                <th className="text-right py-2 px-2">投資</th>
                <th className="text-right py-2 px-2">回収</th>
                <th className="text-right py-2 px-2">回収率</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-b last:border-0">
                  <td className="py-2 px-2 font-bold">{m.month}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.total}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.hits}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{fmtPct(m.hit_rate, 1)}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.investment.toLocaleString()}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{Math.round(m.payout).toLocaleString()}</td>
                  <td className={cn("text-right py-2 px-2 tabular-nums font-bold", m.return_rate >= 1 ? "text-emerald-600" : "text-rose-600")}>{fmtPct(m.return_rate, 1)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold border-t-2">
                <td className="py-2 px-2">合計</td>
                <td className="text-right py-2 px-2 tabular-nums">{overall.total}</td>
                <td className="text-right py-2 px-2 tabular-nums">{overall.hits}</td>
                <td className="text-right py-2 px-2 tabular-nums">{fmtPct(overall.hit_rate, 1)}</td>
                <td className="text-right py-2 px-2 tabular-nums">{overall.investment.toLocaleString()}</td>
                <td className="text-right py-2 px-2 tabular-nums">{Math.round(overall.payout).toLocaleString()}</td>
                <td className={cn("text-right py-2 px-2 tabular-nums font-bold", overall.return_rate >= 1 ? "text-emerald-600" : "text-rose-600")}>{fmtPct(overall.return_rate, 1)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, accent }) {
  const accentClass = {
    emerald: "text-emerald-600",
    rose: "text-rose-600",
    primary: "text-primary",
  };
  return (
    <div className="rounded-2xl bg-card border border-border p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground tracking-wider">{label}</span>
      </div>
      <div className={cn("text-2xl font-bold tabular-nums", accent ? accentClass[accent] : "text-foreground")}>{value}</div>
    </div>
  );
}
import { useEffect, useState } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Cell } from "recharts";
import { Loader2, CalendarDays, MapPin, TrendingUp, Target, Wallet } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function Trends() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const key = "boatworks:uichiTrends:v1";
        const cached = localStorage.getItem(key);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Date.now() - parsed.t < 10 * 60 * 1000) {
            setData(parsed.v);
            setLoading(false);
            return;
          }
        }
        const res = await base44.functions.invoke("getUichiTrends", {});
        setData(res.data);
        localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: res.data }));
      } catch (e) {
        setError(e?.message || "データ取得に失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="flex items-center justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (error) return <div className="text-center py-24 text-muted-foreground">{error}</div>;
  if (!data || data.overall.total === 0) return <div className="text-center py-24 text-muted-foreground">まだレース結果データがありません</div>;

  const { byMonth, byVenue, overall } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <TrendingUp className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-bold">ういち傾向分析</h1>
      </div>

      {/* 全体サマリー */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={Target} label="総レース数" value={overall.total.toLocaleString()} />
        <SummaryCard icon={CalendarDays} label="ういち的中" value={overall.hits.toLocaleString()} />
        <SummaryCard icon={TrendingUp} label="全体出現率" value={fmtPct(overall.rate, 2)} accent="primary" />
        <SummaryCard icon={Wallet} label="全体回収率" value={fmtPct(overall.return_rate, 1)} accent={overall.return_rate >= 1 ? "emerald" : "rose"} />
      </div>

      {/* 月別推移グラフ */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold">月別 出現率・回収率推移</h2>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={byMonth}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="left" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
            <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value, name) => {
                if (name === "レース数" || name === "的中数") return [value, name];
                return [`${value.toFixed(1)}%`, name];
              }}
              contentStyle={{ borderRadius: "0.75rem", border: "1px solid hsl(var(--border))", fontSize: "12px" }}
            />
            <Legend wrapperStyle={{ fontSize: "11px" }} />
            <Bar yAxisId="left" dataKey="total" fill="hsl(var(--chart-3))" name="レース数" radius={[4, 4, 0, 0]} barSize={20} />
            <Bar yAxisId="left" dataKey="hits" fill="hsl(var(--chart-1))" name="的中数" radius={[4, 4, 0, 0]} barSize={20} />
            <Line yAxisId="right" type="monotone" dataKey="rate_pct" stroke="hsl(var(--chart-2))" strokeWidth={2.5} name="出現率" dot={{ r: 4 }} />
            <Line yAxisId="right" type="monotone" dataKey="return_rate_pct" stroke="hsl(var(--chart-4))" strokeWidth={2.5} name="回収率" dot={{ r: 4 }} strokeDasharray="5 5" />
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
                <th className="text-right py-2 px-2">レース</th>
                <th className="text-right py-2 px-2">的中</th>
                <th className="text-right py-2 px-2">出現率</th>
                <th className="text-right py-2 px-2">回収率</th>
              </tr>
            </thead>
            <tbody>
              {byMonth.map((m) => (
                <tr key={m.month} className="border-b last:border-0">
                  <td className="py-2 px-2 font-bold">{m.month}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.total}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.hits}</td>
                  <td className="text-right py-2 px-2 tabular-nums font-semibold text-primary">{fmtPct(m.rate, 1)}</td>
                  <td className={cn("text-right py-2 px-2 tabular-nums font-semibold", m.return_rate >= 1 ? "text-emerald-600" : "text-rose-600")}>{fmtPct(m.return_rate, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 競艇場別グラフ */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold">競艇場別 出現率・回収率</h2>
        </div>
        <ResponsiveContainer width="100%" height={Math.max(280, byVenue.length * 32)}>
          <BarChart data={byVenue} layout="vertical" margin={{ left: 20, right: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="venue_name" tick={{ fontSize: 10 }} width={70} />
            <Tooltip
              formatter={(value, name) => [`${value.toFixed(1)}%`, name]}
              contentStyle={{ borderRadius: "0.75rem", border: "1px solid hsl(var(--border))", fontSize: "12px" }}
            />
            <Legend wrapperStyle={{ fontSize: "11px" }} />
            <Bar dataKey="rate_pct" fill="hsl(var(--chart-3))" name="出現率" radius={[0, 4, 4, 0]} barSize={14} />
            <Bar dataKey="return_rate_pct" fill="hsl(var(--chart-2))" name="回収率" radius={[0, 4, 4, 0]} barSize={14} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 競艇場別テーブル */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <h2 className="text-sm font-bold mb-3">競艇場別詳細（上位20）</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b">
                <th className="text-left py-2 px-2">競艇場</th>
                <th className="text-right py-2 px-2">レース</th>
                <th className="text-right py-2 px-2">的中</th>
                <th className="text-right py-2 px-2">出現率</th>
                <th className="text-right py-2 px-2">回収率</th>
              </tr>
            </thead>
            <tbody>
              {byVenue.slice(0, 20).map((v) => (
                <tr key={v.venue_code} className="border-b last:border-0">
                  <td className="py-2 px-2 font-bold">{v.venue_name}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{v.total}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{v.hits}</td>
                  <td className="text-right py-2 px-2 tabular-nums font-semibold text-primary">{fmtPct(v.rate, 1)}</td>
                  <td className={cn("text-right py-2 px-2 tabular-nums font-semibold", v.return_rate >= 1 ? "text-emerald-600" : "text-rose-600")}>{fmtPct(v.return_rate, 1)}</td>
                </tr>
              ))}
            </tbody>
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
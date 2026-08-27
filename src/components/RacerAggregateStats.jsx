import { useEffect, useState } from "react";
import { Loader2, TrendingUp, Cloud } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { VENUES } from "@/lib/boat";
import { fmtNum, fmtPct } from "@/lib/boat";
import { cn } from "@/lib/utils";

// 選手の集計データ表示（得意場ランキング + 天候相性）
// RacerVenueStats / RacerWeatherStats から取得
// 最低サンプル数未満は表示しない

function jcdToName(jcd) {
  const idx = parseInt(jcd, 10) - 1;
  return (idx >= 0 && idx < VENUES.length) ? VENUES[idx].name : jcd;
}

export default function RacerAggregateStats({ registrationNumber }) {
  const [loading, setLoading] = useState(false);
  const [venueStats, setVenueStats] = useState([]);
  const [weatherStats, setWeatherStats] = useState([]);

  useEffect(() => {
    if (!registrationNumber) return;
    let m = true;
    setLoading(true);
    (async () => {
      try {
        const [vs, ws] = await Promise.all([
          base44.entities.RacerVenueStats.filter(
            { registration_number: registrationNumber }, "-boat1_win_rate", 200
          ),
          base44.entities.RacerWeatherStats.filter(
            { registration_number: registrationNumber }, "-win_rate", 200
          ),
        ]);
        if (!m) return;
        // 得意場: boat1_races >= 8 のみ
        setVenueStats(vs.filter(v => v.boat1_races >= 8).slice(0, 5));
        // 天候相性: races >= 5 のみ
        setWeatherStats(ws.filter(w => w.races >= 5).slice(0, 5));
      } catch {}
      if (m) setLoading(false);
    })();
    return () => { m = false; };
  }, [registrationNumber]);

  if (!registrationNumber) return null;

  return (
    <div className="space-y-3">
      {/* 得意場ランキング */}
      <div className="rounded-xl bg-background/50 border border-border p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
          <span className="text-xs font-bold text-muted-foreground tracking-wider">得意場ランキング</span>
          <span className="text-[10px] text-muted-foreground/60 ml-auto">n≥8のみ</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-2"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
        ) : venueStats.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-2">サンプル不足（各場n≥8必要）</div>
        ) : (
          <div className="space-y-1.5">
            {venueStats.map((v, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className={cn("w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold",
                  i === 0 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground")}>{i + 1}</span>
                <span className="font-semibold flex-1">{jcdToName(v.venue_code)}</span>
                <span className="text-xs text-muted-foreground tabular-nums">n={v.boat1_races}</span>
                <span className="font-bold tabular-nums text-emerald-600 w-14 text-right">{fmtPct(v.boat1_win_rate, 0)}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums w-16 text-right">ういち{fmtPct(v.uichi_rate, 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 天候相性 */}
      <div className="rounded-xl bg-background/50 border border-border p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Cloud className="w-3.5 h-3.5 text-sky-600" />
          <span className="text-xs font-bold text-muted-foreground tracking-wider">天候相性</span>
          <span className="text-[10px] text-muted-foreground/60 ml-auto">n≥5のみ</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-2"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
        ) : weatherStats.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-2">サンプル不足（各条件n≥5必要）</div>
        ) : (
          <div className="space-y-1.5">
            {weatherStats.map((w, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="font-semibold flex-1">{w.weather} {w.wind_speed_group}m</span>
                <span className="text-xs text-muted-foreground tabular-nums">n={w.races}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{w.wins}勝</span>
                <span className={cn("font-bold tabular-nums w-14 text-right",
                  w.win_rate >= 0.6 ? "text-emerald-600" : w.win_rate >= 0.4 ? "text-sky-600" : "text-muted-foreground"
                )}>{fmtPct(w.win_rate, 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
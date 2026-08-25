import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Bell, Loader2, Clock } from "lucide-react";
import JudgmentBadge from "@/components/JudgmentBadge";
import { getAlerts, getSettings, getRacesByDate, getLatestOddsByDate, getAllResults, analyzeRacePure } from "@/lib/boatService";
import { base44 } from "@/api/base44Client";
import { GRADE_STYLE, fmtPct, fmtTime, fmtNum, canFinalJudge, minutesUntilDeadline } from "@/lib/boat";
import { cn } from "@/lib/utils";

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export default function Alerts() {
  const [loading, setLoading] = useState(true);
  const [todayAlerts, setTodayAlerts] = useState([]);
  const [tomorrowAlerts, setTomorrowAlerts] = useState([]);
  const [todayRaces, setTodayRaces] = useState([]);
  const [analyses, setAnalyses] = useState({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let m = true;
    (async () => {
      setLoading(true);
      try {
        const [s, past] = await Promise.all([getSettings(), getAllResults()]);
        const [todayR, tomA] = await Promise.all([getRacesByDate(dateStr(0)), getAlerts(dateStr(1))]);
        if (!m) return;
        setTodayRaces(todayR);
        setTomorrowAlerts(tomA);
        // today odds
        const om = await getLatestOddsByDate(dateStr(0));
        const ents = await base44.entities.RaceEntry.filter({ race_date: dateStr(0) }, "boat_number", 600);
        const byRace = {};
        for (const e of ents) (byRace[e.race_id] = byRace[e.race_id] || []).push(e);
        const an = {};
        for (const r of todayR) {
          const within5 = canFinalJudge(r.deadline);
          an[r.id] = analyzeRacePure(r, byRace[r.id] || [], om[r.id], past, s, om[r.id] ? "day" : "pre");
        }
        if (m) setAnalyses(an);
        // today alerts = BUY/WATCH within 5min
        const ta = todayR.filter((r) => canFinalJudge(r.deadline) && (an[r.id]?.judgment === "BUY" || an[r.id]?.judgment === "WATCH"));
        if (m) setTodayAlerts(ta);
      } finally {
        if (m) setLoading(false);
      }
    })();
    return () => { m = false; };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);

  if (loading) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" />読み込み中…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Bell className="w-5 h-5 text-amber-400" />
        <h1 className="text-xl font-bold">ういち買いアラート</h1>
      </div>

      {/* Today */}
      <section>
        <h2 className="text-sm font-bold mb-3 text-muted-foreground tracking-wider">本日のBUY/WATCH</h2>
        {todayAlerts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            現在BUY/WATCH判定のレースはありません
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {todayAlerts.map((r) => {
              const a = analyses[r.id];
              const mins = minutesUntilDeadline(r.deadline);
              return (
                <Link key={r.id} to={`/race/${r.id}`} className="rounded-2xl bg-card border border-border p-4 hover:border-primary/40">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold">{r.venue_name} {r.race_number}R</span>
                    <JudgmentBadge judgment={a.judgment} size="md" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Mini label="出現率" value={fmtPct(a.appearance_rate, 1)} />
                    <Mini label="合成オッズ" value={fmtNum(a.synthetic_odds, 2)} />
                    <Mini label="期待値" value={fmtNum(a.expected_value, 0) + "%"} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />締切 {fmtTime(r.deadline)}</span>
                    <span className="tabular-nums">{mins > 0 ? `あと${mins}分` : "締切"}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Tomorrow */}
      <section>
        <h2 className="text-sm font-bold mb-3 text-muted-foreground tracking-wider">明日の前日アラート候補</h2>
        {tomorrowAlerts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            前日出現率の高いレースはありません
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {tomorrowAlerts.map((al) => {
              const finalJudgeAt = new Date(new Date(al.deadline).getTime() - 5 * 60000);
              return (
                <Link key={al.id} to={`/race/${al.race_id}`} className="rounded-2xl bg-card border border-border p-4 hover:border-primary/40">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold">{al.venue_name} {al.race_number}R</span>
                    <span className={cn("text-base font-bold px-2 py-0.5 rounded border", GRADE_STYLE[al.pre_grade])}>{al.pre_grade}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">前日出現率</span>
                    <span className="font-bold tabular-nums text-primary text-lg">{fmtPct(al.pre_appearance_rate, 1)}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />締切 {fmtTime(al.deadline)}</span>
                    <span>最終判定予定 {fmtTime(finalJudgeAt.toISOString())}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div className="rounded-lg bg-background/50 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-bold tabular-nums">{value}</div>
    </div>
  );
}
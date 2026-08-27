import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Bell, Loader2, Clock } from "lucide-react";
import JudgmentBadge from "@/components/JudgmentBadge";
import RacerPhoto from "@/components/RacerPhoto";
import RacerDetailDialog from "@/components/RacerDetailDialog";
import { getAlerts, getSettings, getRacesByDate, getLatestOddsByDate, analyzeRaceWithSimilar } from "@/lib/boatService";
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
  const [racerDialog, setRacerDialog] = useState(null);
  const [tomorrowEntries, setTomorrowEntries] = useState({});

  useEffect(() => {
    let m = true;
    (async () => {
      setLoading(true);
      try {
        const s = await getSettings();
        const [todayR, tomA] = await Promise.all([getRacesByDate(dateStr(0)), getAlerts(dateStr(1))]);
        if (!m) return;
        setTodayRaces(todayR);
        setTomorrowAlerts(tomA);
        setLoading(false);

        // today odds + entries
        const [om, ents, tomEnts] = await Promise.all([
          getLatestOddsByDate(dateStr(0)),
          base44.entities.RaceEntry.filter({ race_date: dateStr(0) }, "boat_number", 600),
          base44.entities.RaceEntry.filter({ race_date: dateStr(1) }, "boat_number", 600),
        ]);
        if (!m) return;
        const byRace = {};
        for (const e of ents) (byRace[e.race_id] = byRace[e.race_id] || []).push(e);
        const tomByRace = {};
        for (const e of tomEnts) (tomByRace[e.race_id] = tomByRace[e.race_id] || []).push(e);
        if (m) setTomorrowEntries(tomByRace);

        // background analysis per race (getAllResults不使用・類似候補をDB側で絞り取得)
        const an = {};
        for (const r of todayR) {
          if (!m) return;
          try {
            an[r.id] = await analyzeRaceWithSimilar(r, byRace[r.id] || [], om[r.id], s, om[r.id] ? "day" : "pre");
            if (m) setAnalyses({ ...an });
          } catch {
            an[r.id] = null;
          }
        }

        // today alerts = BUY/WATCH within 5min
        const ta = todayR.filter((r) => canFinalJudge(r.deadline) && (an[r.id]?.judgment === "BUY" || an[r.id]?.judgment === "WATCH"));
        if (m) setTodayAlerts(ta);
      } catch {
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
        <Bell className="w-5 h-5 text-amber-500" />
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
                    <JudgmentBadge judgment={a?.judgment || "PENDING"} size="md" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Mini label="出現率" value={fmtPct(a?.appearance_rate, 1)} sub={`n=${a?.similar_count ?? "—"}`} />
                    <Mini label="合成オッズ" value={fmtNum(a?.synthetic_odds, 2)} />
                    <Mini label="期待値" value={fmtNum(a?.expected_value, 0) + "%"} />
                  </div>
                  {(a?.boat1 || a?.boat1_trust) && (
                    <div className="mt-2 flex items-center gap-3 rounded-lg bg-background/50 px-3 py-2">
                      <RacerPhoto
                        registrationNumber={a.boat1?.registration_number}
                        racerName={a.boat1?.racer_name}
                        size="sm"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRacerDialog({ entry: a.boat1, trust: a.boat1_trust }); }}
                        className="cursor-pointer hover:opacity-80 transition-opacity shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-sm truncate">{a.boat1?.racer_name || "1号艇"}</div>
                        <div className="flex items-center gap-1.5">
                          {a.boat1?.grade_class && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-700">{a.boat1.grade_class}</span>}
                          <span className="text-[10px] text-muted-foreground">1号艇信頼</span>
                        </div>
                      </div>
                      {a.boat1_trust && (
                        <div className="text-right shrink-0">
                          <span className={cn("text-xl font-bold tabular-nums",
                            a.boat1_trust.score >= 75 ? "text-emerald-600" :
                            a.boat1_trust.score >= 60 ? "text-sky-600" :
                            a.boat1_trust.score >= 45 ? "text-amber-600" : "text-rose-600"
                          )}>{a.boat1_trust.score}</span>
                          {a.boat1_trust.reasons?.length > 0 && (
                            <span className="ml-1 text-[10px] text-emerald-600 font-semibold">材料{a.boat1_trust.reasons.length}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
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
                  {(() => {
                    const b1 = tomorrowEntries[al.race_id]?.find(e => e.boat_number === 1);
                    return b1 ? (
                      <div className="mt-2 flex items-center gap-3 rounded-lg bg-background/50 px-3 py-2">
                        <RacerPhoto
                          registrationNumber={b1.registration_number}
                          racerName={b1.racer_name}
                          size="sm"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRacerDialog({ entry: b1, trust: null }); }}
                          className="cursor-pointer hover:opacity-80 transition-opacity shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-sm truncate">{b1.racer_name}</div>
                          <div className="flex items-center gap-1.5">
                            {b1.grade_class && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-700">{b1.grade_class}</span>}
                            <span className="text-[10px] text-muted-foreground tabular-nums">#{b1.registration_number}</span>
                          </div>
                        </div>
                      </div>
                    ) : null;
                  })()}
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

      <RacerDetailDialog
        open={!!racerDialog}
        onOpenChange={(open) => !open && setRacerDialog(null)}
        entry={racerDialog?.entry}
        trust={racerDialog?.trust}
      />
    </div>
  );
}

function Mini({ label, value, sub }) {
  return (
    <div className="rounded-lg bg-background/50 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}
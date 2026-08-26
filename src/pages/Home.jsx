import { useEffect, useState, useMemo } from "react";
import { Bell, Loader2, AlertCircle, CalendarClock, CheckCircle2 } from "lucide-react";
import RaceCard from "@/components/RaceCard";
import JudgmentBadge from "@/components/JudgmentBadge";
import {
  seedIfNeeded, getSettings, getRacesByDate, getLatestOddsByDate,
  getAlerts, analyzeRacePure, getAllResults, autoFetchTodayRaces,
} from "@/lib/boatService";
import { base44 } from "@/api/base44Client";
import { fmtPct, fmtNum, fmtTime, minutesUntilDeadline, canFinalJudge, GRADE_STYLE } from "@/lib/boat";
import { cn } from "@/lib/utils";

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export default function Home() {
  const [tab, setTab] = useState("today");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [races, setRaces] = useState([]);
  const [entriesByRace, setEntriesByRace] = useState({});
  const [oddsMap, setOddsMap] = useState({});
  const [pastResults, setPastResults] = useState([]);
  const [settings, setSettings] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [tick, setTick] = useState(0);
  const [autoFetchState, setAutoFetchState] = useState(null); // null|loading|done|error|no_venues

  useEffect(() => {
    let m = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        await seedIfNeeded();
        // 本日の開催データを自動取得（公式サイト・非同期・軽量スケジュールのみ）
        if (tab === "today") {
          setAutoFetchState("loading");
          try {
            const af = await autoFetchTodayRaces();
            setAutoFetchState(af.status === "success" ? "done" : af.status);
          } catch {
            setAutoFetchState("error");
          }
        }
        const [s, past] = await Promise.all([getSettings(), getAllResults()]);
        if (!m) return;
        setSettings(s);
        setPastResults(past);
        const date = tab === "today" ? dateStr(0) : dateStr(1);
        const [rs, al] = await Promise.all([getRacesByDate(date), getAlerts(date)]);
        if (!m) return;
        setRaces(rs);
        setAlerts(al);
        // entries for the day
        const ents = await base44.entities.RaceEntry.filter({ race_date: date }, "boat_number", 600);
        const byRace = {};
        for (const e of ents) {
          (byRace[e.race_id] = byRace[e.race_id] || []).push(e);
        }
        if (!m) return;
        setEntriesByRace(byRace);
        // odds for today
        if (tab === "today") {
          const om = await getLatestOddsByDate(date);
          if (m) setOddsMap(om);
        } else {
          setOddsMap({});
        }
      } catch (err) {
        if (m) setError(err.message || "データ取得失敗");
      } finally {
        if (m) setLoading(false);
      }
    })();
    return () => { m = false; };
  }, [tab]);

  // countdown ticker
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const analyses = useMemo(() => {
    if (!settings || !pastResults) return {};
    const out = {};
    for (const r of races) {
      const ents = entriesByRace[r.id] || [];
      const odds = oddsMap[r.id];
      const within5 = canFinalJudge(r.deadline);
      const stage = tab === "today" ? (within5 ? "final" : "day") : "pre";
      try {
        out[r.id] = analyzeRacePure(r, ents, odds, pastResults, settings, odds ? stage : "pre");
      } catch {
        out[r.id] = null;
      }
    }
    return out;
  }, [races, entriesByRace, oddsMap, pastResults, settings, tab, tick]);

  const sortedRaces = useMemo(() => {
    return [...races].sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  }, [races]);

  // alert races (today: BUY judged; tomorrow: pre-grade A/S)
  const alertRaces = useMemo(() => {
    return sortedRaces.filter((r) => {
      const a = analyses[r.id];
      if (tab === "today") {
        return canFinalJudge(r.deadline) && (a?.judgment === "BUY" || a?.judgment === "WATCH");
      }
      // tomorrow: from alerts
      return alerts.some((al) => al.race_id === r.id);
    });
  }, [sortedRaces, analyses, alerts, tab]);

  const alertMap = useMemo(() => {
    const m = {};
    for (const a of alerts) m[a.race_id] = a;
    return m;
  }, [alerts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> データを取得中…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600">
          <AlertCircle className="w-4 h-4" /> データ取得失敗：{error}
        </div>
      )}

      {/* 本日開催データ自動取得状況 */}
      {autoFetchState === "loading" && (
        <div className="flex items-center gap-2 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-700">
          <Loader2 className="w-4 h-4 animate-spin" /> 本日の開催データを自動取得中…
        </div>
      )}
      {autoFetchState === "done" && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <CheckCircle2 className="w-4 h-4" /> 本日の開催データを取得・キャッシュしました
        </div>
      )}
      {(autoFetchState === "error" || autoFetchState === "no_venues") && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <AlertCircle className="w-4 h-4" /> {autoFetchState === "no_venues" ? "本日は開催がありません" : "開催データ自動取得に失敗しました（再読込で再試行）"}
        </div>
      )}

      {/* 今日｜明日 toggle */}
      <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-card border border-border">
        {["today", "tomorrow"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "py-2.5 rounded-xl text-sm font-bold transition-colors",
              tab === t ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground"
            )}
          >
            {t === "today" ? "今日" : "明日"}
          </button>
        ))}
      </div>

      {/* Alert section */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Bell className="w-4 h-4 text-amber-500" />
          <h2 className="text-sm font-bold tracking-wide">{tab === "today" ? "本日のういち買いアラート" : "前日ういち買いアラート候補"}</h2>
          <span className="ml-auto text-xs text-muted-foreground">{alertRaces.length}件</span>
        </div>
        {alertRaces.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {tab === "today" ? "現在BUY/WATCH候補はありません" : "前日出現率の高いレースはありません"}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {alertRaces.map((r) => (
              <RaceCard key={r.id} race={r} analysis={analyses[r.id]} mode={tab} preGrade={alertMap[r.id]?.pre_grade} />
            ))}
          </div>
        )}
      </section>

      {/* All races */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <CalendarClock className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold tracking-wide">{tab === "today" ? "本日の全レース" : "明日の全レース"}</h2>
          <span className="ml-auto text-xs text-muted-foreground">{sortedRaces.length}レース</span>
        </div>
        {sortedRaces.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            該当するレースがありません
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {sortedRaces.map((r) => (
              <RaceCard key={r.id} race={r} analysis={analyses[r.id]} mode={tab} preGrade={alertMap[r.id]?.pre_grade} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
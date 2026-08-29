import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Bell, Loader2, AlertCircle, CalendarClock } from "lucide-react";
import RaceCard from "@/components/RaceCard";
import JudgmentBadge from "@/components/JudgmentBadge";
import {
  seedIfNeeded, getSettings, getRacesByDate,
  getAlerts,
  getBackfillProgressLight,
} from "@/lib/boatService";
import { getCachedAnalysesByDate, computeCacheHitRate } from "@/lib/analysisCache";
import { useFinalAutoJudge } from "@/hooks/useFinalAutoJudge";
import { fmtPct, fmtNum, fmtTime, minutesUntilDeadline, canFinalJudge, finalJudgeTime, GRADE_STYLE } from "@/lib/boat";
import { cn } from "@/lib/utils";
import { base44 } from "@/api/base44Client";

function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function Home() {
  const [tab, setTab] = useState("today");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [races, setRaces] = useState([]);
  const [settings, setSettings] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [analyses, setAnalyses] = useState({});
  const finalStatusMap = useFinalAutoJudge(
    tab === "today" ? races : [],
    analyses,
    (raceId, finalAn) => setAnalyses(prev => ({ ...prev, [raceId]: finalAn })),
    tab === "today"
  );
  const [tick, setTick] = useState(0);
  const [backfillProgress, setBackfillProgress] = useState(null);
  const [cacheHitRate, setCacheHitRate] = useState(null);

  useEffect(() => {
    let m = true;
    (async () => {
      const t0 = performance.now();
      setLoading(true);
      setError(null);
      setAnalyses({});
      try {
        await seedIfNeeded();
        const s = await getSettings();
        if (!m) return;
        setSettings(s);

        // バックフィル進捗（軽量・非ブロッキング）
        getBackfillProgressLight().then(p => { if (m) setBackfillProgress(p); }).catch(() => {});
        const date = tab === "today" ? dateStr(0) : dateStr(1);
        // Homeは保存済みキャッシュだけを読む。外部取得・補修・再分析はバックグラウンド処理へ分離。
        const [rs, al, cachedAn] = await Promise.all([
          getRacesByDate(date), getAlerts(date), getCachedAnalysesByDate(date),
        ]);

        if (!m) return;
        setRaces(rs);
        setAlerts(al);
        setAnalyses(cachedAn);
        setCacheHitRate(computeCacheHitRate(rs, cachedAn));
        setLoading(false);
        console.log(`[Home] 高速表示完了: ${Math.round(performance.now() - t0)}ms / races=${rs.length}`);
      } catch (err) {
        if (m) setError(err.message || "データ取得失敗");
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

  // 当日Homeで締切90分以内なのに分析未作成のレースが見えている場合、
  // バックグラウンド定期実行を待たず自己修復を1回だけ起動する。
  useEffect(() => {
    if (tab !== "today" || loading || races.length === 0) return;
    const now = Date.now();
    const urgentMissing = races.some(r => {
      if (analyses[r.id] || !r.deadline) return false;
      const d = new Date(r.deadline).getTime();
      return d >= now && d - now <= 90 * 60 * 1000;
    });
    if (!urgentMissing) return;

    const key = `boatworks_urgent_repair_${dateStr(0)}`;
    const last = Number(sessionStorage.getItem(key) || 0);
    if (now - last < 5 * 60 * 1000) return;
    sessionStorage.setItem(key, String(now));
    base44.functions.invoke("runUrgentEntryRepair", { race_date: dateStr(0), stage: "pre" })
      .catch(() => {});
  }, [tab, loading, races, analyses]);

  const sortedRaces = useMemo(() => {
    const now = Date.now();
    return [...races]
      .filter((r) => {
        if (tab !== "today") return true;
        if (!r.deadline) return true;
        if (new Date(r.deadline).getTime() > now) return true;
        // アラート対象レースは、公式結果取得でAlertがresolvedになるまでHomeに残す。
        const al = alerts.find((x) => x.race_id === r.id);
        return !!al && al.status !== "resolved";
      })
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  }, [races, alerts, tab, tick]);

  // alert races: 一度アラート対象になったレースは、BUY/WATCH/SKIPに関係なく結果確定まで表示する。
  const alertRaces = useMemo(() => {
    return sortedRaces.filter((r) => {
      if (tab === "today") {
        const al = alerts.find((x) => x.race_id === r.id);
        if (al && al.status !== "resolved") return true;
        const a = analyses[r.id];
        return a?.pre_grade === "S" || a?.pre_grade === "A";
      }
      return alerts.some((al) => al.race_id === r.id);
    });
  }, [sortedRaces, analyses, alerts, tab]);

  const alertMap = useMemo(() => {
    const m = {};
    for (const a of alerts) m[a.race_id] = a;
    return m;
  }, [alerts]);

  // 候補ランキング（保存済み分析のweighted_probability順・全場横断）
  const rankedRaces = useMemo(() => {
    return sortedRaces
      .filter(r => analyses[r.id] && analyses[r.id].appearance_rate != null)
      .sort((a, b) => (analyses[b.id]?.weighted_probability || 0) - (analyses[a.id]?.weighted_probability || 0));
  }, [sortedRaces, analyses]);

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

      {/* バックフィル進捗（小さな表示） */}
      {backfillProgress && backfillProgress.overall && backfillProgress.overall.rate < 0.99 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span>過去6か月データ補完中 {Math.round((backfillProgress.overall.rate || 0) * 100)}%</span>
          {backfillProgress.p1 && backfillProgress.p1.rate < 0.95 && (
            <span className="text-emerald-600 font-semibold">直近30日 {Math.round((backfillProgress.p1.rate || 0) * 100)}%</span>
          )}
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

      {/* キャッシュヒット率 */}
      {cacheHitRate != null && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
          <span className={cn("inline-block w-2 h-2 rounded-full", cacheHitRate >= 0.95 ? "bg-emerald-400" : "bg-amber-400")} />
          <span>分析キャッシュヒット率 <span className={cn("font-semibold tabular-nums", cacheHitRate >= 0.95 ? "text-emerald-600" : "text-amber-600")}>{Math.round(cacheHitRate * 100)}%</span></span>
        </div>
      )}

      {/* 候補ランキング（保存済み分析から全場横断） */}
      {rankedRaces.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-base">🏆</span>
            <h2 className="text-sm font-bold tracking-wide">{tab === "today" ? "本日の候補ランキング" : "明日の候補ランキング"}</h2>
            <span className="ml-auto text-xs text-muted-foreground">上位{Math.min(rankedRaces.length, 5)}件</span>
          </div>
          <div className="space-y-2">
            {rankedRaces.slice(0, 5).map((r, i) => {
              const a = analyses[r.id];
              return (
                <Link key={r.id} to={`/race/${r.id}`} className="flex items-center gap-3 rounded-2xl bg-card border border-border p-3 hover:border-primary/40">
                  <span className="text-lg font-bold w-7 text-center shrink-0">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm truncate">{r.venue_name} {r.race_number}R</div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">総合出現率 {fmtPct(a?.appearance_rate, 1)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-muted-foreground">1号艇信頼</div>
                    <div className={cn("text-lg font-bold tabular-nums leading-none",
                      a?.boat1_trust_score >= 75 ? "text-emerald-600" :
                      a?.boat1_trust_score >= 60 ? "text-sky-600" :
                      a?.boat1_trust_score >= 45 ? "text-amber-600" : "text-rose-600"
                    )}>{a?.boat1_trust_score ?? "—"}</div>
                  </div>
                  {a?.condition_match_score != null && (
                    <div className="text-right shrink-0">
                      <div className="text-xs text-muted-foreground">条件一致</div>
                      <div className="text-lg font-bold tabular-nums leading-none text-primary">{a.condition_match_score}%</div>
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Alert section */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Bell className="w-4 h-4 text-amber-500" />
          <h2 className="text-sm font-bold tracking-wide">{tab === "today" ? "本日のういち買いアラート" : "前日ういち買いアラート候補"}</h2>
          <span className="ml-auto text-xs text-muted-foreground">{alertRaces.length}件</span>
        </div>
        {tab === "today" && (
          <div className="text-[11px] text-muted-foreground mb-2">アラート対象は結果確定まで表示します。終了後の結果は下メニューの「検証」で確認できます。</div>
        )}
        {alertRaces.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {tab === "today" ? "現在アラート対象レースはありません" : "前日出現率の高いレースはありません"}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {alertRaces.map((r) => (
              <RaceCard key={r.id} race={r} analysis={analyses[r.id]} mode={tab} preGrade={alertMap[r.id]?.pre_grade} finalStatus={finalStatusMap[r.id]} />
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
              <RaceCard key={r.id} race={r} analysis={analyses[r.id]} mode={tab} preGrade={alertMap[r.id]?.pre_grade} finalStatus={finalStatusMap[r.id]} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
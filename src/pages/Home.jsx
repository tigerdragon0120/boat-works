import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Bell, Loader2, AlertCircle, CalendarClock } from "lucide-react";
import RaceCard from "@/components/RaceCard";
import JudgmentBadge from "@/components/JudgmentBadge";
import {
  seedIfNeeded, getSettings, getRacesByDate, getLatestOddsByDate,
  getAlerts,
  getBackfillProgressLight,
  autoFetchRacesForDate,
} from "@/lib/boatService";
import { getCachedAnalysesByDate, computeCacheHitRate, analyzeAllRacesForDate } from "@/lib/analysisCache";
import { useFinalAutoJudge } from "@/hooks/useFinalAutoJudge";
import { base44 } from "@/api/base44Client";
import { fmtPct, fmtNum, fmtTime, minutesUntilDeadline, canFinalJudge, finalJudgeTime, GRADE_STYLE } from "@/lib/boat";
import { cn } from "@/lib/utils";

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
  const [entriesByRace, setEntriesByRace] = useState({});
  const [oddsMap, setOddsMap] = useState({});
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
        // キャッシュ済み分析を先に取得（高速・再分析なし）
        let [rs, al, cachedAn, cachedPre] = await Promise.all([
          getRacesByDate(date), getAlerts(date), getCachedAnalysesByDate(date), getCachedAnalysesByDate(date, "pre"),
        ]);

        // 今日/明日とも公式の開催場一覧を再確認する。
        // 特に今日分は、前夜時点で未公開だった開催場が朝に追加されるため、
        // Raceが一部存在していても毎回軽量な開催場再確認を行い、不足場を補完する。
        try {
          const fetchedSchedule = await autoFetchRacesForDate(date);
          if (fetchedSchedule?.status === "success") {
            const refreshedRaces = await getRacesByDate(date);
            if (refreshedRaces.length !== rs.length || tab === "today") {
              rs = refreshedRaces;
              // 新規Race追加後に関連キャッシュも取り直す
              [al, cachedAn, cachedPre] = await Promise.all([
                getAlerts(date), getCachedAnalysesByDate(date), getCachedAnalysesByDate(date, "pre"),
              ]);
            }
            console.log(`[Home] 開催場再確認: venues=${fetchedSchedule.venues ?? "?"} races=${rs.length}`);
          }
        } catch (scheduleErr) {
          console.error(`[Home] ${tab === "today" ? "本日" : "明日"}スケジュール再確認失敗`, scheduleErr);
        }

        if (!m) return;
        setRaces(rs);
        setAlerts(al);
        setAnalyses(cachedAn);
        setCacheHitRate(computeCacheHitRate(rs, cachedAn));
        console.log(`[Home] Race+Alert+分析キャッシュ取得: ${Math.round(performance.now() - t0)}ms`);

        // 先に出走表を確認。6艇揃っていない未終了レースだけを補修する。
        // Homeを開くたび全場取得するのではなく、欠損レースだけ1回取得する。
        const nowMs = Date.now();
        let ents = await base44.entities.RaceEntry.filter({ race_date: date }, "boat_number", 2000);
        const countByRace = {};
        for (const e of ents) countByRace[e.race_id] = (countByRace[e.race_id] || 0) + 1;

        const activeRaces = rs.filter((r) => tab !== "today" || !r.deadline || new Date(r.deadline).getTime() > nowMs);
        const missingEntryIds = activeRaces.filter(r => (countByRace[r.id] || 0) < 6).map(r => r.id);

        if (missingEntryIds.length > 0) {
          try {
            const repairRes = await base44.functions.invoke("repairRaceEntries", {
              race_date: date,
              race_ids: missingEntryIds,
            });
            if (!m) return;
            const repair = repairRes?.data || repairRes;
            console.log(`[Home] 出走表欠損補修: 対象${missingEntryIds.length} / repaired=${repair?.repaired ?? 0} / errors=${repair?.errors ?? 0}`);
            // 補修後のRaceEntryを取り直す
            ents = await base44.entities.RaceEntry.filter({ race_date: date }, "boat_number", 2000);
          } catch (repairErr) {
            console.error("[Home] 出走表欠損補修失敗", repairErr);
          }
        }

        if (!m) return;
        const byRace = {};
        for (const e of ents) (byRace[e.race_id] = byRace[e.race_id] || []).push(e);
        setEntriesByRace(byRace);

        // 6艇揃ったレースだけをpre分析。出走表未完成レースは分析しない。
        const completeRaceIds = new Set(Object.entries(byRace).filter(([, list]) => list.length >= 6).map(([id]) => id));
        const missingPreIds = activeRaces
          .filter(r => completeRaceIds.has(r.id) && !cachedPre[r.id])
          .map(r => r.id);

        if (missingPreIds.length > 0) {
          try {
            const preResult = await analyzeAllRacesForDate(date, { stage: "pre", race_ids: missingPreIds, force: false });
            if (!m) return;
            if (preResult?.status === "error") throw new Error(preResult.message || "事前分析に失敗しました");
            const refreshed = await getCachedAnalysesByDate(date);
            if (!m) return;
            setAnalyses(refreshed);
            setCacheHitRate(computeCacheHitRate(rs, refreshed));
            console.log(`[Home] 不足pre分析完了: 対象${missingPreIds.length} / analyzed=${preResult?.analyzed ?? "?"} / errors=${preResult?.errors ?? "?"}`);
          } catch (preErr) {
            console.error("[Home] 不足pre分析失敗", preErr);
            if (m) setError(`事前分析の作成に失敗：${preErr?.message || "不明なエラー"}`);
          }
        }

        const om = tab === "today" ? await getLatestOddsByDate(date) : {};
        if (!m) return;
        setOddsMap(om);
        setLoading(false);
        console.log(`[Home] 初期表示完了: ${Math.round(performance.now() - t0)}ms (キャッシュヒット ${Math.round(computeCacheHitRate(rs, cachedAn)*100)}%)`);

        // Home表示時には外部データ自動取得を開始しない。
        // データ収集は日次処理・管理画面側で行い、Homeは保存済みデータを読むだけにする。
        // ※ 再分析は行わない。前夜の一括分析（analyzeAllRacesForDate）でUichiAnalysis保存済み。
        // キャッシュ欠損レースはnullのまま表示（RaceCardがPENDING表示）。
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

  const sortedRaces = useMemo(() => {
    const now = Date.now();
    return [...races]
      .filter((r) => tab !== "today" || !r.deadline || new Date(r.deadline).getTime() > now)
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  }, [races, tab, tick]);

  // 締切後15分だけ残す「直近の最終判定」。通常の全レース一覧には戻さない。
  const recentFinalRaces = useMemo(() => {
    if (tab !== "today") return [];
    const now = Date.now();
    const keepMs = 15 * 60 * 1000;
    return races
      .filter((r) => {
        if (!r.deadline) return false;
        const deadlineMs = new Date(r.deadline).getTime();
        if (deadlineMs > now || now - deadlineMs > keepMs) return false;
        const a = analyses[r.id];
        return a?.stage === "final" && a?.judgment && a.judgment !== "PENDING";
      })
      .sort((a, b) => new Date(b.deadline) - new Date(a.deadline));
  }, [races, analyses, tab, tick]);

  // alert races (today: BUY judged; tomorrow: pre-grade A/S)
  const alertRaces = useMemo(() => {
    return sortedRaces.filter((r) => {
      const a = analyses[r.id];
      if (tab === "today") {
        if (canFinalJudge(r.deadline)) {
          return a?.judgment === "BUY" || a?.judgment === "WATCH";
        }
        // 締切5分前までは事前評価S/Aを候補表示
        return a?.pre_grade === "S" || a?.pre_grade === "A";
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
        {alertRaces.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {tab === "today" ? "現在BUY/WATCH候補はありません" : "前日出現率の高いレースはありません"}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {alertRaces.map((r) => (
              <RaceCard key={r.id} race={r} analysis={analyses[r.id]} mode={tab} preGrade={alertMap[r.id]?.pre_grade} finalStatus={finalStatusMap[r.id]} />
            ))}
          </div>
        )}
      </section>

      {/* 締切後15分だけ表示する直近の最終判定 */}
      {tab === "today" && recentFinalRaces.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <CalendarClock className="w-4 h-4 text-sky-600" />
            <h2 className="text-sm font-bold tracking-wide">直近の最終判定</h2>
            <span className="ml-auto text-xs text-muted-foreground">締切後15分で自動非表示</span>
          </div>
          <div className="space-y-2">
            {recentFinalRaces.map((r) => {
              const a = analyses[r.id];
              return (
                <Link key={r.id} to={`/race/${r.id}`} className="flex items-center gap-3 rounded-2xl bg-card border border-border p-3 hover:border-primary/40">
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-sm">{r.venue_name} {r.race_number}R</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      最終判定 {fmtTime(finalJudgeTime(r.deadline))}
                    </div>
                  </div>
                  <div className="shrink-0"><JudgmentBadge judgment={a.judgment} /></div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-muted-foreground">合成オッズ</div>
                    <div className="font-bold tabular-nums">{a.synthetic_odds ? `${fmtNum(a.synthetic_odds, 2)}倍` : "—"}</div>
                  </div>
                  {a.judgment === "SKIP" && (a.similar_count || 0) < (settings?.min_similar_races || 30) && (
                    <div className="text-[11px] text-amber-600 shrink-0">データ不足</div>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      )}

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
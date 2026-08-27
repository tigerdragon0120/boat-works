import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Clock, Loader2, AlertCircle, History, Gauge, RefreshCw, Database } from "lucide-react";
import JudgmentBadge from "@/components/JudgmentBadge";
import StatTile from "@/components/StatTile";
import {
  getSettings, getEntries, getLatestOdds, getOddsHistory, analyzeRaceWithSimilar, fetchOfficialRace,
} from "@/lib/boatService";
import { base44 } from "@/api/base44Client";
import {
  UICHI_COMBOS, UICHI_LABEL, GRADE_STYLE, fmtPct, fmtNum, fmtTime, minutesUntilDeadline,
  canFinalJudge, JUDGMENT_STYLE, reliabilityGrade,
} from "@/lib/boat";
import { cn } from "@/lib/utils";

export default function RaceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [odds, setOdds] = useState(null);
  const [oddsHistory, setOddsHistory] = useState([]);
  const [settings, setSettings] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState(null);
  const [fetchMsg, setFetchMsg] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    setAnalysis(null);
    try {
      const s = await getSettings();
      const r = await base44.entities.Race.get(id);
      setSettings(s);
      setRace(r);
      const [ents, latestOdds, hist] = await Promise.all([
        getEntries(id), getLatestOdds(id), getOddsHistory(id),
      ]);
      setEntries(ents);
      setOdds(latestOdds);
      setOddsHistory(hist);
      setLoading(false);

      // Background analysis (getAllResults不使用・類似候補をDB側で絞り取得)
      try {
        const a = await analyzeRaceWithSimilar(r, ents, latestOdds, s, latestOdds ? "day" : "pre");
        setAnalysis(a);
      } catch {
        setAnalysis(null);
      }
    } catch (e) {
      setError(e.message || "データ取得失敗");
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> 読み込み中…
      </div>
    );
  }
  if (error || !race) {
    return (
      <div className="space-y-3">
        <button onClick={() => nav(-1)} className="text-sm text-muted-foreground flex items-center gap-1"><ArrowLeft className="w-4 h-4" />戻る</button>
        <div className="flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-600">
          <AlertCircle className="w-4 h-4" /> {error || "レースが見つかりません"}
        </div>
      </div>
    );
  }

  const mins = minutesUntilDeadline(race.deadline);
  const within5 = canFinalJudge(race.deadline);
  const boat1 = entries.find((e) => e.boat_number === 1);
  const isOfficial = race.data_source === "official";

  const handleRefetch = async () => {
    setFetching("loading");
    setFetchMsg(null);
    try {
      const res = await fetchOfficialRace(race.race_date, race.venue_code, race.race_number);
      if (res?.status === "success") {
        setFetching("done");
        setFetchMsg(`再取得成功：${res.entries}艇・オッズ${res.odds_count}通り・合成${fmtNum(res.synthetic_odds, 2)}倍`);
        setReloadKey((k) => k + 1);
      } else {
        setFetching("error");
        setFetchMsg(res?.message || "実データ取得失敗");
      }
    } catch (e) {
      setFetching("error");
      setFetchMsg(e?.message || "実データ取得失敗");
    }
  };

  return (
    <div className="space-y-5">
      <button onClick={() => nav(-1)} className="text-sm text-muted-foreground flex items-center gap-1 hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> 戻る
      </button>

      {/* Race header */}
      <div className="rounded-2xl bg-gradient-to-br from-card to-background border border-border p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold tracking-tight">{race.venue_name}</span>
              <span className="text-lg text-muted-foreground">{race.race_number}R</span>
              {isOfficial ? (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300">LIVE</span>
              ) : (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-300">SAMPLE</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{race.race_name} · {race.grade}</div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1 text-sm text-muted-foreground justify-end">
              <Clock className="w-3.5 h-3.5" /> 締切 <span className="tabular-nums text-foreground font-semibold">{fmtTime(race.deadline)}</span>
            </div>
            {mins != null && (
              <div className={cn("text-xs mt-1 tabular-nums", mins <= 5 ? "text-amber-600" : "text-muted-foreground")}>
                {mins > 0 ? `最終判定まで ${mins}分` : "締切"}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 実データ取得状況（公式データ時） */}
      {isOfficial && (
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-600" />
              <h3 className="text-sm font-bold">実データ取得状況</h3>
            </div>
            <button
              onClick={handleRefetch}
              disabled={fetching === "loading"}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-60"
            >
              {fetching === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {fetching === "loading" ? "取得中…" : "再取得"}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-background/50 px-3 py-2">
              <div className="text-muted-foreground">出走表取得</div>
              <div className="font-semibold tabular-nums">{race.entries_fetched_at ? fmtTime(race.entries_fetched_at) : "—"}</div>
            </div>
            <div className="rounded-xl bg-background/50 px-3 py-2">
              <div className="text-muted-foreground">オッズ取得</div>
              <div className="font-semibold tabular-nums">{race.odds_fetched_at ? fmtTime(race.odds_fetched_at) : "—"}</div>
            </div>
          </div>
          {fetchMsg && (
            <div className={cn(
              "mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm",
              fetching === "done" ? "bg-emerald-50 text-emerald-700 border border-emerald-300"
                : "bg-rose-50 text-rose-700 border border-rose-300"
            )}>
              {fetchMsg}
            </div>
          )}
        </div>
      )}

      {/* Final judgment */}
      <div className="rounded-2xl bg-card border border-border p-5 text-center">
        <div className="text-xs text-muted-foreground tracking-wider mb-2">最終判定</div>
        {within5 && analysis?.judgment && analysis.judgment !== "PENDING" ? (
          <JudgmentBadge judgment={analysis.judgment} size="xl" />
        ) : (
          <div className="space-y-1">
            <JudgmentBadge judgment="PENDING" size="lg" />
            {mins != null && mins > 0 && (
              <div className="text-sm text-muted-foreground">最終判定まで <span className="text-foreground font-bold tabular-nums">{mins}分</span></div>
            )}
            <div className="text-[11px] text-muted-foreground">締切5分前から判定表示</div>
          </div>
        )}
      </div>

      {/* Big 3 stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="ういち出現率" value={fmtPct(analysis?.appearance_rate, 1)} accent="primary"
          sub={`類似 ${analysis?.similar_count ?? "—"}件 / 的中 ${analysis?.uichi_hits ?? "—"}件`} />
        <StatTile label="合成オッズ" value={within5 && odds ? fmtNum(analysis?.synthetic_odds, 2) : "—"} accent="emerald" unit={within5 && odds ? "倍" : ""} />
        <StatTile label="期待値指数" value={within5 && odds ? fmtNum(analysis?.expected_value, 0) + "%" : "—"} accent="amber" />
      </div>

      {/* データ品質指標 */}
      {analysis && (
        <div className="rounded-xl bg-card border border-border p-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-[10px] text-muted-foreground tracking-wider">有効サンプル</div>
              <div className="text-lg font-bold tabular-nums">n={analysis.similar_count ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground tracking-wider">データ充足率</div>
              <div className="text-lg font-bold tabular-nums text-primary">{fmtPct(analysis.data_sufficiency, 0)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground tracking-wider">分析信頼度</div>
              <div className={cn("text-lg font-bold",
                analysis.reliability === "A" ? "text-emerald-600" :
                analysis.reliability === "B" ? "text-sky-600" :
                analysis.reliability === "C" ? "text-amber-600" :
                "text-rose-600"
              )}>{analysis.reliability || "—"}</div>
            </div>
          </div>
          {analysis.is_reference && (
            <div className="mt-2 text-center text-xs text-amber-600 font-semibold">
              ※ データ不足のため参考値として表示中
            </div>
          )}
        </div>
      )}

      {!analysis?.min_similar_ok && analysis && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> データ不足：類似レースが{settings?.min_similar_races || 30}件未満です。出現率は参考値です。
        </div>
      )}

      {/* 1号艇評価 */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <Gauge className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-bold">1号艇評価</h3>
        </div>
        <div className="flex items-center gap-4">
          <div className={cn("text-5xl font-bold w-16 h-16 flex items-center justify-center rounded-2xl border-2", GRADE_STYLE[analysis?.boat1_grade || "D"])}>
            {analysis?.boat1_grade || "—"}
          </div>
          <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <Stat label="級別" value={boat1?.grade_class || "—"} />
            <Stat label="全国勝率" value={fmtNum(boat1?.national_win_rate, 2)} />
            <Stat label="当地勝率" value={fmtNum(boat1?.local_win_rate, 2)} />
            <Stat label="平均ST" value={fmtNum(boat1?.avg_st, 2)} />
            <Stat label="1C 1着率" value={fmtNum(boat1?.c1_win_rate, 1) + "%"} />
            <Stat label="1C 2連率" value={fmtNum(boat1?.c1_2rate, 1) + "%"} />
            <Stat label="F数" value={boat1?.f_count ?? "—"} />
            <Stat label="展示" value={fmtNum(boat1?.exhibition_time, 2)} />
          </div>
        </div>
      </div>

      {/* 6点オッズ */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold">ういち買い6点（{UICHI_LABEL}）</h3>
          <span className="text-xs text-muted-foreground">合成 {fmtNum(analysis?.synthetic_odds, 2)}倍</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {UICHI_COMBOS.map((c) => {
            const key = "odds_" + c.replace(/-/g, "_");
            const val = odds?.[key];
            return (
              <div key={c} className="rounded-xl bg-background/50 px-3 py-2 flex items-center justify-between">
                <span className="text-sm font-mono font-semibold">{c}</span>
                <span className="text-lg font-bold tabular-nums text-primary">{val ? fmtNum(val, 1) : "—"}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* オッズ履歴 */}
      {oddsHistory.length > 0 && (
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2 mb-3">
            <History className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-bold">オッズ推移</h3>
          </div>
          <div className="space-y-1.5">
            {oddsHistory.map((o) => (
              <div key={o.id} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{fmtTime(o.captured_at)} <span className="text-[10px]">({o.stage})</span></span>
                <span className="tabular-nums">合成 {fmtNum(o.synthetic_odds, 2)}倍</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 出走表 */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <h3 className="text-sm font-bold mb-3">出走表</h3>
        <div className="space-y-1.5">
          {entries.map((e) => (
            <div key={e.id} className="flex items-center gap-3 text-sm py-1.5 border-b border-border/50 last:border-0">
              <span className="w-6 h-6 rounded-md bg-primary/15 text-primary font-bold flex items-center justify-center text-xs">{e.boat_number}</span>
              <span className="font-semibold flex-1 truncate">{e.racer_name}</span>
              <span className="text-xs text-muted-foreground">{e.grade_class}</span>
              <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">全国{fmtNum(e.national_win_rate, 2)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">ST{fmtNum(e.avg_st, 2)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Clock, Loader2, AlertCircle, History, Gauge, RefreshCw, Database } from "lucide-react";
import JudgmentBadge from "@/components/JudgmentBadge";
import StatTile from "@/components/StatTile";
import TrustScoreCard from "@/components/TrustScoreCard";
import BuyReasonCard from "@/components/BuyReasonCard";
import EvaluationReasonCard from "@/components/EvaluationReasonCard";
import PlayerStructureCard from "@/components/PlayerStructureCard";
import RacerPhoto from "@/components/RacerPhoto";
import RacerDetailDialog from "@/components/RacerDetailDialog";
import {
  getSettings, getEntries, getLatestOdds, getOddsHistory, fetchOfficialRace,
  getBoat1TrustScore,
} from "@/lib/boatService";
import { getCachedAnalysesForRace, analyzeRaceFinal } from "@/lib/analysisCache";
import { base44 } from "@/api/base44Client";
import {
  UICHI_COMBOS, URA_UICHI_COMBOS, NEW_UICHI_COMBOS, NEW_URA_UICHI_COMBOS, UICHI_LABEL, GRADE_STYLE, fmtPct, fmtNum, fmtTime, fmtTimeSec, minutesUntilDeadline,
  canFinalJudge, JUDGMENT_STYLE, reliabilityGrade, trustScoreColor, finalJudgeTime,
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
  const [trust, setTrust] = useState(null);
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState(null);
  const [fetchMsg, setFetchMsg] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [racerOpen, setRacerOpen] = useState(false);
  const [preAnalysis, setPreAnalysis] = useState(null);
  const [venuePatternRates, setVenuePatternRates] = useState(null);
  const [seriesPoint, setSeriesPoint] = useState(null);
  const [raceResult, setRaceResult] = useState(null);

  // キャッシュ済みUichiAnalysis → 表示用オブジェクト変換
  const cachedToObjects = (cached, s) => {
    if (!cached) return { analysis: null, trust: null };
    const trust = {
      score: cached.boat1_trust_score,
      reliability: cached.reliability,
      reasons: cached.reasons || [],
      concerns: cached.concerns || [],
      condition_match: { score: cached.condition_match_score, conditions: cached.condition_matches || [] },
      components: cached.trust_components || [],
      sample_size: (cached.total_pool || 0),
    };
    const analysis = {
      judgment: cached.judgment,
      appearance_rate: cached.appearance_rate,
      similar_count: cached.similar_count,
      uichi_hits: cached.uichi_hits,
      synthetic_odds: cached.synthetic_odds,
      expected_value: cached.expected_value,
      boat1_grade: cached.boat1_grade,
      data_sufficiency: cached.data_sufficiency,
      reliability: cached.reliability,
      min_similar_ok: cached.min_similar_ok,
      is_reference: (cached.data_sufficiency ?? 0) < 0.5 || (cached.similar_count || 0) < (s?.min_buy_sample || 100),
      boat1_trust: trust,
      total_pool: cached.total_pool,
      valid_pool: cached.valid_pool,
      stage: cached.stage,
      pre_grade: cached.pre_grade,
      ura_uichi_rate: cached.ura_uichi_rate,
      new_uichi_rate: cached.new_uichi_rate,
      new_ura_uichi_rate: cached.new_ura_uichi_rate,
      recommended_pattern: cached.recommended_pattern,
      recommended_rate: cached.recommended_rate,
      recommended_pattern_label: cached.recommended_pattern_label,
      recommended_bets: cached.recommended_bets || [],
      pattern_scores: cached.pattern_scores || {},
      captured_at: cached.captured_at,
    };
    return { analysis, trust };
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setTrust(null);
    setPreAnalysis(null);
    setSeriesPoint(null);
    setRaceResult(null);
    try {
      const s = await getSettings();
      const r = await base44.entities.Race.get(id);
      setSettings(s);
      setRace(r);
      const [ents, latestOdds, hist, byStage, results, vrs] = await Promise.all([
        getEntries(id), getLatestOdds(id), getOddsHistory(id), getCachedAnalysesForRace(id),
        base44.entities.RaceResult.filter({ race_id: id }, "-finished_at", 1).catch(() => []),
        base44.entities.RaceResult.filter({ venue_code: r.venue_code, race_number: Number(r.race_number), data_source: "official" }, "-race_date", 500).catch(() => []),
      ]);
      const historical = vrs || [];
      const newMainHits = historical.filter(x => Number(x.result_1) === 1 && [3,4,5,6].includes(Number(x.result_2)) && Number(x.result_3) === 2).length;
      const newUraHits = historical.filter(x => Number(x.result_1) === 2 && Number(x.result_2) === 1 && [3,4,5,6].includes(Number(x.result_3))).length;
      setVenuePatternRates(historical.length ? { new_uichi_rate: newMainHits / historical.length, new_ura_uichi_rate: newUraHits / historical.length } : null);
      setRaceResult(results?.[0] || null);
      setEntries(ents);
      const b1 = (ents || []).find(e => Number(e.boat_number) === 1);
      if (r.series_key && b1?.registration_number) {
        try {
          const sp = await base44.entities.SeriesRacerPoint.filter({
            series_key: r.series_key,
            registration_number: String(b1.registration_number),
          }, "-snapshot_at", 1);
          setSeriesPoint(sp?.[0] || null);
        } catch {}
      }
      setOdds(latestOdds);
      setOddsHistory(hist);
      setLoading(false);

      // 保存済み分析を使用（再分析なし）
      const within5 = canFinalJudge(r.deadline);
      const finalCached = byStage.final;
      const preCached = byStage.pre;
      // final が保存済みなら締切時刻に関係なく最優先で表示する。
      // 画面側の時刻判定とWorker実行時刻がずれても、確定済み判定を隠さない。
      const chosen = finalCached || preCached;
      if (preCached) setPreAnalysis(preCached);
      if (chosen) {
        const { analysis, trust } = cachedToObjects(chosen, s);
        setAnalysis(analysis);
        setTrust(trust);
      } else {
        // キャッシュ欠損時のみフォールバック（個別取得）
        try {
          const t = await getBoat1TrustScore(id);
          if (t?.status === "success") setTrust(t);
        } catch {}
      }

      // final取得・分析はバックエンド Final Judge Worker に一本化。
      // 詳細画面を開いただけでは公式サイトへ再アクセスしない。
      const finalNeedsUpdate = within5 && (!finalCached || finalCached.judgment === "PENDING");
      if (finalNeedsUpdate) {
        setFetching("waiting");
        setFetchMsg("最終オッズを自動取得中…（バックエンドで処理）");
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
    // 時刻表示だけでなく、最終判定待ち中はDBのfinal判定も自動再読込する。
    const t = setInterval(() => {
      setTick((x) => x + 1);
      if (canFinalJudge(race?.deadline)) setReloadKey((k) => k + 1);
    }, 15000);
    return () => clearInterval(t);
  }, [race?.deadline]);

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

  const finalAt = finalJudgeTime(race.deadline);
  const mins = finalAt ? Math.max(0, Math.ceil((finalAt.getTime() - Date.now()) / 60000)) : null;
  const within5 = canFinalJudge(race.deadline);
  const boat1 = entries.find((e) => e.boat_number === 1);

  // DBのfinal保存が一巡遅れても、取得済み120通り実オッズから合成オッズ/EVを即時計算して表示する。
  const PATTERN_COMBOS = {
    MAIN: ['1-2-5','1-2-6','1-3-5','1-3-6','1-4-5','1-4-6'],
    URA: ['1-5-2','1-5-3','1-5-4','1-6-2','1-6-3','1-6-4'],
    NEW_MAIN: ['1-3-2','1-4-2','1-5-2','1-6-2'],
    NEW_URA: ['2-1-3','2-1-4','2-1-5','2-1-6'],
  };
  const displayCombos = PATTERN_COMBOS[analysis?.recommended_pattern] || [];
  const displayOddsValues = displayCombos.map(c => Number(odds?.all_trifecta_odds?.[c])).filter(v => Number.isFinite(v) && v > 1);
  const fallbackSynth = displayOddsValues.length === displayCombos.length && displayOddsValues.length > 0
    ? 1 / displayOddsValues.reduce((s, v) => s + 1 / v, 0) : null;
  const displaySynth = Number(analysis?.synthetic_odds) > 0 ? Number(analysis.synthetic_odds) : fallbackSynth;
  const displayEv = analysis?.expected_value != null ? Number(analysis.expected_value)
    : (displaySynth && Number(analysis?.recommended_rate) > 0 ? Number(analysis.recommended_rate) * displaySynth * 100 : null);
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
              <div className={cn("text-xs mt-1 tabular-nums", mins <= 10 ? "text-amber-600" : "text-muted-foreground")}>
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

      {/* 判定表示: final > 事前評価 > 未作成 */}
      <div className="rounded-2xl bg-card border border-border p-5 text-center">
        {(raceResult?.is_finished || raceResult?.result_status === "RESULT_FINAL" || race.result_trifecta) && (
          <div className="mb-4 pb-4 border-b border-border">
            <div className="text-xs text-muted-foreground tracking-wider mb-1">レース結果</div>
            <div className="text-3xl font-black tabular-nums">{raceResult?.result_trifecta || race.result_trifecta || "—"}</div>
            {(raceResult?.payout != null || race.payout_trifecta != null) && (
              <div className="text-sm font-bold text-emerald-600 mt-1">{Math.round(raceResult?.payout ?? race.payout_trifecta).toLocaleString()}円</div>
            )}
            {raceResult?.winning_method && <div className="text-xs text-muted-foreground mt-1">決まり手 {raceResult.winning_method}</div>}
          </div>
        )}
        {analysis?.stage === "final" && analysis.judgment && analysis.judgment !== "PENDING" ? (
          <>
            <div className="text-xs text-muted-foreground tracking-wider mb-2">最終判定</div>
            <JudgmentBadge judgment={analysis.judgment} size="xl" />
            {analysis.captured_at && (
              <div className="text-[11px] text-muted-foreground mt-2">最終オッズ取得 <span className="tabular-nums">{fmtTimeSec(analysis.captured_at)}</span></div>
            )}
          </>
        ) : analysis ? (
          <>
            <div className="text-xs text-muted-foreground tracking-wider mb-2">事前評価</div>
            {analysis.program_scenario_status === "PLAYER_BREAK" || analysis.program_scenario_status === "NEUTRAL" ? (
              <div>
                <span className="text-2xl font-bold px-5 py-2 rounded-xl border-2 inline-block border-rose-300 bg-rose-50 text-rose-700">見送り候補</span>
                <div className="text-xs text-muted-foreground mt-1">元評価 {analysis.pre_grade || "—"}</div>
              </div>
            ) : analysis.program_scenario_status === "MOTOR_BREAK" ? (
              <div>
                <span className="text-2xl font-bold px-5 py-2 rounded-xl border-2 inline-block border-amber-300 bg-amber-50 text-amber-700">慎重</span>
                <div className="text-xs text-muted-foreground mt-1">元評価 {analysis.pre_grade || "—"}</div>
              </div>
            ) : (
              <span className={cn("text-3xl font-bold px-5 py-2 rounded-xl border-2 inline-block", GRADE_STYLE[analysis.pre_grade] || GRADE_STYLE.D)}>{analysis.pre_grade || "—"}</span>
            )}
            {mins != null && (
              <div className="text-sm text-muted-foreground mt-2">
                最終判定予定 <span className="text-foreground font-bold tabular-nums">{fmtTime(finalAt)}</span>
                <span className="ml-1.5">{mins > 0 ? `（あと${mins}分）` : "（最終判定中…）"}</span>
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-muted-foreground">分析データ未作成</div>
        )}
      </div>

      {/* 前日→直前 比較 */}
      {preAnalysis && analysis?.stage === "final" && (
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2 mb-3">
            <History className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-bold">前日→直前 評価比較</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-background/50 p-3">
              <div className="text-[10px] text-muted-foreground tracking-wider mb-1">前日評価 (pre)</div>
              <div className="flex items-center gap-2">
                <span className={cn("text-base font-bold px-2 py-0.5 rounded border", GRADE_STYLE[preAnalysis.pre_grade])}>{preAnalysis.pre_grade || "—"}</span>
                <span className="text-xs text-muted-foreground">出現率 {fmtPct(preAnalysis.appearance_rate, 1)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1 tabular-nums">信頼 {preAnalysis.boat1_trust_score ?? "—"} / 条件 {preAnalysis.condition_match_score ?? "—"}%</div>
            </div>
            <div className="rounded-xl bg-background/50 p-3">
              <div className="text-[10px] text-muted-foreground tracking-wider mb-1">直前評価 (final)</div>
              <div className="flex items-center gap-2">
                <JudgmentBadge judgment={analysis.judgment} size="sm" />
                <span className="text-xs text-muted-foreground">EV {fmtNum(analysis.expected_value, 0)}%</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1 tabular-nums">信頼 {analysis.boat1_trust?.score ?? "—"} / オッズ {fmtNum(analysis.synthetic_odds, 2)}倍</div>
            </div>
          </div>
          {analysis.judgment === "BUY" && preAnalysis.pre_grade && (preAnalysis.pre_grade === "B" || preAnalysis.pre_grade === "C") && (
            <div className="mt-2 text-xs text-emerald-600 font-semibold flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> 前日→直前で評価上昇（オッズ改善・条件一致度上昇の可能性）
            </div>
          )}
        </div>
      )}

      {/* Big 3 stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="ういち出現率" value={fmtPct(analysis?.appearance_rate, 1)} accent="primary"
          sub={`類似 ${analysis?.similar_count ?? "—"}件 / 的中 ${analysis?.uichi_hits ?? "—"}件`} />
        <StatTile label="合成オッズ" value={odds && displaySynth ? fmtNum(displaySynth, 2) : "—"} accent="emerald" unit={odds && displaySynth ? "倍" : ""} />
        <StatTile label="期待値指数" value={odds && displayEv != null ? fmtNum(displayEv, 0) + "%" : "—"} accent="amber" />
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

      {/* 1号艇選手（写真 + 詳細 + 信頼スコア） */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="flex items-center gap-2 mb-3">
          <Gauge className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-bold">1号艇選手</h3>
        </div>
        <div className="flex items-start gap-4">
          <div className="relative shrink-0">
            <RacerPhoto
              registrationNumber={boat1?.registration_number}
              racerName={boat1?.racer_name}
              size="xl"
              lazy={false}
              onClick={() => setRacerOpen(true)}
              className="cursor-pointer hover:opacity-80 transition-opacity"
            />
            {analysis?.boat1_grade && (
              <span className={cn("absolute -bottom-1 -right-1 text-xs font-bold w-7 h-7 flex items-center justify-center rounded-full border-2 border-card", GRADE_STYLE[analysis.boat1_grade])}>
                {analysis.boat1_grade}
              </span>
            )}
          </div>
          <div className="flex-1 space-y-2">
            <div>
              <div className="text-xl font-bold">{boat1?.racer_name || "—"}</div>
              <div className="text-sm text-muted-foreground tabular-nums">登録番号 {boat1?.registration_number || "—"}</div>
              <div className="flex items-center gap-2 mt-1">
                {boat1?.grade_class && (
                  <span className="text-xs font-bold px-2 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-700">{boat1.grade_class}</span>
                )}
                {boat1?.branch && <span className="text-xs text-muted-foreground">{boat1.branch}支部</span>}
                {Number(race?.series_day || 1) >= 2 && seriesPoint?.series_score != null && (
                  <span className="text-xs font-bold px-2 py-0.5 rounded border border-violet-300 bg-violet-50 text-violet-700 tabular-nums">
                    節間ポイント {Number(seriesPoint.series_score).toFixed(1)}
                    {seriesPoint.series_sample_confidence != null ? `・信頼${Math.round(seriesPoint.series_sample_confidence)}%` : ""}
                  </span>
                )}
              </div>
            </div>
            {(trust || analysis?.boat1_trust) && (
              <div className="flex items-center gap-3 rounded-lg bg-background/50 px-3 py-2">
                <div>
                  <div className="text-[10px] text-muted-foreground tracking-wider">1号艇信頼</div>
                  <div className={cn("text-xl font-bold tabular-nums", trustScoreColor((trust || analysis?.boat1_trust)?.score))}>
                    {(trust || analysis?.boat1_trust)?.score ?? "—"}
                  </div>
                </div>
                {trust?.condition_match && (
                  <div>
                    <div className="text-[10px] text-muted-foreground tracking-wider">条件一致度</div>
                    <div className="text-xl font-bold tabular-nums">{trust.condition_match.score}%</div>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
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
      </div>

      {/* 1号艇信頼スコア（フル版・DB履歴データ使用） */}
      <TrustScoreCard trust={trust || analysis?.boat1_trust} />

      {/* 評価理由カード（スコア算出の具体的要因） */}
      <EvaluationReasonCard trust={trust || analysis?.boat1_trust} />

      {/* 買える理由カード + 不安材料 */}
      <BuyReasonCard trust={trust || analysis?.boat1_trust} />

      {/* 選手配置指数（ういち・裏ういち） */}
      <PlayerStructureCard raceId={id} race={race} entries={entries} />

      {/* 4型・全買い目オッズ */}
      <div className="rounded-2xl bg-card border border-border p-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold">4型 全買い目・オッズ</h3>
            <div className="text-[11px] text-muted-foreground mt-0.5">推奨型だけでなく、4型すべてを常時表示</div>
          </div>
          {analysis?.recommended_pattern_label && <span className="text-xs font-bold px-2 py-1 rounded-lg bg-primary/10 text-primary">推奨 {analysis.recommended_pattern_label}</span>}
        </div>
        {[
          {key:'MAIN',label:'ういち目',notation:'1-234-56',rate:analysis?.appearance_rate,combos:UICHI_COMBOS},
          {key:'URA',label:'裏ういち目',notation:'1-56-234',rate:analysis?.ura_uichi_rate,combos:URA_UICHI_COMBOS},
          {key:'NEW_MAIN',label:'新ういち目',notation:'1-3456-2',rate:(Number(venuePatternRates?.new_uichi_rate) > 0 ? Number(venuePatternRates.new_uichi_rate) : analysis?.new_uichi_rate),combos:NEW_UICHI_COMBOS},
          {key:'NEW_URA',label:'新裏ういち目',notation:'2-1-3456',rate:(Number(venuePatternRates?.new_ura_uichi_rate) > 0 ? Number(venuePatternRates.new_ura_uichi_rate) : analysis?.new_ura_uichi_rate),combos:NEW_URA_UICHI_COMBOS},
        ].map(p => {
          const values=p.combos.map(c=>Number(odds?.all_trifecta_odds?.[c] ?? odds?.['odds_'+c.replace(/-/g,'_')])).filter(v=>Number.isFinite(v)&&v>0);
          const synth=values.length===p.combos.length ? 1/values.reduce((sum,v)=>sum+1/v,0) : null;
          const recommended=analysis?.recommended_pattern===p.key;
          return <div key={p.key} className={cn('rounded-xl border p-3',recommended?'border-primary bg-primary/5':'border-border bg-background/30')}>
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="flex items-center gap-2 flex-wrap"><span className="font-bold text-sm">{p.label}</span><span className="font-mono text-xs text-muted-foreground">{p.notation}</span>{recommended&&<span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-primary text-primary-foreground">推奨</span>}</div>
              <div className="text-right text-xs"><span className="font-bold">出現率 {fmtPct(p.rate,1)}</span><span className="ml-2 text-muted-foreground">合成 {synth?fmtNum(synth,2)+'倍':'—'}</span></div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {p.combos.map(c=>{const val=odds?.all_trifecta_odds?.[c] ?? odds?.['odds_'+c.replace(/-/g,'_')];return <div key={c} className="rounded-lg bg-card px-3 py-2 flex items-center justify-between"><span className="text-sm font-mono font-semibold">{c}</span><span className="text-base font-bold tabular-nums text-primary">{val?fmtNum(val,1):'—'}</span></div>})}
            </div>
          </div>
        })}
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

      {/* 出走表 — BOAT WORKS 2 と同じ情報密度 */}
      <div className="rounded-2xl bg-card border border-border overflow-hidden">
        <div className="px-4 pt-4 pb-3"><h3 className="text-sm font-bold">出走表</h3></div>
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[42px_250px_48px_58px_90px_90px_48px] gap-2 px-4 py-2 bg-muted/35 text-[10px] text-muted-foreground font-semibold">
              <span>枠</span><span>選手名</span><span className="text-center">FL</span><span className="text-center">ST</span><span className="text-center">全国勝率</span><span className="text-center">当地勝率</span><span className="text-center">評価</span>
            </div>
            {entries.map((e) => (
              <div key={e.id} className={cn("grid grid-cols-[42px_250px_48px_58px_90px_90px_48px] gap-2 items-center px-4 py-3 border-t border-border/60 text-sm", e.boat_number === 3 && "bg-rose-50/55", e.boat_number === 5 && "bg-amber-50/55", e.boat_number === 6 && "bg-emerald-50/55")}>
                <span className="w-8 h-8 rounded-lg bg-primary/15 text-primary font-bold flex items-center justify-center">{e.boat_number}</span>
                <div className="flex items-center gap-2 min-w-0">
                  <RacerPhoto registrationNumber={e.registration_number} racerName={e.racer_name} size="sm" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0"><span className="font-bold truncate">{e.racer_name || "—"}</span><span className="font-semibold truncate text-xs">{e.branch || ""}</span><span className="px-1.5 py-0.5 rounded bg-slate-700 text-white text-[10px] font-bold">{e.grade_class || "—"}</span></div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">登録{e.registration_number || "—"}</div>
                  </div>
                </div>
                <span className="text-center tabular-nums">{e.f_count ? "F"+e.f_count : e.l_count ? "L"+e.l_count : "—"}</span>
                <span className="text-center tabular-nums font-semibold">{fmtNum(e.avg_st, 2)}</span>
                <div className="text-center"><div className="font-bold tabular-nums">{fmtNum(e.national_win_rate, 2)}</div>{e.national_2rate != null && <div className="text-[10px] text-muted-foreground">2連{fmtNum(e.national_2rate, 2)}%</div>}</div>
                <div className="text-center"><div className="font-bold tabular-nums">{fmtNum(e.local_win_rate, 2)}</div>{e.local_2rate != null && <div className="text-[10px] text-muted-foreground">2連{fmtNum(e.local_2rate, 2)}%</div>}</div>
                <span className="text-center font-bold text-amber-500">{e.evaluation_score != null ? Math.round(e.evaluation_score) : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 展示情報 */}
      <div className="rounded-2xl bg-card border border-border p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-bold">展示情報</h3>
            <div className="text-[11px] text-muted-foreground mt-0.5">展示前評価から直前評価へ変化した根拠を確認</div>
          </div>
          <span className={cn(
            "text-[10px] font-bold px-2 py-1 rounded-full border",
            race.exhibition_ready ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-slate-50 text-slate-500 border-slate-300"
          )}>{race.exhibition_ready ? "取得済み" : "待機中"}</span>
        </div>

        {race.exhibition_ready ? (
          <>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4 text-center">
              <ExhibitWeather label="天候" value={race.weather || "—"} />
              <ExhibitWeather label="風向" value={race.wind_dir || "—"} />
              <ExhibitWeather label="風速" value={race.wind_speed != null ? `${race.wind_speed}m` : "—"} />
              <ExhibitWeather label="波高" value={race.wave_height != null ? `${race.wave_height}cm` : "—"} />
              <ExhibitWeather label="気温" value={race.air_temperature != null ? `${race.air_temperature}℃` : "—"} />
              <ExhibitWeather label="水温" value={race.water_temperature != null ? `${race.water_temperature}℃` : "—"} />
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-[620px]">
                <div className="grid grid-cols-[44px_1fr_62px_78px_72px_62px_58px] gap-2 px-2 pb-2 text-[10px] text-muted-foreground font-semibold">
                  <span>艇</span><span>選手</span><span className="text-center">進入</span><span className="text-center">展示T</span><span className="text-center">展示ST</span><span className="text-center">チルト</span><span className="text-center">順位</span>
                </div>
                {entries.map((e) => (
                  <div key={`ex-${e.id}`} className={cn(
                    "grid grid-cols-[44px_1fr_62px_78px_72px_62px_58px] gap-2 items-center px-2 py-2.5 text-sm border-t border-border/60",
                    e.boat_number === 1 && "bg-primary/5"
                  )}>
                    <span className="w-7 h-7 rounded-lg bg-primary/15 text-primary font-bold flex items-center justify-center text-xs">{e.boat_number}</span>
                    <span className="font-semibold truncate">{e.racer_name}</span>
                    <span className="text-center tabular-nums font-semibold">{e.entry_course ?? "—"}</span>
                    <span className="text-center tabular-nums font-semibold">{e.exhibition_time != null ? fmtNum(e.exhibition_time, 2) : "—"}</span>
                    <span className={cn("text-center tabular-nums font-semibold", String(e.exhibition_st_raw || "").startsWith("F") && "text-rose-600")}>{e.exhibition_st_raw || (e.exhibition_st != null ? fmtNum(e.exhibition_st, 2) : "—")}</span>
                    <span className="text-center tabular-nums">{e.tilt != null ? fmtNum(e.tilt, 1) : "—"}</span>
                    <span className="text-center tabular-nums font-bold">{e.exhibition_rank ?? "—"}</span>
                  </div>
                ))}
              </div>
            </div>
            {race.beforeinfo_fetched_at && <div className="mt-3 text-[10px] text-muted-foreground text-right">展示取得 {fmtTimeSec(race.beforeinfo_fetched_at)}</div>}
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-background/40 px-4 py-6 text-center">
            <div className="text-sm font-semibold text-muted-foreground">展示情報待機中</div>
            <div className="text-xs text-muted-foreground mt-1">展示公開後、進入・展示タイム・展示ST・チルト・自然条件を自動表示します</div>
          </div>
        )}
      </div>

      <RacerDetailDialog open={racerOpen} onOpenChange={setRacerOpen} entry={boat1} trust={trust || analysis?.boat1_trust} />
    </div>
  );
}

function ExhibitWeather({ label, value }) {
  return (
    <div className="rounded-xl bg-background/50 px-2 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-bold tabular-nums mt-0.5">{value}</div>
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
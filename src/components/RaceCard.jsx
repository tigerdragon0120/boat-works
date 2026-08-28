import { useState } from "react";
import { Link } from "react-router-dom";
import { Clock, ChevronRight, Loader2, AlertCircle } from "lucide-react";
import JudgmentBadge from "./JudgmentBadge";
import RacerPhoto from "./RacerPhoto";
import RacerDetailDialog from "./RacerDetailDialog";
import { GRADE_STYLE, fmtPct, fmtNum, fmtTime, fmtTimeSec, minutesUntilDeadline, trustScoreColor, finalJudgeTime } from "@/lib/boat";
import { cn } from "@/lib/utils";

// race: Race, analysis: UichiAnalysis（cached）, mode: today|tomorrow, finalStatus: {status: fetching|failed|done}
export default function RaceCard({ race, analysis, mode = "today", preGrade, finalStatus }) {
  const [racerOpen, setRacerOpen] = useState(false);
  const mins = minutesUntilDeadline(race.deadline);

  const hasFinal = analysis?.stage === "final";
  const hasPre = analysis && !hasFinal;
  const effectivePreGrade = analysis?.pre_grade || preGrade;

  const racerName = analysis?.boat1_racer_name;
  const regNum = analysis?.boat1_registration_number;
  const gradeClass = analysis?.boat1_grade_class;
  const trustScore = analysis?.boat1_trust_score;
  const conditionMatch = analysis?.condition_match_score;

  const dialogEntry = analysis ? { registration_number: regNum, racer_name: racerName, grade_class: gradeClass } : null;
  const dialogTrust = analysis ? { score: trustScore, reasons: analysis.reasons, concerns: analysis.concerns, condition_match: { score: conditionMatch, conditions: analysis.condition_matches } } : null;

  const finalJudgeAt = finalJudgeTime(race.deadline);
  const isFetching = finalStatus?.status === "fetching";
  const isFailed = finalStatus?.status === "failed";

  return (
    <>
      <Link to={`/race/${race.id}`} className="block rounded-2xl bg-card border border-border p-4 hover:border-primary/40 transition-colors group">
        {/* header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold tracking-tight">{race.venue_name}</span>
            <span className="text-sm text-muted-foreground">{race.race_number}R</span>
            {race.data_source === "official" ? (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300">LIVE</span>
            ) : (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-300">SAMPLE</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="w-3.5 h-3.5" />
            <span className="tabular-nums">{fmtTime(race.deadline)}</span>
          </div>
        </div>

        {hasFinal ? (
          /* === 最終判定 === */
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <JudgmentBadge judgment={analysis.judgment} size="md" />
              {analysis.expected_value != null && (
                <span className="text-xs text-muted-foreground">EV <span className="text-foreground font-bold tabular-nums">{fmtNum(analysis.expected_value, 0)}%</span></span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <CardStat label="ういち率" value={fmtPct(analysis.appearance_rate, 1)} sub={`n=${analysis.similar_count ?? "—"}`} />
              <CardStat label="合成オッズ" value={fmtNum(analysis.synthetic_odds, 2)} unit="倍" accent="primary" />
              <CardStat label="期待値" value={fmtNum(analysis.expected_value, 0) + "%"} accent="emerald" />
            </div>
            {racerName && (
              <RacerBlock racerName={racerName} regNum={regNum} gradeClass={gradeClass} trustScore={trustScore} reasons={analysis.reasons} concerns={analysis.concerns} onPhotoClick={() => setRacerOpen(true)} />
            )}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>最終オッズ取得 <span className="tabular-nums">{fmtTimeSec(analysis.captured_at)}</span></span>
              <span className="text-primary/70 group-hover:translate-x-0.5 transition-transform flex items-center gap-0.5">詳細 <ChevronRight className="w-3 h-3" /></span>
            </div>
          </div>
        ) : hasPre ? (
          /* === 事前評価 === */
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">事前評価</span>
              <span className={cn("text-lg font-bold px-2 py-0.5 rounded border", GRADE_STYLE[effectivePreGrade] || GRADE_STYLE.D)}>{effectivePreGrade || "—"}</span>
              {isFetching && (
                <span className="flex items-center gap-1 text-xs text-primary font-semibold">
                  <Loader2 className="w-3 h-3 animate-spin" /> 最新オッズ取得中…
                </span>
              )}
              {isFailed && (
                <span className="flex items-center gap-1 text-xs text-amber-600 font-semibold">
                  <AlertCircle className="w-3 h-3" /> オッズ取得失敗
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <CardStat label="ういち本線" value={fmtPct(analysis.appearance_rate, 1)} sub="1-234-56" />
              <CardStat label="裏ういち" value={analysis.ura_uichi_rate != null ? fmtPct(analysis.ura_uichi_rate, 1) : "—"} sub="1-56-234" accent="amber" />
              <CardStat label="方向指数" value={analysis.uichi_direction_index != null ? `${analysis.uichi_direction_index > 0 ? "+" : ""}${analysis.uichi_direction_index}` : "—"} sub={`${analysis.uichi_direction_label || "中立"}${analysis.uichi_direction_confidence != null ? ` / 信頼${analysis.uichi_direction_confidence}` : ""}`} accent={(analysis.uichi_direction_index ?? 0) < -24 ? "amber" : (analysis.uichi_direction_index ?? 0) > 24 ? "sky" : "primary"} />
              <CardStat label="1号艇信頼" value={trustScore ?? "—"} accent={trustScore >= 75 ? "emerald" : trustScore >= 60 ? "sky" : "amber"} />
              <CardStat label="推奨" value={analysis.recommended_pattern === "MAIN" ? "本線" : analysis.recommended_pattern === "URA" ? "裏" : "中立"} sub={analysis.recommended_pattern === "MAIN" ? "1-234-56" : analysis.recommended_pattern === "URA" ? "1-56-234" : "見送り候補"} accent={analysis.recommended_pattern === "URA" ? "amber" : analysis.recommended_pattern === "MAIN" ? "sky" : "primary"} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <LayerStat
                label="① 番組意図"
                value={analysis.program_hypothesis === "MAIN" ? "本線" : analysis.program_hypothesis === "URA" ? "裏" : "中立"}
                score={analysis.program_intent_confidence}
                sub={analysis.program_hypothesis === "URA" ? `裏${analysis.program_ura_intent ?? "—"}` : analysis.program_hypothesis === "MAIN" ? `本線${analysis.program_main_intent ?? "—"}` : `本${analysis.program_main_intent ?? "—"} / 裏${analysis.program_ura_intent ?? "—"}`}
              />
              <LayerStat
                label="② 選手成立"
                value={analysis.recommended_pattern === "URA" ? analysis.racer_ura_execution : analysis.recommended_pattern === "MAIN" ? analysis.racer_main_execution : analysis.racer_escape_execution}
                score={analysis.racer_escape_execution}
                sub={`1号艇逃げ力 ${analysis.racer_escape_execution ?? "—"}`}
              />
              <LayerStat
                label="③ モーター"
                value={analysis.recommended_pattern === "URA" ? analysis.motor_ura_support : analysis.recommended_pattern === "MAIN" ? analysis.motor_main_support : analysis.motor_boat1_support}
                score={analysis.motor_boat1_support}
                sub={`1号艇足 ${analysis.motor_boat1_support ?? "—"}`}
              />
            </div>
            {racerName && (
              <RacerBlock racerName={racerName} regNum={regNum} gradeClass={gradeClass} trustScore={trustScore} reasons={analysis.reasons} concerns={analysis.concerns} onPhotoClick={() => setRacerOpen(true)} />
            )}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>最終判定予定 <span className="tabular-nums">{finalJudgeAt ? fmtTime(finalJudgeAt.toISOString()) : "—"}</span></span>
              <span className="text-primary/70 group-hover:translate-x-0.5 transition-transform flex items-center gap-0.5">詳細 <ChevronRight className="w-3 h-3" /></span>
            </div>
          </div>
        ) : (
          /* === 分析データ未作成 === */
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {isFetching ? (
                <><Loader2 className="w-4 h-4 animate-spin text-primary" /> 最新オッズ取得中…</>
              ) : (
                <><AlertCircle className="w-4 h-4" /> 分析データ未作成</>
              )}
            </div>
            {finalJudgeAt && !isFetching && (
              <div className="text-[11px] text-muted-foreground">最終判定予定 <span className="tabular-nums">{fmtTime(finalJudgeAt.toISOString())}</span></div>
            )}
          </div>
        )}
      </Link>
      <RacerDetailDialog open={racerOpen} onOpenChange={setRacerOpen} entry={dialogEntry} trust={dialogTrust} />
    </>
  );
}

function CardStat({ label, value, sub, unit, accent }) {
  const accentColor = {
    primary: "text-primary",
    emerald: "text-emerald-600",
    sky: "text-sky-600",
    amber: "text-amber-600",
  };
  return (
    <div className="rounded-xl bg-background/50 px-3 py-2">
      <div className="text-[10px] text-muted-foreground tracking-wider">{label}</div>
      <div className={cn("text-xl font-bold tabular-nums", accent ? accentColor[accent] : "text-foreground")}>
        {value}{unit && <span className="text-xs ml-0.5">{unit}</span>}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

function LayerStat({ label, value, score, sub }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 px-3 py-2">
      <div className="text-[10px] font-semibold text-muted-foreground tracking-wider">{label}</div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <span className="text-base font-bold tabular-nums">{value ?? "—"}</span>
        {score != null && <span className="text-[10px] text-muted-foreground">信頼{score}</span>}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}

function RacerBlock({ racerName, regNum, gradeClass, trustScore, reasons, concerns, onPhotoClick }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-background/50 px-3 py-2.5">
      <RacerPhoto
        registrationNumber={regNum}
        racerName={racerName}
        size="sm"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPhotoClick(); }}
        className="cursor-pointer hover:opacity-80 transition-opacity shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm truncate">{racerName || "1号艇"}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {gradeClass && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-700">{gradeClass}</span>}
          {regNum && <span className="text-[10px] text-muted-foreground tabular-nums">#{regNum}</span>}
        </div>
      </div>
      {trustScore != null && (
        <div className="text-right shrink-0">
          <div className="text-[10px] text-muted-foreground tracking-wider">1号艇信頼</div>
          <div className={cn("text-2xl font-bold tabular-nums leading-none", trustScoreColor(trustScore))}>{trustScore}</div>
          <div className="flex items-center gap-1 mt-0.5 justify-end">
            {reasons?.length > 0 && <span className="text-[10px] text-emerald-600 font-semibold">材料{reasons.length}</span>}
            {concerns?.length > 0 && <span className="text-[10px] text-amber-600 font-semibold">注意{concerns.length}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
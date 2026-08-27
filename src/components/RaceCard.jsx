import { useState } from "react";
import { Link } from "react-router-dom";
import { Clock, ChevronRight } from "lucide-react";
import JudgmentBadge from "./JudgmentBadge";
import RacerPhoto from "./RacerPhoto";
import RacerDetailDialog from "./RacerDetailDialog";
import { GRADE_STYLE, fmtPct, fmtNum, fmtTime, canFinalJudge, minutesUntilDeadline, trustScoreColor, trustScoreLabel } from "@/lib/boat";
import { cn } from "@/lib/utils";

// race: Race, analysis: 分析結果, mode: today|tomorrow, preGrade: 前日評価(S/A/B/C)
export default function RaceCard({ race, analysis, mode = "today", preGrade }) {
  const [racerOpen, setRacerOpen] = useState(false);
  const within5 = canFinalJudge(race.deadline);
  const canJudge = mode === "today" && within5 && analysis?.judgment && analysis.judgment !== "PENDING";
  const showOdds = mode === "today" && within5 && analysis?.synthetic_odds > 0;
  const mins = minutesUntilDeadline(race.deadline);
  const boat1 = analysis?.boat1;
  const trust = analysis?.boat1_trust;

  return (
    <>
      <Link
        to={`/race/${race.id}`}
        className="block rounded-2xl bg-card border border-border p-4 hover:border-primary/40 transition-colors group"
      >
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
            {analysis?.boat1_grade && (
              <span className={cn("text-[11px] font-bold px-1.5 py-0.5 rounded border", GRADE_STYLE[analysis.boat1_grade])}>
                1号 {analysis.boat1_grade}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="w-3.5 h-3.5" />
            <span className="tabular-nums">{fmtTime(race.deadline)}</span>
          </div>
        </div>

        {/* judgment row */}
        <div className="flex items-center gap-3 mb-3">
          {canJudge ? (
            <JudgmentBadge judgment={analysis.judgment} size="md" />
          ) : mode === "tomorrow" && preGrade ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">前日評価</span>
              <span className={cn("text-lg font-bold px-2 py-0.5 rounded border", GRADE_STYLE[preGrade])}>{preGrade}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <JudgmentBadge judgment="PENDING" size="sm" />
              {mins != null && mins > 0 && (
                <span className="text-xs text-muted-foreground">最終判定まで <span className="text-foreground font-semibold tabular-nums">{mins}分</span></span>
              )}
            </div>
          )}
          {showOdds && analysis.expected_value != null && (
            <span className="ml-auto text-[11px] text-muted-foreground">EV <span className="text-foreground font-semibold tabular-nums">{fmtNum(analysis.expected_value, 0)}%</span></span>
          )}
        </div>

        {/* big stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-background/50 px-3 py-2">
            <div className="text-[10px] text-muted-foreground tracking-wider">出現率</div>
            <div className="text-xl font-bold tabular-nums text-foreground">{fmtPct(analysis?.appearance_rate, 1)}</div>
            {analysis?.similar_count != null && (
              <div className="text-[10px] text-muted-foreground tabular-nums">n={analysis.similar_count}</div>
            )}
          </div>
          <div className="rounded-xl bg-background/50 px-3 py-2">
            <div className="text-[10px] text-muted-foreground tracking-wider">合成オッズ</div>
            <div className="text-xl font-bold tabular-nums text-primary">{showOdds ? fmtNum(analysis.synthetic_odds, 2) : "—"}</div>
          </div>
          <div className="rounded-xl bg-background/50 px-3 py-2">
            <div className="text-[10px] text-muted-foreground tracking-wider">期待値</div>
            <div className="text-xl font-bold tabular-nums text-emerald-600">{showOdds ? fmtNum(analysis.expected_value, 0) + "%" : "—"}</div>
          </div>
        </div>

        {/* 1号艇選手ブロック: 写真 + 名前 + 信頼スコア */}
        {(boat1 || trust) && (
          <div className="mt-2 flex items-center gap-3 rounded-xl bg-background/50 px-3 py-2.5">
            <RacerPhoto
              registrationNumber={boat1?.registration_number}
              racerName={boat1?.racer_name}
              size="sm"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRacerOpen(true); }}
              className="cursor-pointer hover:opacity-80 transition-opacity shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-sm truncate">{boat1?.racer_name || "1号艇"}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                {boat1?.grade_class && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-700">{boat1.grade_class}</span>
                )}
                {boat1?.registration_number && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">#{boat1.registration_number}</span>
                )}
              </div>
            </div>
            {trust && (
              <div className="text-right shrink-0">
                <div className="text-[10px] text-muted-foreground tracking-wider">1号艇信頼</div>
                <div className={cn("text-2xl font-bold tabular-nums leading-none", trustScoreColor(trust.score))}>{trust.score}</div>
                <div className="flex items-center gap-1 mt-0.5 justify-end">
                  {trust.reasons?.length > 0 && <span className="text-[10px] text-emerald-600 font-semibold">材料{trust.reasons.length}</span>}
                  {trust.concerns?.length > 0 && <span className="text-[10px] text-amber-600 font-semibold">注意{trust.concerns.length}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            類似 {analysis?.similar_count ?? "—"}件 / 的中 {analysis?.uichi_hits ?? "—"}件
            {analysis?.reliability && (
              <span className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-bold",
                analysis.reliability === "A" ? "bg-emerald-100 text-emerald-700" :
                analysis.reliability === "B" ? "bg-sky-100 text-sky-700" :
                analysis.reliability === "C" ? "bg-amber-100 text-amber-700" :
                "bg-rose-100 text-rose-700"
              )}>
                {analysis.reliability}
              </span>
            )}
            {analysis?.is_reference && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-600">参考値</span>
            )}
          </span>
          <span className="text-primary/70 group-hover:translate-x-0.5 transition-transform flex items-center gap-0.5">詳細 <ChevronRight className="w-3 h-3" /></span>
        </div>
      </Link>
      <RacerDetailDialog open={racerOpen} onOpenChange={setRacerOpen} entry={boat1} trust={trust} />
    </>
  );
}
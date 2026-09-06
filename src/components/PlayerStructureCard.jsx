import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Users, RefreshCw, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// スコア色分け
function scoreColor(score) {
  if (score == null) return "text-muted-foreground";
  if (score >= 80) return "text-emerald-600";
  if (score >= 70) return "text-sky-600";
  if (score >= 60) return "text-amber-600";
  return "text-rose-600";
}
function scoreBg(score) {
  if (score == null) return "bg-muted";
  if (score >= 80) return "bg-emerald-100 text-emerald-700 border-emerald-300";
  if (score >= 70) return "bg-sky-100 text-sky-700 border-sky-300";
  if (score >= 60) return "bg-amber-100 text-amber-700 border-amber-300";
  return "bg-rose-100 text-rose-700 border-rose-300";
}

const TYPE_LABELS = {
  IN_SPECIALIST: "イン逃げ特化",
  MID_SECOND_SPECIALIST: "中枠2着特化",
  MID_THIRD_SPECIALIST: "中枠3着特化",
  UICHI_OUTSIDE_SPECIALIST: "ういち外枠3着",
  URA_UICHI_OUTSIDE_SPECIALIST: "裏ういち外枠2着",
  OUTSIDE_DANGER: "外枠一着危険",
  UNSTABLE: "着順不安定",
};

export default function PlayerStructureCard({ raceId, race, entries }) {
  const [structure, setStructure] = useState(null);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState(null);

  const loadStructure = async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = await base44.entities.RacePlayerStructure.filter(
        { race_id: raceId }, "-created_date", 1
      );
      if (existing.length > 0) {
        setStructure(existing[0]);
      } else {
        // 存在しない場合は計算
        await computeStructure();
      }
    } catch (e) {
      setError(e?.message || "取得失敗");
    } finally {
      setLoading(false);
    }
  };

  const computeStructure = async () => {
    setComputing(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("computeRacePlayerStructure", {
        race_id: raceId,
        race_date: race?.race_date,
        venue_code: race?.venue_code,
        venue_name: race?.venue_name,
        race_number: race?.race_number,
      });
      setStructure(res.data);
    } catch (e) {
      const errMsg = e?.response?.data?.message || e?.message || "計算失敗";
      setError(errMsg);
    } finally {
      setComputing(false);
    }
  };

  useEffect(() => {
    if (raceId) loadStructure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> 選手配置指数を取得中…
        </CardContent>
      </Card>
    );
  }

  if (error && !structure) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center gap-2 text-sm text-rose-600 mb-3">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
          <button
            onClick={computeStructure}
            disabled={computing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-60"
          >
            {computing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            計算する
          </button>
        </CardContent>
      </Card>
    );
  }

  if (!structure) return null;

  const uichi = structure.uichi_player_structure_score;
  const ura = structure.ura_uichi_player_structure_score;
  const ub = structure.uichi_breakdown || {};
  const urab = structure.ura_uichi_breakdown || {};
  const boats = structure.boat_evaluations || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" /> 選手配置指数
          </CardTitle>
          <button
            onClick={computeStructure}
            disabled={computing}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {computing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            再計算
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ういち・裏ういち スコア */}
        <div className="grid grid-cols-2 gap-3">
          <div className={cn("rounded-xl border p-3 text-center", scoreBg(uichi))}>
            <div className="text-[10px] tracking-wider">ういち 1-234-56</div>
            <div className="text-3xl font-bold tabular-nums">{uichi ?? "—"}</div>
            <div className="text-[10px] opacity-80">選手配置指数</div>
          </div>
          <div className={cn("rounded-xl border p-3 text-center", scoreBg(ura))}>
            <div className="text-[10px] tracking-wider">裏ういち 1-56-234</div>
            <div className="text-3xl font-bold tabular-nums">{ura ?? "—"}</div>
            <div className="text-[10px] opacity-80">選手配置指数</div>
          </div>
        </div>

        {/* ういち構成詳細 */}
        <div className="rounded-xl bg-background/50 border border-border p-3 space-y-2">
          <div className="text-xs font-bold text-foreground">ういち構成</div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">① 1号艇イン逃げ</span>
            <span className={cn("font-bold tabular-nums", scoreColor(ub.in_strength))}>{ub.in_strength ?? "—"}</span>
          </div>
          <CandidateRow label="② 中枠2着候補" candidates={ub.mid_second_candidates} />
          <CandidateRow label="③ 外枠3着候補" candidates={ub.outside_third_candidates} />
          {ub.risk_factors?.length > 0 && (
            <div className="pt-1 space-y-0.5">
              {ub.risk_factors.map((r, i) => (
                <div key={i} className="text-[11px] text-rose-600 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {r.type === "NO_MID_SECOND_CANDIDATE" ? "中枠に2着候補不在" :
                   r.type === "NO_OUTSIDE_THIRD_CANDIDATE" ? "外枠に3着候補不在" :
                   r.boat ? `${r.boat}号艇${TYPE_LABELS[r.type] || r.type}` : (TYPE_LABELS[r.type] || r.type)}
                  <span className="tabular-nums">(-{r.penalty})</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 裏ういち構成詳細 */}
        <div className="rounded-xl bg-background/50 border border-border p-3 space-y-2">
          <div className="text-xs font-bold text-foreground">裏ういち構成</div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">① 1号艇イン逃げ</span>
            <span className={cn("font-bold tabular-nums", scoreColor(urab.in_strength))}>{urab.in_strength ?? "—"}</span>
          </div>
          <CandidateRow label="② 外枠2着候補" candidates={urab.outside_second_candidates} />
          <CandidateRow label="③ 中枠3着候補" candidates={urab.mid_third_candidates} />
          {urab.risk_factors?.length > 0 && (
            <div className="pt-1 space-y-0.5">
              {urab.risk_factors.map((r, i) => (
                <div key={i} className="text-[11px] text-rose-600 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {r.type === "NO_OUTSIDE_SECOND_CANDIDATE" ? "外枠に2着候補不在" :
                   r.type === "NO_MID_THIRD_CANDIDATE" ? "中枠に3着候補不在" :
                   r.boat ? `${r.boat}号艇${TYPE_LABELS[r.type] || r.type}` : (TYPE_LABELS[r.type] || r.type)}
                  <span className="tabular-nums">(-{r.penalty})</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 各艇評価一覧 */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="bg-muted/50 px-3 py-1.5 text-xs font-bold">各艇評価</div>
          <div className="divide-y divide-border/50">
            {boats.map((b) => (
              <div key={b.boat_number} className="grid grid-cols-[32px_1fr_44px_44px_44px_44px] gap-1 px-2 py-2 items-center text-xs">
                <span className="w-6 h-6 rounded-md bg-primary/15 text-primary font-bold flex items-center justify-center">{b.boat_number}</span>
                <span className="font-semibold truncate">{b.racer_name || "—"}</span>
                <ScoreCell label="IN" value={b.in_strength} />
                <ScoreCell label="中2" value={b.mid_second} />
                <ScoreCell label="中3" value={b.mid_third} />
                <ScoreCell label="外3" value={b.outside_third} />
                <ScoreCell label="外2" value={b.outside_second} />
              </div>
            ))}
          </div>
          {boats.some(b => b.player_types?.length > 0) && (
            <div className="px-3 py-2 space-y-1 border-t border-border/50">
              {boats.filter(b => b.player_types?.length > 0).map((b) => (
                <div key={b.boat_number} className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-bold">{b.boat_number}号艇</span>
                  {b.player_types.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded border border-violet-300 bg-violet-50 text-violet-700">
                      {TYPE_LABELS[t] || t}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="text-xs text-rose-600 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CandidateRow({ label, candidates }) {
  if (!candidates || candidates.length === 0) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-xs text-rose-600">不在</span>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {candidates.map((c) => (
          <span key={c.boat_number} className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-xs">
            <span className="w-4 h-4 rounded bg-primary/15 text-primary font-bold flex items-center justify-center text-[10px]">{c.boat_number}</span>
            <span className="font-semibold truncate max-w-[60px]">{c.racer_name || "—"}</span>
            <span className={cn("font-bold tabular-nums", scoreColor(c.score))}>{c.score ?? "—"}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ScoreCell({ label, value }) {
  return (
    <div className="text-center">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={cn("font-bold tabular-nums", scoreColor(value))}>{value ?? "—"}</div>
    </div>
  );
}
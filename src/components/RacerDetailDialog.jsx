import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RacerPhoto from "./RacerPhoto";
import { fmtNum, trustScoreColor, trustScoreLabel } from "@/lib/boat";
import { cn } from "@/lib/utils";

// 選手詳細カード（写真タップで表示）
// 現在: エントリーデータ + 信頼スコアを表示
// 将来拡張: 得意場・1号艇成績・天候別成績（プレースホルダー表示）
export default function RacerDetailDialog({ open, onOpenChange, entry, trust }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>選手詳細</DialogTitle>
        </DialogHeader>
        {entry ? (
          <div className="space-y-4">
            {/* Photo + basic info */}
            <div className="flex items-center gap-4">
              <RacerPhoto
                registrationNumber={entry.registration_number}
                racerName={entry.racer_name}
                size="xl"
                lazy={false}
              />
              <div className="space-y-1">
                <div className="text-xl font-bold">{entry.racer_name || "—"}</div>
                <div className="text-sm text-muted-foreground tabular-nums">登録番号 {entry.registration_number || "—"}</div>
                <div className="flex items-center gap-2">
                  {entry.grade_class && (
                    <span className="text-xs font-bold px-2 py-0.5 rounded border border-sky-300 bg-sky-50 text-sky-700">{entry.grade_class}</span>
                  )}
                  {entry.branch && <span className="text-xs text-muted-foreground">{entry.branch}支部</span>}
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-2">
              <StatRow label="全国勝率" value={fmtNum(entry.national_win_rate, 2)} />
              <StatRow label="当地勝率" value={fmtNum(entry.local_win_rate, 2)} />
              <StatRow label="全国2連率" value={fmtNum(entry.national_2rate, 1) + "%"} />
              <StatRow label="当地2連率" value={fmtNum(entry.local_2rate, 1) + "%"} />
              <StatRow label="平均ST" value={fmtNum(entry.avg_st, 2)} />
              <StatRow label="F数" value={entry.f_count ?? "—"} />
              <StatRow label="1C 1着率" value={fmtNum(entry.c1_win_rate, 1) + "%"} />
              <StatRow label="1C 2連率" value={fmtNum(entry.c1_2rate, 1) + "%"} />
            </div>

            {/* Trust score */}
            {trust && (
              <div className="rounded-xl bg-background/50 border border-border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">1号艇信頼スコア</span>
                  <span className={cn("text-2xl font-bold tabular-nums", trustScoreColor(trust.score))}>{trust.score ?? "—"}</span>
                </div>
                <div className="text-xs text-muted-foreground">{trustScoreLabel(trust.score)}</div>
                {trust.condition_match && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">条件一致度</span>
                    <span className="font-bold tabular-nums">{trust.condition_match.score}% ({trust.condition_match.matched}/{trust.condition_match.total})</span>
                  </div>
                )}
                {trust.reasons?.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-bold text-emerald-600">信頼材料</div>
                    {trust.reasons.map((r, i) => (
                      <div key={i} className="text-xs text-foreground flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        {r.label}
                      </div>
                    ))}
                  </div>
                )}
                {trust.concerns?.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-bold text-amber-600">注意材料</div>
                    {trust.concerns.map((c, i) => (
                      <div key={i} className="text-xs text-foreground flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        {c.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Future extension placeholders */}
            <div className="space-y-2">
              <div className="text-xs font-bold text-muted-foreground tracking-wider">詳細分析（今後拡張予定）</div>
              <div className="grid grid-cols-3 gap-2">
                <FutureStat label="得意場" />
                <FutureStat label="1号艇成績" />
                <FutureStat label="天候別" />
              </div>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">選手データがありません</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatRow({ label, value }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-background/50 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-bold tabular-nums text-sm">{value}</span>
    </div>
  );
}

function FutureStat({ label }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-3 text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-[10px] text-muted-foreground/60 mt-0.5">準備中</div>
    </div>
  );
}
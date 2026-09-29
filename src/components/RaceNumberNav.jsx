import { cn } from "@/lib/utils";

// 同じ開催場・同じ日のレース番号へ直接移動する切替バー
export default function RaceNumberNav({ races = [], currentId, onSelect }) {
  if (!races || races.length < 2) return null;
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {races.map((r) => {
        const active = r.id === currentId;
        const finished = Boolean(r.result_trifecta);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => !active && onSelect?.(r.id)}
            className={cn(
              "shrink-0 min-w-[48px] rounded-xl border px-2.5 py-1.5 text-sm font-bold tabular-nums transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : finished
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-primary/40"
                : "border-border bg-card text-foreground hover:border-primary/40"
            )}
          >
            {r.race_number}R
          </button>
        );
      })}
    </div>
  );
}
import { cn } from "@/lib/utils";

// 大型数値タイル（出現率・合成オッズ・期待値用）
export default function StatTile({ label, value, unit, accent = "default", sub, className }) {
  const accents = {
    default: "text-foreground",
    primary: "text-primary",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    rose: "text-rose-400",
  };
  return (
    <div className={cn("rounded-2xl bg-card border border-border p-4 flex flex-col gap-1", className)}>
      <div className="text-[11px] text-muted-foreground tracking-wider uppercase">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={cn("font-display font-bold tabular-nums leading-none", accents[accent], "text-4xl")}>
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground font-medium">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
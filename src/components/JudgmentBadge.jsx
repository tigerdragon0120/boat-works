import { cn } from "@/lib/utils";
import { JUDGMENT_STYLE } from "@/lib/boat";

export default function JudgmentBadge({ judgment, size = "md", className }) {
  const s = JUDGMENT_STYLE[judgment] || JUDGMENT_STYLE.PENDING;
  const sizes = {
    sm: "px-2 py-0.5 text-[11px] rounded-md",
    md: "px-3 py-1 text-sm rounded-lg",
    lg: "px-5 py-2 text-lg rounded-xl",
    xl: "px-8 py-3 text-3xl rounded-2xl",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center font-bold tracking-wider ring-1",
        s.bg, s.ring, "text-white shadow-lg", s.glow,
        sizes[size], className
      )}
    >
      {s.label}
    </span>
  );
}
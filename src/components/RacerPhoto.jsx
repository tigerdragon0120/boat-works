import { useState } from "react";
import { User } from "lucide-react";
import { getOfficialRacerPhotoUrl } from "@/lib/boat";
import { cn } from "@/lib/utils";

// 公式選手写真共通コンポーネント
// 登録番号からURLを動的生成・404時はイニシャル/シルエットフォールバック
// loading="lazy"で大量表示時の起動速度を維持
const SIZE_CLASSES = {
  sm: "w-12 h-12 text-base",
  md: "w-16 h-16 text-lg",
  lg: "w-24 h-24 text-2xl",
  xl: "w-32 h-32 text-3xl",
};
const ICON_SIZES = {
  sm: "w-5 h-5",
  md: "w-7 h-7",
  lg: "w-10 h-10",
  xl: "w-14 h-14",
};

export default function RacerPhoto({ registrationNumber, racerName, size = "md", className, lazy = true, onClick }) {
  const [error, setError] = useState(false);
  const url = getOfficialRacerPhotoUrl(registrationNumber);
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const iconSize = ICON_SIZES[size] || ICON_SIZES.md;
  const initial = racerName ? racerName.charAt(0) : null;
  const clickable = !!onClick;

  if (!url || error) {
    return (
      <div
        className={cn(
          "rounded-full bg-muted flex items-center justify-center font-bold text-muted-foreground border border-border shrink-0",
          sizeClass, clickable && "cursor-pointer hover:bg-muted/80 transition-colors", className
        )}
        onClick={onClick}
      >
        {initial || <User className={cn(iconSize, "text-muted-foreground/50")} />}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={racerName ? `${racerName}の選手写真` : "選手写真"}
      loading={lazy ? "lazy" : "eager"}
      onClick={onClick}
      onError={() => setError(true)}
      className={cn(
        "rounded-full object-cover border border-border shrink-0 bg-muted",
        sizeClass, clickable && "cursor-pointer", className
      )}
    />
  );
}
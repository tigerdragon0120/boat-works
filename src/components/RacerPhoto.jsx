import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { base44 } from "@/api/base44Client";
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

const photoCache = new Map();
const pendingCache = new Map();
const failureCache = new Map();
const FAILURE_TTL = 60 * 1000; // 一時失敗は1分後に再試行。nullを永久キャッシュしない

async function loadPhoto(registrationNumber) {
  const reg = String(registrationNumber || "").trim();
  if (!/^\d{4}$/.test(reg)) return null;
  if (photoCache.has(reg)) return photoCache.get(reg);
  const failedAt = failureCache.get(reg);
  if (failedAt && Date.now() - failedAt < FAILURE_TTL) return null;
  if (pendingCache.has(reg)) return pendingCache.get(reg);

  const p = base44.functions.invoke("getRacerPhoto", { registration_number: reg })
    .then((res) => {
      const data = res?.data || res;
      const url = data?.status === "success" ? data.data_url : null;
      if (url) {
        photoCache.set(reg, url);
        failureCache.delete(reg);
      } else {
        failureCache.set(reg, Date.now());
      }
      pendingCache.delete(reg);
      return url;
    })
    .catch(() => {
      failureCache.set(reg, Date.now());
      pendingCache.delete(reg);
      return null;
    });
  pendingCache.set(reg, p);
  return p;
}

export default function RacerPhoto({ registrationNumber, racerName, size = "md", className, lazy = true, onClick }) {
  const reg = String(registrationNumber || "").trim();
  const directUrl = /^\d{4}$/.test(reg) ? `https://www.boatrace.jp/owpc/pc/racer/${reg}/portrait.jpg` : null;
  const [url, setUrl] = useState(() => directUrl || photoCache.get(reg) || null);
  const [loaded, setLoaded] = useState(() => !!directUrl || photoCache.has(reg) || failureCache.has(reg));
  const [triedProxy, setTriedProxy] = useState(false);
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const iconSize = ICON_SIZES[size] || ICON_SIZES.md;
  const initial = racerName ? racerName.charAt(0) : null;
  const clickable = !!onClick;

  useEffect(() => {
    let active = true;
    setUrl(directUrl || photoCache.get(reg) || null);
    setLoaded(!!directUrl || photoCache.has(reg) || failureCache.has(reg));
    setTriedProxy(false);
    if (!/^\d{4}$/.test(reg)) {
      setLoaded(true);
      return () => { active = false; };
    }
    if (!directUrl) {
      loadPhoto(reg).then((nextUrl) => {
        if (!active) return;
        setUrl(nextUrl);
        setLoaded(true);
        setTriedProxy(true);
      });
    }
    return () => { active = false; };
  }, [reg]);

  if (!url) {
    return (
      <div
        className={cn(
          "rounded-full bg-muted flex items-center justify-center font-bold text-muted-foreground border border-border shrink-0",
          sizeClass, clickable && "cursor-pointer hover:bg-muted/80 transition-colors", className
        )}
        onClick={onClick}
      >
        {!loaded ? <span className="animate-pulse text-[10px]">…</span> : (initial || <User className={cn(iconSize, "text-muted-foreground/50")} />)}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={racerName ? `${racerName}の選手写真` : "選手写真"}
      loading={lazy ? "lazy" : "eager"}
      onClick={onClick}
      referrerPolicy="no-referrer"
      onError={() => {
        if (!triedProxy) {
          setTriedProxy(true);
          loadPhoto(reg).then((nextUrl) => { setUrl(nextUrl); setLoaded(true); });
          return;
        }
        photoCache.delete(reg);
        failureCache.set(reg, Date.now());
        setUrl(null);
        setLoaded(true);
      }}
      className={cn(
        "rounded-full object-cover border border-border shrink-0 bg-muted",
        sizeClass, clickable && "cursor-pointer", className
      )}
    />
  );
}
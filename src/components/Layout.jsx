import { Link, useLocation, Outlet } from "react-router-dom";
import { Waves, Bell, BarChart3, Settings, Home, CheckCircle2, LineChart, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Layout() {
  const location = useLocation();
  const nav = [
    { to: "/", label: "ホーム", icon: Home },
    { to: "/alerts", label: "アラート", icon: Bell },
    { to: "/analysis", label: "分析", icon: BarChart3 },
    { to: "/series", label: "今節", icon: Activity },
    { to: "/trends", label: "傾向", icon: LineChart },
    { to: "/verification", label: "検証", icon: CheckCircle2 },
    { to: "/admin", label: "設定", icon: Settings },
  ];
  const isActive = (to) => (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to));

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Top header - ocean blue gradient */}
      <header className="sticky top-0 z-40 bg-gradient-to-r from-sky-600 via-blue-500 to-cyan-500 shadow-md shadow-blue-500/20">
        <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="relative w-9 h-9 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/40">
              <Waves className="w-5 h-5 text-white" />
            </div>
            <div className="leading-none">
              <div className="font-display font-bold tracking-tight text-[15px] text-white drop-shadow-sm">BOAT WORKS</div>
              <div className="text-[10px] text-cyan-100 tracking-widest">ういち買い 1-234-56</div>
            </div>
          </Link>
          <div className="text-[11px] text-cyan-50 hidden sm:block">期待値分析</div>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 pb-24 pt-4">
        <Outlet />
      </main>

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-card/95 backdrop-blur-md">
        <div className="mx-auto max-w-5xl grid grid-cols-7">
          {nav.map((n) => {
            const active = isActive(n.to);
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 py-2.5 transition-colors",
                  active ? "text-primary" : "text-muted-foreground"
                )}
              >
                <Icon className={cn("w-5 h-5", active && "drop-shadow-[0_0_6px_rgba(14,165,233,0.4)]")} />
                <span className="text-[10px] font-medium">{n.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
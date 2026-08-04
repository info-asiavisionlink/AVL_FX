"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import {
  LayoutDashboard, BarChart2, Globe, CalendarDays,
  Newspaper, Briefcase, History, Settings,
  ScrollText, Cable,
} from "lucide-react";

const NAV = [
  { href: "/",          icon: LayoutDashboard, label: "DASHBOARD", group: 1 },
  { href: "/markets",   icon: Globe,           label: "MARKETS",   group: 1 },
  { href: "/chart",     icon: BarChart2,       label: "CHART",     group: 1 },
  { href: "/positions", icon: Briefcase,       label: "POSITIONS", group: 1 },
  { href: "/history",   icon: History,         label: "HISTORY",   group: 1 },
  { href: "/calendar",  icon: CalendarDays,    label: "CALENDAR",  group: 2 },
  { href: "/news",      icon: Newspaper,       label: "NEWS",      group: 2 },
  { href: "/logs",      icon: ScrollText,      label: "AI LOGS",   group: 3 },
  { href: "/settings",  icon: Settings,        label: "SETTINGS",  group: 3 },
];

export function Sidebar() {
  const pathname   = usePathname();
  const { status } = useConnectionStore();
  let   lastGroup  = 0;

  return (
    <aside className="relative flex flex-col items-center w-[80px] h-full shrink-0 overflow-hidden"
      style={{
        background: "linear-gradient(180deg, #02040a 0%, #030508 100%)",
        borderRight: "1px solid rgba(0,200,255,0.1)",
        boxShadow: "2px 0 24px rgba(0,0,0,0.8)",
      }}>

      {/* Animated vertical neon line */}
      <div className="absolute right-0 top-0 bottom-0 w-px pointer-events-none"
        style={{background:"linear-gradient(180deg, transparent 0%, rgba(0,200,255,0.3) 30%, rgba(0,200,255,0.5) 50%, rgba(0,200,255,0.3) 70%, transparent 100%)"}}/>

      {/* Subtle grid */}
      <div className="absolute inset-0 avl-grid-bg opacity-[0.04] pointer-events-none"/>

      {/* Logo */}
      <Link href="/" className="group relative flex flex-col items-center justify-center w-full h-16 shrink-0 select-none mb-1">
        <div className="relative">
          {/* Outer glow ring */}
          <div className="absolute inset-[-6px] rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{background:"radial-gradient(circle, rgba(0,200,255,0.12) 0%, transparent 70%)"}}/>

          {/* Logo box */}
          <div className="relative w-11 h-11 flex flex-col items-center justify-center"
            style={{
              background: "linear-gradient(135deg, rgba(0,30,60,0.9) 0%, rgba(0,15,30,0.95) 100%)",
              border: "1px solid rgba(0,200,255,0.3)",
              boxShadow: "0 0 16px rgba(0,200,255,0.15), inset 0 0 8px rgba(0,200,255,0.05)",
            }}>
            {/* Corner accents */}
            {[
              "absolute top-0 left-0 w-2 h-2 border-t border-l border-cyan-400/60",
              "absolute top-0 right-0 w-2 h-2 border-t border-r border-cyan-400/60",
              "absolute bottom-0 left-0 w-2 h-2 border-b border-l border-cyan-400/60",
              "absolute bottom-0 right-0 w-2 h-2 border-b border-r border-cyan-400/60",
            ].map((cls, i) => <div key={i} className={cls} />)}

            <span className="text-[13px] font-black font-mono leading-none avl-glow-cyan"
              style={{color:"#00e5ff", letterSpacing:"0.05em"}}>
              AVL
            </span>
            <span className="text-[7px] font-bold font-mono tracking-[0.2em] mt-0.5"
              style={{color:"rgba(0,200,255,0.5)"}}>
              FX
            </span>
          </div>
        </div>
      </Link>

      {/* Nav items */}
      <div className="flex flex-col w-full flex-1 gap-0.5 px-1.5 py-1">
        {NAV.map(({ href, icon: Icon, label, group }, idx) => {
          const isActive    = pathname === href || (href !== "/" && pathname.startsWith(href));
          const showDivider = group !== lastGroup && lastGroup !== 0;
          lastGroup = group;

          const activeColor  = "rgba(0,200,255,";
          const activeBorder = "rgba(0,200,255,0.25)";
          const activeGlow   = "rgba(0,200,255,0.1)";
          const textColor    = "#00e5ff";

          return (
            <div key={`${href}-${idx}`} className="w-full flex flex-col items-center">
              {showDivider && (
                <div className="w-full h-px my-1.5 mx-1"
                  style={{background:"linear-gradient(to right, transparent, rgba(0,200,255,0.15), transparent)"}}/>
              )}
              <Link href={href} className={cn(
                "group relative flex flex-col items-center justify-center w-full h-[52px] gap-1 transition-all duration-200 overflow-hidden",
                !isActive && "hover:bg-cyan-950/15"
              )}
                style={isActive ? {
                  background: `linear-gradient(135deg, ${activeColor}0.12) 0%, ${activeColor}0.05) 100%)`,
                  border: `1px solid ${activeBorder}`,
                  boxShadow: `0 0 12px ${activeGlow}, inset 0 1px 0 ${activeColor}0.15)`,
                } : { border: "1px solid transparent" }}>

                {/* Active left accent */}
                {isActive && (
                  <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r"
                    style={{background: textColor, boxShadow:`0 0 6px ${textColor}`}}/>
                )}

                {/* Shimmer on hover */}
                <div className="absolute inset-0 avl-shimmer opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"/>

                {/* Icon */}
                <Icon size={15} className="transition-all duration-200"
                  style={isActive ? { color: textColor, filter:`drop-shadow(0 0 4px ${textColor})` } : { color: "#4b5563" }}/>

                {/* Label */}
                <span className="text-[6px] font-mono tracking-[0.12em] font-semibold transition-colors"
                  style={isActive ? { color: textColor } : { color: "#374151" }}>
                  {label}
                </span>

              </Link>
            </div>
          );
        })}
      </div>

      {/* MT5 link at bottom */}
      <div className="w-full px-1.5 pb-2 shrink-0">
        <div className="w-full h-px mb-2"
          style={{background:"linear-gradient(to right, transparent, rgba(0,200,255,0.12), transparent)"}}/>
        <Link href="/mt5" className={cn(
          "group relative flex flex-col items-center justify-center w-full h-[52px] gap-1 overflow-hidden transition-all",
          !pathname.startsWith("/mt5") && "hover:bg-cyan-950/15"
        )}
          style={pathname.startsWith("/mt5") ? {
            background: "linear-gradient(135deg, rgba(0,200,255,0.12) 0%, rgba(0,200,255,0.05) 100%)",
            border: "1px solid rgba(0,200,255,0.25)",
            boxShadow: "0 0 12px rgba(0,200,255,0.1)",
          } : { border: "1px solid transparent" }}>

          <Cable size={15} className={cn(pathname.startsWith("/mt5") ? "text-cyan-300" : "text-gray-600")}
            style={pathname.startsWith("/mt5") ? {filter:"drop-shadow(0 0 4px #00e5ff)"} : undefined}/>
          <span className="text-[6px] font-mono tracking-[0.12em] font-semibold"
            style={pathname.startsWith("/mt5") ? {color:"#00e5ff"} : {color:"#374151"}}>
            MT5
          </span>

          {/* Connection status dot */}
          <div className="absolute top-1.5 right-1.5 flex items-center justify-center">
            <div className={cn("w-2 h-2 rounded-full",
              status==="connected"  ? "bg-green-400" :
              status==="connecting" ? "bg-yellow-400" :
              "bg-gray-700"
            )}
              style={{
                boxShadow: status==="connected" ? "0 0 8px #22c55e" : status==="connecting" ? "0 0 6px #fbbf24" : "none",
                animation: status==="connecting" ? "avl-blink 0.8s ease-in-out infinite" : "none",
              }}/>
            {status === "connected" && (
              <div className="absolute w-2 h-2 rounded-full bg-green-400 opacity-60"
                style={{animation:"avl-ring-expand 2s ease-out infinite"}}/>
            )}
          </div>
        </Link>
      </div>
    </aside>
  );
}

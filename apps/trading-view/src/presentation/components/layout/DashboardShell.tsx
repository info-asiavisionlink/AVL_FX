"use client";

import { useState, useCallback, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { Menu, Maximize2, Minimize2 } from "lucide-react";

const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen,   setMobileOpen]   = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const openMobile  = useCallback(() => setMobileOpen(true),  []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // 全画面状態の変化を検知
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  return (
    <div className="flex h-screen overflow-hidden" style={{
      background: "radial-gradient(ellipse at 20% 50%, rgba(0,15,35,1) 0%, #020408 100%)",
    }}>

      {/* ── Desktop sidebar (md+) ───────────────────────────── */}
      <div className="hidden md:flex flex-col">
        <Sidebar />
        {/* 全画面トグルボタン */}
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? "全画面解除" : "全画面表示"}
          className="shrink-0 flex flex-col items-center justify-center h-10 w-full transition-colors hover:bg-emerald-950/20"
          style={{
            background: "linear-gradient(180deg, #02040a 0%, #030508 100%)",
            borderRight: `1px solid ${NG_rgba}0.12)`,
            color: isFullscreen ? NG : "#374151",
          }}
        >
          {isFullscreen
            ? <Minimize2 size={14} style={{ color: NG, filter: `drop-shadow(0 0 4px ${NG})` }}/>
            : <Maximize2 size={14} style={{ color: "#374151" }}/>
          }
        </button>
      </div>

      {/* ── Main content ────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden relative min-w-0">
        <div className="absolute inset-0 pointer-events-none z-0"
          style={{background:"radial-gradient(ellipse 80% 60% at 50% 50%, transparent 30%, rgba(0,0,0,0.6) 100%)"}}/>
        {children}
      </div>

      {/* ── Mobile: hamburger button (md以下のみ表示) ─────────── */}
      <button
        onClick={openMobile}
        className="md:hidden fixed top-2.5 left-3 z-[60] flex items-center justify-center w-9 h-9 rounded"
        style={{
          background: "rgba(2,4,10,0.80)",
          backdropFilter: "blur(8px)",
          border: `1px solid ${NG_rgba}0.25)`,
          boxShadow: `0 0 12px ${NG_rgba}0.12)`,
          color: NG,
        }}
        aria-label="メニューを開く"
      >
        <Menu size={18}/>
      </button>

      {/* ── Mobile: backdrop overlay ─────────────────────────── */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-[65] bg-black/65 backdrop-blur-sm"
          onClick={closeMobile}
        />
      )}

      {/* ── Mobile: slide-in drawer ──────────────────────────── */}
      <div
        className="md:hidden fixed top-0 left-0 bottom-0 z-[70] transform transition-transform duration-300 ease-out"
        style={{
          transform: mobileOpen ? "translateX(0)" : "translateX(-100%)",
          width: 220,
        }}
      >
        <Sidebar mobile onClose={closeMobile}/>
      </div>
    </div>
  );
}

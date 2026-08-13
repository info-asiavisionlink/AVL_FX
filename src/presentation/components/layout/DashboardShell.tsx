"use client";

import { useState, useCallback } from "react";
import { Sidebar } from "./Sidebar";
import { Menu } from "lucide-react";

const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const openMobile  = useCallback(() => setMobileOpen(true),  []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden" style={{
      background: "radial-gradient(ellipse at 20% 50%, rgba(0,15,35,1) 0%, #020408 100%)",
    }}>

      {/* ── Desktop sidebar (md+) ───────────────────────────── */}
      <div className="hidden md:flex">
        <Sidebar />
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

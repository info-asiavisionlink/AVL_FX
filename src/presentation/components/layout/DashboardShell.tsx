"use client";

import { useState, useCallback, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { Menu, Maximize2, Minimize2 } from "lucide-react";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen,   setMobileOpen]   = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const openMobile  = useCallback(() => setMobileOpen(true),  []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

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
    <div className="flex h-screen overflow-hidden" style={{ background: "#f8f7f4" }}>

      {/* デスクトップ サイドバー */}
      <div className="hidden md:flex flex-col">
        <Sidebar />
        {/* 全画面トグル */}
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? "全画面解除" : "全画面表示"}
          className="shrink-0 flex items-center justify-center h-9 w-full transition-colors"
          style={{
            background: "linear-gradient(180deg, #f97316 0%, #ea580c 100%)",
            borderTop: "1px solid rgba(255,255,255,0.15)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          {isFullscreen
            ? <Minimize2 size={13} style={{ color: "#fff" }} />
            : <Maximize2 size={13} style={{ color: "rgba(255,255,255,0.7)" }} />
          }
        </button>
      </div>

      {/* メインコンテンツ */}
      <div className="flex flex-1 overflow-hidden relative min-w-0" style={{ background: "#f8f7f4" }}>
        {children}
      </div>

      {/* モバイル ハンバーガー */}
      <button
        onClick={openMobile}
        className="md:hidden fixed top-2.5 left-3 z-[60] flex items-center justify-center w-9 h-9 rounded-xl"
        style={{
          background: "linear-gradient(135deg, #f97316, #ea580c)",
          boxShadow: "0 2px 8px rgba(249,115,22,0.3)",
          color: "#fff",
        }}
        aria-label="メニューを開く"
      >
        <Menu size={16} />
      </button>

      {/* モバイル オーバーレイ */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-[65] bg-black/30 backdrop-blur-sm"
          onClick={closeMobile}
        />
      )}

      {/* モバイル ドロワー */}
      <div
        className="md:hidden fixed top-0 left-0 bottom-0 z-[70] transform transition-transform duration-300 ease-out"
        style={{ transform: mobileOpen ? "translateX(0)" : "translateX(-100%)", width: 200 }}
      >
        <Sidebar mobile onClose={closeMobile} />
      </div>
    </div>
  );
}

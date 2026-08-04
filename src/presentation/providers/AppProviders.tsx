"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useAutoConnect } from "@/presentation/hooks/useAutoConnect";
import { useWatchlistData } from "@/presentation/hooks/useWatchlistData";

// グローバルサービスブリッジ（DOM を持たない副作用専用コンポーネント）
function GlobalBridge() {
  useAutoConnect();   // 起動時に localStorage から自動接続
  useWatchlistData(); // 接続状態に応じてウォッチリストデータを管理
  return null;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delay={0}>
      <GlobalBridge />
      {children}
      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{
          style: {
            background: "#1a1d29",
            border: "1px solid #2a2d3a",
            color: "#e5e7eb",
          },
        }}
      />
    </TooltipProvider>
  );
}

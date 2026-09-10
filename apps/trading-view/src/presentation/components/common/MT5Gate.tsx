"use client";

import { useUserMT5Connection } from "@/presentation/hooks/useUserMT5Connection";
import { Wifi, WifiOff, Loader2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

interface MT5GateProps {
  children: ReactNode;
  feature?: string; // 「リアルタイムチャート」など表示用
}

/**
 * MT5Gate — MT5接続が必要な機能を保護するラッパー
 * 未接続時: 接続促進UI
 * 接続済みだがオフライン時: 警告 + コンテンツ表示
 * 接続済みかつオンライン時: そのままコンテンツ表示
 */
export function MT5Gate({ children, feature = "この機能" }: MT5GateProps) {
  const { status, loading } = useUserMT5Connection(15_000);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={20} className="animate-spin text-cyan-400" />
      </div>
    );
  }

  // MT5未接続: ゲート表示
  if (!status.connected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 px-8">
        <div className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
          <WifiOff size={28} style={{ color: "#475569" }} />
        </div>
        <div className="text-center space-y-2">
          <p className="text-sm font-bold" style={{ color: "#e2e8f0" }}>
            MT5を接続してください
          </p>
          <p className="text-xs" style={{ color: "#64748b" }}>
            {feature}はあなた自身のMT5が接続されている場合にご利用いただけます
          </p>
        </div>
        <Link href="/mt5">
          <button
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-all hover:opacity-80"
            style={{ background: "rgba(0,229,255,0.12)", color: "#00e5ff", border: "1px solid rgba(0,229,255,0.3)" }}>
            <Wifi size={14} />
            MT5を接続する
          </button>
        </Link>
      </div>
    );
  }

  // 接続済みだがオフライン: 警告バナー + コンテンツ表示
  if (!status.online) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 px-4 py-2 shrink-0"
          style={{ background: "rgba(251,191,36,0.06)", borderBottom: "1px solid rgba(251,191,36,0.2)" }}>
          <div className="w-2 h-2 rounded-full bg-yellow-400" />
          <p className="text-[11px] font-bold" style={{ color: "#fbbf24" }}>
            MT5 接続が切断されています — MT5でBridgeEAが起動しているか確認してください
          </p>
          {status.ageSeconds !== null && (
            <p className="text-[10px] ml-auto" style={{ color: "#64748b" }}>
              最終確認: {Math.floor(status.ageSeconds / 60)}分前
            </p>
          )}
        </div>
        <div className="flex-1 overflow-hidden opacity-50 pointer-events-none">
          {children}
        </div>
      </div>
    );
  }

  // オンライン: コンテンツをそのまま表示
  return <>{children}</>;
}

/** MT5接続状態バッジ（Header等で使用） */
export function MT5StatusBadge() {
  const { status, loading } = useUserMT5Connection(15_000);

  if (loading) return null;
  if (!status.connected) return null;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded"
      style={{
        background: status.online
          ? "rgba(0,255,136,0.08)"
          : "rgba(251,191,36,0.08)",
        border: `1px solid ${status.online ? "rgba(0,255,136,0.2)" : "rgba(251,191,36,0.2)"}`,
      }}>
      <div className={`w-1.5 h-1.5 rounded-full ${status.online ? "bg-green-400" : "bg-yellow-400"}`}
        style={{ boxShadow: status.online ? "0 0 4px #4ade80" : "none" }} />
      <span className="text-[10px] font-bold"
        style={{ color: status.online ? "#4ade80" : "#fbbf24" }}>
        {status.online ? "MT5 Live" : "MT5 切断中"}
      </span>
    </div>
  );
}

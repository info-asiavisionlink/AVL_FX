"use client";

import { usePriceStore } from "@/application/stores/priceStore";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { TIMEFRAMES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff, Loader2 } from "lucide-react";

// --------------------------------------------------
// 接続状態ラベル設定（日本語）
// --------------------------------------------------
const STATUS_CONFIG = {
  connected:    { label: "MT5 接続済み", color: "border-green-600 text-green-400",  Icon: Wifi     },
  connecting:   { label: "接続中...",    color: "border-yellow-600 text-yellow-400", Icon: Loader2  },
  disconnected: { label: "MT5 未接続",   color: "border-gray-600 text-gray-500",    Icon: WifiOff  },
  error:        { label: "MT5 未接続",   color: "border-red-700 text-red-500",      Icon: WifiOff  },
} as const;

export function Header() {
  const { activeSymbol, activeTimeframe, setActiveTimeframe } = usePriceStore();
  const { status } = useConnectionStore();

  const cfg = STATUS_CONFIG[status];

  return (
    <header className="flex items-center h-10 px-3 bg-[#1a1d29] border-b border-[#2a2d3a] gap-3 shrink-0">
      {/* アクティブシンボル */}
      <span className="text-white font-semibold text-sm min-w-[80px]">
        {activeSymbol}
      </span>

      {/* 時間足セレクター */}
      <div className="flex gap-0.5">
        {TIMEFRAMES.map(({ label, value }) => (
          <button
            key={value}
            onClick={() => setActiveTimeframe(value)}
            className={cn(
              "px-2 py-0.5 text-xs rounded transition-colors",
              activeTimeframe === value
                ? "bg-blue-600 text-white"
                : "text-gray-400 hover:text-gray-100 hover:bg-[#2a2d3a]"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* 接続状態バッジ（日本語・3状態）*/}
      <Badge
        variant="outline"
        className={cn("text-xs gap-1.5 border", cfg.color)}
      >
        <cfg.Icon
          size={11}
          className={status === "connecting" ? "animate-spin" : ""}
        />
        {cfg.label}
      </Badge>
    </header>
  );
}

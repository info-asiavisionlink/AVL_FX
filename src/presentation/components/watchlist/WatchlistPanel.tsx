"use client";

import { usePriceStore } from "@/application/stores/priceStore";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Wifi, Loader2 } from "lucide-react";

export function WatchlistPanel() {
  const { watchlist, activeSymbol, setActiveSymbol } = usePriceStore();
  const { status } = useConnectionStore();

  const isConnected  = status === "connected";
  const isConnecting = status === "connecting";

  return (
    <div className="flex flex-col h-full">
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a2d3a] shrink-0">
        <span className="text-xs font-semibold text-gray-300 tracking-wide uppercase">
          ウォッチリスト
        </span>
        {isConnected  && <Wifi    size={11} className="text-green-400" />}
        {isConnecting && <Loader2 size={11} className="text-yellow-400 animate-spin" />}
      </div>

      {/* カラムヘッダー */}
      <div className="grid grid-cols-[1fr_60px_60px_48px_56px] px-3 py-1 text-[10px] text-gray-600 border-b border-[#2a2d3a] shrink-0">
        <span>シンボル</span>
        <span className="text-right">Bid</span>
        <span className="text-right">Ask</span>
        <span className="text-right">Spr</span>
        <span className="text-right">前日比</span>
      </div>

      <ScrollArea className="flex-1">
        {watchlist.map((item) => {
          const isActive   = item.symbol === activeSymbol;
          const isLive     = item.isConnected && item.bid > 0;
          const isPositive = item.dailyChangePercent >= 0;

          return (
            <button
              key={item.symbol}
              onClick={() => setActiveSymbol(item.symbol)}
              className={cn(
                "w-full grid grid-cols-[1fr_60px_60px_48px_56px] items-center",
                "px-3 py-1.5 text-xs transition-colors text-left border-l-2",
                isActive
                  ? "bg-blue-600/15 border-blue-500"
                  : "border-transparent hover:bg-[#2a2d3a]"
              )}
            >
              {/* シンボル */}
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn(
                  "w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
                  isLive ? "bg-green-400" : "bg-gray-700"
                )} />
                <span className={cn(
                  "font-medium truncate",
                  isActive ? "text-white" : "text-gray-300"
                )}>
                  {item.symbol}
                </span>
              </div>

              {/* Bid */}
              <span className="text-right font-mono text-gray-200">
                {isLive ? fmtPrice(item.bid, item.symbol) : <Dash />}
              </span>

              {/* Ask */}
              <span className="text-right font-mono text-gray-500">
                {isLive ? fmtPrice(item.ask, item.symbol) : <Dash />}
              </span>

              {/* Spread */}
              <span className="text-right font-mono text-gray-600">
                {isLive ? item.spread.toFixed(1) : <Dash />}
              </span>

              {/* 前日比 */}
              <span className={cn(
                "text-right font-mono",
                !isLive || item.dailyChangePercent === 0
                  ? "text-gray-600"
                  : isPositive ? "text-green-400" : "text-red-400"
              )}>
                {isLive && item.dailyChangePercent !== 0
                  ? `${isPositive ? "+" : ""}${item.dailyChangePercent.toFixed(2)}%`
                  : <Dash />
                }
              </span>
            </button>
          );
        })}

        {/* 未接続メッセージ */}
        {!isConnected && !isConnecting && (
          <div className="px-3 py-3 mt-1 border-t border-[#1e2030]">
            <p className="text-[10px] text-gray-700 leading-relaxed">
              MT5 接続後に<br />リアルタイム価格を表示
            </p>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

const Dash = () => <span className="text-gray-700">—</span>;

function fmtPrice(price: number, symbol: string): string {
  if (price === 0) return "—";
  const digits =
    symbol.includes("JPY") ? 3 :
    symbol === "XAUUSD" || symbol === "BTCUSD" ? 2 : 5;
  return price.toFixed(digits);
}

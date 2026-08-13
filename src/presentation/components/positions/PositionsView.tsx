"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { ConnectionManager }  from "@/infrastructure/connection/ConnectionManager";
import type { MarketPosition, MarketAccount } from "@/infrastructure/connection/GatewayClient";

export function PositionsView() {
  const { status } = useConnectionStore();
  const [positions, setPositions] = useState<MarketPosition[]>([]);
  const [account,   setAccount]   = useState<MarketAccount | null>(null);

  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;
    const unsubs = [
      client.onPosition((pos) => setPositions(pos)),
      client.onAccount((acc)  => setAccount(acc)),
    ];
    return () => unsubs.forEach(u => u());
  }, [status]);

  const totalPL = positions.reduce((s, p) => s + p.profit, 0);

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-4 pt-12 md:pt-4 bg-[#04060d]">
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <div className="w-0.5 h-4 bg-cyan-500/60" />
        <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest">POSITIONS</span>
        <span className={cn("text-[8px] font-mono ml-auto", positions.length > 0 ? "text-green-400" : "text-gray-700")}>
          {positions.length} OPEN
        </span>
      </div>

      {/* Account Summary */}
      {account && (
        <div className="grid grid-cols-4 gap-2 mb-4 shrink-0">
          {[
            { label: "Balance",    value: `${account.currency} ${account.balance.toLocaleString("en", { minimumFractionDigits: 2 })}`, color: "text-white" },
            { label: "Equity",     value: `${account.currency} ${account.equity.toLocaleString("en", { minimumFractionDigits: 2 })}`, color: account.equity >= account.balance ? "text-green-400" : "text-red-400" },
            { label: "Unrealized", value: `${totalPL >= 0 ? "+" : ""}${totalPL.toFixed(2)}`, color: totalPL >= 0 ? "text-green-400" : "text-red-400" },
            { label: "Free Margin",value: `${account.currency} ${account.freeMargin.toFixed(2)}`, color: "text-cyan-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="border border-[#0d1520] bg-[#060a12] p-2">
              <div className="text-[7px] text-gray-700 font-mono">{label}</div>
              <div className={cn("text-[10px] font-mono font-semibold", color)}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ポジション一覧 */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {positions.length === 0 ? (
          <div className="border border-[#0d1520] bg-[#060a12] p-6 text-center">
            <p className="text-[10px] text-gray-600 font-mono">
              {status === "connected" ? "オープンポジションなし" : "MT5 に接続してください"}
            </p>
          </div>
        ) : (
          positions.map((pos) => (
            <div key={pos.ticket} className={cn(
              "border p-3",
              pos.profit >= 0 ? "border-green-800/40 bg-green-950/10" : "border-red-800/40 bg-red-950/10"
            )}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={cn("text-[10px] font-mono font-bold", pos.type === 0 ? "text-green-400" : "text-red-400")}>
                    {pos.type === 0 ? "▲ BUY" : "▼ SELL"}
                  </span>
                  <span className="text-[9px] text-cyan-400 font-mono">{pos.volume} Lot</span>
                  <span className="text-[8px] text-gray-600 font-mono">#{pos.ticket}</span>
                </div>
                <span className={cn("text-[12px] font-mono font-bold", pos.profit >= 0 ? "text-green-400" : "text-red-400")}>
                  {pos.profit >= 0 ? "+" : ""}{pos.profit.toFixed(2)}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[8px] font-mono">
                <div>
                  <span className="text-gray-700">Open</span>
                  <p className="text-white">{pos.openPrice.toFixed(5)}</p>
                </div>
                <div>
                  <span className="text-gray-700">Current</span>
                  <p className="text-white">{pos.currentPrice.toFixed(5)}</p>
                </div>
                <div>
                  <span className="text-gray-700">SL</span>
                  <p className={pos.sl > 0 ? "text-red-400" : "text-gray-700"}>{pos.sl > 0 ? pos.sl.toFixed(5) : "---"}</p>
                </div>
                <div>
                  <span className="text-gray-700">TP</span>
                  <p className={pos.tp > 0 ? "text-green-400" : "text-gray-700"}>{pos.tp > 0 ? pos.tp.toFixed(5) : "---"}</p>
                </div>
              </div>
              <div className="mt-1.5 text-[7px] text-gray-700 font-mono">
                Open: {new Date(pos.openTime * 1000).toLocaleString("ja-JP")} · Swap: {pos.swap.toFixed(2)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

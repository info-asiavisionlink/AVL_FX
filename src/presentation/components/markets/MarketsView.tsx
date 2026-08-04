"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { useIndicatorStore }  from "@/application/stores/indicatorStore";
import { ConnectionManager }  from "@/infrastructure/connection/ConnectionManager";
import { TrendingUp, TrendingDown, Minus, RefreshCw } from "lucide-react";
import type { IndicatorData } from "@/application/stores/indicatorStore";

const TFS = ["H4", "H1", "M15", "M5"] as const;

function TrendIcon({ ema21, ema200 }: { ema21: number; ema200: number }) {
  if (ema21 > ema200 * 1.0001) return <TrendingUp size={10} className="text-green-400" />;
  if (ema21 < ema200 * 0.9999) return <TrendingDown size={10} className="text-red-400" />;
  return <Minus size={10} className="text-gray-600" />;
}

function SymbolRow({ ind }: { ind: IndicatorData }) {
  const h4  = ind.timeframes?.H4;
  const h1  = ind.timeframes?.H1;
  const dir = h4 ? (h4.ema21 > h4.ema200 ? "up" : "down") : null;

  return (
    <div className="border border-[#0d1520] bg-[#060a12] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-bold text-cyan-400">{ind.symbol}</span>
          {dir === "up"   && <span className="text-[8px] text-green-400 font-mono border border-green-800/50 px-1">BULL</span>}
          {dir === "down" && <span className="text-[8px] text-red-400 font-mono border border-red-800/50 px-1">BEAR</span>}
        </div>
        <div className="flex items-center gap-3 text-[8px] font-mono text-gray-600">
          <span>Spread: <span className="text-yellow-500">{ind.spread.toFixed(1)}p</span></span>
          {ind.sessions && ind.sessions.length > 0 && (
            <span className="text-cyan-600">{ind.sessions.join(" / ")}</span>
          )}
          <span>{new Date(ind.brokerTime * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {TFS.map((tf) => {
          const d = ind.timeframes?.[tf];
          return (
            <div key={tf} className="border border-[#0d1520] p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[8px] text-cyan-600/60 font-mono">[{tf}]</span>
                {d && <TrendIcon ema21={d.ema21} ema200={d.ema200} />}
              </div>
              {d ? (
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[7px] font-mono">
                    <span className="text-gray-700">EMA21</span>
                    <span className="text-white">{d.ema21.toFixed(ind.digits >= 3 ? 3 : 2)}</span>
                  </div>
                  <div className="flex justify-between text-[7px] font-mono">
                    <span className="text-gray-700">EMA200</span>
                    <span className="text-white">{d.ema200.toFixed(ind.digits >= 3 ? 3 : 2)}</span>
                  </div>
                  <div className="flex justify-between text-[7px] font-mono">
                    <span className="text-gray-700">ATR</span>
                    <span className="text-orange-400">{d.atr.toFixed(ind.digits >= 3 ? 4 : 2)}</span>
                  </div>
                  <div className="mt-1 h-px w-full">
                    <div
                      className={cn("h-full", d.ema21 > d.ema200 ? "bg-green-500/40" : "bg-red-500/40")}
                      style={{ width: `${Math.min(100, Math.abs(d.ema21 - d.ema200) / d.atr * 50 + 20)}%` }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-[7px] text-gray-800 font-mono">---</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MarketsView() {
  const { status }      = useConnectionStore();
  const { indicators, setIndicators } = useIndicatorStore();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;
    const unsub = client.onIndicators((ind) => setIndicators(ind));
    return () => unsub();
  }, [status, setIndicators]);

  const indList = Object.values(indicators);

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-4 bg-[#04060d]">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-4 bg-cyan-500/60" />
          <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest">MARKETS OVERVIEW</span>
          <span className="text-[8px] text-gray-700 font-mono">· EMA21 / EMA200 / ATR14 × H4,H1,M15,M5</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("text-[8px] font-mono", status === "connected" ? "text-green-400" : "text-gray-700")}>
            {status === "connected" ? `● LIVE · ${indList.length} symbols` : "● MT5 未接続"}
          </span>
          <button onClick={() => setRefresh(r => r + 1)} className="text-gray-700 hover:text-gray-400">
            <RefreshCw size={11} />
          </button>
        </div>
      </div>

      {/* シンボル一覧 */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {indList.length === 0 ? (
          <div className="border border-[#0d1520] bg-[#060a12] p-6 text-center">
            <p className="text-[10px] text-gray-600 font-mono">
              {status === "connected" ? "インジケーターデータ待機中..." : "MT5 に接続してください"}
            </p>
          </div>
        ) : (
          indList.map((ind) => <SymbolRow key={ind.symbol} ind={ind} />)
        )}
      </div>

      <div className="mt-1 text-[7px] text-gray-800 font-mono shrink-0" suppressHydrationWarning>
        更新: {refresh >= 0 && new Date().toLocaleTimeString("ja-JP")}
      </div>
    </div>
  );
}

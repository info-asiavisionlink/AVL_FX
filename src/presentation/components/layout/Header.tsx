"use client";

// =================================================================
// Header v4.0 — リアルタイム価格 + データステータス表示
// =================================================================
//
// 追加:
//   - アクティブ銘柄のBID/ASK/SPREADをリアルタイム表示
//   - EA ACTIVE / STALE DATA / NO DATA ステータス
//   - Tick更新時の価格フラッシュ（常時点滅禁止）
// =================================================================

import { useEffect, useRef, useState } from "react";
import { usePriceStore }      from "@/application/stores/priceStore";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { useIndicatorStore }  from "@/application/stores/indicatorStore";
import { TIMEFRAMES }         from "@/lib/constants";
import { cn }                 from "@/lib/utils";

function fmtPrice(v: number, digits: number): string {
  if (v <= 0) return "—";
  return v.toFixed(digits >= 3 ? 5 : 3);
}

export function Header() {
  const { activeSymbol, activeTimeframe, setActiveTimeframe, ticks } = usePriceStore();
  const { status }    = useConnectionStore();
  const { indicators, getForSymbol } = useIndicatorStore();

  const isConnected = status === "connected";

  // アクティブ銘柄のTick
  const tick = ticks[activeSymbol?.toUpperCase?.() ?? ""];
  const ind  = getForSymbol(activeSymbol ?? "");
  const bid  = tick?.bid  ?? 0;
  const ask  = tick?.ask  ?? 0;
  const spr  = tick?.spread ?? 0;
  const digits = ind?.digits ?? (activeSymbol?.includes("JPY") ? 3 : 5);

  // 価格フラッシュ（Bidが変化した時だけ）
  const [flash, setFlash] = useState(false);
  const prevBid = useRef(bid);
  useEffect(() => {
    if (bid > 0 && bid !== prevBid.current) {
      prevBid.current = bid;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 400);
      return () => clearTimeout(t);
    }
    prevBid.current = bid;
  }, [bid]);

  // データステータス判定
  const ageMs = tick?.time ? Date.now() - tick.time * 1000 : null;
  const dataStatus: "live" | "stale" | "no_data" | "ind_only" =
    !isConnected                           ? "no_data"  :
    bid > 0 && ageMs !== null && ageMs < 10_000  ? "live"    :
    bid > 0 && ageMs !== null && ageMs < 60_000  ? "stale"   :
    bid > 0                                ? "stale"    :
    ind != null                            ? "ind_only" :
                                             "no_data";

  const statusLabel =
    dataStatus === "live"     ? "EA ACTIVE" :
    dataStatus === "stale"    ? "STALE DATA" :
    dataStatus === "ind_only" ? "IND ONLY"  :
                                "NO DATA";

  const statusColor =
    dataStatus === "live"     ? "text-green-400"    :
    dataStatus === "stale"    ? "text-yellow-500"   :
    dataStatus === "ind_only" ? "text-blue-400/70"  :
                                "text-gray-600";

  const dotColor =
    dataStatus === "live"     ? "bg-green-400"   :
    dataStatus === "stale"    ? "bg-yellow-500"  :
    dataStatus === "ind_only" ? "bg-blue-500/60" :
                                "bg-gray-700";

  return (
    <header className="flex items-center h-10 pl-14 pr-3 md:px-3 bg-[#111520] border-b border-[#1a1d2e] gap-2 md:gap-3 shrink-0">
      {/* Symbol name */}
      <span className="text-white font-black text-[13px] font-mono tracking-wider shrink-0">
        {activeSymbol}
      </span>

      {/* Separator */}
      <div className="w-px h-5 bg-[#2a2d3a] hidden sm:block"/>

      {/* Timeframe selector */}
      <div className="flex gap-0.5 overflow-x-auto" style={{scrollbarWidth:"none"}}>
        {TIMEFRAMES.map(({ label, value }) => (
          <button
            key={value}
            onClick={() => setActiveTimeframe(value)}
            className={cn(
              "px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors shrink-0",
              activeTimeframe === value
                ? "bg-cyan-600/30 text-cyan-300 border border-cyan-700/50"
                : "text-gray-600 hover:text-gray-300 hover:bg-[#1a1d2e]"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1"/>

      {/* Real-time BID / ASK */}
      {bid > 0 && (
        <>
          <div className="hidden sm:flex items-center gap-3 text-[9px] font-mono">
            <div className="flex items-center gap-1">
              <span className="text-gray-700">BID</span>
              <span className={cn("tabular-nums font-bold transition-all duration-300",
                flash ? "text-cyan-300" : "text-gray-200")}>
                {fmtPrice(bid, digits)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-gray-700">ASK</span>
              <span className="text-gray-400 tabular-nums">{fmtPrice(ask, digits)}</span>
            </div>
            {spr > 0 && (
              <span className={cn("tabular-nums",
                spr > 5 ? "text-red-400/80" : spr > 2.5 ? "text-yellow-400/80" : "text-gray-600")}>
                SPR {spr.toFixed(1)}p
              </span>
            )}
          </div>

          <div className="w-px h-5 bg-[#2a2d3a] hidden sm:block"/>
        </>
      )}

      {/* Connection badge */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div className={cn("w-1.5 h-1.5 rounded-full",
          isConnected ? "bg-green-400" : "bg-gray-700")}
          style={isConnected ? { boxShadow: "0 0 4px rgba(0,255,136,0.5)" } : undefined}/>
        <span className={cn("hidden sm:block text-[8.5px] font-mono",
          isConnected ? "text-green-400/70" : "text-gray-600")}>
          {isConnected ? "MT5 LIVE" : "OFFLINE"}
        </span>
      </div>
    </header>
  );
}

"use client";

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
  const { getForSymbol } = useIndicatorStore();

  const isConnected = status === "connected";

  const tick   = ticks[activeSymbol?.toUpperCase?.() ?? ""];
  const ind    = getForSymbol(activeSymbol ?? "");
  const bid    = tick?.bid  ?? 0;
  const ask    = tick?.ask  ?? 0;
  const spr    = tick?.spread ?? 0;
  const digits = ind?.digits ?? (activeSymbol?.includes("JPY") ? 3 : 5);

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

  const ageMs = tick?.time ? Date.now() - tick.time * 1000 : null;
  const dataStatus: "live" | "stale" | "no_data" =
    !isConnected                                    ? "no_data" :
    bid > 0 && ageMs !== null && ageMs < 10_000    ? "live"    :
    bid > 0                                         ? "stale"   :
                                                      "no_data";

  const statusLabel =
    dataStatus === "live"  ? "EA稼働中" :
    dataStatus === "stale" ? "データ遅延" : "オフライン";

  const statusColor =
    dataStatus === "live"  ? "#16a34a" :
    dataStatus === "stale" ? "#d97706" : "#9a9a9a";

  return (
    <header
      className="flex items-center h-11 pl-14 pr-4 md:px-4 gap-2 md:gap-3 shrink-0"
      style={{
        background: "#fff",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
      }}
    >
      {/* Symbol */}
      <span className="font-black text-[13px] font-mono tracking-wider shrink-0"
        style={{ color: "#1a1a1a" }}>
        {activeSymbol}
      </span>

      <div className="w-px h-4 shrink-0" style={{ background: "rgba(0,0,0,0.1)" }} />

      {/* Timeframe selector */}
      <div className="flex gap-0.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        {TIMEFRAMES.map(({ label, value }) => (
          <button
            key={value}
            onClick={() => setActiveTimeframe(value)}
            className="px-2 py-1 text-[10px] font-mono rounded-lg transition-all shrink-0"
            style={activeTimeframe === value ? {
              background: "rgba(249,115,22,0.12)",
              color: "#ea580c",
              border: "1px solid rgba(249,115,22,0.25)",
              fontWeight: 700,
            } : {
              color: "#9a9a9a",
              border: "1px solid transparent",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* BID / ASK */}
      {bid > 0 && (
        <>
          <div className="hidden sm:flex items-center gap-3 text-[9px] font-mono">
            <div className="flex items-center gap-1">
              <span style={{ color: "#9a9a9a" }}>BID</span>
              <span className={cn("tabular-nums font-bold transition-all duration-300")}
                style={{ color: flash ? "#ea580c" : "#1a1a1a" }}>
                {fmtPrice(bid, digits)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span style={{ color: "#9a9a9a" }}>ASK</span>
              <span className="tabular-nums" style={{ color: "#4a4a4a" }}>
                {fmtPrice(ask, digits)}
              </span>
            </div>
            {spr > 0 && (
              <span className="tabular-nums" style={{
                color: spr > 5 ? "#dc2626" : spr > 2.5 ? "#d97706" : "#9a9a9a"
              }}>
                SPR {spr.toFixed(1)}p
              </span>
            )}
          </div>
          <div className="w-px h-4 shrink-0 hidden sm:block" style={{ background: "rgba(0,0,0,0.1)" }} />
        </>
      )}

      {/* 接続バッジ */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div
          className="w-2 h-2 rounded-full"
          style={{
            background: statusColor,
            boxShadow: dataStatus === "live" ? `0 0 4px ${statusColor}` : "none",
          }}
        />
        <span className="hidden sm:block text-[9px] font-mono" style={{ color: statusColor }}>
          {statusLabel}
        </span>
      </div>
    </header>
  );
}

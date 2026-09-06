"use client";

// =================================================================
// WatchlistPanel v4.0 — EA稼働銘柄専用Watch List
// =================================================================
//
// データソース:
//   - 銘柄リスト: indicatorStore.indicators (EA稼働銘柄のみ)
//   - Bid/Ask/Spread: priceStore.ticks (WebSocket Tickで更新)
//   - 前日比%: marketStore.symbols (SYMBOLSイベントで更新)
//   - Bias/DQ: indicatorStoreから計算
//
// ダミー銘柄・固定リスト・架空Confidence禁止
// =================================================================

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useConnectionStore }  from "@/application/stores/connectionStore";
import { useIndicatorStore }   from "@/application/stores/indicatorStore";
import { useMarketStore }      from "@/application/stores/marketStore";
import { usePriceStore }       from "@/application/stores/priceStore";
import { ConnectionManager }   from "@/infrastructure/connection/ConnectionManager";
import { cn }                  from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, Radio } from "lucide-react";
import type { IndicatorData }  from "@/application/stores/indicatorStore";

// ── Helpers ────────────────────────────────────────────────────────
const TFS = ["H4", "H1", "M15", "M5"] as const;

function getDir(ema21: number, ema200: number): "BULL" | "BEAR" | "FLAT" {
  if (ema21 > ema200 * 1.00008) return "BULL";
  if (ema21 < ema200 * 0.99992) return "BEAR";
  return "FLAT";
}

function getAIBias(ind: IndicatorData): "BUY" | "SELL" | "WAIT" {
  let bull = 0, bear = 0, total = 0;
  for (const tf of TFS) {
    const d = ind.timeframes?.[tf];
    if (!d || d.ema21 === 0) continue;
    const dir = getDir(d.ema21, d.ema200);
    if (dir === "BULL") bull++;
    else if (dir === "BEAR") bear++;
    total++;
  }
  if (total === 0) return "WAIT";
  if (bull >= Math.ceil(total * 0.75)) return "BUY";
  if (bear >= Math.ceil(total * 0.75)) return "SELL";
  return "WAIT";
}

function getDataStatus(ind: IndicatorData, hasTick: boolean): {
  label: string; color: string; dot: string;
} {
  const tfCount = TFS.filter(tf => (ind.timeframes?.[tf]?.ema21 ?? 0) > 0).length;
  const ageMs   = Date.now() - (ind.receivedAt ?? 0);
  const fresh   = ageMs < 15_000;
  const stale   = ageMs > 60_000;

  if (!hasTick && tfCount === 0) return { label: "NO DATA",    color: "text-gray-700",   dot: "bg-gray-800"   };
  if (!hasTick)                  return { label: "IND ONLY",   color: "text-blue-500/70", dot: "bg-blue-600/50" };
  if (stale)                     return { label: "STALE",      color: "text-yellow-600", dot: "bg-yellow-600"  };
  if (fresh && tfCount >= 3)     return { label: "LIVE",       color: "text-green-400",  dot: "bg-green-400"   };
  if (tfCount >= 2)              return { label: "PARTIAL",    color: "text-cyan-500/70", dot: "bg-cyan-600/50" };
  return                                { label: "PRICE ONLY", color: "text-orange-400/70", dot: "bg-orange-500/50" };
}

function fmtPrice(v: number, digits: number): string {
  if (v <= 0) return "—";
  return v.toFixed(digits >= 3 ? 5 : 3);
}

// ── Individual symbol row ──────────────────────────────────────────
const SymbolRow = ({
  ind, bid, ask, spread, changePct, isActive, onClick,
}: {
  ind: IndicatorData; bid: number; ask: number; spread: number; changePct: number;
  isActive: boolean; onClick: () => void;
}) => {
  const [flash, setFlash] = useState(false);
  const prevBid = useRef(bid);

  useEffect(() => {
    if (bid > 0 && bid !== prevBid.current) {
      prevBid.current = bid;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 500);
      return () => clearTimeout(t);
    }
    prevBid.current = bid;
  }, [bid]);

  const bias    = getAIBias(ind);
  const status_ = getDataStatus(ind, bid > 0);
  const hasBid  = bid > 0;

  const biasColor = bias === "BUY" ? "#00ff88" : bias === "SELL" ? "#ff1a4e" : "#00e5ff";
  const biasLabel = bias === "BUY" ? "▲ BUY" : bias === "SELL" ? "▼ SELL" : "● WAIT";

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-2.5 py-2 border-b border-[#12161e] transition-all duration-200",
        "border-l-2 relative overflow-hidden",
        isActive
          ? "bg-cyan-950/20 border-l-cyan-400"
          : "border-l-transparent hover:bg-[#12161e]"
      )}
      style={isActive ? { boxShadow: "inset 1px 0 8px rgba(0,229,255,0.05)" } : undefined}
    >
      {/* Tick flash overlay */}
      <div className="absolute inset-0 pointer-events-none transition-opacity duration-300"
        style={{ background: "rgba(0,229,255,0.04)", opacity: flash ? 1 : 0 }}/>

      {/* Row 1: Status dot + Symbol + Bias */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 transition-all", status_.dot)}
            style={status_.label === "LIVE" ? { animation: flash ? "avl-blink 0.3s ease-in-out 3" : "none" } : undefined}/>
          <span className={cn("text-[11px] font-black font-mono tracking-wider truncate",
            isActive ? "text-cyan-300" : "text-gray-200")}>
            {ind.symbol}
          </span>
        </div>
        <span className="text-[8.5px] font-mono font-bold shrink-0 ml-1"
          style={{ color: biasColor }}>{biasLabel}</span>
      </div>

      {/* Row 2: BID / ASK */}
      {hasBid ? (
        <div className="flex items-center justify-between mb-0.5">
          <div className="flex items-center gap-2">
            <div>
              <span className="text-[6.5px] font-mono text-gray-700 mr-0.5">BID</span>
              <span className={cn("text-[10px] font-mono font-bold tabular-nums transition-all duration-300",
                flash ? "text-cyan-300" : isActive ? "text-gray-100" : "text-gray-300")}>
                {fmtPrice(bid, ind.digits)}
              </span>
            </div>
            <div>
              <span className="text-[6.5px] font-mono text-gray-700 mr-0.5">ASK</span>
              <span className="text-[10px] font-mono tabular-nums text-gray-500">
                {fmtPrice(ask, ind.digits)}
              </span>
            </div>
          </div>
          <div className="text-right shrink-0">
            <span className={cn("text-[8px] font-mono tabular-nums",
              spread > 5 ? "text-red-400/70" : spread > 2.5 ? "text-yellow-400/70" : "text-gray-600")}>
              {spread > 0 ? `${spread.toFixed(1)}p` : "—"}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-[8px] font-mono text-gray-800 mb-0.5">PRICE UNAVAILABLE</div>
      )}

      {/* Row 3: Data status + changePct */}
      <div className="flex items-center justify-between">
        <span className={cn("text-[6.5px] font-mono", status_.color)}>{status_.label}</span>
        {changePct !== 0 && (
          <span className={cn("text-[7.5px] font-mono tabular-nums font-semibold",
            changePct > 0 ? "text-green-400/80" : "text-red-400/80")}>
            {changePct > 0 ? "+" : ""}{changePct.toFixed(2)}%
          </span>
        )}
      </div>
    </button>
  );
};

// ── WatchlistPanel ─────────────────────────────────────────────────
export function WatchlistPanel() {
  const { status }                     = useConnectionStore();
  const { indicators }                 = useIndicatorStore();
  const { symbols: marketSymbols }     = useMarketStore();
  const { ticks, activeSymbol, setActiveSymbol } = usePriceStore();

  const isConnected = status === "connected";

  // EA稼働銘柄リスト（indicatorStoreから、アルファベット順）
  const eaSymbols = useMemo(
    () => Object.values(indicators).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [indicators]
  );

  // activeSymbol のバリデーション
  // EA稼働銘柄に存在しない場合は最初の銘柄を選択
  useEffect(() => {
    if (eaSymbols.length === 0) return;
    const eaSet = new Set(eaSymbols.map((s) => s.symbol.toUpperCase()));
    if (!eaSet.has(activeSymbol.toUpperCase())) {
      setActiveSymbol(eaSymbols[0].symbol as never);
    }
  }, [eaSymbols, activeSymbol, setActiveSymbol]);

  const handleSelect = useCallback((sym: string) => {
    setActiveSymbol(sym as never);
  }, [setActiveSymbol]);

  return (
    <div className="flex flex-col h-full bg-[#0a0d12]">
      {/* Header */}
      <div className="flex items-center justify-between px-2.5 py-2 border-b border-[#12161e] shrink-0">
        <div>
          <p className="text-[6.5px] font-mono text-gray-700 tracking-[0.25em] leading-none mb-0.5">AVL EA</p>
          <p className="text-[9px] font-bold font-mono text-gray-400 tracking-wider leading-none">ACTIVE SYMBOLS</p>
        </div>
        <div className="flex items-center gap-1">
          <div className={cn("w-1.5 h-1.5 rounded-full",
            isConnected ? "bg-green-400" : "bg-gray-700")}
            style={isConnected ? { animation: "avl-blink 2s ease-in-out infinite", boxShadow: "0 0 4px rgba(0,255,136,0.5)" } : undefined}/>
          <span className={cn("text-[7px] font-mono",
            isConnected ? "text-green-400/70" : "text-gray-700")}>
            {isConnected ? "MT5" : "OFFLINE"}
          </span>
        </div>
      </div>

      {/* Symbol count */}
      {eaSymbols.length > 0 && (
        <div className="px-2.5 py-1 border-b border-[#12161e] shrink-0 flex items-center justify-between">
          <span className="text-[6.5px] font-mono text-gray-800 tracking-wider">
            {eaSymbols.length} SYMBOL{eaSymbols.length > 1 ? "S" : ""}
          </span>
          <span className="text-[6px] font-mono text-gray-800">EA INDICATORS</span>
        </div>
      )}

      {/* Symbol list */}
      <div className="flex-1 overflow-y-auto avl-scroll">
        {eaSymbols.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-3">
            <Radio size={16} className="text-gray-800"/>
            <p className="text-[9px] text-gray-700 font-mono text-center leading-relaxed">
              {isConnected
                ? "EA稼働銘柄を\n待機中..."
                : "MT5に\n接続してください"}
            </p>
            <p className="text-[7.5px] text-gray-800 font-mono text-center">
              AVL_FX_Bridge.mq5
            </p>
          </div>
        ) : (
          eaSymbols.map((ind) => {
            const tick       = ticks[ind.symbol.toUpperCase()];
            const mktSym     = marketSymbols.get(ind.symbol.toUpperCase());
            const bid        = tick?.bid ?? mktSym?.bid ?? 0;
            const ask        = tick?.ask ?? mktSym?.ask ?? 0;
            const spread     = tick?.spread ?? mktSym?.spread ?? 0;
            const changePct  = mktSym?.changePct ?? 0;

            return (
              <SymbolRow
                key={ind.symbol}
                ind={ind}
                bid={bid}
                ask={ask}
                spread={spread}
                changePct={changePct}
                isActive={ind.symbol.toUpperCase() === activeSymbol.toUpperCase()}
                onClick={() => handleSelect(ind.symbol)}
              />
            );
          })
        )}
      </div>

      {/* Footer — EA connection info */}
      {isConnected && eaSymbols.length > 0 && (
        <div className="shrink-0 px-2.5 py-1.5 border-t border-[#12161e]">
          <p className="text-[6px] font-mono text-gray-800 tracking-wider">
            RAILWAY GATEWAY · WEBSOCKET LIVE
          </p>
        </div>
      )}
    </div>
  );
}

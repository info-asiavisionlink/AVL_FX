"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export interface RankedOpp {
  rank:       number;
  symbol:     string;
  direction:  "BUY" | "SELL" | "WAIT";
  confidence: number;
  dataQuality:number;
  rr?:        number | null;
  entry?:     number | null;
  sl?:        number | null;
  tp?:        number | null;
  spread:     number;
  dowTrend:   string;
  reason:     string;
}

interface Props {
  opportunities: RankedOpp[];
  scanning:      boolean;
}

function AnimatedNumber({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [displayed, setDisplayed] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    const to   = value;
    if (from === to) return;
    let start: number | null = null;
    const dur = 400;
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const ease = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
      setDisplayed(Math.round((from + (to - from) * ease) * 10**decimals) / 10**decimals);
      if (p < 1) requestAnimationFrame(step);
      else prevRef.current = to;
    };
    requestAnimationFrame(step);
  }, [value, decimals]);

  return <span>{displayed.toFixed(decimals)}</span>;
}

export function OpportunityRanker({ opportunities, scanning }: Props) {
  const [prevRanks, setPrevRanks] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const m = new Map(opportunities.map(o => [o.symbol, o.rank]));
    setPrevRanks(m);
  }, [opportunities]);

  const dirIcon = (d: string) =>
    d === "BUY"  ? <TrendingUp  size={10} style={{ color: "#00ff88" }}/> :
    d === "SELL" ? <TrendingDown size={10} style={{ color: "#ff1a4e" }}/> :
                   <Minus size={10} style={{ color: "#00e5ff" }}/>;

  const dirColor = (d: string) =>
    d === "BUY" ? "#00ff88" : d === "SELL" ? "#ff1a4e" : "#00e5ff";

  if (opportunities.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-2">
        {scanning ? (
          <>
            <div className="flex gap-1">
              {[0,1,2].map(i => (
                <div key={i} className="w-2 h-2 rounded-full bg-cyan-600/40"
                  style={{ animation: `avl-blink 1s ease-in-out ${i*0.2}s infinite` }}/>
              ))}
            </div>
            <p className="text-[7.5px] font-mono text-cyan-500/50">CALCULATING OPPORTUNITIES...</p>
          </>
        ) : (
          <p className="text-[7.5px] font-mono text-gray-700">RUN SCAN TO DISCOVER OPPORTUNITIES</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 p-2 h-full overflow-y-auto">
      {opportunities.slice(0, 6).map((opp) => {
        const isActionable = opp.direction !== "WAIT";
        const prev = prevRanks.get(opp.symbol);
        const moved = prev !== undefined && prev !== opp.rank;
        const movedUp = prev !== undefined && opp.rank < prev;

        return (
          <div key={opp.symbol}
            className={cn(
              "relative border overflow-hidden transition-all duration-500",
              isActionable
                ? opp.direction === "BUY"
                  ? "border-green-700/40 bg-green-950/10"
                  : "border-red-700/40 bg-red-950/10"
                : "border-[#0d1520] bg-[#04060d]",
              moved ? "scale-[1.01]" : ""
            )}>

            {/* Rank movement indicator */}
            {moved && (
              <div className={cn(
                "absolute right-1.5 top-1 text-[6px] font-mono",
                movedUp ? "text-green-400" : "text-red-400"
              )}>
                {movedUp ? "▲" : "▼"}
              </div>
            )}

            {/* Top glow for top rank */}
            {opp.rank === 1 && isActionable && (
              <div className="absolute top-0 left-0 right-0 h-px"
                style={{ background: `linear-gradient(90deg, transparent, ${dirColor(opp.direction)}60, transparent)` }}/>
            )}

            <div className="flex items-start gap-2 px-2.5 py-2">
              {/* Rank */}
              <div className="flex flex-col items-center shrink-0">
                <span className={cn(
                  "text-[11px] font-black font-mono",
                  opp.rank === 1 ? "text-white" : "text-gray-600"
                )}>#{opp.rank}</span>
              </div>

              {/* Symbol + direction */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  {dirIcon(opp.direction)}
                  <span className="text-[11px] font-black font-mono" style={{ color: dirColor(opp.direction) }}>
                    {opp.symbol}
                  </span>
                  <span className="text-[8px] font-mono font-bold ml-1" style={{ color: dirColor(opp.direction) }}>
                    {opp.direction}
                  </span>
                  <span className={cn("text-[6px] font-mono border px-1 py-0.5 ml-auto",
                    opp.direction === "BUY" ? "border-green-700/40 text-green-400/70" :
                    opp.direction === "SELL" ? "border-red-700/40 text-red-400/70" :
                    "border-cyan-900/40 text-cyan-600/60"
                  )}>
                    {opp.dowTrend || "—"}
                  </span>
                </div>

                {/* Metrics row */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Confidence bar */}
                  <div className="flex items-center gap-1">
                    <span className="text-[6.5px] font-mono text-gray-700">CONF</span>
                    <div className="w-14 h-1 bg-[#0d1520] rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${opp.confidence}%`,
                          background: opp.confidence >= 70
                            ? "linear-gradient(90deg,#22c55e,#00ff88)"
                            : "linear-gradient(90deg,#eab308,#f97316)"
                        }}/>
                    </div>
                    <span className="text-[7px] font-mono" style={{ color: dirColor(opp.direction) }}>
                      <AnimatedNumber value={opp.confidence}/>%
                    </span>
                  </div>

                  {/* Data quality */}
                  <div className="flex items-center gap-1">
                    <span className="text-[6.5px] font-mono text-gray-700">DQ</span>
                    <span className={cn("text-[7px] font-mono",
                      opp.dataQuality >= 75 ? "text-green-400" : opp.dataQuality >= 50 ? "text-yellow-400" : "text-red-400"
                    )}><AnimatedNumber value={opp.dataQuality}/></span>
                  </div>

                  {/* RR */}
                  {opp.rr && (
                    <div className="flex items-center gap-1">
                      <span className="text-[6.5px] font-mono text-gray-700">RR</span>
                      <span className="text-[7px] font-mono text-cyan-400">{opp.rr.toFixed(1)}</span>
                    </div>
                  )}

                  {/* Spread */}
                  <div className="flex items-center gap-1">
                    <span className="text-[6.5px] font-mono text-gray-700">SPR</span>
                    <span className={cn("text-[7px] font-mono", opp.spread > 3 ? "text-yellow-400" : "text-gray-600")}>
                      {opp.spread.toFixed(1)}p
                    </span>
                  </div>
                </div>

                {/* Entry levels */}
                {isActionable && opp.entry && (
                  <div className="flex gap-2 mt-1 text-[6.5px] font-mono">
                    <span className="text-gray-700">E <span className="text-white">{opp.entry.toFixed(5)}</span></span>
                    <span className="text-gray-700">SL <span className="text-red-400">{opp.sl?.toFixed(5)}</span></span>
                    <span className="text-gray-700">TP <span className="text-green-400">{opp.tp?.toFixed(5)}</span></span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

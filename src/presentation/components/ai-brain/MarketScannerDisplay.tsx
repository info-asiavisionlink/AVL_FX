"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface SymbolRow {
  symbol:     string;
  status:     "pending" | "scanning" | "done" | "skip";
  direction:  "BUY" | "SELL" | "WAIT" | null;
  confidence: number;
  dataQuality:number;
  spread:     number;
  source:     string;
}

interface Props {
  symbols:   string[];
  scanning:  boolean;
  rows:      SymbolRow[];
  currentSym:string | null;
}

export function MarketScannerDisplay({ symbols, scanning, rows, currentSym }: Props) {
  const [scanLine, setScanLine] = useState(0);
  const rafRef = useRef<number | undefined>(undefined);

  // Animate scan line
  useEffect(() => {
    if (!scanning) { setScanLine(0); return; }
    let pos = 0;
    const tick = () => {
      pos = (pos + 1) % (symbols.length * 2 + 8);
      setScanLine(pos);
      rafRef.current = setTimeout(tick, 180) as unknown as number;
    };
    rafRef.current = setTimeout(tick, 180) as unknown as number;
    return () => clearTimeout(rafRef.current);
  }, [scanning, symbols.length]);

  const dirColor = (d: string | null) =>
    d === "BUY" ? "#00ff88" : d === "SELL" ? "#ff1a4e" : "#00e5ff";
  const dirBg = (d: string | null) =>
    d === "BUY" ? "rgba(0,255,136,0.08)" : d === "SELL" ? "rgba(255,26,78,0.08)" : "transparent";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cyan-900/20 shrink-0">
        <div className="flex items-center gap-2">
          <div className={cn("w-1.5 h-1.5 rounded-full", scanning ? "bg-cyan-400 animate-pulse" : "bg-gray-700")}/>
          <span className="text-[8px] font-mono tracking-[0.25em] text-cyan-400/70">MARKET SCANNER</span>
        </div>
        <div className="flex items-center gap-2 text-[7px] font-mono text-gray-700">
          <span>{rows.filter(r=>r.status==="done").length}/{symbols.length}</span>
          <span className={scanning ? "text-cyan-400" : "text-gray-700"}>
            {scanning ? "SCANNING..." : "IDLE"}
          </span>
        </div>
      </div>

      {/* Scanner grid */}
      <div className="flex-1 overflow-y-auto">
        {symbols.map((sym, i) => {
          const row = rows.find(r => r.symbol === sym);
          const isCurrent = sym === currentSym;
          const isDone    = row?.status === "done";
          const isSkip    = row?.status === "skip";
          const dir       = row?.direction ?? null;

          return (
            <div key={sym}
              className="relative flex items-center gap-2 px-3 py-1.5 border-b border-[#080c14] transition-all duration-300"
              style={{
                background: isCurrent
                  ? "rgba(0,229,255,0.06)"
                  : isDone ? dirBg(dir) : "transparent",
              }}>

              {/* Scan line */}
              {isCurrent && (
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                  <div className="absolute inset-0"
                    style={{
                      background: "linear-gradient(90deg, transparent, rgba(0,229,255,0.12), transparent)",
                      animation:  "avl-scan-h 0.8s ease-in-out infinite",
                    }}/>
                </div>
              )}

              {/* Index */}
              <span className="text-[6.5px] font-mono text-gray-700 w-3 shrink-0">{i+1}</span>

              {/* Status dot */}
              <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 transition-all",
                isCurrent  ? "bg-cyan-400 animate-ping" :
                isDone     ? (dir === "BUY" ? "bg-green-400" : dir === "SELL" ? "bg-red-400" : "bg-cyan-600") :
                isSkip     ? "bg-gray-800" : "bg-gray-700"
              )}/>

              {/* Symbol */}
              <span className="text-[9px] font-mono font-bold w-14 shrink-0"
                style={{ color: isCurrent ? "#00e5ff" : isDone ? (dir ? dirColor(dir) : "#4b5563") : "#374151" }}>
                {sym}
              </span>

              {/* Scanning animation */}
              {isCurrent && (
                <div className="flex gap-0.5 items-end h-3">
                  {[2,4,3,5,2,4,3].map((h,j) => (
                    <div key={j} className="w-0.5 bg-cyan-400 rounded-sm"
                      style={{
                        height: h * 2,
                        opacity: 0.8,
                        animation: `avl-wave-bar ${0.4+j*0.06}s ease-in-out ${j*0.07}s infinite alternate`,
                      }}/>
                  ))}
                  <span className="text-[6.5px] font-mono text-cyan-400 ml-1">SCANNING</span>
                </div>
              )}

              {/* Done: show result */}
              {isDone && !isCurrent && (
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-[8px] font-mono font-bold" style={{ color: dirColor(dir) }}>
                    {dir ?? "—"}
                  </span>
                  {row && row.confidence > 0 && (
                    <span className="text-[7px] font-mono text-gray-600">
                      {row.confidence}%
                    </span>
                  )}
                  <div className="flex-1 h-px bg-[#0d1520] relative overflow-hidden mx-1">
                    <div className="h-full transition-all duration-500"
                      style={{
                        width: `${row?.dataQuality ?? 0}%`,
                        background: (row?.dataQuality ?? 0) >= 70 ? "#22c55e" : "#eab308",
                      }}/>
                  </div>
                  <span className="text-[6.5px] font-mono text-gray-700">{row?.dataQuality}/100</span>
                </div>
              )}

              {/* Skip */}
              {isSkip && (
                <span className="text-[7px] font-mono text-gray-700 ml-2">NO DATA</span>
              )}

              {/* Pending */}
              {!isCurrent && !isDone && !isSkip && (
                <div className="flex gap-0.5 ml-2">
                  {[1,2,3].map(d => (
                    <div key={d} className="w-0.5 h-0.5 rounded-full bg-gray-700"/>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

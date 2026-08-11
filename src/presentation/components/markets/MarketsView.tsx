"use client";

// =================================================================
// AVL AI Market Command Center — MarketsView v3.0
//
// 完全リデザイン。データフロー (WebSocket → indicatorStore) は変更なし。
//
// 主な変更点:
//   - 4カードを横並び・高さを画面いっぱいに
//   - 銘柄名 24px / 価格 32px / BIAS 22px に大型化
//   - スキャン中カードに明確なglow + scan-line アニメーション
//   - コマンドセンター型ヘッダー
//   - 下部: AI Scanner プログレスバー
//   - 偽データ一切なし
// =================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { useIndicatorStore }  from "@/application/stores/indicatorStore";
import { useMarketStore }     from "@/application/stores/marketStore";
import { usePriceStore }      from "@/application/stores/priceStore";
import { ConnectionManager }  from "@/infrastructure/connection/ConnectionManager";
import { TrendingUp, TrendingDown, Minus, Radio, Activity, Zap, X } from "lucide-react";
import type { IndicatorData } from "@/application/stores/indicatorStore";

// ── Helpers ────────────────────────────────────────────────────────
const TFS = ["H4", "H1", "M15", "M5"] as const;

function getDir(ema21: number, ema200: number): "BULL" | "BEAR" | "FLAT" {
  if (ema21 > ema200 * 1.00008) return "BULL";
  if (ema21 < ema200 * 0.99992) return "BEAR";
  return "FLAT";
}

function getTFSummary(ind: IndicatorData) {
  let bull = 0, bear = 0, flat = 0;
  for (const tf of TFS) {
    const d = ind.timeframes?.[tf];
    if (!d || d.ema21 === 0) continue;
    const dir = getDir(d.ema21, d.ema200);
    if (dir === "BULL") bull++;
    else if (dir === "BEAR") bear++;
    else flat++;
  }
  return { bull, bear, flat, total: bull + bear + flat };
}

function getAIBias(ind: IndicatorData): "BUY" | "SELL" | "WAIT" {
  const { bull, bear, total } = getTFSummary(ind);
  if (total === 0) return "WAIT";
  if (bull >= Math.ceil(total * 0.75)) return "BUY";
  if (bear >= Math.ceil(total * 0.75)) return "SELL";
  return "WAIT";
}

function getDataQuality(ind: IndicatorData): { score: number; label: string } {
  const tfCount = TFS.filter(tf => (ind.timeframes?.[tf]?.ema21 ?? 0) > 0).length;
  const fresh   = Date.now() - (ind.receivedAt ?? 0) < 60_000;
  if (tfCount >= 4 && fresh) return { score: 90, label: "COMPLETE" };
  if (tfCount >= 3 && fresh) return { score: 75, label: "GOOD" };
  if (tfCount >= 2)          return { score: 55, label: "PARTIAL" };
  if (tfCount >= 1)          return { score: 30, label: "PRICE ONLY" };
  return { score: 0, label: "NO DATA" };
}

function getBarPct(ema21: number, ema200: number, atr: number): number {
  const gap = Math.abs(ema21 - ema200);
  return Math.min(100, Math.max(8, (gap / Math.max(atr, 0.00001)) * 22 + 12));
}

function formatAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

function fmtPrice(v: number, digits: number): string {
  return v > 0 ? v.toFixed(digits >= 3 ? 5 : 3) : "—";
}

// ── TF Direction Row ───────────────────────────────────────────────
const TFRow = memo(function TFRow({
  tf, ema21, ema200, atr, digits, animate,
}: {
  tf: string; ema21: number; ema200: number; atr: number;
  digits: number; animate: boolean;
}) {
  if (ema21 === 0) return (
    <div className="flex items-center gap-2">
      <span className="text-[8.5px] font-mono text-gray-700 w-7 shrink-0">{tf}</span>
      <div className="flex-1 h-1.5 bg-[#0d1520] rounded-full"/>
      <span className="text-[7px] font-mono text-gray-800 w-8">N/A</span>
    </div>
  );

  const dir  = getDir(ema21, ema200);
  const pct  = getBarPct(ema21, ema200, atr);
  const bull = dir === "BULL";
  const bear = dir === "BEAR";
  const col  = bull ? "#00ff88" : bear ? "#ff1a4e" : "#374151";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[8.5px] font-mono text-gray-600 w-7 shrink-0 font-semibold">{tf}</span>
      <div className="relative flex-1 h-2 bg-[#0d1520] rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            background: bull
              ? "linear-gradient(90deg,#00ff8825,#00ff88)"
              : bear
              ? "linear-gradient(90deg,#ff1a4e25,#ff1a4e)"
              : "#374151",
            transition: "width 0.8s ease",
            animation: animate
              ? bull ? "avl-flow-right 1.4s linear infinite" : "avl-flow-left 1.4s linear infinite"
              : "none",
            backgroundSize: animate ? "200% 100%" : "100% 100%",
          }}
        />
        {animate && (
          <div className="absolute inset-y-0 w-6 pointer-events-none"
            style={{
              background: "linear-gradient(90deg,transparent,rgba(0,229,255,0.25),transparent)",
              animation: "avl-scan-h 1.6s ease-in-out infinite",
            }}/>
        )}
      </div>
      <div className="flex items-center gap-0.5 w-12 shrink-0">
        {bull && <TrendingUp  size={9} style={{color:"#00ff88"}}/>}
        {bear && <TrendingDown size={9} style={{color:"#ff1a4e"}}/>}
        {dir === "FLAT" && <Minus size={9} className="text-gray-700"/>}
        <span className="text-[8px] font-mono font-bold" style={{color:col}}>{dir}</span>
      </div>
      <span className="text-[7px] font-mono text-gray-700 w-12 shrink-0 text-right tabular-nums">
        {atr.toFixed(digits >= 3 ? 4 : 2)}
      </span>
    </div>
  );
});

// ── Symbol Card ────────────────────────────────────────────────────
const SymbolCard = memo(function SymbolCard({
  ind, bid, ask, changePct, spread, isScanning, onClick,
}: {
  ind: IndicatorData; bid: number; ask: number; changePct: number; spread: number;
  isScanning: boolean; onClick: () => void;
}) {
  // Flash on new data
  const [flashing, setFlashing] = useState(false);
  const prevTs = useRef(ind.receivedAt);
  useEffect(() => {
    if (ind.receivedAt <= prevTs.current) return;
    prevTs.current = ind.receivedAt;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 500);
    return () => clearTimeout(t);
  }, [ind.receivedAt]);

  const { bull, bear, total } = getTFSummary(ind);
  const bias   = getAIBias(ind);
  const dq     = getDataQuality(ind);
  const ageMs  = Date.now() - ind.receivedAt;
  const isLive = ageMs < 6_000;

  const biasColor = bias === "BUY" ? "#00ff88" : bias === "SELL" ? "#ff1a4e" : "#00e5ff";
  const overallDir = bull > bear ? "BULL" : bear > bull ? "BEAR" : "FLAT";

  // Card border / glow colors
  const borderColor = isScanning
    ? "#00e5ff"
    : overallDir === "BULL" ? "#00ff8840"
    : overallDir === "BEAR" ? "#ff1a4e40"
    : "#0d1520";

  const bgColor = isScanning
    ? "rgba(0,229,255,0.04)"
    : overallDir === "BULL" ? "rgba(0,255,136,0.03)"
    : overallDir === "BEAR" ? "rgba(255,26,78,0.03)"
    : "rgba(3,5,8,0.97)";

  return (
    <div
      onClick={onClick}
      className="relative flex flex-col border cursor-pointer overflow-hidden transition-colors duration-300"
      style={{
        borderColor,
        background: bgColor,
        animation: isScanning ? "avl-scan-pulse 1.8s ease-in-out infinite" : "none",
      }}
    >
      {/* Top color stripe */}
      <div className="absolute top-0 left-0 right-0 h-0.5"
        style={{
          background: isScanning
            ? "linear-gradient(90deg,transparent,#00e5ff,transparent)"
            : overallDir === "BULL"
            ? "linear-gradient(90deg,transparent,#00ff88,transparent)"
            : overallDir === "BEAR"
            ? "linear-gradient(90deg,transparent,#ff1a4e,transparent)"
            : "none",
        }}/>

      {/* Corner brackets */}
      {[
        "absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2",
        "absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2",
        "absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2",
        "absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2",
      ].map((cls, i) => (
        <div key={i} className={cls}
          style={{
            borderColor: isScanning ? "#00e5ff80" : `${borderColor}80`,
            animation: isScanning ? "avl-border-corner 1.8s ease-in-out infinite" : "none",
            animationDelay: `${i * 0.15}s`,
          }}/>
      ))}

      {/* Data flash overlay */}
      <div className="absolute inset-0 pointer-events-none z-20 transition-opacity duration-500"
        style={{ background: "rgba(0,229,255,0.08)", opacity: flashing ? 1 : 0 }}/>

      {/* Scan-line when scanning */}
      {isScanning && (
        <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
          <div className="absolute inset-x-0 h-12"
            style={{
              background: "linear-gradient(180deg,transparent,rgba(0,229,255,0.06),transparent)",
              animation: "avl-scan-v 2.2s linear infinite",
            }}/>
          <div className="absolute inset-y-0 w-8"
            style={{
              background: "linear-gradient(90deg,transparent,rgba(0,229,255,0.06),transparent)",
              animation: "avl-scan-h 1.8s ease-in-out infinite",
            }}/>
        </div>
      )}

      {/* ── CONTENT ── */}
      <div className="relative z-[5] flex flex-col flex-1 p-4 gap-3">

        {/* SCANNING badge */}
        {isScanning && (
          <div className="flex items-center gap-2 px-2 py-1 border border-cyan-400/50 bg-cyan-950/30 shrink-0"
            style={{boxShadow:"0 0 8px rgba(0,229,255,0.2)"}}>
            <div className="w-2 h-2 rounded-full bg-cyan-400"
              style={{animation:"avl-blink 0.5s ease-in-out infinite"}}/>
            <span className="text-[8px] font-mono font-bold tracking-[0.3em] text-cyan-400">
              ◉ SCANNING
            </span>
            <div className="flex-1 overflow-hidden h-1 bg-[#0d1520] rounded-full">
              <div className="h-full bg-cyan-400 rounded-full"
                style={{animation:"avl-scan-h 1s linear infinite", width:"40%"}}/>
            </div>
          </div>
        )}

        {/* Symbol name + live status */}
        <div className="flex items-start justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className={cn("w-2 h-2 rounded-full shrink-0 mt-0.5",
              isLive ? "bg-green-400" : ageMs < 30000 ? "bg-yellow-400" : "bg-gray-700"
            )} style={isLive ? {animation:"avl-blink 1.2s ease-in-out infinite"} : undefined}/>
            <span className="text-[24px] font-black font-mono text-gray-100 leading-none tracking-wider">
              {ind.symbol}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 mt-0.5">
            <span className={cn("text-[7px] font-mono",
              isLive ? "text-green-400" : "text-gray-700")}>
              {isLive ? "● LIVE" : formatAge(ind.receivedAt) + " ago"}
            </span>
            {changePct !== 0 && (
              <span className={cn("text-[8px] font-mono tabular-nums font-semibold",
                changePct >= 0 ? "text-green-400" : "text-red-400")}>
                {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        {/* BIAS — large and prominent */}
        <div className="flex items-center justify-center py-2 shrink-0 border"
          style={{
            borderColor: `${biasColor}30`,
            background: `${biasColor}08`,
            boxShadow: `inset 0 0 12px ${biasColor}10`,
          }}>
          <div className="flex items-center gap-2">
            {bias === "BUY"  && <TrendingUp  size={20} style={{color:"#00ff88"}}/>}
            {bias === "SELL" && <TrendingDown size={20} style={{color:"#ff1a4e"}}/>}
            {bias === "WAIT" && <Minus size={20} style={{color:"#00e5ff"}}/>}
            <span className="text-[22px] font-black font-mono"
              style={{
                color: biasColor,
                textShadow: `0 0 12px ${biasColor}60`,
              }}>
              {bias === "BUY" ? "▲ BUY" : bias === "SELL" ? "▼ SELL" : "● WAIT"}
            </span>
          </div>
        </div>

        {/* Price */}
        <div className="shrink-0">
          {bid > 0 ? (
            <>
              <div className="text-center mb-1">
                <span className="text-[32px] font-black font-mono tabular-nums text-gray-100 leading-none"
                  style={{textShadow: overallDir === "BULL" ? "0 0 20px rgba(0,255,136,0.2)" : overallDir === "BEAR" ? "0 0 20px rgba(255,26,78,0.2)" : "none"}}>
                  {fmtPrice(bid, ind.digits)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[8px] font-mono">
                <div className="flex gap-4 text-gray-600">
                  <span>BID <span className="text-gray-300 tabular-nums">{fmtPrice(bid, ind.digits)}</span></span>
                  <span>ASK <span className="text-gray-300 tabular-nums">{fmtPrice(ask, ind.digits)}</span></span>
                </div>
                <span className={cn("font-semibold",
                  spread > 5 ? "text-red-400" : spread > 2.5 ? "text-yellow-400" : "text-cyan-400/70")}>
                  SPR {spread > 0 ? spread.toFixed(1) : (ind.spread > 0 ? ind.spread.toFixed(1) : "—")}p
                </span>
              </div>
            </>
          ) : (
            <div className="text-center">
              <span className="text-[24px] font-mono text-gray-800">NO PRICE</span>
            </div>
          )}
        </div>

        {/* Multi-TF section */}
        <div className="flex-1 flex flex-col gap-1.5">
          {/* TF summary header */}
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[7.5px] font-mono text-gray-700 tracking-[0.2em]">MULTI-TF</span>
            <div className="flex items-center gap-2 text-[8px] font-mono">
              {bull > 0 && <span className="text-green-400 font-bold">▲ {bull}/{total}</span>}
              {bear > 0 && <span className="text-red-400 font-bold">▼ {bear}/{total}</span>}
              {bull === 0 && bear === 0 && <span className="text-gray-700">—</span>}
            </div>
          </div>
          {/* TF bars */}
          <div className="space-y-1.5 flex-1">
            {TFS.map(tf => {
              const d = ind.timeframes?.[tf];
              return (
                <TFRow key={tf}
                  tf={tf}
                  ema21={d?.ema21 ?? 0}
                  ema200={d?.ema200 ?? 0}
                  atr={d?.atr ?? 0}
                  digits={ind.digits}
                  animate={isScanning}
                />
              );
            })}
          </div>
        </div>

        {/* Footer: DQ + Session */}
        <div className="flex items-center justify-between pt-2 border-t border-[#0d1520] shrink-0">
          <div className="flex items-center gap-2">
            <div className={cn("text-[7px] font-mono px-1.5 py-0.5 border font-bold tabular-nums",
              dq.score >= 75 ? "border-green-700/40 text-green-400 bg-green-950/20"
              : dq.score >= 40 ? "border-yellow-700/40 text-yellow-400 bg-yellow-950/20"
              : "border-gray-700/40 text-gray-600"
            )}>
              DQ {dq.score}
            </div>
            <span className="text-[7px] font-mono text-gray-700">{dq.label}</span>
          </div>
          <div className="flex items-center gap-2 text-[7px] font-mono text-gray-700">
            {ind.sessions?.[0] && (
              <span>{ind.sessions[0].replace(" Session","")}</span>
            )}
            <span className="text-gray-800">▸</span>
          </div>
        </div>
      </div>
    </div>
  );
});

// ── AI Scanner Panel (bottom) ──────────────────────────────────────
function AIScannerPanel({
  symbols, scanIdx, isConnected,
}: {
  symbols: string[]; scanIdx: number; isConnected: boolean;
}) {
  if (symbols.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-cyan-900/25 bg-[#02040a] px-4 py-2.5 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent"/>

      <div className="flex items-center gap-4">
        {/* Label */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Activity size={10} className={isConnected ? "text-cyan-400/70" : "text-gray-700"}/>
          <span className="text-[7.5px] font-mono tracking-[0.25em] text-cyan-400/70">AI SCANNER</span>
        </div>

        {/* Symbol progress bars */}
        <div className="flex-1 flex items-center gap-2 overflow-hidden">
          {symbols.map((sym, i) => {
            const done    = i < scanIdx;
            const current = i === scanIdx;
            return (
              <div key={sym} className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className={cn("text-[6.5px] font-mono truncate",
                    current ? "text-cyan-400 font-bold" : done ? "text-gray-500" : "text-gray-800")}>
                    {sym}
                  </span>
                  <span className={cn("text-[6px] font-mono shrink-0 ml-1",
                    current ? "text-cyan-400/80" : done ? "text-green-400/60" : "text-gray-800")}>
                    {current ? "SCAN" : done ? "DONE" : "WAIT"}
                  </span>
                </div>
                <div className="h-1 bg-[#0d1520] rounded-full overflow-hidden">
                  {done && (
                    <div className="h-full bg-green-500/50 rounded-full w-full"/>
                  )}
                  {current && (
                    <div className="h-full rounded-full"
                      style={{
                        width: "60%",
                        background: "linear-gradient(90deg,#00e5ff30,#00e5ff)",
                        animation: "avl-scan-h 1.2s linear infinite",
                        backgroundSize: "200% 100%",
                      }}/>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Current target */}
        <div className="shrink-0 text-right">
          <p className="text-[6px] font-mono text-gray-700 tracking-wider">TARGET</p>
          <p className="text-[11px] font-black font-mono text-cyan-400" suppressHydrationWarning
            style={{textShadow:"0 0 8px rgba(0,229,255,0.5)"}}>
            {symbols[scanIdx] ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Command Center Header ──────────────────────────────────────────
function CommandCenterHeader({
  isConnected, totalSymbols, liveCount, lastUpdateTs,
}: {
  isConnected: boolean; totalSymbols: number; liveCount: number; lastUpdateTs: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ageMs = lastUpdateTs > 0 ? now - lastUpdateTs : null;

  return (
    <div className="shrink-0 border-b border-cyan-900/25 bg-[#02040a] relative overflow-hidden">
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent"/>
      {isConnected && (
        <div className="absolute top-0 left-0 right-0 h-px"
          style={{
            background: "linear-gradient(90deg,transparent,rgba(0,229,255,0.4),transparent)",
            animation: "avl-scan-h 4s linear infinite",
          }}/>
      )}

      <div className="px-5 py-3 flex items-center gap-5">
        {/* Title */}
        <div className="shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5">
              <div className="w-0.5 h-6 bg-cyan-400" style={{boxShadow:"0 0 8px #00e5ff"}}/>
              <div className="w-0.5 h-6 bg-cyan-400/25"/>
            </div>
            <div>
              <p className="text-[8px] font-mono text-purple-400/60 tracking-[0.3em] leading-none mb-0.5">AVL AI</p>
              <p className="text-[13px] font-black font-mono tracking-[0.15em] leading-none"
                style={{color:"#00e5ff", textShadow:"0 0 12px rgba(0,229,255,0.5)"}}>
                MARKET COMMAND CENTER
              </p>
            </div>
          </div>
        </div>

        <div className="w-px h-10 bg-cyan-900/30"/>

        {/* Connection indicators */}
        <div className="flex items-center gap-3 shrink-0">
          {[
            { label: "MT5",      active: isConnected },
            { label: "RAILWAY",  active: isConnected },
            { label: "WEBSOCKET",active: isConnected },
          ].map(({ label, active }) => (
            <div key={label} className="flex items-center gap-1">
              <div className={cn("w-1.5 h-1.5 rounded-full",
                active ? "bg-green-400" : "bg-gray-700")}
                style={active ? {animation:"avl-blink 1.5s ease-in-out infinite"} : undefined}/>
              <span className={cn("text-[7px] font-mono", active ? "text-green-400/70" : "text-gray-700")}>
                {label}
              </span>
            </div>
          ))}
        </div>

        <div className="w-px h-10 bg-cyan-900/30"/>

        {/* Stats */}
        <div className="flex items-center gap-5">
          <div className="text-center">
            <p className="text-[22px] font-black font-mono tabular-nums text-cyan-400 leading-none"
              style={{textShadow:"0 0 10px rgba(0,229,255,0.5)"}}>
              {totalSymbols}
            </p>
            <p className="text-[6px] font-mono text-gray-700 tracking-wider mt-0.5">SYMBOLS</p>
          </div>
          <div className="text-center">
            <p className={cn("text-[22px] font-black font-mono tabular-nums leading-none",
              liveCount > 0 ? "text-green-400" : "text-gray-700")}
              style={liveCount > 0 ? {textShadow:"0 0 10px rgba(0,255,136,0.5)"} : undefined}>
              {liveCount}
            </p>
            <p className="text-[6px] font-mono text-gray-700 tracking-wider mt-0.5">LIVE</p>
          </div>
        </div>

        <div className="flex-1"/>

        {/* Live status + last update */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-2">
            <div className={cn("w-2 h-2 rounded-full",
              isConnected ? "bg-green-400" : "bg-gray-700")}
              style={isConnected ? {animation:"avl-blink 1.2s ease-in-out infinite"} : undefined}/>
            <span className={cn("text-[10px] font-mono font-bold tracking-wider",
              isConnected ? "text-green-400" : "text-gray-600")}>
              {isConnected ? "LIVE" : "OFFLINE"}
            </span>
          </div>
          {ageMs !== null && (
            <span className={cn("text-[7px] font-mono tabular-nums",
              ageMs < 3000 ? "text-green-400/70"
              : ageMs < 15000 ? "text-yellow-400/70"
              : "text-gray-700")}>
              {ageMs < 1000 ? `${ageMs}ms ago` : `${Math.floor(ageMs / 1000)}s ago`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Expanded Detail Panel (modal) ──────────────────────────────────
function ExpandedPanel({
  ind, bid, ask, changePct, onClose, onAnalyze,
}: {
  ind: IndicatorData; bid: number; ask: number; changePct: number;
  onClose: () => void; onAnalyze: (sym: string) => void;
}) {
  const bias     = getAIBias(ind);
  const dq       = getDataQuality(ind);
  const { bull, bear, total } = getTFSummary(ind);
  const biasColor = bias === "BUY" ? "#00ff88" : bias === "SELL" ? "#ff1a4e" : "#00e5ff";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl border border-cyan-900/50 bg-[#030508] overflow-hidden relative"
        style={{boxShadow:"0 0 60px rgba(0,229,255,0.1)"}}>
        <div className="absolute top-0 left-0 right-0 h-px"
          style={{background:`linear-gradient(90deg,transparent,${biasColor}50,transparent)`}}/>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cyan-900/20">
          <div className="flex items-center gap-3">
            <span className="text-[20px] font-black font-mono text-gray-100">{ind.symbol}</span>
            <span className="text-[10px] font-mono font-bold px-2 py-1 border"
              style={{color:biasColor, borderColor:`${biasColor}50`, background:`${biasColor}10`}}>
              {bias === "BUY" ? "▲ BUY" : bias === "SELL" ? "▼ SELL" : "● WAIT"}
            </span>
            <span className={cn("text-[8px] font-mono px-1.5 py-0.5 border",
              dq.score >= 75 ? "border-green-700/40 text-green-400" : "border-yellow-700/40 text-yellow-400")}>
              DQ {dq.score} · {dq.label}
            </span>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X size={16}/>
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto avl-scroll">
          {/* Price */}
          {bid > 0 && (
            <div className="flex items-baseline gap-6">
              <div><p className="text-[7px] font-mono text-gray-700 mb-0.5">BID</p>
                <p className="text-[24px] font-mono tabular-nums text-gray-100 font-bold">{fmtPrice(bid, ind.digits)}</p></div>
              <div><p className="text-[7px] font-mono text-gray-700 mb-0.5">ASK</p>
                <p className="text-[24px] font-mono tabular-nums text-gray-400 font-bold">{fmtPrice(ask, ind.digits)}</p></div>
              <div><p className="text-[7px] font-mono text-gray-700 mb-0.5">SPREAD</p>
                <p className="text-[18px] font-mono font-bold text-yellow-400">{ind.spread.toFixed(1)}p</p></div>
              {changePct !== 0 && <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">CHG</p>
                <p className={cn("text-[18px] font-mono font-bold", changePct >= 0 ? "text-green-400" : "text-red-400")}>
                  {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
                </p>
              </div>}
            </div>
          )}

          {/* Multi-TF */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[8px] font-mono text-cyan-400/60 tracking-[0.2em]">MULTI-TIMEFRAME</p>
              <div className="flex gap-3 text-[8px] font-mono">
                {bull > 0 && <span className="text-green-400 font-bold">▲ {bull}/{total} BULL</span>}
                {bear > 0 && <span className="text-red-400 font-bold">▼ {bear}/{total} BEAR</span>}
              </div>
            </div>
            <div className="space-y-2">
              {TFS.map(tf => {
                const d = ind.timeframes?.[tf];
                if (!d || d.ema21 === 0) return (
                  <div key={tf} className="flex items-center gap-3 border border-[#0d1520] px-3 py-2">
                    <span className="text-[9px] font-mono text-gray-700 w-8">[{tf}]</span>
                    <span className="text-[7px] font-mono text-gray-800">NO DATA</span>
                  </div>
                );
                const dir  = getDir(d.ema21, d.ema200);
                const pct  = getBarPct(d.ema21, d.ema200, d.atr);
                const bull_  = dir === "BULL";
                const bear_  = dir === "BEAR";
                const col_   = bull_ ? "#00ff88" : bear_ ? "#ff1a4e" : "#374151";
                return (
                  <div key={tf} className="border px-3 py-2"
                    style={{
                      borderColor: bull_ ? "#00ff8825" : bear_ ? "#ff1a4e25" : "#0d1520",
                      background: bull_ ? "rgba(0,255,136,0.02)" : bear_ ? "rgba(255,26,78,0.02)" : "transparent",
                    }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono text-cyan-500/60 font-bold w-8">[{tf}]</span>
                        {bull_  && <TrendingUp  size={10} style={{color:"#00ff88"}}/>}
                        {bear_  && <TrendingDown size={10} style={{color:"#ff1a4e"}}/>}
                        {dir === "FLAT" && <Minus size={10} className="text-gray-700"/>}
                        <span className="text-[9px] font-mono font-bold" style={{color:col_}}>{dir}</span>
                      </div>
                      <span className="text-[7px] font-mono text-orange-400 tabular-nums">
                        ATR {d.atr.toFixed(ind.digits >= 3 ? 5 : 3)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-[#0d1520] rounded-full overflow-hidden mb-1.5">
                      <div className="h-full rounded-full"
                        style={{width:`${pct}%`,background:`linear-gradient(90deg,${col_}20,${col_})`,transition:"width 0.8s ease"}}/>
                    </div>
                    <div className="flex gap-4 text-[7px] font-mono">
                      <span className="text-gray-700">EMA21 <span className="text-gray-300 tabular-nums">{d.ema21.toFixed(ind.digits >= 3 ? 5 : 3)}</span></span>
                      <span className="text-gray-700">EMA200 <span className="text-gray-300 tabular-nums">{d.ema200.toFixed(ind.digits >= 3 ? 5 : 3)}</span></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Session */}
          {(ind.sessions?.length || ind.brokerTime) ? (
            <div className="flex gap-4 text-[7px] font-mono">
              {ind.sessions?.length ? <span className="text-gray-700">SESSION <span className="text-cyan-400/70">{ind.sessions.join(" · ")}</span></span> : null}
              {ind.brokerTime > 0 ? <span className="text-gray-700">TIME <span className="text-gray-400">{new Date(ind.brokerTime * 1000).toLocaleTimeString("ja-JP")}</span></span> : null}
            </div>
          ) : null}

          {/* AI BRAIN link */}
          <div className="border border-purple-900/40 bg-purple-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Zap size={9} className="text-purple-400"/>
              <span className="text-[7.5px] font-mono text-purple-400/70 tracking-[0.2em]">AI BRAIN ANALYSIS</span>
            </div>
            <p className="text-[7px] font-mono text-gray-700 mb-2">MarketSnapshot → Decision Engine → Risk Engine → DRY RUN</p>
            <button onClick={() => onAnalyze(ind.symbol)}
              className="flex items-center gap-2 px-3 py-1.5 border border-purple-700/50 text-purple-300 bg-purple-950/20 hover:bg-purple-900/30 transition-all text-[8px] font-mono tracking-wider">
              <Zap size={9}/> ANALYZE {ind.symbol} WITH AI BRAIN
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main MarketsView ───────────────────────────────────────────────
export function MarketsView() {
  const { status }                                  = useConnectionStore();
  const { indicators, setIndicators,
          setIndicatorsBatch }                       = useIndicatorStore();
  const { symbolList, setSymbols }                  = useMarketStore();
  const { setActiveSymbol }              = usePriceStore();
  const router                           = useRouter();

  // ── WebSocket subscriptions + 初期 HTTP 取得 ────────────────────
  // 問題: Gateway は WebSocket 接続時に SYMBOLS は送るが INDICATORS は送らない。
  // 解決: 接続確立後に HTTP GET /indicators + /symbols で現在データを取得する。
  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;

    // リアルタイム購読
    const unsubInd  = client.onIndicators((ind) => setIndicators(ind));
    const unsubSyms = client.onSymbols((syms) => setSymbols(syms));

    // 初期データ HTTP 取得（SYMBOLS / INDICATORS イベントを逃した場合の補完）
    client.getIndicators().then((list) => {
      if (list.length > 0) setIndicatorsBatch(list);
    }).catch(() => {});

    client.getSymbols().then((syms) => {
      if (syms.length > 0) setSymbols(syms);
    }).catch(() => {});

    return () => { unsubInd(); unsubSyms(); };
  }, [status, setIndicators, setIndicatorsBatch, setSymbols]);

  // ── Derived data ───────────────────────────────────────────────
  const indList = useMemo(() =>
    Object.values(indicators).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [indicators]
  );

  const priceMap = useMemo(() => {
    const m: Record<string, {bid:number; ask:number; changePct:number; spread:number}> = {};
    for (const s of symbolList) {
      m[s.symbol.toUpperCase()] = {
        bid:       s.bid,
        ask:       s.ask,
        changePct: s.changePct,
        spread:    s.spread,
      };
    }
    return m;
  }, [symbolList]);

  // ── Scanner cycle ──────────────────────────────────────────────
  const [scanIdx, setScanIdx] = useState(0);
  useEffect(() => {
    if (indList.length === 0) return;
    const id = setInterval(() => setScanIdx(i => (i + 1) % indList.length), 3000);
    return () => clearInterval(id);
  }, [indList.length]);

  // ── Selected card ──────────────────────────────────────────────
  const [selectedSym, setSelectedSym] = useState<string | null>(null);

  const handleAnalyze = useCallback((sym: string) => {
    setActiveSymbol(sym as never);
    router.push("/");
  }, [setActiveSymbol, router]);

  // ── Stats ──────────────────────────────────────────────────────
  const isConnected = status === "connected";
  const now     = Date.now();
  const liveN   = indList.filter(i => now - i.receivedAt < 6000).length;
  const lastTs  = indList.length > 0 ? Math.max(...indList.map(i => i.receivedAt)) : 0;
  const scanSym = indList[scanIdx]?.symbol;

  // ── Card grid columns ──────────────────────────────────────────
  // lg: 4 cols / md: 2 cols / sm: 1 col
  const cols = indList.length;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#030508] min-w-0 relative"
      style={{background:"radial-gradient(ellipse at 50% 0%, #020c1a 0%, #030508 55%, #020408 100%)"}}>
      {/* Subtle background grid */}
      <div className="absolute inset-0 avl-grid-bg opacity-[0.06] pointer-events-none"/>
      {/* Scan line */}
      <div className="absolute left-0 right-0 h-px pointer-events-none avl-scan-line"
        style={{background:"linear-gradient(to right,transparent,rgba(0,229,255,0.12),transparent)"}}/>

      {/* ── HEADER ── */}
      <CommandCenterHeader
        isConnected={isConnected}
        totalSymbols={indList.length}
        liveCount={liveN}
        lastUpdateTs={lastTs}
      />

      {/* ── CARDS GRID ── */}
      <div className="flex-1 min-h-0 p-3 overflow-auto">
        {indList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Radio size={28} className="text-gray-800"/>
            <p className="text-[11px] text-gray-600 font-mono">
              {isConnected ? "MT5 インジケーターデータ待機中..." : "MT5 に接続してください"}
            </p>
            <p className="text-[8.5px] text-gray-800 font-mono">AVL_FX_Bridge.mq5 をチャートにアタッチ</p>
          </div>
        ) : (
          <div
            className={cn(
              "h-full grid gap-3",
              cols <= 1 ? "grid-cols-1" :
              cols <= 2 ? "grid-cols-1 sm:grid-cols-2" :
              cols <= 3 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" :
              "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
            )}
            style={{ gridAutoRows: "1fr" }}
          >
            {indList.map((ind) => {
              const p = priceMap[ind.symbol] ?? {bid:0, ask:0, changePct:0, spread:0};
              return (
                <SymbolCard
                  key={ind.symbol}
                  ind={ind}
                  bid={p.bid}
                  ask={p.ask}
                  changePct={p.changePct}
                  spread={p.spread}
                  isScanning={ind.symbol === scanSym}
                  onClick={() => setSelectedSym(prev => prev === ind.symbol ? null : ind.symbol)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── AI SCANNER PANEL ── */}
      <AIScannerPanel
        symbols={indList.map(i => i.symbol)}
        scanIdx={scanIdx}
        isConnected={isConnected}
      />

      {/* ── DETAIL PANEL (modal) ── */}
      {selectedSym && indicators[selectedSym] && (
        <ExpandedPanel
          ind={indicators[selectedSym]}
          bid={priceMap[selectedSym]?.bid ?? 0}
          ask={priceMap[selectedSym]?.ask ?? 0}
          changePct={priceMap[selectedSym]?.changePct ?? 0}
          onClose={() => setSelectedSym(null)}
          onAnalyze={handleAnalyze}
        />
      )}
    </div>
  );
}

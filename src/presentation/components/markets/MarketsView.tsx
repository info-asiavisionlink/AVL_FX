"use client";

// =================================================================
// AVL AI Market Command Center — MarketsView v4.0
//
// UI/UX大幅強化。データフロー・WebSocket・Store変更なし。
//
// 追加要素:
//   - AICommandBar: 画面上部に大型スキャナーバー
//   - AI Reasoning Flow: 下部にステージパイプライン
//   - SymbolCard: 完全刷新（DQバー・Tickフラッシュ・強化TFバー）
//   - スキャンステージ: DATA→STRUCTURE→MULTI-TF→TECHNICAL→CORRELATION→RISK→DECISION
// =================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useConnectionStore }  from "@/application/stores/connectionStore";
import { useIndicatorStore }   from "@/application/stores/indicatorStore";
import { useMarketStore }      from "@/application/stores/marketStore";
import { usePriceStore }       from "@/application/stores/priceStore";
import { ConnectionManager }   from "@/infrastructure/connection/ConnectionManager";
import { TrendingUp, TrendingDown, Minus, Zap, X, Cpu, ShieldAlert } from "lucide-react";
import type { IndicatorData }  from "@/application/stores/indicatorStore";
import type { MarketIntelligence, DataStatus } from "@/infrastructure/market-intelligence/types";

// ── AI Reasoning Stages (10段階) ───────────────────────────────────
const STAGES = ["DATA", "STRUCTURE", "MULTI-TF", "TECHNICAL", "SENTIMENT", "COT", "PUBLIC", "CORRELATION", "RISK", "DECISION"] as const;
type Stage = typeof STAGES[number];
const STAGE_MS = Math.floor(4000 / STAGES.length); // ~400ms per stage

// ── Constants ──────────────────────────────────────────────────────
const TFS = ["H4", "H1", "M15", "M5"] as const;

// ── Helpers ────────────────────────────────────────────────────────
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

function getDataQuality(ind: IndicatorData): { score: number; label: string; color: string } {
  const tfCount = TFS.filter(tf => (ind.timeframes?.[tf]?.ema21 ?? 0) > 0).length;
  const fresh   = Date.now() - (ind.receivedAt ?? 0) < 60_000;
  if (tfCount >= 4 && fresh) return { score: 90, label: "COMPLETE",   color: "#00ff88" };
  if (tfCount >= 3 && fresh) return { score: 75, label: "GOOD",       color: "#00e5ff" };
  if (tfCount >= 2)          return { score: 55, label: "PARTIAL",    color: "#f59e0b" };
  if (tfCount >= 1)          return { score: 30, label: "PRICE ONLY", color: "#f97316" };
  return                            { score: 0,  label: "NO DATA",    color: "#374151" };
}

function getBarPct(ema21: number, ema200: number, atr: number): number {
  const gap = Math.abs(ema21 - ema200);
  return Math.min(96, Math.max(8, (gap / Math.max(atr, 0.00001)) * 22 + 12));
}

function fmtPrice(v: number, digits: number): string {
  return v > 0 ? v.toFixed(digits >= 3 ? 5 : 3) : "—";
}

function formatAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

function fmtAgeMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000)       return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000)     return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86400_000)    return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86400_000)}d ago`;
}

function statusColor(s: DataStatus): string {
  switch (s) {
    case 'LIVE':               return '#00ff88';
    case 'FRESH':              return '#00e5ff';
    case 'STALE':              return '#f59e0b';
    case 'NO_DATA':            return '#374151';
    case 'SOURCE_UNAVAILABLE': return '#dc2626';
  }
}

function statusLabel(s: DataStatus): string {
  switch (s) {
    case 'LIVE':               return 'LIVE';
    case 'FRESH':              return 'FRESH';
    case 'STALE':              return 'STALE';
    case 'NO_DATA':            return 'NO DATA';
    case 'SOURCE_UNAVAILABLE': return 'UNAVAILABLE';
  }
}

// ── TF Direction Bar (enhanced) ─────────────────────────────────────
const TFBar = memo(function TFBar({
  tf, ema21, ema200, atr, digits, isActive,
}: {
  tf: string; ema21: number; ema200: number; atr: number; digits: number; isActive: boolean;
}) {
  if (ema21 === 0) return (
    <div className="flex items-center gap-2 h-6">
      <span className="text-[8px] font-mono text-gray-800 w-7 shrink-0 font-bold">{tf}</span>
      <div className="flex-1 h-2 bg-[#0a1018] rounded-sm flex items-center px-1">
        <span className="text-[6px] font-mono text-gray-800">NO DATA</span>
      </div>
    </div>
  );

  const dir  = getDir(ema21, ema200);
  const pct  = getBarPct(ema21, ema200, atr);
  const bull = dir === "BULL";
  const bear = dir === "BEAR";
  const col  = bull ? "#00ff88" : bear ? "#ff1a4e" : "#374151";
  const icon = bull ? "▲" : bear ? "▼" : "●";

  return (
    <div className="flex items-center gap-2 h-6">
      <span className="text-[8px] font-mono w-7 shrink-0 font-bold" style={{ color: col }}>{tf}</span>

      {/* Direction bar */}
      <div className="relative flex-1 h-2.5 bg-[#0a1018] rounded-sm overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-sm"
          style={{
            width: `${pct}%`,
            background: bull
              ? "linear-gradient(90deg,rgba(0,255,136,0.15),#00ff88)"
              : bear
              ? "linear-gradient(90deg,rgba(255,26,78,0.15),#ff1a4e)"
              : "#374151",
            transition: "width 0.9s ease",
            animation: isActive
              ? bull ? "avl-flow-right 1.2s linear infinite"
              : bear ? "avl-flow-left 1.2s linear infinite"
              : undefined
              : undefined,
            backgroundSize: isActive ? "200% 100%" : "100% 100%",
          }}
        />
        {/* Moving glow on active */}
        {isActive && (
          <div className="absolute inset-y-0 w-6 pointer-events-none"
            style={{
              background: `linear-gradient(90deg,transparent,${col}30,transparent)`,
              animation: "avl-scan-h 1.5s ease-in-out infinite",
            }}/>
        )}
      </div>

      {/* Direction label */}
      <div className="flex items-center gap-1 w-14 shrink-0">
        <span className="text-[9px] font-mono font-black" style={{ color: col }}>{icon}</span>
        <span className="text-[7.5px] font-mono font-bold" style={{ color: col }}>{dir}</span>
      </div>

      {/* ATR */}
      <span className="text-[6.5px] font-mono text-gray-800 w-12 shrink-0 text-right tabular-nums">
        {atr > 0 ? atr.toFixed(digits >= 3 ? 4 : 2) : "—"}
      </span>
    </div>
  );
});

// ── Symbol Card (v6 — inline full detail, no click needed) ──────────
const SymbolCard = memo(function SymbolCard({
  ind, bid, ask, changePct, spread, isScanning, onClick, intelligence, intelligenceLoading,
}: {
  ind: IndicatorData; bid: number; ask: number; changePct: number; spread: number;
  isScanning: boolean; onClick: () => void;
  intelligence?: MarketIntelligence | null;
  intelligenceLoading?: boolean;
}) {
  // ── Tick flash: fires on any data update ──
  const [tickFlash, setTickFlash]   = useState(false);
  const [priceGlow, setPriceGlow]   = useState(false);
  const prevTs  = useRef(ind.receivedAt);
  const prevBid = useRef(bid);

  useEffect(() => {
    const tsChanged  = ind.receivedAt > prevTs.current;
    const bidChanged = bid > 0 && bid !== prevBid.current;
    if (!tsChanged && !bidChanged) return;

    prevTs.current  = ind.receivedAt;
    prevBid.current = bid;
    setTickFlash(true);
    if (bidChanged) setPriceGlow(true);
    const t1 = setTimeout(() => setTickFlash(false), 600);
    const t2 = setTimeout(() => setPriceGlow(false), 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [ind.receivedAt, bid]);

  const { bull, bear, total } = getTFSummary(ind);
  const bias       = getAIBias(ind);
  const dq         = getDataQuality(ind);
  const ageMs      = Date.now() - ind.receivedAt;
  const isLive     = ageMs < 6_000;
  const overallDir = bull > bear ? "BULL" : bear > bull ? "BEAR" : "FLAT";

  const biasColor = bias === "BUY" ? "#00ff88" : bias === "SELL" ? "#ff1a4e" : "#00e5ff";
  const dirColor  = overallDir === "BULL" ? "#00ff88" : overallDir === "BEAR" ? "#ff1a4e" : "#1e3a5f";

  const borderColor = isScanning ? "#00e5ff"
    : overallDir === "BULL" ? "#00ff8850"
    : overallDir === "BEAR" ? "#ff1a4e50"
    : "#0d1a27";

  return (
    <div
      onClick={onClick}
      className="relative flex flex-col border cursor-pointer overflow-hidden select-none"
      style={{
        borderColor,
        background: isScanning
          ? "rgba(0,18,36,0.98)"
          : overallDir === "BULL" ? "rgba(0,10,6,0.98)"
          : overallDir === "BEAR" ? "rgba(10,2,4,0.98)"
          : "rgba(2,4,10,0.98)",
        boxShadow: isScanning
          ? "0 0 24px rgba(0,229,255,0.15), inset 0 0 40px rgba(0,229,255,0.03)"
          : overallDir === "BULL" ? "0 0 12px rgba(0,255,136,0.08)"
          : overallDir === "BEAR" ? "0 0 12px rgba(255,26,78,0.08)"
          : "none",
        animation: isScanning ? "avl-scan-pulse 2s ease-in-out infinite" : "none",
        transition: "border-color 0.4s, box-shadow 0.4s",
      }}
    >
      {/* Top accent line */}
      <div className="absolute top-0 left-0 right-0 h-0.5 pointer-events-none"
        style={{
          background: isScanning
            ? "linear-gradient(90deg,transparent 0%,#00e5ff 40%,#00e5ff 60%,transparent 100%)"
            : `linear-gradient(90deg,transparent,${dirColor},transparent)`,
          opacity: isScanning ? 1 : 0.6,
        }}/>

      {/* Corner brackets — HUD style */}
      {(["tl","tr","bl","br"] as const).map((pos, i) => {
        const bCol = isScanning ? "#00e5ff" : borderColor;
        return (
          <div key={pos} className="absolute pointer-events-none"
            style={{
              top:    pos.startsWith("t") ? 0 : "auto",
              bottom: pos.startsWith("b") ? 0 : "auto",
              left:   pos.endsWith("l")   ? 0 : "auto",
              right:  pos.endsWith("r")   ? 0 : "auto",
              width: 10, height: 10,
              borderTop:    pos.startsWith("t") ? `1.5px solid ${bCol}` : "none",
              borderBottom: pos.startsWith("b") ? `1.5px solid ${bCol}` : "none",
              borderLeft:   pos.endsWith("l")   ? `1.5px solid ${bCol}` : "none",
              borderRight:  pos.endsWith("r")   ? `1.5px solid ${bCol}` : "none",
              animation: isScanning
                ? `avl-border-corner 2s ease-in-out ${i * 0.2}s infinite`
                : "none",
            }}/>
        );
      })}

      {/* Data flash overlay (on tick) */}
      <div className="absolute inset-0 pointer-events-none z-20 transition-opacity duration-500"
        style={{ background: "rgba(0,229,255,0.06)", opacity: tickFlash ? 1 : 0 }}/>

      {/* Scan overlays */}
      {isScanning && (
        <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
          <div className="absolute inset-x-0 h-16"
            style={{
              background: "linear-gradient(180deg,transparent,rgba(0,229,255,0.04),transparent)",
              animation: "avl-scan-v 2.5s linear infinite",
            }}/>
        </div>
      )}

      {/* ── CONTENT ── */}
      <div className="relative z-[5] flex flex-col flex-1 p-3 gap-2">

        {/* Row 1: Status badge + Symbol */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            {/* Live dot — only pulses on data update */}
            <div
              className={cn("w-1.5 h-1.5 rounded-full shrink-0 transition-colors duration-300",
                isLive ? "bg-green-400" : ageMs < 30000 ? "bg-yellow-500" : "bg-gray-800"
              )}
              style={tickFlash ? { animation: "avl-blink 0.3s ease-in-out 2" } : undefined}
            />
            <span className="text-[22px] font-black font-mono text-gray-100 leading-none tracking-widest">
              {ind.symbol}
            </span>
          </div>

          <div className="flex flex-col items-end gap-0.5">
            {isScanning ? (
              <span className="text-[7px] font-mono font-bold tracking-[0.25em] text-cyan-400"
                style={{ animation: "avl-blink 1s ease-in-out infinite" }}>
                ◉ SCANNING
              </span>
            ) : (
              <span className={cn("text-[7px] font-mono",
                isLive ? "text-green-400/80" : "text-gray-700")}>
                {isLive ? "● LIVE" : `${formatAge(ind.receivedAt)} ago`}
              </span>
            )}
            {changePct !== 0 && (
              <span className={cn("text-[8px] font-mono tabular-nums font-semibold",
                changePct > 0 ? "text-green-400" : "text-red-400")}>
                {changePct > 0 ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        {/* Row 2: BIAS — primary information */}
        <div className="shrink-0 flex items-center justify-center py-2 border"
          style={{
            borderColor: `${biasColor}25`,
            background: `${biasColor}08`,
          }}>
          <div className="flex items-center gap-2">
            {bias === "BUY"  && <TrendingUp  size={18} style={{ color: "#00ff88" }}/>}
            {bias === "SELL" && <TrendingDown size={18} style={{ color: "#ff1a4e" }}/>}
            {bias === "WAIT" && <Minus size={18} style={{ color: "#00e5ff" }}/>}
            <span className="text-[20px] font-black font-mono"
              style={{ color: biasColor, textShadow: `0 0 16px ${biasColor}50` }}>
              {bias === "BUY" ? "▲ BUY" : bias === "SELL" ? "▼ SELL" : "● WAIT"}
            </span>
          </div>
        </div>

        {/* Row 3: Price */}
        <div className="shrink-0">
          {bid > 0 ? (
            <>
              <div className="text-center mb-1">
                <span
                  className="text-[28px] font-black font-mono tabular-nums leading-none transition-all duration-300"
                  style={{
                    color: priceGlow ? biasColor : "#e5e7eb",
                    textShadow: priceGlow
                      ? `0 0 24px ${biasColor}80`
                      : overallDir === "BULL" ? "0 0 12px rgba(0,255,136,0.15)"
                      : overallDir === "BEAR" ? "0 0 12px rgba(255,26,78,0.15)"
                      : "none",
                  }}>
                  {fmtPrice(bid, ind.digits)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[7.5px] font-mono">
                <div className="flex gap-3 text-gray-700">
                  <span>BID <span className="text-gray-400 tabular-nums">{fmtPrice(bid, ind.digits)}</span></span>
                  <span>ASK <span className="text-gray-400 tabular-nums">{fmtPrice(ask, ind.digits)}</span></span>
                </div>
                <span className={cn("font-bold tabular-nums",
                  spread > 5 ? "text-red-400" : spread > 2.5 ? "text-yellow-400" : "text-cyan-600")}>
                  SPR {(spread > 0 ? spread : ind.spread).toFixed(1)}p
                </span>
              </div>
            </>
          ) : (
            <div className="text-center py-2">
              <span className="text-[13px] font-mono text-gray-800 tracking-widest">PRICE UNAVAILABLE</span>
            </div>
          )}
        </div>

        {/* Row 4: MULTI-TF bars */}
        <div className="flex-1 flex flex-col gap-0">
          {/* Header */}
          <div className="flex items-center justify-between mb-1 shrink-0">
            <span className="text-[6.5px] font-mono text-gray-700 tracking-[0.25em]">MULTI-TF ANALYSIS</span>
            <div className="flex items-center gap-2 text-[7.5px] font-mono font-bold">
              {total === 0 ? (
                <span className="text-gray-800">NO DATA</span>
              ) : (
                <>
                  {bull > 0 && <span className="text-green-400">▲{bull}</span>}
                  {bear > 0 && <span className="text-red-400">▼{bear}</span>}
                  {bull === 0 && bear === 0 && <span className="text-gray-700">—</span>}
                  <span className="text-gray-700">/{total}</span>
                </>
              )}
            </div>
          </div>

          {/* TF bars */}
          <div className="flex flex-col gap-1 flex-1 justify-around">
            {TFS.map(tf => {
              const d = ind.timeframes?.[tf];
              return (
                <TFBar
                  key={tf}
                  tf={tf}
                  ema21={d?.ema21 ?? 0}
                  ema200={d?.ema200 ?? 0}
                  atr={d?.atr ?? 0}
                  digits={ind.digits}
                  isActive={isScanning}
                />
              );
            })}
          </div>
        </div>

        {/* Row 5: Market Intelligence — inline full detail */}
        <div className="shrink-0 border-t border-[#0d1520] pt-2 space-y-1.5">
          <div className="flex items-center gap-1.5 mb-1">
            <ShieldAlert size={7} style={{ color: "#00e5ff80" }}/>
            <span className="text-[6px] font-mono tracking-[0.2em]" style={{ color: "#00e5ff70" }}>MARKET INTELLIGENCE</span>
            {intelligenceLoading && (
              <span className="text-[5.5px] font-mono ml-auto" style={{ color: "#00e5ff60", animation: "avl-blink 1s ease-in-out infinite" }}>FETCHING</span>
            )}
          </div>

          {/* COT */}
          <div className="flex items-center justify-between text-[7.5px] font-mono">
            <span className="w-10 shrink-0 font-bold" style={{ color: "#6b7280" }}>COT</span>
            {!intelligence || intelligence.cot.status === 'NO_DATA' || intelligence.cot.status === 'SOURCE_UNAVAILABLE' ? (
              <span style={{ color: "#4b5563" }}>NO DATA</span>
            ) : (
              <div className="flex items-center gap-2 flex-1 justify-end">
                <span className="text-green-400">L{intelligence.cot.longPct}%</span>
                <span className="text-red-400">S{intelligence.cot.shortPct}%</span>
                <span className="font-bold tabular-nums"
                  style={{ color: (intelligence.cot.netPct ?? 0) > 0 ? '#00ff88' : (intelligence.cot.netPct ?? 0) < 0 ? '#ff1a4e' : '#6b7280' }}>
                  NET {(intelligence.cot.netPct ?? 0) > 0 ? '+' : ''}{intelligence.cot.netPct}%
                </span>
              </div>
            )}
          </div>

          {/* SENTIMENT */}
          <div className="flex items-center justify-between text-[7.5px] font-mono">
            <span className="w-10 shrink-0 font-bold" style={{ color: "#6b7280" }}>SENT</span>
            {!intelligence || intelligence.sentiment.status === 'NO_DATA' || intelligence.sentiment.status === 'SOURCE_UNAVAILABLE' ? (
              <span style={{ color: "#4b5563" }}>NO DATA</span>
            ) : (
              <div className="flex items-center gap-2 flex-1 justify-end">
                <span className="text-green-400">L{intelligence.sentiment.longPct}%</span>
                <span className="text-red-400">S{intelligence.sentiment.shortPct}%</span>
              </div>
            )}
          </div>

          {/* PUBLIC */}
          <div className="flex items-center justify-between text-[7.5px] font-mono">
            <span className="w-10 shrink-0 font-bold" style={{ color: "#6b7280" }}>PUB</span>
            {!intelligence || intelligence.publicPositioning.status === 'NO_DATA' || intelligence.publicPositioning.status === 'SOURCE_UNAVAILABLE' ? (
              <span style={{ color: "#4b5563" }}>NO DATA</span>
            ) : (
              <div className="flex items-center gap-2 flex-1 justify-end">
                <span className="text-green-400">L{intelligence.publicPositioning.longPct}%</span>
                <span className="text-red-400">S{intelligence.publicPositioning.shortPct}%</span>
              </div>
            )}
          </div>

          {/* COT disclaimer */}
          {intelligence && intelligence.cot.reportDate && (
            <div className="flex items-center justify-between text-[5.5px] font-mono" style={{ color: "#374151" }}>
              <span>CFTC FUTURES · {intelligence.cot.reportDate}</span>
              <span className="text-yellow-800">≠ SPOT</span>
            </div>
          )}
        </div>

        {/* Row 6: Data Quality bar */}
        <div className="shrink-0 pt-2 border-t border-[#0d1520]">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <span className="text-[6.5px] font-mono text-gray-700 tracking-[0.2em]">DATA QUALITY</span>
              <span className="text-[7.5px] font-mono font-bold tabular-nums"
                style={{ color: dq.color }}>{dq.score}</span>
              <span className="text-[6.5px] font-mono" style={{ color: `${dq.color}80` }}>{dq.label}</span>
            </div>
            {ind.sessions?.[0] && (
              <span className="text-[6px] font-mono text-gray-800">
                {ind.sessions[0].replace(" Session", "")}
              </span>
            )}
          </div>
          {/* DQ progress bar */}
          <div className="h-1 bg-[#0a1018] rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${dq.score}%`,
                background: `linear-gradient(90deg,${dq.color}40,${dq.color})`,
              }}/>
          </div>
        </div>
      </div>
    </div>
  );
});

// ── AI Command Bar (top) ────────────────────────────────────────────
function AICommandBar({
  symbols, scanIdx, stageIdx, isConnected,
}: {
  symbols: string[]; scanIdx: number; stageIdx: number; isConnected: boolean;
}) {
  if (symbols.length === 0 || !isConnected) return null;

  const currentSym   = symbols[scanIdx] ?? "—";
  const currentStage = STAGES[stageIdx];

  return (
    <div className="shrink-0 border-b border-cyan-900/20 bg-[#010509] relative overflow-hidden">
      {/* Animated top line */}
      <div className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: "linear-gradient(90deg,transparent,rgba(0,229,255,0.5),transparent)",
          animation: "avl-scan-h 3s linear infinite",
        }}/>

      <div className="px-4 py-2 flex items-center gap-4">
        {/* AI Icon + Label */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <Cpu size={14} className="text-cyan-400"
              style={{ animation: "avl-blink 2s ease-in-out infinite" }}/>
          </div>
          <div>
            <p className="text-[6px] font-mono text-gray-700 tracking-[0.3em] leading-none">AVL AI</p>
            <p className="text-[8px] font-mono font-bold text-cyan-400 tracking-[0.1em] leading-none">
              MARKET SCANNER
            </p>
          </div>
        </div>

        <div className="w-px h-8 bg-cyan-900/30 shrink-0"/>

        {/* Current target */}
        <div className="shrink-0">
          <p className="text-[6px] font-mono text-gray-700 tracking-wider leading-none mb-0.5">SCANNING</p>
          <p className="text-[18px] font-black font-mono text-cyan-300 leading-none"
            style={{ textShadow: "0 0 16px rgba(0,229,255,0.6)" }}
            suppressHydrationWarning>
            {currentSym}
          </p>
        </div>

        {/* Stage pipeline */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 overflow-hidden">
            {STAGES.map((stage, i) => {
              const isDone    = i < stageIdx;
              const isCurrent = i === stageIdx;
              const isPending = i > stageIdx;
              return (
                <div key={stage} className="flex items-center gap-1 min-w-0 flex-1">
                  <div className="flex flex-col items-center min-w-0 flex-1">
                    <div
                      className="w-full h-0.5 mb-0.5 rounded-full transition-all duration-300"
                      style={{
                        background: isCurrent
                          ? "#00e5ff"
                          : isDone
                          ? "#00ff8850"
                          : "#0d1520",
                        boxShadow: isCurrent ? "0 0 6px rgba(0,229,255,0.8)" : "none",
                        animation: isCurrent ? "avl-scan-pulse 1s ease-in-out infinite" : "none",
                      }}/>
                    <span
                      className="text-[5.5px] font-mono font-bold tracking-wider truncate w-full text-center leading-none"
                      style={{
                        color: isCurrent ? "#00e5ff"
                          : isDone ? "#00ff8860"
                          : "#1f2a36",
                        textShadow: isCurrent ? "0 0 6px rgba(0,229,255,0.6)" : "none",
                      }}>
                      {stage}
                    </span>
                  </div>
                  {i < STAGES.length - 1 && (
                    <span className="text-[6px] shrink-0"
                      style={{ color: isDone ? "#00ff8840" : "#0d1520" }}>›</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Symbol quick-view */}
        <div className="shrink-0 flex items-center gap-2">
          {symbols.map((sym, i) => {
            const active = i === scanIdx;
            const done   = i < scanIdx;
            return (
              <div key={sym} className="flex flex-col items-center gap-0.5">
                <div className="h-0.5 w-8 rounded-full transition-all duration-300"
                  style={{
                    background: active ? "#00e5ff" : done ? "#00ff8850" : "#0d1520",
                    boxShadow: active ? "0 0 4px rgba(0,229,255,0.6)" : "none",
                  }}/>
                <span className="text-[5.5px] font-mono"
                  style={{ color: active ? "#00e5ff" : done ? "#374151" : "#1f2a36" }}>
                  {sym}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── AI Reasoning Flow (bottom) ──────────────────────────────────────
function AIReasoningFlow({
  symbols, scanIdx, stageIdx, isConnected,
}: {
  symbols: string[]; scanIdx: number; stageIdx: number; isConnected: boolean;
}) {
  if (symbols.length === 0) return null;

  const currentSym   = symbols[scanIdx] ?? "—";
  const currentStage = STAGES[stageIdx];
  const isDone       = stageIdx === STAGES.length - 1;

  return (
    <div className="shrink-0 border-t border-cyan-900/20 bg-[#010509] relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent"/>

      <div className="px-4 py-2.5 flex items-center gap-4">
        {/* Label */}
        <div className="shrink-0">
          <p className="text-[5.5px] font-mono text-gray-700 tracking-[0.3em] leading-none mb-0.5">AI REASONING</p>
          <p className="text-[8.5px] font-mono font-bold leading-none"
            style={{ color: isDone ? "#00ff88" : "#00e5ff" }}
            suppressHydrationWarning>
            {isDone ? `✓ ${currentSym}` : `${currentStage}`}
          </p>
        </div>

        <div className="w-px h-8 bg-cyan-900/25 shrink-0"/>

        {/* Stage dots */}
        <div className="flex items-center gap-3 flex-1">
          {STAGES.map((stage, i) => {
            const isDone_    = i < stageIdx;
            const isCurrent_ = i === stageIdx;
            return (
              <div key={stage} className="flex items-center gap-1 shrink-0">
                {i > 0 && <div className="w-3 h-px"
                  style={{ background: isDone_ || isCurrent_ ? "#00ff8820" : "#0d1520" }}/>}
                <div className="flex flex-col items-center gap-0.5">
                  <div
                    className="rounded-full transition-all duration-300"
                    style={{
                      width: isCurrent_ ? 8 : 5,
                      height: isCurrent_ ? 8 : 5,
                      background: isCurrent_ ? "#00e5ff"
                        : isDone_ ? "#00ff88"
                        : "#0d1520",
                      boxShadow: isCurrent_ ? "0 0 8px rgba(0,229,255,0.8)" : "none",
                      animation: isCurrent_ ? "avl-blink 0.8s ease-in-out infinite" : "none",
                    }}/>
                  <span className="text-[5px] font-mono font-bold"
                    style={{
                      color: isCurrent_ ? "#00e5ff" : isDone_ ? "#00ff8870" : "#1f2a36",
                    }}>
                    {stage}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Current analysis text */}
        <div className="shrink-0 text-right">
          <p className="text-[6px] font-mono text-gray-700 tracking-wider" suppressHydrationWarning>
            {isConnected ? "ANALYZING" : "OFFLINE"}
          </p>
          <p className="text-[10px] font-black font-mono"
            style={{ color: "#00e5ff", textShadow: "0 0 6px rgba(0,229,255,0.4)" }}
            suppressHydrationWarning>
            {currentSym}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Command Center Header ──────────────────────────────────────────
function CommandCenterHeader({
  isConnected, totalSymbols, liveCount, lastUpdateTs, tickFlash,
}: {
  isConnected: boolean; totalSymbols: number; liveCount: number;
  lastUpdateTs: number; tickFlash: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ageMs = lastUpdateTs > 0 ? now - lastUpdateTs : null;

  return (
    <div className="shrink-0 border-b border-cyan-900/25 bg-[#010408] relative overflow-hidden">
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent"/>
      {isConnected && (
        <div className="absolute top-0 left-0 right-0 h-px"
          style={{
            background: "linear-gradient(90deg,transparent,rgba(0,229,255,0.35),transparent)",
            animation: "avl-scan-h 5s linear infinite",
          }}/>
      )}

      <div className="pl-14 pr-4 md:px-5 py-2.5 flex items-center gap-3 md:gap-5">
        {/* Title */}
        <div className="shrink-0 flex items-center gap-2.5">
          <div className="flex gap-0.5">
            <div className="w-0.5 h-7" style={{ background: "#00e5ff", boxShadow: "0 0 8px #00e5ff" }}/>
            <div className="w-0.5 h-7 bg-cyan-400/20"/>
          </div>
          <div>
            <p className="text-[7px] font-mono text-purple-400/50 tracking-[0.35em] leading-none mb-0.5">AVL AI</p>
            <p className="text-[12px] font-black font-mono tracking-[0.12em] leading-none"
              style={{ color: "#00e5ff", textShadow: "0 0 14px rgba(0,229,255,0.45)" }}>
              MARKET COMMAND CENTER
            </p>
          </div>
        </div>

        <div className="w-px h-9 bg-cyan-900/25"/>

        {/* Connection status */}
        <div className="flex items-center gap-3 shrink-0">
          {(["MT5","RAILWAY","WS"] as const).map((label) => (
            <div key={label} className="flex items-center gap-1">
              <div
                className={cn("w-1.5 h-1.5 rounded-full transition-colors duration-500",
                  isConnected ? "bg-green-400" : "bg-gray-800")}
                style={isConnected && tickFlash
                  ? { animation: "avl-blink 0.3s ease-in-out 3", boxShadow: "0 0 6px #00ff88" }
                  : isConnected
                  ? { boxShadow: "0 0 4px rgba(0,255,136,0.4)" }
                  : undefined}
              />
              <span className={cn("text-[6.5px] font-mono",
                isConnected ? "text-green-400/70" : "text-gray-800")}>
                {label}
              </span>
            </div>
          ))}
        </div>

        <div className="w-px h-9 bg-cyan-900/25"/>

        {/* Stats */}
        <div className="flex items-center gap-5">
          <div className="text-center">
            <p className="text-[20px] font-black font-mono tabular-nums text-cyan-400 leading-none"
              style={{ textShadow: "0 0 10px rgba(0,229,255,0.4)" }}>
              {totalSymbols}
            </p>
            <p className="text-[5.5px] font-mono text-gray-700 tracking-wider">SYMBOLS</p>
          </div>
          <div className="text-center">
            <p className={cn("text-[20px] font-black font-mono tabular-nums leading-none",
              liveCount > 0 ? "text-green-400" : "text-gray-800")}
              style={liveCount > 0 ? { textShadow: "0 0 10px rgba(0,255,136,0.4)" } : undefined}>
              {liveCount}
            </p>
            <p className="text-[5.5px] font-mono text-gray-700 tracking-wider">LIVE</p>
          </div>
        </div>

        <div className="flex-1"/>

        {/* Right side status */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-1.5">
            <div
              className={cn("w-2 h-2 rounded-full transition-colors duration-500",
                isConnected ? "bg-green-400" : "bg-gray-800")}
              style={isConnected ? { boxShadow: "0 0 6px rgba(0,255,136,0.5)" } : undefined}/>
            <span className={cn("text-[10px] font-mono font-bold tracking-wider",
              isConnected ? "text-green-400" : "text-gray-700")}>
              {isConnected ? "LIVE" : "OFFLINE"}
            </span>
          </div>
          {ageMs !== null && (
            <span className={cn("text-[6.5px] font-mono tabular-nums",
              ageMs < 3000 ? "text-green-400/70" : ageMs < 15000 ? "text-yellow-400/70" : "text-gray-700")}>
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
  ind, bid, ask, changePct, onClose, onAnalyze, intelligence, intelligenceLoading,
}: {
  ind: IndicatorData; bid: number; ask: number; changePct: number;
  onClose: () => void; onAnalyze: (sym: string) => void;
  intelligence?: MarketIntelligence | null;
  intelligenceLoading?: boolean;
}) {
  const bias      = getAIBias(ind);
  const dq        = getDataQuality(ind);
  const { bull, bear, total } = getTFSummary(ind);
  const biasColor = bias === "BUY" ? "#00ff88" : bias === "SELL" ? "#ff1a4e" : "#00e5ff";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl border border-cyan-900/50 bg-[#030508] overflow-hidden relative"
        style={{ boxShadow: "0 0 60px rgba(0,229,255,0.1)" }}>
        <div className="absolute top-0 left-0 right-0 h-px"
          style={{ background: `linear-gradient(90deg,transparent,${biasColor}50,transparent)` }}/>

        <div className="flex items-center justify-between px-5 py-4 border-b border-cyan-900/20">
          <div className="flex items-center gap-3">
            <span className="text-[20px] font-black font-mono text-gray-100">{ind.symbol}</span>
            <span className="text-[10px] font-mono font-bold px-2 py-1 border"
              style={{ color: biasColor, borderColor: `${biasColor}50`, background: `${biasColor}10` }}>
              {bias === "BUY" ? "▲ BUY" : bias === "SELL" ? "▼ SELL" : "● WAIT"}
            </span>
            <span className="text-[7px] font-mono px-1.5 py-0.5 border font-bold"
              style={{ color: dq.color, borderColor: `${dq.color}40`, background: `${dq.color}08` }}>
              DQ {dq.score} {dq.label}
            </span>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors p-1">
            <X size={16}/>
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto avl-scroll">
          {bid > 0 && (
            <div className="flex items-baseline gap-5">
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">BID</p>
                <p className="text-[22px] font-mono tabular-nums text-gray-100 font-bold">{fmtPrice(bid, ind.digits)}</p>
              </div>
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">ASK</p>
                <p className="text-[22px] font-mono tabular-nums text-gray-400 font-bold">{fmtPrice(ask, ind.digits)}</p>
              </div>
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">SPREAD</p>
                <p className="text-[16px] font-mono font-bold text-yellow-400">{ind.spread.toFixed(1)}p</p>
              </div>
              {changePct !== 0 && (
                <div>
                  <p className="text-[7px] font-mono text-gray-700 mb-0.5">CHG</p>
                  <p className={cn("text-[16px] font-mono font-bold",
                    changePct >= 0 ? "text-green-400" : "text-red-400")}>
                    {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
                  </p>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[7.5px] font-mono text-cyan-400/60 tracking-[0.2em]">MULTI-TIMEFRAME ANALYSIS</p>
              <div className="flex gap-3 text-[8px] font-mono font-bold">
                {bull > 0 && <span className="text-green-400">▲ {bull}/{total} BULL</span>}
                {bear > 0 && <span className="text-red-400">▼ {bear}/{total} BEAR</span>}
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
                const dir   = getDir(d.ema21, d.ema200);
                const pct   = getBarPct(d.ema21, d.ema200, d.atr);
                const bull_ = dir === "BULL";
                const bear_ = dir === "BEAR";
                const col_  = bull_ ? "#00ff88" : bear_ ? "#ff1a4e" : "#374151";
                return (
                  <div key={tf} className="border px-3 py-2"
                    style={{
                      borderColor: bull_ ? "#00ff8820" : bear_ ? "#ff1a4e20" : "#0d1520",
                      background: bull_ ? "rgba(0,255,136,0.02)" : bear_ ? "rgba(255,26,78,0.02)" : "transparent",
                    }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] font-mono font-bold w-7" style={{ color: col_ }}>{tf}</span>
                        {bull_ && <TrendingUp size={9} style={{ color: "#00ff88" }}/>}
                        {bear_ && <TrendingDown size={9} style={{ color: "#ff1a4e" }}/>}
                        {dir === "FLAT" && <Minus size={9} className="text-gray-700"/>}
                        <span className="text-[8px] font-mono font-bold" style={{ color: col_ }}>{dir}</span>
                      </div>
                      <span className="text-[7px] font-mono text-orange-400/70 tabular-nums">
                        ATR {d.atr.toFixed(ind.digits >= 3 ? 5 : 3)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-[#0d1520] rounded-full overflow-hidden mb-1.5">
                      <div className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: `linear-gradient(90deg,${col_}20,${col_})`, transition: "width 0.8s ease" }}/>
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

          {(ind.sessions?.length || ind.brokerTime > 0) && (
            <div className="flex gap-4 text-[7px] font-mono">
              {ind.sessions?.length ? (
                <span className="text-gray-700">SESSION <span className="text-cyan-400/70">{ind.sessions.join(" · ")}</span></span>
              ) : null}
              {ind.brokerTime > 0 ? (
                <span className="text-gray-700">BROKER TIME <span className="text-gray-400">{new Date(ind.brokerTime * 1000).toLocaleTimeString("ja-JP")}</span></span>
              ) : null}
            </div>
          )}

          {/* ── MARKET INTELLIGENCE ── */}
          <div className="border border-cyan-900/30 bg-[#020810] p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert size={9} className="text-cyan-400/60"/>
                <span className="text-[7px] font-mono text-cyan-400/60 tracking-[0.2em]">MARKET INTELLIGENCE</span>
              </div>
              {intelligenceLoading && (
                <span className="text-[6px] font-mono text-cyan-700 tracking-wider"
                  style={{ animation: "avl-blink 1s ease-in-out infinite" }}>FETCHING...</span>
              )}
            </div>

            {intelligence ? (
              <div className="space-y-2">
                {/* SENTIMENT */}
                <div className="border border-[#0d1520] px-3 py-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[7px] font-mono text-gray-600 tracking-wider">BROKER SENTIMENT</span>
                    <span className="text-[6px] font-mono" style={{ color: statusColor(intelligence.sentiment.status) }}>
                      {statusLabel(intelligence.sentiment.status)}
                    </span>
                  </div>
                  {intelligence.sentiment.longPct !== null ? (
                    <div className="flex items-center gap-4 text-[7.5px] font-mono">
                      <span className="text-green-400 font-bold">LONG {intelligence.sentiment.longPct}%</span>
                      <span className="text-red-400 font-bold">SHORT {intelligence.sentiment.shortPct}%</span>
                    </div>
                  ) : (
                    <span className="text-[7px] font-mono text-gray-800">NO DATA</span>
                  )}
                  <div className="mt-1 flex gap-3 text-[6px] font-mono text-gray-800">
                    <span>SOURCE {intelligence.sentiment.source.name}</span>
                    {intelligence.sentiment.source.ageMs !== null &&
                      <span>UPDATED {fmtAgeMs(intelligence.sentiment.source.ageMs)}</span>}
                  </div>
                </div>

                {/* COT */}
                <div className="border border-[#0d1520] px-3 py-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <div>
                      <span className="text-[7px] font-mono text-gray-600 tracking-wider">COT</span>
                      <span className="text-[6px] font-mono text-gray-800 ml-2">NON-COMMERCIAL FUTURES</span>
                    </div>
                    <span className="text-[6px] font-mono" style={{ color: statusColor(intelligence.cot.status) }}>
                      {statusLabel(intelligence.cot.status)}
                    </span>
                  </div>
                  {intelligence.cot.longPct !== null ? (
                    <>
                      <div className="flex items-center gap-4 text-[7.5px] font-mono mb-1">
                        <span className="text-green-400 font-bold">LONG {intelligence.cot.longPct}%</span>
                        <span className="text-red-400 font-bold">SHORT {intelligence.cot.shortPct}%</span>
                        <span className="font-bold tabular-nums"
                          style={{ color: (intelligence.cot.netPct ?? 0) > 0 ? '#00ff88' : (intelligence.cot.netPct ?? 0) < 0 ? '#ff1a4e' : '#374151' }}>
                          NET {(intelligence.cot.netPct ?? 0) > 0 ? '+' : ''}{intelligence.cot.netPct ?? 0}%
                        </span>
                      </div>
                      <div className="h-1 bg-[#0a1018] rounded-full overflow-hidden">
                        <div className="h-full rounded-full"
                          style={{ width: `${intelligence.cot.longPct}%`, background: 'linear-gradient(90deg,rgba(0,255,136,0.3),#00ff88)' }}/>
                      </div>
                    </>
                  ) : (
                    <span className="text-[7px] font-mono text-gray-800">NO DATA</span>
                  )}
                  <div className="mt-1 flex gap-3 text-[6px] font-mono text-gray-800 flex-wrap">
                    <span>SOURCE {intelligence.cot.source.name}</span>
                    {intelligence.cot.reportDate && <span>WEEK {intelligence.cot.reportDate}</span>}
                    {intelligence.cot.source.ageMs !== null && <span>UPDATED {fmtAgeMs(intelligence.cot.source.ageMs)}</span>}
                    <span className="text-yellow-900">⚠ FUTURES DATA, NOT SPOT</span>
                  </div>
                </div>

                {/* PUBLIC POSITIONING */}
                <div className="border border-[#0d1520] px-3 py-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[7px] font-mono text-gray-600 tracking-wider">PUBLIC POSITIONING</span>
                    <span className="text-[6px] font-mono" style={{ color: statusColor(intelligence.publicPositioning.status) }}>
                      {statusLabel(intelligence.publicPositioning.status)}
                    </span>
                  </div>
                  {intelligence.publicPositioning.longPct !== null ? (
                    <div className="flex items-center gap-4 text-[7.5px] font-mono">
                      <span className="text-green-400 font-bold">LONG {intelligence.publicPositioning.longPct}%</span>
                      <span className="text-red-400 font-bold">SHORT {intelligence.publicPositioning.shortPct}%</span>
                    </div>
                  ) : (
                    <span className="text-[7px] font-mono text-gray-800">NO DATA</span>
                  )}
                </div>

                {/* DATA FRESHNESS */}
                <div className="border border-[#0d1520] px-3 py-2">
                  <span className="text-[6.5px] font-mono text-gray-700 tracking-wider block mb-2">DATA SOURCES</span>
                  <div className="space-y-1">
                    {intelligence.sources.map((src, i) => (
                      <div key={i} className="flex items-center justify-between text-[6.5px] font-mono">
                        <span className="text-gray-700">{src.name}</span>
                        <div className="flex items-center gap-2">
                          {src.ageMs !== null && <span className="text-gray-800">{fmtAgeMs(src.ageMs)}</span>}
                          <span className="font-bold" style={{ color: statusColor(src.status) }}>
                            {statusLabel(src.status)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-[7px] font-mono text-gray-800 text-center py-2">
                {intelligenceLoading ? 'FETCHING INTELLIGENCE...' : 'NO INTELLIGENCE DATA'}
              </div>
            )}
          </div>

          {/* ── AVL AI ANALYSIS ── */}
          <div className="border border-purple-900/40 bg-purple-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Zap size={9} className="text-purple-400"/>
              <span className="text-[7px] font-mono text-purple-400/70 tracking-[0.2em]">AVL AI ANALYSIS</span>
            </div>
            <p className="text-[6.5px] font-mono text-gray-700 mb-2">MarketSnapshot → Decision Engine → Risk Engine → DRY RUN</p>
            <button onClick={() => onAnalyze(ind.symbol)}
              className="flex items-center gap-2 px-3 py-1.5 border border-purple-700/50 text-purple-300 bg-purple-950/20 hover:bg-purple-900/30 transition-all text-[8px] font-mono tracking-wider">
              <Zap size={9}/> ANALYZE {ind.symbol} WITH AVL AI
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main MarketsView ───────────────────────────────────────────────
export function MarketsView() {
  const { status }                             = useConnectionStore();
  const { indicators, setIndicators,
          setIndicatorsBatch }                 = useIndicatorStore();
  const { symbolList, setSymbols }             = useMarketStore();
  const { setActiveSymbol }                    = usePriceStore();
  const router                                 = useRouter();

  // ── WebSocket subscriptions + 初期 HTTP 取得 ────────────────────
  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;

    const unsubInd  = client.onIndicators((ind) => setIndicators(ind));
    const unsubSyms = client.onSymbols((syms) => setSymbols(syms));

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
    const m: Record<string, { bid: number; ask: number; changePct: number; spread: number }> = {};
    for (const s of symbolList) {
      m[s.symbol.toUpperCase()] = { bid: s.bid, ask: s.ask, changePct: s.changePct, spread: s.spread };
    }
    return m;
  }, [symbolList]);

  // ── Scanner + Stage cycle ──────────────────────────────────────
  // Stage cycles every STAGE_MS ms; when stage wraps, advance symbol.
  const [scanIdx,  setScanIdx]  = useState(0);
  const [stageIdx, setStageIdx] = useState(0);
  const stageRef  = useRef(0);
  const scanRef   = useRef(0);

  useEffect(() => {
    if (indList.length === 0) return;
    // sync refs on indList change
    scanRef.current  = 0;
    stageRef.current = 0;
    setScanIdx(0);
    setStageIdx(0);

    const id = setInterval(() => {
      stageRef.current = (stageRef.current + 1) % STAGES.length;
      setStageIdx(stageRef.current);
      if (stageRef.current === 0) {
        scanRef.current = (scanRef.current + 1) % indList.length;
        setScanIdx(scanRef.current);
      }
    }, STAGE_MS);

    return () => clearInterval(id);
  }, [indList.length]);

  // ── Global tick flash (for header) ────────────────────────────
  const [headerFlash, setHeaderFlash] = useState(false);
  const lastTsRef = useRef(0);

  useEffect(() => {
    const latest = indList.length > 0 ? Math.max(...indList.map(i => i.receivedAt)) : 0;
    if (latest > lastTsRef.current) {
      lastTsRef.current = latest;
      setHeaderFlash(true);
      const t = setTimeout(() => setHeaderFlash(false), 400);
      return () => clearTimeout(t);
    }
  });

  // ── Selected card (detail modal) ──────────────────────────────
  const [selectedSym, setSelectedSym] = useState<string | null>(null);

  // ── Market Intelligence — 全シンボル一括取得（5分ごとに更新） ──
  const [intelligenceMap, setIntelligenceMap] = useState<Record<string, MarketIntelligence>>({});
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const intelFetchingRef = useRef(false);

  const fetchAllIntelligence = useCallback(async (symbols: string[]) => {
    if (symbols.length === 0 || intelFetchingRef.current) return;
    intelFetchingRef.current = true;
    setIntelligenceLoading(true);
    try {
      const results = await Promise.allSettled(
        symbols.map(sym =>
          fetch(`/api/market/intelligence?symbol=${sym}`, { cache: 'no-store' })
            .then(r => r.json() as Promise<MarketIntelligence>)
            .then(data => ({ sym, data }))
        )
      );
      const newMap: Record<string, MarketIntelligence> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') newMap[r.value.sym] = r.value.data;
      }
      setIntelligenceMap(prev => ({ ...prev, ...newMap }));
    } catch (err) {
      console.error('[MarketsView] intelligence fetch error', err);
    } finally {
      intelFetchingRef.current = false;
      setIntelligenceLoading(false);
    }
  }, []);

  // シンボルリスト確定後に一括取得、5分ごとに更新
  useEffect(() => {
    const syms = indList.map(i => i.symbol);
    if (syms.length === 0) return;
    void fetchAllIntelligence(syms);
    const id = setInterval(() => void fetchAllIntelligence(syms), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [indList.length, fetchAllIntelligence]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnalyze = useCallback((sym: string) => {
    setActiveSymbol(sym as never);
    router.push("/");
  }, [setActiveSymbol, router]);

  // ── Stats ──────────────────────────────────────────────────────
  const isConnected = status === "connected";
  const now    = Date.now();
  const liveN  = indList.filter(i => now - i.receivedAt < 6000).length;
  const lastTs = indList.length > 0 ? Math.max(...indList.map(i => i.receivedAt)) : 0;
  const scanSym = indList[scanIdx]?.symbol;
  const cols    = indList.length;
  const symbols = indList.map(i => i.symbol);

  return (
    <div className="flex flex-col h-full overflow-hidden min-w-0 relative"
      style={{ background: "radial-gradient(ellipse at 50% 0%, #010c1e 0%, #020408 60%, #010305 100%)" }}>

      {/* Background grid */}
      <div className="absolute inset-0 avl-grid-bg opacity-[0.05] pointer-events-none"/>

      {/* ── HEADER ── */}
      <CommandCenterHeader
        isConnected={isConnected}
        totalSymbols={indList.length}
        liveCount={liveN}
        lastUpdateTs={lastTs}
        tickFlash={headerFlash}
      />

      {/* ── AI COMMAND BAR (scanner, top) ── */}
      <AICommandBar
        symbols={symbols}
        scanIdx={scanIdx}
        stageIdx={stageIdx}
        isConnected={isConnected}
      />

      {/* ── CARDS GRID — 固定幅横並び・縦スクロール ── */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3">
        {indList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Cpu size={28} className="text-gray-800"/>
            <p className="text-[11px] text-gray-600 font-mono">
              {isConnected ? "MT5 インジケーターデータ待機中..." : "MT5 に接続してください"}
            </p>
            <p className="text-[8px] text-gray-800 font-mono">AVL_FX_Bridge.mq5 をチャートにアタッチしてください</p>
          </div>
        ) : (
          // 固定幅カード: 最小260px、自動折り返し、縦スクロール
          <div className="grid gap-3"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              alignItems: "start",
            }}
          >
            {indList.map((ind) => {
              const p = priceMap[ind.symbol] ?? { bid: 0, ask: 0, changePct: 0, spread: 0 };
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
                  intelligence={intelligenceMap[ind.symbol] ?? null}
                  intelligenceLoading={intelligenceLoading && !intelligenceMap[ind.symbol]}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── AI REASONING FLOW (bottom) ── */}
      <AIReasoningFlow
        symbols={symbols}
        scanIdx={scanIdx}
        stageIdx={stageIdx}
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
          intelligence={intelligenceMap[selectedSym] ?? null}
          intelligenceLoading={intelligenceLoading && !intelligenceMap[selectedSym]}
        />
      )}
    </div>
  );
}

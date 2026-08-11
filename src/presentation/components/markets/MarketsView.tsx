"use client";

// =================================================================
// AVL AI Market Command Center — MarketsView v2.0
//
// データフロー (変更なし):
//   MT5 → Railway Gateway → WebSocket → client.onIndicators()
//   → indicatorStore → このコンポーネント
//
// 新規 UI:
//   - Market Pulse ヘッダー
//   - AI Scanner (銘柄巡回アニメーション)
//   - Market Card グリッド (リアルタイム更新フラッシュ)
//   - カードクリックで詳細パネル展開
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
import {
  TrendingUp, TrendingDown, Minus, Radio, Activity,
  Eye, X, ChevronRight, Zap,
} from "lucide-react";
import type { IndicatorData } from "@/application/stores/indicatorStore";

// ── Constants ─────────────────────────────────────────────────
const TFS = ["H4", "H1", "M15", "M5"] as const;
const SCAN_INTERVAL_MS = 3000;

// ── Helper functions ───────────────────────────────────────────
function getDir(ema21: number, ema200: number): "BULL" | "BEAR" | "FLAT" {
  if (ema21 > ema200 * 1.00008) return "BULL";
  if (ema21 < ema200 * 0.99992) return "BEAR";
  return "FLAT";
}

function getOverallBias(ind: IndicatorData): "BULL" | "BEAR" | "WAIT" {
  const h4 = ind.timeframes?.H4;
  const h1 = ind.timeframes?.H1;
  if (!h4 && !h1) return "WAIT";
  const d4 = h4 ? getDir(h4.ema21, h4.ema200) : "FLAT";
  const d1 = h1 ? getDir(h1.ema21, h1.ema200) : "FLAT";
  if (d4 === "BULL" && d1 === "BULL") return "BULL";
  if (d4 === "BEAR" && d1 === "BEAR") return "BEAR";
  if (d4 === "BULL" || d1 === "BULL") return "WAIT";
  if (d4 === "BEAR" || d1 === "BEAR") return "WAIT";
  return "WAIT";
}

function getDataQuality(ind: IndicatorData): { score: number; label: string } {
  const tfCount = Object.keys(ind.timeframes ?? {}).filter(
    k => ind.timeframes?.[k]?.ema21 > 0
  ).length;
  const ageMs = Date.now() - (ind.receivedAt ?? 0);
  const fresh = ageMs < 60_000;

  if (tfCount >= 4 && fresh) return { score: 90, label: "COMPLETE" };
  if (tfCount >= 3 && fresh) return { score: 75, label: "GOOD" };
  if (tfCount >= 2)          return { score: 55, label: "PARTIAL" };
  if (tfCount >= 1)          return { score: 30, label: "PRICE ONLY" };
  return { score: 0, label: "NO DATA" };
}

function getBarPct(ema21: number, ema200: number, atr: number): number {
  const gap = Math.abs(ema21 - ema200);
  return Math.min(100, Math.max(10, (gap / Math.max(atr, 0.0001)) * 25 + 15));
}

function formatAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

function fmtPrice(v: number, digits: number): string {
  return v.toFixed(digits >= 3 ? 5 : 3);
}

// ── TF Direction Bar ───────────────────────────────────────────
const TFBar = memo(function TFBar({
  tf, ema21, ema200, atr, digits, isScanning,
}: {
  tf: string; ema21: number; ema200: number; atr: number;
  digits: number; isScanning: boolean;
}) {
  const dir  = getDir(ema21, ema200);
  const pct  = getBarPct(ema21, ema200, atr);
  const bull = dir === "BULL";
  const bear = dir === "BEAR";
  const col  = bull ? "#00ff88" : bear ? "#ff1a4e" : "#374151";

  return (
    <div className="flex items-center gap-2 py-0.5">
      {/* TF label */}
      <span className="text-[7px] font-mono text-gray-600 w-5 shrink-0">{tf}</span>

      {/* Direction bar */}
      <div className="relative flex-1 h-1.5 bg-[#0d1520] rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
          style={{
            width: `${pct}%`,
            background: bull
              ? "linear-gradient(90deg, #00ff8818, #00ff88)"
              : bear
              ? "linear-gradient(90deg, #ff1a4e18, #ff1a4e)"
              : "#374151",
            boxShadow: (bull || bear) && isScanning ? `0 0 8px ${col}` : "none",
            // Flow animation for active direction
            backgroundSize: isScanning ? "200% 100%" : "100% 100%",
            animation: isScanning
              ? bull ? "avl-flow-right 1.5s linear infinite" : "avl-flow-left 1.5s linear infinite"
              : "none",
          }}
        />
        {/* Scan sweep overlay */}
        {isScanning && (
          <div className="absolute inset-y-0 w-8 pointer-events-none"
            style={{
              background: "linear-gradient(90deg, transparent, rgba(0,229,255,0.2), transparent)",
              animation: "avl-scan-h 1.8s ease-in-out infinite",
            }}
          />
        )}
      </div>

      {/* Direction icon + label */}
      <div className="flex items-center gap-0.5 w-[38px] shrink-0">
        {bull && <TrendingUp  size={7} style={{color:"#00ff88"}}/>}
        {bear && <TrendingDown size={7} style={{color:"#ff1a4e"}}/>}
        {dir === "FLAT" && <Minus size={7} className="text-gray-700"/>}
        <span className="text-[6.5px] font-mono font-semibold" style={{color:col}}>
          {dir}
        </span>
      </div>

      {/* ATR value */}
      <span className="text-[6px] font-mono text-gray-700 w-[46px] shrink-0 tabular-nums text-right">
        {atr.toFixed(digits >= 3 ? 4 : 2)}
      </span>
    </div>
  );
});

// ── Symbol Card ────────────────────────────────────────────────
const SymbolCard = memo(function SymbolCard({
  ind,
  bid,
  ask,
  changePct,
  isScanning,
  isSelected,
  onClick,
}: {
  ind:        IndicatorData;
  bid:        number;
  ask:        number;
  changePct:  number;
  isScanning: boolean;
  isSelected: boolean;
  onClick:    () => void;
}) {
  // ── Flash on new data ──────────────────────────────────────
  const [flashing, setFlashing] = useState(false);
  const prevTs = useRef(ind.receivedAt);

  useEffect(() => {
    if (ind.receivedAt <= prevTs.current) return;
    prevTs.current = ind.receivedAt;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 450);
    return () => clearTimeout(t);
  }, [ind.receivedAt]);

  const bias  = getOverallBias(ind);
  const dq    = getDataQuality(ind);
  const ageMs = Date.now() - ind.receivedAt;
  const isLive = ageMs < 8_000;
  const priceDisplay = bid > 0 ? fmtPrice(bid, ind.digits) : null;

  const biasColor = bias === "BULL" ? "#00ff88" : bias === "BEAR" ? "#ff1a4e" : "#00e5ff";
  const borderCol = isScanning
    ? "#00e5ff"
    : isSelected
    ? "#a855f7"
    : bias === "BULL" ? "#00ff8828" : bias === "BEAR" ? "#ff1a4e28" : "#0d1520";

  return (
    <div
      onClick={onClick}
      className="relative border cursor-pointer transition-all duration-300 overflow-hidden select-none"
      style={{
        borderColor: borderCol,
        background:
          isSelected  ? "rgba(168,85,247,0.06)"  :
          bias === "BULL" ? "rgba(0,255,136,0.025)" :
          bias === "BEAR" ? "rgba(255,26,78,0.025)" :
          "rgba(4,6,13,0.95)",
        boxShadow: isScanning
          ? "0 0 24px rgba(0,229,255,0.18), inset 0 0 12px rgba(0,229,255,0.04)"
          : isSelected
          ? "0 0 16px rgba(168,85,247,0.15)"
          : "none",
      }}
    >
      {/* Bias stripe at top */}
      <div className="absolute top-0 left-0 right-0 h-px pointer-events-none"
        style={{background:`linear-gradient(90deg,transparent,${biasColor}60,transparent)`}}/>

      {/* New-data flash overlay */}
      <div className="absolute inset-0 pointer-events-none z-10 transition-opacity duration-[450ms]"
        style={{
          background: "rgba(0,229,255,0.09)",
          opacity: flashing ? 1 : 0,
        }}
      />

      {/* Scanner scan-line */}
      {isScanning && (
        <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
          <div className="absolute inset-x-0 h-8"
            style={{
              background: "linear-gradient(180deg,transparent,rgba(0,229,255,0.05),transparent)",
              animation: "avl-scan-v 2s linear infinite",
            }}/>
          <div className="absolute top-0 left-0 right-0 h-px bg-cyan-400/50"/>
          <div className="absolute bottom-0 left-0 right-0 h-px bg-cyan-400/20"/>
        </div>
      )}

      <div className="p-3 relative z-[5]">

        {/* ── Row 1: Symbol name + Bias + Status ── */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            {/* Live indicator */}
            <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
              isLive ? "bg-green-400" : ageMs < 60000 ? "bg-yellow-500" : "bg-gray-700"
            )} style={isLive ? {animation:"avl-blink 1.2s ease-in-out infinite"} : undefined}/>

            <span className="text-[13px] font-black font-mono text-gray-100">
              {ind.symbol}
            </span>

            {bias !== "WAIT" && (
              <span className="text-[7px] font-mono font-bold px-1.5 py-0.5 border"
                style={{
                  color: biasColor,
                  borderColor: `${biasColor}50`,
                  background: `${biasColor}10`,
                  textShadow: `0 0 6px ${biasColor}50`,
                }}>
                {bias === "BULL" ? "▲ BULL" : "▼ BEAR"}
              </span>
            )}
          </div>

          <div className="flex flex-col items-end gap-0.5 text-right">
            <span className={cn("text-[6.5px] font-mono tabular-nums",
              isLive ? "text-green-400/80" : "text-gray-700"
            )}>
              {isLive ? "● LIVE" : formatAge(ind.receivedAt) + " ago"}
            </span>
            {changePct !== 0 && (
              <span className={cn("text-[6.5px] font-mono tabular-nums",
                changePct >= 0 ? "text-green-400/70" : "text-red-400/70"
              )}>
                {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        {/* ── Row 2: Price + Spread ── */}
        <div className="flex items-baseline justify-between mb-3">
          {priceDisplay ? (
            <span className="text-[17px] font-mono tabular-nums text-gray-100 font-semibold leading-none"
              style={{transition:"color 0.3s", color: flashing ? "#00e5ff" : undefined}}>
              {priceDisplay}
            </span>
          ) : (
            <span className="text-[12px] font-mono text-gray-800 leading-none">─ ─ ─ ─ ─</span>
          )}
          <div className="text-right">
            <span className={cn("text-[7px] font-mono tabular-nums block",
              ind.spread > 5 ? "text-red-400" : ind.spread > 2.5 ? "text-yellow-400" : "text-gray-500"
            )}>
              SPR {ind.spread.toFixed(1)}p
            </span>
            {ind.sessions && ind.sessions.length > 0 && (
              <span className="text-[6px] font-mono text-gray-700 block mt-0.5">
                {ind.sessions[0].replace(" Session","")}
              </span>
            )}
          </div>
        </div>

        {/* ── Row 3: TF Direction bars ── */}
        <div className="space-y-0 mb-2.5 border-t border-b border-[#0d1520] py-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[5.5px] font-mono text-gray-700 tracking-[0.2em]">TIMEFRAME</span>
            <span className="text-[5.5px] font-mono text-gray-700 tracking-[0.2em]">ATR</span>
          </div>
          {TFS.map(tf => {
            const d = ind.timeframes?.[tf];
            if (!d || d.ema21 === 0) return (
              <div key={tf} className="flex items-center gap-2 py-0.5">
                <span className="text-[7px] font-mono text-gray-700 w-5">{tf}</span>
                <div className="flex-1 h-1.5 bg-[#0d1520] rounded-full"/>
                <span className="text-[6px] font-mono text-gray-800 w-[84px] text-right">NO DATA</span>
              </div>
            );
            return (
              <TFBar key={tf}
                tf={tf} ema21={d.ema21} ema200={d.ema200}
                atr={d.atr} digits={ind.digits}
                isScanning={isScanning}
              />
            );
          })}
        </div>

        {/* ── Row 4: DQ + Scanner status ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className={cn("text-[6px] font-mono px-1.5 py-0.5 border tabular-nums",
              dq.score >= 75
                ? "border-green-700/40 text-green-400 bg-green-950/20"
                : dq.score >= 40
                ? "border-yellow-700/40 text-yellow-400 bg-yellow-950/20"
                : "border-gray-700/40 text-gray-600"
            )}>
              DQ {dq.score}
            </div>
            <span className="text-[6px] font-mono text-gray-700">{dq.label}</span>
          </div>
          <div className="flex items-center gap-1">
            {isScanning && (
              <span className="text-[6px] font-mono text-cyan-400/60"
                style={{animation:"avl-blink 0.8s ease-in-out infinite"}}>
                SCANNING
              </span>
            )}
            <span className="text-[6px] font-mono text-gray-800">
              {isSelected ? "▾" : "▸"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

// ── Expanded Detail Panel ──────────────────────────────────────
function ExpandedPanel({
  ind,
  bid,
  ask,
  changePct,
  onClose,
  onAnalyze,
}: {
  ind:       IndicatorData;
  bid:       number;
  ask:       number;
  changePct: number;
  onClose:   () => void;
  onAnalyze: (sym: string) => void;
}) {
  const bias  = getOverallBias(ind);
  const dq    = getDataQuality(ind);
  const biasColor = bias === "BULL" ? "#00ff88" : bias === "BEAR" ? "#ff1a4e" : "#00e5ff";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="relative w-full max-w-2xl border border-cyan-900/40 bg-[#03050d] overflow-hidden"
        style={{boxShadow:"0 0 60px rgba(0,229,255,0.12), inset 0 0 30px rgba(0,229,255,0.02)"}}>

        {/* Top accent */}
        <div className="absolute top-0 left-0 right-0 h-px"
          style={{background:`linear-gradient(90deg,transparent,${biasColor}60,transparent)`}}/>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cyan-900/20">
          <div className="flex items-center gap-3">
            <div className="flex gap-0.5">
              <div className="w-0.5 h-5 bg-cyan-400" style={{boxShadow:"0 0 6px #00e5ff"}}/>
              <div className="w-0.5 h-5 bg-cyan-400/25"/>
            </div>
            <span className="text-[15px] font-black font-mono text-gray-100">{ind.symbol}</span>
            {bias !== "WAIT" && (
              <span className="text-[8px] font-mono font-bold px-2 py-0.5 border"
                style={{color:biasColor, borderColor:`${biasColor}50`, background:`${biasColor}10`}}>
                {bias === "BULL" ? "▲ BULL" : "▼ BEAR"}
              </span>
            )}
            <div className={cn("text-[7px] font-mono px-1.5 py-0.5 border",
              dq.score >= 75 ? "border-green-700/40 text-green-400" :
              dq.score >= 40 ? "border-yellow-700/40 text-yellow-400" :
              "border-gray-700/40 text-gray-600"
            )}>
              DQ {dq.score} · {dq.label}
            </div>
          </div>
          <button onClick={onClose}
            className="text-gray-600 hover:text-gray-300 transition-colors p-1">
            <X size={16}/>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto max-h-[70vh] avl-scroll">

          {/* Price row */}
          {bid > 0 && (
            <div className="flex items-center gap-6">
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">BID</p>
                <p className="text-[20px] font-mono tabular-nums text-gray-100 font-semibold">
                  {fmtPrice(bid, ind.digits)}
                </p>
              </div>
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">ASK</p>
                <p className="text-[20px] font-mono tabular-nums text-gray-300 font-semibold">
                  {fmtPrice(ask, ind.digits)}
                </p>
              </div>
              <div>
                <p className="text-[7px] font-mono text-gray-700 mb-0.5">SPREAD</p>
                <p className={cn("text-[14px] font-mono tabular-nums font-semibold",
                  ind.spread > 5 ? "text-red-400" : "text-yellow-400")}>
                  {ind.spread.toFixed(1)}p
                </p>
              </div>
              {changePct !== 0 && (
                <div>
                  <p className="text-[7px] font-mono text-gray-700 mb-0.5">CHG</p>
                  <p className={cn("text-[14px] font-mono tabular-nums font-semibold",
                    changePct >= 0 ? "text-green-400" : "text-red-400")}>
                    {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Multi-TF detail */}
          <div>
            <p className="text-[7.5px] font-mono text-cyan-400/60 tracking-[0.2em] mb-2">MULTI-TIMEFRAME ANALYSIS</p>
            <div className="space-y-1">
              {TFS.map(tf => {
                const d = ind.timeframes?.[tf];
                if (!d || d.ema21 === 0) return (
                  <div key={tf} className="flex items-center gap-3 px-2 py-1.5 border border-[#0d1520]">
                    <span className="text-[8px] font-mono text-gray-700 w-8">[{tf}]</span>
                    <span className="text-[7px] font-mono text-gray-800">NO DATA</span>
                  </div>
                );
                const dir  = getDir(d.ema21, d.ema200);
                const pct  = getBarPct(d.ema21, d.ema200, d.atr);
                const bull = dir === "BULL";
                const bear = dir === "BEAR";
                const col  = bull ? "#00ff88" : bear ? "#ff1a4e" : "#374151";
                return (
                  <div key={tf} className="border px-3 py-2.5"
                    style={{
                      borderColor: bull ? "#00ff8820" : bear ? "#ff1a4e20" : "#0d1520",
                      background: bull ? "rgba(0,255,136,0.025)" : bear ? "rgba(255,26,78,0.025)" : "transparent",
                    }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] font-mono text-cyan-500/60 font-bold">[{tf}]</span>
                        {bull && <TrendingUp  size={10} style={{color:"#00ff88"}}/>}
                        {bear && <TrendingDown size={10} style={{color:"#ff1a4e"}}/>}
                        {dir === "FLAT" && <Minus size={10} className="text-gray-700"/>}
                        <span className="text-[8px] font-mono font-bold" style={{color:col}}>{dir}</span>
                      </div>
                      <span className="text-[7px] font-mono text-orange-400">ATR {d.atr.toFixed(ind.digits >= 3 ? 5 : 3)}</span>
                    </div>
                    {/* Bar */}
                    <div className="h-1 bg-[#0d1520] rounded-full overflow-hidden mb-1.5">
                      <div className="h-full rounded-full transition-all duration-700"
                        style={{width:`${pct}%`, background:`linear-gradient(90deg,${col}20,${col})`}}/>
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

          {/* Session + time */}
          {(ind.sessions?.length || ind.brokerTime) && (
            <div className="flex gap-4 text-[7px] font-mono">
              {ind.sessions && ind.sessions.length > 0 && (
                <div>
                  <span className="text-gray-700">SESSION </span>
                  <span className="text-cyan-400/70">{ind.sessions.join(" · ")}</span>
                </div>
              )}
              {ind.brokerTime > 0 && (
                <div>
                  <span className="text-gray-700">BROKER TIME </span>
                  <span className="text-gray-400">
                    {new Date(ind.brokerTime * 1000).toLocaleTimeString("ja-JP")}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* AI BRAIN link */}
          <div className="border border-purple-900/40 bg-purple-950/10 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Zap size={10} className="text-purple-400"/>
              <span className="text-[7.5px] font-mono text-purple-400/70 tracking-[0.2em]">AI BRAIN ANALYSIS</span>
            </div>
            <p className="text-[7px] font-mono text-gray-700 mb-2 leading-relaxed">
              MarketSnapshot → AI Decision Engine → Risk Engine → DRY RUN
            </p>
            <button
              onClick={() => onAnalyze(ind.symbol)}
              className="flex items-center gap-2 px-3 py-1.5 border border-purple-700/50 text-purple-300 bg-purple-950/20 hover:bg-purple-900/30 transition-all text-[8px] font-mono tracking-wider">
              <ChevronRight size={10}/>
              ANALYZE {ind.symbol} WITH AI BRAIN
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Scanner Progress Bar ───────────────────────────────────────
function ScannerBar({
  symbols, currentIdx, totalSymbols,
}: {
  symbols: string[]; currentIdx: number; totalSymbols: number;
}) {
  if (symbols.length === 0) return null;
  const pct = ((currentIdx + 1) / Math.max(symbols.length, 1)) * 100;

  return (
    <div className="flex items-center gap-3 mb-3 shrink-0">
      <div className="flex items-center gap-1.5 shrink-0">
        <Eye size={9} className="text-cyan-400/60"/>
        <span className="text-[7px] font-mono text-cyan-400/60 tracking-[0.2em]">AI SCAN</span>
      </div>
      <div className="flex-1 relative h-1 bg-[#0d1520] rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, #00e5ff30, #00e5ff)",
          }}/>
        <div className="absolute inset-y-0 w-4"
          style={{
            left: `${Math.max(0, pct - 5)}%`,
            background: "rgba(0,229,255,0.6)",
            filter: "blur(2px)",
          }}/>
      </div>
      <span className="text-[7px] font-mono text-cyan-400/80 shrink-0 tabular-nums font-bold w-20">
        {symbols[currentIdx] ?? "—"}
      </span>
      <span className="text-[6.5px] font-mono text-gray-700 shrink-0">
        {currentIdx + 1}/{totalSymbols}
      </span>
    </div>
  );
}

// ── Market Pulse Header ────────────────────────────────────────
function MarketPulse({
  isConnected, totalSymbols, liveSymbols, lastUpdateTs,
}: {
  isConnected: boolean;
  totalSymbols: number;
  liveSymbols:  number;
  lastUpdateTs: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ageMs = lastUpdateTs > 0 ? now - lastUpdateTs : null;

  return (
    <div className="shrink-0 mb-3 border border-cyan-900/20 bg-[#02040a] relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent"/>
      {isConnected && (
        <div className="absolute bottom-0 left-0 right-0 h-px"
          style={{background:"linear-gradient(90deg,transparent,rgba(0,229,255,0.15),transparent)",
            animation:"avl-scan-h 4s linear infinite"}}/>
      )}

      <div className="px-4 py-3 flex items-center gap-6">
        {/* Brand */}
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <Radio size={9} className={isConnected ? "text-cyan-400/80" : "text-gray-700"}
              style={isConnected ? {animation:"avl-blink 1.5s ease-in-out infinite"} : undefined}/>
            <span className="text-[9px] font-mono tracking-[0.25em] text-cyan-400/80 font-semibold">
              MARKET COMMAND CENTER
            </span>
          </div>
          <p className="text-[6.5px] font-mono text-gray-700 tracking-[0.15em] ml-4">
            AVL AI · MARKET SCAN · EMA / ATR × H4 H1 M15 M5
          </p>
        </div>

        <div className="w-px h-8 bg-cyan-900/30"/>

        {/* Stats */}
        <div className="flex items-center gap-5">
          <div className="text-center">
            <p className="text-[18px] font-black font-mono tabular-nums text-cyan-400 leading-none"
              style={{textShadow:"0 0 12px #00e5ff50"}}>
              {totalSymbols}
            </p>
            <p className="text-[6px] font-mono text-gray-700 mt-0.5 tracking-wider">SYMBOLS</p>
          </div>
          <div className="text-center">
            <p className={cn("text-[18px] font-black font-mono tabular-nums leading-none",
              liveSymbols > 0 ? "text-green-400" : "text-gray-700")}
              style={liveSymbols > 0 ? {textShadow:"0 0 10px #00ff8850"} : undefined}>
              {liveSymbols}
            </p>
            <p className="text-[6px] font-mono text-gray-700 mt-0.5 tracking-wider">LIVE</p>
          </div>
        </div>

        <div className="flex-1"/>

        {/* Status + Last update */}
        <div className="flex flex-col items-end gap-0.5">
          <div className="flex items-center gap-1.5">
            <div className={cn("w-1.5 h-1.5 rounded-full",
              isConnected ? "bg-green-400" : "bg-gray-700")}
              style={isConnected ? {animation:"avl-blink 1.2s ease-in-out infinite"} : undefined}/>
            <span className={cn("text-[8px] font-mono font-semibold",
              isConnected ? "text-green-400" : "text-gray-600")}>
              {isConnected ? "LIVE" : "OFFLINE"}
            </span>
          </div>
          {ageMs !== null && (
            <span className={cn("text-[6.5px] font-mono tabular-nums",
              ageMs < 5000 ? "text-green-400/70" : ageMs < 30000 ? "text-yellow-400/70" : "text-gray-700")}>
              {ageMs < 1000 ? `${ageMs}ms` : `${Math.floor(ageMs/1000)}s`} ago
            </span>
          )}
          {!isConnected && (
            <span className="text-[6px] font-mono text-gray-700">MT5 未接続</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main MarketsView ───────────────────────────────────────────
export function MarketsView() {
  const { status }       = useConnectionStore();
  const { indicators, setIndicators } = useIndicatorStore();
  const { symbolList }   = useMarketStore();
  const { setActiveSymbol } = usePriceStore();
  const router = useRouter();

  // データフロー: 変更なし
  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;
    const unsub = client.onIndicators((ind) => setIndicators(ind));
    return () => unsub();
  }, [status, setIndicators]);

  // Symbol list derived from indicatorStore
  const indList = useMemo(() =>
    Object.values(indicators).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [indicators]
  );

  // Scanner state
  const [scanIdx, setScanIdx] = useState(0);
  useEffect(() => {
    if (indList.length === 0) return;
    const id = setInterval(() => {
      setScanIdx(i => (i + 1) % indList.length);
    }, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [indList.length]);
  const scanningSymbol = indList[scanIdx]?.symbol;

  // Selected card
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const selectedInd = selectedSymbol ? indicators[selectedSymbol] : null;

  const handleCardClick = useCallback((sym: string) => {
    setSelectedSymbol(prev => prev === sym ? null : sym);
  }, []);

  const handleAnalyze = useCallback((sym: string) => {
    setActiveSymbol(sym as never);
    router.push("/");
  }, [setActiveSymbol, router]);

  // Price lookup from marketStore.symbolList
  const priceMap = useMemo(() => {
    const m: Record<string, {bid:number;ask:number;changePct:number}> = {};
    for (const s of symbolList) {
      m[s.symbol.toUpperCase()] = { bid: s.bid, ask: s.ask, changePct: s.changePct };
    }
    return m;
  }, [symbolList]);

  // Stats for Market Pulse
  const now     = Date.now();
  const liveN   = indList.filter(i => now - i.receivedAt < 8000).length;
  const lastTs  = indList.length > 0 ? Math.max(...indList.map(i => i.receivedAt)) : 0;

  const isConnected = status === "connected";

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-3 bg-[#030508] min-w-0"
      style={{background:"radial-gradient(ellipse at 50% 0%, #020c1a 0%, #030508 60%, #020408 100%)"}}>

      {/* Market Pulse header */}
      <MarketPulse
        isConnected={isConnected}
        totalSymbols={indList.length}
        liveSymbols={liveN}
        lastUpdateTs={lastTs}
      />

      {/* AI Scanner progress */}
      {indList.length > 0 && (
        <ScannerBar
          symbols={indList.map(i => i.symbol)}
          currentIdx={scanIdx}
          totalSymbols={indList.length}
        />
      )}

      {/* Symbol Grid */}
      <div className="flex-1 overflow-y-auto avl-scroll min-h-0">
        {indList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Activity size={24} className="text-gray-800"/>
            <p className="text-[10px] text-gray-600 font-mono">
              {isConnected
                ? "MT5 インジケーターデータ待機中..."
                : "MT5 に接続してください"}
            </p>
            <p className="text-[8px] text-gray-800 font-mono">
              AVL_FX_Bridge.mq5 をチャートにアタッチしてください
            </p>
          </div>
        ) : (
          <div className="grid gap-2.5"
            style={{
              gridTemplateColumns:
                "repeat(auto-fill, minmax(min(100%, 280px), 1fr))",
            }}>
            {indList.map(ind => {
              const p = priceMap[ind.symbol] ?? {bid:0, ask:0, changePct:0};
              return (
                <SymbolCard
                  key={ind.symbol}
                  ind={ind}
                  bid={p.bid}
                  ask={p.ask}
                  changePct={p.changePct}
                  isScanning={ind.symbol === scanningSymbol}
                  isSelected={ind.symbol === selectedSymbol}
                  onClick={() => handleCardClick(ind.symbol)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Expanded detail panel */}
      {selectedInd && (
        <ExpandedPanel
          ind={selectedInd}
          bid={priceMap[selectedInd.symbol]?.bid ?? 0}
          ask={priceMap[selectedInd.symbol]?.ask ?? 0}
          changePct={priceMap[selectedInd.symbol]?.changePct ?? 0}
          onClose={() => setSelectedSymbol(null)}
          onAnalyze={handleAnalyze}
        />
      )}
    </div>
  );
}

"use client";

// =================================================================
// AVL AI Trading Operating System — Dashboard OS v4.0
// JARVIS / Cyberpunk Style — Full Redesign
// =================================================================

import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { cn } from "@/lib/utils";
import { useConnectionStore }  from "@/application/stores/connectionStore";
import { usePriceStore }       from "@/application/stores/priceStore";
import { useIndicatorStore }   from "@/application/stores/indicatorStore";
import { useMarketStore }      from "@/application/stores/marketStore";
import type { MarketSymbol }   from "@/infrastructure/connection/GatewayClient";
import type { IndicatorData }  from "@/application/stores/indicatorStore";
import { useAIOSStore, type AIMode, type AgentState } from "@/application/stores/aiOSStore";
import { ConnectionManager }   from "@/infrastructure/connection/ConnectionManager";
import { useRealtimeAgent }    from "@/presentation/hooks/useRealtimeAgent";
import { useMonitor }          from "@/presentation/hooks/useMonitor";
import { useAgentPipeline }    from "@/presentation/hooks/useAgentPipeline";
import { useSettingsStore }    from "@/application/stores/settingsStore";
import { HolographicAICore }   from "@/presentation/components/os/HolographicAICore";
import { ParticleTorus }       from "@/presentation/components/os/ParticleTorus";
import { AnalysisEngine }      from "@/presentation/components/os/AnalysisEngine";
import type { MarketPosition, MarketAccount } from "@/infrastructure/connection/GatewayClient";
import {
  Wifi, WifiOff, Radio, Mic, MicOff, Send, Volume2, VolumeX,
  TrendingUp, TrendingDown, Minus, AlertCircle, RefreshCw,
  Eye, Brain, Zap, Bot, Shield, Activity, ChevronRight, Bell,
  Briefcase, ScrollText, Globe, BarChart2, Settings,
} from "lucide-react";

// -----------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------
interface Message { id: string; role: "user" | "assistant" | "system"; content: string; ts: number; }
interface OrderProposal { direction: "BUY"|"SELL"; symbol: string; entry: number; sl: number; tp: number; rr: string; confidence: number; reason: string; }
interface ExtQuote { symbol: string; name: string; price: number; change: number; changePct: number; isOpen: boolean; }

// =================================================================
// CURRENT INSTRUMENT PANEL
// =================================================================
function CurrentInstrumentPanel({ activeSymbol, symbolList, indicators, onSelect }: {
  activeSymbol: string;
  symbolList:   MarketSymbol[];
  indicators:   Record<string, IndicatorData>;
  onSelect:     (sym: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open,   setOpen]   = useState(false);

  const activeSym = symbolList.find(s => s.symbol.toUpperCase() === activeSymbol.toUpperCase());
  const pos = activeSym ? activeSym.changePct >= 0 : null;

  const filtered = symbolList.filter(s =>
    s.symbol.toUpperCase().includes(search.toUpperCase())
  );

  const h4 = indicators[activeSymbol.toUpperCase()]?.timeframes?.H4;
  const trend = h4 ? (h4.ema21 > h4.ema200 ? "UP" : "DOWN") : null;

  return (
    <div className="avl-glass relative overflow-hidden">
      {/* top accent — cyan glow */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent"/>

      <div className="px-3 pt-3 pb-2">
        <p className="text-[7.5px] text-cyan-400/60 font-mono tracking-[0.25em] mb-2 flex items-center gap-1.5">
          <Zap size={7} className="text-cyan-400/60"/> CURRENT INSTRUMENT
        </p>

        {/* 選択中シンボル表示 */}
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full group relative"
        >
          <div className={cn(
            "relative border px-3 py-2.5 transition-all duration-300",
            "border-cyan-500/40 bg-cyan-950/20",
            "hover:border-cyan-400/60 hover:bg-cyan-900/25",
          )}
          style={{ boxShadow: "0 0 12px rgba(0,229,255,0.08), inset 0 0 8px rgba(0,229,255,0.03)" }}>
            {/* pulse corner */}
            <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-cyan-400/70"/>
            <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-cyan-400/70"/>
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-cyan-400/40"/>
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-cyan-400/40"/>

            {/* symbol name */}
            <p className="text-[18px] font-black font-mono tracking-[0.15em] text-center"
              style={{ color:"#00e5ff", textShadow:"0 0 14px #00e5ff, 0 0 30px rgba(0,229,255,0.4)" }}>
              {activeSymbol}
            </p>

            {/* price row */}
            {activeSym && activeSym.bid > 0 ? (
              <div className="flex items-center justify-between mt-1.5">
                <div className="text-center">
                  <p className="text-[6.5px] text-gray-700 font-mono">BID</p>
                  <p className="text-[10px] text-gray-100 font-mono tabular-nums font-semibold">
                    {activeSym.bid.toFixed(activeSym.digits > 3 ? 5 : 3)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[6.5px] text-gray-700 font-mono">ASK</p>
                  <p className="text-[10px] text-gray-100 font-mono tabular-nums font-semibold">
                    {activeSym.ask.toFixed(activeSym.digits > 3 ? 5 : 3)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[6.5px] text-gray-700 font-mono">SPR</p>
                  <p className={cn("text-[10px] font-mono tabular-nums font-semibold",
                    activeSym.spread > 5 ? "text-red-400" : "text-cyan-400/80"
                  )}>{activeSym.spread.toFixed(1)}p</p>
                </div>
                <div className="text-center">
                  <p className="text-[6.5px] text-gray-700 font-mono">CHG</p>
                  <p className={cn("text-[10px] font-mono tabular-nums font-semibold",
                    pos ? "text-green-400" : "text-red-400"
                  )}>
                    {pos ? "+" : ""}{activeSym.changePct.toFixed(2)}%
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-[8px] text-gray-700 font-mono text-center mt-1">AWAITING DATA</p>
            )}

            {/* trend badge */}
            {trend && (
              <div className="flex justify-center mt-1.5">
                <span className={cn("text-[7px] font-mono border px-2 py-0.5 tracking-widest",
                  trend === "UP"
                    ? "border-green-700/40 text-green-400 bg-green-950/20"
                    : "border-red-700/40 text-red-400 bg-red-950/20"
                )}>
                  {trend === "UP" ? "▲ BULLISH" : "▼ BEARISH"} H4
                </span>
              </div>
            )}
          </div>
        </button>

        {/* 展開時: シンボルリスト */}
        {open && (
          <div className="mt-1 border border-cyan-900/30 bg-[#03060f]/95 backdrop-blur">
            {/* 検索 */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-cyan-900/20">
              <Globe size={8} className="text-cyan-600/60 shrink-0"/>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search symbol..."
                className="flex-1 bg-transparent text-[8.5px] font-mono text-cyan-300 placeholder-gray-700 outline-none"
                autoFocus
              />
              {search && (
                <button onClick={() => setSearch("")} className="text-gray-700 hover:text-gray-400 text-[8px]">✕</button>
              )}
            </div>

            {/* シンボルリスト */}
            <div className="max-h-48 overflow-y-auto avl-scroll">
              {filtered.length === 0 && (
                <p className="text-[8px] text-gray-700 font-mono text-center py-3">MT5 データ待機中...</p>
              )}
              {filtered.map(s => {
                const isActive  = s.symbol.toUpperCase() === activeSymbol.toUpperCase();
                const symChange = s.changePct >= 0;
                return (
                  <button
                    key={s.symbol}
                    onClick={() => { onSelect(s.symbol); setOpen(false); setSearch(""); }}
                    className={cn(
                      "w-full flex items-center gap-2 px-2.5 py-1 text-left transition-all",
                      isActive
                        ? "bg-cyan-900/25 border-l-2 border-cyan-400"
                        : "hover:bg-cyan-950/20 border-l-2 border-transparent"
                    )}
                  >
                    <div className={cn("w-1 h-1 rounded-full shrink-0",
                      s.bid > 0 ? "bg-green-400" : "bg-gray-700"
                    )}/>
                    <span className={cn("text-[9px] font-mono font-semibold flex-1",
                      isActive ? "text-cyan-300" : s.bid > 0 ? "text-gray-200" : "text-gray-600"
                    )}>{s.symbol}</span>
                    {s.bid > 0 && (
                      <>
                        <span className="text-[8.5px] font-mono text-gray-300 tabular-nums">
                          {s.bid.toFixed(s.digits > 3 ? 5 : 3)}
                        </span>
                        <span className={cn("text-[7px] font-mono tabular-nums w-10 text-right",
                          symChange ? "text-green-400" : "text-red-400"
                        )}>
                          {symChange ? "+" : ""}{s.changePct.toFixed(2)}%
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="px-2.5 py-1 border-t border-cyan-900/20">
              <p className="text-[6.5px] text-gray-700 font-mono">
                {symbolList.length} symbols from MT5 Market Watch
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function parseOrder(text: string): OrderProposal | null {
  const m = text.match(/<ORDER>([\s\S]*?)<\/ORDER>/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as OrderProposal; } catch { return null; }
}
function stripOrder(t: string) { return t.replace(/<ORDER>[\s\S]*?<\/ORDER>/g,"").trim(); }

// =================================================================
// グローバルステータスバー
// =================================================================
function GlobalStatusBar({ time, isConnected, status, aiMode, voiceStatus, account, sessions }: {
  time: Date; isConnected: boolean; status: string; aiMode: AIMode; voiceStatus: string; account: MarketAccount | null; sessions?: string[];
}) {
  const modeLabel: Record<AIMode, string> = {
    analysis: "ANALYSIS", monitor: "MONITOR", assisted: "ASSISTED", autonomous: "AUTONOMOUS",
  };
  const modeColor: Record<AIMode, string> = {
    analysis: "text-cyan-400 border-cyan-700/40", monitor: "text-yellow-400 border-yellow-700/40",
    assisted: "text-green-400 border-green-700/40", autonomous: "text-red-400 border-red-700/40",
  };

  return (
    <div className="relative flex items-center gap-3 px-4 h-10 bg-[#020408] border-b border-cyan-900/20 shrink-0 text-[8.5px] font-mono overflow-hidden">
      {/* 底辺グロー */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />

      {/* ブランド */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex gap-0.5">
          <div className="w-0.5 h-4 bg-cyan-500" style={{boxShadow:"0 0 6px rgba(0,200,255,0.8)"}} />
          <div className="w-0.5 h-4 bg-cyan-500/40" />
        </div>
        <span className="text-cyan-400 tracking-[0.2em] font-bold text-[9px]" style={{textShadow:"0 0 12px rgba(0,200,255,0.5)"}}>
          AVL AI
        </span>
        <span className="text-gray-600 tracking-widest text-[7px]">OPERATING SYSTEM</span>
      </div>

      <div className="w-px h-5 bg-cyan-900/40" />

      {/* MT5 接続 */}
      <div className="flex items-center gap-1.5">
        <div className={cn("relative w-2 h-2 rounded-full", isConnected ? "bg-green-400" : "bg-gray-700")}>
          {isConnected && <div className="absolute inset-0 rounded-full bg-green-400 animate-ping opacity-50" />}
        </div>
        <span className={cn("tracking-wider", isConnected ? "text-green-400" : "text-gray-600")}>
          MT5 {isConnected ? "LIVE" : "OFFLINE"}
        </span>
      </div>

      {/* AI Mode */}
      <div className={cn("flex items-center gap-1 px-2 py-0.5 border tracking-widest", modeColor[aiMode])}>
        <Brain size={7} />
        <span className="text-[7.5px]">{modeLabel[aiMode]}</span>
      </div>

      {/* Voice */}
      {voiceStatus !== "idle" ? (
        <div className="flex items-center gap-1 text-cyan-400">
          <Volume2 size={9} className="animate-pulse" />
          <span className="tracking-wider">{voiceStatus.toUpperCase()}</span>
        </div>
      ) : (
        <div className="flex items-center gap-1 text-gray-700">
          <VolumeX size={9} />
          <span>VOICE</span>
        </div>
      )}

      {/* Account */}
      {account && (
        <>
          <div className="w-px h-4 bg-cyan-900/40" />
          <div className="flex items-center gap-3">
            <span className="text-gray-600">{account.broker.slice(0,14)}</span>
            <span className="text-gray-300">{account.currency} <span className="text-white font-semibold">{account.balance.toLocaleString()}</span></span>
            <span className={cn("font-semibold", account.equity >= account.balance ? "text-green-400" : "text-red-400")}>
              EQ {account.equity.toLocaleString()}
            </span>
          </div>
        </>
      )}

      <div className="flex-1" />

      {/* Sessions */}
      {sessions && sessions.length > 0 && (
        <div className="flex items-center gap-1">
          {sessions.map(s => (
            <span key={s} className={cn("text-[7px] tracking-wider border px-1.5 py-0.5",
              s.includes("Tokyo")    ? "border-blue-800/60 text-blue-300 bg-blue-950/30" :
              s.includes("London")   ? "border-purple-800/60 text-purple-300 bg-purple-950/30" :
              s.includes("New York") ? "border-orange-800/60 text-orange-300 bg-orange-950/30" :
              s.includes("Sydney")   ? "border-teal-800/60 text-teal-300 bg-teal-950/30" :
              "border-gray-700/50 text-gray-500"
            )}>{s.replace(" Session","")}</span>
          ))}
        </div>
      )}

      <div className="w-px h-4 bg-cyan-900/40" />

      {/* Time */}
      <div className="flex items-center gap-1.5">
        <Radio size={8} className="text-cyan-600/60 avl-blink" />
        <span className="text-gray-300 tabular-nums" suppressHydrationWarning>
          {time.toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
        </span>
        <span className="text-gray-700">JST</span>
      </div>
    </div>
  );
}

// =================================================================
// AI モードセレクター
// =================================================================
function ModeSelector({ mode, onChange }: { mode: AIMode; onChange: (m: AIMode) => void }) {
  const [confirm, setConfirm] = useState<AIMode | null>(null);

  const modes: { id: AIMode; label: string; icon: typeof Brain }[] = [
    { id: "analysis",   label: "ANALYSIS",   icon: Brain },
    { id: "monitor",    label: "MONITOR",    icon: Eye   },
    { id: "assisted",   label: "ASSISTED",   icon: Zap   },
    { id: "autonomous", label: "AUTO",       icon: Bot   },
  ];
  const colors: Record<AIMode,string> = {
    analysis:   "border-cyan-600/60 bg-cyan-900/30 text-cyan-300",
    monitor:    "border-yellow-600/60 bg-yellow-900/30 text-yellow-300",
    assisted:   "border-green-600/60 bg-green-900/30 text-green-300",
    autonomous: "border-red-600/60 bg-red-900/30 text-red-300",
  };

  const handleClick = (id: AIMode) => {
    if (id === "autonomous" && mode !== "autonomous") { setConfirm(id); return; }
    onChange(id);
  };

  return (
    <>
      <div className="flex gap-1">
        {modes.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => handleClick(id)}
            className={cn("flex items-center gap-1 px-2 py-1 text-[8px] font-mono border transition-all",
              mode === id ? colors[id] : "border-[#0d1520] text-gray-700 hover:text-gray-500 hover:border-[#1a2535]"
            )}>
            <Icon size={8} />{label}
          </button>
        ))}
      </div>
      {confirm === "autonomous" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="border border-red-700/60 bg-[#060a12] p-6 max-w-xs w-full mx-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1 h-5 bg-red-500" />
              <span className="text-[10px] text-red-400 font-mono font-bold">AUTONOMOUS MODE</span>
            </div>
            <p className="text-[8px] text-yellow-300 font-mono mb-2">⚠ 重要な警告</p>
            <p className="text-[8px] text-gray-300 font-mono leading-relaxed mb-4">
              このモードでは AVL AI が市場分析・<br/>
              エントリー・決済を自動実行します。<br/><br/>
              実際の資金が自動運用されます。<br/>
              リスクを完全に理解した上で有効化してください。
            </p>
            <div className="flex gap-2">
              <button onClick={() => { onChange("autonomous"); setConfirm(null); }}
                className="flex-1 py-1.5 text-[8px] font-mono border border-red-700/50 text-red-300 hover:bg-red-900/30">
                有効化する
              </button>
              <button onClick={() => setConfirm(null)}
                className="flex-1 py-1.5 text-[8px] font-mono border border-[#0d1520] text-gray-500 hover:text-gray-300">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// =================================================================
// エージェントカード
// =================================================================
function AgentCard({ agent }: { agent: AgentState }) {
  const statusColors: Record<AgentState["status"],string> = {
    idle:     "bg-gray-700",
    active:   "bg-green-400",
    thinking: "bg-cyan-400 animate-pulse",
    error:    "bg-red-400",
  };
  const icons: Record<string, typeof Brain> = {
    market:   Activity, analysis: Brain, decision: Zap, order: Shield, voice: Volume2,
  };
  const Icon = icons[agent.id] ?? Bot;

  const isActive   = agent.status === "active";
  const isThinking = agent.status === "thinking";
  const isError    = agent.status === "error";

  return (
    <div className={cn(
      "relative flex-1 border p-2 min-w-[110px] overflow-hidden transition-all duration-300",
      isActive   ? "border-green-700/50 bg-green-950/20" :
      isThinking ? "border-cyan-700/50 bg-cyan-950/20" :
      isError    ? "border-red-700/50 bg-red-950/20" :
      "border-[#0d1520] bg-[#04060d]"
    )}>
      {/* アクティブ時のトップグロー */}
      {(isActive || isThinking) && (
        <div className={cn("absolute top-0 left-0 right-0 h-px",
          isThinking ? "bg-cyan-500/60" : "bg-green-500/50"
        )} />
      )}
      {/* 思考中スキャンライン */}
      {isThinking && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-cyan-400/20 to-transparent avl-scan-line" />
        </div>
      )}

      <div className="flex items-center gap-1.5 mb-1">
        <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusColors[agent.status])} />
        <Icon size={9} className={cn(
          isActive   ? "text-green-400" :
          isThinking ? "text-cyan-400" :
          isError    ? "text-red-400" :
          "text-gray-700"
        )} />
        <span className={cn(
          "text-[7.5px] font-mono font-semibold tracking-wide truncate",
          isActive || isThinking ? "text-gray-200" : isError ? "text-red-400" : "text-gray-700"
        )}>{agent.name}</span>
      </div>
      {agent.lastAction ? (
        <p className="text-[7px] font-mono truncate avl-fade-up" style={{color: isThinking?"rgba(0,200,255,0.7)": isActive?"rgba(0,255,120,0.6)":"rgba(100,120,140,0.6)"}}>
          {agent.lastAction}
        </p>
      ) : (
        <p className="text-[7px] text-gray-800 font-mono">{agent.description}</p>
      )}
    </div>
  );
}

// =================================================================
// AI レーダー — JARVIS / Cyberpunk スタイル
// =================================================================
function AIRadar({ mode, thinking, voiceStatus }: {
  mode: AIMode; thinking: boolean; voiceStatus: string;
}) {
  const isListening = voiceStatus === "listening";
  const isSpeaking  = voiceStatus === "speaking";
  const isActive    = thinking || isListening || isSpeaking;

  // モード別ネオンカラー
  const nc: Record<AIMode, {hex: string; r: string}> = {
    analysis:   { hex: "#00e5ff", r: "rgba(0,229,255," },
    monitor:    { hex: "#ffd700", r: "rgba(255,215,0," },
    assisted:   { hex: "#00ff88", r: "rgba(0,255,136," },
    autonomous: { hex: "#ff1a4e", r: "rgba(255,26,78," },
  };
  const { hex, r: rgba } = nc[mode];

  const statusText =
    thinking    ? "ANALYZING"   :
    isListening ? "LISTENING"   :
    isSpeaking  ? "RESPONDING"  :
    { analysis:"ANALYSIS MODE", monitor:"MONITOR MODE", assisted:"ASSISTED MODE", autonomous:"AUTONOMOUS MODE" }[mode];

  const SIZE = 480;
  const CX   = SIZE / 2;
  const rnd  = (v: number) => Math.round(v * 1e4) / 1e4;

  // 外周ティック (72本)
  const ticks = useMemo(() => Array.from({ length: 72 }, (_, i) => {
    const deg = i * 5 * Math.PI / 180;
    const main = i % 9 === 0;
    const r1 = 228, r2 = main ? 212 : 222;
    return {
      x1: rnd(CX + r1 * Math.cos(deg - Math.PI/2)),
      y1: rnd(CX + r1 * Math.sin(deg - Math.PI/2)),
      x2: rnd(CX + r2 * Math.cos(deg - Math.PI/2)),
      y2: rnd(CX + r2 * Math.sin(deg - Math.PI/2)),
      main,
    };
  }), []);

  // ニューラルネットワーク ノード（黄金角スパイラル）
  const nodes = useMemo(() =>
    Array.from({ length: 24 }, (_, i) => {
      const angle = i * 137.508 * Math.PI / 180;
      const dist  = 32 + i * 8.5;
      if (dist > 198) return null;
      return {
        id: i,
        x:  rnd(CX + dist * Math.cos(angle)),
        y:  rnd(CX + dist * Math.sin(angle)),
        r:  1 + (i % 3) * 0.5,
        a:  0.18 + (i % 4) * 0.09,
      };
    }).filter(Boolean) as {id:number;x:number;y:number;r:number;a:number}[]
  , []);

  // 3軌道リング定義
  const orbits = [
    { ry: 55,  rotG: 0,    col: hex,      dur: "20s", ccw: false, pts: [0, 180]      },
    { ry: 55,  rotG: 65,   col: "#ff1a4e",dur: "13s", ccw: true,  pts: [0, 120, 240] },
    { ry: 55,  rotG: -58,  col: "#00ff88",dur: "24s", ccw: false, pts: [60, 240]     },
  ];
  const ORBIT_RX = 168;

  // 放射ライン (12本)
  const spokes = useMemo(() =>
    Array.from({ length: 12 }, (_, i) => {
      const rad = i * 30 * Math.PI / 180;
      return {
        x1: rnd(CX + 38  * Math.cos(rad)),
        y1: rnd(CX + 38  * Math.sin(rad)),
        x2: rnd(CX + 200 * Math.cos(rad)),
        y2: rnd(CX + 200 * Math.sin(rad)),
      };
    })
  , []);

  return (
    <div className="relative flex items-center justify-center select-none" style={{ width: SIZE, height: SIZE }}>

      {/* ── 背景ネオングロー ── */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: `radial-gradient(circle at 50% 50%, ${rgba}0.22) 0%, ${rgba}0.08) 30%, ${rgba}0.02) 60%, transparent 80%)`,
        filter: `blur(${isActive ? 24 : 14}px)`,
      }}/>
      <div className="absolute inset-0 avl-grid-bg opacity-10 pointer-events-none"/>

      {/* ── スキャンスウィープ（メイン）── */}
      <div className="absolute overflow-hidden rounded-full pointer-events-none"
        style={{ width: SIZE-16, height: SIZE-16, left: 8, top: 8,
          animation: `avl-spin-cw-med ${isActive ? (thinking ? "2.8s" : "4.5s") : "12s"} linear infinite` }}>
        <div className="absolute inset-0" style={{
          background: `conic-gradient(from 0deg, transparent 0deg, ${rgba}0.4) 16deg, ${rgba}0.15) 38deg, transparent 40deg)`,
        }}/>
      </div>

      {/* ── 逆回転スウィープ（アクティブ時）── */}
      {isActive && (
        <div className="absolute overflow-hidden rounded-full pointer-events-none"
          style={{ width: SIZE-100, height: SIZE-100, left: 50, top: 50,
            animation: `avl-spin-ccw ${thinking ? "3.5s" : "8s"} linear infinite` }}>
          <div className="absolute inset-0" style={{
            background: `conic-gradient(from 0deg, transparent 0deg, rgba(255,255,255,0.06) 8deg, transparent 10deg)`,
          }}/>
        </div>
      )}

      {/* ── メイン SVG ── */}
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0" overflow="visible">
        <defs>
          <filter id="jv-sm" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.5" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="jv-md" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="5" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="jv-lg" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="10" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <radialGradient id="jv-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={hex} stopOpacity={isActive ? 1 : 0.7}/>
            <stop offset="25%"  stopColor={hex} stopOpacity="0.4"/>
            <stop offset="60%"  stopColor={hex} stopOpacity="0.1"/>
            <stop offset="100%" stopColor={hex} stopOpacity="0"/>
          </radialGradient>
          <radialGradient id="jv-sphere" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={hex} stopOpacity="0.12"/>
            <stop offset="70%"  stopColor={hex} stopOpacity="0.04"/>
            <stop offset="100%" stopColor={hex} stopOpacity="0"/>
          </radialGradient>
        </defs>

        {/* 外側球体グロー */}
        <circle cx={CX} cy={CX} r={228} fill="url(#jv-sphere)"/>
        <circle cx={CX} cy={CX} r={228} fill="none" stroke={`${rgba}0.10)`} strokeWidth="1.5"/>

        {/* 外周72ティック */}
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={`${rgba}${t.main ? 0.6 : 0.18})`}
            strokeWidth={t.main ? 2 : 0.7}
            filter={t.main ? "url(#jv-sm)" : undefined}
          />
        ))}

        {/* 同心円 5本 */}
        {[192, 155, 118, 82, 52].map((r, i) => (
          <circle key={r} cx={CX} cy={CX} r={r}
            fill="none"
            stroke={`${rgba}${0.06 + i * 0.02})`}
            strokeWidth={i === 0 ? 1.2 : 0.5}
            strokeDasharray={i === 1 ? "4 8" : i === 3 ? "1 6" : undefined}
          />
        ))}

        {/* 放射スポーク */}
        {spokes.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
            stroke={`${rgba}0.07)`} strokeWidth="0.5"
          />
        ))}

        {/* ニューラルネット接続線 */}
        {nodes.map((n, i) =>
          nodes.slice(i + 1, i + 5).map((m, j) => {
            const d = Math.hypot(n.x - m.x, n.y - m.y);
            if (d > 85) return null;
            return (
              <line key={`${i}-${j}`} x1={n.x} y1={n.y} x2={m.x} y2={m.y}
                stroke={`${rgba}${Math.max(0.04, 0.13 * (1 - d/85))})`}
                strokeWidth="0.5"
              />
            );
          })
        )}
        {/* ニューラルノード */}
        {nodes.map(n => (
          <circle key={n.id} cx={n.x} cy={n.y} r={n.r}
            fill={hex} opacity={n.a}
          />
        ))}

        {/* 3軌道リング + アニメーション粒子 */}
        {orbits.map((orb, oi) => (
          <g key={oi} style={{ transformOrigin:`${CX}px ${CX}px`, transform:`rotate(${orb.rotG}deg)` }}>
            <ellipse cx={CX} cy={CX} rx={ORBIT_RX} ry={orb.ry}
              fill="none" stroke={orb.col} strokeWidth="1" opacity="0.45"
              strokeDasharray="3 10" filter="url(#jv-sm)"
            />
            {orb.pts.map((offset, pi) => (
              <g key={pi}>
                {/* 粒子本体 */}
                <circle cx={CX + ORBIT_RX} cy={CX} r={pi === 0 ? 4 : 3}
                  fill={orb.col} filter="url(#jv-md)" opacity="0.95">
                  <animateTransform attributeName="transform" type="rotate"
                    from={`${offset} ${CX} ${CX}`}
                    to={`${offset + (orb.ccw ? -360 : 360)} ${CX} ${CX}`}
                    dur={orb.dur} repeatCount="indefinite"
                  />
                </circle>
                {/* ハロー */}
                <circle cx={CX + ORBIT_RX} cy={CX} r={pi === 0 ? 9 : 7}
                  fill="none" stroke={orb.col} strokeWidth="0.8" opacity="0.25">
                  <animateTransform attributeName="transform" type="rotate"
                    from={`${offset} ${CX} ${CX}`}
                    to={`${offset + (orb.ccw ? -360 : 360)} ${CX} ${CX}`}
                    dur={orb.dur} repeatCount="indefinite"
                  />
                </circle>
              </g>
            ))}
          </g>
        ))}

        {/* アクティブ時パルス波 */}
        {isActive && [0, 1, 2].map(i => (
          <circle key={i} cx={CX} cy={CX} r={52}
            fill="none" stroke={`${rgba}0.45)`} strokeWidth="1.5"
            style={{
              animation: `avl-pulse-ring-out ${2.2 + i * 0.4}s ease-out ${i * 0.65}s infinite`,
            }}
          />
        ))}

        {/* コアグロー */}
        <circle cx={CX} cy={CX} r={70} fill="url(#jv-core)"/>

        {/* センターリング群 */}
        <circle cx={CX} cy={CX} r={46} fill="none" stroke={`${rgba}0.3)`} strokeWidth="1" filter="url(#jv-sm)"/>
        <circle cx={CX} cy={CX} r={32} fill="none" stroke={`${rgba}0.5)`} strokeWidth="1.2" filter="url(#jv-sm)"/>
        <circle cx={CX} cy={CX} r={20} fill="none" stroke={`${rgba}0.7)`} strokeWidth="1.5" filter="url(#jv-md)"/>

        {/* 内側高速回転スポーク */}
        <g style={{ transformOrigin:`${CX}px ${CX}px`, animation:"avl-spin-cw-fast 7s linear infinite" }}>
          {[0,60,120,180,240,300].map(deg => {
            const rad = deg * Math.PI / 180;
            return (
              <line key={deg}
                x1={rnd(CX + 22 * Math.cos(rad))} y1={rnd(CX + 22 * Math.sin(rad))}
                x2={rnd(CX + 30 * Math.cos(rad))} y2={rnd(CX + 30 * Math.sin(rad))}
                stroke={hex} strokeWidth="2.5" opacity="0.7"
              />
            );
          })}
        </g>
        {/* 逆回転リング（外側）*/}
        <g style={{ transformOrigin:`${CX}px ${CX}px`, animation:"avl-spin-ccw-slow 15s linear infinite" }}>
          {[0,45,90,135,180,225,270,315].map(deg => {
            const rad = deg * Math.PI / 180;
            const x = rnd(CX + 46 * Math.cos(rad));
            const y = rnd(CX + 46 * Math.sin(rad));
            return <circle key={deg} cx={x} cy={y} r="2" fill={hex} opacity="0.5" filter="url(#jv-sm)"/>;
          })}
        </g>

        {/* センタードット */}
        <circle cx={CX} cy={CX} r={isActive ? 9 : 6} fill={hex} filter="url(#jv-lg)"/>
        <circle cx={CX} cy={CX} r={isActive ? 4 : 3} fill="white" opacity="0.95"/>

        {/* コンパスラベル */}
        {[{l:"N",x:CX,y:16},{l:"E",x:SIZE-15,y:CX+4},{l:"S",x:CX,y:SIZE-11},{l:"W",x:15,y:CX+4}].map(({l,x,y})=>(
          <text key={l} x={x} y={y} textAnchor="middle"
            fill={`${rgba}0.45)`} fontSize="9" fontFamily="monospace" filter="url(#jv-sm)">
            {l}
          </text>
        ))}

        {/* HUD コーナーブラケット */}
        {([
          `M 34,54 L 34,34 L 54,34`,
          `M ${SIZE-54},34 L ${SIZE-34},34 L ${SIZE-34},54`,
          `M 34,${SIZE-54} L 34,${SIZE-34} L 54,${SIZE-34}`,
          `M ${SIZE-54},${SIZE-34} L ${SIZE-34},${SIZE-34} L ${SIZE-34},${SIZE-54}`,
        ] as string[]).map((d, i) => (
          <path key={i} d={d} fill="none" stroke={`${rgba}0.45)`} strokeWidth="1.8" filter="url(#jv-sm)"/>
        ))}

        {/* HUD データラベル */}
        <text x={42} y={29} fill={`${rgba}0.35)`} fontSize="6.5" fontFamily="monospace">SYS:ONLINE</text>
        <text x={SIZE-42} y={29} textAnchor="end" fill={`${rgba}0.35)`} fontSize="6.5" fontFamily="monospace">AVL.v3.11</text>
        <text x={42} y={SIZE-20} fill={`${rgba}0.35)`} fontSize="6.5" fontFamily="monospace">MT5:LIVE</text>
        <text x={SIZE-42} y={SIZE-20} textAnchor="end" fill={`${rgba}0.35)`} fontSize="6.5" fontFamily="monospace">EURUSD</text>

        {/* 45°ノード（交差点マーカー）*/}
        {[45,135,225,315].map((deg, i) => {
          const rad = deg * Math.PI / 180;
          const x = rnd(CX + 155 * Math.cos(rad));
          const y = rnd(CX + 155 * Math.sin(rad));
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={5} fill="none" stroke={hex} strokeWidth="1.2" opacity="0.5" filter="url(#jv-sm)"/>
              <circle cx={x} cy={y} r={2} fill={hex} opacity="0.8" filter="url(#jv-sm)"/>
            </g>
          );
        })}
      </svg>

      {/* ── 外側パルスリング（active）── */}
      {isActive && (
        <div className="absolute rounded-full pointer-events-none"
          style={{
            width: 130, height: 130, left: CX-65, top: CX-65,
            border: `1px solid ${rgba}0.35)`,
            boxShadow: `0 0 20px ${hex}44, inset 0 0 15px ${hex}22`,
            animation: "avl-ping-outer 2.8s ease-out infinite",
          }}
        />
      )}

      {/* ── 中心テキスト ── */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <p className="font-black font-mono"
          style={{
            fontSize: 18, letterSpacing: "0.55em",
            color: hex,
            textShadow: `0 0 12px ${hex}, 0 0 28px ${hex}bb, 0 0 55px ${hex}66, 0 0 100px ${hex}33`,
          }}>
          AVL AI
        </p>
        <p className="font-mono mt-1"
          style={{
            fontSize: 7.5, letterSpacing: "0.28em",
            color: `${rgba}0.85)`,
            textShadow: `0 0 8px ${hex}88`,
          }}>
          {statusText}
        </p>

        {/* 音声ウェーブバー */}
        {isActive && (
          <div className="flex gap-0.5 mt-3 items-end">
            {[2,4,6,9,13,16,13,9,6,4,2].map((h, i) => (
              <div key={i} className="w-1 rounded-full"
                style={{
                  height: h * 2.2,
                  backgroundColor: hex,
                  boxShadow: `0 0 6px ${hex}, 0 0 12px ${hex}88`,
                  animation: `avl-wave-bar ${0.65 + i * 0.07}s ease-in-out ${i * 0.07}s infinite alternate`,
                  transformOrigin: "bottom",
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =================================================================
// スパークライン（小型折れ線 SVG）
// =================================================================
function Sparkline({ data, color = "#22c55e", height = 28 }: {
  data: number[]; color?: string; height?: number;
}) {
  if (data.length < 2) return null;
  const w = 100, h = height;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 100 ${h}`} className="w-full" style={{ height }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <polyline points={`0,${h} ${pts} 100,${h}`} fill={color} fillOpacity="0.08" stroke="none" />
    </svg>
  );
}

// =================================================================
// 左パネル: アカウント・ポジション
// =================================================================
function AccountPanel({ account, positions, logs }: {
  account: MarketAccount | null;
  positions: MarketPosition[];
  logs: { id: string; ts: number; text: string; type: string }[];
}) {
  const totalPL = positions.reduce((s, p) => s + p.profit, 0);

  // セッション中の equity 履歴（最大40点）
  const equityHistRef = useRef<number[]>([]);
  useEffect(() => {
    if (account) {
      equityHistRef.current = [...equityHistRef.current.slice(-39), account.equity];
    }
  }, [account?.equity]);
  const equityHist = equityHistRef.current;

  const plPct = account ? (totalPL / Math.max(1, account.balance)) * 100 : 0;

  return (
    <div className="flex flex-col gap-1.5 w-56 shrink-0 overflow-y-auto p-2 avl-grid-bg">

      {/* Account Overview */}
      <div className="border border-cyan-900/20 bg-[#02040a] p-3 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />
        <div className="text-[7.5px] text-cyan-500/50 font-mono tracking-[0.2em] mb-2.5 flex items-center gap-1.5">
          <Activity size={8} className="text-cyan-500/50" />
          ACCOUNT OVERVIEW
        </div>
        {account ? (
          <div className="space-y-2">
            {/* Balance / Equity */}
            <div className="space-y-1">
              <div className="flex justify-between items-baseline">
                <span className="text-[7px] text-gray-600">BALANCE</span>
                <span className="text-[10px] text-white font-semibold tabular-nums">
                  {account.balance.toLocaleString()} <span className="text-[7px] text-gray-600">{account.currency}</span>
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-[7px] text-gray-600">EQUITY</span>
                <span className={cn("text-[10px] font-semibold tabular-nums", account.equity >= account.balance ? "text-green-400" : "text-red-400")}>
                  {account.equity.toLocaleString()}
                </span>
              </div>
            </div>

            {/* Equity Sparkline */}
            {equityHist.length >= 2 && (
              <div className="border border-[#0d1520] p-1.5">
                <div className="text-[6.5px] text-gray-700 font-mono mb-1">EQUITY CURVE</div>
                <Sparkline data={equityHist} color={account.equity >= account.balance ? "#22c55e" : "#ef4444"} height={24} />
              </div>
            )}

            {/* P&L バー */}
            <div>
              <div className="flex justify-between text-[7px] font-mono mb-1">
                <span className="text-gray-700">UNREALIZED P&L</span>
                <span className={cn("font-semibold", totalPL >= 0 ? "text-green-400" : "text-red-400")}>
                  {totalPL >= 0 ? "+" : ""}{totalPL.toFixed(2)}
                </span>
              </div>
              <div className="h-0.5 w-full bg-[#0d1520] relative overflow-hidden">
                <div className={cn("h-full transition-all duration-500", totalPL >= 0 ? "bg-green-500" : "bg-red-500")}
                  style={{ width: `${Math.min(100, Math.abs(plPct) * 50)}%` }}
                />
              </div>
            </div>

            {/* グリッドメトリクス */}
            <div className="grid grid-cols-2 gap-1">
              {[
                { label: "FREE MG", value: account.freeMargin.toFixed(0) },
                { label: "MG LEVEL", value: account.marginLevel > 0 ? account.marginLevel.toFixed(0) + "%" : "—" },
                { label: "LEVERAGE", value: "1:" + account.leverage },
                { label: "BROKER", value: account.broker.slice(0, 8) },
              ].map(({ label, value }) => (
                <div key={label} className="border border-[#0d1520] px-1.5 py-1">
                  <div className="text-[6.5px] text-gray-700 font-mono">{label}</div>
                  <div className="text-[8.5px] text-gray-300 font-mono">{value}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center py-3 gap-1">
            <WifiOff size={14} className="text-gray-700" />
            <p className="text-[8px] text-gray-700 font-mono">MT5 未接続</p>
          </div>
        )}
      </div>

      {/* Open Positions */}
      <div className="border border-cyan-900/20 bg-[#02040a] p-3 flex-1 min-h-0">
        <div className="text-[7.5px] text-cyan-500/50 font-mono tracking-[0.2em] mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Briefcase size={8} className="text-cyan-500/50" />
            POSITIONS
          </div>
          <span className={cn("text-[7px] tabular-nums", positions.length > 0 ? "text-green-400" : "text-gray-700")}>
            {positions.length} OPEN
          </span>
        </div>
        {positions.length === 0 ? (
          <p className="text-[7.5px] text-gray-700 font-mono py-2 text-center">— NO OPEN POSITIONS —</p>
        ) : (
          <div className="space-y-1.5 overflow-y-auto max-h-40">
            {positions.map((pos) => (
              <div key={pos.ticket} className={cn(
                "relative border p-2 overflow-hidden",
                pos.profit >= 0 ? "border-green-900/30 bg-green-950/10" : "border-red-900/30 bg-red-950/10"
              )}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1">
                    {pos.type===0
                      ? <TrendingUp size={9} className="text-green-400"/>
                      : <TrendingDown size={9} className="text-red-400"/>}
                    <span className={cn("text-[8px] font-mono font-bold", pos.type===0 ? "text-green-400" : "text-red-400")}>
                      {pos.type===0 ? "BUY" : "SELL"}
                    </span>
                    <span className="text-[7px] text-gray-500 font-mono">{pos.volume}L</span>
                  </div>
                  <span className={cn("text-[9px] font-mono font-semibold tabular-nums", pos.profit>=0 ? "text-green-400" : "text-red-400")}>
                    {pos.profit>=0?"+":""}{pos.profit.toFixed(2)}
                  </span>
                </div>
                <div className="text-[6.5px] text-gray-600 font-mono tabular-nums">
                  {pos.openPrice.toFixed(5)} → {pos.currentPrice.toFixed(5)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* System Log */}
      <div className="border border-cyan-900/20 bg-[#02040a] p-2.5 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/20 to-transparent" />
        <div className="text-[7.5px] text-purple-500/50 font-mono tracking-[0.2em] mb-2 flex items-center gap-1.5">
          <ScrollText size={8} className="text-purple-500/50" />
          SYSTEM LOG
        </div>
        <div className="space-y-0.5 max-h-24 overflow-y-auto">
          {logs.length === 0 && <p className="text-[7px] text-gray-800 font-mono text-center py-1">STANDBY</p>}
          {logs.slice().reverse().slice(0, 20).map((log) => (
            <div key={log.id} className="flex items-start gap-1.5 avl-slide-in">
              <div className={cn("w-1 h-1 rounded-full shrink-0 mt-1",
                log.type==="ok"     ? "bg-green-500" :
                log.type==="warn"   ? "bg-yellow-500" :
                log.type==="ai"     ? "bg-purple-400" :
                log.type==="signal" ? "bg-cyan-400" :
                log.type==="order"  ? "bg-orange-400" :
                "bg-gray-700"
              )} />
              <p className="text-[6.5px] text-gray-600 font-mono leading-tight truncate">{log.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// =================================================================
// 右パネル: マーケット情報・分析ログ
// =================================================================
function MarketPanel({ symbol, indicators, watchlist, extQuotes }: {
  symbol: string;
  indicators: ReturnType<typeof useIndicatorStore.getState>["indicators"][string] | undefined;
  watchlist: { symbol: string; bid: number; ask: number; spread: number; isConnected: boolean }[];
  extQuotes: ExtQuote[];
}) {
  const TFS = ["H4", "H1", "M15", "M5"] as const;

  return (
    <div className="flex flex-col gap-1.5 w-56 shrink-0 overflow-y-auto p-2 avl-grid-bg">

      {/* Global Markets */}
      {extQuotes.length > 0 && (
        <div className="border border-cyan-900/20 bg-[#02040a] p-2.5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-blue-500/25 to-transparent" />
          <div className="text-[7.5px] text-blue-400/50 font-mono tracking-[0.2em] mb-2 flex items-center gap-1.5">
            <Globe size={8} className="text-blue-400/50" />
            GLOBAL MARKETS
          </div>
          <div className="space-y-1">
            {extQuotes.map((q) => {
              const pos = q.changePct >= 0;
              return (
                <div key={q.symbol} className="flex items-center justify-between py-0.5">
                  <span className="text-[7.5px] font-mono text-gray-500">{q.symbol.replace("/USD","").replace("/","")}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[8.5px] font-mono text-gray-200 tabular-nums">
                      {q.price > 0 ? q.price.toFixed(q.price > 100 ? 1 : 4) : "—"}
                    </span>
                    {q.changePct !== 0 && (
                      <span className={cn("text-[7px] font-mono tabular-nums w-12 text-right",
                        pos ? "text-green-400" : "text-red-400"
                      )}>
                        {pos ? "+" : ""}{q.changePct.toFixed(2)}%
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Market Watch */}
      <div className="border border-cyan-900/20 bg-[#02040a] p-2.5 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent" />
        <div className="text-[7.5px] text-cyan-500/50 font-mono tracking-[0.2em] mb-2 flex items-center gap-1.5">
          <BarChart2 size={8} className="text-cyan-500/50" />
          MARKET WATCH
        </div>
        <div className="space-y-0.5">
          {watchlist.map((item) => (
            <div key={item.symbol} className={cn(
              "flex items-center justify-between py-1 px-1.5 transition-colors",
              item.isConnected ? "hover:bg-cyan-950/20" : ""
            )}>
              <span className={cn("text-[8.5px] font-mono font-semibold",
                item.isConnected ? "text-cyan-400" : "text-gray-700"
              )}>{item.symbol}</span>
              <div className="flex items-center gap-2">
                <span className="text-[8.5px] font-mono tabular-nums text-gray-200">
                  {item.bid>0 ? item.bid.toFixed(5) : "—"}
                </span>
                {item.isConnected && (
                  <span className={cn("text-[6.5px] font-mono tabular-nums",
                    item.spread > 5 ? "text-red-400" : "text-gray-600"
                  )}>{item.spread.toFixed(1)}p</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Technical Indicators */}
      <div className="border border-cyan-900/20 bg-[#02040a] p-2.5 relative overflow-hidden">
        <div className="text-[7.5px] text-cyan-500/50 font-mono tracking-[0.2em] mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Activity size={8} className="text-cyan-500/50" />
            INDICATORS
          </div>
          <span className="text-cyan-400/40 text-[7px]">{symbol}</span>
        </div>
        {indicators ? (
          <div className="space-y-1.5">
            {/* Spread インジケーター */}
            <div className="flex items-center justify-between text-[7px] font-mono pb-1 border-b border-[#0d1520]/50">
              <span className="text-gray-700">SPREAD</span>
              <span className={cn("font-semibold tabular-nums",
                indicators.spread > 5 ? "text-red-400" : indicators.spread > 2 ? "text-yellow-400" : "text-green-400"
              )}>{indicators.spread.toFixed(1)} pips</span>
            </div>
            {TFS.map((tf) => {
              const d = indicators.timeframes?.[tf];
              const dir = d ? (d.ema21 > d.ema200 ? "up" : d.ema21 < d.ema200 ? "down" : "flat") : null;
              const pct = d ? ((d.ema21 - d.ema200) / d.ema200 * 100) : 0;
              return (
                <div key={tf} className={cn("border p-1.5 transition-colors",
                  dir==="up"   ? "border-green-900/30 bg-green-950/10" :
                  dir==="down" ? "border-red-900/30 bg-red-950/10" :
                  "border-[#0d1520]/50"
                )}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[7.5px] text-cyan-500/60 font-mono font-semibold">{tf}</span>
                    <div className="flex items-center gap-1">
                      {dir==="up"   && <><TrendingUp size={8} className="text-green-400"/><span className="text-[7px] text-green-400 font-mono">BULL</span></>}
                      {dir==="down" && <><TrendingDown size={8} className="text-red-400"/><span className="text-[7px] text-red-400 font-mono">BEAR</span></>}
                      {dir==="flat" && <Minus size={8} className="text-gray-600"/>}
                    </div>
                  </div>
                  {d && (
                    <div className="grid grid-cols-3 gap-1 text-[6.5px] font-mono">
                      <div><div className="text-gray-700 mb-0.5">EMA21</div><div className="text-gray-300 tabular-nums">{d.ema21.toFixed(4)}</div></div>
                      <div><div className="text-gray-700 mb-0.5">EMA200</div><div className="text-gray-300 tabular-nums">{d.ema200.toFixed(4)}</div></div>
                      <div><div className="text-gray-700 mb-0.5">ATR</div><div className="text-orange-400 tabular-nums">{d.atr.toFixed(4)}</div></div>
                      <div className="col-span-3 mt-0.5">
                        <div className="h-0.5 bg-[#0d1520] w-full relative overflow-hidden">
                          <div className={cn("h-full", dir==="up"?"bg-green-500":"bg-red-500")}
                            style={{width:`${Math.min(100,Math.abs(pct)*2000)}%`}} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[7.5px] text-gray-700 font-mono text-center py-3">— AWAITING DATA —</p>
        )}
      </div>

      {/* AI Activity Log */}
      <div className="border border-cyan-900/20 bg-[#02040a] p-2.5 flex-1 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/25 to-transparent" />
        <div className="text-[7.5px] text-purple-400/50 font-mono tracking-[0.2em] mb-2 flex items-center gap-1.5">
          <Brain size={8} className="text-purple-400/50" />
          AI ACTIVITY
        </div>
        <MarketPanelActivityLog />
      </div>
    </div>
  );
}
// Isolated log for MarketPanel — subscribes to aiLogs directly
const MarketPanelActivityLog = memo(function MarketPanelActivityLog() {
  const aiLogs = useAIOSStore(s => s.aiLogs);
  return (
    <div className="space-y-1 max-h-52 overflow-y-auto">
      {aiLogs.length === 0 && <p className="text-[7px] text-gray-800 font-mono text-center py-2">STANDBY</p>}
      {[...aiLogs].reverse().slice(0, 30).map((log) => (
        <div key={log.id} className="pb-1 border-b border-[#0d1520]/20 avl-slide-in">
          <span className="text-[6px] text-gray-800 font-mono tabular-nums">
            {new Date(log.ts).toLocaleTimeString("ja-JP")}
          </span>
          <p className={cn("text-[7px] font-mono leading-snug",
            log.type==="signal" ? "text-cyan-300" :
            log.type==="order"  ? "text-orange-300" :
            log.type==="ai"     ? "text-purple-300" :
            log.type==="ok"     ? "text-green-400" :
            log.type==="warn"   ? "text-yellow-400" :
            "text-gray-600"
          )}>{log.text}</p>
        </div>
      ))}
    </div>
  );
});

// =================================================================
// マークダウン表示
// =================================================================
function MessageContent({ content }: { content: string }) {
  const clean = stripOrder(content);
  return (
    <div className="space-y-0.5">
      {clean.split("\n").map((line, i) => {
        if (line.startsWith("## "))  return <p key={i} className="text-cyan-300 font-semibold text-[11px] mt-1.5">{line.slice(3)}</p>;
        if (line.startsWith("### ")) return <p key={i} className="text-blue-300 text-[10px] mt-1">{line.slice(4)}</p>;
        if (/^\*\*(.+)\*\*$/.test(line)) return <p key={i} className="text-white font-semibold text-[11px]">{line.replace(/\*\*/g,"")}</p>;
        if (!line.trim()) return <div key={i} className="h-0.5" />;
        return <p key={i} className="text-gray-300 text-[11px] leading-relaxed">{line}</p>;
      })}
    </div>
  );
}

// =================================================================
// 注文確認カード
// =================================================================
function OrderCard({ p, onConfirm, onCancel }: { p: OrderProposal; onConfirm:()=>void; onCancel:()=>void }) {
  const isBuy = p.direction === "BUY";
  return (
    <div className={cn("border mx-4 p-3 my-1", isBuy ? "border-green-700/50 bg-green-950/20" : "border-red-700/50 bg-red-950/20")}>
      <div className="flex items-center gap-2 mb-2">
        <span className={cn("text-[10px] font-mono font-bold px-2 py-0.5 border", isBuy ? "border-green-600/50 text-green-300 bg-green-900/30" : "border-red-600/50 text-red-300 bg-red-900/30")}>
          {p.direction}
        </span>
        <span className="text-[9px] text-cyan-400 font-mono">{p.symbol}</span>
        <span className="ml-auto text-[8px] text-gray-600 font-mono">ORDER CONFIRMATION</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        {[["ENTRY",p.entry.toFixed(5),"text-white"],["SL",p.sl.toFixed(5),"text-red-400"],["TP",p.tp.toFixed(5),"text-green-400"]].map(([l,v,c])=>(
          <div key={l} className="border border-[#0d1520] p-1 text-center">
            <div className="text-[7px] text-gray-700 font-mono">{l}</div>
            <div className={cn("text-[9px] font-mono font-semibold",c)}>{v}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-3 text-[8px] font-mono mb-2">
        <span className="text-gray-600">RR: <span className="text-cyan-400">{p.rr}</span></span>
        <span className="text-gray-600">Confidence: <span className="text-yellow-400">{p.confidence}%</span></span>
      </div>
      <p className="text-[8px] text-gray-500 font-mono mb-2 leading-snug">{p.reason}</p>
      <div className="flex gap-1.5">
        <button onClick={onConfirm} className={cn("flex-1 py-1.5 text-[9px] font-mono border transition-all", isBuy ? "border-green-600/50 text-green-300 hover:bg-green-900/30" : "border-red-600/50 text-red-300 hover:bg-red-900/30")}>
          ✓ 注文実行
        </button>
        <button onClick={onCancel} className="flex-1 py-1.5 text-[9px] font-mono border border-[#0d1520] text-gray-500 hover:text-gray-300 transition-all">
          ✗ キャンセル
        </button>
      </div>
    </div>
  );
}

// =================================================================
// Log panels — isolated memo components so aiLogs updates
// don't re-render the entire DashboardOS tree
// =================================================================
const SystemLogPanel = memo(function SystemLogPanel() {
  const aiLogs = useAIOSStore(s => s.aiLogs);
  return (
    <div className="avl-glass avl-top-accent relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/20 to-transparent"/>
      <div className="px-3 py-2.5">
        <p className="text-[8px] text-purple-400/50 font-mono tracking-[0.2em] mb-2 flex items-center gap-1.5">
          <ScrollText size={8}/> SYSTEM LOG
        </p>
        <div className="space-y-1 max-h-36 overflow-y-auto">
          {aiLogs.slice().reverse().slice(0,15).map(log => (
            <div key={log.id} className="flex items-start gap-2 avl-slide-in">
              <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 mt-0.5",
                log.type==="ok"?"bg-green-500": log.type==="warn"?"bg-yellow-500":
                log.type==="ai"?"bg-purple-400": log.type==="signal"?"bg-cyan-400":
                log.type==="order"?"bg-orange-400":"bg-gray-700"
              )}/>
              <div>
                <span className="text-[7px] text-gray-700 font-mono tabular-nums">
                  {new Date(log.ts).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
                </span>
                <p className="text-[7.5px] text-gray-500 font-mono leading-snug">{log.text}</p>
              </div>
            </div>
          ))}
          {aiLogs.length === 0 && <p className="text-[7px] text-gray-800 font-mono">STANDBY</p>}
        </div>
      </div>
    </div>
  );
});

const AIActivityPanel = memo(function AIActivityPanel() {
  const aiLogs = useAIOSStore(s => s.aiLogs);
  return (
    <div className="avl-glass avl-top-accent relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/25 to-transparent"/>
      <div className="px-3 py-2.5">
        <p className="text-[8px] text-purple-400/60 font-mono tracking-[0.2em] mb-2.5 flex items-center gap-1.5">
          <Activity size={8}/> AI ACTIVITY
        </p>
        <div className="space-y-1.5 max-h-44 overflow-y-auto">
          {aiLogs.length===0 && <p className="text-[7.5px] text-gray-800 font-mono text-center py-2">NO ACTIVITY</p>}
          {[...aiLogs].reverse().slice(0,20).map(log => (
            <div key={log.id} className="flex items-start gap-2 avl-slide-in">
              <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 mt-1",
                log.type==="signal"?"bg-cyan-400":log.type==="order"?"bg-orange-400":
                log.type==="ok"?"bg-green-500":log.type==="warn"?"bg-yellow-500":
                log.type==="ai"?"bg-purple-400":"bg-gray-700"
              )}/>
              <div>
                <span className="text-[7px] text-gray-700 font-mono tabular-nums">
                  {new Date(log.ts).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
                </span>
                <p className="text-[7.5px] text-gray-500 font-mono leading-snug">{log.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

// =================================================================
// Voice Telop — AI speaking subtitle
// =================================================================
const VoiceTelop = memo(function VoiceTelop({
  text, status, neonHex,
}: { text: string; status: string; neonHex: string }) {
  const [displayed, setDisplayed] = useState("");
  const [visible,   setVisible]   = useState(false);
  const idxRef  = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!text) {
      // Fade out when text clears
      const t = setTimeout(() => { setVisible(false); setDisplayed(""); }, 600);
      return () => clearTimeout(t);
    }
    // New text: reset and typewrite character by character
    setVisible(true);
    setDisplayed("");
    idxRef.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);

    const MAX_DISPLAY = 80; // characters to show at once (scrolling window)
    const tick = () => {
      if (idxRef.current >= text.length) return;
      idxRef.current++;
      const slice = text.slice(Math.max(0, idxRef.current - MAX_DISPLAY), idxRef.current);
      setDisplayed(slice);
      timerRef.current = setTimeout(tick, 28); // ~35 chars/sec ≈ natural speech pace
    };
    timerRef.current = setTimeout(tick, 40);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [text]);

  const isSpeaking = status === "speaking" || status === "processing";

  return (
    <div
      className="flex items-center justify-center px-6 transition-all duration-500"
      style={{ minHeight: 36, opacity: visible ? 1 : 0 }}
    >
      {visible && (
        <p
          className="text-[9px] font-mono text-center leading-relaxed tracking-wide"
          style={{
            color: neonHex,
            textShadow: `0 0 10px ${neonHex}70, 0 0 20px ${neonHex}30`,
            maxWidth: 340,
          }}
        >
          {displayed}
          {isSpeaking && (
            <span
              className="inline-block w-[6px] h-[9px] ml-0.5 align-middle rounded-sm"
              style={{
                backgroundColor: neonHex,
                opacity: 0.9,
                animation: "avl-wave-bar 0.5s ease-in-out infinite alternate",
              }}
            />
          )}
        </p>
      )}
    </div>
  );
});

// =================================================================
// メインコンポーネント
// =================================================================
export function DashboardOS() {
  const { status, connectedAt } = useConnectionStore();
  const { activeSymbol, watchlist, setActiveSymbol } = usePriceStore();
  const { indicators, setIndicators, setIndicatorsBatch } = useIndicatorStore();
  const { setSymbols, setOrders, symbolList } = useMarketStore();
  // Use selectors — prevent re-render when unrelated store fields (aiLogs) change
  const mode         = useAIOSStore(s => s.mode);
  const agents       = useAIOSStore(s => s.agents);
  const setMode      = useAIOSStore(s => s.setMode);
  const setAgentStatus = useAIOSStore(s => s.setAgentStatus);
  const addLog       = useAIOSStore(s => s.addLog);
  // aiLogs NOT subscribed here — rendered by isolated memo components below
  const { settings: osSettings } = useSettingsStore();

  const [messages, setMessages]     = useState<Message[]>([{
    id:"boot",role:"system",content:"AVL AI TRADING OS v3.0 起動完了\nシステム初期化... ALL SYSTEMS ONLINE",ts:Date.now()
  }]);
  const [input, setInput]           = useState("");
  const [thinking, setThinking]     = useState(false);  // text chat AI only
  const [voiceThinking, setVoiceThinking] = useState(false); // voice AI only
  const [error, setError]           = useState<string|null>(null);
  const [orderProposal, setOrderProposal] = useState<OrderProposal|null>(null);
  const [positions, setPositions]   = useState<MarketPosition[]>([]);
  const [account, setAccount]       = useState<MarketAccount|null>(null);
  const [time, setTime]             = useState(new Date());
  const [showChat, setShowChat]     = useState(false);
  const [extQuotes, setExtQuotes]   = useState<ExtQuote[]>([]);

  const scrollRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLTextAreaElement>(null);
  const isConnected = status === "connected";
  const symInd      = indicators[activeSymbol.toUpperCase()];

  // Stable callback refs — prevent useRealtimeAgent from re-subscribing on every render
  const voiceCallbacks = useRef({
    onTranscript: (text: string, role: "user" | "assistant") => {
      setMessages(prev => [...prev, { id: `v_${Date.now()}`, role, content: text, ts: Date.now() }]);
    },
    onOrderProposal: (p: Parameters<typeof setOrderProposal>[0]) => {
      setOrderProposal(p);
    },
    onAgentThinking: (t: boolean) => setVoiceThinking(t),
  });

  // Voice Agent (useRealtimeAgent)
  const voice = useRealtimeAgent(voiceCallbacks.current);

  // Monitor フック
  const monitor = useMonitor();

  // Multi-Agent パイプライン
  const pipeline = useAgentPipeline();

  // 外部市場データ取得（Twelve Data / デモ）
  useEffect(() => {
    const SYMBOLS = "DXY,US30/USD,XAU/USD,VIX,JP225/USD,US100/USD";
    const key     = osSettings.twelveDataKey;
    const url     = `/api/market/external?symbols=${encodeURIComponent(SYMBOLS)}${key ? `&key=${key}` : ""}`;
    const fetch_  = async () => {
      try {
        const res  = await fetch(url);
        const json = await res.json() as { data: ExtQuote[] };
        setExtQuotes(json.data ?? []);
      } catch {}
    };
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, [osSettings.twelveDataKey]);

  // 時計
  useEffect(() => { const id = setInterval(()=>setTime(new Date()),1000); return ()=>clearInterval(id); }, []);

  // /api/mt5/live プロキシ経由でポーリング（CORS回避）
  useEffect(() => {
    const fetchLive = async () => {
      try {
        const res = await fetch("/api/mt5/live");
        if (!res.ok) return;
        const data = await res.json() as {
          symbols: Array<{
            symbol: string; bid: number; ask: number; spread: number;
            digits?: number; point?: number; changePct?: number;
            contractSize?: number; tickValue?: number; tickSize?: number;
            high52?: number; low52?: number; prevClose?: number; time?: number;
          }>;
          account: unknown;
          indicators: Array<{ symbol: string; [k: string]: unknown }>;
        };

        if (Array.isArray(data.symbols) && data.symbols.length > 0) {
          setSymbols(data.symbols.map(s => ({
            symbol:       s.symbol,
            bid:          s.bid ?? 0,
            ask:          s.ask ?? 0,
            spread:       s.spread ?? 0,
            changePct:    s.changePct ?? 0,
            digits:       s.digits ?? 5,
            point:        s.point ?? 0.00001,
            contractSize: s.contractSize ?? 100000,
            tickValue:    s.tickValue ?? 0,
            tickSize:     s.tickSize ?? 0,
            high52:       s.high52 ?? 0,
            low52:        s.low52 ?? 0,
            prevClose:    s.prevClose ?? 0,
            time:         s.time ?? 0,
          })));
        }

        if (data.account) setAccount(data.account as Parameters<typeof setAccount>[0]);

        if (Array.isArray(data.indicators) && data.indicators.length > 0) {
          // Single batch write — avoids N re-renders for N symbols
          setIndicatorsBatch(
            data.indicators.filter(ind => !!ind.symbol) as unknown as Parameters<typeof setIndicatorsBatch>[0]
          );
        }
      } catch {}
    };

    fetchLive();
    const id = setInterval(fetchLive, 10000); // 10s is enough; WS provides real-time updates
    return () => clearInterval(id);
  }, [setSymbols, setIndicatorsBatch]);

  // スクロール
  useEffect(() => { scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:"smooth"}); }, [messages]);

  // WebSocket サブスクリプション
  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;

    // Throttle indicator store writes: accumulate WS messages, flush as a single batch every 300ms
    let pendingIndicators: Parameters<typeof setIndicators>[0][] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushIndicators = () => {
      if (pendingIndicators.length === 0) return;
      setIndicatorsBatch(pendingIndicators);
      pendingIndicators = [];
      flushTimer = null;
    };

    const unsubs = [
      client.onIndicators((ind) => {
        pendingIndicators.push(ind);
        if (!flushTimer) flushTimer = setTimeout(flushIndicators, 300);
      }),
      client.onPosition((pos) => { setPositions(pos); }),
      client.onAccount((acc)  => { setAccount(acc); }),
      client.onSymbols((syms) => {
        setSymbols(syms);
        setAgentStatus("market", "active", `Market Watch ${syms.length}シンボル受信`);
      }),
      client.onOrders((orders) => {
        setOrders(orders);
      }),
    ];
    addLog("MT5 データストリーム接続完了", "ok");
    setAgentStatus("market", "active", "データ受信中");
    return () => {
      unsubs.forEach(u=>u());
      if (flushTimer) clearTimeout(flushTimer);
      setAgentStatus("market","idle");
    };
  }, [status, setIndicators, setIndicatorsBatch, addLog, setAgentStatus]);

  useEffect(() => {
    if (status==="connected") { addLog("MT5 Gateway 接続完了","ok"); }
    else if (status==="disconnected") { addLog("MT5 Gateway 切断","warn"); setAgentStatus("market","idle"); }
  }, [status, addLog, setAgentStatus]);

  // パイプライン結果 → OrderProposal 変換
  useEffect(() => {
    if (!pipeline.result?.decision) return;
    const d = pipeline.result.decision;
    if (d.decision === "HOLD") {
      setMessages(prev => [...prev, {
        id: `pipe_${Date.now()}`, role: "assistant",
        content: `[3-Agent 分析完了] HOLD — ${d.reason} (confidence: ${d.confidence}%)`,
        ts: Date.now(),
      }]);
      return;
    }
    setOrderProposal({
      direction:  d.decision as "BUY"|"SELL",
      symbol:     pipeline.result.symbol,
      entry:      d.entry,
      sl:         d.sl,
      tp:         d.tp,
      rr:         d.rr,
      confidence: d.confidence,
      reason:     d.reason,
    });
    setShowChat(true);
    setMessages(prev => [...prev, {
      id: `pipe_${Date.now()}`, role: "assistant",
      content: `[MarketAgent→AnalysisAgent→DecisionAgent]\n${d.reason}\n\nConfidence: ${d.confidence}%\n${d.warnings?.join(", ") ?? ""}`,
      ts: Date.now(),
    }]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.result]);

  // AI 送信
  const sendMessage = useCallback(async (userText: string) => {
    if (!userText.trim() || thinking) return;
    setError(null);
    setOrderProposal(null);
    setShowChat(true);

    const userMsg: Message = { id:`u_${Date.now()}`, role:"user", content:userText.trim(), ts:Date.now() };
    const aid = `a_${Date.now()}`;
    const assistantMsg: Message = { id:aid, role:"assistant", content:"", ts:Date.now() };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput("");
    setThinking(true);
    setAgentStatus("analysis","thinking","分析中...");
    addLog(`[AI] "${userText.slice(0,30)}..." → 分析開始`, "ai");

    const sym = activeSymbol; // 常に選択中のインストゥルメントを使用
    const history = messages.filter(m=>m.role!=="system").slice(-8).map(m=>({role:m.role as "user"|"assistant",content:m.content}));

    try {
      const res = await fetch("/api/ai/chat", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ messages:[...history,{role:"user",content:userText}], symbol:sym }),
      });
      if (!res.ok || !res.body) throw new Error(`AI API エラー: ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = "";
      let   full    = "";

      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        buf += decoder.decode(value,{stream:true});
        const lines = buf.split("\n"); buf = lines.pop()??"";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const d = line.slice(6).trim();
          if (d==="[DONE]") break;
          try {
            const {delta} = JSON.parse(d) as {delta:string};
            full += delta;
            setMessages(prev => prev.map(m => m.id===aid ? {...m,content:full} : m));
          } catch {}
        }
      }

      const proposal = parseOrder(full);
      if (proposal) {
        setOrderProposal(proposal);
        setAgentStatus("decision","active",`${proposal.direction} ${proposal.symbol} 提案`);
        addLog(`[SIGNAL] ${proposal.direction} ${proposal.symbol} Entry:${proposal.entry}`, "signal", proposal.symbol);
      }
      setAgentStatus("analysis","idle","分析完了");
      addLog("[AI] 分析レポート生成完了", "ai");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMessages(prev => prev.filter(m=>m.id!==aid));
      addLog(`[ERR] ${msg}`, "warn");
      setAgentStatus("analysis","error",msg);
    } finally {
      setThinking(false);
    }
  }, [thinking, messages, activeSymbol, addLog, setAgentStatus]);

  // 注文実行
  const executeOrder = useCallback(async (p: OrderProposal) => {
    addLog(`[ORDER] ${p.direction} ${p.symbol} @ ${p.entry} — 送信中`, "order");
    setAgentStatus("order","thinking","注文送信中...");
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL}/orders/pending`,{
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ type:p.direction, symbol:p.symbol, entry:p.entry, sl:p.sl, tp:p.tp, volume:0.01, source:"AVL_AI" }),
      });
      if (res.ok) {
        addLog(`[ORDER] ✓ ${p.direction} ${p.symbol} 注文送信完了`, "ok");
        setAgentStatus("order","idle","注文完了");
      } else {
        addLog(`[ORDER] 送信失敗: ${res.status}`, "warn");
        setAgentStatus("order","error","注文失敗");
      }
    } catch {
      addLog("[ORDER] Gateway 送信エラー", "warn");
      setAgentStatus("order","error");
    }
    setOrderProposal(null);
  }, [addLog, setAgentStatus]);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); sendMessage(input); };
  const handleKey    = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key==="Enter"&&!e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  // モード別ネオンカラー
  const modeNeon: Record<AIMode,{hex:string;label:string}> = {
    analysis:   { hex:"#00e5ff", label:"ANALYSIS MODE"   },
    monitor:    { hex:"#ffd700", label:"MONITOR MODE"    },
    assisted:   { hex:"#00ff88", label:"ASSISTED MODE"   },
    autonomous: { hex:"#ff1a4e", label:"AUTONOMOUS MODE" },
  };
  const { hex: neonHex, label: modeLabel2 } = modeNeon[mode];
  const isVoiceActive = voice.status !== "idle";
  const isActive      = thinking || voiceThinking || isVoiceActive;

  const aiStatusText =
    thinking        ? "THINKING..."   :
    voice.status === "listening"  ? "LISTENING..."  :
    voice.status === "speaking"   ? "RESPONDING..." :
    voice.status === "connecting" ? "CONNECTING..." :
    isConnected     ? "STANDBY"     : "OFFLINE";

  // =================================================================
  // レンダリング — JARVIS Style v4.0
  // =================================================================
  return (
    <div className="flex flex-col h-full overflow-hidden relative" style={{background:"radial-gradient(ellipse at 50% 0%, #020c1a 0%, #030508 60%, #020408 100%)"}}>
      {/* Multi-layer animated background */}
      <div className="absolute inset-0 avl-grid-fine opacity-100 pointer-events-none z-0"/>
      <div className="absolute inset-0 avl-scanlines pointer-events-none z-0"/>
      {/* Radial ambient glow at center */}
      <div className="absolute inset-0 pointer-events-none z-0" style={{background:"radial-gradient(ellipse 60% 40% at 50% 45%, rgba(0,180,255,0.04) 0%, transparent 70%)"}}/>
      {/* Animated scanning line */}
      <div className="absolute left-0 right-0 h-px pointer-events-none z-0 avl-scan-line" style={{background:"linear-gradient(to right, transparent, rgba(0,200,255,0.15), transparent)"}} />

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          TOP STATUS BAR
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div className="relative z-10 h-11 shrink-0 flex items-center px-5 gap-6 bg-[#05070A] border-b border-cyan-900/25">
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent"/>

        {/* Brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex gap-0.5">
            <div className="w-0.5 h-5 bg-cyan-400" style={{boxShadow:"0 0 6px #00e5ff"}}/>
            <div className="w-0.5 h-5 bg-cyan-400/30"/>
          </div>
          <div>
            <p className="text-[11px] font-black font-mono tracking-[0.2em]" style={{color:"#00e5ff",textShadow:"0 0 12px #00e5ff88"}}>AVL AI</p>
            <p className="text-[7px] font-mono tracking-[0.15em] text-gray-600 -mt-0.5">OPERATING SYSTEM</p>
          </div>
        </div>

        <div className="w-px h-5 bg-cyan-900/40"/>

        {/* Status indicators */}
        {[
          { dot:isConnected?"bg-green-400":"bg-gray-700", glow:isConnected?"0 0 6px #22c55e":"none", label:"MT5 LIVE",          active:isConnected },
          { dot:"bg-green-400", glow:"0 0 6px #22c55e",  label:"GATEWAY CONNECTED",  active:isConnected },
          { dot:`${isActive?"bg-cyan-400 animate-pulse":"bg-gray-600"}`, glow:isActive?"0 0 6px #00e5ff":"none", label:"AI ONLINE", active:true },
          { dot:isVoiceActive?"bg-purple-400 animate-pulse":"bg-gray-700", glow:isVoiceActive?"0 0 6px #a855f7":"none", label:"VOICE ACTIVE", active:isVoiceActive },
        ].map(({ dot, glow, label, active }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className={cn("w-2 h-2 rounded-full", dot)} style={{boxShadow:glow}}/>
            <span className={cn("text-[9px] font-mono tracking-wider", active ? "text-gray-200" : "text-gray-600")}>{label}</span>
          </div>
        ))}

        <div className="flex-1"/>

        {/* Sessions */}
        {symInd?.sessions && symInd.sessions.length > 0 && (
          <div className="flex gap-1.5 items-center">
            {symInd.sessions.map(s => (
              <span key={s} className={cn("text-[7px] font-mono border px-2 py-0.5 tracking-wider",
                s.includes("Tokyo")  ? "border-blue-700/50 text-blue-300 bg-blue-950/20" :
                s.includes("London") ? "border-purple-700/50 text-purple-300 bg-purple-950/20" :
                s.includes("York")   ? "border-orange-700/50 text-orange-300 bg-orange-950/20" :
                "border-gray-700/40 text-gray-500"
              )}>{s.replace(" Session","")}</span>
            ))}
          </div>
        )}

        {/* Time */}
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className="text-gray-100 tabular-nums font-semibold" suppressHydrationWarning>
            {time.toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
          </span>
          <span className="text-gray-600">JST</span>
          <span className="text-gray-500 tabular-nums" suppressHydrationWarning>
            {time.toLocaleDateString("en-US",{year:"numeric",month:"2-digit",day:"2-digit"})}
          </span>
        </div>
      </div>

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          MAIN CONTENT — 3 COLUMN LAYOUT
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div className="flex flex-1 overflow-hidden z-10 relative">

        {/* ╔══════════════════════════════╗
            ║  LEFT PANEL                  ║
            ╚══════════════════════════════╝ */}
        <div className="w-[262px] shrink-0 flex flex-col border-r border-cyan-900/20 overflow-hidden avl-stream">
          <div className="flex-1 overflow-y-auto avl-scroll p-3 space-y-3">

            {/* Account Overview */}
            <div className="avl-glass avl-top-accent relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent"/>
              <div className="px-3 pt-3 pb-2">
                <p className="text-[8px] text-cyan-400/60 font-mono tracking-[0.2em] mb-3 flex items-center gap-1.5">
                  <Activity size={8}/> ACCOUNT OVERVIEW
                </p>
                {account ? (
                  <div className="space-y-1.5">
                    {[
                      { label:"BALANCE",        value:`${account.balance.toLocaleString()} ${account.currency}`, col:"text-gray-100" },
                      { label:"EQUITY",         value:`${account.equity.toLocaleString()} ${account.currency}`,  col:account.equity>=account.balance?"text-green-400":"text-red-400" },
                      { label:"UNREALIZED P&L", value:`${(account.equity-account.balance)>=0?"+":""}${(account.equity-account.balance).toFixed(2)} ${account.currency} (${((account.equity-account.balance)/Math.max(1,account.balance)*100).toFixed(2)}%)`,
                        col:(account.equity-account.balance)>=0?"text-green-400":"text-red-400" },
                    ].map(({label,value,col})=>(
                      <div key={label} className="flex justify-between items-baseline">
                        <span className="text-[8px] text-gray-600 font-mono">{label}</span>
                        <span className={cn("text-[9px] font-mono font-semibold tabular-nums",col)}>{value}</span>
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {[
                        {label:"FREE MARGIN",value:`${account.freeMargin.toFixed(0)} ${account.currency}`},
                        {label:"MARGIN LEVEL",value:account.marginLevel>0?`${account.marginLevel.toFixed(2)}%`:"0.00%"},
                        {label:"LEVERAGE",value:`1:${account.leverage}`},
                        {label:"BROKER",value:account.broker.slice(0,8)},
                      ].map(({label,value})=>(
                        <div key={label} className="border border-cyan-900/15 px-2 py-1.5">
                          <p className="text-[7px] text-gray-700 font-mono">{label}</p>
                          <p className="text-[9px] text-gray-300 font-mono tabular-nums">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-[9px] text-gray-700 font-mono py-2">MT5 未接続</p>
                )}
              </div>

              {/* Equity Curve */}
              {account && (
                <div className="border-t border-cyan-900/15 px-3 py-2">
                  <p className="text-[7.5px] text-cyan-400/50 font-mono tracking-[0.2em] mb-1.5">EQUITY CURVE</p>
                  <Sparkline data={[account.equity * 0.97, account.equity * 0.99, account.equity * 0.98, account.equity * 1.0, account.equity].filter(Boolean)} color="#00e5ff" height={28}/>
                </div>
              )}
            </div>

            {/* ── CURRENT INSTRUMENT ── */}
            <CurrentInstrumentPanel
              activeSymbol={activeSymbol}
              symbolList={symbolList}
              indicators={indicators}
              onSelect={setActiveSymbol}
            />

            {/* System Log */}
            <SystemLogPanel />

          </div>
        </div>

        {/* ╔══════════════════════════════════════════╗
            ║  CENTER PANEL — AI OPERATIONS            ║
            ╚══════════════════════════════════════════╝ */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Header: Title + Mode + Agent Cards */}
          <div className="relative shrink-0 border-b border-cyan-900/20 px-4 py-2.5 bg-[#05070A]">
            <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent"/>
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-3">
                <div className="flex gap-0.5">
                  <div className="w-0.5 h-5 bg-cyan-400/80" style={{boxShadow:"0 0 4px #00e5ff"}}/>
                  <div className="w-0.5 h-5 bg-cyan-400/20"/>
                </div>
                <span className="text-[9.5px] font-mono tracking-[0.2em] text-cyan-400/80 font-semibold">AI OPERATIONS CENTER</span>
                <span className={cn("text-[7px] font-mono border px-2 py-0.5 tracking-wider",
                  isConnected ? "border-green-600/40 text-green-400/80 bg-green-950/15" : "border-red-800/40 text-red-500/60"
                )}>● {isConnected?"ONLINE":"OFFLINE"}</span>
              </div>
              <ModeSelector mode={mode} onChange={setMode} />
            </div>

            {/* Agent Cards */}
            <div className="flex gap-1.5 items-stretch">
              {agents.map(agent => <AgentCard key={agent.id} agent={agent}/>)}
              <button onClick={() => pipeline.run()} disabled={pipeline.running||!isConnected}
                className={cn("ml-auto px-4 text-[7.5px] font-mono border flex items-center gap-1.5 transition-all shrink-0 tracking-wider",
                  pipeline.running ? "border-purple-700/50 text-purple-300 bg-purple-950/20 cursor-wait"
                    : isConnected   ? "border-cyan-700/40 text-cyan-400 bg-cyan-950/20 hover:bg-cyan-900/30 hover:border-cyan-600/50"
                    : "border-gray-800/40 text-gray-700 cursor-not-allowed"
                )}>
                <Brain size={8} className={pipeline.running?"animate-pulse":""}/>
                {pipeline.running ? "ANALYZING..." : "3-AGENT ANALYSIS"}
              </button>
            </div>
          </div>

          {/* ── ANALYSIS ENGINE (mode=analysis) ── */}
          {mode === "analysis" && (
            <div className="flex-1 overflow-hidden min-w-0">
              <AnalysisEngine activeSymbol={activeSymbol}/>
            </div>
          )}

          {/* ── ONE CONTINUOUS IMMERSIVE AI CANVAS ── */}
          {/* Particles + mic all on the same plane, no separators */}
          <div className={cn("flex-1 relative overflow-hidden min-w-0", mode === "analysis" && "hidden")}>


            {/* ░░ LAYER 0 — particle background ░░ */}
            <div className="absolute inset-0 z-0">
              <HolographicAICore mode={mode} isActive={isActive} isThinking={thinking || voiceThinking} voiceStatus={voice.status}/>
            </div>

            {/* ░░ LAYER 5 — torus ring ░░ */}
            <div className="absolute inset-0 z-[5] pointer-events-none">
              <ParticleTorus voiceStatus={voice.status} isThinking={thinking || voiceThinking} />
            </div>

            {/* ░░ LAYER 10 — AVL AI text, always centered ░░ */}
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
              <p className="font-black font-mono tracking-[0.55em] select-none"
                style={{fontSize:30, color:"#ffffff",
                  textShadow:"0 0 12px #ffffff, 0 0 30px #ffffff99, 0 0 60px #aaddff66, 0 0 100px #88bbff33"}}>
                AVL AI
              </p>
            </div>

            {/* ░░ LAYER 10 — HUD corner brackets ░░ */}
            {["top-3 left-3 border-t-2 border-l-2","top-3 right-3 border-t-2 border-r-2",
              "bottom-3 left-3 border-b-2 border-l-2","bottom-3 right-3 border-b-2 border-r-2"
            ].map((cls,i) => (
              <div key={i} className={`absolute w-5 h-5 pointer-events-none z-10 ${cls}`}
                style={{borderColor:`${neonHex}50`}}/>
            ))}

            {/* ░░ LAYER 20 — signal notification (floats above mic) ░░ */}
            {monitor.signals.length > 0 && (
              <div className="absolute left-0 right-0 z-20 flex justify-center" style={{bottom:"33%"}}>
                <div className="flex items-center gap-2 px-3 py-1.5 border"
                  style={{borderColor:`${neonHex}40`, backgroundColor:`${neonHex}08`}}>
                  <Bell size={9} style={{color:neonHex}} className="animate-pulse"/>
                  <span className="text-[8px] font-mono tracking-wider" style={{color:neonHex}}>
                    {monitor.signals[monitor.signals.length-1]?.message}
                  </span>
                </div>
              </div>
            )}

            {/* ░░ LAYER 20 — order proposal card (floats above mic) ░░ */}
            {orderProposal && (
              <div className="absolute left-0 right-0 z-20 px-4" style={{bottom:"28%"}}>
                <OrderCard p={orderProposal}
                  onConfirm={()=>executeOrder(orderProposal)}
                  onCancel={()=>{setOrderProposal(null);addLog("[ORDER] キャンセル","info");}}
                />
              </div>
            )}

            {/* ░░ LAYER 20 — AI status bar (waveform + mode text) ░░ */}
            <div className="absolute left-0 right-0 z-20 flex items-center gap-4 px-5 py-2" style={{bottom:"23%"}}>
              <div className="flex items-end gap-0.5 h-5 overflow-hidden">
                {[3,5,8,12,16,20,16,12,8,5,3,6,10,15,10,6].map((h,i) => (
                  <div key={i} className="w-0.5 rounded-full"
                    style={{
                      height: Math.min(h, 20),
                      backgroundColor: neonHex,
                      opacity: isActive ? 0.7 : 0.18,
                      boxShadow: isActive ? `0 0 3px ${neonHex}` : "none",
                      animation: `avl-wave-bar ${0.6+i*0.06}s ease-in-out ${i*0.06}s infinite alternate`,
                      animationPlayState: isActive ? "running" : "paused",
                      transformOrigin: "bottom",
                      transition: "opacity 0.4s ease",
                      willChange: "transform",
                    }}/>
                ))}
              </div>
              <p className="text-[11px] font-mono tracking-[0.2em] font-semibold"
                style={{color:neonHex, textShadow:`0 0 8px ${neonHex}88`}}>{aiStatusText}</p>
              <button onClick={()=>{setMessages([{id:"r",role:"system",content:"RESET",ts:Date.now()}]);setOrderProposal(null);setError(null);}}
                className="ml-auto text-gray-700 hover:text-gray-400 transition-colors p-1">
                <RefreshCw size={11}/>
              </button>
            </div>

            {/* ░░ LAYER 30 — holographic mic floating at bottom ░░ */}
            <div className="absolute bottom-0 left-0 right-0 z-30 flex flex-col items-center pb-5 gap-2">

              {/* Concentric ring mic button */}
              <div className="relative flex items-center justify-center" style={{width:96,height:96,contain:'layout style'}}>

                {/* Listening: ambient pulse ring — always rendered, opacity-controlled */}
                <div className="absolute rounded-full pointer-events-none"
                  style={{
                    width:140, height:140, left:-22, top:-22,
                    border:`1px solid ${neonHex}55`,
                    boxShadow:`0 0 30px ${neonHex}22, 0 0 60px ${neonHex}11`,
                    animation:"avl-ping-outer 2s ease-out infinite",
                    animationPlayState: voice.status === "listening" ? "running" : "paused",
                    opacity: voice.status === "listening" ? 1 : 0,
                    transition:"opacity 0.3s ease",
                    willChange:"transform,opacity",
                  }}/>

                {/* Thinking: inner convergence glow — always rendered */}
                <div className="absolute rounded-full pointer-events-none"
                  style={{
                    width:120, height:120, left:-12, top:-12,
                    background:`radial-gradient(circle, ${neonHex}18 0%, transparent 70%)`,
                    animation:"avl-pulse-ring-out 1.8s ease-out infinite",
                    animationPlayState: (thinking || voiceThinking) ? "running" : "paused",
                    opacity: (thinking || voiceThinking) ? 1 : 0,
                    transition:"opacity 0.3s ease",
                    willChange:"transform,opacity",
                  }}/>

                {/* Speaking: outward energy waves — always rendered */}
                {[0,1,2].map(i => (
                  <div key={i} className="absolute rounded-full pointer-events-none"
                    style={{
                      width:48+i*36, height:48+i*36,
                      left:-(i*18+4), top:-(i*18+4),
                      border:`1px solid ${neonHex}${["55","33","18"][i]}`,
                      animation:`avl-pulse-ring-out ${1.4+i*0.5}s ease-out ${i*0.4}s infinite`,
                      animationPlayState: voice.status === "speaking" ? "running" : "paused",
                      opacity: voice.status === "speaking" ? 1 : 0,
                      transition:"opacity 0.3s ease",
                      willChange:"transform,opacity",
                    }}/>
                ))}

                {/* Voice active ping — always rendered */}
                <div className="absolute inset-0 rounded-full"
                  style={{
                    border:`1px solid ${neonHex}`,
                    animation:"ping 1s cubic-bezier(0,0,0.2,1) infinite",
                    animationPlayState: isVoiceActive ? "running" : "paused",
                    opacity: isVoiceActive ? 0.2 : 0,
                    transition:"opacity 0.3s ease",
                    willChange:"transform,opacity",
                  }}/>

                {/* Ring 3 */}
                <div className="absolute w-24 h-24 rounded-full transition-all duration-500"
                  style={{border:`1px solid ${isVoiceActive ? neonHex+'35' : '#1a2a35'}`,
                          boxShadow: isVoiceActive ? `0 0 18px ${neonHex}18` : 'none'}}/>

                {/* Ring 2 + cardinal dots */}
                <div className="absolute w-[70px] h-[70px] rounded-full transition-all duration-500"
                  style={{border:`1px solid ${isVoiceActive ? neonHex+'55' : '#1e303d'}`,
                          boxShadow: isVoiceActive ? `0 0 14px ${neonHex}28` : 'none'}}>
                  {[
                    'absolute top-0    left-1/2 -translate-x-1/2 -translate-y-1/2',
                    'absolute bottom-0 left-1/2 -translate-x-1/2  translate-y-1/2',
                    'absolute right-0  top-1/2   translate-x-1/2 -translate-y-1/2',
                    'absolute left-0   top-1/2  -translate-x-1/2 -translate-y-1/2',
                  ].map((cls,i) => (
                    <div key={i} className={`${cls} w-1.5 h-1.5 rounded-full transition-all duration-500`}
                      style={{backgroundColor: isVoiceActive ? neonHex : '#1e3a4a',
                              boxShadow:       isVoiceActive ? `0 0 6px ${neonHex}` : 'none'}}/>
                  ))}
                </div>

                {/* Ring 1 */}
                <div className="absolute w-[50px] h-[50px] rounded-full transition-all duration-500"
                  style={{border:`1px solid ${isVoiceActive ? neonHex+'75' : '#1e303d'}`,
                          boxShadow: isVoiceActive ? `0 0 10px ${neonHex}38` : 'none'}}/>

                {/* Button core */}
                <button type="button" disabled={voice.status === "connecting"}
                  onClick={() => voice.status==="idle" ? voice.start(activeSymbol) : voice.stop()}
                  className="relative z-10 w-10 h-10 rounded-full flex items-center justify-center transition-all duration-500 disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{
                    background: isVoiceActive
                      ? `radial-gradient(circle, ${neonHex}30 0%, ${neonHex}08 70%)`
                      : 'radial-gradient(circle, rgba(0,70,110,0.45) 0%, rgba(0,25,50,0.2) 70%)',
                    border: `2px solid ${isVoiceActive ? neonHex : neonHex+'30'}`,
                    boxShadow: isVoiceActive
                      ? `0 0 22px ${neonHex}55, 0 0 44px ${neonHex}18, inset 0 0 14px ${neonHex}12`
                      : `0 0 8px ${neonHex}18`,
                  }}>
                  <Mic size={17}
                    style={{color: isVoiceActive ? neonHex : `${neonHex}60`}}
                    className={isVoiceActive ? 'animate-pulse' : ''}/>
                </button>
              </div>

              {/* Voice status + wave bars */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[8px] font-mono tracking-[0.35em] transition-all duration-300"
                  style={{color: isVoiceActive ? neonHex : '#2a3a4a',
                          textShadow: isVoiceActive ? `0 0 8px ${neonHex}60` : 'none'}}>
                  {isVoiceActive ? aiStatusText : 'VOICE STANDBY'}
                </span>
                {isVoiceActive && (
                  <div className="flex items-end gap-0.5 h-3">
                    {[2,4,6,9,6,4,2,4,6,4,2].map((h,i) => (
                      <div key={i} className="w-0.5 rounded-full"
                        style={{height:h,backgroundColor:neonHex,opacity:0.75,
                          animation:`avl-wave-bar 0.8s ease-in-out ${i*0.07}s infinite alternate`}}/>
                    ))}
                  </div>
                )}
                {isVoiceActive && voice.status !== 'idle' && (
                  <div className="flex items-center gap-3 mt-0.5">
                    {voice.muted && <span className="text-[7px] text-yellow-400 font-mono">MUTED</span>}
                    <button onClick={voice.interrupt}
                      className="text-[7px] text-gray-600 hover:text-red-400 font-mono transition-colors tracking-wider">
                      INTERRUPT
                    </button>
                  </div>
                )}
              </div>

              {/* AI Telop — speaking text subtitle */}
              <VoiceTelop text={voice.speakingText} status={voice.status} neonHex={neonHex} />
            </div>


          </div>{/* end immersive AI canvas */}
        </div>

        {/* ╔══════════════════════════════╗
            ║  RIGHT PANEL                  ║
            ╚══════════════════════════════╝ */}
        <div className="w-[276px] shrink-0 flex flex-col border-l border-cyan-900/20 overflow-hidden avl-stream">
          <div className="flex-1 overflow-y-auto avl-scroll p-3 space-y-3">

            {/* Global Markets */}
            {extQuotes.length > 0 && (
              <div className="avl-glass avl-top-accent relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-blue-500/25 to-transparent"/>
                <div className="px-3 py-2.5">
                  <p className="text-[8px] text-blue-400/60 font-mono tracking-[0.2em] mb-2.5 flex items-center gap-1.5">
                    <Globe size={8}/> GLOBAL MARKETS
                  </p>
                  <div className="space-y-1">
                    {extQuotes.filter(q => q?.symbol).map(q => {
                      const pos = q.changePct >= 0;
                      return (
                        <div key={q.symbol} className="flex items-center justify-between py-0.5 border-b border-cyan-900/10 last:border-0">
                          <span className="text-[8.5px] font-mono text-gray-400">{q.symbol.replace("/USD","").replace("/","")}</span>
                          <div className="flex items-center gap-2.5">
                            <span className="text-[9px] font-mono text-gray-100 tabular-nums">
                              {q.price>0 ? q.price.toFixed(q.price>100?1:4) : "—"}
                            </span>
                            {q.changePct!==0 && (
                              <span className={cn("text-[8px] font-mono tabular-nums w-14 text-right font-semibold",
                                pos?"text-green-400":"text-red-400")}>
                                {pos?"+":""}{q.changePct.toFixed(2)}%
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* AI Agents */}
            <div className="avl-glass avl-top-accent relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/25 to-transparent"/>
              <div className="px-3 py-2.5">
                <p className="text-[8px] text-cyan-400/60 font-mono tracking-[0.2em] mb-2.5 flex items-center gap-1.5">
                  <Brain size={8}/> AI AGENTS
                </p>
                <div className="space-y-1.5">
                  {agents.map(agent => {
                    const statusColors: Record<string,{bg:string;text:string;label:string}> = {
                      idle:     {bg:"#1a2535",    text:"#6b7280", label:"IDLE"     },
                      active:   {bg:"#052010",    text:"#22c55e", label:"ACTIVE"   },
                      thinking: {bg:"#051525",    text:"#00e5ff", label:"THINKING" },
                      error:    {bg:"#1a0510",    text:"#ef4444", label:"ERROR"    },
                    };
                    const sc = statusColors[agent.status] ?? statusColors.idle;
                    const icons: Record<string,typeof Brain> = {
                      market:Activity,analysis:Brain,decision:Zap,order:Shield,voice:Volume2
                    };
                    const Icon = icons[agent.id] ?? Brain;
                    return (
                      <div key={agent.id} className="flex items-center justify-between px-2 py-2 border border-cyan-900/15 transition-colors"
                        style={{backgroundColor:sc.bg+"88"}}>
                        <div className="flex items-center gap-2">
                          <Icon size={11} style={{color:sc.text}}/>
                          <div>
                            <p className="text-[8.5px] font-mono font-semibold text-gray-200">{agent.name}</p>
                            <p className="text-[7px] font-mono text-gray-600 truncate max-w-[110px]">
                              {agent.lastAction || agent.description}
                            </p>
                          </div>
                        </div>
                        <span className="text-[7.5px] font-mono font-bold tracking-wider shrink-0" style={{color:sc.text}}>
                          {agent.status === "thinking" ? "● " : agent.status === "active" ? "● " : "○ "}
                          {sc.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* AI Activity Log — isolated memo component */}
            <AIActivityPanel />

            {/* Risk Management */}
            <div className="avl-glass avl-top-accent relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-500/20 to-transparent"/>
              <div className="px-3 py-2.5">
                <p className="text-[8px] text-orange-400/60 font-mono tracking-[0.2em] mb-2.5 flex items-center gap-1.5">
                  <Shield size={8}/> RISK MANAGEMENT
                </p>
                <div className="space-y-1.5">
                  {[
                    {label:"RISK PER TRADE",   value:`${(osSettings.defaultLotSize*100).toFixed(0)}%`,          col:"text-cyan-400" },
                    {label:"DAILY LOSS LIMIT",  value:`${osSettings.maxDailyLossPct.toFixed(2)}%`,               col:"text-yellow-400"},
                    {label:"MAX POSITIONS",     value:`${osSettings.maxPositions}`,                               col:"text-gray-200"  },
                    {label:"AUTO STOP",         value:osSettings.stopOnLoss?"ON":"OFF",                           col:osSettings.stopOnLoss?"text-green-400":"text-gray-600"},
                  ].map(({label,value,col}) => (
                    <div key={label} className="flex items-center justify-between py-1 border-b border-cyan-900/10 last:border-0">
                      <span className="text-[7.5px] text-gray-600 font-mono">{label}</span>
                      <span className={cn("text-[9px] font-mono font-bold", col)}>{value}</span>
                    </div>
                  ))}
                </div>
                {/* Risk level indicator */}
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex justify-between text-[7px] font-mono mb-1">
                      <span className="text-gray-700">RISK LEVEL</span>
                      <span className="text-green-400">LOW</span>
                    </div>
                    <div className="h-1 bg-[#0d1520] w-full relative overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 transition-all"
                        style={{width:`${Math.min(100, osSettings.maxDailyLossPct * 10)}%`}}/>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Tech Indicators */}
            {symInd && (
              <div className="avl-glass avl-top-accent relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent"/>
                <div className="px-3 py-2.5">
                  <p className="text-[8px] text-cyan-400/60 font-mono tracking-[0.2em] mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5"><BarChart2 size={8}/>INDICATORS</span>
                    <span className="text-cyan-500/40">{activeSymbol}</span>
                  </p>
                  <div className="space-y-1">
                    {["H4","H1","M15","M5"].map(tf => {
                      const d = symInd.timeframes?.[tf];
                      if (!d) return null;
                      const up = d.ema21 > d.ema200;
                      return (
                        <div key={tf} className={cn("flex items-center justify-between px-2 py-1 border",
                          up?"border-green-900/30 bg-green-950/10":"border-red-900/30 bg-red-950/10"
                        )}>
                          <span className="text-[8px] font-mono text-cyan-500/60">[{tf}]</span>
                          <div className="flex items-center gap-1">
                            {up ? <TrendingUp size={9} className="text-green-400"/> : <TrendingDown size={9} className="text-red-400"/>}
                            <span className={cn("text-[8px] font-mono", up?"text-green-400":"text-red-400")}>
                              {up?"BULL":"BEAR"}
                            </span>
                          </div>
                          <span className="text-[7px] font-mono text-orange-400 tabular-nums">{d.atr.toFixed(4)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>


      {/* Order Proposal Modal */}
      {orderProposal && !showChat && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-50 backdrop-blur-sm">
          <OrderCard p={orderProposal}
            onConfirm={()=>executeOrder(orderProposal)}
            onCancel={()=>{setOrderProposal(null);addLog("[ORDER] キャンセル","info");}}
          />
        </div>
      )}
    </div>
  );
}

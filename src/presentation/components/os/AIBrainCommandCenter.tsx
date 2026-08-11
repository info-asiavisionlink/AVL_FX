"use client";

// =================================================================
// AIBrainCommandCenter — AVL AI BRAIN 統合コマンドセンター
//
// 構成:
//   Left  : AI State / Confidence / Scan Status / Brain Step
//   Center: BrainParticleCore (GPU 25K particles)
//   Right : [SCAN | OPP | FEED] タブパネル
//   Bottom: Reasoning Chain → Mic Area (slot)
//
// データフロー:
//   useBrainScanner → brainVisState → particleState / chainStage
//   useAIBrain      → brainStep     → chainStage / decision
//   voiceStatus     → particleState オーバーライド
// =================================================================

import { memo, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Brain, Play, Square, TrendingUp, TrendingDown, Minus,
  Activity, Shield, Zap, Clock, RefreshCw,
} from "lucide-react";

import { BrainParticleCore }    from "@/presentation/components/ai-brain/BrainParticleCore";
import { ReasoningChain }       from "@/presentation/components/ai-brain/ReasoningChain";
import type { ChainStage }      from "@/presentation/components/ai-brain/ReasoningChain";
import { MarketScannerDisplay } from "@/presentation/components/ai-brain/MarketScannerDisplay";
import { OpportunityRanker }    from "@/presentation/components/ai-brain/OpportunityRanker";
import { ActivityStream }       from "@/presentation/components/ai-brain/ActivityStream";
import type { ActivityEvent }   from "@/presentation/components/ai-brain/ActivityStream";
import type { RankedOpp }       from "@/presentation/components/ai-brain/OpportunityRanker";
import type { SymbolScanRow }   from "@/presentation/hooks/useBrainScanner";
import type { BrainStep }       from "@/presentation/hooks/useAIBrain";
import type { TradeProposal }   from "@/domain/trading/MarketSnapshot";

// ── State meta for badges / glow colors ───────────────────────────
const STATE_META: Record<string, { label: string; color: string; desc: string }> = {
  idle:          { label: "STANDBY",    color: "#2a3a4a",  desc: "Awaiting command"          },
  standby:       { label: "STANDBY",    color: "#2a3a4a",  desc: "Awaiting command"          },
  scanning:      { label: "SCANNING",   color: "#00e5ff",  desc: "Market structure analysis" },
  collecting:    { label: "COLLECTING", color: "#00bfff",  desc: "Data collection"           },
  analyzing:     { label: "ANALYZING",  color: "#a855f7",  desc: "Multi-TF correlation"      },
  complete_buy:  { label: "BUY",        color: "#00ff88",  desc: "Long opportunity detected" },
  complete_sell: { label: "SELL",       color: "#ff1a4e",  desc: "Short opportunity detected"},
  complete_wait: { label: "WAIT",       color: "#00e5ff",  desc: "No actionable setup"       },
  error:         { label: "ERROR",      color: "#ef4444",  desc: "Analysis failed"           },
  snapshot:      { label: "SNAPSHOT",   color: "#00bfff",  desc: "Market snapshot"           },
  decision:      { label: "DECIDING",   color: "#a855f7",  desc: "AI decision engine"        },
  risk:          { label: "RISK CHECK", color: "#f97316",  desc: "Risk validation"           },
  dryrun:        { label: "DRY RUN",    color: "#22c55e",  desc: "Trade simulation"          },
  complete:      { label: "COMPLETE",   color: "#22c55e",  desc: "Analysis complete"         },
  speaking:      { label: "SPEAKING",   color: "#7c3aed",  desc: "AI voice output"           },
  listening:     { label: "LISTENING",  color: "#2563eb",  desc: "Listening..."              },
};

// ── Reasoning chain stages (in order) ────────────────────────────
const ALL_STAGES: ChainStage[] = [
  "market_structure","dow_theory","multi_tf","momentum","oscillators",
  "correlation","fundamental","news","risk","decision",
];

// ── Right panel tab type ──────────────────────────────────────────
type RightTab = "scanner" | "ranker" | "feed";

// ── Props ─────────────────────────────────────────────────────────
interface Props {
  // Scanner (useBrainScanner)
  scanning:      boolean;
  brainVisState: string;
  scanRows:      SymbolScanRow[];
  currentSym:    string | null;
  opportunities: RankedOpp[];
  events:        ActivityEvent[];
  lastScanTs:    number | null;
  scanSymbols:   string[];
  onRunScan:     () => void;
  onStopScan:    () => void;

  // Single-symbol brain (useAIBrain)
  brainStep:     BrainStep;
  proposal:      TradeProposal | null;
  onRunBrain:    (sym?: string) => void;
  onResetBrain:  () => void;

  // Voice
  voiceStatus:   string;
  isActive:      boolean;

  // UI
  activeSymbol:  string;
  neonHex:       string;

  // Mic + voice controls slot (from DashboardOS scope)
  micArea:       React.ReactNode;
}

// =================================================================
// Main Component
// =================================================================
export const AIBrainCommandCenter = memo(function AIBrainCommandCenter({
  scanning, brainVisState, scanRows, currentSym, opportunities,
  events, lastScanTs, scanSymbols, onRunScan, onStopScan,
  brainStep, proposal, onRunBrain, onResetBrain,
  voiceStatus, isActive,
  activeSymbol, neonHex,
  micArea,
}: Props) {

  const [rightTab, setRightTab] = useState<RightTab>("scanner");

  // Auto-switch tabs based on scan state
  useEffect(() => {
    if (scanning) setRightTab("scanner");
  }, [scanning]);
  useEffect(() => {
    if (!scanning && opportunities.length > 0) setRightTab("ranker");
  }, [scanning, opportunities.length]);

  // ── Particle state derivation ────────────────────────────────
  const particleState = useMemo(() => {
    if (voiceStatus === "speaking")  return "speaking";
    if (voiceStatus === "listening") return "listening";

    // Scanner state (multi-symbol)
    const scanMap: Record<string, string> = {
      "scanning":    "scanning",
      "collecting":  "snapshot",
      "analyzing":   "decision",
      "complete_buy":  "complete_buy",
      "complete_sell": "complete_sell",
      "complete_wait": "complete_wait",
      "error":       "error",
    };
    if (scanMap[brainVisState]) return scanMap[brainVisState];

    // Single-symbol brain state
    if (brainStep !== "idle") {
      const brainMap: Record<string, string> = {
        "snapshot": "snapshot",
        "decision": "decision",
        "risk":     "risk",
        "dryrun":   "dryrun",
        "complete":
          proposal?.decision === "BUY"  ? "complete_buy"  :
          proposal?.decision === "SELL" ? "complete_sell" : "complete_wait",
        "error": "error",
      };
      return brainMap[brainStep] ?? "idle";
    }

    return "idle";
  }, [voiceStatus, brainVisState, brainStep, proposal]);

  // Simulated voice amplitude (real amplitude requires AudioAnalyser hook)
  const voiceAmp = voiceStatus === "speaking" ? 0.65 : voiceStatus === "listening" ? 0.35 : 0;

  // ── Reasoning chain stage derivation ────────────────────────
  const { activeChainStage, completedChainStages, chainRunning } = useMemo(() => {
    if (scanning) {
      const scanStageMap: Record<string, { active: ChainStage|null; done: number }> = {
        "scanning":    { active: "market_structure", done: 0 },
        "collecting":  { active: "dow_theory",       done: 1 },
        "analyzing":   { active: "multi_tf",         done: 2 },
      };
      if (scanStageMap[brainVisState]) {
        const { active, done } = scanStageMap[brainVisState];
        return { activeChainStage: active, completedChainStages: ALL_STAGES.slice(0, done), chainRunning: true };
      }
      if (brainVisState.startsWith("complete")) {
        return { activeChainStage: null, completedChainStages: ALL_STAGES, chainRunning: false };
      }
    }

    // Single-symbol brain
    const brainStageMap: Record<string, { active: ChainStage|null; done: number; running: boolean }> = {
      "snapshot": { active: "market_structure", done: 0,  running: true  },
      "decision": { active: "fundamental",      done: 4,  running: true  },
      "risk":     { active: "risk",             done: 8,  running: true  },
      "dryrun":   { active: "decision",         done: 9,  running: true  },
      "complete": { active: null,               done: 10, running: false },
    };
    if (brainStageMap[brainStep]) {
      const { active, done, running } = brainStageMap[brainStep];
      return { activeChainStage: active, completedChainStages: ALL_STAGES.slice(0, done), chainRunning: running };
    }

    return { activeChainStage: null, completedChainStages: [], chainRunning: false };
  }, [scanning, brainVisState, brainStep]);

  // ── Current state meta ────────────────────────────────────────
  const stateKey = voiceStatus === "speaking" ? "speaking" :
                   voiceStatus === "listening" ? "listening" :
                   brainVisState;
  const stateMeta = STATE_META[stateKey] ?? STATE_META.idle;

  // ── Derived values ────────────────────────────────────────────
  const bestOpp    = opportunities[0] ?? null;
  const actionable = opportunities.filter(o => o.direction !== "WAIT");
  const brainRunning = !["idle","complete","error"].includes(brainStep);

  const chainDecision: "BUY" | "SELL" | "WAIT" | null =
    proposal?.decision ?? (
      brainVisState === "complete_buy"  ? "BUY"  :
      brainVisState === "complete_sell" ? "SELL" :
      brainVisState === "complete_wait" ? "WAIT" : null
    );

  // ====================================================================
  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── HEADER ──────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-[#03050a] border-b border-cyan-900/20 relative overflow-hidden">
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/30 to-transparent"/>

        <Brain size={11} className="text-purple-400 shrink-0"/>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9.5px] font-mono tracking-[0.2em] text-purple-300/90 font-bold">AVL AI BRAIN</span>
          <span className="text-[6.5px] font-mono border border-yellow-700/40 text-yellow-400/70 px-1.5 py-0.5">DRY RUN</span>
        </div>

        {/* State badge */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 border shrink-0"
          style={{ borderColor: `${stateMeta.color}50`, background: `${stateMeta.color}12` }}>
          <div className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: stateMeta.color, boxShadow: `0 0 4px ${stateMeta.color}`,
              animation: chainRunning || scanning ? "avl-blink 0.7s ease-in-out infinite" : "none" }}/>
          <span className="text-[8px] font-mono font-bold tracking-wider" style={{ color: stateMeta.color }}>
            {stateMeta.label}
          </span>
        </div>

        <div className="flex-1"/>

        {/* Scan all button */}
        <button
          onClick={scanning ? onStopScan : onRunScan}
          disabled={brainRunning}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-[8px] font-mono border transition-all tracking-wider disabled:opacity-40 shrink-0",
            scanning
              ? "border-red-700/50 text-red-300 bg-red-950/20 hover:bg-red-900/30"
              : "border-cyan-700/40 text-cyan-400 bg-cyan-950/20 hover:bg-cyan-900/30"
          )}>
          {scanning ? <><Square size={8}/> STOP SCAN</> : <><Play size={8}/> SCAN ALL</>}
        </button>

        {/* Single-symbol analyze */}
        <button
          onClick={() => onRunBrain(activeSymbol)}
          disabled={scanning || brainRunning}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-[8px] font-mono border transition-all tracking-wider disabled:opacity-40 shrink-0",
            brainRunning
              ? "border-purple-700/50 text-purple-300 bg-purple-950/20 cursor-wait"
              : "border-purple-700/40 text-purple-400 bg-purple-950/15 hover:bg-purple-900/25"
          )}>
          <Brain size={8} className={brainRunning ? "animate-pulse" : ""}/>
          {brainRunning ? `${brainStep.toUpperCase()}...` : `ANALYZE ${activeSymbol}`}
        </button>
      </div>

      {/* ── MAIN 3-COLUMN ───────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── LEFT META PANEL (150px) ─────────────────────────────── */}
        <div className="w-[150px] shrink-0 flex flex-col gap-2 p-2 border-r border-cyan-900/15 overflow-y-auto avl-scroll">

          {/* AI STATE */}
          <div className="border border-cyan-900/20 bg-[#030508] p-2 relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-px"
              style={{ background: `linear-gradient(90deg, transparent, ${stateMeta.color}40, transparent)` }}/>
            <p className="text-[6px] font-mono text-gray-700 tracking-[0.2em] mb-1.5">AI STATE</p>
            <div className="flex items-center gap-1.5 mb-0.5">
              <div className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: stateMeta.color, boxShadow: `0 0 5px ${stateMeta.color}` }}/>
              <span className="text-[9px] font-mono font-black leading-none" style={{ color: stateMeta.color }}>
                {stateMeta.label}
              </span>
            </div>
            <p className="text-[6.5px] font-mono text-gray-600 leading-snug">{stateMeta.desc}</p>
          </div>

          {/* BEST OPPORTUNITY */}
          {bestOpp ? (
            <div className="border p-2 relative overflow-hidden"
              style={{
                borderColor: bestOpp.direction === "BUY" ? "#00ff8840" : bestOpp.direction === "SELL" ? "#ff1a4e40" : "#00e5ff30",
                background:  bestOpp.direction === "BUY" ? "#031508"   : bestOpp.direction === "SELL" ? "#150308"   : "#030508",
              }}>
              <p className="text-[6px] font-mono text-gray-700 tracking-[0.2em] mb-1">BEST OPPORTUNITY</p>
              <div className="flex items-center gap-1 mb-0.5">
                {bestOpp.direction === "BUY"  ? <TrendingUp   size={9} style={{ color: "#00ff88" }}/> :
                 bestOpp.direction === "SELL" ? <TrendingDown size={9} style={{ color: "#ff1a4e" }}/> :
                 <Minus size={9} style={{ color: "#00e5ff" }}/>}
                <span className="text-[10px] font-mono font-black"
                  style={{ color: bestOpp.direction === "BUY" ? "#00ff88" : bestOpp.direction === "SELL" ? "#ff1a4e" : "#00e5ff" }}>
                  {bestOpp.symbol}
                </span>
              </div>
              <div className="flex items-center gap-1 mb-0.5">
                <span className="text-[6px] font-mono text-gray-700">CONF</span>
                <div className="flex-1 h-0.5 bg-[#0d1520] rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${bestOpp.confidence}%`,
                      background: bestOpp.confidence >= 70 ? "#22c55e" : "#eab308",
                    }}/>
                </div>
                <span className="text-[7px] font-mono text-gray-300">{bestOpp.confidence}%</span>
              </div>
              <div className="flex gap-2 text-[6.5px] font-mono">
                <span className="text-gray-700">
                  DQ <span className={cn(bestOpp.dataQuality >= 75 ? "text-green-400" : "text-yellow-400")}>
                    {bestOpp.dataQuality}
                  </span>
                </span>
                {bestOpp.rr != null && (
                  <span className="text-gray-700">RR <span className="text-cyan-400">{bestOpp.rr.toFixed(1)}</span></span>
                )}
              </div>
              {actionable.length > 0 && (
                <p className="text-[6px] font-mono text-gray-700 mt-1">{actionable.length} actionable setup{actionable.length > 1 ? "s" : ""}</p>
              )}
            </div>
          ) : (
            <div className="border border-[#0d1520] bg-[#030508] p-2">
              <p className="text-[6px] font-mono text-gray-700 tracking-[0.2em] mb-1">BEST OPPORTUNITY</p>
              <p className="text-[7px] font-mono text-gray-800 text-center py-2">
                {scanning ? "SCANNING..." : "RUN SCAN"}
              </p>
            </div>
          )}

          {/* SCAN STATUS */}
          <div className="border border-[#0d1520] bg-[#030508] p-2">
            <p className="text-[6px] font-mono text-gray-700 tracking-[0.2em] mb-1.5">SCAN STATUS</p>
            <div className="flex items-center gap-1.5 mb-1">
              <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", scanning ? "bg-cyan-400 animate-pulse" : "bg-gray-700")}/>
              <span className={cn("text-[8px] font-mono font-semibold", scanning ? "text-cyan-400" : "text-gray-600")}>
                {scanning ? "ACTIVE" : "IDLE"}
              </span>
            </div>
            <div className="space-y-0.5 text-[6.5px] font-mono">
              <div className="flex justify-between">
                <span className="text-gray-700">Scanned</span>
                <span className="text-gray-400">
                  {scanRows.filter(r => r.status === "done" || r.status === "skip").length}/{scanSymbols.length}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Signals</span>
                <span className={actionable.length > 0 ? "text-cyan-400" : "text-gray-700"}>
                  {actionable.length}
                </span>
              </div>
              {lastScanTs && (
                <div className="flex items-center gap-1 text-[6px] pt-0.5">
                  <Clock size={6} className="text-gray-700 shrink-0"/>
                  <span className="text-gray-700">
                    {new Date(lastScanTs).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* BRAIN STEP (single analysis) */}
          {brainStep !== "idle" && (
            <div className="border border-purple-900/30 bg-purple-950/10 p-2">
              <p className="text-[6px] font-mono text-purple-400/60 tracking-[0.2em] mb-1.5">BRAIN STEP</p>
              {(["snapshot","decision","risk","dryrun","complete"] as BrainStep[]).map(step => {
                const ORDER: BrainStep[] = ["idle","snapshot","decision","risk","dryrun","executing","complete","error"];
                const curIdx  = ORDER.indexOf(brainStep);
                const stepIdx = ORDER.indexOf(step);
                const isDone   = curIdx > stepIdx;
                const isActive_ = brainStep === step;
                return (
                  <div key={step} className="flex items-center gap-1.5 py-0.5">
                    <div className={cn("w-1 h-1 rounded-full shrink-0",
                      isDone    ? "bg-green-500"  :
                      isActive_ ? "bg-cyan-400 animate-pulse" :
                      "bg-gray-800"
                    )}/>
                    <span className={cn("text-[6.5px] font-mono",
                      isDone    ? "text-green-400/60" :
                      isActive_ ? "text-cyan-400"     :
                      "bg-transparent text-gray-800"
                    )}>{step.toUpperCase()}</span>
                  </div>
                );
              })}
              <button
                onClick={onResetBrain}
                disabled={brainRunning}
                className="w-full mt-2 text-[6.5px] font-mono text-gray-700 hover:text-gray-500 border border-[#0d1520] py-0.5 transition-colors disabled:opacity-30 flex items-center justify-center gap-1">
                <RefreshCw size={7}/> RESET
              </button>
            </div>
          )}
        </div>

        {/* ── CENTER: BrainParticleCore ──────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col items-center overflow-hidden relative">
          {/* Ambient background glow */}
          <div className="absolute inset-0 pointer-events-none z-0"
            style={{ background: `radial-gradient(ellipse 70% 60% at 50% 50%, ${stateMeta.color}07 0%, transparent 65%)` }}/>

          {/* Title */}
          <div className="relative z-10 pt-2 pb-0.5">
            <p className="text-[6.5px] font-mono tracking-[0.4em] text-purple-400/40 text-center">
              AVL AI BRAIN
            </p>
          </div>

          {/* Particle core — fills remaining height */}
          <div className="flex-1 w-full min-h-0 relative z-10">
            <BrainParticleCore
              brainState={particleState}
              decision={proposal?.decision ?? null}
              voiceAmp={voiceAmp}
              className="absolute inset-0 w-full h-full"
            />
          </div>

          {/* State desc + waveform */}
          <div className="relative z-10 pb-1 flex flex-col items-center gap-1">
            <p className="text-[7px] font-mono tracking-[0.18em] font-semibold"
              style={{ color: stateMeta.color, textShadow: `0 0 8px ${stateMeta.color}50` }}>
              {stateMeta.desc.toUpperCase()}
            </p>
            {isActive && (
              <div className="flex items-end gap-0.5 h-3">
                {[2,4,6,9,12,15,12,9,6,4,2,4,7,10,7,4].map((h, i) => (
                  <div key={i} className="w-0.5 rounded-full"
                    style={{
                      height: Math.min(h, 15),
                      backgroundColor: neonHex,
                      opacity: 0.6,
                      animation: `avl-wave-bar ${0.55+i*0.055}s ease-in-out ${i*0.05}s infinite alternate`,
                      transformOrigin: "bottom",
                    }}/>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL (198px): tabbed ─────────────────────────── */}
        <div className="w-[198px] shrink-0 flex flex-col border-l border-cyan-900/15 overflow-hidden">

          {/* Tab bar */}
          <div className="flex border-b border-cyan-900/15 shrink-0 bg-[#030508]">
            {([
              { id: "scanner" as RightTab, label: "SCAN",  Icon: Activity },
              { id: "ranker"  as RightTab, label: "OPP",   Icon: Zap      },
              { id: "feed"    as RightTab, label: "FEED",  Icon: Shield   },
            ]).map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setRightTab(id)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1 py-1.5 text-[7px] font-mono tracking-wider transition-all border-b-2",
                  rightTab === id
                    ? "border-cyan-400 text-cyan-400 bg-cyan-950/20"
                    : "border-transparent text-gray-700 hover:text-gray-500"
                )}>
                <Icon size={8}/> {label}
                {id === "ranker" && actionable.length > 0 && (
                  <span className="w-3.5 h-3.5 rounded-full bg-cyan-900 text-cyan-400 text-[6px] flex items-center justify-center ml-0.5">
                    {actionable.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {rightTab === "scanner" && (
              <MarketScannerDisplay
                symbols={scanSymbols}
                scanning={scanning}
                rows={scanRows}
                currentSym={currentSym}
              />
            )}
            {rightTab === "ranker" && (
              <OpportunityRanker
                opportunities={opportunities}
                scanning={scanning}
              />
            )}
            {rightTab === "feed" && (
              <ActivityStream events={events} maxVisible={35}/>
            )}
          </div>
        </div>

      </div>{/* end 3-column */}

      {/* ── REASONING CHAIN ─────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-cyan-900/15 bg-[#020408]">
        <ReasoningChain
          activeStage={activeChainStage}
          completedStages={completedChainStages}
          decision={chainDecision}
          running={chainRunning}
        />
      </div>

      {/* ── MIC + VOICE AREA (slot from DashboardOS) ─────────────────── */}
      {micArea}

    </div>
  );
});

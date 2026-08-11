"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type ChainStage =
  | "market_structure"
  | "dow_theory"
  | "multi_tf"
  | "momentum"
  | "oscillators"
  | "correlation"
  | "fundamental"
  | "news"
  | "risk"
  | "decision";

interface StageInfo {
  id:    ChainStage;
  label: string;
  abbr:  string;
  icon:  string;
}

const STAGES: StageInfo[] = [
  { id: "market_structure", label: "MARKET STRUCTURE",  abbr: "MKT",  icon: "◈" },
  { id: "dow_theory",       label: "DOW THEORY",        abbr: "DOW",  icon: "△" },
  { id: "multi_tf",         label: "MULTI-TF",          abbr: "MTF",  icon: "≋" },
  { id: "momentum",         label: "MOMENTUM",          abbr: "MOM",  icon: "➤" },
  { id: "oscillators",      label: "OSCILLATORS",       abbr: "OSC",  icon: "≈" },
  { id: "correlation",      label: "CORRELATION",       abbr: "COR",  icon: "⊛" },
  { id: "fundamental",      label: "FUNDAMENTAL",       abbr: "FND",  icon: "◎" },
  { id: "news",             label: "NEWS",              abbr: "NWS",  icon: "▣" },
  { id: "risk",             label: "RISK ENGINE",       abbr: "RSK",  icon: "⬡" },
  { id: "decision",         label: "DECISION",          abbr: "DEC",  icon: "★" },
];

type StageStatus = "pending" | "active" | "complete" | "skip";

interface Props {
  activeStage?:   ChainStage | null;
  completedStages?: ChainStage[];
  decision?: "BUY" | "SELL" | "WAIT" | null;
  running:   boolean;
}

export function ReasoningChain({ activeStage, completedStages = [], decision, running }: Props) {
  const [pulseIdx, setPulseIdx] = useState(-1);

  useEffect(() => {
    if (!running) { setPulseIdx(-1); return; }
    const activeIdx = STAGES.findIndex(s => s.id === activeStage);
    setPulseIdx(activeIdx);
  }, [activeStage, running]);

  const getStatus = (id: ChainStage): StageStatus => {
    if (completedStages.includes(id)) return "complete";
    if (id === activeStage) return "active";
    if (running) return "pending";
    return "pending";
  };

  const decisionColor =
    decision === "BUY"  ? "#00ff88" :
    decision === "SELL" ? "#ff1a4e" :
    decision === "WAIT" ? "#00e5ff" : "#374151";

  return (
    <div className="flex items-center gap-0 w-full overflow-x-auto py-1 px-2">
      {STAGES.map((stage, i) => {
        const status = getStatus(stage.id);
        const isLast = i === STAGES.length - 1;
        const isDecision = stage.id === "decision";

        const col =
          isDecision && decision === "BUY"  ? "#00ff88" :
          isDecision && decision === "SELL" ? "#ff1a4e" :
          status === "complete" ? "#00e5ff" :
          status === "active"   ? "#00e5ff" :
          "#1a2535";

        const bg =
          isDecision && decision ? `${decisionColor}12` :
          status === "complete"  ? "rgba(0,229,255,0.06)" :
          status === "active"    ? "rgba(0,229,255,0.10)" :
          "transparent";

        return (
          <div key={stage.id} className="flex items-center shrink-0">
            {/* Stage node */}
            <div className="flex flex-col items-center gap-0.5 relative"
              style={{ minWidth: 44 }}>
              {/* Node */}
              <div className="relative flex items-center justify-center w-7 h-7 border transition-all duration-400"
                style={{
                  borderColor: col,
                  background: bg,
                  boxShadow: status === "active"
                    ? `0 0 12px ${col}60, inset 0 0 6px ${col}20`
                    : "none",
                }}>
                {/* Active: spinning ring */}
                {status === "active" && (
                  <div className="absolute inset-0 border border-cyan-400/30"
                    style={{ animation: "avl-spin-cw-fast 1.5s linear infinite" }}/>
                )}
                <span className="text-[9px] font-mono" style={{ color: col }}>
                  {status === "complete" ? "✓" : stage.icon}
                </span>
              </div>
              {/* Label */}
              <span className="text-[5.5px] font-mono text-center leading-tight"
                style={{
                  color: status === "complete" || status === "active" ? col : "#374151",
                  textShadow: status === "active" ? `0 0 8px ${col}` : "none",
                }}>
                {stage.abbr}
              </span>

              {/* Active pulse dot */}
              {status === "active" && (
                <div className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-cyan-400"
                  style={{ animation: "avl-blink 0.5s ease-in-out infinite" }}/>
              )}
            </div>

            {/* Connector */}
            {!isLast && (
              <div className="h-px w-3 shrink-0 transition-all duration-300"
                style={{
                  background: status === "complete"
                    ? "linear-gradient(90deg, #00e5ff, #00e5ff60)"
                    : "#0d1520",
                }}/>
            )}
          </div>
        );
      })}

      {/* Decision badge */}
      {decision && (
        <div className="ml-3 flex items-center gap-1.5 px-2.5 py-1 border shrink-0"
          style={{
            borderColor: `${decisionColor}60`,
            background:  `${decisionColor}12`,
            boxShadow:   `0 0 16px ${decisionColor}30`,
          }}>
          <span className="text-[11px] font-black font-mono" style={{ color: decisionColor }}>
            {decision}
          </span>
        </div>
      )}
    </div>
  );
}

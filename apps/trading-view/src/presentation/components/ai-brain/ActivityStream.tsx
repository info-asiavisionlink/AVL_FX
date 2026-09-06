"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface ActivityEvent {
  id:        string;
  ts:        number;
  category:  "MARKET" | "TECHNICAL" | "CORRELATION" | "NEWS" | "AI" | "RISK" | "SYSTEM" | "DECISION";
  message:   string;
  level:     "info" | "signal" | "warn" | "ok" | "ai";
}

const CAT_COLORS: Record<string, string> = {
  MARKET:      "#00e5ff",
  TECHNICAL:   "#7c3aed",
  CORRELATION: "#2563eb",
  NEWS:        "#f59e0b",
  AI:          "#a855f7",
  RISK:        "#f97316",
  SYSTEM:      "#374151",
  DECISION:    "#00ff88",
};

const LEVEL_COLORS: Record<string, string> = {
  info:   "#4b5563",
  signal: "#00e5ff",
  warn:   "#f59e0b",
  ok:     "#22c55e",
  ai:     "#a855f7",
};

interface Props {
  events: ActivityEvent[];
  maxVisible?: number;
}

export function ActivityStream({ events, maxVisible = 25 }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [events.length]);

  const visible = events.slice(-maxVisible);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#080c14] shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse"/>
        <span className="text-[7.5px] font-mono tracking-[0.2em] text-purple-400/60">LIVE ACTIVITY</span>
        <span className="ml-auto text-[6.5px] font-mono text-gray-700">{events.length} events</span>
      </div>

      {/* Stream */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
        {visible.length === 0 && (
          <p className="text-[7px] font-mono text-gray-800 text-center mt-4">STANDBY — NO ACTIVITY</p>
        )}
        {visible.map((ev) => (
          <div key={ev.id}
            className="flex items-start gap-1.5 py-0.5 border-b border-[#06090f] avl-slide-in">
            {/* Timestamp */}
            <span className="text-[6px] font-mono text-gray-700 tabular-nums shrink-0 mt-0.5">
              {new Date(ev.ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            {/* Category badge */}
            <span className="text-[5.5px] font-mono px-1 py-0.5 shrink-0 mt-0.5"
              style={{
                color:            CAT_COLORS[ev.category] ?? "#4b5563",
                border:           `1px solid ${CAT_COLORS[ev.category] ?? "#1f2937"}40`,
                backgroundColor:  `${CAT_COLORS[ev.category] ?? "#1f2937"}10`,
              }}>
              {ev.category}
            </span>
            {/* Message */}
            <p className="text-[7px] font-mono leading-snug"
              style={{ color: LEVEL_COLORS[ev.level] ?? "#4b5563" }}>
              {ev.message}
            </p>
          </div>
        ))}
        <div ref={bottomRef}/>
      </div>
    </div>
  );
}

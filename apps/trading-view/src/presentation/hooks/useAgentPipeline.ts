"use client";

// =================================================================
// useAgentPipeline — OpenAI Agents SDK マルチエージェント分析
// MarketAgent → AnalysisAgent → DecisionAgent の3段パイプライン
// =================================================================

import { useCallback, useState } from "react";
import { useAIOSStore }           from "@/application/stores/aiOSStore";
import { useIndicatorStore }      from "@/application/stores/indicatorStore";
import { usePriceStore }          from "@/application/stores/priceStore";

export interface PipelineDecision {
  decision:    "BUY" | "SELL" | "HOLD";
  confidence:  number;
  entry:       number;
  sl:          number;
  tp:          number;
  rr:          string;
  volume:      number;
  reason:      string;
  warnings:    string[];
}

export interface PipelineResult {
  output:   string;
  decision: PipelineDecision | null;
  symbol:   string;
  runId:    string;
  ts:       number;
}

export function useAgentPipeline() {
  const [running, setRunning]   = useState(false);
  const [result,  setResult]    = useState<PipelineResult | null>(null);
  const [error,   setError]     = useState<string | null>(null);

  const { addLog, setAgentStatus } = useAIOSStore();
  const { indicators }             = useIndicatorStore();
  const { activeSymbol, watchlist } = usePriceStore();

  const run = useCallback(async (symbolOverride?: string) => {
    const sym = symbolOverride ?? activeSymbol;
    setRunning(true);
    setError(null);
    setResult(null);

    addLog(`[PIPELINE] MarketAgent → AnalysisAgent → DecisionAgent 起動 (${sym})`, "ai");
    setAgentStatus("market",   "thinking", "データ収集中...");
    setAgentStatus("analysis", "thinking", "待機中...");
    setAgentStatus("decision", "idle",     "待機中...");

    const ind = indicators[sym.toUpperCase()];
    const wl  = watchlist.find(w => w.symbol.replace("/", "") === sym.replace("/", ""));

    try {
      const res = await fetch("/api/ai/agent-pipeline", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          symbol:     sym,
          indicators: ind?.timeframes ?? {},
          spread:     ind?.spread ?? 0,
          bid:        wl?.bid ?? 0,
          ask:        wl?.ask ?? 0,
        }),
      });

      if (!res.ok) {
        const { error: e } = await res.json() as { error: string };
        throw new Error(e);
      }

      const data = await res.json() as PipelineResult;
      setResult(data);

      const d = data.decision;
      if (d) {
        const lvl = d.confidence >= 70 ? "signal" : "info";
        addLog(`[DECISION] ${d.decision} (${d.confidence}%) — ${d.reason}`, lvl, sym);
        setAgentStatus("decision", "active", `${d.decision} confidence=${d.confidence}%`);

        if (d.decision !== "HOLD") {
          setAgentStatus("order", d.confidence >= 70 ? "active" : "idle",
            d.confidence >= 70 ? `${d.decision} 提案あり` : "信頼度不足"
          );
        }
      } else {
        addLog(`[PIPELINE] 分析完了`, "ok", sym);
        setAgentStatus("decision", "idle", "分析完了");
      }

      setAgentStatus("market",   "active", "待機中");
      setAgentStatus("analysis", "idle",   "完了");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addLog(`[PIPELINE ERROR] ${msg}`, "warn", sym);
      setAgentStatus("market",   "error", msg);
      setAgentStatus("analysis", "error", msg);
      setAgentStatus("decision", "error", msg);
    } finally {
      setRunning(false);
    }
  }, [activeSymbol, indicators, watchlist, addLog, setAgentStatus]);

  return { run, running, result, error };
}

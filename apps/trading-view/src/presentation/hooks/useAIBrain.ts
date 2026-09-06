"use client";

// =================================================================
// useAIBrain — AVL AI Trading Brain フック
//
// MarketSnapshot → Decision → Risk Engine のパイプラインを
// React から呼び出すためのフック。
//
// DRY RUN モード（ENABLE_LIVE_TRADING=false）では
// 注文は Gateway に送信されない。ログのみ記録される。
// =================================================================

import { useCallback, useState } from "react";
import { useAIOSStore }       from "@/application/stores/aiOSStore";
import { usePriceStore }      from "@/application/stores/priceStore";
import type {
  MarketSnapshot, TradeProposal, RiskDecision,
} from "@/domain/trading/MarketSnapshot";

export type BrainStep =
  | "idle"
  | "snapshot"
  | "decision"
  | "risk"
  | "dryrun"
  | "executing"
  | "complete"
  | "error";

export interface BrainState {
  step:       BrainStep;
  snapshot:   MarketSnapshot | null;
  proposal:   TradeProposal  | null;
  riskResult: RiskDecision   | null;
  error:      string | null;
  lastRunTs:  number | null;
  isLive:     boolean;   // 常に false（DRY RUN）
}

export function useAIBrain() {
  const [state, setState] = useState<BrainState>({
    step: "idle", snapshot: null, proposal: null,
    riskResult: null, error: null, lastRunTs: null, isLive: false,
  });

  const { addLog, setAgentStatus } = useAIOSStore();
  const { activeSymbol }           = usePriceStore();

  const setStep = (step: BrainStep) =>
    setState(prev => ({ ...prev, step }));

  const run = useCallback(async (symbolOverride?: string) => {
    const sym = symbolOverride ?? activeSymbol;
    setState(prev => ({
      ...prev,
      step: "snapshot", error: null,
      snapshot: null, proposal: null, riskResult: null,
    }));
    addLog(`[BRAIN] ${sym} 分析開始 — MarketSnapshot 構築`, "ai");
    setAgentStatus("market", "thinking", "データ収集中...");

    try {
      // ── Step 1: MarketSnapshot ─────────────────────────────────
      const snapRes = await fetch("/api/ai/brain/snapshot", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ symbol: sym }),
      });
      if (!snapRes.ok) throw new Error(`Snapshot failed: ${snapRes.status}`);
      const snapshot = await snapRes.json() as MarketSnapshot;

      setState(prev => ({ ...prev, snapshot, step: "decision" }));
      addLog(`[BRAIN] Snapshot: ${snapshot.overallSource} spread=${snapshot.spread.toFixed(1)}p newsRisk=${snapshot.newsRisk}`, "info");
      setAgentStatus("analysis", "thinking", "AI 分析中...");

      // ── Step 2: AI Decision ────────────────────────────────────
      const decRes = await fetch("/api/ai/brain/decision", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ snapshot }),
      });
      if (!decRes.ok) throw new Error(`Decision failed: ${decRes.status}`);
      const proposal = await decRes.json() as TradeProposal;

      setState(prev => ({ ...prev, proposal, step: "risk" }));
      addLog(
        `[BRAIN] AI → ${proposal.decision} ${sym} confidence=${proposal.confidence}% EV=${proposal.expected_value.toFixed(2)}`,
        proposal.decision === "WAIT" ? "info" : "signal",
        sym
      );
      setAgentStatus("decision", proposal.decision === "WAIT" ? "idle" : "active",
        `${proposal.decision} ${proposal.confidence}%`);

      if (proposal.decision === "WAIT") {
        setState(prev => ({ ...prev, step: "complete", lastRunTs: Date.now() }));
        addLog(`[BRAIN] WAIT — ${proposal.reasoning.market_structure}`, "info");
        setAgentStatus("order", "idle", "WAIT");
        return;
      }

      // ── Step 3: Risk Engine ────────────────────────────────────
      const valRes = await fetch("/api/ai/brain/validate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          proposal,
          account:   snapshot.account,
          positions: snapshot.positions,
          spread:    snapshot.spread,
          newsRisk:  snapshot.newsRisk,
        }),
      });
      if (!valRes.ok) throw new Error(`Validate failed: ${valRes.status}`);
      const riskResult = await valRes.json() as RiskDecision;

      setState(prev => ({ ...prev, riskResult, step: "dryrun" }));
      addLog(
        `[RISK] ${riskResult.status} lot=${riskResult.lot} risk=${riskResult.riskPct.toFixed(2)}%` +
        (riskResult.rejectionReason ? ` — ${riskResult.rejectionReason}` : ""),
        riskResult.status === "APPROVED" ? "ok" : riskResult.status === "MODIFIED" ? "warn" : "warn",
        sym
      );

      if (riskResult.status === "REJECTED") {
        setState(prev => ({ ...prev, step: "complete", lastRunTs: Date.now() }));
        setAgentStatus("order", "idle", `REJECTED: ${riskResult.rejectionReason ?? ""}`);
        return;
      }

      // ── Step 4: DRY RUN (live trading always disabled here) ────
      // ENABLE_LIVE_TRADING はサーバー側のみで判定。クライアントは常に DRY RUN。
      setState(prev => ({ ...prev, step: "dryrun" }));
      addLog(`[BRAIN] DRY RUN — ${proposal.decision} ${sym} @${proposal.entry} SL=${proposal.stop_loss} TP=${proposal.take_profit} lot=${riskResult.lot}`, "signal", sym);
      addLog("[BRAIN] ライブ取引は無効です。Settings で ENABLE_LIVE_TRADING を有効化してください。", "warn");
      setAgentStatus("order", "idle", "DRY RUN");

      setState(prev => ({ ...prev, step: "complete", lastRunTs: Date.now() }));

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState(prev => ({ ...prev, step: "error", error: msg }));
      addLog(`[BRAIN ERROR] ${msg}`, "warn");
      setAgentStatus("analysis", "error", msg);
    }
  }, [activeSymbol, addLog, setAgentStatus]);

  const reset = useCallback(() => {
    setState({ step: "idle", snapshot: null, proposal: null, riskResult: null, error: null, lastRunTs: null, isLive: false });
  }, []);

  return { ...state, run, reset };
}

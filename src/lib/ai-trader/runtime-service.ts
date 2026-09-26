import { entryIdempotencyKey, positionReviewIdempotencyKey, validatePositionDecision, type PositionDecision, type RuntimeState } from "./core-runtime";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createCommandExpiryUtc } from "./command-expiry";

export type EntryDecision = "WAIT" | "INVALIDATE" | "ENTER_LONG" | "ENTER_SHORT";

export interface RuntimeScenario {
  id: string;
  version: number;
  state: string;
  h1BarTime: number;
  entrySide?: "LONG" | "SHORT";
  suggestedSl?: number | null;
  suggestedTp?: number | null;
  symbol?: string;
}

export interface RuntimePosition {
  id: string;
  traderId: string;
  scenarioId: string;
  commandId?: string | null;
  status: "PENDING_OPEN" | "OPEN" | "CLOSED";
  side: "BUY" | "SELL";
  entryPrice: number;
  currentPrice?: number;
  stopLoss: number;
  takeProfit: number;
  volume: number;
  userId?: string;
  connectionId?: string;
  symbol?: string;
  magicNumber?: number;
  positionTicket?: number | null;
}

export interface RuntimeLog {
  userId: string;
  traderId: string;
  traderVersionId: string;
  scenarioId?: string | null;
  positionId?: string | null;
  trigger: string;
  analysisType: string;
  decision: string;
  marketTimestamp: number;
  knowledgeSnapshot: unknown[];
  reasoning?: string | null;
  error?: string | null;
  commandId?: string | null;
  connectionId?: string | null;
}

export interface RuntimeRepository {
  claim(key: string): Promise<boolean>;
  transition(traderId: string, from: RuntimeState | RuntimeState[], to: RuntimeState): Promise<boolean>;
  createScenario(input: { traderId: string; userId: string; traderVersionId: string; h1BarTime: number; state: string; scenarioPayload?: Record<string, unknown> }): Promise<RuntimeScenario>;
  createCommand(input: { idempotencyKey: string; action: string; traderId: string; scenarioId: string; positionId?: string; details?: { userId: string; connectionId: string; symbol: string; magicNumber: number; positionTicket?: number | null; volume?: number | null; stopLoss?: number | null; takeProfit?: number | null; metadata?: Record<string, unknown> } }): Promise<{ id: string }>;
  openPosition(input: { commandId: string; traderId: string; scenarioId: string }): Promise<RuntimePosition>;
  closePosition(positionId: string, reason: string): Promise<{ outcomeId: string; closed: boolean }>;
  saveLog(log: RuntimeLog): Promise<void>;
}
export type RuntimeCommandInput = Parameters<RuntimeRepository["createCommand"]>[0];

export interface RuntimeAI {
  entry(input: { scenario: RuntimeScenario; trigger: string }): Promise<{ decision: unknown; reasoning?: string }>;
  position(input: { position: RuntimePosition; trigger: string }): Promise<{ decision: unknown; newSl?: unknown; newTp?: unknown; reasoning?: string }>;
}

export interface RuntimeRisk {
  entry(input: { decision: "ENTER_LONG" | "ENTER_SHORT"; hardSl: number; marketValid: boolean }): Promise<{ approved: boolean; reason?: string }>;
}

export interface RuntimeMarket {
  validEntry(): boolean;
  validPosition(position: RuntimePosition): boolean;
  validateHardSl(position: { side: "BUY" | "SELL"; stopLoss: number }): boolean;
  validateModifySl(position: RuntimePosition, value: unknown): boolean;
  validateModifyTp(position: RuntimePosition, value: unknown): boolean;
}

export async function createProductionPositionCommand(
  db: SupabaseClient,
  input: { idempotencyKey: string; action: string; traderId: string; scenarioId: string; positionId?: string; details: { userId: string; connectionId: string; symbol: string; magicNumber: number; positionTicket?: number | null; volume?: number | null; stopLoss?: number | null; takeProfit?: number | null; metadata?: Record<string, unknown> } },
): Promise<{ id: string }> {
  const { data, error } = await db.from("execution_commands").insert({
    command_id: randomUUID(), idempotency_key: input.idempotencyKey,
    ai_trader_id: input.traderId, ai_position_id: input.positionId ?? null,
    user_id: input.details.userId, connection_id: input.details.connectionId,
    action: input.action, symbol: input.details.symbol, magic_number: input.details.magicNumber,
    position_ticket: input.details.positionTicket ?? null, volume: input.details.volume ?? null,
    stop_loss: input.details.stopLoss ?? null, take_profit: input.details.takeProfit ?? null,
    expires_at: createCommandExpiryUtc(), status: "PENDING",
    metadata: input.details.metadata ?? {},
  }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "Position command creation failed");
  return { id: data.id as string };
}

export class RuntimeService {
  constructor(
    private readonly repo: RuntimeRepository,
    private readonly ai: RuntimeAI,
    private readonly risk: RuntimeRisk,
    private readonly market: RuntimeMarket,
  ) {}

  /** Canonical state writer used by production route adapters. */
  async transitionState(traderId: string, from: RuntimeState | RuntimeState[], to: RuntimeState): Promise<boolean> {
    return this.repo.transition(traderId, from, to);
  }

  async hourlyAnalysis(input: { userId: string; traderId: string; traderVersionId: string; h1BarTime: number; scenarioPayload?: Record<string, unknown>; knowledgeSnapshot?: unknown[]; decision?: string; reasoning?: string }): Promise<RuntimeScenario | null> {
    const key = `H1:${input.traderId}:${input.h1BarTime}`;
    if (!(await this.repo.claim(key))) return null;
    const scenario = await this.repo.createScenario({ ...input, state: "WATCHING" });
    await this.repo.transition(input.traderId, ["FLAT", "ANALYZING", "WATCHING_ENTRY"], "WATCHING_ENTRY");
    await this.repo.saveLog({ ...this.baseLog(input, scenario.id, "HOURLY_ANALYSIS", input.decision ?? "WATCH", input.h1BarTime), decision: input.decision ?? "WATCH", knowledgeSnapshot: input.knowledgeSnapshot ?? [], reasoning: input.reasoning });
    return scenario;
  }

  async entryRecheck(input: { userId: string; traderId: string; traderVersionId: string; scenario: RuntimeScenario; trigger: string; m5BarTime: number; hardSl: number; knowledgeSnapshot: unknown[]; side?: "BUY" | "SELL" }): Promise<{ decision: EntryDecision; commandId?: string }> {
    const key = entryIdempotencyKey(input.traderId, input.scenario.id, input.trigger, input.m5BarTime);
    if (!(await this.repo.claim(key))) return { decision: "WAIT" };
    await this.repo.transition(input.traderId, "WATCHING_ENTRY", "ENTRY_RECHECK");
    if (!this.market.validEntry() || !this.market.validateHardSl({ side: input.side ?? "BUY", stopLoss: input.hardSl })) return this.entryFailure(input, "INVALID_MARKET_OR_HARD_SL");
    let result: Awaited<ReturnType<RuntimeAI["entry"]>>;
    try { result = await this.ai.entry({ scenario: input.scenario, trigger: input.trigger }); }
    catch { return this.entryFailure(input, "AI_FAILURE"); }
    const decision = result.decision;
    if (decision !== "WAIT" && decision !== "INVALIDATE" && decision !== "ENTER_LONG" && decision !== "ENTER_SHORT") return this.entryFailure(input, "INVALID_DECISION");
    if (decision === "WAIT" || decision === "INVALIDATE") {
      await this.repo.saveLog({ ...this.baseLog(input, input.scenario.id, "ENTRY_RECHECK", decision, input.m5BarTime), knowledgeSnapshot: input.knowledgeSnapshot, reasoning: result.reasoning });
      await this.repo.transition(input.traderId, "ENTRY_RECHECK", decision === "INVALIDATE" ? "FLAT" : "WATCHING_ENTRY");
      return { decision };
    }
    const risk = await this.risk.entry({ decision, hardSl: input.hardSl, marketValid: true });
    if (!risk.approved) {
      await this.repo.saveLog({ ...this.baseLog(input, input.scenario.id, "ENTRY_RECHECK", decision, input.m5BarTime), knowledgeSnapshot: input.knowledgeSnapshot, error: risk.reason ?? "RISK_DENY" });
      await this.repo.transition(input.traderId, "ENTRY_RECHECK", "WATCHING_ENTRY");
      return { decision };
    }
    await this.repo.transition(input.traderId, "ENTRY_RECHECK", "ENTERING");
    const command = await this.repo.createCommand({ idempotencyKey: key, action: decision === "ENTER_LONG" ? "BUY" : "SELL", traderId: input.traderId, scenarioId: input.scenario.id });
    await this.repo.saveLog({ ...this.baseLog(input, input.scenario.id, "ENTRY_RECHECK", decision, input.m5BarTime), commandId: command.id, knowledgeSnapshot: input.knowledgeSnapshot, reasoning: result.reasoning });
    return { decision, commandId: command.id };
  }

  async fill(input: { userId: string; traderId: string; traderVersionId: string; scenario: RuntimeScenario; commandId: string; knowledgeSnapshot: unknown[] }): Promise<RuntimePosition> {
    const position = await this.repo.openPosition({ commandId: input.commandId, traderId: input.traderId, scenarioId: input.scenario.id });
    await this.repo.transition(input.traderId, ["ENTERING", "POSITION"], "WATCHING_POSITION");
    await this.repo.saveLog({ ...this.baseLog(input, input.scenario.id, "EXECUTION_RESULT", "FILLED", Date.now()), positionId: position.id, knowledgeSnapshot: input.knowledgeSnapshot });
    return position;
  }

  async positionReview(input: { userId: string; traderId: string; traderVersionId: string; position: RuntimePosition; trigger: "TP_RECHECK" | "SL_RECHECK" | "POSITION_REVIEW" | "H1_BAR_CLOSED"; barTime: number; knowledgeSnapshot: unknown[] }): Promise<{ decision: PositionDecision; commandId?: string }> {
    const key = positionReviewIdempotencyKey(input.position.id, input.trigger, input.barTime);
    if (!(await this.repo.claim(key))) return { decision: "HOLD" };
    await this.repo.transition(input.traderId, ["WATCHING_POSITION", "POSITION"], "POSITION_REVIEW");
    if (!this.market.validPosition(input.position)) return this.positionFailure(input, "INVALID_POSITION_MARKET");
    let result: Awaited<ReturnType<RuntimeAI["position"]>>;
    try { result = await this.ai.position({ position: input.position, trigger: input.trigger }); }
    catch { return this.positionFailure(input, "AI_FAILURE"); }
    const decision = validatePositionDecision(result.decision) ?? "HOLD";
    if (decision === "HOLD") { await this.repo.saveLog({ ...this.baseLog(input, input.position.scenarioId, input.trigger, decision, input.barTime), positionId: input.position.id, connectionId: input.position.connectionId ?? null, knowledgeSnapshot: input.knowledgeSnapshot, reasoning: result.reasoning }); await this.repo.transition(input.traderId, "POSITION_REVIEW", "WATCHING_POSITION"); return { decision }; }
    if (decision === "MODIFY_SL" && !this.market.validateModifySl(input.position, result.newSl)) return this.positionFailure(input, "INVALID_SL");
    if (decision === "EXTEND_TP" && !this.market.validateModifyTp(input.position, result.newTp)) return this.positionFailure(input, "INVALID_TP");
    const command = await this.repo.createCommand({ idempotencyKey: key, action: decision === "EXTEND_TP" ? "MODIFY_TP" : decision, traderId: input.traderId, scenarioId: input.position.scenarioId, positionId: input.position.id, details: input.position.userId && input.position.connectionId && input.position.symbol ? { userId: input.position.userId, connectionId: input.position.connectionId, symbol: input.position.symbol, magicNumber: input.position.magicNumber ?? 0, positionTicket: input.position.positionTicket, volume: input.position.volume, stopLoss: decision === "MODIFY_SL" ? Number(result.newSl) : null, takeProfit: decision === "EXTEND_TP" ? Number(result.newTp) : null } : undefined });
    await this.repo.saveLog({ ...this.baseLog(input, input.position.scenarioId, input.trigger, decision, input.barTime), positionId: input.position.id, commandId: command.id, connectionId: input.position.connectionId ?? null, knowledgeSnapshot: input.knowledgeSnapshot, reasoning: result.reasoning });
    if (decision === "CLOSE") await this.repo.transition(input.traderId, "POSITION_REVIEW", "CLOSING");
    return { decision, commandId: command.id };
  }

  async close(input: { traderId: string; positionId: string; reason: string }): Promise<{ outcomeId: string; closed: boolean }> {
    const result = await this.repo.closePosition(input.positionId, input.reason);
    if (result.closed) await this.repo.transition(input.traderId, ["CLOSING", "WATCHING_POSITION"], "CLOSED");
    return result;
  }

  private baseLog(input: { userId: string; traderId: string; traderVersionId: string }, scenarioId: string, trigger: string, decision: string, marketTimestamp: number): RuntimeLog {
    return { userId: input.userId, traderId: input.traderId, traderVersionId: input.traderVersionId, scenarioId, trigger, analysisType: trigger, decision, marketTimestamp, knowledgeSnapshot: [] };
  }
  private async entryFailure(input: { userId: string; traderId: string; traderVersionId: string; scenario: RuntimeScenario; m5BarTime: number; knowledgeSnapshot: unknown[] }, error: string) {
    await this.repo.saveLog({ ...this.baseLog(input, input.scenario.id, "ENTRY_RECHECK", "ERROR", input.m5BarTime), knowledgeSnapshot: input.knowledgeSnapshot, error });
    await this.repo.transition(input.traderId, "ENTRY_RECHECK", "WATCHING_ENTRY");
    return { decision: "WAIT" as const };
  }
  private async positionFailure(input: { userId: string; traderId: string; traderVersionId: string; position: RuntimePosition; trigger: string; barTime: number; knowledgeSnapshot: unknown[] }, error: string) {
    await this.repo.saveLog({ ...this.baseLog(input, input.position.scenarioId, input.trigger, "ERROR", input.barTime), positionId: input.position.id, knowledgeSnapshot: input.knowledgeSnapshot, error });
    await this.repo.transition(input.traderId, "POSITION_REVIEW", "WATCHING_POSITION");
    return { decision: "HOLD" as const };
  }
}

/**
 * Production server factory. External AI/Gateway calls remain injectable, but
 * persistence and state transitions always use the real Supabase repository.
 */
export function createProductionRuntimeService(
  db: SupabaseClient,
  deps: { ai: RuntimeAI; risk: RuntimeRisk; market: RuntimeMarket; createEntryCommand?: (input: RuntimeCommandInput) => Promise<{ id: string }>; createPositionCommand?: (input: RuntimeCommandInput) => Promise<{ id: string }> },
): RuntimeService {
  const repo: RuntimeRepository = {
    async claim(key) {
      const { error } = await db.from("runtime_idempotency_claims").insert({ idempotency_key: key });
      return !error;
    },
    async transition(traderId, from, to) {
      const allowed = Array.isArray(from) ? from : [from];
      const { data } = await db.from("ai_traders").update({ watcher_state: to }).eq("id", traderId).in("watcher_state", allowed).select("id");
      return (data ?? []).length > 0;
    },
    async createScenario(input) {
      const { data, error } = await db.rpc("create_h1_scenario_atomic", {
        p_trader_id: input.traderId, p_user_id: input.userId,
        p_trader_version_id: input.traderVersionId, p_h1_bar_time: input.h1BarTime,
        p_payload: { state: input.state, market: "GOLD", ...(input.scenarioPayload ?? {}) },
      });
      if (error || !data?.[0]) throw new Error(error?.message ?? "Scenario creation failed");
      return { id: data[0].id, version: data[0].scenario_version, state: input.state, h1BarTime: input.h1BarTime };
    },
    async createCommand(input) {
      if (input.positionId && deps.createPositionCommand) return deps.createPositionCommand(input);
      if (!deps.createEntryCommand) throw new Error("Production entry command adapter is not configured");
      return deps.createEntryCommand(input);
    },
    async openPosition(input) {
      const { data, error } = await db.from("ai_positions").update({ status: "OPEN" }).eq("execution_command_id", input.commandId).select("*").maybeSingle();
      if (error || !data) throw new Error(error?.message ?? "Position not found");
      return data as RuntimePosition;
    },
    async closePosition(positionId, reason) {
      const { data, error } = await db.from("ai_positions").update({ status: "CLOSED", closed_at: new Date().toISOString() }).eq("id", positionId).eq("status", "OPEN").select("id");
      if (error || !data?.length) return { outcomeId: positionId, closed: false };
      const { data: outcome } = await db.from("trade_outcomes").upsert({ position_id: positionId, close_reason: reason }, { onConflict: "position_id" }).select("id").maybeSingle();
      return { outcomeId: (outcome?.id as string) ?? positionId, closed: true };
    },
    async saveLog(log) { await db.from("ai_analysis_logs").insert({ user_id: log.userId, trader_id: log.traderId, ai_trader_version_id: log.traderVersionId, scenario_id: log.scenarioId ?? null, position_id: log.positionId ?? null, command_id: log.commandId ?? null, trigger_type: log.trigger, analysis_type: log.analysisType, decision: log.decision, market_timestamp: new Date(log.marketTimestamp).toISOString(), knowledge_snapshot: log.knowledgeSnapshot, reasoning_summary: log.reasoning ?? null, error: log.error ?? null, market_context: log.connectionId ? { connection_id: log.connectionId } : null }); },
  };
  return new RuntimeService(repo, deps.ai, deps.risk, deps.market);
}

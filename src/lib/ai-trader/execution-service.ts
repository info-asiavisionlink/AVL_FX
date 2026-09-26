// =================================================================
// execution-service.ts
// Purpose: Single execution path for ALL automated new-entry orders
//
// Architecture: ALL automated new entries must go through:
//   Market Data Validation
//   → Common Risk Engine (runRiskEngine)
//   → createEntryExecutionCommand
//   → execution_commands → Gateway → ExecutionBridge → MT5
//
// Callers:
//   - /api/traders/[id]/execute   (AI Trader DEMO_AUTONOMOUS path)
//   - /api/cron/evaluate-strategies (EA Builder strategy path)
//   - /api/traders/[id]/decide     (Manual approval path)
//
// Prohibited:
//   - Route-specific risk logic (copy of Risk Engine)
//   - Direct execution_commands INSERT without Risk Engine
// =================================================================

import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  runRiskEngine,
  type RiskEngineTrader,
  type RiskEngineProfile,
  type RiskEngineResult,
  type RiskEngineAccountSnapshot,
  type RiskEngineSymbolSpec,
  type RiskEngineLiveQuote,
} from "./risk-engine";
import { validateBarsForEntry, validateTickForEntry, type Bar } from "./market-data-validator";

// -----------------------------------------------------------------
// Input types
// -----------------------------------------------------------------

export interface CommonRiskCheckParams {
  trader:   RiskEngineTrader;   // caller constructs from their data model
  profile:  RiskEngineProfile;  // caller constructs from their data model
  connectionId: string;
  symbol:   string;             // broker symbol (e.g., "GOLD#")
  decision: "ENTER_LONG" | "ENTER_SHORT";
  suggestedSl: number | null;
  suggestedTp: number | null;
  openPositionCount: number;
  totalExposureLots: number;
  /** Bars actually used to make the entry decision, when already fetched by caller. */
  marketBars?: Bar[];
  marketTimeframe?: string;
  skipGlobalKillSwitch?: boolean;
  enforceProfileLimits?: boolean;
  manualApproval?: boolean;
  requireMarginValidation?: boolean;
  positionCountAvailable?: boolean;
}

export interface CommonRiskCheckResult {
  riskResult:      RiskEngineResult;
  accountSnapshot: RiskEngineAccountSnapshot | null;
  symbolSpec:      RiskEngineSymbolSpec | null;
  liveQuote:       RiskEngineLiveQuote | null;
}

export interface CreateCommandParams {
  userId:       string;
  connectionId: string;
  symbol:       string;
  riskResult:   RiskEngineResult;
  magicNumber:  number;

  // AI Trader path (optional)
  aiTraderId?:    string;
  aiPositionId?:  string;
  decisionId?:    string;
  /** Stable caller-supplied key for approval/retry idempotency. */
  idempotencyKey?: string;

  // Strategy path (optional)
  strategyId?:    string;

  // Extra metadata
  metadata?: Record<string, unknown>;
}

export interface CreateCommandResult {
  commandDbId: string;  // UUID in DB
  commandId:   string;  // idempotency key
}

// -----------------------------------------------------------------
// Internal: fetch account snapshot from DB
// -----------------------------------------------------------------

async function fetchAccountSnapshot(
  userId: string,
  db: SupabaseClient,
): Promise<RiskEngineAccountSnapshot | null> {
  const { data: conn } = await db
    .from("mt5_connections")
    .select("id, account_type, account_mode, balance, equity, margin, free_margin, account_balance_updated_at, last_heartbeat_at")
    .eq("user_id", userId)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conn) return null;

  const updatedAt = conn.account_balance_updated_at ?? conn.last_heartbeat_at;
  const updatedAtMs = updatedAt ? new Date(updatedAt as string).getTime() : 0;

  const equity    = Number(conn.equity    ?? 0);
  const balance   = Number(conn.balance   ?? 0);
  const freeMargin = Number(conn.free_margin ?? 0);
  const margin    = Number(conn.margin    ?? 0);

  // Reject non-finite values (NaN/Infinity from DB)
  if (!Number.isFinite(equity) || !Number.isFinite(balance) || !Number.isFinite(freeMargin) || !Number.isFinite(margin)) {
    return null;
  }

  return {
    connectionId: conn.id as string,
    accountType:  (conn.account_type as string) ?? "REAL",
    accountMode:  (conn.account_mode  as string) ?? "NETTING",
    balance, equity, freeMargin, margin,
    currency: "USD",
    updatedAtMs,
  };
}

// -----------------------------------------------------------------
// Internal: fetch symbol spec from DB
// -----------------------------------------------------------------

async function fetchSymbolSpec(
  connectionId: string,
  canonicalSymbol: string,
  brokerSymbol: string,
  db: SupabaseClient,
): Promise<RiskEngineSymbolSpec | null> {
  const { data: spec } = await db
    .from("symbol_specs")
    .select("contract_size, tick_size, tick_value, volume_min, volume_max, volume_step, stops_level_price, digits, margin_initial, max_spread_allowed")
    .eq("connection_id", connectionId)
    .or(`symbol.eq.${canonicalSymbol},broker_symbol.eq.${brokerSymbol}`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!spec) return null;

  // No permissive defaults: an incomplete broker specification is unsafe.
  const contractSize   = Number(spec.contract_size);
  const tickSize       = Number(spec.tick_size);
  const tickValue      = Number(spec.tick_value);
  const volumeMin      = Number(spec.volume_min);
  const volumeMax      = Number(spec.volume_max);
  const volumeStep     = Number(spec.volume_step);
  const stopsLevelPrice = Number(spec.stops_level_price);
  const digits         = Number(spec.digits);
  const marginInitial  = Number(spec.margin_initial);
  const maxSpreadAllowed = Number(spec.max_spread_allowed);

  // Validate all are finite
  if ([contractSize, tickSize, tickValue, volumeMin, volumeMax, volumeStep, stopsLevelPrice, digits, marginInitial, maxSpreadAllowed]
    .some(v => !Number.isFinite(v))) {
    return null;
  }

  return { contractSize, tickSize, tickValue, volumeMin, volumeMax, volumeStep, stopsLevelPrice, digits, marginInitial, maxSpreadAllowed };
}

// -----------------------------------------------------------------
// Internal: fetch live tick from Gateway
// FAIL CLOSED: missing/stale/NaN timestamp = null (not Date.now())
// -----------------------------------------------------------------

async function fetchLiveQuote(
  connectionId: string,
  symbol: string,
  gatewayUrl: string,
  gatewaySecret: string,
  maxAgeSeconds = 10,
): Promise<RiskEngineLiveQuote | null> {
  if (!gatewayUrl) return null;
  try {
    const res = await fetch(
      `${gatewayUrl}/connections/${encodeURIComponent(connectionId)}/tick/${encodeURIComponent(symbol)}`,
      { headers: { Authorization: `Bearer ${gatewaySecret}`, "x-internal-service-auth": gatewaySecret, "x-connection-id": connectionId }, signal: AbortSignal.timeout(4_000) }
    );
    if (!res.ok) return null;

    const tick = await res.json() as { bid?: number; ask?: number; spread?: number; time?: number };

    // Validate bid/ask
    if (!tick.bid || !tick.ask || !Number.isFinite(tick.bid) || !Number.isFinite(tick.ask)) return null;
    if (tick.bid <= 0 || tick.ask <= 0) return null;
    if (tick.ask < tick.bid) return null;

    // CRITICAL: tick.time missing = FAIL CLOSED (do NOT substitute Date.now())
    if (!tick.time || !Number.isFinite(tick.time) || tick.time <= 0) {
      console.warn(`[execution-service] fetchLiveQuote: tick.time missing/invalid for ${symbol}. FAIL CLOSED.`);
      return null;
    }

    const timestampMs = tick.time * 1000;

    // Staleness check using production validator
    const tickData = { bid: tick.bid, ask: tick.ask, spread: tick.spread ?? (tick.ask - tick.bid), time: tick.time };
    const validation = validateTickForEntry(tickData, maxAgeSeconds);
    if (!validation.valid) {
      console.warn(`[execution-service] fetchLiveQuote: ${validation.reason}`);
      return null;
    }

    return {
      bid:         tick.bid,
      ask:         tick.ask,
      spread:      tick.spread ?? (tick.ask - tick.bid),
      timestampMs,
    };
  } catch {
    return null;  // Fail Closed
  }
}

// -----------------------------------------------------------------
// runCommonRiskCheck — fetch inputs + run Risk Engine
// -----------------------------------------------------------------

export async function runCommonRiskCheck(
  params: CommonRiskCheckParams,
  db: SupabaseClient,
  gatewayUrl: string,
  gatewaySecret: string,
): Promise<CommonRiskCheckResult> {
  const { trader, profile, connectionId, symbol, decision, suggestedSl, suggestedTp,
          openPositionCount, totalExposureLots, skipGlobalKillSwitch,
          enforceProfileLimits = false, manualApproval = false,
          requireMarginValidation = enforceProfileLimits,
          positionCountAvailable = true } = params;

  // Derive canonical symbol (strip broker suffix)
  const canonicalSymbol = symbol.replace(/[#.].*$/, "").toUpperCase();

  // Fetch all three in parallel
  const [accountSnapshot, symbolSpec, liveQuote] = await Promise.all([
    fetchAccountSnapshot(trader.user_id, db),
    fetchSymbolSpec(connectionId, canonicalSymbol, symbol, db),
    fetchLiveQuote(connectionId, symbol, gatewayUrl, gatewaySecret),
  ]);

  // Entry context must be valid at the final execution boundary.  A caller
  // may pass the exact bars it used; otherwise fetch the current M5 context.
  let barsValid = true;
  if (params.marketBars) {
    barsValid = validateBarsForEntry(params.marketBars, params.marketTimeframe ?? "M5", 5).valid;
  } else if (gatewayUrl) {
    try {
      const barsRes = await fetch(
        `${gatewayUrl}/connections/${encodeURIComponent(connectionId)}/bars/${encodeURIComponent(symbol)}/M5?count=100`,
        { headers: { Authorization: `Bearer ${gatewaySecret}`, "x-internal-service-auth": gatewaySecret, "x-connection-id": connectionId }, signal: AbortSignal.timeout(4_000) },
      );
      const bars = barsRes.ok ? await barsRes.json() as Bar[] : [];
      barsValid = validateBarsForEntry(bars, "M5", 5).valid;
    } catch {
      barsValid = false;
    }
  } else {
    barsValid = false;
  }

  const riskResult = await runRiskEngine({
    trader,
    profile,
    accountSnapshot,
    symbolSpec,
    liveQuote: barsValid ? liveQuote : null,
    decision: {
      decision:    decision,
      suggestedSl: suggestedSl,
      suggestedTp: suggestedTp,
    },
    openPositionCount,
    totalExposureLots,
    skipGlobalKillSwitch,
    enforceProfileLimits,
    manualApproval,
    requireMarginValidation,
    positionCountAvailable,
  }, db);

  return { riskResult, accountSnapshot, symbolSpec, liveQuote };
}

// -----------------------------------------------------------------
// createEntryExecutionCommand — create execution_commands after Risk approval
// -----------------------------------------------------------------

export async function createEntryExecutionCommand(
  params: CreateCommandParams,
  db: SupabaseClient,
): Promise<CreateCommandResult> {
  const { userId, connectionId, symbol, riskResult, magicNumber,
          aiTraderId, aiPositionId, decisionId, idempotencyKey, strategyId, metadata } = params;

  if (!riskResult.approved) {
    throw new Error(`createEntryExecutionCommand called with denied riskResult: ${riskResult.deniedReason}`);
  }

  // Ensure at least one source reference
  if (!aiTraderId && !strategyId) {
    throw new Error("createEntryExecutionCommand: requires aiTraderId or strategyId");
  }

  const commandUUID = randomUUID();

  const { data: cmd, error: cmdErr } = await db
    .from("execution_commands")
    .insert({
      command_id:      commandUUID,
      idempotency_key: idempotencyKey ?? null,
      user_id:         userId,
      connection_id:   connectionId,
      strategy_id:     strategyId ?? null,
      ai_trader_id:    aiTraderId ?? null,
      ai_position_id:  aiPositionId ?? null,
      magic_number:    magicNumber,
      action:          riskResult.side,  // BUY | SELL (normalized by Risk Engine)
      symbol,
      volume:          riskResult.lot,
      stop_loss:       riskResult.stopLoss,
      take_profit:     riskResult.takeProfit,
      requested_price: null,
      status:          "PENDING",
      expires_at:      riskResult.expiresAt,
      attempt_count:   0,
      metadata: {
        risk_calc:   riskResult.calc,
        entry_price: riskResult.entryPrice,
        ...(decisionId ? { decision_id: decisionId } : {}),
        ...(metadata ?? {}),
      },
    })
    .select("id, command_id")
    .single();

  if (cmdErr || !cmd) {
    if (idempotencyKey) {
      const { data: existing } = await db.from("execution_commands")
        .select("id, command_id")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing) return { commandDbId: existing.id as string, commandId: existing.command_id as string };
    }
    throw new Error(`createEntryExecutionCommand: INSERT failed: ${cmdErr?.message}`);
  }

  return { commandDbId: cmd.id as string, commandId: cmd.command_id as string };
}

// -----------------------------------------------------------------
// buildStrategyRiskEngineTrader — create minimal RiskEngineTrader
// for non-AI-Trader callers (evaluate-strategies, decide)
// -----------------------------------------------------------------

export function buildStrategyRiskEngineTrader(params: {
  userId: string;
  tradingEnabled: boolean;
  emergencyStop: boolean;
  dailyTradeCount?: number;
  dailyLossUsd?: number;
  dailyConsecutiveLosses?: number;
  dailyStatsDate?: string | null;
}): RiskEngineTrader {
  return {
    id:                       "strategy-path",
    user_id:                  params.userId,
    execution_mode:           "DEMO_AUTONOMOUS",
    kill_switch:              params.emergencyStop || !params.tradingEnabled,
    kill_switch_reason:       params.emergencyStop ? "emergency_stop" : (!params.tradingEnabled ? "trading_disabled" : null),
    daily_stats_date:         params.dailyStatsDate ?? null,
    daily_trade_count:        params.dailyTradeCount ?? 0,
    daily_loss_usd:           params.dailyLossUsd ?? 0,
    daily_consecutive_losses: params.dailyConsecutiveLosses ?? 0,
  };
}

// -----------------------------------------------------------------
// buildDefaultRiskEngineProfile — conservative defaults for strategies
// -----------------------------------------------------------------

export function buildDefaultRiskEngineProfile(
  id: string,
  magicNumber: number | null,
  opts?: Partial<RiskEngineProfile>,
): RiskEngineProfile {
  return {
    id,
    magic_number:                 magicNumber,
    max_daily_trades:             opts?.max_daily_trades             ?? 5,
    max_daily_loss_usd:           opts?.max_daily_loss_usd           ?? 100,
    max_consecutive_losses:       opts?.max_consecutive_losses       ?? 3,
    max_total_exposure_lots:      opts?.max_total_exposure_lots      ?? 0.10,
    account_data_max_age_seconds: opts?.account_data_max_age_seconds ?? 60,
    tick_data_max_age_seconds:    opts?.tick_data_max_age_seconds    ?? 10,
    max_spread_points:            opts?.max_spread_points            ?? 0,
    max_risk_per_trade:           opts?.max_risk_per_trade           ?? 0.5,
    minimum_rr:                   opts?.minimum_rr,
    max_positions:                opts?.max_positions,
  };
}

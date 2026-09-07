// =================================================================
// executionStore.ts — Execution Bridge専用Supabase操作モジュール
//
// 責務:
//   - Bridge EA認証（connection_id + token hash検証）
//   - Execution Command取得・Claim・Result更新
//   - live_positions / live_deals Upsert
//   - mt5_connections Heartbeat更新
//
// Source of Truth: Supabase（execution_commands, mt5_connections等）
// Gateway in-memoryは補助キャッシュのみ
// =================================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";
import { WebSocket as ws } from "ws";

// ------------------------------------------------------------------
// Supabase クライアント（遅延初期化）
// ------------------------------------------------------------------

let _client: SupabaseClient | null = null;
let _initialized = false;
let _enabled = false;

function getClient(): SupabaseClient | null {
  if (_initialized) return _enabled ? _client : null;
  _initialized = true;

  const url = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[executionStore] SUPABASE_URL/KEY 未設定 — Execution Bridge無効");
    _enabled = false;
    return null;
  }

  _client  = createClient(url, key, {
    global: { fetch: globalThis.fetch },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: ws as any },
  });
  _enabled = true;
  console.log("[executionStore] Supabase接続 OK");
  return _client;
}

export function isEnabled(): boolean {
  getClient();
  return _enabled;
}

// ------------------------------------------------------------------
// 型定義
// ------------------------------------------------------------------

export interface ConnectionSafetyFlags {
  connectionId:   string;
  userId:         string;
  tradingEnabled: boolean;
  emergencyStop:  boolean;
  accountType:    "REAL" | "DEMO";
  accountMode:    "HEDGING" | "NETTING";
}

export interface BridgeCommand {
  id:             string;   // DB UUID
  commandId:      string;   // Idempotency Key
  action:         string;
  symbol:         string;
  volume:         number | null;
  magicNumber:    number;
  strategyId:     string;
  requestedPrice: number | null;
  stopLoss:       number | null;
  takeProfit:     number | null;
  positionTicket: number | null;
  orderTicket:    number | null;
  expiresAt:      string;
  createdAt:      string;
}

export interface BridgeResultInput {
  commandId:      string;
  success:        boolean;
  status:         string;
  retcode:        number | null;
  orderTicket:    number | null;
  dealTicket:     number | null;
  positionTicket: number | null;
  requestedPrice: number | null;
  executionPrice: number | null;
  requestedVolume:number | null;
  executedVolume: number | null;
  stopLoss:       number | null;
  takeProfit:     number | null;
  brokerTime:     string | null;
  errorCode:      number | null;
  errorMessage:   string | null;
}

export interface BridgePosition {
  positionTicket: number;
  symbol:         string;
  direction:      "BUY" | "SELL";
  volume:         number;
  openPrice:      number;
  currentPrice:   number;
  stopLoss:       number | null;
  takeProfit:     number | null;
  unrealizedPnl:  number;
  commission:     number;
  swap:           number;
  magicNumber:    number;
  openedAt:       string | null;
}

export interface BridgeDeal {
  dealTicket:     number;
  orderTicket:    number | null;
  positionTicket: number | null;
  symbol:         string;
  dealType:       "BUY" | "SELL";
  entryType:      "IN" | "OUT" | "INOUT" | null;
  volume:         number;
  price:          number;
  profit:         number;
  commission:     number;
  swap:           number;
  dealTime:       string;
  magicNumber:    number;
  commandId:      string | null;
}

// ------------------------------------------------------------------
// Bridge EA認証
// SHA-256(connection_token) を mt5_connections.connection_token_hash と照合
// ------------------------------------------------------------------

export async function verifyBridgeAuth(
  connectionId: string,
  connectionToken: string,
): Promise<ConnectionSafetyFlags | null> {
  const sb = getClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from("mt5_connections")
    .select("id, user_id, connection_token_hash, trading_enabled, emergency_stop, account_type, account_mode")
    .eq("id", connectionId)
    .single();

  if (error || !data) return null;

  // Token hash照合（平文Tokenはログに出さない）
  const hash = createHash("sha256").update(connectionToken).digest("hex");
  if (hash !== data.connection_token_hash) {
    console.warn(`[executionStore] auth FAIL connection_id=${connectionId} (token hash mismatch)`);
    return null;
  }

  return {
    connectionId:   data.id,
    userId:         data.user_id,
    tradingEnabled: data.trading_enabled,
    emergencyStop:  data.emergency_stop,
    accountType:    data.account_type,
    accountMode:    data.account_mode,
  };
}

// ------------------------------------------------------------------
// Pending Execution Commands取得
// ------------------------------------------------------------------

export async function getPendingCommands(
  connectionId: string,
): Promise<BridgeCommand[]> {
  const sb = getClient();
  if (!sb) return [];

  const { data, error } = await sb
    .from("execution_commands")
    .select(`
      id, command_id, action, symbol, volume,
      magic_number, strategy_id,
      requested_price, stop_loss, take_profit,
      position_ticket, order_ticket,
      expires_at, created_at
    `)
    .eq("connection_id", connectionId)
    .eq("status", "PENDING")
    .order("created_at", { ascending: true })
    .limit(10);

  if (error || !data) return [];

  return data.map(r => ({
    id:             r.id,
    commandId:      r.command_id,
    action:         r.action,
    symbol:         r.symbol,
    volume:         r.volume,
    magicNumber:    r.magic_number,
    strategyId:     r.strategy_id,
    requestedPrice: r.requested_price,
    stopLoss:       r.stop_loss,
    takeProfit:     r.take_profit,
    positionTicket: r.position_ticket,
    orderTicket:    r.order_ticket,
    expiresAt:      r.expires_at,
    createdAt:      r.created_at,
  }));
}

// ------------------------------------------------------------------
// Command Claim（Atomic: PENDING → CLAIMED）
// Supabase UPDATE with WHERE status='PENDING'
// → affected rows 0なら既に別プロセスがclaimした
// ------------------------------------------------------------------

export async function claimCommand(
  commandId: string,
  connectionId: string,
): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;

  const { data, error } = await sb
    .from("execution_commands")
    .update({
      status:     "CLAIMED",
      claimed_at: new Date().toISOString(),
    })
    .eq("command_id", commandId)
    .eq("connection_id", connectionId)
    .eq("status", "PENDING")   // Atomic: statusがPENDINGのものだけ更新
    .select("command_id")
    .single();

  if (error || !data) return false;
  return true;
}

// ------------------------------------------------------------------
// Command Result提出（Terminal State移行）
// ------------------------------------------------------------------

export async function submitCommandResult(
  result: BridgeResultInput,
): Promise<void> {
  const sb = getClient();
  if (!sb) return;

  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    status:        result.status,
    completed_at:  now,
    error_code:    result.errorCode,
    error_message: result.errorMessage,
  };

  if (result.success && result.status === "FILLED") {
    update.executed_at        = result.brokerTime ?? now;
    update.broker_order_ticket   = result.orderTicket;
    update.broker_deal_ticket    = result.dealTicket;
    update.broker_position_ticket = result.positionTicket;
    update.execution_price    = result.executionPrice;
    update.executed_volume    = result.executedVolume;
  }

  await sb
    .from("execution_commands")
    .update(update)
    .eq("command_id", result.commandId)
    .in("status", ["CLAIMED", "EXECUTING"]);  // Terminal Stateには書き込まない

  console.log(`[executionStore] result commandId=${result.commandId} status=${result.status}`);
}

// ------------------------------------------------------------------
// Heartbeat更新（mt5_connections）
// Safety flagsを返す
// ------------------------------------------------------------------

export async function updateHeartbeat(
  connectionId: string,
  bridgeData: {
    accountType:    "REAL" | "DEMO";
    accountMode:    "HEDGING" | "NETTING";
    tradeAllowed:   boolean;
    balance:        number;
    equity:         number;
    margin:         number;
    freeMargin:     number;
    leverage:       number;
  }
): Promise<ConnectionSafetyFlags | null> {
  const sb = getClient();
  if (!sb) return null;

  const now = new Date().toISOString();

  const { data, error } = await sb
    .from("mt5_connections")
    .update({
      last_heartbeat_at: now,
      status:            "CONNECTED",
      account_type:      bridgeData.accountType,
      account_mode:      bridgeData.accountMode,
      leverage:          bridgeData.leverage,
    })
    .eq("id", connectionId)
    .select("id, user_id, trading_enabled, emergency_stop, account_type, account_mode")
    .single();

  if (error || !data) return null;

  return {
    connectionId:   data.id,
    userId:         data.user_id,
    tradingEnabled: data.trading_enabled,
    emergencyStop:  data.emergency_stop,
    accountType:    data.account_type,
    accountMode:    data.account_mode,
  };
}

// ------------------------------------------------------------------
// Connection切断通知
// ------------------------------------------------------------------

export async function markConnectionDisconnected(connectionId: string): Promise<void> {
  const sb = getClient();
  if (!sb) return;

  await sb
    .from("mt5_connections")
    .update({
      status:          "DISCONNECTED",
      disconnected_at: new Date().toISOString(),
    })
    .eq("id", connectionId);
}

// ------------------------------------------------------------------
// Live Positions Upsert
// ------------------------------------------------------------------

export async function upsertPositions(
  connectionId: string,
  userId: string,
  positions: BridgePosition[],
): Promise<void> {
  const sb = getClient();
  if (!sb || positions.length === 0) return;

  const rows = positions.map(p => ({
    user_id:          userId,
    connection_id:    connectionId,
    position_ticket:  p.positionTicket,
    symbol:           p.symbol,
    direction:        p.direction,
    volume:           p.volume,
    open_price:       p.openPrice,
    current_price:    p.currentPrice,
    stop_loss:        p.stopLoss ?? null,
    take_profit:      p.takeProfit ?? null,
    unrealized_pnl:   p.unrealizedPnl,
    commission:       p.commission,
    swap:             p.swap,
    magic_number:     p.magicNumber,
    opened_at:        p.openedAt,
    status:           "OPEN",
    last_synced_at:   new Date().toISOString(),
  }));

  const { error } = await sb
    .from("live_positions")
    .upsert(rows, {
      onConflict:        "connection_id,position_ticket",
      ignoreDuplicates:  false,
    });

  if (error) console.warn("[executionStore] positions upsert:", error.message);
}

// ------------------------------------------------------------------
// Live Deals Upsert
// ------------------------------------------------------------------

export async function upsertDeals(
  connectionId: string,
  userId: string,
  deals: BridgeDeal[],
): Promise<void> {
  const sb = getClient();
  if (!sb || deals.length === 0) return;

  const rows = deals.map(d => ({
    user_id:          userId,
    connection_id:    connectionId,
    deal_ticket:      d.dealTicket,
    order_ticket:     d.orderTicket ?? null,
    position_ticket:  d.positionTicket ?? null,
    symbol:           d.symbol,
    deal_type:        d.dealType,
    entry_type:       d.entryType ?? null,
    volume:           d.volume,
    price:            d.price,
    profit:           d.profit,
    commission:       d.commission,
    swap:             d.swap,
    deal_time:        d.dealTime,
    magic_number:     d.magicNumber,
    command_id:       d.commandId ?? null,
    synced_at:        new Date().toISOString(),
  }));

  const { error } = await sb
    .from("live_deals")
    .upsert(rows, {
      onConflict:       "connection_id,deal_ticket",
      ignoreDuplicates: true,  // 同一Dealは一度だけ保存
    });

  if (error) console.warn("[executionStore] deals upsert:", error.message);
}

// ------------------------------------------------------------------
// テスト用: Execution Command作成（開発専用）
// Strategy Runtime未実装期間中のE2Eテスト用
// ------------------------------------------------------------------

export async function createTestCommand(params: {
  userId:       string;
  connectionId: string;
  strategyId:   string;
  magicNumber:  number;
  action:       string;
  symbol:       string;
  volume?:      number;
  stopLoss?:    number;
  takeProfit?:  number;
  positionTicket?: number;
  expirySeconds?: number;
}): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;

  const commandId = randomUUID();
  const expiresAt = new Date(Date.now() + (params.expirySeconds ?? 300) * 1000).toISOString();

  const { data, error } = await sb
    .from("execution_commands")
    .insert({
      command_id:      commandId,
      user_id:         params.userId,
      connection_id:   params.connectionId,
      strategy_id:     params.strategyId,
      magic_number:    params.magicNumber,
      action:          params.action,
      symbol:          params.symbol,
      volume:          params.volume ?? null,
      stop_loss:       params.stopLoss ?? null,
      take_profit:     params.takeProfit ?? null,
      position_ticket: params.positionTicket ?? null,
      status:          "PENDING",
      expires_at:      expiresAt,
      attempt_count:   0,
    })
    .select("command_id")
    .single();

  if (error) {
    console.error("[executionStore] createTestCommand:", error.message);
    return null;
  }

  return commandId;
}

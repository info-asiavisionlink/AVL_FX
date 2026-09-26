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
  dealTime:       string | number;  // EA may send Unix epoch seconds (number) or formatted string
  magicNumber:    number;
  commandId:      string | null;
}

/** Persistence boundary for execution-result and position-snapshot paths. */
export interface ExecutionStore {
  submitCommandResult(result: BridgeResultInput, connectionId: string): Promise<{ rowsAffected: number }>;
  upsertPositions(connectionId: string, userId: string, positions: BridgePosition[], complete?: boolean): Promise<void>;
}

/** Production store keeps the existing Supabase-backed behavior lazy. */
export function createProductionExecutionStore(): ExecutionStore {
  return {
    submitCommandResult,
    upsertPositions: (connectionId, userId, positions, complete) => upsertPositions(connectionId, userId, positions, undefined, complete),
  };
}

export async function processExecutionResult(
  result: BridgeResultInput,
  connectionId: string,
  store: ExecutionStore = createProductionExecutionStore(),
): Promise<{ rowsAffected: number }> {
  return store.submitCommandResult(result, connectionId);
}

export async function reconcilePositionSnapshot(
  connectionId: string,
  userId: string,
  positions: BridgePosition[],
  store: ExecutionStore = createProductionExecutionStore(),
  options: { complete?: boolean } = {},
): Promise<void> {
  await store.upsertPositions(connectionId, userId, positions, options.complete === true);
}

// ------------------------------------------------------------------
// Bridge EA認証
// SHA-256(connection_token) を mt5_connections.connection_token_hash と照合
// ------------------------------------------------------------------

export async function verifyBridgeAuth(
  connectionId: string,
  connectionToken: string,
): Promise<ConnectionSafetyFlags | null> {
  const result = await verifyBridgeAuthStatus(connectionId, connectionToken);
  return result === "unavailable" || result === "denied" ? null : result;
}

export type BridgeAuthStatus = ConnectionSafetyFlags | "denied" | "unavailable";

/** Detailed auth result for HTTP handlers that must distinguish outage from denial. */
export async function verifyBridgeAuthStatus(
  connectionId: string,
  connectionToken: string,
): Promise<BridgeAuthStatus> {
  const sb = getClient();
  if (!sb) return "unavailable";

  const { data, error } = await sb
    .from("mt5_connections")
    .select("id, user_id, connection_token_hash, trading_enabled, emergency_stop, account_type, account_mode")
    .eq("id", connectionId)
    .single();

  if (error) return "unavailable";
  if (!data) return "denied";

  // Token hash照合（平文Tokenはログに出さない）
  const hash = createHash("sha256").update(connectionToken).digest("hex");
  if (hash !== data.connection_token_hash) {
    console.warn(`[executionStore] auth FAIL connection_id=${connectionId} (token hash mismatch)`);
    return "denied";
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

// STAGE1-05 AUDIT-022: connectionId パラメータ追加（コマンド所有者チェック）
// Returns: rowsAffected — 0 = ownership mismatch or terminal state (no update)
export async function submitCommandResult(
  result: BridgeResultInput,
  connectionId: string,
  dbOverride?: SupabaseClient | null,
): Promise<{ rowsAffected: number }> {
  const sb = dbOverride === undefined ? getClient() : dbOverride;
  if (!sb) return { rowsAffected: 0 };

  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    status:        result.status,
    completed_at:  now,
    error_code:    result.errorCode,
    error_message: result.errorMessage,
  };

  if (result.success && result.status === "FILLED") {
    update.executed_at            = result.brokerTime ?? now;
    update.broker_order_ticket    = result.orderTicket;
    update.broker_deal_ticket     = result.dealTicket;
    update.broker_position_ticket = result.positionTicket;
    update.execution_price        = result.executionPrice;
    update.executed_volume        = result.executedVolume;
  }

  // STAGE1-05 AUDIT-022: connection_id ownership check + select to detect 0-row updates
  const { data: updated } = await sb
    .from("execution_commands")
    .update(update)
    .eq("command_id", result.commandId)
    .eq("connection_id", connectionId)        // 所有接続のコマンドのみ
    .in("status", ["CLAIMED", "EXECUTING"])   // Terminal Stateには書き込まない
    .select("command_id, action, ai_position_id, user_id, connection_id, stop_loss, take_profit, created_at");

  const rowsAffected = (updated ?? []).length;
  if (rowsAffected > 0 && result.success && result.status === "FILLED") {
    const { data: command } = await sb.from("execution_commands")
      .select("command_id, action, ai_position_id, user_id, connection_id, stop_loss, take_profit, created_at")
      .eq("command_id", result.commandId)
      .eq("connection_id", connectionId)
      .maybeSingle();
    if (command && (command.action === "MODIFY_SL" || command.action === "MODIFY_TP") && !command.ai_position_id) {
      throw new Error(`MODIFY_POSITION_SYNC_FAILED:MISSING_AI_POSITION_CORRELATION:${command.command_id}`);
    }
    if (command?.ai_position_id) {
      if (command.action === "MODIFY_SL" || command.action === "MODIFY_TP") {
        // A later-created successful modification is authoritative. This keeps
        // a delayed broker result from rolling back a newer confirmed value.
        const { data: latest } = await sb.from("execution_commands")
          .select("command_id, created_at")
          .eq("ai_position_id", command.ai_position_id)
          .eq("user_id", command.user_id)
          .eq("connection_id", command.connection_id)
          .eq("action", command.action)
          .eq("status", "FILLED")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latest?.command_id !== command.command_id) {
          console.warn(`[executionStore] stale modify result ignored commandId=${result.commandId}`);
        } else {
          const requested = command.action === "MODIFY_SL" ? command.stop_loss : command.take_profit;
          const confirmed = command.action === "MODIFY_SL"
            ? (Number.isFinite(result.stopLoss) ? result.stopLoss : requested)
            : (Number.isFinite(result.takeProfit) ? result.takeProfit : requested);
          if (confirmed === null || confirmed === undefined || !Number.isFinite(Number(confirmed))) {
            throw new Error(`MODIFY_SYNC_MISSING_CONFIRMED_VALUE:${command.action}`);
          }
          const protectionUpdate = command.action === "MODIFY_SL"
            ? { stop_loss: Number(confirmed) }
            : { take_profit: Number(confirmed) };
          const { data: synced, error: syncError } = await sb.from("ai_positions")
            .update(protectionUpdate)
            .eq("id", command.ai_position_id)
            .eq("user_id", command.user_id)
            .eq("connection_id", command.connection_id)
            .eq("status", "OPEN")
            .select("id");
          if (syncError || !synced || synced.length === 0) {
            const { data: currentPosition } = await sb.from("ai_positions")
              .select("id, status")
              .eq("id", command.ai_position_id)
              .eq("user_id", command.user_id)
              .eq("connection_id", command.connection_id)
              .maybeSingle();
            if (currentPosition?.status !== "CLOSED") {
              throw new Error(`MODIFY_POSITION_SYNC_FAILED:${syncError?.message ?? "position_not_open_or_owned"}`);
            }
            console.warn(`[executionStore] modify result ignored for closed position=${command.ai_position_id}`);
          }
        }
      } else {
        await sb.from("ai_positions")
          .update({
            status: "OPEN",
            position_ticket: result.positionTicket ?? null,
            order_ticket: result.orderTicket ?? null,
            entry_deal_ticket: result.dealTicket ?? null,
            entry_price: result.executionPrice ?? null,
            volume: result.executedVolume ?? undefined,
            opened_at: result.brokerTime ?? now,
          })
          .eq("id", command.ai_position_id)
          .eq("user_id", command.user_id)
          .eq("connection_id", command.connection_id);
      }
    }
  }
  console.log(`[executionStore] result commandId=${result.commandId} status=${result.status} rows=${rowsAffected}`);
  return { rowsAffected };
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
      last_heartbeat_at:           now,
      status:                      "CONNECTED",
      account_type:                bridgeData.accountType,
      account_mode:                bridgeData.accountMode,
      leverage:                    bridgeData.leverage,
      // Phase 3.5: account balance/equity をリアルタイム保存
      // Risk Engine の Source of Truth として使用する
      balance:                     bridgeData.balance,
      equity:                      bridgeData.equity,
      margin:                      bridgeData.margin,
      free_margin:                 bridgeData.freeMargin,
      account_balance_updated_at:  now,
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
  dbOverride?: SupabaseClient | null,
  complete = false,
): Promise<void> {
  const sb = dbOverride === undefined ? getClient() : dbOverride;
  if (!sb) return;

  const invalid = positions.some((p) =>
    !Number.isInteger(p.positionTicket) || p.positionTicket <= 0 ||
    !p.symbol || !["BUY", "SELL"].includes(p.direction) ||
    !Number.isFinite(p.volume) || p.volume <= 0 ||
    !Number.isFinite(p.openPrice) || p.openPrice <= 0 ||
    !Number.isFinite(p.currentPrice) || p.currentPrice <= 0 ||
    (p.stopLoss !== null && (!Number.isFinite(p.stopLoss) || p.stopLoss < 0)) ||
    (p.takeProfit !== null && (!Number.isFinite(p.takeProfit) || p.takeProfit < 0))
  );
  if (invalid) throw new Error("POSITION_SNAPSHOT_INVALID_ITEM");

  // Only an explicitly authoritative complete snapshot may close positions
  // absent from the payload. Unknown/partial snapshots are upsert-only.
  if (positions.length === 0 && complete) {
    const { error } = await sb.from("live_positions")
      .update({ status: "CLOSED", last_synced_at: new Date().toISOString() })
      .eq("connection_id", connectionId)
      .eq("user_id", userId)
      .eq("status", "OPEN");
    if (error) throw new Error(`POSITION_RECONCILIATION_CLOSE_FAILED:${error.message}`);
    return;
  }

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

  if (error) throw new Error(`POSITION_RECONCILIATION_UPSERT_FAILED:${error.message}`);

  if (!complete) return;

  const seen = rows.map((row) => row.position_ticket);
  const { data: openRows, error: readError } = await sb.from("live_positions")
    .select("position_ticket")
    .eq("connection_id", connectionId)
    .eq("user_id", userId)
    .eq("status", "OPEN");
  if (readError) throw new Error(`POSITION_RECONCILIATION_READ_FAILED:${readError.message}`);
  const stale = (openRows ?? [])
    .map((row: { position_ticket: number }) => row.position_ticket)
    .filter((ticket: number) => !seen.includes(ticket));
  if (stale.length > 0) {
    const { error: closeError } = await sb.from("live_positions")
      .update({ status: "CLOSED", last_synced_at: new Date().toISOString() })
      .eq("connection_id", connectionId)
      .eq("user_id", userId)
      .in("position_ticket", stale);
    if (closeError) throw new Error(`POSITION_RECONCILIATION_CLOSE_FAILED:${closeError.message}`);
  }
}

// ------------------------------------------------------------------
// Live Deals Upsert
// ------------------------------------------------------------------

/**
 * Normalize a deal timestamp to ISO 8601 for PostgreSQL TIMESTAMPTZ.
 *
 * The EA sends one of two formats:
 *   (a) Unix epoch seconds as a bare number:  1790335988
 *   (b) MQL5 TimeToString string: "2026.09.25 11:33:08 UTC"
 *
 * PostgreSQL TIMESTAMPTZ rejects bare epoch-second integers and dot-separated
 * date strings, so we normalise to "YYYY-MM-DDTHH:MM:SS.000Z" in all cases.
 * Seconds timestamps must be multiplied by 1000 before constructing Date to
 * avoid treating them as milliseconds (which would give dates near 1970-01-01).
 */
function normalizeDealTime(raw: string | number): string {
  // Case 1: numeric (EA sent plain epoch seconds without TimeToString)
  const asNum = typeof raw === "number" ? raw : (String(raw).match(/^\d{9,12}$/) ? Number(raw) : NaN);
  if (!isNaN(asNum) && asNum > 1_000_000_000 && asNum < 9_999_999_999) {
    return new Date(asNum * 1000).toISOString();
  }
  // Case 2: MQL5 "YYYY.MM.DD HH:MM:SS UTC" — replace dots with dashes
  if (typeof raw === "string") {
    const normalized = raw.trim().replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3");
    return normalized;
  }
  return String(raw);
}

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
    deal_time:        normalizeDealTime(d.dealTime),
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
// Symbol Specification Upsert（Bridge EA から送信されたスペックを DB 保存）
// Risk Engine の Lot 計算・Stop Level 検証の Source of Truth
// ------------------------------------------------------------------

export interface SymbolSpecInput {
  connectionId:      string;
  userId:            string;
  symbol:            string;  // canonical symbol (e.g., "GOLD")
  brokerSymbol:      string;  // actual MT5 symbol (e.g., "GOLD#")
  contractSize:      number;
  volumeMin:         number;
  volumeMax:         number;
  volumeStep:        number;
  tickSize:          number;
  tickValue:         number;  // per lot per tick in deposit currency
  pointSize:         number;
  digits:            number;
  stopsLevelPoints:  number;
  stopsLevelPrice:   number;
  currencyProfit:    string;
  currencyMargin:    string;
  marginInitial:     number;
  spreadCurrent:     number;
}

export async function upsertSymbolSpec(spec: SymbolSpecInput): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;

  const { error } = await sb
    .from("symbol_specs")
    .upsert({
      user_id:              spec.userId,
      connection_id:        spec.connectionId,
      symbol:               spec.symbol,
      broker_symbol:        spec.brokerSymbol,
      contract_size:        spec.contractSize,
      volume_min:           spec.volumeMin,
      volume_max:           spec.volumeMax,
      volume_step:          spec.volumeStep,
      tick_size:            spec.tickSize,
      tick_value:           spec.tickValue,
      point_size:           spec.pointSize,
      digits:               spec.digits,
      stops_level_points:   spec.stopsLevelPoints,
      stops_level_price:    spec.stopsLevelPrice,
      currency_profit:      spec.currencyProfit,
      currency_margin:      spec.currencyMargin,
      margin_initial:       spec.marginInitial,
      spread_current:       spec.spreadCurrent,
      updated_at:           new Date().toISOString(),
    }, {
      onConflict: "connection_id,broker_symbol",
    });

  if (error) {
    console.warn("[executionStore] symbol_spec upsert:", error.message);
    return false;
  }

  console.log(`[executionStore] symbol_spec saved: ${spec.brokerSymbol} contract=${spec.contractSize} tickVal=${spec.tickValue}`);
  return true;
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

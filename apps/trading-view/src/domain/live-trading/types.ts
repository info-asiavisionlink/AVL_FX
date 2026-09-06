// =================================================================
// Live Trading Domain Types — STAGE 3-A
//
// Architecture: 共通Execution Bridge EA方式
//   - Strategy Runtime (Server) → Signal → Execution Engine
//     → Execution Command → Gateway → Bridge EA → MT5
//
// Source of Truth:
//   Market Price / Position / Deal / Account : MT5 / Broker
//   Strategy Definition / Signal / Command   : AVL-FX
//
// =================================================================

// -----------------------------------------------------------------
// MT5 Connection
// -----------------------------------------------------------------

export type MT5ConnectionStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "ERROR";

export interface MT5Connection {
  id:                   string;   // UUID
  userId:               string;   // auth.users.id
  connectionTokenHash:  string;   // SHA-256 of the token shown to user
  broker:               string;
  serverName:           string;
  mt5Login:             number;
  accountCurrency:      string;
  accountType:          "REAL" | "DEMO";
  accountMode:          "HEDGING" | "NETTING";
  leverage:             number | null;
  status:               MT5ConnectionStatus;
  emergencyStop:        boolean;   // true → すべての新規CommandをBlock
  tradingEnabled:       boolean;   // false → Signal生成のみ、Command発行なし
  lastHeartbeatAt:      string | null;  // ISO
  connectedAt:          string | null;
  disconnectedAt:       string | null;
  createdAt:            string;
  updatedAt:            string;
}

// -----------------------------------------------------------------
// Execution Action
// -----------------------------------------------------------------

export type ExecutionAction =
  | "BUY"
  | "SELL"
  | "CLOSE"
  | "MODIFY_SL"
  | "MODIFY_TP";

// -----------------------------------------------------------------
// Command Status State Machine
//
// PENDING → CLAIMED → EXECUTING → FILLED  （正常）
// PENDING → EXPIRED                        （期限切れ）
// CLAIMED/EXECUTING → FAILED               （MT5エラー）
// CLAIMED/EXECUTING → REJECTED             （Broker拒否）
// any non-terminal → CANCELLED             （手動キャンセル）
//
// Terminal States: FILLED / REJECTED / FAILED / EXPIRED / CANCELLED
// -----------------------------------------------------------------

export type ExecutionCommandStatus =
  | "PENDING"     // Gateway取得待ち
  | "CLAIMED"     // EAが取得済み（処理中）
  | "EXECUTING"   // MT5へ注文送信済み
  | "FILLED"      // 約定完了（Terminal）
  | "REJECTED"    // Broker拒否（Terminal）
  | "FAILED"      // MT5/Gateway障害（Terminal）
  | "EXPIRED"     // 期限切れ（Terminal）
  | "CANCELLED";  // 手動キャンセル（Terminal）

export const TERMINAL_STATUSES: ReadonlySet<ExecutionCommandStatus> = new Set([
  "FILLED",
  "REJECTED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);

export function isTerminalStatus(status: ExecutionCommandStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// -----------------------------------------------------------------
// Execution Command
//
// AVL-FX → MT5 への唯一の正式注文Contract。
// command_id で Idempotency を保証。
// -----------------------------------------------------------------

export interface ExecutionCommand {
  id:                   string;   // UUID (DB primary key)
  commandId:            string;   // Idempotency Key (UNIQUE)

  userId:               string;
  connectionId:         string;

  strategyId:           string;
  magicNumber:          number;
  signalId:             string | null;

  action:               ExecutionAction;
  symbol:               string;
  volume:               number | null;

  requestedPrice:       number | null;
  stopLoss:             number | null;
  takeProfit:           number | null;

  positionTicket:       number | null;  // CLOSE / MODIFY用
  orderTicket:          number | null;

  status:               ExecutionCommandStatus;

  createdAt:            string;   // ISO
  expiresAt:            string;   // ISO (必須: 遅延実行防止)
  claimedAt:            string | null;
  executedAt:           string | null;
  completedAt:          string | null;

  attemptCount:         number;

  brokerOrderTicket:    number | null;
  brokerDealTicket:     number | null;
  brokerPositionTicket: number | null;
  executionPrice:       number | null;
  executedVolume:       number | null;

  errorCode:            number | null;
  errorMessage:         string | null;

  metadata:             Record<string, unknown> | null;
}

// -----------------------------------------------------------------
// Execution Command Input (作成時に必要な最小フィールド)
// -----------------------------------------------------------------

export interface CreateExecutionCommandInput {
  commandId:      string;   // 呼び出し元が生成 (UUIDv4)
  connectionId:   string;
  strategyId:     string;
  magicNumber:    number;
  signalId?:      string;
  action:         ExecutionAction;
  symbol:         string;
  volume?:        number;
  requestedPrice?: number;
  stopLoss?:      number;
  takeProfit?:    number;
  positionTicket?: number;
  orderTicket?:   number;
  expiresAt:      string;   // ISO - 必須
  metadata?:      Record<string, unknown>;
}

// -----------------------------------------------------------------
// Execution Result (MT5 → AVL-FX)
// -----------------------------------------------------------------

export interface ExecutionResult {
  commandId:          string;
  success:            boolean;
  status:             ExecutionCommandStatus;

  // MT5 retcode（ERR_SUCCESS = 0 / 各エラーコード）
  retcode:            number | null;
  retcodeDescription: string | null;

  orderTicket:        number | null;
  dealTicket:         number | null;
  positionTicket:     number | null;

  requestedPrice:     number | null;
  executionPrice:     number | null;
  requestedVolume:    number | null;
  executedVolume:     number | null;

  stopLoss:           number | null;
  takeProfit:         number | null;

  brokerTime:         string | null;  // ISO

  errorCode:          number | null;
  errorMessage:       string | null;

  receivedAt:         string;   // ISO
}

// -----------------------------------------------------------------
// Strategy Signal
//
// StrategyEvaluatorの出力。Signal ≠ Execution Command。
// Riskで棄却されたSignalも記録される。
// -----------------------------------------------------------------

export type SignalDirection = "BUY" | "SELL" | "EXIT_LONG" | "EXIT_SHORT";

export type SignalExecutionStatus =
  | "PENDING"
  | "EXECUTED"
  | "REJECTED"
  | "SKIPPED"
  | "EXPIRED";

export interface StrategySignal {
  id:               string;
  strategyId:       string;
  connectionId:     string | null;

  symbol:           string;
  timeframe:        string;
  direction:        SignalDirection;

  signalTime:       string;   // ISO
  barTime:          string;   // ISO (評価対象バーの時刻)
  referencePrice:   number | null;
  suggestedSl:      number | null;
  suggestedTp:      number | null;

  executionStatus:  SignalExecutionStatus;
  commandId:        string | null;  // 実行されたCommandのID

  reason:           Record<string, unknown> | null;
  metadata:         Record<string, unknown> | null;

  createdAt:        string;
}

// -----------------------------------------------------------------
// Strategy Runtime State
//
// strategy_registry.status（lifecycle）とは分離。
// Runtime Engineが自動更新する実行状態。
// -----------------------------------------------------------------

export type StrategyRuntimeStatus =
  | "STOPPED"
  | "STARTING"
  | "RUNNING"
  | "PAUSING"
  | "PAUSED"
  | "ERROR";

export interface StrategyRuntimeState {
  strategyId:       string;
  connectionId:     string | null;

  runtimeStatus:    StrategyRuntimeStatus;

  startedAt:        string | null;
  stoppedAt:        string | null;
  lastEvaluatedAt:  string | null;
  lastSignalAt:     string | null;
  lastBarTime:      string | null;
  lastError:        string | null;

  runtimeVersion:   number;

  createdAt:        string;
  updatedAt:        string;
}

// -----------------------------------------------------------------
// Live Position (MT5 Position Mirror)
//
// Source of Truth = MT5/Broker
// このDBレコードはMirrorであり、MT5と定期同期が必要。
// -----------------------------------------------------------------

export type LivePositionStatus = "OPEN" | "CLOSED" | "PARTIAL";

export interface LivePosition {
  id:               string;
  userId:           string;
  connectionId:     string;
  strategyId:       string | null;
  magicNumber:      number | null;

  positionTicket:   number;
  symbol:           string;
  direction:        "BUY" | "SELL";

  volume:           number;
  openPrice:        number;
  currentPrice:     number | null;
  stopLoss:         number | null;
  takeProfit:       number | null;

  unrealizedPnl:    number | null;
  commission:       number | null;
  swap:             number | null;

  openedAt:         string | null;
  closedAt:         string | null;

  status:           LivePositionStatus;

  openCommandId:    string | null;
  closeCommandId:   string | null;

  lastSyncedAt:     string;
}

// -----------------------------------------------------------------
// Live Deal (MT5 Deal History)
//
// Live Performance計算の基盤データ。
// DEAL_ENTRY_IN（エントリー）とDEAL_ENTRY_OUT（決済）を分離記録。
// -----------------------------------------------------------------

export type DealType = "BUY" | "SELL";
export type DealEntryType = "IN" | "OUT" | "INOUT";

export interface LiveDeal {
  id:               string;
  userId:           string;
  connectionId:     string;
  strategyId:       string | null;
  magicNumber:      number | null;

  dealTicket:       number;
  orderTicket:      number | null;
  positionTicket:   number | null;

  symbol:           string;
  dealType:         DealType;
  entryType:        DealEntryType | null;

  volume:           number;
  price:            number;
  profit:           number | null;
  commission:       number | null;
  swap:             number | null;

  dealTime:         string;   // ISO

  commandId:        string | null;

  syncedAt:         string;
}

// -----------------------------------------------------------------
// Gateway Payload Types (Bridge EA ↔ Gateway)
//
// 既存Gatewayとの後方互換を維持しつつ、
// Execution CommandをBridge EA向けに提供する形式。
// -----------------------------------------------------------------

/** Gateway が Bridge EA に返す Pending Command の形式 */
export interface GatewayCommandPayload {
  id:             string;   // command_id (Idempotency Key)
  action:         ExecutionAction;
  symbol:         string;
  volume:         number | null;
  magic:          number;
  requestedPrice: number | null;
  stopLoss:       number | null;
  takeProfit:     number | null;
  positionTicket: number | null;
  expiresAt:      string;  // ISO
  createdAt:      string;  // ISO
}

/** Bridge EA が Gateway に返す Result の形式 */
export interface GatewayResultPayload {
  commandId:      string;
  success:        boolean;
  retcode:        number;
  orderTicket:    number | null;
  dealTicket:     number | null;
  positionTicket: number | null;
  executionPrice: number | null;
  executedVolume: number | null;
  errorMessage:   string | null;
  brokerTime:     string | null;
}

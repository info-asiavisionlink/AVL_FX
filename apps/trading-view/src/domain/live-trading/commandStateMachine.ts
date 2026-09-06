// =================================================================
// Command State Machine — STAGE 3-A
//
// 有効な状態遷移のみを許可する。
// Terminal Stateに一度到達したCommandは再実行不可。
//
// PENDING   → CLAIMED, EXPIRED, CANCELLED
// CLAIMED   → EXECUTING, FAILED, REJECTED, CANCELLED
// EXECUTING → FILLED, FAILED, REJECTED
//
// Terminal States (再遷移不可):
//   FILLED / REJECTED / FAILED / EXPIRED / CANCELLED
// =================================================================

import type { ExecutionCommandStatus } from "./types";
import { isTerminalStatus } from "./types";

// -----------------------------------------------------------------
// 有効な遷移マップ
// -----------------------------------------------------------------

const VALID_TRANSITIONS: Record<ExecutionCommandStatus, ReadonlySet<ExecutionCommandStatus>> = {
  PENDING:    new Set(["CLAIMED", "EXPIRED", "CANCELLED"]),
  CLAIMED:    new Set(["EXECUTING", "FAILED", "REJECTED", "CANCELLED"]),
  EXECUTING:  new Set(["FILLED", "FAILED", "REJECTED"]),
  // Terminal States — 遷移先なし
  FILLED:     new Set(),
  REJECTED:   new Set(),
  FAILED:     new Set(),
  EXPIRED:    new Set(),
  CANCELLED:  new Set(),
};

// -----------------------------------------------------------------
// State Machine エラー型
// -----------------------------------------------------------------

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: ExecutionCommandStatus,
    public readonly to: ExecutionCommandStatus,
    public readonly commandId: string,
  ) {
    super(
      `Invalid state transition: ${from} → ${to} (commandId: ${commandId})`
    );
    this.name = "InvalidStateTransitionError";
  }
}

// -----------------------------------------------------------------
// 遷移可否チェック（例外なし版）
// -----------------------------------------------------------------

export function canTransition(
  from: ExecutionCommandStatus,
  to: ExecutionCommandStatus,
): boolean {
  if (isTerminalStatus(from)) return false;
  return VALID_TRANSITIONS[from].has(to);
}

// -----------------------------------------------------------------
// 遷移実行（例外あり版）
// -----------------------------------------------------------------

export function transition(
  from: ExecutionCommandStatus,
  to: ExecutionCommandStatus,
  commandId: string,
): ExecutionCommandStatus {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to, commandId);
  }
  return to;
}

// -----------------------------------------------------------------
// 期限切れチェック
// -----------------------------------------------------------------

export function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt) <= new Date();
}

// -----------------------------------------------------------------
// PENDING Command を EXPIRED に遷移すべきか判定
// -----------------------------------------------------------------

export function shouldExpire(
  status: ExecutionCommandStatus,
  expiresAt: string,
): boolean {
  if (status !== "PENDING") return false;
  return isExpired(expiresAt);
}

// -----------------------------------------------------------------
// State情報ユーティリティ
// -----------------------------------------------------------------

export function getValidTransitions(
  from: ExecutionCommandStatus,
): ExecutionCommandStatus[] {
  return Array.from(VALID_TRANSITIONS[from]);
}

export { isTerminalStatus };

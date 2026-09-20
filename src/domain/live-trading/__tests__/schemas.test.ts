/**
 * Live Trading Schema Validation Tests — STAGE 3-A
 *
 * 実行方法:
 *   npx tsx src/domain/live-trading/__tests__/schemas.test.ts
 */

import assert from "node:assert/strict";
import {
  CreateExecutionCommandSchema,
  ExecutionResultSchema,
  CreateMT5ConnectionSchema,
  CreateStrategySignalSchema,
} from "../schemas";

// ─── Test runner ────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

const FUTURE_ISO = new Date(Date.now() + 60_000).toISOString();
const PAST_ISO   = new Date(Date.now() - 60_000).toISOString();

const BASE_BUY = {
  commandId:    "123e4567-e89b-12d3-a456-426614174000",
  connectionId: "223e4567-e89b-12d3-a456-426614174001",
  strategyId:   "323e4567-e89b-12d3-a456-426614174002",
  magicNumber:  20001,
  action:       "BUY" as const,
  symbol:       "EURUSD",
  volume:       0.10,
  stopLoss:     1.08000,
  takeProfit:   1.09500,
  expiresAt:    FUTURE_ISO,
};

// ─── BUY validation ──────────────────────────────────────────────
console.log("\n[BUY Command Validation]");

test("valid BUY command passes", () => {
  const r = CreateExecutionCommandSchema.safeParse(BASE_BUY);
  assert.equal(r.success, true);
});

test("BUY without volume fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, volume: undefined });
  assert.equal(r.success, false);
});

test("BUY with volume=0 fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, volume: 0 });
  assert.equal(r.success, false);
});

test("BUY with negative volume fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, volume: -0.1 });
  assert.equal(r.success, false);
});

// ─── SELL validation ─────────────────────────────────────────────
console.log("\n[SELL Command Validation]");

test("valid SELL command passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({
    ...BASE_BUY,
    commandId:  "423e4567-e89b-12d3-a456-426614174003",
    action:     "SELL",
    magicNumber: 20002,
  });
  assert.equal(r.success, true);
});

test("SELL without volume fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({
    ...BASE_BUY, action: "SELL", volume: undefined,
  });
  assert.equal(r.success, false);
});

// ─── CLOSE validation ────────────────────────────────────────────
console.log("\n[CLOSE Command Validation]");

test("valid CLOSE command passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({
    commandId:    "523e4567-e89b-12d3-a456-426614174004",
    connectionId: BASE_BUY.connectionId,
    strategyId:   BASE_BUY.strategyId,
    magicNumber:  20001,
    action:       "CLOSE",
    symbol:       "EURUSD",
    positionTicket: 123456789,
    expiresAt:    FUTURE_ISO,
  });
  assert.equal(r.success, true);
});

test("CLOSE without positionTicket fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({
    ...BASE_BUY, action: "CLOSE", positionTicket: undefined,
  });
  assert.equal(r.success, false);
});

// ─── MODIFY_SL validation ────────────────────────────────────────
console.log("\n[MODIFY_SL/TP Validation]");

test("valid MODIFY_SL passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({
    commandId:      "623e4567-e89b-12d3-a456-426614174005",
    connectionId:   BASE_BUY.connectionId,
    strategyId:     BASE_BUY.strategyId,
    magicNumber:    20001,
    action:         "MODIFY_SL",
    symbol:         "EURUSD",
    positionTicket: 123456789,
    stopLoss:       1.08500,
    expiresAt:      FUTURE_ISO,
  });
  assert.equal(r.success, true);
});

test("MODIFY_SL without positionTicket fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({
    ...BASE_BUY, action: "MODIFY_SL", stopLoss: 1.085,
  });
  assert.equal(r.success, false);
});

test("MODIFY_SL without stopLoss fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({
    ...BASE_BUY, action: "MODIFY_SL", positionTicket: 123, stopLoss: undefined,
  });
  assert.equal(r.success, false);
});

// ─── Expiry ──────────────────────────────────────────────────────
console.log("\n[Expiry Validation]");

test("past expiresAt fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, expiresAt: PAST_ISO });
  assert.equal(r.success, false);
});

test("future expiresAt passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, expiresAt: FUTURE_ISO });
  assert.equal(r.success, true);
});

// ─── Magic Number ────────────────────────────────────────────────
console.log("\n[Magic Number Validation]");

test("magicNumber 20001 passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, magicNumber: 20001 });
  assert.equal(r.success, true);
});

test("magicNumber 29999 passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, magicNumber: 29999 });
  assert.equal(r.success, true);
});

test("magicNumber 20000 (below range) fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, magicNumber: 20000 });
  assert.equal(r.success, false);
});

test("magicNumber 30000 (above range) fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, magicNumber: 30000 });
  assert.equal(r.success, false);
});

test("magicNumber float fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, magicNumber: 20001.5 });
  assert.equal(r.success, false);
});

// ─── Symbol validation ───────────────────────────────────────────
console.log("\n[Symbol Validation]");

test("valid symbol EURUSD passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, symbol: "EURUSD" });
  assert.equal(r.success, true);
});

test("valid symbol XAUUSD passes", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, symbol: "XAUUSD" });
  assert.equal(r.success, true);
});

test("empty symbol fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, symbol: "" });
  assert.equal(r.success, false);
});

test("lowercase symbol fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, symbol: "eurusd" });
  assert.equal(r.success, false);
});

// ─── UUID validation ─────────────────────────────────────────────
console.log("\n[UUID Validation]");

test("invalid commandId (non-UUID) fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, commandId: "not-a-uuid" });
  assert.equal(r.success, false);
});

test("invalid strategyId fails", () => {
  const r = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, strategyId: "bad" });
  assert.equal(r.success, false);
});

// ─── Multi Strategy isolation ───────────────────────────────────
console.log("\n[Multi Strategy — magic_number isolation]");

test("Strategy A and B have different magicNumbers", () => {
  const stratA = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, magicNumber: 20001, strategyId: "323e4567-e89b-12d3-a456-426614174002" });
  const stratB = CreateExecutionCommandSchema.safeParse({ ...BASE_BUY, magicNumber: 20002, strategyId: "423e4567-e89b-12d3-a456-426614174002", commandId: "523e4567-e89b-12d3-a456-426614174002" });
  assert.equal(stratA.success, true);
  assert.equal(stratB.success, true);
  if (stratA.success && stratB.success) {
    assert.notEqual(stratA.data.magicNumber, stratB.data.magicNumber);
    assert.notEqual(stratA.data.strategyId, stratB.data.strategyId);
  }
});

// ─── Execution Result Schema ─────────────────────────────────────
console.log("\n[Execution Result Schema]");

test("valid FILLED result passes", () => {
  const r = ExecutionResultSchema.safeParse({
    commandId:      "cmd-001",
    success:        true,
    retcode:        0,
    orderTicket:    111111,
    dealTicket:     222222,
    positionTicket: 333333,
    executionPrice: 1.08500,
    executedVolume: 0.10,
    receivedAt:     FUTURE_ISO,
  });
  assert.equal(r.success, true);
});

test("valid FAILED result passes", () => {
  const r = ExecutionResultSchema.safeParse({
    commandId:    "cmd-002",
    success:      false,
    retcode:      10004,
    errorCode:    10004,
    errorMessage: "Requote",
    receivedAt:   FUTURE_ISO,
  });
  assert.equal(r.success, true);
});

// ─── MT5 Connection Schema ────────────────────────────────────────
console.log("\n[MT5 Connection Schema]");

test("valid DEMO connection passes", () => {
  const r = CreateMT5ConnectionSchema.safeParse({
    broker:      "XM",
    serverName:  "XMGlobal-Demo",
    mt5Login:    12345678,
    accountType: "DEMO",
  });
  assert.equal(r.success, true);
});

test("invalid account type fails", () => {
  const r = CreateMT5ConnectionSchema.safeParse({
    broker:      "XM",
    serverName:  "XMGlobal-Demo",
    mt5Login:    12345678,
    accountType: "TEST",  // invalid
  });
  assert.equal(r.success, false);
});

// ─── Strategy Signal Schema ───────────────────────────────────────
console.log("\n[Strategy Signal Schema]");

test("valid BUY signal passes", () => {
  const r = CreateStrategySignalSchema.safeParse({
    strategyId:   "323e4567-e89b-12d3-a456-426614174002",
    symbol:       "EURUSD",
    timeframe:    "H1",
    direction:    "BUY",
    signalTime:   new Date().toISOString(),
    barTime:      new Date(Date.now() - 3600_000).toISOString(),
    referencePrice: 1.08500,
    suggestedSl:  1.08000,
    suggestedTp:  1.09500,
  });
  assert.equal(r.success, true);
});

test("invalid direction fails", () => {
  const r = CreateStrategySignalSchema.safeParse({
    strategyId:  "323e4567-e89b-12d3-a456-426614174002",
    symbol:      "EURUSD",
    timeframe:   "H1",
    direction:   "HOLD",  // invalid
    signalTime:  new Date().toISOString(),
    barTime:     new Date().toISOString(),
  });
  assert.equal(r.success, false);
});

// ─── Summary ─────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Schema Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

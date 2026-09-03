/**
 * Command State Machine Tests — STAGE 3-A
 *
 * 実行方法:
 *   npx tsx src/domain/live-trading/__tests__/commandStateMachine.test.ts
 */

import assert from "node:assert/strict";
import {
  canTransition,
  transition,
  InvalidStateTransitionError,
  isExpired,
  shouldExpire,
  getValidTransitions,
} from "../commandStateMachine";
import { isTerminalStatus, TERMINAL_STATUSES } from "../types";
import type { ExecutionCommandStatus } from "../types";

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

// ─── Terminal Status Tests ───────────────────────────────────────
console.log("\n[Terminal Status]");

test("FILLED is terminal", () => {
  assert.equal(isTerminalStatus("FILLED"), true);
});
test("REJECTED is terminal", () => {
  assert.equal(isTerminalStatus("REJECTED"), true);
});
test("FAILED is terminal", () => {
  assert.equal(isTerminalStatus("FAILED"), true);
});
test("EXPIRED is terminal", () => {
  assert.equal(isTerminalStatus("EXPIRED"), true);
});
test("CANCELLED is terminal", () => {
  assert.equal(isTerminalStatus("CANCELLED"), true);
});
test("PENDING is not terminal", () => {
  assert.equal(isTerminalStatus("PENDING"), false);
});
test("CLAIMED is not terminal", () => {
  assert.equal(isTerminalStatus("CLAIMED"), false);
});
test("EXECUTING is not terminal", () => {
  assert.equal(isTerminalStatus("EXECUTING"), false);
});
test("TERMINAL_STATUSES has exactly 5 members", () => {
  assert.equal(TERMINAL_STATUSES.size, 5);
});

// ─── Valid Transitions ───────────────────────────────────────────
console.log("\n[Valid Transitions]");

const validCases: Array<[ExecutionCommandStatus, ExecutionCommandStatus]> = [
  ["PENDING",   "CLAIMED"],
  ["PENDING",   "EXPIRED"],
  ["PENDING",   "CANCELLED"],
  ["CLAIMED",   "EXECUTING"],
  ["CLAIMED",   "FAILED"],
  ["CLAIMED",   "REJECTED"],
  ["CLAIMED",   "CANCELLED"],
  ["EXECUTING", "FILLED"],
  ["EXECUTING", "FAILED"],
  ["EXECUTING", "REJECTED"],
];

for (const [from, to] of validCases) {
  test(`${from} → ${to} is VALID`, () => {
    assert.equal(canTransition(from, to), true);
  });
}

// ─── Invalid Transitions ─────────────────────────────────────────
console.log("\n[Invalid Transitions]");

const invalidCases: Array<[ExecutionCommandStatus, ExecutionCommandStatus]> = [
  ["FILLED",    "PENDING"],    // Terminal → any
  ["FILLED",    "CLAIMED"],
  ["REJECTED",  "PENDING"],
  ["FAILED",    "PENDING"],
  ["EXPIRED",   "PENDING"],
  ["CANCELLED", "PENDING"],
  ["PENDING",   "FILLED"],     // Skip intermediate steps
  ["PENDING",   "EXECUTING"],
  ["CLAIMED",   "PENDING"],    // Backward
  ["EXECUTING", "PENDING"],
  ["EXECUTING", "CLAIMED"],
  ["EXECUTING", "CANCELLED"],  // Cannot cancel after executing
];

for (const [from, to] of invalidCases) {
  test(`${from} → ${to} is INVALID`, () => {
    assert.equal(canTransition(from, to), false);
  });
}

// ─── transition() throws on invalid ─────────────────────────────
console.log("\n[State Machine Enforcement]");

test("transition() returns new status on valid transition", () => {
  const result = transition("PENDING", "CLAIMED", "cmd-001");
  assert.equal(result, "CLAIMED");
});

test("transition() throws InvalidStateTransitionError on invalid", () => {
  assert.throws(
    () => transition("FILLED", "PENDING", "cmd-002"),
    InvalidStateTransitionError,
  );
});

test("transition() throws on Terminal → any", () => {
  assert.throws(
    () => transition("EXPIRED", "CLAIMED", "cmd-003"),
    InvalidStateTransitionError,
  );
});

test("InvalidStateTransitionError has correct from/to/commandId", () => {
  try {
    transition("REJECTED", "PENDING", "cmd-xyz");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof InvalidStateTransitionError);
    assert.equal(e.from, "REJECTED");
    assert.equal(e.to, "PENDING");
    assert.equal(e.commandId, "cmd-xyz");
  }
});

// ─── Idempotency: Terminal cannot re-transition ──────────────────
console.log("\n[Idempotency — Terminal State]");

const terminals: ExecutionCommandStatus[] = ["FILLED", "REJECTED", "FAILED", "EXPIRED", "CANCELLED"];
const nonTerminals: ExecutionCommandStatus[] = ["PENDING", "CLAIMED", "EXECUTING"];

for (const terminal of terminals) {
  for (const target of nonTerminals) {
    test(`${terminal} cannot transition to ${target}`, () => {
      assert.equal(canTransition(terminal, target), false);
    });
  }
}

// ─── Expiry Tests ────────────────────────────────────────────────
console.log("\n[Expiry]");

test("past expiresAt → isExpired returns true", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(isExpired(past), true);
});

test("future expiresAt → isExpired returns false", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(isExpired(future), false);
});

test("shouldExpire: PENDING + past → true", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(shouldExpire("PENDING", past), true);
});

test("shouldExpire: PENDING + future → false", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(shouldExpire("PENDING", future), false);
});

test("shouldExpire: CLAIMED + past → false (non-PENDING)", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(shouldExpire("CLAIMED", past), false);
});

test("shouldExpire: FILLED + past → false (terminal)", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(shouldExpire("FILLED", past), false);
});

// ─── getValidTransitions ─────────────────────────────────────────
console.log("\n[getValidTransitions]");

test("PENDING has 3 valid transitions", () => {
  const t = getValidTransitions("PENDING");
  assert.equal(t.length, 3);
  assert.ok(t.includes("CLAIMED"));
  assert.ok(t.includes("EXPIRED"));
  assert.ok(t.includes("CANCELLED"));
});

test("FILLED has 0 valid transitions", () => {
  assert.equal(getValidTransitions("FILLED").length, 0);
});

test("EXECUTING has 3 valid transitions", () => {
  const t = getValidTransitions("EXECUTING");
  assert.equal(t.length, 3);
  assert.ok(t.includes("FILLED"));
  assert.ok(t.includes("FAILED"));
  assert.ok(t.includes("REJECTED"));
});

// ─── Summary ─────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`State Machine Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

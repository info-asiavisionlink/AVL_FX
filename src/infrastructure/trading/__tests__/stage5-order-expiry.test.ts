import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createCommandExpiryUtc, COMMAND_EXPIRY_SECONDS, isCommandExpired } from "@/lib/ai-trader/command-expiry";
import { isExpired } from "@/domain/live-trading/commandStateMachine";

const NOW = new Date("2026-09-24T00:00:00.000Z");

test("canonical command expiry is exactly five UTC minutes", () => {
  assert.equal(COMMAND_EXPIRY_SECONDS, 300);
  assert.equal(createCommandExpiryUtc(NOW), "2026-09-24T00:05:00.000Z");
  assert.equal(createCommandExpiryUtc(new Date("2026-09-24T09:00:00+09:00")), "2026-09-24T00:05:00.000Z");
  assert.notEqual(createCommandExpiryUtc(NOW), "2026-09-24T09:05:00.000Z");
});

test("expiry gate is UTC, inclusive, and fail closed", () => {
  const expiry = "2026-09-24T00:05:00.000Z";
  assert.equal(isCommandExpired(expiry, new Date("2026-09-24T00:04:59.999Z")), false);
  assert.equal(isCommandExpired(expiry, new Date("2026-09-24T00:05:00.000Z")), true);
  assert.equal(isCommandExpired(expiry, new Date("2026-09-24T00:05:00.001Z")), true);
  assert.equal(isCommandExpired("", NOW), true);
  assert.equal(isCommandExpired(undefined, NOW), true);
  assert.equal(isCommandExpired("not-a-timestamp", NOW), true);
  assert.equal(isExpired("not-a-timestamp"), true);
  assert.equal(isExpired(expiry), new Date(expiry).getTime() <= Date.now());
});

test("all production expiry boundaries contain no fixed JST offset and EA fails closed", () => {
  const risk = readFileSync("src/lib/ai-trader/risk-engine.ts", "utf8");
  const runtime = readFileSync("src/lib/ai-trader/runtime-service.ts", "utf8");
  const ea = readFileSync("ea/AVL_ExecutionBridge.mq5", "utf8");
  assert.equal(risk.includes("9 * 3600"), false);
  assert.match(risk, /createCommandExpiryUtc\(\)/);
  assert.match(runtime, /expires_at:\s*createCommandExpiryUtc\(\)/);
  assert.equal(ea.includes("9 * 3600"), false);
  assert.match(ea, /StringLen\(expiresAt\) == 0/);
  assert.match(ea, /expiry <= 0/);
  assert.match(ea, /TimeCurrent\(\) >= expiry/);
});

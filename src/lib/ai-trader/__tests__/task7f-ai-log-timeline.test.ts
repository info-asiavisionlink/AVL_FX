import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeTimeline, sanitizeTimelineLog } from "../timeline";

const base = (overrides: Record<string, unknown> = {}) => ({
  id: "log-a", user_id: "user-a", trader_id: "trader-a", ai_trader_version_id: "version-a",
  scenario_id: "scenario-a", position_id: null, command_id: null, trigger_type: "ENTRY_RECHECK",
  analysis_type: "ENTRY_RECHECK", decision: "WAIT", market_timestamp: "2026-01-01T00:00:00Z",
  market_context: { connection_id: "connection-a", symbol: "GOLD", secret: "must-not-leak" },
  reasoning_summary: "条件未成立のため待機", error: null, created_at: "2026-01-01T00:00:00Z",
  ai_traders: { name: "A trader", market: "GOLD", user_id: "user-a" }, ...overrides,
}) as any;

test("Task 7F: all decision triggers are user-safe timeline entries", () => {
  for (const trigger of ["HOURLY_ANALYSIS", "ENTRY_RECHECK", "TP_RECHECK", "SL_RECHECK", "POSITION_REVIEW", "MANUAL_APPROVAL"]) {
    const entry = sanitizeTimelineLog(base({ id: trigger, trigger_type: trigger, decision: "HOLD" }));
    assert.ok(entry); assert.equal(entry.trigger, trigger); assert.equal(entry.connection_id, "connection-a");
  }
});
test("Task 7F: owner mismatch is rejected", () => { assert.equal(sanitizeTimelineLog(base({ ai_traders: { user_id: "user-b" } })), null); });
test("Task 7F: secrets and raw context are not serialized", () => { const entry = sanitizeTimelineLog(base())!; assert.equal((entry as any).secret, undefined); assert.equal((entry.market_context as any).secret, undefined); });
test("Task 7F: command, position, scenario and version correlation is preserved", () => { const e = sanitizeTimelineLog(base({ command_id: "command-a", position_id: "position-a" }))!; assert.equal(e.command_id, "command-a"); assert.equal(e.position_id, "position-a"); assert.equal(e.scenario_id, "scenario-a"); assert.equal(e.trader_version_id, "version-a"); });
test("Task 7F: duplicate timeline rows are suppressed", () => { const e = sanitizeTimelineLog(base())!; assert.equal(dedupeTimeline([e, { ...e, id: "retry-row" }]).length, 1); });
test("Task 7F: error remains visible and is not an empty success", () => { const e = sanitizeTimelineLog(base({ decision: "ERROR", error: "RISK_DENY", reasoning_summary: null }))!; assert.equal(e.error, "RISK_DENY"); assert.match(e.reasoning, /見送り/); });
test("Task 7F: provider exception text is redacted", () => { const e = sanitizeTimelineLog(base({ error: "Error: Authorization Bearer super-secret\n at provider.js:1" }))!; assert.doesNotMatch(e.error ?? "", /Bearer|super-secret|provider\.js/); });

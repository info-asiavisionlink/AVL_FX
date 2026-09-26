import assert from "node:assert/strict";
import test from "node:test";
import {
  entryIdempotencyKey,
  isClosedBar,
  normalizeScenarioState,
  positionReviewIdempotencyKey,
  validatePositionDecision,
} from "../core-runtime";

test("closed-bar gate rejects forming bars and accepts completed bars", () => {
  const now = 3_600_000;
  assert.equal(isClosedBar(3_300_000, "M5", now), true);
  assert.equal(isClosedBar(3_450_000, "M5", now), false);
  assert.equal(isClosedBar(0, "M5", now), false);
});

test("runtime idempotency keys are stable and scoped", () => {
  assert.equal(entryIdempotencyKey("t", "s", "PRICE_ENTERS_ZONE", 100), "ENTRY:t:s:PRICE_ENTERS_ZONE:100");
  assert.equal(positionReviewIdempotencyKey("p", "TP_RECHECK", 100), "POSITION_REVIEW:p:TP_RECHECK:100");
});

test("position decisions and legacy scenario states are canonicalized", () => {
  assert.equal(validatePositionDecision("CLOSE"), "CLOSE");
  assert.equal(validatePositionDecision("ENTER_LONG"), null);
  assert.equal(normalizeScenarioState("INVALID"), "INVALIDATED");
  assert.equal(normalizeScenarioState("CONSIDERING"), "TRIGGERED");
});

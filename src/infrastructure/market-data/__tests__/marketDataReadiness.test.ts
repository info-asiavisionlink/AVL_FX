/**
 * Data Phase C — Market Data Readiness Tests (C01–C30+)
 *
 * 対象: marketDataReadiness.ts の pure functions
 *
 * 実行方法:
 *   npx tsx src/infrastructure/market-data/__tests__/marketDataReadiness.test.ts
 */

import assert from "node:assert/strict";
import {
  getReadiness,
  getCoveragePercent,
  getReadinessNote,
  isValidRange,
  countFullReady,
  countActiveJobs,
} from "../marketDataReadiness";

// ------------------------------------------------------------------
// Test runner (same pattern as existing test files)
// ------------------------------------------------------------------

let passed = 0, failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}\n     ${msg}`);
    failed++;
  }
}

function describe(name: string, fn: () => void) {
  console.log(`\n📊 ${name}`);
  fn();
}

// ------------------------------------------------------------------
// Tests — getReadiness
// ------------------------------------------------------------------

describe("C01–C12: getReadiness — boundary values", () => {
  test("C01: spanDays=0 → NOT_READY", () => {
    assert.equal(getReadiness(0), "NOT_READY");
  });

  test("C02: spanDays=59.9 → NOT_READY", () => {
    assert.equal(getReadiness(59.9), "NOT_READY");
  });

  test("C03: spanDays=60 → MONTE_CARLO_READY", () => {
    assert.equal(getReadiness(60), "MONTE_CARLO_READY");
  });

  test("C04: spanDays=89.9 → MONTE_CARLO_READY", () => {
    assert.equal(getReadiness(89.9), "MONTE_CARLO_READY");
  });

  test("C05: spanDays=90 → OPTIMIZATION_READY", () => {
    assert.equal(getReadiness(90), "OPTIMIZATION_READY");
  });

  test("C06: spanDays=179.9 → OPTIMIZATION_READY", () => {
    assert.equal(getReadiness(179.9), "OPTIMIZATION_READY");
  });

  test("C07: spanDays=180 → WALK_FORWARD_READY", () => {
    assert.equal(getReadiness(180), "WALK_FORWARD_READY");
  });

  test("C08: spanDays=364.9 → WALK_FORWARD_READY", () => {
    assert.equal(getReadiness(364.9), "WALK_FORWARD_READY");
  });

  test("C09: spanDays=365 → FULL_READY", () => {
    assert.equal(getReadiness(365), "FULL_READY");
  });

  test("C10: spanDays=1000 → FULL_READY", () => {
    assert.equal(getReadiness(1000), "FULL_READY");
  });

  test("C11: negative spanDays → NOT_READY", () => {
    assert.equal(getReadiness(-1), "NOT_READY");
    assert.equal(getReadiness(-999), "NOT_READY");
  });

  test("C12: non-finite / invalid input → NOT_READY", () => {
    assert.equal(getReadiness(NaN),      "NOT_READY");
    assert.equal(getReadiness(Infinity), "NOT_READY");
    assert.equal(getReadiness(-Infinity),"NOT_READY");
  });
});

// ------------------------------------------------------------------
// Tests — getCoveragePercent
// ------------------------------------------------------------------

describe("C13–C17: getCoveragePercent", () => {
  test("C13: 365 days → 100%", () => {
    assert.equal(getCoveragePercent(365), 100);
  });

  test("C14: >365 days → clamped to 100%", () => {
    assert.equal(getCoveragePercent(730), 100);
    assert.equal(getCoveragePercent(10000), 100);
  });

  test("C15: 0 days → 0%", () => {
    assert.equal(getCoveragePercent(0), 0);
  });

  test("C16: 182.5 days ≈ 50%", () => {
    const pct = getCoveragePercent(182.5);
    assert.ok(pct >= 49.5 && pct <= 50.5, `expected ~50%, got ${pct}`);
  });

  test("C17: negative / non-finite → 0%", () => {
    assert.equal(getCoveragePercent(-10),    0);
    assert.equal(getCoveragePercent(NaN),    0);
    assert.equal(getCoveragePercent(-Infinity), 0);
  });
});

// ------------------------------------------------------------------
// Tests — getReadinessNote
// ------------------------------------------------------------------

describe("C18–C22: getReadinessNote", () => {
  test("C18: NOT_READY note contains days needed", () => {
    const note = getReadinessNote("NOT_READY", 0);
    assert.ok(note.includes("60"), `expected '60' in note: "${note}"`);
  });

  test("C19: MONTE_CARLO_READY note mentions Optimization", () => {
    const note = getReadinessNote("MONTE_CARLO_READY", 75);
    assert.ok(note.toLowerCase().includes("optimiz"), `expected 'optimiz' in note: "${note}"`);
  });

  test("C20: OPTIMIZATION_READY note mentions Walk-Forward", () => {
    const note = getReadinessNote("OPTIMIZATION_READY", 120);
    assert.ok(note.toLowerCase().includes("walk"), `expected 'walk' in note: "${note}"`);
  });

  test("C21: WALK_FORWARD_READY note mentions Full", () => {
    const note = getReadinessNote("WALK_FORWARD_READY", 200);
    assert.ok(note.toLowerCase().includes("full"), `expected 'full' in note: "${note}"`);
  });

  test("C22: FULL_READY note is positive confirmation", () => {
    const note = getReadinessNote("FULL_READY", 365);
    assert.ok(note.length > 0, "note should not be empty");
    assert.ok(note.toLowerCase().includes("full"), `expected 'full' in note: "${note}"`);
  });
});

// ------------------------------------------------------------------
// Tests — isValidRange
// ------------------------------------------------------------------

describe("C23–C26: isValidRange", () => {
  test("C23: valid range → true", () => {
    assert.ok(isValidRange("2024-01-01T00:00:00Z", "2025-01-01T00:00:00Z"));
  });

  test("C24: null/undefined inputs → false (NO DATA handling)", () => {
    assert.ok(!isValidRange(null, "2025-01-01T00:00:00Z"));
    assert.ok(!isValidRange("2024-01-01T00:00:00Z", null));
    assert.ok(!isValidRange(null, null));
    assert.ok(!isValidRange(undefined, undefined));
  });

  test("C25: newest < oldest (inverted) → false", () => {
    assert.ok(!isValidRange("2025-01-01T00:00:00Z", "2024-01-01T00:00:00Z"));
  });

  test("C26: oldest === newest → false (zero-span range)", () => {
    const ts = "2024-06-01T00:00:00Z";
    assert.ok(!isValidRange(ts, ts));
  });
});

// ------------------------------------------------------------------
// Tests — countFullReady / countActiveJobs
// ------------------------------------------------------------------

describe("C27–C30: summary count calculation", () => {
  test("C27: countFullReady counts correct entries", () => {
    const entries = [
      { spanDays: 400 }, // FULL_READY
      { spanDays: 200 }, // WALK_FORWARD_READY
      { spanDays: 500 }, // FULL_READY
      { spanDays: 50  }, // NOT_READY
    ];
    assert.equal(countFullReady(entries), 2);
  });

  test("C28: countFullReady with empty array → 0", () => {
    assert.equal(countFullReady([]), 0);
  });

  test("C29: countActiveJobs counts PENDING and RUNNING", () => {
    const jobs = [
      { status: "PENDING"   },
      { status: "RUNNING"   },
      { status: "COMPLETED" },
      { status: "FAILED"    },
      { status: "PAUSED"    },
      { status: "PENDING"   },
    ];
    assert.equal(countActiveJobs(jobs), 3);
  });

  test("C30: countActiveJobs with no active jobs → 0", () => {
    const jobs = [
      { status: "COMPLETED" },
      { status: "FAILED"    },
    ];
    assert.equal(countActiveJobs(jobs), 0);
  });
});

// ------------------------------------------------------------------
// Additional edge cases
// ------------------------------------------------------------------

describe("C31–C36: Additional edge cases", () => {
  test("C31: exact boundary 59.999... → NOT_READY", () => {
    assert.equal(getReadiness(59.999), "NOT_READY");
  });

  test("C32: getCoveragePercent precision — 91.25 days ≈ 25%", () => {
    const pct = getCoveragePercent(91.25);
    assert.ok(pct >= 24 && pct <= 26, `expected ~25%, got ${pct}`);
  });

  test("C33: NOT_READY note with partial data (30 days) shows remaining days", () => {
    const note = getReadinessNote("NOT_READY", 30);
    assert.ok(note.includes("30"), `expected remaining '30' days in note: "${note}"`);
  });

  test("C34: WALK_FORWARD_READY note shows exact days needed", () => {
    const note = getReadinessNote("WALK_FORWARD_READY", 300);
    assert.ok(note.includes("65"), `expected '65' days in note: "${note}"`);
  });

  test("C35: countFullReady when all entries are NOT_READY → 0", () => {
    const entries = [{ spanDays: 10 }, { spanDays: 30 }, { spanDays: 50 }];
    assert.equal(countFullReady(entries), 0);
  });

  test("C36: isValidRange with invalid date strings → false", () => {
    assert.ok(!isValidRange("not-a-date", "2025-01-01T00:00:00Z"));
    assert.ok(!isValidRange("2024-01-01T00:00:00Z", "not-a-date"));
  });
});

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------

setTimeout(() => {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`Data Phase C Readiness Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
}, 0);

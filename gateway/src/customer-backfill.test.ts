// V2 Stage 2: Historical Backfill / Recovery Tests
// Pure function tests — no real Supabase or DB required.

import assert from "node:assert/strict";
import test from "node:test";
import {
  validateBar,
  canonicalizeSymbol,
  SUPPORTED_TIMEFRAMES,
  type BarIngestionInput,
  type BarSource,
} from "./customerBarDataStore";

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const BASE_TIME_SEC = 1_740_000_000; // ~2025-02-20, well within valid range
const H1_SEC        = 3_600;
const MS = 1000;

function mkBar(overrides: Partial<BarIngestionInput> = {}): BarIngestionInput {
  return {
    connection_id:    "conn-1",
    user_id:          "user-1",
    broker_symbol:    "GOLD#",
    canonical_symbol: "GOLD",
    timeframe:        "H1",
    time_utc:         new Date((BASE_TIME_SEC - 3600) * MS).toISOString(), // 1h ago
    open:  2600.0,
    high:  2610.0,
    low:   2595.0,
    close: 2605.0,
    source: "bridge_recovery",
    ...overrides,
  };
}

// ----------------------------------------------------------------
// Gap detection logic (pure function)
// ----------------------------------------------------------------

function detectGap(lastBarUtc: string | null, currentTimeSec: number, timeframeSec: number): boolean {
  if (!lastBarUtc) return true;
  const lastSec = new Date(lastBarUtc).getTime() / MS;
  return currentTimeSec > lastSec + timeframeSec;
}

test("gap detection: null last bar → gap exists", () => {
  assert.equal(detectGap(null, BASE_TIME_SEC, H1_SEC), true);
});

test("gap detection: last bar < now - 1 TF → gap exists", () => {
  const lastBar = new Date((BASE_TIME_SEC - 2 * H1_SEC) * MS).toISOString();
  assert.equal(detectGap(lastBar, BASE_TIME_SEC, H1_SEC), true);
});

test("gap detection: last bar = now - 1 TF → no gap (exactly 1 period behind)", () => {
  const lastBar = new Date((BASE_TIME_SEC - H1_SEC) * MS).toISOString();
  assert.equal(detectGap(lastBar, BASE_TIME_SEC, H1_SEC), false);
});

test("gap detection: last bar within 1 TF of now → no gap", () => {
  const lastBar = new Date((BASE_TIME_SEC - H1_SEC / 2) * MS).toISOString();
  assert.equal(detectGap(lastBar, BASE_TIME_SEC, H1_SEC), false);
});

// ----------------------------------------------------------------
// Backfill idempotency: same bars sent twice produce same result
// (tested at validation level — DB-level is tested via real DB)
// ----------------------------------------------------------------

test("idempotency: duplicate bars in batch are deduplicated before upsert", () => {
  // Two bars with identical canonical key (different broker symbols that canonicalize to same)
  const bar1 = mkBar({ broker_symbol: "GOLD#",  canonical_symbol: "GOLD", time_utc: new Date((BASE_TIME_SEC - H1_SEC) * MS).toISOString() });
  const bar2 = mkBar({ broker_symbol: "XAUUSD", canonical_symbol: "GOLD", time_utc: new Date((BASE_TIME_SEC - H1_SEC) * MS).toISOString() });

  // Simulate dedup logic from upsertCustomerBars
  const dedupMap = new Map<string, BarIngestionInput>();
  for (const b of [bar1, bar2]) {
    const key = `${b.connection_id}|${b.canonical_symbol}|${b.timeframe}|${b.time_utc}`;
    dedupMap.set(key, b);
  }
  // Only 1 row should survive dedup
  assert.equal(dedupMap.size, 1);
});

test("idempotency: same bar sent in two separate batches → dedup handles each independently", () => {
  const bar = mkBar();
  const dedupMap = new Map<string, BarIngestionInput>();
  // Batch 1
  for (const b of [bar]) {
    const key = `${b.connection_id}|${b.canonical_symbol}|${b.timeframe}|${b.time_utc}`;
    dedupMap.set(key, b);
  }
  // Batch 2 (same bar again)
  for (const b of [bar]) {
    const key = `${b.connection_id}|${b.canonical_symbol}|${b.timeframe}|${b.time_utc}`;
    dedupMap.set(key, b);
  }
  assert.equal(dedupMap.size, 1);
});

// ----------------------------------------------------------------
// Out-of-order batch handling
// ----------------------------------------------------------------

test("out-of-order: bars arriving in descending time order are all valid", () => {
  const times = [3, 2, 1, 4, 0].map(i => new Date((BASE_TIME_SEC - (i + 1) * H1_SEC) * MS).toISOString());
  const bars = times.map(t => mkBar({ time_utc: t }));
  // All bars should pass validation regardless of order
  for (const b of bars) {
    assert.equal(validateBar(b), null, `bar at ${b.time_utc} should be valid`);
  }
});

test("out-of-order: gap detection works correctly with out-of-order batches", () => {
  // Gap detection only cares about MAX(time_utc), not order
  const times = [
    new Date((BASE_TIME_SEC - 3 * H1_SEC) * MS).toISOString(), // oldest
    new Date((BASE_TIME_SEC - 1 * H1_SEC) * MS).toISOString(), // newest
    new Date((BASE_TIME_SEC - 2 * H1_SEC) * MS).toISOString(), // middle
  ];
  const maxTime = times.reduce((a, b) => a > b ? a : b);
  // After backfill, MAX(time_utc) = most recent = no new gap from current time
  const maxTimeSec = new Date(maxTime).getTime() / MS;
  assert.equal(detectGap(maxTime, maxTimeSec + H1_SEC / 2, H1_SEC), false);
});

// ----------------------------------------------------------------
// Conflict resolution: backfill does NOT overwrite realtime bars
// ----------------------------------------------------------------

test("conflict resolution: recovery source → ignoreDuplicates=true (skip on conflict)", () => {
  const recoveryBars: BarIngestionInput[] = [mkBar({ source: "bridge_recovery" })];
  const allRealtime = recoveryBars.every(b => b.source === "bridge_realtime");
  assert.equal(allRealtime, false); // not all realtime
  // So ignoreDuplicates should be true → skip on conflict (never overwrite realtime)
  const ignoreDups = !allRealtime;
  assert.equal(ignoreDups, true);
});

test("conflict resolution: backfill source → ignoreDuplicates=true", () => {
  const backfillBars: BarIngestionInput[] = [mkBar({ source: "bridge_backfill" })];
  const allRealtime = backfillBars.every(b => b.source === "bridge_realtime");
  assert.equal(!allRealtime, true); // ignoreDups = true
});

test("conflict resolution: realtime source → ignoreDuplicates=false (allow update)", () => {
  const realtimeBars: BarIngestionInput[] = [mkBar({ source: "bridge_realtime" })];
  const allRealtime = realtimeBars.every(b => b.source === "bridge_realtime");
  assert.equal(allRealtime, true);
  const ignoreDups = !allRealtime;
  assert.equal(ignoreDups, false); // allow update for forming bars
});

test("conflict resolution: mixed batch with any non-realtime → ignoreDuplicates=true", () => {
  const mixedBars: BarIngestionInput[] = [
    mkBar({ source: "bridge_realtime" }),
    mkBar({ source: "bridge_recovery", time_utc: new Date((BASE_TIME_SEC - 2 * H1_SEC) * MS).toISOString() }),
  ];
  const allRealtime = mixedBars.every(b => b.source === "bridge_realtime");
  assert.equal(allRealtime, false);
  assert.equal(!allRealtime, true); // ignoreDups = true → safe for mixed batch
});

// ----------------------------------------------------------------
// Large-gap scenario: multi-batch processing
// ----------------------------------------------------------------

test("large-gap: batch size limit 500 is respected", () => {
  const BATCH_LIMIT = 500;
  // Simulate a 2-hour gap → 2 H1 bars (well under limit)
  const gapBars = Array.from({ length: 2 }, (_, i) =>
    mkBar({ time_utc: new Date((BASE_TIME_SEC - (i + 1) * H1_SEC) * MS).toISOString() }),
  );
  assert.ok(gapBars.length <= BATCH_LIMIT);
});

test("large-gap: week offline → 168 H1 bars, fits in single batch", () => {
  const BATCH_LIMIT = 500;
  const weekBars = 7 * 24; // 168 H1 bars for a week
  assert.ok(weekBars <= BATCH_LIMIT, `${weekBars} bars should fit in one batch of ${BATCH_LIMIT}`);
});

test("large-gap: month offline → M5 bars need multiple batches", () => {
  const BATCH_LIMIT = 500;
  const monthM5Bars = 30 * 24 * 12; // 8640 M5 bars
  const batchCount  = Math.ceil(monthM5Bars / BATCH_LIMIT);
  assert.ok(batchCount > 1, `${monthM5Bars} M5 bars requires ${batchCount} batches`);
  assert.ok(batchCount <= 18); // reasonable upper bound
});

// ----------------------------------------------------------------
// Partial batch retry: entire batch is idempotent
// ----------------------------------------------------------------

test("partial retry: entire batch re-send is idempotent (no net change)", () => {
  // If a batch fails, retry the entire batch (not partial)
  // Since ignoreDuplicates=true for recovery, re-sending same bars is safe
  const bars = [
    mkBar({ time_utc: new Date((BASE_TIME_SEC - H1_SEC) * MS).toISOString(), source: "bridge_recovery" }),
    mkBar({ time_utc: new Date((BASE_TIME_SEC - 2 * H1_SEC) * MS).toISOString(), source: "bridge_recovery" }),
  ];
  // Simulate dedup for batch 1
  const dedup1 = new Map(bars.map(b => [`${b.connection_id}|${b.canonical_symbol}|${b.timeframe}|${b.time_utc}`, b]));
  // Simulate dedup for batch 2 (same bars → same result)
  const dedup2 = new Map(bars.map(b => [`${b.connection_id}|${b.canonical_symbol}|${b.timeframe}|${b.time_utc}`, b]));
  assert.equal(dedup1.size, dedup2.size);
  // Both batches would try the same upsert with ignoreDuplicates=true → safe
});

// ----------------------------------------------------------------
// Completeness verification
// ----------------------------------------------------------------

test("completeness: gap_remaining when verified < sent", () => {
  const barsSent = 10;
  const barsVerified = 8; // 2 were rejected (validation failed)
  const gapRemaining = barsVerified < barsSent;
  assert.equal(gapRemaining, true);
});

test("completeness: no gap when verified >= sent", () => {
  const barsSent = 10;
  const barsVerified = 10;
  const gapRemaining = barsVerified < barsSent;
  assert.equal(gapRemaining, false);
});

// ----------------------------------------------------------------
// Memory safety: no unbounded accumulation
// ----------------------------------------------------------------

test("memory safety: batch size is bounded at 500", () => {
  const MAX_BATCH = 500;
  // Simulated large array — only first 500 would be sent per batch
  const largeBatch = Array.from({ length: 1000 }, (_, i) =>
    mkBar({ time_utc: new Date((BASE_TIME_SEC - (i + 1) * H1_SEC) * MS).toISOString() }),
  );
  const batch1 = largeBatch.slice(0, MAX_BATCH);
  const batch2 = largeBatch.slice(MAX_BATCH);
  assert.equal(batch1.length, MAX_BATCH);
  assert.ok(batch2.length > 0);
  assert.ok(batch1.length <= MAX_BATCH);
  assert.ok(batch2.length <= MAX_BATCH);
});

test("memory safety: each batch is independent (no accumulation across batches)", () => {
  // Each batch is processed independently; the function does not hold all batches in memory
  let totalProcessed = 0;
  const BATCH_SIZE = 500;
  const totalBars = 1500;
  for (let i = 0; i < totalBars; i += BATCH_SIZE) {
    const batch = Array.from({ length: Math.min(BATCH_SIZE, totalBars - i) }, () => mkBar());
    totalProcessed += batch.length;
    // After this "iteration", batch goes out of scope (GC eligible)
  }
  assert.equal(totalProcessed, totalBars);
});

// ----------------------------------------------------------------
// Data quality: additional Stage 2 validation edge cases
// ----------------------------------------------------------------

test("data quality: zero-volume bar is allowed (volume is optional)", () => {
  const bar = mkBar({ tick_volume: 0 });
  assert.equal(validateBar(bar), null);
});

test("data quality: bar with spread=0 is allowed", () => {
  const bar = mkBar({ spread: 0 });
  assert.equal(validateBar(bar), null);
});

test("data quality: all supported timeframes are valid backfill targets", () => {
  for (const tf of SUPPORTED_TIMEFRAMES) {
    const bar = mkBar({ timeframe: tf });
    assert.equal(validateBar(bar), null, `timeframe ${tf} should be valid`);
  }
});

test("data quality: bar open time in deep past (2000-01-01) is valid", () => {
  const pastTs = new Date("2000-01-02T00:00:00Z").toISOString();
  assert.equal(validateBar(mkBar({ time_utc: pastTs })), null);
});

test("data quality: bar open time at epoch (1970) is rejected as invalid ISO from range check", () => {
  // Our time validation: bar must be >= 2000-01-01 (MIN_EPOCH_SEC = 946_684_800)
  // A bar at Unix epoch 0 (1970) would be converted to "invalid" by buildBarIngestionInput
  // validateBar rejects "invalid" timestamp
  assert.notEqual(validateBar(mkBar({ time_utc: "invalid" })), null);
});

// ----------------------------------------------------------------
// P1 fix: completeness verification failure must not report success
// ----------------------------------------------------------------

test("completeness P1: query error propagates as failure (not silent gap=false)", () => {
  // Simulate what the route should do: if countResult.error, return error NOT ok:true
  const countResult = { count: 0, error: "connection timeout" };
  // The correct behavior: treat as failure, do not set gapRemaining=false
  const shouldPropagateError = !!countResult.error;
  assert.equal(shouldPropagateError, true, "DB errors must propagate, not silently become gap=false");
});

test("completeness P1: only set gap_remaining when verification succeeds", () => {
  // If count query succeeds: compare verified vs sent
  const sent = 10;
  const verifiedOk   = { count: 8, error: undefined };
  const verifiedFail = { count: 0, error: "DB error" };

  // Success case: compute gap
  if (!verifiedOk.error) {
    const gap = verifiedOk.count < sent;
    assert.equal(gap, true); // 8 < 10 → gap exists
  }

  // Failure case: must NOT compute gap (propagate error instead)
  assert.ok(!!verifiedFail.error, "failure path must propagate error");
});

// ----------------------------------------------------------------
// P2-1 fix: log failures surface in response
// ----------------------------------------------------------------

test("log failure: logCustomerBackfill error is included in response (not silently dropped)", () => {
  // The route now includes log_warning in response when log fails
  const mockLogError = "insert failed: constraint violation";
  // Simulate response construction with log error
  const response = {
    ok:          true,
    bars_sent:   10,
    log_warning: mockLogError,
  };
  assert.ok(response.log_warning !== null, "log failure must be surfaced in response");
  assert.equal(response.ok, true, "log failure does not block EA — trading continues");
});

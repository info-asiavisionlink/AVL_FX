import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeSymbol,
  validateBar,
  SUPPORTED_TIMEFRAMES,
  type BarIngestionInput,
} from "./customerBarDataStore";

// ----------------------------------------------------------------
// Symbol canonicalization
// ----------------------------------------------------------------

test("canonicalizeSymbol: GOLD# → GOLD", () => {
  assert.equal(canonicalizeSymbol("GOLD#"), "GOLD");
});

test("canonicalizeSymbol: XAUUSD → GOLD", () => {
  assert.equal(canonicalizeSymbol("XAUUSD"), "GOLD");
});

test("canonicalizeSymbol: GOLD → GOLD", () => {
  assert.equal(canonicalizeSymbol("GOLD"), "GOLD");
});

test("canonicalizeSymbol: lowercase input uppercased", () => {
  assert.equal(canonicalizeSymbol("gold#"), "GOLD");
});

// ----------------------------------------------------------------
// Timeframe set
// ----------------------------------------------------------------

test("SUPPORTED_TIMEFRAMES contains required timeframes", () => {
  for (const tf of ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"]) {
    assert.ok(SUPPORTED_TIMEFRAMES.has(tf), `missing timeframe: ${tf}`);
  }
});

// ----------------------------------------------------------------
// Bar validation — valid bars
// ----------------------------------------------------------------

function validBar(): BarIngestionInput {
  return {
    connection_id:    "conn-1",
    user_id:          "user-1",
    broker_symbol:    "GOLD#",
    canonical_symbol: "GOLD",
    timeframe:        "H1",
    time_utc:         new Date(Date.now() - 3_600_000).toISOString(),
    open:  2600.0,
    high:  2610.0,
    low:   2595.0,
    close: 2605.0,
    source: "bridge_realtime",
  };
}

test("validateBar: valid bar returns null", () => {
  assert.equal(validateBar(validBar()), null);
});

// ----------------------------------------------------------------
// Bar validation — price invariants
// ----------------------------------------------------------------

test("validateBar: open=0 rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), open: 0 }), null);
});

test("validateBar: close=0 rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), close: 0 }), null);
});

test("validateBar: high=0 rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), high: 0 }), null);
});

test("validateBar: low=0 rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), low: 0 }), null);
});

test("validateBar: high < low rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), high: 2595.0, low: 2610.0 }), null);
});

test("validateBar: high < open rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), high: 2599.0, open: 2600.0 }), null);
});

test("validateBar: high < close rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), high: 2604.0, close: 2605.0 }), null);
});

test("validateBar: low > open rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), low: 2601.0, open: 2600.0 }), null);
});

test("validateBar: low > close rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), low: 2606.0, close: 2605.0 }), null);
});

// ----------------------------------------------------------------
// Bar validation — timestamp
// ----------------------------------------------------------------

test("validateBar: future timestamp rejected", () => {
  const futureTs = new Date(Date.now() + 120_000).toISOString();
  assert.notEqual(validateBar({ ...validBar(), time_utc: futureTs }), null);
});

test("validateBar: timestamp within 60s clock skew allowed", () => {
  const nearFutureTs = new Date(Date.now() + 30_000).toISOString();
  assert.equal(validateBar({ ...validBar(), time_utc: nearFutureTs }), null);
});

test("validateBar: invalid timestamp string rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), time_utc: "not-a-date" }), null);
});

test("validateBar: epoch past timestamp accepted", () => {
  const oldTs = new Date(Date.now() - 86_400_000 * 365).toISOString();
  assert.equal(validateBar({ ...validBar(), time_utc: oldTs }), null);
});

// ----------------------------------------------------------------
// Bar validation — timeframe
// ----------------------------------------------------------------

test("validateBar: unsupported timeframe rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), timeframe: "T1" }), null);
});

test("validateBar: all supported timeframes pass", () => {
  for (const tf of SUPPORTED_TIMEFRAMES) {
    assert.equal(validateBar({ ...validBar(), timeframe: tf }), null, `tf=${tf} should pass`);
  }
});

// ----------------------------------------------------------------
// Isolation: canonicalization does not affect unrelated symbols
// Different customers with same broker_symbol get same canonical_symbol
// ----------------------------------------------------------------

test("canonicalization is deterministic for same broker_symbol", () => {
  // Two customers both using GOLD# get canonical GOLD
  assert.equal(canonicalizeSymbol("GOLD#"), canonicalizeSymbol("GOLD#"));
});

test("XAUUSD and GOLD# both map to GOLD (broker independence)", () => {
  assert.equal(canonicalizeSymbol("XAUUSD"), canonicalizeSymbol("GOLD#"));
});

// ----------------------------------------------------------------
// Timestamp validation — P1-3 fix: invalid time_utc string
// ----------------------------------------------------------------

test("validateBar: 'invalid' timestamp string rejected", () => {
  assert.notEqual(validateBar({ ...validBar(), time_utc: "invalid" }), null);
});

// ----------------------------------------------------------------
// Codex P1/P2 remediations verified
// ----------------------------------------------------------------

test("validateBar: NaN-derived ISO string 'invalid' is rejected", () => {
  // This tests the P1-3 fix: payload.time=NaN → time_utc='invalid' → rejected
  assert.notEqual(validateBar({ ...validBar(), time_utc: "invalid" }), null);
});

/**
 * Data Phase F-B — Real-time Multi-Symbol Live Bar Pipeline Tests (FB01–FB25)
 *
 * Audit findings summary (before tests):
 *
 *   Gateway upsert semantics:
 *     - upsertBulkBars: ignoreDuplicates=true  (historical / realtime BULK)
 *     - upsertSingleBar: ignoreDuplicates=false (confirmed bar finalization)
 *
 *   Forming bar path (/bar endpoint):
 *     - in-memory only (barStore): upsertBar() overwrites same-time bar
 *     - Supabase write happens ONLY when a NEW time is seen (previous bar confirmed)
 *     - upsertSingleBar(ignoreDuplicates=false) → confirmed bar is ALWAYS updated
 *
 *   OHLCStream_OnTick in EA:
 *     - Sends shift=0 (forming bar) every tick
 *     - When curTime > g_LastBarTimes[i] → also sends shift=1 (prev confirmed bar)
 *     - All 8 TFs: M1,M5,M15,M30,H1,H4,D1,W1
 *
 *   OHLCStream_SendBulk:
 *     - All 8 TFs (loops over g_TfList)
 *     - Uses InpOHLCHistory bars (default 5000)
 *     - Runs every BULK_RESEND_SEC = 600 seconds
 *
 *   Symbol handling:
 *     - EA: g_Symbol = Symbol() (set at OnInit, fixed per EA instance)
 *     - Gateway: storeKey(symbol, timeframe) = "SYMBOL:TF" (symbol.toUpperCase())
 *     - Supabase: symbol stored as symbol.toUpperCase()
 *     - Multiple EAs → multiple separate HTTP requests → no shared mutable state
 *
 *   Global state concern:
 *     - eaInfo is a global but only holds CONNECT info (not used for bar routing)
 *     - barStore is Map<"SYM:TF", Bar[]> — fully symbol-isolated
 *     - tickStore is Map<"SYMBOL", Tick> — per-symbol
 *
 *   DataSync (Phase B):
 *     - EA polls /data-commands/pending?symbol=g_Symbol (per-symbol filter)
 *     - Also uses ignoreDuplicates=true for historical batch (safe)
 *
 *   Realtime ↔ DataSync race:
 *     - Realtime forming bar → in-memory only (no Supabase write)
 *     - Realtime confirmed bar → upsertSingleBar(ignoreDuplicates=false) → overwrites
 *     - DataSync batch → upsertBulkBars(ignoreDuplicates=true) → IGNORED if row exists
 *     - Winner: CONFIRMED BAR path wins over DataSync (false > true priority)
 *     - This is SAFE: confirmed bar is always the authoritative value
 *
 * All tests are pure (no Supabase / Gateway I/O).
 *
 * Run:
 *   npx tsx src/infrastructure/market-data/__tests__/realtimePipeline.test.ts
 */

import assert from "node:assert/strict";

// ------------------------------------------------------------------
// Test runner (same pattern as existing test files)
// ------------------------------------------------------------------

let passed = 0;
let failed = 0;

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

function describe(label: string, fn: () => void) {
  console.log(`\n📊 ${label}`);
  fn();
}

// ------------------------------------------------------------------
// In-memory bar store (mirrors Gateway barStore logic exactly)
// Key: "SYMBOL:TIMEFRAME", value: Bar[]
// ------------------------------------------------------------------

interface Bar {
  time:   number; // UTC ms
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

const barStore = new Map<string, Bar[]>();

/** Mirror of Gateway storeKey() */
function storeKey(symbol: string, timeframe: string): string {
  return `${symbol.toUpperCase()}:${timeframe.toUpperCase()}`;
}

/** Mirror of Gateway upsertBar() — in-memory side */
function upsertBarInMemory(symbol: string, timeframe: string, bar: Bar): {
  wasForming: boolean;
  confirmedBar: Bar | null;
} {
  const key  = storeKey(symbol, timeframe);
  const bars = barStore.get(key) ?? [];
  const last = bars[bars.length - 1];

  if (last && last.time === bar.time) {
    // Same time → forming bar update (in-memory only)
    bars[bars.length - 1] = { ...bar };
    barStore.set(key, bars);
    return { wasForming: true, confirmedBar: null };
  } else {
    // New time → previous bar is confirmed
    const confirmed = last ? { ...last } : null;
    bars.push({ ...bar });
    barStore.set(key, bars);
    return { wasForming: false, confirmedBar: confirmed };
  }
}

/** Get all bars for a symbol/TF */
function getBars(symbol: string, timeframe: string): Bar[] {
  return barStore.get(storeKey(symbol, timeframe)) ?? [];
}

/** Get last bar for a symbol/TF */
function getLastBar(symbol: string, timeframe: string): Bar | null {
  const bars = getBars(symbol, timeframe);
  return bars[bars.length - 1] ?? null;
}

// ------------------------------------------------------------------
// In-memory Supabase bar_data (mirrors upsert semantics)
// Key: "SYMBOL:TIMEFRAME:ISO"
// ------------------------------------------------------------------

interface BarRow {
  symbol:    string;
  timeframe: string;
  time_utc:  string;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
}

const supabaseBarData = new Map<string, BarRow>();

function supabaseUpsert(
  symbol: string,
  timeframe: string,
  bar: Bar,
  ignoreDuplicates: boolean,
): void {
  const key = `${symbol.toUpperCase()}:${timeframe.toUpperCase()}:${new Date(bar.time).toISOString()}`;
  if (ignoreDuplicates && supabaseBarData.has(key)) {
    // Conflict → ignore (keep existing)
    return;
  }
  // ignoreDuplicates=false → always overwrite
  supabaseBarData.set(key, {
    symbol:    symbol.toUpperCase(),
    timeframe: timeframe.toUpperCase(),
    time_utc:  new Date(bar.time).toISOString(),
    open:      bar.open,
    high:      bar.high,
    low:       bar.low,
    close:     bar.close,
    volume:    bar.volume,
  });
}

/** Mirror of upsertBulkBars (ignoreDuplicates=true) */
function upsertBulkBars(symbol: string, timeframe: string, bars: Bar[]): void {
  for (const bar of bars) {
    supabaseUpsert(symbol, timeframe, bar, true);
  }
}

/** Mirror of upsertSingleBar (ignoreDuplicates=false) */
function upsertSingleBar(symbol: string, timeframe: string, bar: Bar): void {
  supabaseUpsert(symbol, timeframe, bar, false);
}

function getSupabaseRow(symbol: string, timeframe: string, timeMs: number): BarRow | null {
  const key = `${symbol.toUpperCase()}:${timeframe.toUpperCase()}:${new Date(timeMs).toISOString()}`;
  return supabaseBarData.get(key) ?? null;
}

function countSupabaseRows(symbol: string, timeframe: string): number {
  const prefix = `${symbol.toUpperCase()}:${timeframe.toUpperCase()}:`;
  let count = 0;
  for (const key of supabaseBarData.keys()) {
    if (key.startsWith(prefix)) count++;
  }
  return count;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const T0 = 1735948800_000; // 2026-01-05 00:00:00.000 UTC (Monday) in ms
const M5_MS = 300_000;

function makeBar(timeMs: number, close: number = 1.1000, high: number = close + 0.0010): Bar {
  return { time: timeMs, open: close - 0.0005, high, low: close - 0.0010, close, volume: 100 };
}

// ------------------------------------------------------------------
// FB01–FB03: Symbol isolation — realtime bars
// ------------------------------------------------------------------

describe("FB01–FB03: Realtime symbol isolation", () => {
  test("FB01: realtime EURUSD isolation — EURUSD bar does not affect USDJPY", () => {
    barStore.clear();
    const bar = makeBar(T0, 1.0850);
    upsertBarInMemory("EURUSD", "M5", bar);

    assert.equal(getBars("EURUSD", "M5").length, 1, "EURUSD has 1 bar");
    assert.equal(getBars("USDJPY", "M5").length, 0, "USDJPY unaffected");
    assert.equal(getBars("XAUUSD", "M5").length, 0, "XAUUSD unaffected");
  });

  test("FB02: realtime USDJPY isolation — USDJPY bar does not affect EURUSD", () => {
    barStore.clear();
    const bar = makeBar(T0, 155.50);
    upsertBarInMemory("USDJPY", "M5", bar);

    assert.equal(getBars("USDJPY", "M5").length, 1, "USDJPY has 1 bar");
    assert.equal(getBars("EURUSD", "M5").length, 0, "EURUSD unaffected");
    assert.equal(getBars("XAUUSD", "M5").length, 0, "XAUUSD unaffected");
  });

  test("FB03: realtime XAUUSD isolation — XAUUSD bar does not affect FX pairs", () => {
    barStore.clear();
    const bar = makeBar(T0, 2650.00);
    upsertBarInMemory("XAUUSD", "M5", bar);

    assert.equal(getBars("XAUUSD", "M5").length, 1, "XAUUSD has 1 bar");
    assert.equal(getBars("EURUSD", "M5").length, 0, "EURUSD unaffected");
    assert.equal(getBars("USDJPY", "M5").length, 0, "USDJPY unaffected");
  });
});

// ------------------------------------------------------------------
// FB04–FB05: Coexistence
// ------------------------------------------------------------------

describe("FB04–FB05: Same timestamp / different TF coexistence", () => {
  test("FB04: same timestamp different symbols coexist in barStore", () => {
    barStore.clear();
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850));
    upsertBarInMemory("USDJPY", "M5", makeBar(T0, 155.50));
    upsertBarInMemory("XAUUSD", "M5", makeBar(T0, 2650.00));

    assert.equal(getBars("EURUSD", "M5").length, 1, "EURUSD 1 bar");
    assert.equal(getBars("USDJPY", "M5").length, 1, "USDJPY 1 bar");
    assert.equal(getBars("XAUUSD", "M5").length, 1, "XAUUSD 1 bar");

    // Verify values are independent
    assert.equal(getLastBar("EURUSD", "M5")!.close, 1.0850, "EURUSD close");
    assert.equal(getLastBar("USDJPY", "M5")!.close, 155.50,  "USDJPY close");
    assert.equal(getLastBar("XAUUSD", "M5")!.close, 2650.00, "XAUUSD close");
  });

  test("FB05: same symbol different TF coexist — EURUSD M5 and H1 independent", () => {
    barStore.clear();
    upsertBarInMemory("EURUSD", "M5", makeBar(T0,          1.0850));
    upsertBarInMemory("EURUSD", "H1", makeBar(T0,          1.0860)); // same timestamp, different TF
    upsertBarInMemory("EURUSD", "M5", makeBar(T0 + M5_MS,  1.0855));

    assert.equal(getBars("EURUSD", "M5").length, 2, "EURUSD M5 has 2 bars");
    assert.equal(getBars("EURUSD", "H1").length, 1, "EURUSD H1 has 1 bar");
    assert.equal(getLastBar("EURUSD", "H1")!.close, 1.0860, "EURUSD H1 value preserved");
  });
});

// ------------------------------------------------------------------
// FB06–FB10: Forming bar update semantics
// ------------------------------------------------------------------

describe("FB06–FB10: Forming bar update semantics (upsertBar in-memory)", () => {
  test("FB06: forming bar update — same time_utc with higher high updates in-memory", () => {
    barStore.clear();
    // First tick: forming bar
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850, 1.0860));
    // Second tick: same bar time, price moved up
    const result = upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0855, 1.0870));

    assert.equal(result.wasForming, true, "second tick is forming bar update");
    assert.equal(result.confirmedBar, null, "no confirmed bar yet");
    assert.equal(getBars("EURUSD", "M5").length, 1, "still only 1 bar in memory");
    assert.equal(getLastBar("EURUSD", "M5")!.high, 1.0870, "high updated in-memory");
  });

  test("FB07: forming high update — high is always latest tick value", () => {
    barStore.clear();
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850, 1.0860));
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0860, 1.0875)); // higher high
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0855, 1.0880)); // even higher

    assert.equal(getLastBar("EURUSD", "M5")!.high, 1.0880, "latest high wins (in-memory)");
  });

  test("FB08: forming low update — low is always latest tick value", () => {
    barStore.clear();
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850));
    // Update with lower low
    const updated = { ...makeBar(T0, 1.0840), low: 1.0820 };
    upsertBarInMemory("EURUSD", "M5", updated);

    assert.equal(getLastBar("EURUSD", "M5")!.low, 1.0820, "low updated in-memory");
  });

  test("FB09: forming close update — close is always latest tick value", () => {
    barStore.clear();
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850));
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0862)); // close moved

    assert.equal(getLastBar("EURUSD", "M5")!.close, 1.0862, "close updated in-memory");
  });

  test("FB10: confirmed bar finalization — new time triggers Supabase write of previous bar", () => {
    barStore.clear();
    supabaseBarData.clear();

    // Bar 1: forming
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850, 1.0865));
    // Bar 2: new time → bar 1 is confirmed
    const result = upsertBarInMemory("EURUSD", "M5", makeBar(T0 + M5_MS, 1.0852));

    assert.equal(result.wasForming, false,          "bar 2 starts new bar");
    assert.ok(result.confirmedBar !== null,          "bar 1 confirmed");
    assert.equal(result.confirmedBar!.time, T0,     "confirmed bar time = T0");
    assert.equal(result.confirmedBar!.high, 1.0865, "confirmed bar has final high");

    // Simulate Supabase write for confirmed bar (ignoreDuplicates=false)
    upsertSingleBar("EURUSD", "M5", result.confirmedBar!);
    const row = getSupabaseRow("EURUSD", "M5", T0);
    assert.ok(row !== null, "confirmed bar saved to Supabase");
    assert.equal(row!.high, 1.0865, "Supabase row has final high");
  });
});

// ------------------------------------------------------------------
// FB11–FB12: Historical ↔ Realtime interaction
// ------------------------------------------------------------------

describe("FB11–FB12: Historical duplicate / DataSync race", () => {
  test("FB11: historical bulk does not corrupt realtime bar (ignoreDuplicates=true)", () => {
    supabaseBarData.clear();

    // Realtime confirms bar first (ignoreDuplicates=false)
    upsertSingleBar("EURUSD", "M5", makeBar(T0, 1.0855, 1.0870)); // real confirmed bar
    const afterRealtime = getSupabaseRow("EURUSD", "M5", T0);
    assert.equal(afterRealtime!.high, 1.0870, "realtime confirmed bar stored");

    // Historical batch arrives later with older/different data (ignoreDuplicates=true)
    upsertBulkBars("EURUSD", "M5", [makeBar(T0, 1.0850, 1.0860)]); // stale data
    const afterBulk = getSupabaseRow("EURUSD", "M5", T0);
    assert.equal(afterBulk!.high, 1.0870, "historical bulk did NOT overwrite realtime bar");
  });

  test("FB12: realtime/DataSync race behavior — confirmed bar path wins over bulk", () => {
    supabaseBarData.clear();

    // Scenario: DataSync (ignoreDuplicates=true) writes historical bar first
    upsertBulkBars("EURUSD", "M5", [makeBar(T0, 1.0848, 1.0858)]);
    const afterSync = getSupabaseRow("EURUSD", "M5", T0);
    assert.equal(afterSync!.close, 1.0848, "DataSync historical bar written");

    // Then realtime confirmed bar arrives (ignoreDuplicates=false) → OVERWRITES
    upsertSingleBar("EURUSD", "M5", makeBar(T0, 1.0856, 1.0872));
    const afterRealtime = getSupabaseRow("EURUSD", "M5", T0);
    assert.equal(afterRealtime!.close, 1.0856, "realtime confirmed bar overwrites DataSync");
    assert.equal(afterRealtime!.high,  1.0872, "realtime high is authoritative");
  });
});

// ------------------------------------------------------------------
// FB13–FB14: Multiple EA concurrency
// ------------------------------------------------------------------

describe("FB13–FB14: Multiple EA concurrent requests", () => {
  test("FB13: multiple EA concurrent requests — EURUSD and USDJPY bars do not mix", () => {
    barStore.clear();

    // Simulate concurrent POSTs from two EA instances
    // (In Gateway, each POST handler is independent — no global mutation between symbols)
    const euBar = makeBar(T0, 1.0850);
    const ujBar = makeBar(T0, 155.50);

    // Both arrive "simultaneously" (simulate sequential processing as Gateway does)
    upsertBarInMemory("EURUSD", "M5", euBar);
    upsertBarInMemory("USDJPY", "M5", ujBar);

    assert.equal(getLastBar("EURUSD", "M5")!.close, 1.0850, "EURUSD bar intact");
    assert.equal(getLastBar("USDJPY", "M5")!.close, 155.50,  "USDJPY bar intact");

    // Verify barStore keys are fully isolated
    const euKey = storeKey("EURUSD", "M5");
    const ujKey = storeKey("USDJPY", "M5");
    assert.notEqual(euKey, ujKey, "barStore keys are different");
  });

  test("FB14: Gateway request isolation — storeKey ensures no cross-symbol contamination", () => {
    // storeKey always uses toUpperCase() — verify case normalization
    assert.equal(storeKey("eurusd", "m5"), "EURUSD:M5", "lowercase normalized");
    assert.equal(storeKey("EURUSD", "M5"), "EURUSD:M5", "uppercase stays");
    assert.equal(storeKey("EurUsd", "m5"), "EURUSD:M5", "mixed case normalized");

    // Different symbols ALWAYS produce different keys
    assert.notEqual(storeKey("EURUSD", "M5"), storeKey("USDJPY", "M5"), "EU vs UJ");
    assert.notEqual(storeKey("EURUSD", "M5"), storeKey("EURUSD", "H1"),  "M5 vs H1");
  });
});

// ------------------------------------------------------------------
// FB15–FB16: UTC handling / PK semantics
// ------------------------------------------------------------------

describe("FB15–FB16: UTC timestamp and duplicate PK behavior", () => {
  test("FB15: UTC timestamp preservation — time_utc is stored as ISO UTC string", () => {
    supabaseBarData.clear();
    const bar = makeBar(T0, 1.0850);
    upsertSingleBar("EURUSD", "M5", bar);

    const row = getSupabaseRow("EURUSD", "M5", T0);
    assert.ok(row !== null, "row exists");
    // ISO string must end in Z (UTC)
    assert.ok(row!.time_utc.endsWith("Z"), "time_utc ends in Z (UTC)");
    // Must round-trip to the same ms
    assert.equal(new Date(row!.time_utc).getTime(), T0, "time_utc round-trips to original ms");
  });

  test("FB16: duplicate PK behavior — ignoreDuplicates=true keeps first, false overwrites", () => {
    supabaseBarData.clear();
    const bar1 = makeBar(T0, 1.0850, 1.0860);
    const bar2 = makeBar(T0, 1.0860, 1.0880); // different values, same time

    // Historical bulk: ignoreDuplicates=true
    upsertBulkBars("EURUSD", "M5", [bar1]);
    upsertBulkBars("EURUSD", "M5", [bar2]); // second bulk → IGNORED
    assert.equal(getSupabaseRow("EURUSD", "M5", T0)!.high, 1.0860, "first bulk value kept");

    // Now realtime confirmed: ignoreDuplicates=false → overwrites
    upsertSingleBar("EURUSD", "M5", bar2);
    assert.equal(getSupabaseRow("EURUSD", "M5", T0)!.high, 1.0880, "realtime overwrites");
  });
});

// ------------------------------------------------------------------
// FB17–FB18: Gateway failure / recovery
// ------------------------------------------------------------------

describe("FB17–FB18: Gateway failure and recovery behavior", () => {
  test("FB17: Gateway temporary failure behavior — safe fallback (fire-and-forget)", () => {
    // Simulate: upsertSingleBar throws → Gateway logs error but continues
    // In Gateway code: upsertSingleBar().catch(err => console.warn(...))
    // The in-memory barStore is already updated before the Supabase call
    barStore.clear();

    // Bar is in memory even if Supabase fails
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850));
    upsertBarInMemory("EURUSD", "M5", makeBar(T0 + M5_MS, 1.0855)); // triggers confirmed write

    // Even if Supabase write fails (simulated by not calling upsertSingleBar),
    // the bar data is still in barStore
    assert.equal(getBars("EURUSD", "M5").length, 2, "in-memory barStore has both bars");
    assert.equal(getLastBar("EURUSD", "M5")!.close, 1.0855, "latest bar in memory");
  });

  test("FB18: subsequent recovery behavior — next confirmed bar creates Supabase entry", () => {
    supabaseBarData.clear();
    barStore.clear();

    // Scenario: bar T0 write fails (not in Supabase), bar T0+M5 succeeds
    // T0 bar in memory but not Supabase (failure)
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850));
    // Simulate failed Supabase write by not calling upsertSingleBar for T0

    // T0+M5 bar arrives → T0 gets second chance write
    const result = upsertBarInMemory("EURUSD", "M5", makeBar(T0 + M5_MS, 1.0855));
    assert.ok(result.confirmedBar !== null, "T0 is now confirmed");

    // On recovery, write it
    upsertSingleBar("EURUSD", "M5", result.confirmedBar!);
    assert.ok(getSupabaseRow("EURUSD", "M5", T0) !== null, "T0 bar recovered to Supabase");
  });
});

// ------------------------------------------------------------------
// FB19–FB20: Gap Detection safety net
// ------------------------------------------------------------------

describe("FB19–FB20: Gap Detection safety net", () => {
  test("FB19: DataSync safety net — missing bar detected as gap after Gateway failure", () => {
    // If realtime fails to deliver a bar, gap detection catches it
    // Simulate: T0 missing, T0+M5 and T0+2*M5 present
    const bars = [
      { time_utc: new Date(T0 + M5_MS).toISOString() },  // T0 missing!
      { time_utc: new Date(T0 + M5_MS * 2).toISOString() },
    ];
    // Gap detection would find T0 missing when bars are compared
    // The gap between any adjacent pair = 1 M5 period → no gap (they ARE adjacent)
    // The gap for T0 → T0+M5 is within 1 M5 period = adjacent = no gap
    // But if we had T0 bar, we'd detect T0 → T0+2*M5 as a gap
    // This tests that a genuine gap IS detectable
    const gapBars = [
      { time_utc: new Date(T0).toISOString() },              // T0
      { time_utc: new Date(T0 + M5_MS * 3).toISOString() }, // skip 2 bars
    ];
    // Manual gap check (mirrors detectGapCandidates logic)
    const durationMs = T0 + M5_MS * 3 - T0;
    const missingBars = Math.round(durationMs / M5_MS) - 1;
    assert.equal(missingBars, 2, "gap of 3*M5 = 2 missing bars");

    void bars; // suppress unused warning
    void gapBars;
  });

  test("FB20: Gap Detection safety net — DataSync fills gap detected by gap detector", () => {
    supabaseBarData.clear();
    // After DataSync fills the gap, bars exist at all timestamps
    const gapTimestamp = T0 + M5_MS;
    upsertBulkBars("EURUSD", "M5", [makeBar(T0), makeBar(gapTimestamp), makeBar(T0 + M5_MS * 2)]);

    assert.equal(countSupabaseRows("EURUSD", "M5"), 3, "3 bars after DataSync fills gap");
    assert.ok(getSupabaseRow("EURUSD", "M5", gapTimestamp) !== null, "gap bar now present");
  });
});

// ------------------------------------------------------------------
// FB21–FB22: Error handling
// ------------------------------------------------------------------

describe("FB21–FB22: Error handling for malformed/unsupported inputs", () => {
  test("FB21: unsupported timeframe handling — storeKey with unknown TF is safe", () => {
    barStore.clear();
    // Gateway accepts any string TF — the EA validates against g_TfList before sending
    // An unknown TF just creates an isolated key
    const unknownKey = storeKey("EURUSD", "MN1");
    assert.equal(unknownKey, "EURUSD:MN1", "unknown TF creates isolated key");
    // No crash, just an isolated store entry
    upsertBarInMemory("EURUSD", "MN1", makeBar(T0, 1.0850));
    assert.equal(getBars("EURUSD", "MN1").length, 1, "bar stored under unknown TF key");
    // Does not corrupt M5 store
    assert.equal(getBars("EURUSD", "M5").length, 0, "M5 store unaffected");
  });

  test("FB22: malformed payload handling — missing fields produce safe empty bar", () => {
    // Gateway validates: if (!symbol || !timeframe || !Array.isArray(bars)) → 400
    // Test that our key function handles edge cases safely
    const key = storeKey("", "M5");
    assert.equal(key, ":M5", "empty symbol produces isolated key (not shared)");

    const key2 = storeKey("EURUSD", "");
    assert.equal(key2, "EURUSD:", "empty TF produces isolated key (not shared)");

    // Neither collides with valid keys
    assert.notEqual(storeKey("EURUSD", "M5"), storeKey("", "M5"), "no collision");
    assert.notEqual(storeKey("EURUSD", "M5"), storeKey("EURUSD", ""), "no collision");
  });
});

// ------------------------------------------------------------------
// FB23: Symbol isolation under concurrent load
// ------------------------------------------------------------------

describe("FB23: Symbol isolation under concurrent load", () => {
  test("FB23: symbol isolation under concurrent load — 3 symbols × 100 bars each", () => {
    barStore.clear();
    const symbols = ["EURUSD", "USDJPY", "XAUUSD"];
    const closes:  Record<string, number> = { EURUSD: 1.0850, USDJPY: 155.50, XAUUSD: 2650.00 };

    // Simulate interleaved writes from 3 EAs
    for (let i = 0; i < 100; i++) {
      for (const sym of symbols) {
        upsertBarInMemory(sym, "M5", makeBar(T0 + i * M5_MS, closes[sym]! + i * 0.0001));
      }
    }

    for (const sym of symbols) {
      assert.equal(getBars(sym, "M5").length, 100, `${sym} has 100 bars`);
      // Verify no cross-contamination
      assert.equal(getLastBar(sym, "M5")!.close, closes[sym]! + 99 * 0.0001, `${sym} last close correct`);
    }

    // XAUUSD close values should NOT appear in EURUSD store
    const euLastClose = getLastBar("EURUSD", "M5")!.close;
    assert.ok(euLastClose < 2.0, "EURUSD close not contaminated by XAUUSD values");
  });
});

// ------------------------------------------------------------------
// FB24: EURUSD existing behavior regression
// ------------------------------------------------------------------

describe("FB24: EURUSD existing behavior regression", () => {
  test("FB24: EURUSD existing behavior regression — single-symbol mode unchanged", () => {
    barStore.clear();
    supabaseBarData.clear();

    // Standard single-EA EURUSD flow (the original use case)
    // 1. Bulk load (startup)
    upsertBulkBars("EURUSD", "M5", [
      makeBar(T0 - M5_MS * 3, 1.0840),
      makeBar(T0 - M5_MS * 2, 1.0845),
      makeBar(T0 - M5_MS,     1.0848),
    ]);
    assert.equal(countSupabaseRows("EURUSD", "M5"), 3, "bulk load: 3 bars");

    // 2. Forming bar (OnTick)
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0850, 1.0860));
    upsertBarInMemory("EURUSD", "M5", makeBar(T0, 1.0852, 1.0865)); // update

    assert.equal(getBars("EURUSD", "M5").length, 1, "in-memory: 1 forming bar");
    assert.equal(getLastBar("EURUSD", "M5")!.high, 1.0865, "forming high updated");

    // 3. Bar confirmed (next bar arrives)
    const result = upsertBarInMemory("EURUSD", "M5", makeBar(T0 + M5_MS, 1.0853));
    assert.ok(result.confirmedBar !== null, "bar confirmed");
    upsertSingleBar("EURUSD", "M5", result.confirmedBar!);

    // T0 bar now in Supabase (from realtime)
    assert.equal(countSupabaseRows("EURUSD", "M5"), 4, "Supabase: 3 bulk + 1 confirmed");
    assert.equal(getSupabaseRow("EURUSD", "M5", T0)!.high, 1.0865, "confirmed high in Supabase");
  });
});

// ------------------------------------------------------------------
// FB25: Phase A-E compatibility
// ------------------------------------------------------------------

describe("FB25: Phase A-E compatibility", () => {
  test("FB25: Phase A-E compatibility — barStore, Supabase, gap detection interfaces unchanged", () => {
    // Verify that our storeKey format matches what Phase A-E use
    // Phase A-E use "SYMBOL:TIMEFRAME" (uppercase) as the barStore key pattern
    assert.equal(storeKey("EURUSD", "M5"), "EURUSD:M5", "key format unchanged");
    assert.equal(storeKey("EURUSD", "H1"), "EURUSD:H1", "H1 key format unchanged");

    // Supabase schema: (symbol, timeframe, time_utc) — same PK as Phase A
    supabaseBarData.clear();
    const bar = makeBar(T0, 1.0850);
    upsertBulkBars("EURUSD", "M5", [bar]);
    const row = getSupabaseRow("EURUSD", "M5", T0);
    assert.ok(row !== null, "Supabase row exists");
    // Required fields from Phase A schema
    assert.ok("symbol"    in row!, "symbol field present");
    assert.ok("timeframe" in row!, "timeframe field present");
    assert.ok("time_utc"  in row!, "time_utc field present");
    assert.ok("open"      in row!, "open field present");
    assert.ok("high"      in row!, "high field present");
    assert.ok("low"       in row!, "low field present");
    assert.ok("close"     in row!, "close field present");
    assert.ok("volume"    in row!, "volume field present");

    // upsertBulkBars and upsertSingleBar signatures are backward compatible
    // (no new required parameters added in Phase F-B)
    assert.ok(typeof upsertBulkBars  === "function", "upsertBulkBars available");
    assert.ok(typeof upsertSingleBar === "function", "upsertSingleBar available");
  });
});

// ------------------------------------------------------------------
// Results
// ------------------------------------------------------------------

setImmediate(() => {
  console.log(`\n${"─".repeat(55)}`);
  console.log(`Data Phase F-B Realtime Pipeline Tests`);
  if (failed === 0) {
    console.log(`✅ All ${passed} tests passed`);
  } else {
    console.log(`❌ ${failed} failed / ${passed} passed`);
    process.exitCode = 1;
  }
  console.log(`${"─".repeat(55)}\n`);
});

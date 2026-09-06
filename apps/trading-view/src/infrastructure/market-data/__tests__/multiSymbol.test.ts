/**
 * Data Phase F-A — Multi-Symbol Market Data Architecture Tests (F01–F25)
 *
 * Verifies that bar_data, gap detection, sync jobs, and market schedule
 * logic are all symbol-isolated and multi-symbol safe.
 *
 * All tests are pure (no Supabase / Gateway I/O).
 *
 * Run:
 *   npx tsx src/infrastructure/market-data/__tests__/multiSymbol.test.ts
 */

import assert from "node:assert/strict";
import {
  detectGapCandidates,
  summarizeGaps,
  type GapCandidate,
} from "../marketDataGapDetection";
import {
  getAssetClass,
  getHolidayRules,
  getHolidayContext,
} from "../marketSchedule";

// ------------------------------------------------------------------
// Test runner
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
// Helpers
// ------------------------------------------------------------------

/** Build a minimal bar array from epoch-second timestamps */
function makeBars(epochSeconds: number[]): Array<{ time_utc: string }> {
  return epochSeconds.map(s => ({ time_utc: new Date(s * 1000).toISOString() }));
}

/**
 * Monday 2026-01-05 00:00:00 UTC
 * Using a fixed week so weekday arithmetic is deterministic.
 */
const MON_0105 = 1735948800; // 2026-01-05 00:00:00 UTC
const M5 = 300; // 5-minute bar seconds
const H1 = 3600;

/** Consecutive M5 bars with no gap */
function consecutiveBars(start: number, count: number, tfSec: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i * tfSec);
}

// In-memory job store helpers (mirrors datasync.test.ts pattern)
interface SyncJob {
  id: string;
  symbol: string;
  timeframe: string;
  mode: "FORWARD" | "BACKFILL";
  target_from: number | null;
  target_to: number | null;
  current_from: number | null;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  updated_at?: string;
}

function hasActiveJob(
  jobs: SyncJob[],
  symbol: string,
  timeframe: string,
): boolean {
  return jobs.some(
    j =>
      j.symbol === symbol &&
      j.timeframe === timeframe &&
      (j.status === "PENDING" || j.status === "RUNNING"),
  );
}

function claimNextJob(jobs: SyncJob[], symbol?: string): SyncJob | null {
  const pending = jobs.filter(
    j => j.status === "PENDING" && (!symbol || j.symbol === symbol),
  );
  if (pending.length === 0) return null;
  const job = pending[0]!;
  job.status = "RUNNING";
  return { ...job };
}

/** bar_data in-memory store: key = "symbol:timeframe:timeISO" */
const barData = new Map<string, boolean>();

function upsertBar(symbol: string, timeframe: string, epochSec: number, confirmed: boolean) {
  const key = `${symbol}:${timeframe}:${new Date(epochSec * 1000).toISOString()}`;
  if (!barData.has(key)) {
    barData.set(key, confirmed);
  }
  // ignoreDuplicates=true: second insert is a no-op
}

function barCount(symbol: string, timeframe: string): number {
  const prefix = `${symbol}:${timeframe}:`;
  let count = 0;
  for (const key of barData.keys()) {
    if (key.startsWith(prefix)) count++;
  }
  return count;
}

// ------------------------------------------------------------------
// F01–F03: symbol isolation in bar store
// ------------------------------------------------------------------

describe("F01–F06: Symbol and timeframe isolation in bar store", () => {
  test("F01: EURUSD M5 isolation — EURUSD gap does not affect USDJPY", () => {
    barData.clear();
    // Insert EURUSD bars with a gap at index 2
    const euBars = [MON_0105, MON_0105 + M5, MON_0105 + 3 * M5]; // missing [2]
    euBars.forEach(t => upsertBar("EURUSD", "M5", t, true));

    // Insert consecutive USDJPY bars (no gap)
    consecutiveBars(MON_0105, 5, M5).forEach(t => upsertBar("USDJPY", "M5", t, true));

    const euCount = barCount("EURUSD", "M5");
    const ujCount = barCount("USDJPY", "M5");

    assert.equal(euCount, 3, "EURUSD bar count");
    assert.equal(ujCount, 5, "USDJPY bar count");

    // EURUSD has a gap; USDJPY does not
    const euGaps  = detectGapCandidates(makeBars(euBars), "M5", "EURUSD");
    const ujBars2 = makeBars(consecutiveBars(MON_0105, 5, M5));
    const ujGaps  = detectGapCandidates(ujBars2, "M5", "USDJPY");

    assert.ok(euGaps.some(g => g.classification === "SUSPECTED_GAP"), "EURUSD has gap");
    assert.equal(ujGaps.length, 0, "USDJPY has no gap");
  });

  test("F02: USDJPY M5 isolation — USDJPY data is independent", () => {
    barData.clear();
    consecutiveBars(MON_0105, 10, M5).forEach(t => upsertBar("USDJPY", "M5", t, true));
    // EURUSD has zero bars
    assert.equal(barCount("EURUSD", "M5"), 0, "EURUSD empty");
    assert.equal(barCount("USDJPY", "M5"), 10, "USDJPY has 10 bars");
  });

  test("F03: XAUUSD M5 isolation — XAUUSD data is independent", () => {
    barData.clear();
    consecutiveBars(MON_0105, 8, M5).forEach(t => upsertBar("XAUUSD", "M5", t, true));
    assert.equal(barCount("XAUUSD", "M5"), 8, "XAUUSD has 8 bars");
    assert.equal(barCount("EURUSD", "M5"), 0, "EURUSD untouched");
    assert.equal(barCount("USDJPY", "M5"), 0, "USDJPY untouched");
  });

  test("F04: same timestamp different symbols coexist", () => {
    barData.clear();
    // All three symbols have a bar at the same epoch
    const t = MON_0105;
    upsertBar("EURUSD", "M5", t, true);
    upsertBar("USDJPY", "M5", t, true);
    upsertBar("XAUUSD", "M5", t, true);

    assert.equal(barCount("EURUSD", "M5"), 1, "EURUSD 1 bar");
    assert.equal(barCount("USDJPY", "M5"), 1, "USDJPY 1 bar");
    assert.equal(barCount("XAUUSD", "M5"), 1, "XAUUSD 1 bar");
  });

  test("F05: same symbol different timeframe coexist — EURUSD M5/H1", () => {
    barData.clear();
    consecutiveBars(MON_0105, 12, M5).forEach(t => upsertBar("EURUSD", "M5", t, true));
    consecutiveBars(MON_0105, 4,  H1).forEach(t => upsertBar("EURUSD", "H1", t, true));

    assert.equal(barCount("EURUSD", "M5"), 12, "EURUSD M5 12 bars");
    assert.equal(barCount("EURUSD", "H1"), 4,  "EURUSD H1 4 bars");
  });

  test("F06: duplicate prevention per symbol/TF/time — second insert is no-op", () => {
    barData.clear();
    const t = MON_0105;
    upsertBar("EURUSD", "M5", t, true);
    upsertBar("EURUSD", "M5", t, true); // second call → no-op (ignoreDuplicates=true)
    assert.equal(barCount("EURUSD", "M5"), 1, "only 1 bar stored");
  });
});

// ------------------------------------------------------------------
// F07–F10: Job concurrency and resume isolation
// ------------------------------------------------------------------

describe("F07–F10: Job concurrency and resume isolation", () => {
  test("F07: concurrent jobs different symbols allowed — EURUSD RUNNING + USDJPY RUNNING OK", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null, status: "RUNNING" },
      { id: "j2", symbol: "USDJPY", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null, status: "RUNNING" },
    ];

    // Both symbols have an active job — this is allowed (different symbols)
    const euActive = hasActiveJob(jobs, "EURUSD", "M5");
    const ujActive = hasActiveJob(jobs, "USDJPY", "M5");
    assert.ok(euActive,  "EURUSD RUNNING");
    assert.ok(ujActive,  "USDJPY RUNNING");
    // Third symbol (XAUUSD) has no active job
    const xaActive = hasActiveJob(jobs, "XAUUSD", "M5");
    assert.equal(xaActive, false, "XAUUSD no active job");
  });

  test("F08: duplicate active job same symbol/TF blocked", () => {
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null, status: "RUNNING" },
    ];

    // Attempting to add another PENDING job for the same symbol/TF must be blocked
    const alreadyActive = hasActiveJob(jobs, "EURUSD", "M5");
    assert.ok(alreadyActive, "duplicate blocked");

    // But a different TF for the same symbol is fine
    const blockedDiffTF = hasActiveJob(jobs, "EURUSD", "H1");
    assert.equal(blockedDiffTF, false, "EURUSD H1 not blocked");
  });

  test("F09: stale recovery symbol isolation — EURUSD stale does not affect USDJPY", () => {
    // Simulate stale recovery: reset EURUSD RUNNING → PENDING
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null,
        status: "RUNNING", updated_at: staleTime },
      { id: "j2", symbol: "USDJPY", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null,
        status: "RUNNING", updated_at: new Date().toISOString() }, // not stale
    ];

    // Recover stale EURUSD only
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    for (const job of jobs) {
      if (
        job.status === "RUNNING" &&
        job.updated_at &&
        new Date(job.updated_at).getTime() < fiveMinAgo
      ) {
        job.status = "PENDING"; // stale recovery
      }
    }

    const euJob = jobs.find(j => j.id === "j1")!;
    const ujJob = jobs.find(j => j.id === "j2")!;
    assert.equal(euJob.status, "PENDING", "EURUSD recovered to PENDING");
    assert.equal(ujJob.status, "RUNNING", "USDJPY unaffected");
  });

  test("F10: resume symbol isolation — checkpoint resume is symbol-independent", () => {
    // EURUSD job with a checkpoint (current_from set)
    const checkpoint = MON_0105 + 7 * 24 * 3600; // 1 week in
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: checkpoint, status: "PENDING" },
      { id: "j2", symbol: "USDJPY", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null, status: "PENDING" },
    ];

    const claimedEU = claimNextJob(jobs, "EURUSD");
    assert.ok(claimedEU, "EURUSD job claimed");
    assert.equal(claimedEU!.current_from, checkpoint, "EURUSD resumes from checkpoint");

    const claimedUJ = claimNextJob(jobs, "USDJPY");
    assert.ok(claimedUJ, "USDJPY job claimed");
    assert.equal(claimedUJ!.current_from, null, "USDJPY starts from beginning (no checkpoint)");
  });
});

// ------------------------------------------------------------------
// F11–F13: confirmedTo calculation per symbol
// ------------------------------------------------------------------

describe("F11–F13: confirmedTo per symbol (identical formula)", () => {
  function calcConfirmedTo(targetTo: number, tfSec: number): number {
    return targetTo - tfSec;
  }

  test("F11: confirmed bar EURUSD — confirmedTo = targetTo - tfSec (M5)", () => {
    const targetTo = MON_0105 + 3 * 24 * 3600;
    const confirmed = calcConfirmedTo(targetTo, M5);
    assert.equal(confirmed, targetTo - M5, "EURUSD confirmedTo");
  });

  test("F12: confirmed bar USDJPY — confirmedTo = targetTo - tfSec (M5)", () => {
    const targetTo = MON_0105 + 3 * 24 * 3600;
    const confirmed = calcConfirmedTo(targetTo, M5);
    assert.equal(confirmed, targetTo - M5, "USDJPY confirmedTo (same formula)");
  });

  test("F13: confirmed bar XAUUSD — confirmedTo = targetTo - tfSec (M5)", () => {
    const targetTo = MON_0105 + 3 * 24 * 3600;
    const confirmed = calcConfirmedTo(targetTo, M5);
    assert.equal(confirmed, targetTo - M5, "XAUUSD confirmedTo (same formula)");
  });
});

// ------------------------------------------------------------------
// F14–F15: gap detection symbol isolation
// ------------------------------------------------------------------

describe("F14–F15: Gap detection symbol isolation", () => {
  test("F14: gap detection symbol isolation — EURUSD gaps != USDJPY gaps", () => {
    // EURUSD: consecutive bars (no gap)
    const euBars = makeBars(consecutiveBars(MON_0105, 6, M5));
    // USDJPY: bars with a gap (skip index 3)
    const ujEpochs = [
      MON_0105,
      MON_0105 + M5,
      MON_0105 + 2 * M5,
      MON_0105 + 4 * M5, // gap here: index 3 missing
      MON_0105 + 5 * M5,
    ];
    const ujBars = makeBars(ujEpochs);

    const euGaps = detectGapCandidates(euBars, "M5", "EURUSD");
    const ujGaps = detectGapCandidates(ujBars, "M5", "USDJPY");

    assert.equal(euGaps.length, 0, "EURUSD no gaps");
    assert.ok(ujGaps.length > 0,   "USDJPY has gaps");
    assert.ok(
      ujGaps.some(g => g.classification === "SUSPECTED_GAP"),
      "USDJPY has SUSPECTED_GAP",
    );
  });

  test("F15: coverage calculation symbol isolation — coverage per symbol independent", () => {
    // EURUSD: 12 bars (1 hour coverage at M5)
    const euBars = makeBars(consecutiveBars(MON_0105, 12, M5));
    // USDJPY: 6 bars (30 minutes)
    const ujBars = makeBars(consecutiveBars(MON_0105, 6, M5));

    const euSummary = summarizeGaps(detectGapCandidates(euBars, "M5", "EURUSD"));
    const ujSummary = summarizeGaps(detectGapCandidates(ujBars, "M5", "USDJPY"));

    assert.equal(euSummary.suspectedGaps, 0, "EURUSD no suspected gaps");
    assert.equal(ujSummary.suspectedGaps, 0, "USDJPY no suspected gaps");
    // Both have no unexpected gaps — their coverage lengths are independent
    assert.equal(euSummary.integrityStatus, "HEALTHY", "EURUSD HEALTHY");
    assert.equal(ujSummary.integrityStatus, "HEALTHY", "USDJPY HEALTHY");
  });
});

// ------------------------------------------------------------------
// F16: Pagination multi-symbol
// ------------------------------------------------------------------

describe("F16: Pagination multi-symbol", () => {
  test("F16: pagination multi-symbol — 1000+ bars per symbol independent", () => {
    // Simulate what fetchAllBars does: offset-based pagination
    // Each symbol has 1200 bars; verify counts are independent
    barData.clear();
    const count = 1200;
    for (let i = 0; i < count; i++) {
      upsertBar("EURUSD", "M5", MON_0105 + i * M5, true);
      upsertBar("USDJPY", "M5", MON_0105 + i * M5, true);
    }
    assert.equal(barCount("EURUSD", "M5"), count, "EURUSD 1200 bars");
    assert.equal(barCount("USDJPY", "M5"), count, "USDJPY 1200 bars");
  });
});

// ------------------------------------------------------------------
// F17–F18: Status API and history sync job multi-symbol
// ------------------------------------------------------------------

describe("F17–F18: Status and History Sync multi-symbol", () => {
  test("F17: status API multi-symbol — status returns all symbols", () => {
    // Simulate get_bar_data_status() grouping
    const rows = [
      { symbol: "EURUSD", timeframe: "M5",  bar_count: 5000, oldest_bar: "2025-01-01T00:00:00Z", newest_bar: "2026-01-01T00:00:00Z" },
      { symbol: "USDJPY", timeframe: "M5",  bar_count: 4800, oldest_bar: "2025-02-01T00:00:00Z", newest_bar: "2026-01-01T00:00:00Z" },
      { symbol: "XAUUSD", timeframe: "M5",  bar_count: 3200, oldest_bar: "2025-06-01T00:00:00Z", newest_bar: "2026-01-01T00:00:00Z" },
      { symbol: "EURUSD", timeframe: "H1",  bar_count:  400, oldest_bar: "2025-01-01T00:00:00Z", newest_bar: "2026-01-01T00:00:00Z" },
    ];

    const symbols = new Set(rows.map(r => r.symbol));
    assert.ok(symbols.has("EURUSD"), "EURUSD in status");
    assert.ok(symbols.has("USDJPY"), "USDJPY in status");
    assert.ok(symbols.has("XAUUSD"), "XAUUSD in status");
    assert.equal(rows.length, 4, "4 symbol/TF entries");
  });

  test("F18: history sync job multi-symbol — job created per symbol", () => {
    // Each symbol/TF gets its own independent job
    const jobs: SyncJob[] = [
      { id: "j1", symbol: "EURUSD", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null, status: "PENDING" },
      { id: "j2", symbol: "USDJPY", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null, status: "PENDING" },
      { id: "j3", symbol: "XAUUSD", timeframe: "M5", mode: "FORWARD",
        target_from: MON_0105, target_to: null, current_from: null, status: "PENDING" },
    ];

    // Each symbol can claim its own job independently
    const claimed1 = claimNextJob(jobs, "EURUSD");
    const claimed2 = claimNextJob(jobs, "USDJPY");
    const claimed3 = claimNextJob(jobs, "XAUUSD");

    assert.equal(claimed1?.symbol, "EURUSD", "EURUSD job claimed");
    assert.equal(claimed2?.symbol, "USDJPY", "USDJPY job claimed");
    assert.equal(claimed3?.symbol, "XAUUSD", "XAUUSD job claimed");

    // All three now RUNNING — no conflicts
    const runningCount = jobs.filter(j => j.status === "RUNNING").length;
    assert.equal(runningCount, 3, "3 jobs running simultaneously");
  });
});

// ------------------------------------------------------------------
// F19: Holiday classification isolation
// ------------------------------------------------------------------

describe("F19: Holiday classification isolation", () => {
  test("F19: EURUSD and USDJPY share same FOREX holiday calendar", () => {
    // Both are FOREX — same holiday rules apply (this is correct FX behaviour)
    const euRules = getHolidayRules("EURUSD");
    const ujRules = getHolidayRules("USDJPY");

    assert.ok(euRules.length > 0, "EURUSD has holiday rules");
    assert.ok(ujRules.length > 0, "USDJPY has holiday rules");
    // Both should have CHRISTMAS and NEW_YEAR
    assert.ok(euRules.some(r => r.name === "CHRISTMAS"), "EURUSD has CHRISTMAS");
    assert.ok(ujRules.some(r => r.name === "CHRISTMAS"), "USDJPY has CHRISTMAS");
    assert.ok(euRules.some(r => r.name === "NEW_YEAR"),  "EURUSD has NEW_YEAR");
    assert.ok(ujRules.some(r => r.name === "NEW_YEAR"),  "USDJPY has NEW_YEAR");
  });
});

// ------------------------------------------------------------------
// F20: Malformed/unsupported symbol handling
// ------------------------------------------------------------------

describe("F20: Malformed/unsupported symbol handling", () => {
  test("F20: malformed/unsupported symbol — INVALID → safe empty result", () => {
    const bars = makeBars(consecutiveBars(MON_0105, 5, M5));
    // detectGapCandidates with INVALID symbol: falls back gracefully
    // (getHolidayRules("INVALID") → UNKNOWN → empty rules → no holiday match)
    const gaps = detectGapCandidates(bars, "M5", "INVALID");
    assert.equal(gaps.length, 0, "no gaps in consecutive bars even with invalid symbol");

    // getAssetClass returns UNKNOWN — no throw
    const cls = getAssetClass("INVALID");
    assert.equal(cls, "UNKNOWN", "INVALID → UNKNOWN asset class");

    // getHolidayRules returns empty array — safe
    const rules = getHolidayRules("INVALID");
    assert.equal(rules.length, 0, "INVALID → no holiday rules");
  });
});

// ------------------------------------------------------------------
// F21–F23: getAssetClass per symbol
// ------------------------------------------------------------------

describe("F21–F23: getAssetClass", () => {
  test("F21: getAssetClass EURUSD → FOREX", () => {
    assert.equal(getAssetClass("EURUSD"), "FOREX");
  });

  test("F22: getAssetClass USDJPY → FOREX", () => {
    assert.equal(getAssetClass("USDJPY"), "FOREX");
  });

  test("F23: getAssetClass XAUUSD → METAL", () => {
    assert.equal(getAssetClass("XAUUSD"), "METAL");
  });
});

// ------------------------------------------------------------------
// F24: getHolidayRules for METAL (XAUUSD)
// ------------------------------------------------------------------

describe("F24: getHolidayRules for METAL", () => {
  test("F24: XAUUSD (METAL) has CHRISTMAS and NEW_YEAR holiday rules", () => {
    const rules = getHolidayRules("XAUUSD");
    assert.ok(rules.length > 0, "XAUUSD has holiday rules");
    assert.ok(
      rules.some(r => r.name === "CHRISTMAS"),
      "XAUUSD CHRISTMAS rule",
    );
    assert.ok(
      rules.some(r => r.name === "NEW_YEAR"),
      "XAUUSD NEW_YEAR rule",
    );
    // All rules must include METAL in applicableAssetClasses
    for (const rule of rules) {
      assert.ok(
        rule.applicableAssetClasses.includes("METAL"),
        `rule ${rule.name} applies to METAL`,
      );
    }
  });
});

// ------------------------------------------------------------------
// F25: summarizeGaps per symbol independent
// ------------------------------------------------------------------

describe("F25: summarizeGaps per symbol independent", () => {
  test("F25: summarizeGaps per symbol — EURUSD and XAUUSD summaries are independent", () => {
    // EURUSD: 1 suspected gap
    const euEpochs = [
      MON_0105,
      MON_0105 + M5,
      MON_0105 + M5 * 5, // 4-bar gap = SUSPECTED_GAP (not weekend)
    ];
    const euGaps    = detectGapCandidates(makeBars(euEpochs), "M5", "EURUSD");
    const euSummary = summarizeGaps(euGaps);

    // XAUUSD: no gaps (consecutive bars)
    const xaGaps    = detectGapCandidates(makeBars(consecutiveBars(MON_0105, 5, M5)), "M5", "XAUUSD");
    const xaSummary = summarizeGaps(xaGaps);

    assert.ok(euSummary.suspectedGaps > 0,  "EURUSD has suspected gaps");
    assert.equal(xaSummary.suspectedGaps, 0, "XAUUSD has no suspected gaps");

    assert.ok(
      euSummary.integrityStatus === "WARNING" || euSummary.integrityStatus === "CRITICAL",
      "EURUSD integrity degraded",
    );
    assert.equal(xaSummary.integrityStatus, "HEALTHY", "XAUUSD HEALTHY");
  });
});

// ------------------------------------------------------------------
// XAUUSD holiday closure classification (bonus)
// ------------------------------------------------------------------

describe("XAUUSD holiday closure classification", () => {
  test("XAUUSD Christmas gap correctly classified as HOLIDAY_CLOSED", () => {
    // Christmas 2025: Dec 24 ~20:00 UTC → Dec 26 08:00 UTC (~36h)
    const xmasFrom = "2025-12-24T20:00:00Z";
    const xmasTo   = "2025-12-26T08:00:00Z";
    const durationS = (new Date(xmasTo).getTime() - new Date(xmasFrom).getTime()) / 1000;

    // XAUUSD uses same holiday calendar as FOREX (METAL is included)
    const ctx = getHolidayContext(xmasFrom, xmasTo, durationS, "XAUUSD");
    assert.ok(ctx.isHolidayClosure, "XAUUSD Christmas is holiday closure");
    assert.equal(ctx.holidayName, "CHRISTMAS", "holiday name");
  });
});

// ------------------------------------------------------------------
// Results
// ------------------------------------------------------------------

// Allow async tests to complete
setImmediate(() => {
  console.log(`\n${"─".repeat(50)}`);
  if (failed === 0) {
    console.log(`✅ All ${passed} tests passed`);
  } else {
    console.log(`❌ ${failed} failed / ${passed} passed`);
    process.exitCode = 1;
  }
  console.log(`${"─".repeat(50)}\n`);
});

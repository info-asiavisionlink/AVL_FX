/**
 * Data Phase E — Market Schedule + Holiday Classification Tests (E01–E46)
 *
 * Target: marketSchedule.ts + marketDataGapDetection.ts (holiday extension)
 *
 * Run:
 *   npx tsx src/infrastructure/market-data/__tests__/marketSchedule.test.ts
 */

import assert from "node:assert/strict";
import {
  getAssetClass,
  getHolidayRules,
  getHolidayContext,
  HOLIDAY_MIN_DURATION_S,
  HOLIDAY_MAX_DURATION_S,
  FOREX_HOLIDAY_CALENDAR,
  type AssetClass,
} from "../marketSchedule";
import {
  detectGapCandidates,
  summarizeGaps,
  classifyGap,
  getGapSeverity,
  getIntegrityStatus,
  type GapCandidate,
} from "../marketDataGapDetection";

// ------------------------------------------------------------------
// Test runner
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
// Helpers
// ------------------------------------------------------------------

function isoAt(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function makeBars(
  startEpoch: number,
  stepSec: number,
  count: number,
): Array<{ time_utc: string }> {
  const bars: Array<{ time_utc: string }> = [];
  for (let i = 0; i < count; i++) {
    bars.push({ time_utc: isoAt(startEpoch + i * stepSec) });
  }
  return bars;
}

const M5_SEC  = 300;
const H1_SEC  = 3600;
const H4_SEC  = 14400;

// Known epoch anchors verified for day-of-week:
// 2026-08-17 00:00:00 UTC = Monday
const MON_0800_EPOCH = 1786924800;

// Christmas 2025: Dec 25 falls on Thursday
// Last M5 bar before gap: Wed 2025-12-24 19:55:00 UTC
const XMAS_GAP_FROM_EPOCH = new Date("2025-12-24T19:55:00Z").getTime() / 1000; // Wed
const XMAS_GAP_TO_EPOCH   = new Date("2025-12-26T08:00:00Z").getTime() / 1000; // Fri
const XMAS_DURATION_S     = XMAS_GAP_TO_EPOCH - XMAS_GAP_FROM_EPOCH; // 129900s ≈ 36.1h

// New Year 2026: Jan 1 falls on Thursday
// Last M5 bar before gap: Wed 2025-12-31 19:55:00 UTC
const NY_GAP_FROM_EPOCH = new Date("2025-12-31T19:55:00Z").getTime() / 1000; // Wed
const NY_GAP_TO_EPOCH   = new Date("2026-01-02T08:00:00Z").getTime() / 1000; // Fri
const NY_DURATION_S     = NY_GAP_TO_EPOCH - NY_GAP_FROM_EPOCH; // 129900s ≈ 36.1h

// Normal Friday → Monday weekend (2026-08-21 → 2026-08-24)
const FRI_22_EPOCH = 1787349600; // 2026-08-21 22:00:00 UTC Friday
const MON_24_EPOCH = 1787529600; // 2026-08-24 00:00:00 UTC Monday

// ------------------------------------------------------------------
// E01–E02: Basic gap detection (smoke tests)
// ------------------------------------------------------------------

describe("E01–E02: Basic gap detection", () => {
  test("E01: Normal continuous M5 → 0 gaps", () => {
    const bars = makeBars(MON_0800_EPOCH, M5_SEC, 288);
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 0);
  });

  test("E02: Normal Friday→Monday weekend → WEEKEND (unchanged)", () => {
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(FRI_22_EPOCH) },
      { time_utc: isoAt(MON_24_EPOCH) },
      { time_utc: isoAt(MON_24_EPOCH + M5_SEC) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.classification, "WEEKEND");
  });
});

// ------------------------------------------------------------------
// E03–E04: Holiday closure detection
// ------------------------------------------------------------------

describe("E03–E04: Holiday closure detection (real data patterns)", () => {
  test("E03: Christmas 2025 M5 closure → HOLIDAY_CLOSED", () => {
    // Real observed gap: Wed 2025-12-24 19:55 UTC → Fri 2025-12-26 08:00 UTC
    // Duration: 129900s ≈ 36.1h (just above MARKET_CLOSED_MAX_S = 129600s)
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(XMAS_GAP_FROM_EPOCH) },
      { time_utc: isoAt(XMAS_GAP_TO_EPOCH) },
      { time_utc: isoAt(XMAS_GAP_TO_EPOCH + M5_SEC) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 1, `expected 1 gap, got ${gaps.length}`);
    assert.equal(gaps[0]!.classification, "HOLIDAY_CLOSED",
      `expected HOLIDAY_CLOSED, got ${gaps[0]!.classification}`);
    assert.equal(gaps[0]!.holidayName, "CHRISTMAS");
  });

  test("E04: New Year 2026 M5 closure → HOLIDAY_CLOSED", () => {
    // Real observed gap: Wed 2025-12-31 19:55 UTC → Fri 2026-01-02 08:00 UTC
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(NY_GAP_FROM_EPOCH) },
      { time_utc: isoAt(NY_GAP_TO_EPOCH) },
      { time_utc: isoAt(NY_GAP_TO_EPOCH + M5_SEC) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.classification, "HOLIDAY_CLOSED",
      `expected HOLIDAY_CLOSED, got ${gaps[0]!.classification}`);
    assert.equal(gaps[0]!.holidayName, "NEW_YEAR");
  });
});

// ------------------------------------------------------------------
// E05–E06: False-positive protection (short gap near holiday date)
// ------------------------------------------------------------------

describe("E05–E06: False-positive protection", () => {
  test("E05: Christmas date but gap too short (< 12h) → SUSPECTED_GAP", () => {
    // A 1-hour gap on Dec 24 is just a normal intraday gap, not a holiday closure
    const from = new Date("2025-12-24T12:00:00Z").getTime() / 1000;
    const to   = new Date("2025-12-24T13:00:00Z").getTime() / 1000;
    const dur  = to - from; // 3600s < HOLIDAY_MIN_DURATION_S (43200s)
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, false,
      `1h gap near Christmas should NOT be holiday closure`);
  });

  test("E06: New Year date but gap too short (< 12h) → not holiday", () => {
    const from = new Date("2025-12-31T12:00:00Z").getTime() / 1000;
    const to   = new Date("2025-12-31T14:00:00Z").getTime() / 1000;
    const dur  = to - from; // 7200s < HOLIDAY_MIN_DURATION_S
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, false);
  });
});

// ------------------------------------------------------------------
// E07–E08: Unknown holidays and symbols
// ------------------------------------------------------------------

describe("E07–E08: Unknown holidays and symbols", () => {
  test("E07: Gap on random date with no holiday → SUSPECTED_GAP", () => {
    // March 15 is not a holiday — a 36h gap is SUSPECTED
    const from = new Date("2026-03-15T20:00:00Z").getTime() / 1000;
    const to   = new Date("2026-03-17T08:00:00Z").getTime() / 1000;
    const dur  = to - from; // ~36h
    const missingBars = Math.round(dur / M5_SEC) - 1;
    const cls = classifyGap(isoAt(from), isoAt(to), dur, missingBars, "EURUSD");
    assert.equal(cls, "SUSPECTED_GAP",
      `non-holiday 36h gap should be SUSPECTED_GAP, got ${cls}`);
  });

  test("E08: Unknown symbol → safe fallback (no holiday rules, SUSPECTED_GAP)", () => {
    // An unknown symbol returns no holiday rules, so holiday check is skipped
    const rules = getHolidayRules("XYZABC");
    assert.equal(rules.length, 0, "unknown symbol should return empty rules");

    const ctx = getHolidayContext(
      isoAt(XMAS_GAP_FROM_EPOCH), isoAt(XMAS_GAP_TO_EPOCH),
      XMAS_DURATION_S, "XYZABC",
    );
    assert.equal(ctx.isHolidayClosure, false, "unknown symbol should not trigger holiday");
  });
});

// ------------------------------------------------------------------
// E09–E10: Asset class mapping
// ------------------------------------------------------------------

describe("E09–E10: Asset class mapping", () => {
  test("E09: EURUSD → FOREX", () => {
    assert.equal(getAssetClass("EURUSD"), "FOREX");
  });

  test("E10: Additional FOREX symbols map correctly", () => {
    const forexSymbols: string[] = ["GBPUSD", "USDJPY", "AUDUSD", "USDCHF", "USDCAD", "NZDUSD", "EURGBP"];
    for (const sym of forexSymbols) {
      assert.equal(getAssetClass(sym), "FOREX", `${sym} should be FOREX`);
    }
    assert.equal(getAssetClass("XAUUSD"), "METAL", "XAUUSD should be METAL");
    assert.equal(getAssetClass("BTCUSD"), "CRYPTO", "BTCUSD should be CRYPTO");
    assert.equal(getAssetClass("UNKNOWN_PAIR"), "UNKNOWN", "unknown should be UNKNOWN");
  });
});

// ------------------------------------------------------------------
// E11–E13: Missing bar semantics
// ------------------------------------------------------------------

describe("E11–E13: Missing bar semantics", () => {
  test("E11: rawMissingBars calculation for holiday gap", () => {
    // XMAS gap: 129900s / 300s = 433 periods → 432 missing
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(XMAS_GAP_FROM_EPOCH) },
      { time_utc: isoAt(XMAS_GAP_TO_EPOCH) },
      { time_utc: isoAt(XMAS_GAP_TO_EPOCH + M5_SEC) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.rawMissingBars, 432,
      `expected 432 rawMissingBars, got ${gaps[0]!.rawMissingBars}`);
    assert.equal(gaps[0]!.missingBars, 432, "missingBars alias should equal rawMissingBars");
  });

  test("E12: unexpectedMissingBars for HOLIDAY_CLOSED gap = 0", () => {
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(XMAS_GAP_FROM_EPOCH) },
      { time_utc: isoAt(XMAS_GAP_TO_EPOCH) },
      { time_utc: isoAt(XMAS_GAP_TO_EPOCH + M5_SEC) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps[0]!.unexpectedMissingBars, 0,
      "HOLIDAY_CLOSED unexpectedMissingBars should be 0");
  });

  test("E13: unexpectedMissingBars for SUSPECTED_GAP > 0", () => {
    // A non-holiday 36h gap on a Wednesday → SUSPECTED_GAP
    const from = new Date("2026-06-10T20:00:00Z").getTime() / 1000; // Wednesday
    const to   = new Date("2026-06-12T08:00:00Z").getTime() / 1000; // Friday
    const dur  = to - from;
    const missing = Math.round(dur / M5_SEC) - 1;
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(from) },
      { time_utc: isoAt(to) },
      { time_utc: isoAt(to + M5_SEC) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.classification, "SUSPECTED_GAP",
      `expected SUSPECTED_GAP, got ${gaps[0]!.classification}`);
    assert.equal(gaps[0]!.unexpectedMissingBars, missing,
      `unexpectedMissingBars should equal ${missing}`);
  });
});

// ------------------------------------------------------------------
// E14–E19: Integrity status
// ------------------------------------------------------------------

describe("E14–E19: Integrity status with holiday", () => {
  test("E14: Holiday only → HEALTHY", () => {
    const gaps: GapCandidate[] = [{
      from: isoAt(XMAS_GAP_FROM_EPOCH),
      to: isoAt(XMAS_GAP_TO_EPOCH),
      durationSeconds: XMAS_DURATION_S,
      rawMissingBars: 432,
      missingBars: 432,
      unexpectedMissingBars: 0,
      classification: "HOLIDAY_CLOSED",
      severity: "INFO",
      holidayName: "CHRISTMAS",
    }];
    assert.equal(getIntegrityStatus(gaps), "HEALTHY");
  });

  test("E15: Weekend only → HEALTHY", () => {
    const gaps: GapCandidate[] = [{
      from: isoAt(FRI_22_EPOCH),
      to: isoAt(MON_24_EPOCH),
      durationSeconds: MON_24_EPOCH - FRI_22_EPOCH,
      rawMissingBars: 576,
      missingBars: 576,
      unexpectedMissingBars: 0,
      classification: "WEEKEND",
      severity: "INFO",
    }];
    assert.equal(getIntegrityStatus(gaps), "HEALTHY");
  });

  test("E16: SUSPECTED 1 bar → WARNING", () => {
    const gaps: GapCandidate[] = [{
      from: isoAt(MON_0800_EPOCH),
      to: isoAt(MON_0800_EPOCH + M5_SEC * 2),
      durationSeconds: M5_SEC * 2,
      rawMissingBars: 1,
      missingBars: 1,
      unexpectedMissingBars: 1,
      classification: "SUSPECTED_GAP",
      severity: "WARNING",
    }];
    assert.equal(getIntegrityStatus(gaps), "WARNING");
  });

  test("E17: SUSPECTED >= 3 bars → CRITICAL", () => {
    const gaps: GapCandidate[] = [{
      from: isoAt(MON_0800_EPOCH),
      to: isoAt(MON_0800_EPOCH + M5_SEC * 4),
      durationSeconds: M5_SEC * 4,
      rawMissingBars: 3,
      missingBars: 3,
      unexpectedMissingBars: 3,
      classification: "SUSPECTED_GAP",
      severity: "CRITICAL",
    }];
    assert.equal(getIntegrityStatus(gaps), "CRITICAL");
  });

  test("E18: Holiday + SUSPECTED mixed → WARNING or CRITICAL based on severity", () => {
    const gaps: GapCandidate[] = [
      {
        from: isoAt(XMAS_GAP_FROM_EPOCH),
        to: isoAt(XMAS_GAP_TO_EPOCH),
        durationSeconds: XMAS_DURATION_S,
        rawMissingBars: 432,
        missingBars: 432,
        unexpectedMissingBars: 0,
        classification: "HOLIDAY_CLOSED",
        severity: "INFO",
        holidayName: "CHRISTMAS",
      },
      {
        from: isoAt(MON_0800_EPOCH),
        to: isoAt(MON_0800_EPOCH + M5_SEC * 2),
        durationSeconds: M5_SEC * 2,
        rawMissingBars: 1,
        missingBars: 1,
        unexpectedMissingBars: 1,
        classification: "SUSPECTED_GAP",
        severity: "WARNING",
      },
    ];
    assert.equal(getIntegrityStatus(gaps), "WARNING");
  });

  test("E19: Weekend + Holiday mixed → HEALTHY", () => {
    const gaps: GapCandidate[] = [
      {
        from: isoAt(FRI_22_EPOCH),
        to: isoAt(MON_24_EPOCH),
        durationSeconds: MON_24_EPOCH - FRI_22_EPOCH,
        rawMissingBars: 576,
        missingBars: 576,
        unexpectedMissingBars: 0,
        classification: "WEEKEND",
        severity: "INFO",
      },
      {
        from: isoAt(XMAS_GAP_FROM_EPOCH),
        to: isoAt(XMAS_GAP_TO_EPOCH),
        durationSeconds: XMAS_DURATION_S,
        rawMissingBars: 432,
        missingBars: 432,
        unexpectedMissingBars: 0,
        classification: "HOLIDAY_CLOSED",
        severity: "INFO",
        holidayName: "CHRISTMAS",
      },
    ];
    assert.equal(getIntegrityStatus(gaps), "HEALTHY");
  });
});

// ------------------------------------------------------------------
// E20–E22: Multiple timeframes
// ------------------------------------------------------------------

describe("E20–E22: Multiple timeframes", () => {
  test("E20: M5 Christmas gap → HOLIDAY_CLOSED", () => {
    // M5: from=Dec24 19:55 UTC, to=Dec26 08:00 UTC, dur=129900s
    const xmasFrom = new Date("2025-12-24T19:55:00Z").getTime() / 1000;
    const xmasTo   = new Date("2025-12-26T08:00:00Z").getTime() / 1000;
    const ctx = getHolidayContext(isoAt(xmasFrom), isoAt(xmasTo), xmasTo - xmasFrom, "EURUSD");
    assert.equal(ctx.isHolidayClosure, true);
    assert.equal(ctx.holidayName, "CHRISTMAS");
  });

  test("E21: H1 Christmas gap → HOLIDAY_CLOSED", () => {
    // H1: from=Dec24 19:00 UTC, to=Dec26 08:00 UTC, dur=133200s
    const xmasFrom = new Date("2025-12-24T19:00:00Z").getTime() / 1000;
    const xmasTo   = new Date("2025-12-26T08:00:00Z").getTime() / 1000;
    const ctx = getHolidayContext(isoAt(xmasFrom), isoAt(xmasTo), xmasTo - xmasFrom, "EURUSD");
    assert.equal(ctx.isHolidayClosure, true);
    assert.equal(ctx.holidayName, "CHRISTMAS");
  });

  test("E22: H4 Christmas gap → HOLIDAY_CLOSED", () => {
    // H4: from=Dec24 16:00 UTC, to=Dec26 08:00 UTC, dur=144000s
    const xmasFrom = new Date("2025-12-24T16:00:00Z").getTime() / 1000;
    const xmasTo   = new Date("2025-12-26T08:00:00Z").getTime() / 1000;
    const ctx = getHolidayContext(isoAt(xmasFrom), isoAt(xmasTo), xmasTo - xmasFrom, "EURUSD");
    assert.equal(ctx.isHolidayClosure, true);
    assert.equal(ctx.holidayName, "CHRISTMAS");
  });
});

// ------------------------------------------------------------------
// E23–E27: Year boundary and multi-year checks
// ------------------------------------------------------------------

describe("E23–E27: Year boundary and multi-year", () => {
  test("E23: Year boundary gap (Dec31 → Jan2) → NEW_YEAR", () => {
    // New Year gap crosses year boundary: Dec 31 → Jan 2
    const ctx = getHolidayContext(
      isoAt(NY_GAP_FROM_EPOCH), isoAt(NY_GAP_TO_EPOCH),
      NY_DURATION_S, "EURUSD",
    );
    assert.equal(ctx.isHolidayClosure, true);
    assert.equal(ctx.holidayName, "NEW_YEAR");
  });

  test("E24: Christmas 2025 (Dec 25 = Thursday) → HOLIDAY_CLOSED", () => {
    // Observed: Dec24 20:00 UTC → Dec26 08:00 UTC
    const from = new Date("2025-12-24T20:00:00Z").getTime() / 1000;
    const to   = new Date("2025-12-26T08:00:00Z").getTime() / 1000;
    const ctx = getHolidayContext(isoAt(from), isoAt(to), to - from, "EURUSD");
    assert.equal(ctx.isHolidayClosure, true, "Christmas 2025 should be HOLIDAY_CLOSED");
    assert.equal(ctx.holidayName, "CHRISTMAS");
  });

  test("E25: Christmas 2026 (Dec 25 = Friday) → HOLIDAY_CLOSED", () => {
    // When Dec 25 is Friday: typical gap might be Dec 24 Thu → Dec 28 Mon
    const from = new Date("2026-12-24T22:00:00Z").getTime() / 1000;
    const to   = new Date("2026-12-28T00:00:00Z").getTime() / 1000;
    const dur  = to - from; // ~74h — within HOLIDAY window
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, true, "Christmas 2026 should be HOLIDAY_CLOSED");
    assert.equal(ctx.holidayName, "CHRISTMAS");
  });

  test("E26: New Year 2026 (Jan 1 = Thursday) → HOLIDAY_CLOSED", () => {
    const ctx = getHolidayContext(
      isoAt(NY_GAP_FROM_EPOCH), isoAt(NY_GAP_TO_EPOCH),
      NY_DURATION_S, "EURUSD",
    );
    assert.equal(ctx.isHolidayClosure, true, "New Year 2026 should be HOLIDAY_CLOSED");
    assert.equal(ctx.holidayName, "NEW_YEAR");
  });

  test("E27: New Year 2027 (Jan 1 = Friday) → HOLIDAY_CLOSED", () => {
    // When Jan 1 is Friday: gap might be Dec 31 Thu → Jan 3 Mon
    const from = new Date("2026-12-31T22:00:00Z").getTime() / 1000;
    const to   = new Date("2027-01-03T00:00:00Z").getTime() / 1000;
    const dur  = to - from;
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, true, "New Year 2027 should be HOLIDAY_CLOSED");
    assert.equal(ctx.holidayName, "NEW_YEAR");
  });
});

// ------------------------------------------------------------------
// E28–E30: Leap year and DST periods
// ------------------------------------------------------------------

describe("E28–E30: Leap year and DST", () => {
  test("E28: Leap year safety (2028-02-29) — normal date, not holiday", () => {
    // Feb 29 is not a holiday — a gap should remain SUSPECTED_GAP
    const from = new Date("2028-02-29T10:00:00Z").getTime() / 1000;
    const to   = new Date("2028-03-01T22:00:00Z").getTime() / 1000;
    const dur  = to - from; // ~36h
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, false, "Feb 29 is not a holiday");
  });

  test("E29: DST spring (2026-03-29) — normal weekend gap, no holiday", () => {
    // European DST change — should not affect holiday logic
    const from = new Date("2026-03-27T22:00:00Z").getTime() / 1000; // Friday
    const to   = new Date("2026-03-30T00:00:00Z").getTime() / 1000; // Monday
    const dur  = to - from; // ~50h weekend gap
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, false, "DST weekend should not be holiday");
  });

  test("E30: DST autumn (2026-10-25) — normal weekend gap, no holiday", () => {
    const from = new Date("2026-10-23T22:00:00Z").getTime() / 1000; // Friday
    const to   = new Date("2026-10-26T00:00:00Z").getTime() / 1000; // Monday
    const dur  = to - from;
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, false, "Autumn DST weekend should not be holiday");
  });
});

// ------------------------------------------------------------------
// E31–E35: Correctness and robustness
// ------------------------------------------------------------------

describe("E31–E35: Correctness and robustness", () => {
  test("E31: No fixed UTC broker close time dependency", () => {
    // Holiday check works regardless of the exact hour within the window
    // Test same Christmas at different hours (19:00, 20:00, 21:00 UTC from)
    const hours = [18, 19, 20, 21];
    for (const h of hours) {
      const from = new Date(`2025-12-24T${String(h).padStart(2, "0")}:00:00Z`).getTime() / 1000;
      const to   = new Date("2025-12-26T08:00:00Z").getTime() / 1000;
      const dur  = to - from;
      if (dur < HOLIDAY_MIN_DURATION_S) continue; // skip if too short
      const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
      assert.equal(ctx.isHolidayClosure, true,
        `Christmas at hour ${h}:00 UTC should be HOLIDAY_CLOSED`);
    }
  });

  test("E32: Duplicate timestamp resilience", () => {
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(MON_0800_EPOCH) },
      { time_utc: isoAt(MON_0800_EPOCH) }, // duplicate
      { time_utc: isoAt(MON_0800_EPOCH + M5_SEC) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 0, "duplicate timestamp produces no gap");
  });

  test("E33: Out-of-order bars handled (no gap from negative duration)", () => {
    const bars: Array<{ time_utc: string }> = [
      { time_utc: isoAt(MON_0800_EPOCH + M5_SEC * 5) },
      { time_utc: isoAt(MON_0800_EPOCH) },
    ];
    const gaps = detectGapCandidates(bars, "M5", "EURUSD");
    assert.equal(gaps.length, 0, "out-of-order bars: negative duration skipped");
  });

  test("E34: 1000+ bars → correct holiday detection in middle of set", () => {
    // Build bars up to Christmas, insert holiday gap, then continue
    const preXmas  = makeBars(MON_0800_EPOCH, M5_SEC, 500);
    const lastPreXmas = preXmas[preXmas.length - 1]!;
    const postXmasStart = XMAS_GAP_TO_EPOCH;
    const postXmas = makeBars(postXmasStart, M5_SEC, 500);

    // Insert the actual holiday gap bar at the beginning of postXmas
    const allBars = [
      ...preXmas,
      { time_utc: isoAt(XMAS_GAP_FROM_EPOCH) }, // last bar before gap
      { time_utc: isoAt(XMAS_GAP_TO_EPOCH) },   // first bar after gap
      ...postXmas.slice(1),
    ];

    // Sort by time to ensure correct ordering
    allBars.sort((a, b) => new Date(a.time_utc).getTime() - new Date(b.time_utc).getTime());

    const gaps = detectGapCandidates(allBars, "M5", "EURUSD");
    const holidayGaps = gaps.filter(g => g.classification === "HOLIDAY_CLOSED");
    assert.ok(holidayGaps.length >= 1,
      `expected at least 1 HOLIDAY_CLOSED gap in 1000+ bar set`);

    // Suppress unused variable warning
    void lastPreXmas;
  });

  test("E35: 73000+ bars performance < 500ms", () => {
    const start = Date.now();
    const bars = makeBars(MON_0800_EPOCH, M5_SEC, 73216);
    detectGapCandidates(bars, "M5", "EURUSD");
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `73216 bars took ${elapsed}ms (expected <500ms)`);
  });
});

// ------------------------------------------------------------------
// E36–E37: Summary semantics and API backward compat
// ------------------------------------------------------------------

describe("E36–E37: Summary and backward compat", () => {
  test("E36: API backward compatibility — existing fields present", () => {
    const gaps: GapCandidate[] = [
      {
        from: isoAt(XMAS_GAP_FROM_EPOCH),
        to: isoAt(XMAS_GAP_TO_EPOCH),
        durationSeconds: XMAS_DURATION_S,
        rawMissingBars: 432,
        missingBars: 432,
        unexpectedMissingBars: 0,
        classification: "HOLIDAY_CLOSED",
        severity: "INFO",
        holidayName: "CHRISTMAS",
      },
      {
        from: isoAt(FRI_22_EPOCH),
        to: isoAt(MON_24_EPOCH),
        durationSeconds: MON_24_EPOCH - FRI_22_EPOCH,
        rawMissingBars: 576,
        missingBars: 576,
        unexpectedMissingBars: 0,
        classification: "WEEKEND",
        severity: "INFO",
      },
    ];
    const s = summarizeGaps(gaps);
    // Backward-compat fields
    assert.ok("candidateGaps"   in s, "candidateGaps present");
    assert.ok("normalClosures"  in s, "normalClosures present");
    assert.ok("suspectedGaps"   in s, "suspectedGaps present");
    assert.ok("missingBars"     in s, "missingBars present (compat alias)");
    assert.ok("warningCount"    in s, "warningCount present");
    assert.ok("criticalCount"   in s, "criticalCount present");
    assert.ok("integrityStatus" in s, "integrityStatus present");
    // New fields
    assert.ok("weekendClosures"       in s, "weekendClosures present");
    assert.ok("holidayClosures"       in s, "holidayClosures present");
    assert.ok("marketClosures"        in s, "marketClosures present");
    assert.ok("rawMissingBars"        in s, "rawMissingBars present");
    assert.ok("unexpectedMissingBars" in s, "unexpectedMissingBars present");
  });

  test("E37: Summary semantics — holidayClosures, rawMissingBars, unexpectedMissingBars", () => {
    const gaps: GapCandidate[] = [
      {
        from: isoAt(XMAS_GAP_FROM_EPOCH),
        to: isoAt(XMAS_GAP_TO_EPOCH),
        durationSeconds: XMAS_DURATION_S,
        rawMissingBars: 432,
        missingBars: 432,
        unexpectedMissingBars: 0,
        classification: "HOLIDAY_CLOSED",
        severity: "INFO",
        holidayName: "CHRISTMAS",
      },
      {
        from: isoAt(NY_GAP_FROM_EPOCH),
        to: isoAt(NY_GAP_TO_EPOCH),
        durationSeconds: NY_DURATION_S,
        rawMissingBars: 432,
        missingBars: 432,
        unexpectedMissingBars: 0,
        classification: "HOLIDAY_CLOSED",
        severity: "INFO",
        holidayName: "NEW_YEAR",
      },
      {
        from: isoAt(FRI_22_EPOCH),
        to: isoAt(MON_24_EPOCH),
        durationSeconds: MON_24_EPOCH - FRI_22_EPOCH,
        rawMissingBars: 576,
        missingBars: 576,
        unexpectedMissingBars: 0,
        classification: "WEEKEND",
        severity: "INFO",
      },
    ];
    const s = summarizeGaps(gaps);
    assert.equal(s.candidateGaps,          3,   "3 total gaps");
    assert.equal(s.holidayClosures,        2,   "2 holiday closures");
    assert.equal(s.weekendClosures,        1,   "1 weekend closure");
    assert.equal(s.marketClosures,         0,   "0 market closures");
    assert.equal(s.normalClosures,         3,   "normalClosures = 2+1+0");
    assert.equal(s.suspectedGaps,          0,   "0 suspected gaps");
    assert.equal(s.rawMissingBars,         432+432+576, "rawMissingBars = sum of all");
    assert.equal(s.unexpectedMissingBars,  0,   "no unexpected missing");
    assert.equal(s.missingBars,            0,   "missingBars compat alias = 0");
    assert.equal(s.integrityStatus,       "HEALTHY");
  });
});

// ------------------------------------------------------------------
// E38–E40: UI helper and edge cases
// ------------------------------------------------------------------

describe("E38–E40: UI helpers and edge cases", () => {
  test("E38: HOLIDAY_CLOSED badge label exists in gap classification types", () => {
    // Verify the type is correct by assigning a gap with HOLIDAY_CLOSED
    const g: GapCandidate = {
      from: isoAt(XMAS_GAP_FROM_EPOCH),
      to: isoAt(XMAS_GAP_TO_EPOCH),
      durationSeconds: XMAS_DURATION_S,
      rawMissingBars: 432,
      missingBars: 432,
      unexpectedMissingBars: 0,
      classification: "HOLIDAY_CLOSED",
      severity: "INFO",
      holidayName: "CHRISTMAS",
    };
    assert.equal(g.classification, "HOLIDAY_CLOSED");
    assert.equal(g.holidayName, "CHRISTMAS");
  });

  test("E39: Unsupported timeframe → empty gap list", () => {
    const bars = makeBars(MON_0800_EPOCH, M5_SEC, 10);
    const gaps = detectGapCandidates(bars, "INVALID", "EURUSD");
    assert.equal(gaps.length, 0, "unknown TF → no gaps");
  });

  test("E40: Empty bar array → empty gaps", () => {
    const gaps = detectGapCandidates([], "M5", "EURUSD");
    const summary = summarizeGaps(gaps);
    assert.equal(gaps.length, 0);
    assert.equal(summary.candidateGaps, 0);
    assert.equal(summary.holidayClosures, 0);
    assert.equal(summary.unexpectedMissingBars, 0);
    assert.equal(summary.integrityStatus, "HEALTHY");
  });
});

// ------------------------------------------------------------------
// E41–E46: Additional correctness tests
// ------------------------------------------------------------------

describe("E41–E46: Classification priority and semantics", () => {
  test("E41: holidayName in gap result matches expected names", () => {
    const xmasCtx = getHolidayContext(
      isoAt(XMAS_GAP_FROM_EPOCH), isoAt(XMAS_GAP_TO_EPOCH),
      XMAS_DURATION_S, "EURUSD",
    );
    assert.equal(xmasCtx.holidayName, "CHRISTMAS");

    const nyCtx = getHolidayContext(
      isoAt(NY_GAP_FROM_EPOCH), isoAt(NY_GAP_TO_EPOCH),
      NY_DURATION_S, "EURUSD",
    );
    assert.equal(nyCtx.holidayName, "NEW_YEAR");
  });

  test("E42: Classification priority — WEEKEND takes priority over HOLIDAY", () => {
    // A gap that is Fri→Mon AND within holiday window should be WEEKEND
    // (WEEKEND check comes before holiday check in classifyGap)
    // Construct a scenario where Dec 25 falls on Monday: from=Friday, to=Monday Dec 25
    // For this specific test: not realistic in 2025, use direct classifyGap call
    // Friday → Monday within weekend duration range → WEEKEND (regardless of holiday)
    const durationS = MON_24_EPOCH - FRI_22_EPOCH; // ~50h, within WEEKEND range
    const missing = Math.round(durationS / M5_SEC) - 1;
    const cls = classifyGap(isoAt(FRI_22_EPOCH), isoAt(MON_24_EPOCH), durationS, missing, "EURUSD");
    assert.equal(cls, "WEEKEND", "Fri→Mon should always be WEEKEND regardless of symbol");
  });

  test("E43: Holiday proximity false-positive protection — gap < HOLIDAY_MIN_DURATION_S", () => {
    // 30-minute gap on Dec 24 should NOT be holiday
    const from = new Date("2025-12-24T15:00:00Z").getTime() / 1000;
    const to   = new Date("2025-12-24T15:30:00Z").getTime() / 1000;
    const dur  = to - from; // 1800s << 43200s (HOLIDAY_MIN_DURATION_S)
    const ctx = getHolidayContext(isoAt(from), isoAt(to), dur, "EURUSD");
    assert.equal(ctx.isHolidayClosure, false,
      "30-minute gap near Christmas should not be holiday closure");
  });

  test("E44: Normal weekday 36h gap in June remains SUSPECTED_GAP", () => {
    // Wednesday June 10 → Friday June 12 in 2026 — not a holiday
    const from = new Date("2026-06-10T20:00:00Z").getTime() / 1000;
    const to   = new Date("2026-06-12T08:00:00Z").getTime() / 1000;
    const dur  = to - from; // ~36h
    const missing = Math.round(dur / M5_SEC) - 1;
    const cls = classifyGap(isoAt(from), isoAt(to), dur, missing, "EURUSD");
    assert.equal(cls, "SUSPECTED_GAP",
      `Non-holiday 36h gap should remain SUSPECTED_GAP, got ${cls}`);
  });

  test("E45: HOLIDAY_CLOSED severity is always INFO", () => {
    const sev = getGapSeverity("HOLIDAY_CLOSED", 432);
    assert.equal(sev, "INFO", "holiday closure should be INFO regardless of bar count");
  });

  test("E46: Integrity status ignores expected closures (holiday + weekend)", () => {
    // Build a realistic dataset: 51 weekends + 2 holiday closures, 0 suspected
    const weekendGaps: GapCandidate[] = Array.from({ length: 51 }, (_, i) => ({
      from: isoAt(FRI_22_EPOCH + i * 7 * 86400),
      to:   isoAt(MON_24_EPOCH + i * 7 * 86400),
      durationSeconds: MON_24_EPOCH - FRI_22_EPOCH,
      rawMissingBars: 576,
      missingBars: 576,
      unexpectedMissingBars: 0,
      classification: "WEEKEND" as const,
      severity: "INFO" as const,
    }));

    const holidayGaps: GapCandidate[] = [
      {
        from: isoAt(XMAS_GAP_FROM_EPOCH),
        to: isoAt(XMAS_GAP_TO_EPOCH),
        durationSeconds: XMAS_DURATION_S,
        rawMissingBars: 432,
        missingBars: 432,
        unexpectedMissingBars: 0,
        classification: "HOLIDAY_CLOSED",
        severity: "INFO",
        holidayName: "CHRISTMAS",
      },
      {
        from: isoAt(NY_GAP_FROM_EPOCH),
        to: isoAt(NY_GAP_TO_EPOCH),
        durationSeconds: NY_DURATION_S,
        rawMissingBars: 432,
        missingBars: 432,
        unexpectedMissingBars: 0,
        classification: "HOLIDAY_CLOSED",
        severity: "INFO",
        holidayName: "NEW_YEAR",
      },
    ];

    const allGaps = [...weekendGaps, ...holidayGaps];
    const s = summarizeGaps(allGaps);

    assert.equal(s.weekendClosures, 51,   "51 weekend closures");
    assert.equal(s.holidayClosures, 2,    "2 holiday closures");
    assert.equal(s.suspectedGaps,   0,    "0 suspected gaps");
    assert.equal(s.unexpectedMissingBars, 0, "no unexpected missing bars");
    assert.equal(s.integrityStatus, "HEALTHY",
      `Expected HEALTHY with only expected closures, got ${s.integrityStatus}`);
  });
});

// ------------------------------------------------------------------
// Verify HOLIDAY_MIN/MAX constants are reasonable
// ------------------------------------------------------------------

describe("Phase E constant sanity checks", () => {
  test("HOLIDAY_MIN_DURATION_S = 12h", () => {
    assert.equal(HOLIDAY_MIN_DURATION_S, 12 * 3600);
  });

  test("HOLIDAY_MAX_DURATION_S = 4 days", () => {
    assert.equal(HOLIDAY_MAX_DURATION_S, 4 * 24 * 3600);
  });

  test("FOREX_HOLIDAY_CALENDAR has CHRISTMAS and NEW_YEAR", () => {
    const names = FOREX_HOLIDAY_CALENDAR.map(r => r.name);
    assert.ok(names.includes("CHRISTMAS"), "CHRISTMAS in calendar");
    assert.ok(names.includes("NEW_YEAR"),  "NEW_YEAR in calendar");
  });

  test("Observed Christmas gap (129900s) is within HOLIDAY range", () => {
    assert.ok(XMAS_DURATION_S >= HOLIDAY_MIN_DURATION_S,
      `${XMAS_DURATION_S}s >= ${HOLIDAY_MIN_DURATION_S}s (HOLIDAY_MIN)`);
    assert.ok(XMAS_DURATION_S <= HOLIDAY_MAX_DURATION_S,
      `${XMAS_DURATION_S}s <= ${HOLIDAY_MAX_DURATION_S}s (HOLIDAY_MAX)`);
  });
});

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------

setTimeout(() => {
  console.log(`\n${"=".repeat(55)}`);
  console.log(`Data Phase E Market Schedule Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
}, 0);

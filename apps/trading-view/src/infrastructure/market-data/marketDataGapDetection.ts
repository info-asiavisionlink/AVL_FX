// =================================================================
// Market Data Gap Detection — Pure Functions
//
// Classifies time gaps between consecutive bars as NORMAL, WEEKEND,
// HOLIDAY_CLOSED, MARKET_CLOSED, or SUSPECTED_GAP. All functions are
// pure: no I/O, no side effects, deterministic output.
//
// Design principle: no hard-coded UTC clock times (DST-safe).
// Weekend detection uses day-of-week + duration heuristics only.
// Holiday detection uses calendar windows derived from real bar data.
// =================================================================

import { getHolidayContext } from "./marketSchedule";

export type GapClassification =
  | "NORMAL"
  | "WEEKEND"
  | "HOLIDAY_CLOSED"   // Phase E — known holiday closure
  | "MARKET_CLOSED"
  | "SUSPECTED_GAP";

export type GapSeverity = "INFO" | "WARNING" | "CRITICAL";

export type IntegrityStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "NO_DATA";

export interface GapCandidate {
  from: string;                // ISO8601 UTC — current bar の time_utc
  to: string;                  // ISO8601 UTC — next bar の time_utc
  durationSeconds: number;
  rawMissingBars?: number;     // Phase E: total bars absent between from and to
  missingBars: number;         // backward-compatible: equals rawMissingBars when produced by detectGapCandidates
  unexpectedMissingBars?: number; // Phase E: 0 for expected closures; equals rawMissingBars for SUSPECTED_GAP
  classification: GapClassification;
  severity: GapSeverity;
  holidayName?: string | null; // set only when classification === "HOLIDAY_CLOSED"
}

export interface GapSummary {
  candidateGaps: number;
  normalClosures: number;       // backward-compat: weekendClosures + holidayClosures + marketClosures
  weekendClosures: number;
  holidayClosures: number;
  marketClosures: number;
  suspectedGaps: number;
  rawMissingBars: number;       // total missing bars across ALL gap types
  missingBars: number;          // backward-compat alias: unexpectedMissingBars
  unexpectedMissingBars: number; // missing bars in SUSPECTED_GAP only
  warningCount: number;
  criticalCount: number;
  integrityStatus: IntegrityStatus;
}

// ------------------------------------------------------------------
// Thresholds (pure functions reference these)
// ------------------------------------------------------------------

const SEVERITY_THRESHOLDS = {
  WARNING_MIN_MISSING:  1,
  CRITICAL_MIN_MISSING: 3,  // SUSPECTED_GAP + missing >= 3 → CRITICAL
} as const;

// FX weekend gap: Friday UTC → Monday UTC
// DST-safe: use day-of-week + duration, not fixed clock times.
// Range: 1.5 days (short DST weekend) → 4 days (long holiday edge)
const WEEKEND_DURATION_MIN_S = 1.5 * 24 * 3600; // 129 600
const WEEKEND_DURATION_MAX_S = 4.0 * 24 * 3600; // 345 600

// Short market closure (public holiday intraday, e.g. early close):
// 1 hour → 1.5 days, not a weekend
const MARKET_CLOSED_DURATION_MIN_S = 3600;
const MARKET_CLOSED_DURATION_MAX_S = WEEKEND_DURATION_MIN_S - 1;

// ------------------------------------------------------------------
// timeframe string → seconds
// ------------------------------------------------------------------

const TF_SECONDS_MAP: Record<string, number> = {
  M1:  60,
  M5:  300,
  M15: 900,
  M30: 1800,
  H1:  3600,
  H4:  14400,
  D1:  86400,
  W1:  604800,
};

/**
 * Converts a timeframe string (e.g. "M5", "H1") to seconds.
 * Returns 0 for unknown timeframes.
 */
export function getTimeframeSeconds(timeframe: string): number {
  return TF_SECONDS_MAP[timeframe.toUpperCase()] ?? 0;
}

// ------------------------------------------------------------------
// Missing bar calculation
// ------------------------------------------------------------------

/**
 * Calculates the number of bars missing between two consecutive
 * bar timestamps. A gap of exactly one timeframe = 0 missing bars.
 * Negative durations (out-of-order) return 0.
 */
export function calculateMissingBars(
  currentTimeISO: string,
  nextTimeISO: string,
  timeframeSeconds: number,
): number {
  if (timeframeSeconds <= 0) return 0;
  const currentMs = new Date(currentTimeISO).getTime();
  const nextMs    = new Date(nextTimeISO).getTime();
  const durationS = (nextMs - currentMs) / 1000;
  if (durationS <= 0) return 0;
  // How many full bars fit in the gap, minus the one expected bar
  const bars = Math.round(durationS / timeframeSeconds);
  return Math.max(0, bars - 1);
}

// ------------------------------------------------------------------
// Gap classification
// ------------------------------------------------------------------

/** Returns UTC day-of-week: 0=Sunday … 6=Saturday */
function utcDayOfWeek(isoString: string): number {
  return new Date(isoString).getUTCDay();
}

/**
 * Classifies a gap between two consecutive bars.
 *
 * Priority order:
 * 1. No missing bars → NORMAL
 * 2. Friday→Monday + weekend duration range → WEEKEND
 * 3. Holiday window match (calendar-aware) → HOLIDAY_CLOSED
 * 4. Not weekend + moderate duration → MARKET_CLOSED (holiday/early close)
 * 5. Everything else with missing bars → SUSPECTED_GAP
 *
 * @param symbol  Optional. Used for holiday calendar lookup.
 *                Defaults to "EURUSD" for backward compatibility.
 */
export function classifyGap(
  currentTimeISO: string,
  nextTimeISO: string,
  durationSeconds: number,
  missingBars: number,
  symbol = "EURUSD",
): GapClassification {
  if (missingBars === 0) return "NORMAL";

  const dayOfCurrent = utcDayOfWeek(currentTimeISO); // 0=Sun…6=Sat
  const dayOfNext    = utcDayOfWeek(nextTimeISO);

  // Weekend: current bar closes on a Friday (5) or Saturday (6),
  // next bar opens on a Monday (1) or Sunday (0→late Sunday),
  // and the gap duration falls in the expected weekend range.
  // We also allow Saturday→Monday for edge cases (e.g. D1/H4 bars).
  const currentIsFridayOrSat = dayOfCurrent === 5 || dayOfCurrent === 6;
  const nextIsMonOrSun       = dayOfNext === 1 || dayOfNext === 0;

  if (
    currentIsFridayOrSat &&
    nextIsMonOrSun &&
    durationSeconds >= WEEKEND_DURATION_MIN_S &&
    durationSeconds <= WEEKEND_DURATION_MAX_S
  ) {
    return "WEEKEND";
  }

  // Phase E — Holiday closure: calendar-aware check.
  // Must come before MARKET_CLOSED so that holiday gaps exceeding
  // MARKET_CLOSED_MAX_S (e.g. 36h Christmas/New Year closures) are
  // correctly classified rather than falling into SUSPECTED_GAP.
  const holidayCtx = getHolidayContext(currentTimeISO, nextTimeISO, durationSeconds, symbol);
  if (holidayCtx.isHolidayClosure) {
    return "HOLIDAY_CLOSED";
  }

  // Market closure (holiday, bank holiday, early close):
  // moderate gap that is NOT in the weekend pattern
  if (
    durationSeconds >= MARKET_CLOSED_DURATION_MIN_S &&
    durationSeconds <= MARKET_CLOSED_DURATION_MAX_S
  ) {
    return "MARKET_CLOSED";
  }

  // All other gaps with missing bars → potential data integrity issue
  return "SUSPECTED_GAP";
}

// ------------------------------------------------------------------
// Gap severity
// ------------------------------------------------------------------

/**
 * Returns severity for a gap based on classification and missing bar
 * count. Only SUSPECTED_GAP gaps can be WARNING or CRITICAL.
 * WEEKEND, HOLIDAY_CLOSED, and MARKET_CLOSED are always INFO.
 */
export function getGapSeverity(
  classification: GapClassification,
  missingBars: number,
): GapSeverity {
  if (classification !== "SUSPECTED_GAP") return "INFO";
  if (missingBars >= SEVERITY_THRESHOLDS.CRITICAL_MIN_MISSING) return "CRITICAL";
  if (missingBars >= SEVERITY_THRESHOLDS.WARNING_MIN_MISSING)  return "WARNING";
  return "INFO";
}

// ------------------------------------------------------------------
// Integrity status
// ------------------------------------------------------------------

/**
 * Derives overall data integrity status from a set of gap candidates.
 *
 * - No gaps at all (empty array)                      → HEALTHY
 * - NORMAL/WEEKEND/HOLIDAY_CLOSED/MARKET_CLOSED only  → HEALTHY
 * - Any SUSPECTED_GAP + no CRITICAL                   → WARNING
 * - Any CRITICAL severity                             → CRITICAL
 */
export function getIntegrityStatus(gaps: GapCandidate[]): IntegrityStatus {
  if (gaps.length === 0) return "HEALTHY";

  const hasCritical  = gaps.some(g => g.severity === "CRITICAL");
  const hasSuspected = gaps.some(g => g.classification === "SUSPECTED_GAP");

  if (hasCritical)  return "CRITICAL";
  if (hasSuspected) return "WARNING";
  return "HEALTHY";
}

// ------------------------------------------------------------------
// Main detection function
// ------------------------------------------------------------------

/**
 * Detects gap candidates in a sorted (ASC) array of bar timestamps.
 *
 * Caller must ensure bars are sorted ascending by time_utc.
 * Duplicate timestamps are treated as 0-gap (NORMAL).
 *
 * @param symbol  Optional. Used for holiday calendar lookup.
 *                Defaults to "EURUSD" for backward compatibility.
 */
export function detectGapCandidates(
  bars: ReadonlyArray<{ time_utc: string }>,
  timeframe: string,
  symbol = "EURUSD",
): GapCandidate[] {
  const tfSec = getTimeframeSeconds(timeframe);
  if (tfSec === 0 || bars.length < 2) return [];

  const gaps: GapCandidate[] = [];

  for (let i = 0; i < bars.length - 1; i++) {
    const current = bars[i]!;
    const next    = bars[i + 1]!;

    const currentMs  = new Date(current.time_utc).getTime();
    const nextMs     = new Date(next.time_utc).getTime();
    const durationS  = (nextMs - currentMs) / 1000;

    // Skip out-of-order or duplicate timestamps
    if (durationS <= 0) continue;

    const rawMissingBars = calculateMissingBars(current.time_utc, next.time_utc, tfSec);
    const classification = classifyGap(current.time_utc, next.time_utc, durationS, rawMissingBars, symbol);
    const severity       = getGapSeverity(classification, rawMissingBars);

    // Holiday name is only available from getHolidayContext; re-call it when needed.
    let holidayName: string | null | undefined;
    if (classification === "HOLIDAY_CLOSED") {
      const ctx = getHolidayContext(current.time_utc, next.time_utc, durationS, symbol);
      holidayName = ctx.holidayName;
    }

    // unexpectedMissingBars: only count bars missing in SUSPECTED_GAP
    const unexpectedMissingBars =
      classification === "SUSPECTED_GAP" ? rawMissingBars : 0;

    gaps.push({
      from:                 current.time_utc,
      to:                   next.time_utc,
      durationSeconds:      durationS,
      rawMissingBars,
      missingBars:          rawMissingBars, // backward-compat alias
      unexpectedMissingBars,
      classification,
      severity,
      ...(classification === "HOLIDAY_CLOSED" ? { holidayName } : {}),
    });
  }

  // Only return entries where there is actually a gap
  return gaps.filter(g => (g.rawMissingBars ?? g.missingBars) > 0);
}

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------

/**
 * Produces a summary object from a list of detected gap candidates.
 *
 * normalClosures = weekendClosures + holidayClosures + marketClosures (backward compat).
 * missingBars    = unexpectedMissingBars (backward compat: SUSPECTED_GAP only).
 */
export function summarizeGaps(gaps: GapCandidate[]): GapSummary {
  let weekendClosures = 0;
  let holidayClosures = 0;
  let marketClosures  = 0;
  let suspectedGaps   = 0;
  let rawMissingBars  = 0;
  let unexpectedMissingBars = 0;
  let warningCount    = 0;
  let criticalCount   = 0;

  for (const g of gaps) {
    // rawMissingBars may be undefined in legacy GapCandidate objects
    // constructed before Phase E — fall back to missingBars for compat.
    const bars = g.rawMissingBars ?? g.missingBars;
    rawMissingBars += bars;

    if (g.classification === "WEEKEND") {
      weekendClosures++;
    } else if (g.classification === "HOLIDAY_CLOSED") {
      holidayClosures++;
    } else if (g.classification === "MARKET_CLOSED") {
      marketClosures++;
    } else if (g.classification === "SUSPECTED_GAP") {
      suspectedGaps++;
      unexpectedMissingBars += bars;
      if (g.severity === "WARNING")  warningCount++;
      if (g.severity === "CRITICAL") criticalCount++;
    }
    // NORMAL gaps are filtered before this point (detectGapCandidates only returns rawMissingBars > 0)
  }

  const integrityStatus = getIntegrityStatus(gaps);
  const normalClosures  = weekendClosures + holidayClosures + marketClosures;

  return {
    candidateGaps: gaps.length,
    normalClosures,
    weekendClosures,
    holidayClosures,
    marketClosures,
    suspectedGaps,
    rawMissingBars,
    missingBars: unexpectedMissingBars,  // backward-compat alias
    unexpectedMissingBars,
    warningCount,
    criticalCount,
    integrityStatus,
  };
}

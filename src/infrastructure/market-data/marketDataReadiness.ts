// =================================================================
// Market Data Readiness — Pure Functions
//
// Coverage-based readiness assessment for Phase 4 data requirements.
// All functions are pure: no I/O, no side effects, deterministic.
// =================================================================

export type MarketDataReadiness =
  | "NOT_READY"
  | "MONTE_CARLO_READY"
  | "OPTIMIZATION_READY"
  | "WALK_FORWARD_READY"
  | "FULL_READY";

// Day thresholds — align with Phase 4 engine minimum requirements
const THRESHOLD_MONTE_CARLO  = 60;
const THRESHOLD_OPTIMIZATION = 90;
const THRESHOLD_WALK_FORWARD = 180;
const THRESHOLD_FULL         = 365;

/**
 * Returns the readiness level for a given span of calendar days.
 * Negative or non-finite input maps to NOT_READY.
 */
export function getReadiness(spanDays: number): MarketDataReadiness {
  if (!Number.isFinite(spanDays) || spanDays < THRESHOLD_MONTE_CARLO) return "NOT_READY";
  if (spanDays < THRESHOLD_OPTIMIZATION) return "MONTE_CARLO_READY";
  if (spanDays < THRESHOLD_WALK_FORWARD) return "OPTIMIZATION_READY";
  if (spanDays < THRESHOLD_FULL)         return "WALK_FORWARD_READY";
  return "FULL_READY";
}

/**
 * Returns coverage as a percentage where 365 days = 100%.
 * Values beyond 365 days are clamped to 100.
 * Negative or non-finite input returns 0.
 */
export function getCoveragePercent(spanDays: number): number {
  if (!Number.isFinite(spanDays) || spanDays <= 0) return 0;
  return Math.min(100, Math.round((spanDays / THRESHOLD_FULL) * 1000) / 10);
}

/**
 * Returns a human-readable note describing current readiness status
 * and the number of days still needed to reach the next level.
 */
export function getReadinessNote(
  readiness: MarketDataReadiness,
  spanDays: number,
): string {
  switch (readiness) {
    case "NOT_READY": {
      const need = THRESHOLD_MONTE_CARLO - Math.max(0, spanDays);
      return `Need ${Math.ceil(need)} more days of data to run Monte Carlo simulation.`;
    }
    case "MONTE_CARLO_READY": {
      const need = THRESHOLD_OPTIMIZATION - spanDays;
      return `Monte Carlo ready. Need ${Math.ceil(need)} more days for Optimization.`;
    }
    case "OPTIMIZATION_READY": {
      const need = THRESHOLD_WALK_FORWARD - spanDays;
      return `Optimization ready. Need ${Math.ceil(need)} more days for Walk-Forward validation.`;
    }
    case "WALK_FORWARD_READY": {
      const need = THRESHOLD_FULL - spanDays;
      return `Walk-Forward ready. Need ${Math.ceil(need)} more days for Full readiness (all phases).`;
    }
    case "FULL_READY":
      return `Full data coverage. All Phase 4 analysis modes available.`;
  }
}

/**
 * Validates that oldest < newest, returning false for invalid ranges
 * (null/undefined values or inverted timestamps).
 */
export function isValidRange(oldest: string | null | undefined, newest: string | null | undefined): boolean {
  if (!oldest || !newest) return false;
  const o = new Date(oldest).getTime();
  const n = new Date(newest).getTime();
  return Number.isFinite(o) && Number.isFinite(n) && o < n;
}

/**
 * Counts the number of symbol/TF entries that have reached FULL_READY.
 */
export function countFullReady(
  entries: ReadonlyArray<{ spanDays: number }>,
): number {
  return entries.filter(e => getReadiness(e.spanDays) === "FULL_READY").length;
}

/**
 * Counts the number of sync jobs with PENDING or RUNNING status.
 */
export function countActiveJobs(
  jobs: ReadonlyArray<{ status: string }>,
): number {
  return jobs.filter(j => j.status === "PENDING" || j.status === "RUNNING").length;
}

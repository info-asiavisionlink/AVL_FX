/**
 * Small, server-side primitives shared by the Stage 4 runtime routes.
 * These functions deliberately contain no Next.js, browser, or Supabase code
 * so retries can be tested without an external runtime.
 */

export type RuntimeState =
  | "FLAT" | "ANALYZING" | "HOURLY_ANALYSIS" | "TRIGGERED" | "WATCHING_ENTRY" | "ENTRY_RECHECK"
  | "ENTERING" | "POSITION" | "WATCHING_POSITION" | "POSITION_REVIEW"
  | "CLOSING" | "CLOSED";

export type PositionDecision = "HOLD" | "CLOSE" | "EXTEND_TP" | "MODIFY_SL";

const FRAME_MS: Record<string, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
};

/** A bar is usable only after its broker interval has closed. */
export function isClosedBar(timestampMs: number, timeframe: string, nowMs = Date.now()): boolean {
  const interval = FRAME_MS[timeframe.toUpperCase()];
  return Number.isFinite(timestampMs) && timestampMs > 0 && !!interval && timestampMs + interval <= nowMs;
}

export function runtimeStateForPosition(hasOpenPosition: boolean, review = false): RuntimeState {
  if (hasOpenPosition) return review ? "POSITION_REVIEW" : "WATCHING_POSITION";
  return "WATCHING_ENTRY";
}

export function entryIdempotencyKey(
  traderId: string,
  scenarioId: string,
  trigger: string,
  m5BarTime: number,
): string {
  return `ENTRY:${traderId}:${scenarioId}:${trigger}:${m5BarTime}`;
}

export function positionReviewIdempotencyKey(
  positionId: string,
  trigger: string,
  barTime: number,
): string {
  return `POSITION_REVIEW:${positionId}:${trigger}:${barTime}`;
}

export function validatePositionDecision(value: unknown): PositionDecision | null {
  return value === "HOLD" || value === "CLOSE" || value === "EXTEND_TP" || value === "MODIFY_SL"
    ? value
    : null;
}

export function normalizeScenarioState(value: unknown): "WATCHING" | "TRIGGERED" | "INVALIDATED" | "SUPERSEDED" | "COMPLETED" {
  if (value === "INVALID" || value === "INVALIDATED") return "INVALIDATED";
  if (value === "CONSIDERING" || value === "DECIDED" || value === "TRIGGERED") return "TRIGGERED";
  if (value === "SUPERSEDED" || value === "COMPLETED") return value;
  return "WATCHING";
}

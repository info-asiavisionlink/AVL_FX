/**
 * Deterministic pre-protection management candidate detection.
 *
 * This module is deliberately side-effect free: it does not call AI, a
 * database, Gateway, or MT5. Broker-side SL remains the independent hard
 * protection layer; these candidates only decide when an optional AI review
 * may be requested.
 */

export const POSITION_CANDIDATE_PROGRESS = 0.8;

export type CandidateTrigger = "TP_RECHECK" | "SL_RECHECK";
export type CandidateSide = "BUY" | "SELL";

export interface PositionCandidateInput {
  side: CandidateSide;
  currentPrice: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  progressThreshold?: number;
}

export interface PositionCandidateResult {
  trigger: CandidateTrigger | null;
  progress: number | null;
  reason?: string;
}

const NONE = (reason: string): PositionCandidateResult => ({ trigger: null, progress: null, reason });

/**
 * Returns at most one candidate. Invalid geometry is rejected rather than
 * allowing an ambiguous TP/SL wake-up. The threshold is the fraction of the
 * entry-to-target path already travelled: 0.8 means the final 20% zone.
 */
export function detectPositionCandidate(input: PositionCandidateInput): PositionCandidateResult {
  const values = [input.currentPrice, input.entryPrice, input.stopLoss, input.takeProfit];
  if (!values.every(Number.isFinite)) return NONE("NON_FINITE_POSITION_DATA");
  if (![input.currentPrice, input.entryPrice, input.stopLoss, input.takeProfit].every(v => v > 0)) return NONE("INVALID_POSITION_DATA");
  const threshold = input.progressThreshold ?? POSITION_CANDIDATE_PROGRESS;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return NONE("INVALID_THRESHOLD");

  const favorableDistance = input.side === "BUY"
    ? input.takeProfit - input.entryPrice
    : input.entryPrice - input.takeProfit;
  const adverseDistance = input.side === "BUY"
    ? input.entryPrice - input.stopLoss
    : input.stopLoss - input.entryPrice;
  if (!(favorableDistance > 0) || !(adverseDistance > 0)) return NONE("INVALID_POSITION_GEOMETRY");

  const favorableProgress = input.side === "BUY"
    ? (input.currentPrice - input.entryPrice) / favorableDistance
    : (input.entryPrice - input.currentPrice) / favorableDistance;
  const adverseProgress = input.side === "BUY"
    ? (input.entryPrice - input.currentPrice) / adverseDistance
    : (input.currentPrice - input.entryPrice) / adverseDistance;

  if (!Number.isFinite(favorableProgress) || !Number.isFinite(adverseProgress)) return NONE("NON_FINITE_PROGRESS");
  // Valid geometry should make these mutually exclusive. Reject an unusual
  // overlap instead of waking AI twice or choosing an arbitrary action.
  if (favorableProgress >= threshold && adverseProgress >= threshold) return NONE("AMBIGUOUS_CANDIDATE");
  if (favorableProgress >= threshold && favorableProgress < 1) {
    return { trigger: "TP_RECHECK", progress: favorableProgress };
  }
  if (adverseProgress >= threshold && adverseProgress < 1) {
    return { trigger: "SL_RECHECK", progress: adverseProgress };
  }
  return { trigger: null, progress: Math.max(favorableProgress, adverseProgress, 0) };
}

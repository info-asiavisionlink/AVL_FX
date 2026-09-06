// =================================================================
// Phase 6-B: Raw Signal Analysis (Pure Functions)
//
// Separates Signal Edge from Execution / Exit effects.
// All functions work on raw bar data with no SL/TP constraints
// and zero cost, to isolate the pure directional signal edge.
//
// Design: Pure Functions only — no Supabase / engine side effects.
// =================================================================

import type { Bar }                   from "@/infrastructure/analysis/types";
import type { PrecomputedIndicators } from "../indicators";
import type { EvaluationContext, SignalResult } from "../evaluator";
import type { StrategySpec }          from "@/lib/strategySchema";

const PIP = 0.0001;
const M5_MS = 300_000;

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface SignalOccurrence {
  signalBarIdx: number;
  entryBarIdx:  number;   // signalBarIdx + 1
  direction:    "BUY" | "SELL";
  entryOpen:    number;   // bars[entryBarIdx].open (zero cost)
  atrAtSignal:  number | undefined; // inds.atr[signalBarIdx]
}

export interface RawHorizonResult {
  horizon:      number;
  n:            number;
  mean:         number;
  median:       number;
  positiveRate: number;  // fraction (0–1), NOT percent
  p25:          number;
  p75:          number;
}

export interface RawMfeMaeResult {
  horizon:    number;
  mfeMedian:  number;
  maeMedian:  number;
  mfeP25:     number;
  mfeP75:     number;
  maeP25:     number;
  maeP75:     number;
  mfeGte2Pct: number;  // fraction
  mfeGte5Pct: number;
  mfeGte10Pct:number;
  maeGte2Pct: number;  // fraction where |MAE| >= 2 pips
  maeGte5Pct: number;
  maeGte10Pct:number;
}

// ------------------------------------------------------------------
// Math helpers
// ------------------------------------------------------------------

export function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor((p / 100) * s.length), s.length - 1);
  return s[idx];
}

// ------------------------------------------------------------------
// Seeded random number generator (LCG — Numerical Recipes)
//
// Deterministic, seed-reproducible. Used for random control group.
// ------------------------------------------------------------------

export function seededRNG(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ------------------------------------------------------------------
// Raw directional return at fixed horizon (zero cost)
//
// Measures the market return N bars after entry open, without
// any SL/TP constraints or spread/slippage costs.
//
// LONG:  (close[entryBarIdx + horizon] - open[entryBarIdx]) / PIP
// SHORT: (open[entryBarIdx] - close[entryBarIdx + horizon]) / PIP
//
// Returns null if insufficient future bars.
// ------------------------------------------------------------------

export function computeRawReturn(
  direction:   "BUY" | "SELL",
  entryOpen:   number,
  bars:        Bar[],
  entryBarIdx: number,
  horizon:     number,
  pipSize:     number = PIP,
): number | null {
  const exitIdx = entryBarIdx + horizon;
  if (exitIdx >= bars.length) return null;
  const exitClose = bars[exitIdx].close;
  return direction === "BUY"
    ? (exitClose - entryOpen) / pipSize
    : (entryOpen  - exitClose) / pipSize;
}

// ------------------------------------------------------------------
// Raw MFE/MAE over fixed horizon (zero cost, no cap)
//
// Unlike the trading MFE/MAE, this uses raw open as entry price
// and measures over exactly `horizon` bars regardless of SL/TP.
// ------------------------------------------------------------------

export function computeRawMfeMae(
  direction:   "BUY" | "SELL",
  entryOpen:   number,
  bars:        Bar[],
  entryBarIdx: number,
  horizon:     number,
  pipSize:     number = PIP,
): { mfe: number; mae: number } {
  let mfe = 0;
  let mae = 0;
  const endIdx = Math.min(entryBarIdx + horizon - 1, bars.length - 1);

  for (let i = entryBarIdx; i <= endIdx; i++) {
    const bar = bars[i];
    if (direction === "BUY") {
      const fav = (bar.high - entryOpen) / pipSize;
      const unf = (bar.low  - entryOpen) / pipSize;
      if (fav > mfe) mfe = fav;
      if (unf < mae) mae = unf;
    } else {
      const fav = (entryOpen - bar.low)  / pipSize;
      const unf = (entryOpen - bar.high) / pipSize;
      if (fav > mfe) mfe = fav;
      if (unf < mae) mae = unf;
    }
  }

  return { mfe, mae };
}

// ------------------------------------------------------------------
// Collect ALL signal occurrences (independent of position state)
//
// Iterates every eligible bar and records when the evaluator fires,
// regardless of whether a position is already open in the backtest.
// This gives the "true" signal firing rate for edge estimation.
//
// maxHorizon: reserve this many bars at the end for forward analysis.
// ------------------------------------------------------------------

export function collectAllSignals(
  bars:      Bar[],
  inds:      PrecomputedIndicators,
  evaluator: (ctx: EvaluationContext) => SignalResult,
  spec:      StrategySpec,
  warmup:    number,
  maxHorizon: number = 50,
): SignalOccurrence[] {
  const signals: SignalOccurrence[] = [];
  const limit = bars.length - maxHorizon - 1;

  for (let i = warmup; i < limit; i++) {
    const evalTime = bars[i].time + M5_MS;
    const ctx: EvaluationContext = {
      spec,
      evaluationTime:        evalTime,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    };
    const signal = evaluator(ctx);
    if (signal !== "SKIP") {
      signals.push({
        signalBarIdx: i,
        entryBarIdx:  i + 1,
        direction:    signal,
        entryOpen:    bars[i + 1].open,
        atrAtSignal:  inds.atr[i],
      });
    }
  }

  return signals;
}

// ------------------------------------------------------------------
// Generate random control signals
//
// Matches the given signal list in:
//   - Total count
//   - LONG / SHORT ratio
//
// Seed = 42 for reproducibility.
// Samples bar indices from [warmup .. bars.length - maxHorizon - 2].
// ------------------------------------------------------------------

export function generateRandomSignals(
  signals:    SignalOccurrence[],
  bars:       Bar[],
  warmup:     number,
  maxHorizon: number = 50,
  seed:       number = 42,
): SignalOccurrence[] {
  const rng          = seededRNG(seed);
  const eligibleStart = warmup;
  const eligibleEnd   = bars.length - maxHorizon - 2;
  const range         = eligibleEnd - eligibleStart;

  if (range <= 0) return [];

  const longCount  = signals.filter(s => s.direction === "BUY").length;
  const shortCount = signals.filter(s => s.direction === "SELL").length;

  const result: SignalOccurrence[] = [];

  for (let i = 0; i < longCount; i++) {
    const idx = eligibleStart + Math.floor(rng() * range);
    result.push({
      signalBarIdx: idx,
      entryBarIdx:  idx + 1,
      direction:    "BUY",
      entryOpen:    bars[idx + 1]?.open ?? bars[idx].open,
      atrAtSignal:  undefined,
    });
  }

  for (let i = 0; i < shortCount; i++) {
    const idx = eligibleStart + Math.floor(rng() * range);
    result.push({
      signalBarIdx: idx,
      entryBarIdx:  idx + 1,
      direction:    "SELL",
      entryOpen:    bars[idx + 1]?.open ?? bars[idx].open,
      atrAtSignal:  undefined,
    });
  }

  return result;
}

// ------------------------------------------------------------------
// Compute raw horizon stats for a set of signals
// ------------------------------------------------------------------

export function computeHorizonStats(
  signals:  SignalOccurrence[],
  bars:     Bar[],
  horizons: number[],
  pipSize:  number = PIP,
): RawHorizonResult[] {
  return horizons.map(h => {
    const returns: number[] = [];

    for (const sig of signals) {
      const ret = computeRawReturn(sig.direction, sig.entryOpen, bars, sig.entryBarIdx, h, pipSize);
      if (ret !== null) returns.push(ret);
    }

    if (returns.length === 0) {
      return { horizon: h, n: 0, mean: 0, median: 0, positiveRate: 0, p25: 0, p75: 0 };
    }

    const posCount = returns.filter(r => r > 0).length;

    return {
      horizon:      h,
      n:            returns.length,
      mean:         mean(returns),
      median:       median(returns),
      positiveRate: posCount / returns.length,
      p25:          percentile(returns, 25),
      p75:          percentile(returns, 75),
    };
  });
}

// ------------------------------------------------------------------
// Compute raw MFE/MAE stats for a set of signals over fixed horizons
// ------------------------------------------------------------------

export function computeRawMfeMaeStats(
  signals:  SignalOccurrence[],
  bars:     Bar[],
  horizons: number[],
  pipSize:  number = PIP,
): RawMfeMaeResult[] {
  return horizons.map(h => {
    const mfes: number[] = [];
    const maes: number[] = [];

    for (const sig of signals) {
      if (sig.entryBarIdx + h - 1 >= bars.length) continue;
      const { mfe, mae } = computeRawMfeMae(sig.direction, sig.entryOpen, bars, sig.entryBarIdx, h, pipSize);
      mfes.push(mfe);
      maes.push(mae);
    }

    if (mfes.length === 0) {
      return {
        horizon: h, mfeMedian: 0, maeMedian: 0,
        mfeP25: 0, mfeP75: 0, maeP25: 0, maeP75: 0,
        mfeGte2Pct: 0, mfeGte5Pct: 0, mfeGte10Pct: 0,
        maeGte2Pct: 0, maeGte5Pct: 0, maeGte10Pct: 0,
      };
    }

    const n = mfes.length;
    return {
      horizon:     h,
      mfeMedian:   median(mfes),
      maeMedian:   median(maes),
      mfeP25:      percentile(mfes, 25),
      mfeP75:      percentile(mfes, 75),
      maeP25:      percentile(maes, 25),
      maeP75:      percentile(maes, 75),
      mfeGte2Pct:  mfes.filter(v => v >= 2).length  / n,
      mfeGte5Pct:  mfes.filter(v => v >= 5).length  / n,
      mfeGte10Pct: mfes.filter(v => v >= 10).length / n,
      maeGte2Pct:  maes.filter(v => v <= -2).length  / n,
      maeGte5Pct:  maes.filter(v => v <= -5).length  / n,
      maeGte10Pct: maes.filter(v => v <= -10).length / n,
    };
  });
}

// ------------------------------------------------------------------
// Edge delta
//
// Positive → strategy has directional advantage over random.
// Negative → strategy is WORSE than random (contrarian).
// ------------------------------------------------------------------

export function computeEdgeDelta(
  stratPositiveRate: number,
  randomPositiveRate: number,
): number {
  return stratPositiveRate - randomPositiveRate;
}

// ------------------------------------------------------------------
// Entry price verification helpers
// ------------------------------------------------------------------

export interface EntryAudit {
  direction:        "BUY" | "SELL";
  entryBarOpen:     number;
  spreadPips:       number;
  slippagePips:     number;
  expectedEntry:    number;   // what entry should be
  actualEntry:      number;   // what engine recorded
  diffPips:         number;   // (actualEntry - expectedEntry) / pip
  pass:             boolean;
}

export function auditEntryPrice(
  direction:    "BUY" | "SELL",
  barOpen:      number,
  actualEntry:  number,
  spreadPips:   number,
  slippagePips: number,
  pipSize:      number = PIP,
): EntryAudit {
  const costPrice    = (spreadPips + slippagePips) * pipSize;
  const expectedEntry = direction === "BUY"
    ? barOpen + costPrice
    : barOpen - costPrice;
  const diffPips = (actualEntry - expectedEntry) / pipSize;

  return {
    direction,
    entryBarOpen: barOpen,
    spreadPips,
    slippagePips,
    expectedEntry,
    actualEntry,
    diffPips,
    pass: Math.abs(diffPips) < 0.01, // tolerance: 0.01 pips
  };
}

// ------------------------------------------------------------------
// SL/TP geometry helpers
// ------------------------------------------------------------------

export interface SLTPAudit {
  direction:      "BUY" | "SELL";
  entryPrice:     number;
  sl:             number;
  tp:             number;
  slDistPips:     number;   // |entry - sl| / pip  (positive)
  tpDistPips:     number;   // |tp - entry| / pip  (positive)
  rrRatio:        number;   // tpDist / slDist
  effectiveSLFromOpen: number; // SL dist measured from bar.open (without cost)
  pass:           boolean;    // SL below entry (BUY) and TP above (BUY)
}

export function auditSLTP(
  direction:   "BUY" | "SELL",
  entryPrice:  number,
  barOpen:     number,
  sl:          number,
  tp:          number,
  pipSize:     number = PIP,
): SLTPAudit {
  const slDistPips = Math.abs(entryPrice - sl) / pipSize;
  const tpDistPips = Math.abs(tp - entryPrice) / pipSize;

  // effectiveSL = SL distance measured from open (what the market needs to move)
  const effectiveSLFromOpen = direction === "BUY"
    ? (entryPrice - sl - (entryPrice - barOpen)) / pipSize  // = ATR/pip (for BUY)
    : (sl - entryPrice + (barOpen - entryPrice)) / pipSize;
  // Simpler: for BUY: sl_from_open = (barOpen - sl) / pip
  const simpleSLFromOpen = direction === "BUY"
    ? (barOpen - sl) / pipSize
    : (sl - barOpen) / pipSize;

  const buyPass  = direction === "BUY"  && sl < entryPrice && tp > entryPrice;
  const sellPass = direction === "SELL" && sl > entryPrice && tp < entryPrice;

  return {
    direction,
    entryPrice,
    sl,
    tp,
    slDistPips,
    tpDistPips,
    rrRatio:             tpDistPips / slDistPips,
    effectiveSLFromOpen: simpleSLFromOpen,
    pass:                buyPass || sellPass,
  };
}

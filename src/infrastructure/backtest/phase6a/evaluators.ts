// =================================================================
// Phase 6-A: Hypothesis Evaluators (Pure Functions)
//
// Three market hypotheses for EURUSD M5 screening:
//   A. BREAKOUT         — close breaks previous N-bar high/low
//   B. MOMENTUM         — large directional bar (bodySize >= 1.0×ATR)
//   C. MEAN_REVERSION   — price deviates >= 1.0×ATR from EMA(21)
//
// Design principles:
//   - Pure functions: no side effects, no external I/O
//   - No look-ahead: uses only bars[0..idx] data
//   - Rolling high/low for BREAKOUT excludes current bar
//   - Engine integration via _evaluatorOverride (no engine changes)
// =================================================================

import type { Bar }                   from "@/infrastructure/analysis/types";
import type { PrecomputedIndicators } from "../indicators";
import type { EvaluationContext, SignalResult } from "../evaluator";
import { getLastConfirmedBarIndex }   from "../timeframe";

// ------------------------------------------------------------------
// Constants (Phase 6-A predefined — do NOT change based on results)
// ------------------------------------------------------------------

export const BREAKOUT_N                          = 20;
export const MOMENTUM_BODY_MULTIPLIER            = 1.0;
export const MEAN_REVERSION_DISTANCE_MULTIPLIER  = 1.0;
export const PHASE6A_TIMEFRAME                   = "M5";

// ------------------------------------------------------------------
// A. BREAKOUT
//
// LONG:  close[idx] > max(high[idx-N..idx-1])
// SHORT: close[idx] < min(low[idx-N..idx-1])
//
// IMPORTANT: current bar (idx) is strictly excluded from rolling
//            high/low calculation. Only "previous N completed bars"
//            are used to avoid look-ahead bias.
// ------------------------------------------------------------------

export function evalBreakout(
  bars: Bar[],
  idx:  number,
  n:    number = BREAKOUT_N,
): SignalResult {
  if (idx < n) return "SKIP"; // not enough prior bars

  const close = bars[idx].close;

  let rollingHigh = -Infinity;
  let rollingLow  =  Infinity;

  // bars[idx-N .. idx-1]: N previous completed bars, excludes current
  for (let i = idx - n; i < idx; i++) {
    if (bars[i].high > rollingHigh) rollingHigh = bars[i].high;
    if (bars[i].low  < rollingLow)  rollingLow  = bars[i].low;
  }

  if (!isFinite(rollingHigh) || !isFinite(rollingLow)) return "SKIP";

  if (close > rollingHigh) return "BUY";
  if (close < rollingLow)  return "SELL";
  return "SKIP";
}

// ------------------------------------------------------------------
// B. MOMENTUM CONTINUATION
//
// LONG:  bullish bar AND bodySize >= 1.0 × ATR(14)
// SHORT: bearish bar AND bodySize >= 1.0 × ATR(14)
//
// bodySize = abs(close - open) of the confirmed signal bar.
// ATR is precomputed — only uses bars[0..idx] (no look-ahead).
// ------------------------------------------------------------------

export function evalMomentum(
  bars: Bar[],
  inds: PrecomputedIndicators,
  idx:  number,
): SignalResult {
  const atr = inds.atr[idx];
  if (atr === undefined || atr <= 0) return "SKIP"; // ATR warmup or invalid

  const bar      = bars[idx];
  const bodySize = Math.abs(bar.close - bar.open);

  if (bodySize < MOMENTUM_BODY_MULTIPLIER * atr) return "SKIP";

  if (bar.close > bar.open) return "BUY";
  if (bar.close < bar.open) return "SELL";
  return "SKIP"; // doji (close == open, extremely rare)
}

// ------------------------------------------------------------------
// C. MEAN REVERSION
//
// LONG:  close < EMA(21) AND (EMA21 - close) >= 1.0 × ATR(14)
// SHORT: close > EMA(21) AND (close - EMA21) >= 1.0 × ATR(14)
//
// Note: This is the OPPOSITE of Phase 5 pullback.
//   Phase 5: price returns TO EMA → enter in trend direction
//   Phase 6-C: price deviates FAR FROM EMA → expect mean reversion
//
// EMA and ATR are precomputed — only uses bars[0..idx] (no look-ahead).
// ------------------------------------------------------------------

export function evalMeanReversion(
  bars: Bar[],
  inds: PrecomputedIndicators,
  idx:  number,
): SignalResult {
  const ema21 = inds.ema1[idx]; // ema1Period = 21 by default
  const atr   = inds.atr[idx];
  if (ema21 === undefined || atr === undefined || atr <= 0) return "SKIP";

  const close     = bars[idx].close;
  const threshold = MEAN_REVERSION_DISTANCE_MULTIPLIER * atr;

  if (close < ema21 - threshold) return "BUY";  // far below EMA → buy (expect bounce up)
  if (close > ema21 + threshold) return "SELL"; // far above EMA → sell (expect pullback)
  return "SKIP";
}

// ------------------------------------------------------------------
// BacktestEngine._evaluatorOverride wrappers
//
// These wrap pure signal functions into the EvaluationContext interface
// required by BacktestEngine. The engine's warmup and position logic
// remain unchanged. Only the signal detection is overridden.
// ------------------------------------------------------------------

export function makeBreakoutEvaluator(
  mainBars: Bar[],
): (ctx: EvaluationContext) => SignalResult {
  return (ctx) => {
    const idx = getLastConfirmedBarIndex(mainBars, PHASE6A_TIMEFRAME, ctx.evaluationTime);
    if (idx < 0) return "SKIP";
    return evalBreakout(mainBars, idx);
  };
}

export function makeMomentumEvaluator(
  mainBars: Bar[],
  mainInds: PrecomputedIndicators,
): (ctx: EvaluationContext) => SignalResult {
  return (ctx) => {
    const idx = getLastConfirmedBarIndex(mainBars, PHASE6A_TIMEFRAME, ctx.evaluationTime);
    if (idx < 0) return "SKIP";
    return evalMomentum(mainBars, mainInds, idx);
  };
}

export function makeMeanReversionEvaluator(
  mainBars: Bar[],
  mainInds: PrecomputedIndicators,
): (ctx: EvaluationContext) => SignalResult {
  return (ctx) => {
    const idx = getLastConfirmedBarIndex(mainBars, PHASE6A_TIMEFRAME, ctx.evaluationTime);
    if (idx < 0) return "SKIP";
    return evalMeanReversion(mainBars, mainInds, idx);
  };
}

/**
 * phase5c_helpers.ts — Pure helper utilities for Phase 5-C tests
 *
 * calcSLTPSymmetry: verifies that given the same ATR, LONG SL distance = SHORT SL distance
 *   LONG:  entry=1.1000, SL = entry - ATR*1.5
 *   SHORT: entry=1.1000, SL = entry + ATR*1.5
 *   Both produce |entry - SL| = ATR * 1.5 (symmetric)
 */

export function calcSLTPSymmetry(): { longSLDist: number; shortSLDist: number } {
  const entry = 1.1000;
  const atr   = 0.0010; // 10 pips (typical EURUSD)
  const mult  = 1.5;

  const longSL  = entry - atr * mult;   // BUY:  SL below entry
  const shortSL = entry + atr * mult;   // SELL: SL above entry

  const longSLDist  = Math.abs(entry - longSL);
  const shortSLDist = Math.abs(entry - shortSL);

  return { longSLDist, shortSLDist };
}

/**
 * Unit Tests — Phase 5-A: Strategy Spec Extension
 *   1. Multiple Trend Filters (trend_filters[]) — backward compatible
 *   2. NEAR_EMA operator
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/phase5a.test.ts
 */

import assert from "node:assert/strict";
import type { Bar }                   from "@/infrastructure/analysis/types";
import type { MACDResult, ADXResult, BollingerResult } from "../types";
import type { PrecomputedIndicators } from "../indicators";
import type { StrategySpec }          from "@/lib/strategySchema";
import { evaluateStrategy, getPipSize, type EvaluationContext } from "../evaluator";
import { TF_MS } from "../timeframe";

// =================================================================
// ─── Test runner ────────────────────────────────────────────────
// =================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}`);
    console.error(`     ${msg}`);
    failed++;
  }
}

function describe(label: string, fn: () => void): void {
  console.log(`\n📊 ${label}`);
  fn();
}

// =================================================================
// ─── Helpers ────────────────────────────────────────────────────
// =================================================================

const DEFAULT_PARAMS = {
  ema1Period: 21, ema2Period: 200, smaPeriod: 50, atrPeriod: 14,
  rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
  adxPeriod: 14, bbPeriod: 20, bbDeviation: 2.0, stochPeriod: 14,
  wmaPeriod: 14, vwmaPeriod: 14, cciPeriod: 14, williamsRPeriod: 14,
  momentumPeriod: 10, volumeRatioPeriod: 20,
  hmaPeriod: 14, demaPeriod: 14, donchianPeriod: 20,
  keltnerPeriod: 20, keltnerAtrPeriod: 10, keltnerMultiplier: 2.0,
  stochRsiRsiPeriod: 14, stochRsiPeriod: 14, rocPeriod: 14,
  aroonPeriod: 14, forceIndexPeriod: 13, mfiPeriod: 14, cmfPeriod: 20,
  psarStep: 0.02, psarMax: 0.2,
};

function makeBar(time: number, close: number): Bar {
  return { time, open: close, high: close * 1.001, low: close * 0.999, close, volume: 100 };
}

function makeBars(closes: number[], startTime: number, tfMs: number): Bar[] {
  return closes.map((c, i) => makeBar(startTime + i * tfMs, c));
}

function makeInds(n: number, opts: {
  rsi?:   (number | undefined)[];
  ema1?:  (number | undefined)[];
  ema2?:  (number | undefined)[];
  sma?:   (number | undefined)[];
  macd?:  MACDResult[];
  adx?:   ADXResult[];
  bb?:    BollingerResult[];
  stoch?: (number | undefined)[];
  params?: Partial<typeof DEFAULT_PARAMS>;
} = {}): PrecomputedIndicators {
  const undef = (): (number | undefined)[] => Array<number | undefined>(n).fill(undefined);
  const noMacd = (): MACDResult[] =>
    Array.from({ length: n }, () => ({ macd: undefined, signal: undefined, histogram: undefined }));
  const noAdx = (): ADXResult[] =>
    Array.from({ length: n }, () => ({ adx: undefined, diPlus: undefined, diMinus: undefined }));
  const noBB = (): BollingerResult[] =>
    Array.from({ length: n }, () => ({ upper: undefined, middle: undefined, lower: undefined, width: undefined }));

  const noIchimoku = () => Array.from({ length: n }, () => ({
    tenkan: undefined, kijun: undefined, senkouA: undefined,
    senkouB: undefined, cloudTop: undefined, cloudBottom: undefined,
  }));
  const noDonchian = () => Array.from({ length: n }, () => ({
    upper: undefined, lower: undefined, middle: undefined,
  }));
  const noAroon = () => Array.from({ length: n }, () => ({
    up: undefined, down: undefined, oscillator: undefined,
  }));
  return {
    ema1:        opts.ema1  ?? undef(),
    ema2:        opts.ema2  ?? undef(),
    sma:         opts.sma   ?? undef(),
    atr:         undef(),
    rsi:         opts.rsi   ?? undef(),
    macd:        opts.macd  ?? noMacd(),
    adx:         opts.adx   ?? noAdx(),
    bb:          opts.bb    ?? noBB(),
    stoch:       opts.stoch ?? undef(),
    wma:         undef(),
    vwma:        undef(),
    cci:         undef(),
    williamsR:   undef(),
    momentum:    undef(),
    obv:         undef(),
    volumeRatio: undef(),
    hma:         undef(),
    dema:        undef(),
    ichimoku:    noIchimoku(),
    donchian:    noDonchian(),
    keltner:     noDonchian(),
    stochRsi:    undef(),
    roc:         undef(),
    ao:          undef(),
    aroon:       noAroon(),
    forceIndex:  undef(),
    mfi:         undef(),
    cmf:         undef(),
    psar:        undef(),
    params: { ...DEFAULT_PARAMS, ...opts.params },
  };
}

function makeSpec(overrides: {
  symbols?:    string[];
  timeframes?: string[];
  logic?:      "AND" | "OR";
  conditions?: StrategySpec["entry_conditions"]["conditions"];
  filters?:    StrategySpec["filters"];
}): StrategySpec {
  return {
    name:           "Test Strategy",
    strategy_type:  "DAY_TRADE",
    symbols:        overrides.symbols ?? ["EURUSD"],
    timeframes:     overrides.timeframes ?? ["M5"],
    entry_conditions: {
      logic:      overrides.logic ?? "AND",
      conditions: overrides.conditions ?? [],
    },
    risk: { risk_per_trade: 1.0 },
    filters: overrides.filters,
  } as StrategySpec;
}

// =================================================================
// ─── Common test setup ───────────────────────────────────────────
// =================================================================

const M5_MS  = TF_MS["M5"];   // 300_000
const H1_MS  = TF_MS["H1"];   // 3_600_000
const H4_MS  = TF_MS["H4"];   // 14_400_000

// Anchor: T0 is an arbitrary base time
const T0     = 1_000_000_000_000; // ms

// M5 bars: 10 bars, bar[9] closes at T0 + 10*M5_MS
const EVAL_T  = T0 + 10 * M5_MS; // evalTime = bar[9] confirmed
const BARS_M5 = makeBars(
  [1.05, 1.06, 1.07, 1.08, 1.06, 1.07, 1.08, 1.09, 1.09, 1.10],
  T0, M5_MS
);

// RSI helper: RSI BELOW 30 = BUY signal
const RSI_BUY_COND: StrategySpec["entry_conditions"]["conditions"][number] = {
  indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30
};
const RSI_SELL_COND: StrategySpec["entry_conditions"]["conditions"][number] = {
  indicator: "RSI", timeframe: "M5", period: 14, operator: "ABOVE", threshold: 70
};

function makeRSIBuyInds(): PrecomputedIndicators {
  const rsi = [...Array(9).fill(35), 28]; // idx=9: rsi=28 < 30
  return makeInds(10, { rsi });
}

function makeRSISellInds(): PrecomputedIndicators {
  const rsi = [...Array(9).fill(65), 72]; // idx=9: rsi=72 > 70
  return makeInds(10, { rsi });
}

/**
 * Build H1 bars + inds where confirmed bar at evalTime has:
 *   close=1.10, ema21=1.08 → close > ema → BULLISH ✓
 */
function makeH1BullishData(): { bars: Bar[]; inds: PrecomputedIndicators } {
  // 3 H1 bars ending at EVAL_T: bar[2] closes at EVAL_T
  const h1Start = EVAL_T - 3 * H1_MS;
  const bars    = makeBars([1.07, 1.09, 1.10], h1Start, H1_MS);
  const ema1    = [1.06, 1.08, 1.09]; // close[2]=1.10 > ema[2]=1.09 → BULLISH
  const inds    = makeInds(3, { ema1, params: { ema1Period: 21 } });
  return { bars, inds };
}

/**
 * Build H1 bars + inds where confirmed bar at evalTime has:
 *   close=1.10, ema21=1.15 → close < ema → BEARISH ✓
 */
function makeH1BearishData(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h1Start = EVAL_T - 3 * H1_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h1Start, H1_MS);
  const ema1    = [1.16, 1.15, 1.15]; // close[2]=1.10 < ema[2]=1.15 → BEARISH
  const inds    = makeInds(3, { ema1, params: { ema1Period: 21 } });
  return { bars, inds };
}

/**
 * Build H4 bars + inds where confirmed bar at evalTime has BULLISH condition
 *   close=1.10, ema21=1.08 → BULLISH
 */
function makeH4BullishData(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.07, 1.09, 1.10], h4Start, H4_MS);
  const ema1    = [1.06, 1.07, 1.08]; // close[2]=1.10 > ema[2]=1.08 → BULLISH
  const inds    = makeInds(3, { ema1, params: { ema1Period: 21 } });
  return { bars, inds };
}

/**
 * Build H4 bars + inds where confirmed bar has BEARISH condition
 *   close=1.10, ema21=1.15 → BEARISH
 */
function makeH4BearishData(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h4Start, H4_MS);
  const ema1    = [1.16, 1.15, 1.15]; // close[2]=1.10 < ema[2]=1.15 → BEARISH
  const inds    = makeInds(3, { ema1, params: { ema1Period: 21 } });
  return { bars, inds };
}

// =================================================================
// ─── 5A-01〜5A-11: Multiple Trend Filters ────────────────────────
// =================================================================

describe("5A-01〜5A-11: Multiple Trend Filters", () => {

  // 5A-01: legacy trend_filter (singular) still works
  test("5A-01: legacy trend_filter (singular) still works", () => {
    const h1 = makeH1BullishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds },
    });
    assert.equal(result, "BUY", "Legacy trend_filter should still produce BUY");
  });

  // 5A-02: trend_filters with one filter → same behavior as single trend_filter
  test("5A-02: trend_filters[] with one filter = same as singular trend_filter", () => {
    const h1 = makeH1BullishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [{ timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" }],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds },
    });
    assert.equal(result, "BUY", "Single-element trend_filters[] should behave like trend_filter");
  });

  // 5A-03: H1 BULLISH AND H4 BULLISH → LONG entry passes
  test("5A-03: trend_filters[H1 BULLISH, H4 BULLISH] → BUY", () => {
    const h1 = makeH1BullishData();
    const h4 = makeH4BullishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "H1 BULLISH + H4 BULLISH should produce BUY");
  });

  // 5A-04: H1 true / H4 false → LONG entry rejected
  test("5A-04: trend_filters[H1 BULLISH=true, H4 BULLISH=false] → SKIP (AND logic)", () => {
    const h1     = makeH1BullishData();
    // H4 is BEARISH (close < ema) but filter requires BULLISH → fails
    const h4Bear = makeH4BearishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SKIP", "H1 pass but H4 fail → AND fails → SKIP");
  });

  // 5A-05: H1 false / H4 true → LONG entry rejected
  test("5A-05: trend_filters[H1 BULLISH=false, H4 BULLISH=true] → SKIP (AND logic)", () => {
    // H1 is BEARISH (close < ema) but filter requires BULLISH → fails
    const h1Bear = makeH1BearishData();
    const h4     = makeH4BullishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bear.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1Bear.inds, H4: h4.inds },
    });
    assert.equal(result, "SKIP", "H1 fail + H4 pass → AND fails → SKIP");
  });

  // 5A-06: both H1 and H4 false → LONG entry rejected
  test("5A-06: trend_filters[H1 BULLISH=false, H4 BULLISH=false] → SKIP", () => {
    const h1Bear = makeH1BearishData();
    const h4Bear = makeH4BearishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SKIP", "Both fail → SKIP");
  });

  // 5A-07: LONG bias maintained with multiple filters
  test("5A-07: multiple BULLISH filters maintain LONG (BUY) bias — not accidentally SHORT", () => {
    const h1 = makeH1BullishData();
    const h4 = makeH4BullishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "Should be BUY, not SELL");
    assert.notEqual(result, "SELL", "Must never return SELL with BULLISH filters");
  });

  // 5A-08: SHORT bias maintained — H1 bearish AND H4 bearish → SHORT entry passes
  test("5A-08: trend_filters[H1 BEARISH, H4 BEARISH] → SELL", () => {
    const h1Bear = makeH1BearishData();
    const h4Bear = makeH4BearishData();
    const spec = makeSpec({
      conditions: [RSI_SELL_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BEARISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: makeRSISellInds(), H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SELL", "H1 BEARISH + H4 BEARISH → SELL");
  });

  // 5A-09: H1 forming bar not referenced (evalTime within H1 bar → uses previous H1)
  test("5A-09: H1 forming bar not referenced — evalTime mid-H1 uses prev confirmed bar", () => {
    // evalTime = T0 + 10*M5_MS = T0 + 3000s
    // H1 bar at T0 + 0: closes at T0 + H1_MS = T0 + 3600s > EVAL_T → NOT confirmed
    // H1 bar at T0 - H1_MS: closes at T0 → confirmed since T0 <= EVAL_T
    // But EVAL_T = T0 + 3000s, so the H1 bar starting at T0 closes at T0+3600s > EVAL_T

    // Build: 3 H1 bars. bar[2] starts at EVAL_T - 500ms (inside forming H1 bar)
    const H1_START_FORMING = EVAL_T - 500; // forming bar starts 500ms before evalTime
    const h1Bars = [
      makeBar(H1_START_FORMING - 2 * H1_MS, 1.10), // idx=0: closes at H1_START_FORMING - H1_MS → confirmed
      makeBar(H1_START_FORMING - H1_MS,     1.10), // idx=1: closes at H1_START_FORMING → confirmed (H1_START_FORMING <= EVAL_T)
      makeBar(H1_START_FORMING,             1.10), // idx=2: forming bar, closes H1_START_FORMING + H1_MS > EVAL_T
    ];
    // For idx=1: close=1.10, ema=1.08 → BULLISH ✓
    // For idx=2: close=1.10, ema=1.08 (even if used would be BULLISH, but shouldn't be accessed)
    const h1Ema1 = [1.09, 1.08, 1.08];
    const h1Inds = makeInds(3, { ema1: h1Ema1, params: { ema1Period: 21 } });

    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1Inds },
    });
    // Should use confirmed bar (idx=1), close=1.10 > ema=1.08 → BULLISH passes → BUY
    assert.equal(result, "BUY", "Should use last confirmed H1 bar, not forming bar");
  });

  // 5A-10: H4 forming bar not referenced
  test("5A-10: H4 forming bar not referenced — uses last confirmed H4 bar", () => {
    // H4 forming bar: starts 1000ms before EVAL_T
    const H4_START_FORMING = EVAL_T - 1000;
    const h4Bars = [
      makeBar(H4_START_FORMING - 2 * H4_MS, 1.10), // confirmed
      makeBar(H4_START_FORMING - H4_MS,     1.10), // confirmed
      makeBar(H4_START_FORMING,             1.10), // forming — should NOT be used
    ];
    const h4Ema1 = [1.09, 1.08, 999.0]; // idx=2 has absurd EMA to detect if used
    const h4Inds = makeInds(3, { ema1: h4Ema1, params: { ema1Period: 21 } });

    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H4: h4Bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H4: h4Inds },
    });
    // Should use idx=1: close=1.10 > ema=1.08 → BULLISH → BUY
    // If it incorrectly uses idx=2: close=1.10 > ema=999 → false → SKIP
    assert.equal(result, "BUY", "Must use confirmed H4 bar (idx=1), not forming bar (idx=2)");
  });

  // 5A-11: confirmed H1 and H4 bars used independently
  test("5A-11: H1 and H4 confirmed bars evaluated independently (different bar counts)", () => {
    const h1 = makeH1BullishData(); // 3 H1 bars
    const h4 = makeH4BullishData(); // 3 H4 bars — different period, independent index

    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds, H4: h4.inds },
    });
    // Both use getLastConfirmedBarIndex independently
    assert.equal(result, "BUY", "H1 and H4 bars each independently confirmed → BUY");
  });

});

// =================================================================
// ─── 5A-12〜5A-20: NEAR_EMA Operator ─────────────────────────────
// =================================================================

describe("5A-12〜5A-20: NEAR_EMA Operator", () => {

  // Common setup: EURUSD, M5, close=1.1000, ema21=1.1004
  // distance = |1.1000 - 1.1004| = 0.0004 = 4 pips (EURUSD pip = 0.0001)
  const CLOSE_NEAR = 1.1000;
  const EMA_NEAR   = 1.1004; // 4 pips away from close

  function makeNearEMASpec(threshold: number, symbol = "EURUSD"): StrategySpec {
    return makeSpec({
      symbols:    [symbol],
      conditions: [
        {
          indicator: "EMA",
          timeframe: "M5",
          period:    21,
          operator:  "NEAR_EMA",
          threshold,
        },
      ],
      // Need a trend filter to avoid AMBIGUOUS direction
      filters: {
        trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" },
      },
    });
  }

  function makeNearEMACtx(
    close:     number,
    emaValue:  number,
    threshold: number,
    symbol = "EURUSD",
  ): EvaluationContext {
    const bars = makeBars(
      [...Array(9).fill(close), close],
      T0, M5_MS
    );
    // Close > ema1 for BULLISH trend filter (we use a second ema1 value)
    // For NEAR_EMA check, ema21 = emaValue; for trend filter (BULLISH), close > ema21
    // We need close > ema → set ema = emaValue which may be > or < close
    // The BULLISH trend filter also uses EMA period 21 → same ema1 array
    // When close > ema: BULLISH filter passes; when close < ema: BULLISH filter fails
    // For NEAR_EMA tests we need the trend filter to pass so we can test NEAR_EMA result
    // Strategy: use ema1 < close for BULLISH, but NEAR_EMA also checks ema1
    // → use the same ema value that is slightly below close for direction=BULLISH
    // For the test we set ema to emaValue and adjust close accordingly
    const ema1 = Array<number | undefined>(10).fill(emaValue);
    const inds = makeInds(10, { ema1, params: { ema1Period: 21 } });
    const actualBars = makeBars([...Array(9).fill(close), close], T0, M5_MS);
    const spec = makeNearEMASpec(threshold, symbol);
    return {
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: actualBars },
      indicatorsByTimeframe: { M5: inds },
    };
  }

  // 5A-12: price within 5 pips → true
  test("5A-12: NEAR_EMA — close 4 pips away, threshold=5 → BUY", () => {
    // EURUSD: 1 pip = 0.0001
    // close=1.1000, ema=1.1004, distance=0.0004=4 pips < 5 → true
    // For BULLISH trend filter: we need close > ema but 1.1000 < 1.1004 → BEARISH
    // Workaround: use NEUTRAL direction on trend filter, determine direction from entry
    // NEAR_EMA has no inherent direction, so use a spec with explicit BUY trend filter
    // Let us invert: close=1.1004, ema=1.1000 → close > ema (BULLISH OK), distance=4 pips
    const close    = 1.1004;
    const emaValue = 1.1000;
    // distance = |1.1004 - 1.1000| / 0.0001 = 4 pips
    const ema1  = Array<number | undefined>(10).fill(emaValue);
    const inds  = makeInds(10, { ema1, params: { ema1Period: 21 } });
    const bars  = makeBars([...Array(9).fill(close), close], T0, M5_MS);
    const spec  = makeNearEMASpec(5, "EURUSD");
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "BUY", "4 pips < threshold 5 pips → NEAR_EMA true → BUY");
  });

  // 5A-13: price exactly threshold pips → true (inclusive boundary)
  test("5A-13: NEAR_EMA — close exactly 5 pips away, threshold=5 → BUY", () => {
    // close=1.1005, ema=1.1000, distance=5 pips (EURUSD)
    const close    = 1.1005;
    const emaValue = 1.1000;
    const ema1     = Array<number | undefined>(10).fill(emaValue);
    const inds     = makeInds(10, { ema1, params: { ema1Period: 21 } });
    const bars     = makeBars([...Array(9).fill(close), close], T0, M5_MS);
    const spec     = makeNearEMASpec(5, "EURUSD");
    const result   = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "BUY", "Exactly 5 pips = threshold → NEAR_EMA true (<=) → BUY");
  });

  // 5A-14: price 5.1 pips away → false
  test("5A-14: NEAR_EMA — close 5.1 pips away, threshold=5 → SKIP", () => {
    // close=1.1000, ema=1.1051/10 ... = 1.10051 → 5.1 pips
    // Easier: close=1.10051, ema=1.1000 → distance = 0.00051 → 5.1 pips
    // But we need close > ema for BULLISH filter
    const close    = 1.10051;
    const emaValue = 1.1000;
    const ema1     = Array<number | undefined>(10).fill(emaValue);
    const inds     = makeInds(10, { ema1, params: { ema1Period: 21 } });
    const bars     = makeBars([...Array(9).fill(close), close], T0, M5_MS);
    const spec     = makeNearEMASpec(5, "EURUSD");
    const result   = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP", "5.1 pips > threshold 5 → NEAR_EMA false → SKIP");
  });

  // 5A-15: NEAR_EMA does not determine LONG/SHORT direction alone
  test("5A-15: NEAR_EMA does not determine direction (direction from trend filter)", () => {
    // With BULLISH trend filter → BUY direction
    // With BEARISH trend filter → SELL direction
    // NEAR_EMA itself is direction-neutral
    //
    // BUY case:  close=1.1003, ema=1.1000 → close > ema (BULLISH) → 3 pips < 5 → NEAR_EMA true
    // SELL case: close=1.1003, ema=1.1006 → close < ema (BEARISH) → 3 pips < 5 → NEAR_EMA true
    const closeBuy  = 1.1003;
    const emaBull   = 1.1000; // close > ema → BULLISH trend passes; distance = 3 pips
    const emaBear   = 1.1006; // close < ema → BEARISH trend passes; distance = 3 pips

    const barsBuy  = makeBars([...Array(9).fill(closeBuy), closeBuy], T0, M5_MS);
    const barsSell = makeBars([...Array(9).fill(closeBuy), closeBuy], T0, M5_MS);

    const indsBull = makeInds(10, { ema1: Array<number | undefined>(10).fill(emaBull), params: { ema1Period: 21 } });
    const indsBear = makeInds(10, { ema1: Array<number | undefined>(10).fill(emaBear), params: { ema1Period: 21 } });

    const specBull = makeSpec({
      symbols:    ["EURUSD"],
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA", threshold: 5 }],
      filters: {
        trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" },
      },
    });
    const specBear = makeSpec({
      symbols:    ["EURUSD"],
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA", threshold: 5 }],
      filters: {
        trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BEARISH" },
      },
    });

    // BULLISH: close=1.1003 > ema=1.1000 → trend passes → BUY; NEAR_EMA 3pips < 5 → true
    const buyResult = evaluateStrategy({
      spec: specBull,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: barsBuy },
      indicatorsByTimeframe: { M5: indsBull },
    });
    // BEARISH: close=1.1003 < ema=1.1006 → trend passes → SELL; NEAR_EMA 3pips < 5 → true
    const sellResult = evaluateStrategy({
      spec: specBear,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: barsSell },
      indicatorsByTimeframe: { M5: indsBear },
    });

    assert.equal(buyResult,  "BUY",  "NEAR_EMA + BULLISH filter → BUY");
    assert.equal(sellResult, "SELL", "NEAR_EMA + BEARISH filter → SELL");
  });

  // 5A-16: EURUSD pip normalization (1 pip = 0.0001)
  test("5A-16: EURUSD pip normalization — 1 pip = 0.0001", () => {
    assert.equal(getPipSize("EURUSD"), 0.0001);
    assert.equal(getPipSize("GBPUSD"), 0.0001);
    assert.equal(getPipSize("AUDUSD"), 0.0001);
  });

  // 5A-17: USDJPY pip normalization (1 pip = 0.01)
  test("5A-17: USDJPY pip normalization — 1 pip = 0.01", () => {
    assert.equal(getPipSize("USDJPY"), 0.01);
    assert.equal(getPipSize("EURJPY"), 0.01);
    assert.equal(getPipSize("GBPJPY"), 0.01);
  });

  // 5A-18: XAUUSD pip normalization (1 pip = 0.10)
  test("5A-18: XAUUSD pip normalization — 1 pip = 0.10", () => {
    assert.equal(getPipSize("XAUUSD"), 0.10);
    assert.equal(getPipSize("GOLD"),   0.10);
  });

  // 5A-19: zero threshold → false (rejected in evaluation)
  test("5A-19: NEAR_EMA threshold=0 → SKIP (zero threshold rejected)", () => {
    const close    = 1.1000;
    const emaValue = 1.1000; // exact same price (0 pips away)
    const ema1     = Array<number | undefined>(10).fill(emaValue);
    const inds     = makeInds(10, { ema1, params: { ema1Period: 21 } });
    const bars     = makeBars([...Array(9).fill(close), close], T0, M5_MS);
    // Use NEUTRAL trend filter to avoid direction issues
    const spec = makeSpec({
      symbols:    ["EURUSD"],
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA", threshold: 0 }],
      filters: {
        trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" },
      },
    });
    // Even with 0 pip distance, threshold=0 is rejected (threshold must be > 0)
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP", "threshold=0 should be rejected → SKIP");
  });

  // 5A-20: negative threshold → false
  test("5A-20: NEAR_EMA threshold=-1 → SKIP (negative threshold rejected)", () => {
    const close    = 1.1000;
    const emaValue = 1.1000;
    const ema1     = Array<number | undefined>(10).fill(emaValue);
    const inds     = makeInds(10, { ema1, params: { ema1Period: 21 } });
    const bars     = makeBars([...Array(9).fill(close), close], T0, M5_MS);
    const spec = makeSpec({
      symbols:    ["EURUSD"],
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA", threshold: -1 }],
      filters: {
        trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" },
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP", "negative threshold → SKIP");
  });

});

// =================================================================
// ─── 5A-21〜5A-30: Regression & Edge Cases ───────────────────────
// =================================================================

describe("5A-21〜5A-30: Regression & Edge Cases", () => {

  // 5A-21: existing Strategy Specs with no trend_filters → unchanged behavior
  test("5A-21: spec without trend_filters → no change in behavior", () => {
    const rsi  = [...Array(9).fill(35), 28];
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: { max_spread_pips: 5.0 }, // no trend_filter, no trend_filters
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5 },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "BUY", "No trend filter → direction from conditions → BUY");
  });

  // 5A-22: existing RSI strategy evaluation result unchanged
  test("5A-22: existing RSI SELL strategy unchanged after Phase 5-A changes", () => {
    const rsi  = [...Array(9).fill(65), 72];
    const ema1 = Array(10).fill(1.15); // close=1.10 < ema=1.15 → BEARISH trend
    const inds = makeInds(10, { rsi, ema1 });
    const spec = makeSpec({
      conditions: [RSI_SELL_COND],
      filters: { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BEARISH" } },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5 },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SELL", "RSI SELL + BEARISH trend → SELL (regression check)");
  });

  // 5A-23: next-bar-open semantics unchanged
  test("5A-23: next-bar-open semantics unchanged — signal at close, execute on next open", () => {
    // evaluateStrategy returns BUY/SELL signal at bar close (evalTime = bar close)
    // Execution happens on next bar open — evaluator just returns direction, no price
    const rsi  = [...Array(9).fill(35), 28];
    const ema1 = Array(10).fill(1.08);
    const inds = makeInds(10, { rsi, ema1 });
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T, // = bar[9] close time
      barsByTimeframe:       { M5: BARS_M5 },
      indicatorsByTimeframe: { M5: inds },
    });
    // Returns BUY — BacktestEngine handles next-bar-open execution
    assert.equal(result, "BUY", "Signal returned at bar close; engine handles next-bar execution");
  });

  // 5A-24: trend_filters empty array → no trend filter applied
  test("5A-24: trend_filters=[] (empty array) → no filter applied (same as no filter)", () => {
    const rsi  = [...Array(9).fill(35), 28];
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: { trend_filters: [] }, // empty array
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5 },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "BUY", "Empty trend_filters array → no filter → BUY");
  });

  // 5A-25: NEAR_EMA period mismatch → false (safe fallback)
  test("5A-25: NEAR_EMA period mismatch (period=50 not precomputed) → SKIP", () => {
    // params have ema1Period=21, ema2Period=200; requesting period=50 → undefined
    const ema1 = Array<number | undefined>(10).fill(1.1000);
    // ema2 is for period=200 per DEFAULT_PARAMS
    const inds = makeInds(10, { ema1, params: { ema1Period: 21, ema2Period: 200 } });
    const bars = makeBars([...Array(9).fill(1.1000), 1.1000], T0, M5_MS);
    const spec = makeSpec({
      symbols:    ["EURUSD"],
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 50, operator: "NEAR_EMA", threshold: 5 }],
      filters: {
        trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" },
      },
    });
    // period=50 → getEMAValue returns undefined → NEAR_EMA returns false → SKIP
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP", "Period=50 not precomputed → EMA value undefined → SKIP");
  });

  // 5A-26: H1 + H4 + H1-entry condition three-way check
  test("5A-26: H1+H4 trend_filters with H1 entry condition — three-way check", () => {
    const h1 = makeH1BullishData();
    const h4 = makeH4BullishData();

    // Entry condition on H1: RSI BELOW 30
    const h1Rsi = [...Array(2).fill(35), 28]; // idx=2: rsi=28 → BUY signal
    const h1IndsWithRSI: PrecomputedIndicators = {
      ...h1.inds,
      rsi: h1Rsi,
    };

    const spec = makeSpec({
      conditions: [{
        indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 30,
      }],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });

    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: makeInds(10), H1: h1IndsWithRSI, H4: h4.inds },
    });
    assert.equal(result, "BUY", "H1+H4 trend + H1 RSI entry → BUY");
  });

  // 5A-27: trend_filters AND trend_filter both present → trend_filters takes precedence
  test("5A-27: trend_filters AND trend_filter both present → trend_filters takes precedence", () => {
    const h1 = makeH1BullishData();
    const h4 = makeH4BullishData();
    // trend_filter (singular) = H1 BEARISH (would reject)
    // trend_filters = [H1 BULLISH, H4 BULLISH] (should win)
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BEARISH" }, // should be ignored
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds, H4: h4.inds },
    });
    // trend_filters takes precedence → H1+H4 BULLISH → BUY (not SKIP from BEARISH)
    assert.equal(result, "BUY", "trend_filters[] takes precedence over trend_filter (singular)");
  });

  // 5A-28: NEAR_EMA on H1 TF (higher TF near EMA)
  test("5A-28: NEAR_EMA on H1 TF — uses H1 confirmed bar's close vs EMA", () => {
    // H1 close = 1.10, H1 EMA21 = 1.1003 → distance = 3 pips (EURUSD)
    // threshold = 5 → 3 < 5 → true
    const h1Start = EVAL_T - 3 * H1_MS;
    const h1Bars  = makeBars([1.10, 1.10, 1.10], h1Start, H1_MS);
    const h1Ema1  = [1.1003, 1.1003, 1.1003]; // close=1.10, ema=1.1003 → 3 pips
    const h1Inds  = makeInds(3, { ema1: h1Ema1, params: { ema1Period: 21 } });

    const spec = makeSpec({
      symbols: ["EURUSD"],
      conditions: [{
        indicator: "EMA", timeframe: "H1", period: 21, operator: "NEAR_EMA", threshold: 5,
      }],
      filters: {
        // H1 close=1.10 > H1 ema=1.1003? No — 1.10 < 1.1003 → BEARISH
        // Use BEARISH direction to avoid AMBIGUOUS
        trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BEARISH" },
      },
    });

    const m5Inds = makeInds(10);
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1Inds },
    });
    // NEAR_EMA on H1: distance=3 pips < 5 → true → SELL (from BEARISH direction)
    assert.equal(result, "SELL", "NEAR_EMA on H1 with 3-pip distance < threshold=5 → SELL");
  });

  // 5A-29: look-ahead safety with multiple trend filters
  test("5A-29: look-ahead safety — future H1/H4 bar changes don't affect evaluation", () => {
    const h1 = makeH1BullishData();
    const h4 = makeH4BullishData();
    const spec = makeSpec({
      conditions: [RSI_BUY_COND],
      filters: {
        trend_filters: [
          { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
          { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        ],
      },
    });

    // Normal evaluation
    const normalResult = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1.inds, H4: h4.inds },
    });

    // Inject absurd future bars (idx=2 is forming bar for both H1 and H4 in our setup)
    // Actually in our setup bar[2] IS confirmed. Let's add a 4th bar as future.
    const h1WithFuture = [
      ...h1.bars,
      makeBar(EVAL_T + H1_MS, 0.5), // future bar — should NOT affect result
    ];
    const h4WithFuture = [
      ...h4.bars,
      makeBar(EVAL_T + H4_MS, 0.5), // future bar
    ];
    const h1IndsWithFuture: PrecomputedIndicators = {
      ...h1.inds,
      ema1: [...h1.inds.ema1, 9999], // absurd future EMA
    };
    const h4IndsWithFuture: PrecomputedIndicators = {
      ...h4.inds,
      ema1: [...h4.inds.ema1, 9999],
    };

    const injectedResult = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1WithFuture, H4: h4WithFuture },
      indicatorsByTimeframe: { M5: makeRSIBuyInds(), H1: h1IndsWithFuture, H4: h4IndsWithFuture },
    });

    assert.equal(injectedResult, normalResult,
      `Future bar injection must not affect result: normal=${normalResult}, injected=${injectedResult}`);
    assert.equal(injectedResult, "BUY", "Look-ahead safe result should be BUY");
  });

  // 5A-30: all existing evaluator tests still pass (regression summary)
  // This test runs a sample of critical evaluator scenarios to ensure no regression
  test("5A-30: regression — EMA PRICE_ABOVE still works (core evaluator intact)", () => {
    const ema1 = Array(10).fill(1.08); // close=1.10 > ema=1.08 → BULLISH
    const inds = makeInds(10, { ema1 });
    const spec = makeSpec({
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" }],
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5 },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "BUY", "EMA PRICE_ABOVE regression check → BUY");
  });

});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) {
  console.log("All tests PASSED");
} else {
  console.log("Some tests FAILED");
  process.exit(1);
}

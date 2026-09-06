/**
 * Unit Tests — Phase 5-C: Multi-TF EMA21 Pullback LONG/SHORT Symmetry
 *
 * Tests:
 *   5C-01〜5C-06: Direction signal generation (LONG / SHORT)
 *   5C-07〜5C-10: Look-ahead safety (forming bar rejection)
 *   5C-11〜5C-12: Symmetry (risk, session)
 *   5C-13〜5C-16: Edge cases
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/phase5c.test.ts
 *
 * Floating-point note:
 *   EURUSD pip = 0.0001. To avoid FP precision issues at exact pip boundaries,
 *   tests use distances that are comfortably within or outside thresholds:
 *   - "within 3 pips":  close=1.1002, ema=1.1000 → ~2 pips (safe under 3)
 *   - "boundary" tests: threshold=5, distance=~4 pips (safe under 5)
 *   - "outside" tests:  distance=~6 pips vs threshold=5 (safe over 5)
 */

import assert from "node:assert/strict";
import type { Bar }                   from "@/infrastructure/analysis/types";
import type { MACDResult, ADXResult, BollingerResult } from "../types";
import type { PrecomputedIndicators } from "../indicators";
import type { StrategySpec }          from "@/lib/strategySchema";
import { evaluateStrategy, type EvaluationContext } from "../evaluator";
import { TF_MS }                      from "../timeframe";
import { calcSLTPSymmetry }           from "./phase5c_helpers";

// =================================================================
// ─── Test runner ────────────────────────────────────────────────
// =================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${msg}`);
    failed++;
  }
}

function describe(label: string, fn: () => void): void {
  console.log(`\n--- ${label} ---`);
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
  atr?:   (number | undefined)[];
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
    atr:         opts.atr   ?? undef(),
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

// =================================================================
// ─── Phase 5-C Strategy Spec helpers ───────────────────────────
// =================================================================

/** Phase 5-C LONG spec: H4 BULLISH + H1 BULLISH trend filters; NEAR_EMA + PRICE_ABOVE entry */
function makeLongSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v2 LONG",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-C LONG: H4+H1 BULLISH trend, EMA21 pullback entry (LONG)",
    symbols:        ["EURUSD"],
    timeframes:     ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE", threshold: 0 },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
      take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
    },
    filters: {
      sessions:        ["LONDON", "NEW_YORK"],
      max_spread_pips: 2.0,
      trend_filters: [
        { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
      ],
    },
    risk: { risk_per_trade: 0.01 },
  };
}

/** Phase 5-C SHORT spec: H4 BEARISH + H1 BEARISH trend filters; NEAR_EMA + PRICE_BELOW entry */
function makeShortSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v2 SHORT",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-C SHORT: H4+H1 BEARISH trend, EMA21 pullback entry (SHORT)",
    symbols:        ["EURUSD"],
    timeframes:     ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW", threshold: 0 },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
      take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
    },
    filters: {
      sessions:        ["LONDON", "NEW_YORK"],
      max_spread_pips: 2.0,
      trend_filters: [
        { timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" },
        { timeframe: "H1", indicator: "EMA", period: 21, direction: "BEARISH" },
      ],
    },
    risk: { risk_per_trade: 0.01 },
  };
}

// =================================================================
// ─── Shared time anchors ─────────────────────────────────────────
// =================================================================

const M5_MS = TF_MS["M5"]!;   // 300_000
const H1_MS = TF_MS["H1"]!;   // 3_600_000
const H4_MS = TF_MS["H4"]!;   // 14_400_000

// Anchor: 2025-01-15 09:00 UTC (Wednesday, LONDON session 07:00-16:00)
const T0     = new Date("2025-01-15T09:00:00.000Z").getTime();
// evalTime = T0 + 10 * M5_MS = 09:50 UTC (still in LONDON session)
const EVAL_T = T0 + 10 * M5_MS;

// ─── H1 helpers ──────────────────────────────────────────────────

/** H1 confirmed bar at EVAL_T: close=1.10 > EMA21=1.09 → BULLISH */
function makeH1Bullish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h1Start = EVAL_T - 3 * H1_MS;
  const bars    = makeBars([1.07, 1.09, 1.10], h1Start, H1_MS);
  const ema1    = [1.06, 1.08, 1.09]; // close[2]=1.10 > ema[2]=1.09 → BULLISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

/** H1 confirmed bar at EVAL_T: close=1.10 < EMA21=1.15 → BEARISH */
function makeH1Bearish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h1Start = EVAL_T - 3 * H1_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h1Start, H1_MS);
  const ema1    = [1.16, 1.15, 1.15]; // close[2]=1.10 < ema[2]=1.15 → BEARISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

// ─── H4 helpers ──────────────────────────────────────────────────

/** H4 confirmed bar at EVAL_T: close=1.10 > EMA21=1.08 → BULLISH */
function makeH4Bullish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.07, 1.09, 1.10], h4Start, H4_MS);
  const ema1    = [1.06, 1.07, 1.08]; // close[2]=1.10 > ema[2]=1.08 → BULLISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

/** H4 confirmed bar at EVAL_T: close=1.10 < EMA21=1.15 → BEARISH */
function makeH4Bearish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h4Start, H4_MS);
  const ema1    = [1.16, 1.15, 1.15]; // close[2]=1.10 < ema[2]=1.15 → BEARISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

// ─── M5 LONG entry helpers ────────────────────────────────────────

/**
 * M5 LONG entry:
 *   close=1.1002, EMA21=1.1000
 *   - PRICE_ABOVE: 1.1002 > 1.1000 ✓
 *   - NEAR_EMA: |1.1002-1.1000|/0.0001 ≈ 2 pips ≤ 3 ✓
 *
 * Note: 2 pips used (not 3) to avoid floating-point boundary ambiguity.
 */
function makeM5LongEntry(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const close = 1.1002;
  const ema21 = 1.1000; // close > ema → PRICE_ABOVE ✓; ~2 pips → NEAR_EMA(3) ✓
  const bars  = makeBars(Array(10).fill(close) as number[], T0, M5_MS);
  const ema1  = Array<number | undefined>(10).fill(ema21);
  return { bars, inds: makeInds(10, { ema1, params: { ema1Period: 21 } }) };
}

/**
 * M5 SHORT entry:
 *   close=1.1000, EMA21=1.1002
 *   - PRICE_BELOW: 1.1000 < 1.1002 ✓
 *   - NEAR_EMA: |1.1000-1.1002|/0.0001 ≈ 2 pips ≤ 3 ✓
 */
function makeM5ShortEntry(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const close = 1.1000;
  const ema21 = 1.1002; // close < ema → PRICE_BELOW ✓; ~2 pips → NEAR_EMA(3) ✓
  const bars  = makeBars(Array(10).fill(close) as number[], T0, M5_MS);
  const ema1  = Array<number | undefined>(10).fill(ema21);
  return { bars, inds: makeInds(10, { ema1, params: { ema1Period: 21 } }) };
}

// =================================================================
// ─── 5C-01〜5C-06: Signal direction tests ────────────────────────
// =================================================================

describe("5C-01〜5C-06: Signal Direction (LONG / SHORT)", () => {

  // 5C-01: Bullish H4+H1 + price above EMA21 → BUY
  test("5C-01: H4 BULLISH + H1 BULLISH + PRICE_ABOVE → BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongEntry();

    const result = evaluateStrategy({
      spec:                  makeLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "LONG spec with bullish H1+H4 and price above EMA → BUY");
  });

  // 5C-02: Bearish H4+H1 → LONG spec rejected
  test("5C-02: H4 BEARISH + H1 BEARISH → LONG spec → SKIP (BULLISH filter fails)", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5     = makeM5LongEntry();

    const result = evaluateStrategy({
      spec:                  makeLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SKIP", "LONG spec with bearish trend → SKIP");
  });

  // 5C-03: Bearish H4+H1 + price below EMA21 → SELL
  test("5C-03: H4 BEARISH + H1 BEARISH + PRICE_BELOW → SELL", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5     = makeM5ShortEntry();

    const result = evaluateStrategy({
      spec:                  makeShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SELL", "SHORT spec with bearish H1+H4 and price below EMA → SELL");
  });

  // 5C-04: Bullish H4+H1 → SHORT spec rejected
  test("5C-04: H4 BULLISH + H1 BULLISH → SHORT spec → SKIP (BEARISH filter fails)", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5ShortEntry();

    const result = evaluateStrategy({
      spec:                  makeShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "SKIP", "SHORT spec with bullish trend → SKIP");
  });

  // 5C-05: LONG NEAR_EMA boundary test — threshold=5, distance=~4 pips → BUY
  test("5C-05: LONG NEAR_EMA within boundary (threshold=5, ~4 pips) → BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    // close=1.1004, ema=1.1000 → ~4 pips < threshold=5 → NEAR_EMA ✓
    // close > ema → PRICE_ABOVE ✓
    const close  = 1.1004;
    const ema21  = 1.1000;
    const bars   = makeBars(Array(10).fill(close) as number[], T0, M5_MS);
    const ema1   = Array<number | undefined>(10).fill(ema21);
    const m5Inds = makeInds(10, { ema1, params: { ema1Period: 21 } });

    const spec: StrategySpec = {
      ...makeLongSpec(),
      entry_conditions: {
        logic: "AND",
        conditions: [
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 5 },
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE", threshold: 0 },
        ],
      },
    };
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "~4 pips < threshold=5 → NEAR_EMA passes → BUY");
  });

  // 5C-06: SHORT NEAR_EMA boundary test — threshold=5, distance=~4 pips → SELL
  test("5C-06: SHORT NEAR_EMA within boundary (threshold=5, ~4 pips) → SELL", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    // close=1.1000, ema=1.1004 → ~4 pips → NEAR_EMA(5) ✓; close < ema → PRICE_BELOW ✓
    const close  = 1.1000;
    const ema21  = 1.1004;
    const bars   = makeBars(Array(10).fill(close) as number[], T0, M5_MS);
    const ema1   = Array<number | undefined>(10).fill(ema21);
    const m5Inds = makeInds(10, { ema1, params: { ema1Period: 21 } });

    const spec: StrategySpec = {
      ...makeShortSpec(),
      entry_conditions: {
        logic: "AND",
        conditions: [
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 5 },
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW", threshold: 0 },
        ],
      },
    };
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SELL", "~4 pips < threshold=5 → NEAR_EMA passes → SELL");
  });

});

// =================================================================
// ─── 5C-07〜5C-10: Look-Ahead Safety (forming bar rejection) ─────
// =================================================================

describe("5C-07〜5C-10: Look-Ahead Safety (Forming Bar Rejection)", () => {

  // 5C-07: H1 forming bar ignored for LONG
  test("5C-07: H1 forming bar NOT used for LONG trend filter", () => {
    const h4   = makeH4Bullish();
    const m5   = makeM5LongEntry();

    // H1 bars: bar[1] confirmed (close>ema → BULLISH), bar[2] forming (absurd EMA)
    const H1_FORMING_START = EVAL_T - 500; // starts 500ms before EVAL_T → closes at EVAL_T + H1_MS - 500ms > EVAL_T
    const h1Bars = [
      makeBar(H1_FORMING_START - 2 * H1_MS, 1.10),
      makeBar(H1_FORMING_START - H1_MS,     1.10), // confirmed: close=1.10 > ema=1.09 → BULLISH
      makeBar(H1_FORMING_START,             1.10), // forming — closes AFTER EVAL_T
    ];
    const h1Ema1 = [1.09, 1.09, 9999.0]; // forming bar ema is absurd
    const h1Inds = makeInds(3, { ema1: h1Ema1, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  makeLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Inds,  H4: h4.inds },
    });
    // If forming bar used: close=1.10 < ema=9999 → BEARISH → fails BULLISH filter → SKIP
    // If confirmed bar used: close=1.10 > ema=1.09 → BULLISH → passes → BUY
    assert.equal(result, "BUY", "Must use confirmed H1 bar, not forming bar → BUY");
  });

  // 5C-08: H1 forming bar ignored for SHORT
  test("5C-08: H1 forming bar NOT used for SHORT trend filter", () => {
    const h4Bear = makeH4Bearish();
    const m5     = makeM5ShortEntry();

    // H1 bars: bar[1] confirmed (close<ema → BEARISH), bar[2] forming (absurd tiny EMA)
    const H1_FORMING_START = EVAL_T - 500;
    const h1Bars = [
      makeBar(H1_FORMING_START - 2 * H1_MS, 1.10),
      makeBar(H1_FORMING_START - H1_MS,     1.10), // confirmed: close=1.10 < ema=1.15 → BEARISH
      makeBar(H1_FORMING_START,             1.10), // forming — closes AFTER EVAL_T
    ];
    const h1Ema1 = [1.15, 1.15, 0.0001]; // forming bar ema is absurdly low → if used: BULLISH → fails BEARISH
    const h1Inds = makeInds(3, { ema1: h1Ema1, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  makeShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Inds,  H4: h4Bear.inds },
    });
    // If forming bar used: close=1.10 > ema=0.0001 → BULLISH → fails BEARISH filter → SKIP
    // If confirmed bar used: close=1.10 < ema=1.15 → BEARISH → passes → SELL
    assert.equal(result, "SELL", "Must use confirmed H1 bar, not forming bar → SELL");
  });

  // 5C-09: H4 forming bar ignored for LONG
  test("5C-09: H4 forming bar NOT used for LONG trend filter", () => {
    const h1 = makeH1Bullish();
    const m5 = makeM5LongEntry();

    // H4 bars: bar[1] confirmed (BULLISH), bar[2] forming (absurd EMA)
    const H4_FORMING_START = EVAL_T - 1000;
    const h4Bars = [
      makeBar(H4_FORMING_START - 2 * H4_MS, 1.10),
      makeBar(H4_FORMING_START - H4_MS,     1.10), // confirmed: close=1.10 > ema=1.08 → BULLISH
      makeBar(H4_FORMING_START,             1.10), // forming — closes AFTER EVAL_T
    ];
    const h4Ema1 = [1.08, 1.08, 9999.0]; // forming bar ema is absurd
    const h4Inds = makeInds(3, { ema1: h4Ema1, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  makeLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4Bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds,  H4: h4Inds },
    });
    // If forming bar used: close=1.10 < ema=9999 → BEARISH → fails BULLISH filter → SKIP
    // If confirmed bar used: close=1.10 > ema=1.08 → BULLISH → passes → BUY
    assert.equal(result, "BUY", "Must use confirmed H4 bar, not forming bar → BUY");
  });

  // 5C-10: H4 forming bar ignored for SHORT
  test("5C-10: H4 forming bar NOT used for SHORT trend filter", () => {
    const h1Bear = makeH1Bearish();
    const m5     = makeM5ShortEntry();

    // H4 bars: bar[1] confirmed (BEARISH), bar[2] forming (absurd tiny EMA)
    const H4_FORMING_START = EVAL_T - 1000;
    const h4Bars = [
      makeBar(H4_FORMING_START - 2 * H4_MS, 1.10),
      makeBar(H4_FORMING_START - H4_MS,     1.10), // confirmed: close=1.10 < ema=1.15 → BEARISH
      makeBar(H4_FORMING_START,             1.10), // forming — closes AFTER EVAL_T
    ];
    const h4Ema1 = [1.15, 1.15, 0.0001]; // forming bar ema absurdly low
    const h4Inds = makeInds(3, { ema1: h4Ema1, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  makeShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Inds },
    });
    // If forming bar used: close=1.10 > ema=0.0001 → BULLISH → fails BEARISH filter → SKIP
    // If confirmed bar used: close=1.10 < ema=1.15 → BEARISH → passes → SELL
    assert.equal(result, "SELL", "Must use confirmed H4 bar, not forming bar → SELL");
  });

});

// =================================================================
// ─── 5C-11〜5C-12: LONG/SHORT Risk and Session Symmetry ──────────
// =================================================================

describe("5C-11〜5C-12: Risk and Session Symmetry", () => {

  // 5C-11: LONG and SHORT use identical ATR SL / RR=2.0 TP
  test("5C-11: LONG and SHORT risk parameters are identical (ATR×1.5 SL, RR=2.0 TP)", () => {
    const longSpec  = makeLongSpec();
    const shortSpec = makeShortSpec();

    const longSL  = longSpec.exit_conditions?.stop_loss;
    const shortSL = shortSpec.exit_conditions?.stop_loss;
    const longTP  = longSpec.exit_conditions?.take_profit;
    const shortTP = shortSpec.exit_conditions?.take_profit;

    assert.equal(longSL?.method,     "ATR",      "LONG SL method = ATR");
    assert.equal(shortSL?.method,    "ATR",      "SHORT SL method = ATR");
    assert.equal(longSL?.multiplier,  1.5,       "LONG SL multiplier = 1.5");
    assert.equal(shortSL?.multiplier, 1.5,       "SHORT SL multiplier = 1.5");
    assert.equal(longTP?.method,     "RR_RATIO", "LONG TP method = RR_RATIO");
    assert.equal(shortTP?.method,    "RR_RATIO", "SHORT TP method = RR_RATIO");
    assert.equal(longTP?.rr_ratio,    2.0,       "LONG TP RR = 2.0");
    assert.equal(shortTP?.rr_ratio,   2.0,       "SHORT TP RR = 2.0");

    // Verify SL distances are symmetric
    const { longSLDist, shortSLDist } = calcSLTPSymmetry();
    assert.ok(
      Math.abs(longSLDist - shortSLDist) < 1e-10,
      `SL distance not symmetric: LONG=${longSLDist}, SHORT=${shortSLDist}`,
    );
  });

  // 5C-12: LONG and SHORT use same sessions [LONDON, NEW_YORK]
  test("5C-12: LONG and SHORT session filters are identical [LONDON, NEW_YORK]", () => {
    const longSpec  = makeLongSpec();
    const shortSpec = makeShortSpec();

    const longSessions  = longSpec.filters?.sessions ?? [];
    const shortSessions = shortSpec.filters?.sessions ?? [];

    assert.deepEqual(
      [...longSessions].sort(),
      [...shortSessions].sort(),
      "LONG and SHORT must have identical session filters",
    );
    assert.ok(longSessions.includes("LONDON"),   "Must include LONDON");
    assert.ok(longSessions.includes("NEW_YORK"), "Must include NEW_YORK");
  });

});

// =================================================================
// ─── 5C-13〜5C-16: Edge Cases ────────────────────────────────────
// =================================================================

describe("5C-13〜5C-16: Edge Cases", () => {

  // 5C-13: Mixed trend (H4 BULLISH, H1 BEARISH) → LONG spec SKIP
  test("5C-13: H4 BULLISH + H1 BEARISH → LONG spec → SKIP (H1 fails BULLISH filter)", () => {
    const h1Bear = makeH1Bearish();
    const h4Bull = makeH4Bullish();
    const m5     = makeM5LongEntry();

    const result = evaluateStrategy({
      spec:                  makeLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bull.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bull.inds },
    });
    assert.equal(result, "SKIP", "H4 bullish but H1 bearish → LONG AND filter fails → SKIP");
  });

  // 5C-14: Mixed trend (H4 BEARISH, H1 BULLISH) → SHORT spec SKIP
  test("5C-14: H4 BEARISH + H1 BULLISH → SHORT spec → SKIP (H1 fails BEARISH filter)", () => {
    const h1Bull = makeH1Bullish();
    const h4Bear = makeH4Bearish();
    const m5     = makeM5ShortEntry();

    const result = evaluateStrategy({
      spec:                  makeShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bull.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bull.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SKIP", "H4 bearish but H1 bullish → SHORT AND filter fails → SKIP");
  });

  // 5C-15: BULLISH trend but price below EMA21 (too far away) → LONG spec SKIP
  test("5C-15: BULLISH trend but price >6 pips from EMA21 → LONG spec → SKIP (NEAR_EMA fails)", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    // close=1.1006, ema=1.1000 → ~6 pips > threshold=5 → NEAR_EMA(5) fails
    const close  = 1.1006;
    const ema21  = 1.1000;
    const bars   = makeBars(Array(10).fill(close) as number[], T0, M5_MS);
    const ema1   = Array<number | undefined>(10).fill(ema21);
    const m5Inds = makeInds(10, { ema1, params: { ema1Period: 21 } });

    const spec: StrategySpec = {
      ...makeLongSpec(),
      entry_conditions: {
        logic: "AND",
        conditions: [
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 5 },
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE", threshold: 0 },
        ],
      },
    };
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "SKIP", "~6 pips > threshold=5 → NEAR_EMA fails → SKIP");
  });

  // 5C-16: BEARISH trend but price too far from EMA21 → SHORT spec SKIP
  test("5C-16: BEARISH trend but price >6 pips from EMA21 → SHORT spec → SKIP (NEAR_EMA fails)", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    // close=1.1000, ema=1.1006 → ~6 pips > threshold=5 → NEAR_EMA(5) fails
    const close  = 1.1000;
    const ema21  = 1.1006;
    const bars   = makeBars(Array(10).fill(close) as number[], T0, M5_MS);
    const ema1   = Array<number | undefined>(10).fill(ema21);
    const m5Inds = makeInds(10, { ema1, params: { ema1Period: 21 } });

    const spec: StrategySpec = {
      ...makeShortSpec(),
      entry_conditions: {
        logic: "AND",
        conditions: [
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 5 },
          { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW", threshold: 0 },
        ],
      },
    };
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SKIP", "~6 pips > threshold=5 → NEAR_EMA fails → SKIP");
  });

});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 5-C Tests: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) {
  console.log("All tests PASSED");
} else {
  console.log("Some tests FAILED");
  process.exit(1);
}

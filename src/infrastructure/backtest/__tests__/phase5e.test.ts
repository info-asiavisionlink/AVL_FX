/**
 * Unit Tests — Phase 5-E: RSI State Filter (Overbought/Oversold Exclusion)
 *
 * Hypothesis: RSI used as a STATE filter (not crossover).
 *   LONG:  RSI(14) < 60  — exclude overbought longs
 *   SHORT: RSI(14) > 40  — exclude oversold shorts
 *
 * Tests:
 *   5E-01: LONG RSI=58 (<60) → passes
 *   5E-02: LONG RSI=60 (boundary, not strictly < 60) → SKIP
 *   5E-03: LONG RSI=62 (>60) → rejected
 *   5E-04: SHORT RSI=42 (>40) → passes
 *   5E-05: SHORT RSI=40 (boundary, not strictly > 40) → SKIP
 *   5E-06: SHORT RSI=38 (<40) → rejected
 *   5E-07: LONG/SHORT complete symmetry (BELOW 60 / ABOVE 40)
 *   5E-08: Phase 5-D CROSS_UP still works (backward compat)
 *   5E-09: Phase 5-C no RSI still works (backward compat)
 *   5E-10: H4 forming bar not referenced with RSI state filter
 *   5E-11: RSI state filter does not affect direction (neutral to LONG/SHORT)
 *   5E-12: RSI state only filter, not timing — no prev bar required
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/phase5e.test.ts
 */

import assert from "node:assert/strict";
import type { Bar }                   from "@/infrastructure/analysis/types";
import type { MACDResult, ADXResult, BollingerResult } from "../types";
import type { PrecomputedIndicators } from "../indicators";
import type { StrategySpec }          from "@/lib/strategySchema";
import { evaluateStrategy }           from "../evaluator";
import { TF_MS }                      from "../timeframe";

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
// ─── Phase 5-E Strategy Spec helpers ───────────────────────────
// =================================================================

/**
 * Phase 5-E LONG spec:
 *   H4 BULLISH + H1 BULLISH trend filters
 *   Entry (AND):
 *     1. EMA(21) M5 NEAR_EMA threshold=3 pips
 *     2. EMA(21) M5 PRICE_ABOVE
 *     3. RSI(14) M5 BELOW 60  (curr < 60 — exclude overbought)
 */
function make5ELongSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v4 LONG",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-E LONG: H4+H1 BULLISH trend, EMA21 pullback + RSI(14) state filter BELOW 60",
    symbols:        ["EURUSD"],
    timeframes:     ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE", threshold: 0 },
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW",       threshold: 60 },
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

/**
 * Phase 5-E SHORT spec:
 *   H4 BEARISH + H1 BEARISH trend filters
 *   Entry (AND):
 *     1. EMA(21) M5 NEAR_EMA threshold=3 pips
 *     2. EMA(21) M5 PRICE_BELOW
 *     3. RSI(14) M5 ABOVE 40  (curr > 40 — exclude oversold)
 */
function make5EShortSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v4 SHORT",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-E SHORT: H4+H1 BEARISH trend, EMA21 pullback + RSI(14) state filter ABOVE 40",
    symbols:        ["EURUSD"],
    timeframes:     ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW", threshold: 0 },
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "ABOVE",       threshold: 40 },
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

/** Phase 5-D LONG spec (CROSS_UP) — for backward compat test */
function make5DLongSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v3 LONG",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-D LONG",
    symbols:        ["EURUSD"],
    timeframes:     ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE", threshold: 0 },
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "CROSS_UP",    threshold: 50 },
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

/** Phase 5-C LONG spec (no RSI) — for backward compat test */
function make5CLongSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v2 LONG",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-C LONG",
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

// =================================================================
// ─── H1 / H4 helpers ─────────────────────────────────────────────
// =================================================================

function makeH1Bullish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h1Start = EVAL_T - 3 * H1_MS;
  const bars    = makeBars([1.07, 1.09, 1.10], h1Start, H1_MS);
  const ema1    = [1.06, 1.08, 1.09]; // close[2]=1.10 > ema[2]=1.09 → BULLISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

function makeH1Bearish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h1Start = EVAL_T - 3 * H1_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h1Start, H1_MS);
  const ema1    = [1.16, 1.15, 1.15]; // close[2]=1.10 < ema[2]=1.15 → BEARISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

function makeH4Bullish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.07, 1.09, 1.10], h4Start, H4_MS);
  const ema1    = [1.06, 1.07, 1.08]; // close[2]=1.10 > ema[2]=1.08 → BULLISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

function makeH4Bearish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h4Start, H4_MS);
  const ema1    = [1.16, 1.15, 1.15]; // close[2]=1.10 < ema[2]=1.15 → BEARISH
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

// =================================================================
// ─── M5 helpers ──────────────────────────────────────────────────
// =================================================================

/**
 * Build M5 bars+inds for LONG state filter:
 *   - close > ema21 (PRICE_ABOVE passes)
 *   - |close - ema21| ≈ 2 pips (NEAR_EMA(3) passes)
 *   - rsi[idx] = rsiVal (single confirmed bar, no prev bar needed)
 *
 * evalTime = EVAL_T = T0 + 10 * M5_MS
 * getLastConfirmedBarIndex → idx=9 (bar[9].time + M5_MS = EVAL_T)
 * n = 11 bars (index 0..10)
 */
function makeM5LongState(rsiVal: number): { bars: Bar[]; inds: PrecomputedIndicators } {
  const n     = 11;
  const close = 1.1002; // ~2 pips above EMA21
  const ema21 = 1.1000;
  const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
  const ema1  = Array<number | undefined>(n).fill(ema21);
  const rsi   = Array<number | undefined>(n).fill(undefined);
  rsi[9] = rsiVal; // confirmed bar (getLastConfirmedBarIndex → 9)
  return { bars, inds: makeInds(n, { ema1, rsi, params: { ema1Period: 21 } }) };
}

/**
 * Build M5 bars+inds for SHORT state filter:
 *   - close < ema21 (PRICE_BELOW passes)
 *   - |close - ema21| ≈ 2 pips (NEAR_EMA(3) passes)
 *   - rsi[idx] = rsiVal
 */
function makeM5ShortState(rsiVal: number): { bars: Bar[]; inds: PrecomputedIndicators } {
  const n     = 11;
  const close = 1.1000; // ~2 pips below EMA21
  const ema21 = 1.1002;
  const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
  const ema1  = Array<number | undefined>(n).fill(ema21);
  const rsi   = Array<number | undefined>(n).fill(undefined);
  rsi[9] = rsiVal; // confirmed bar
  return { bars, inds: makeInds(n, { ema1, rsi, params: { ema1Period: 21 } }) };
}

/**
 * Build M5 bars for Phase 5-D backward compat (CROSS_UP):
 *   rsi[8]=prevRsi, rsi[9]=currRsi
 */
function makeM5LongCrossUp(prevRsi: number, currRsi: number): { bars: Bar[]; inds: PrecomputedIndicators } {
  const n     = 11;
  const close = 1.1002;
  const ema21 = 1.1000;
  const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
  const ema1  = Array<number | undefined>(n).fill(ema21);
  const rsi   = Array<number | undefined>(n).fill(undefined);
  rsi[8] = prevRsi;
  rsi[9] = currRsi;
  return { bars, inds: makeInds(n, { ema1, rsi, params: { ema1Period: 21 } }) };
}

// =================================================================
// ─── 5E-01〜5E-03: LONG RSI State Filter Pass / Reject ───────────
// =================================================================

describe("5E-01〜5E-03: LONG RSI State Filter (BELOW 60)", () => {

  // 5E-01: RSI=58 < 60 → passes
  test("5E-01: LONG RSI=58 (< 60) → BELOW 60 passes → BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongState(58);

    const result = evaluateStrategy({
      spec:                  make5ELongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "RSI=58 < 60 → BELOW 60 state filter passes → BUY");
  });

  // 5E-02: RSI=60 boundary — BELOW is strict (<), so RSI=60 does NOT pass
  test("5E-02: LONG RSI=60 (boundary, not strictly < 60) → BELOW 60 fails → SKIP", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongState(60);

    const result = evaluateStrategy({
      spec:                  make5ELongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    // evalRSI BELOW: curr < threshold → 60 < 60 = false → SKIP
    assert.equal(result, "SKIP", "RSI=60 not strictly < 60 → BELOW 60 fails → SKIP");
  });

  // 5E-03: RSI=62 > 60 → overbought → rejected
  test("5E-03: LONG RSI=62 (> 60, overbought) → BELOW 60 fails → SKIP", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongState(62);

    const result = evaluateStrategy({
      spec:                  make5ELongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "SKIP", "RSI=62 > 60 → overbought LONG excluded → SKIP");
  });

});

// =================================================================
// ─── 5E-04〜5E-06: SHORT RSI State Filter Pass / Reject ──────────
// =================================================================

describe("5E-04〜5E-06: SHORT RSI State Filter (ABOVE 40)", () => {

  // 5E-04: RSI=42 > 40 → passes
  test("5E-04: SHORT RSI=42 (> 40) → ABOVE 40 passes → SELL", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5 = makeM5ShortState(42);

    const result = evaluateStrategy({
      spec:                  make5EShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SELL", "RSI=42 > 40 → ABOVE 40 state filter passes → SELL");
  });

  // 5E-05: RSI=40 boundary — ABOVE is strict (>), so RSI=40 does NOT pass
  test("5E-05: SHORT RSI=40 (boundary, not strictly > 40) → ABOVE 40 fails → SKIP", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5 = makeM5ShortState(40);

    const result = evaluateStrategy({
      spec:                  make5EShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    // evalRSI ABOVE: curr > threshold → 40 > 40 = false → SKIP
    assert.equal(result, "SKIP", "RSI=40 not strictly > 40 → ABOVE 40 fails → SKIP");
  });

  // 5E-06: RSI=38 < 40 → oversold → rejected
  test("5E-06: SHORT RSI=38 (< 40, oversold) → ABOVE 40 fails → SKIP", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5 = makeM5ShortState(38);

    const result = evaluateStrategy({
      spec:                  make5EShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SKIP", "RSI=38 < 40 → oversold SHORT excluded → SKIP");
  });

});

// =================================================================
// ─── 5E-07: LONG/SHORT Symmetry ──────────────────────────────────
// =================================================================

describe("5E-07: LONG/SHORT Complete Symmetry (BELOW 60 / ABOVE 40)", () => {

  test("5E-07: LONG uses BELOW 60, SHORT uses ABOVE 40 — mirror filter logic confirmed", () => {
    const longSpec  = make5ELongSpec();
    const shortSpec = make5EShortSpec();

    const longRsiCond  = longSpec.entry_conditions.conditions.find(c => c.indicator === "RSI");
    const shortRsiCond = shortSpec.entry_conditions.conditions.find(c => c.indicator === "RSI");

    assert.ok(longRsiCond,  "LONG spec must have RSI condition");
    assert.ok(shortRsiCond, "SHORT spec must have RSI condition");
    assert.equal(longRsiCond!.indicator,  "RSI",   "LONG: indicator = RSI");
    assert.equal(shortRsiCond!.indicator, "RSI",   "SHORT: indicator = RSI");
    assert.equal(longRsiCond!.period,     14,      "LONG: RSI period = 14");
    assert.equal(shortRsiCond!.period,    14,      "SHORT: RSI period = 14");
    assert.equal(longRsiCond!.operator,   "BELOW", "LONG: operator = BELOW (exclude overbought)");
    assert.equal(shortRsiCond!.operator,  "ABOVE", "SHORT: operator = ABOVE (exclude oversold)");
    assert.equal(longRsiCond!.threshold,  60,      "LONG: threshold = 60");
    assert.equal(shortRsiCond!.threshold, 40,      "SHORT: threshold = 40");

    // Verify symmetry: LONG excludes RSI >= 60, SHORT excludes RSI <= 40
    // LONG allows: RSI 0-59 (extreme area excluded at top)
    // SHORT allows: RSI 41-100 (extreme area excluded at bottom)
    // Neutral zone (40-60) is the "normal" zone for entry
    const longAllowRange = [0, 59]; // RSI < 60
    const shortAllowRange = [41, 100]; // RSI > 40
    // Their overlap (41-59) is the strictest filter zone
    const overlap = [Math.max(longAllowRange[0], shortAllowRange[0]), Math.min(longAllowRange[1], shortAllowRange[1])];
    assert.ok(overlap[0] <= overlap[1], "Overlap zone (41-59) must exist — not mutually exclusive");
  });

});

// =================================================================
// ─── 5E-08: Phase 5-D CROSS_UP backward compatibility ────────────
// =================================================================

describe("5E-08: Phase 5-D CROSS_UP Still Works (Backward Compat)", () => {

  test("5E-08: Phase 5-D LONG spec CROSS_UP 50 still produces BUY (backward compat)", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    // Phase 5-D needs prev<50, curr>=50 for CROSS_UP
    const m5 = makeM5LongCrossUp(45, 52);

    const result = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "Phase 5-D CROSS_UP RSI(45→52) still works → BUY");
  });

});

// =================================================================
// ─── 5E-09: Phase 5-C no RSI backward compatibility ──────────────
// =================================================================

describe("5E-09: Phase 5-C No RSI Still Works (Backward Compat)", () => {

  test("5E-09: Phase 5-C LONG spec (no RSI condition) still produces BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();

    const n     = 12;
    const close = 1.1002;
    const ema21 = 1.1000;
    const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
    const ema1  = Array<number | undefined>(n).fill(ema21);
    const m5Inds = makeInds(n, { ema1, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  make5CLongSpec(), // no RSI condition
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "Phase 5-C LONG without RSI → BUY (backward compat)");
  });

});

// =================================================================
// ─── 5E-10: H4 Forming Bar Not Referenced ────────────────────────
// =================================================================

describe("5E-10: H4 Forming Bar Not Referenced with RSI State Filter", () => {

  test("5E-10: H4 forming bar ignored — confirmed H4 BULLISH + RSI state filter (BELOW 60) → BUY", () => {
    const h1 = makeH1Bullish();
    const m5 = makeM5LongState(55); // RSI=55 < 60 → BELOW 60 passes

    // H4: bar[1] confirmed (BULLISH), bar[2] forming (absurd EMA → would appear BEARISH)
    const H4_FORMING_START = EVAL_T - 1000; // starts 1s before EVAL_T → closes after EVAL_T
    const h4Bars = [
      makeBar(H4_FORMING_START - 2 * H4_MS, 1.10),
      makeBar(H4_FORMING_START - H4_MS,     1.10), // confirmed: close=1.10 > ema=1.08 → BULLISH
      makeBar(H4_FORMING_START,             1.10), // forming bar
    ];
    const h4Ema1 = [1.08, 1.08, 9999.0]; // forming bar ema absurd
    const h4Inds = makeInds(3, { ema1: h4Ema1, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  make5ELongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4Bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4Inds },
    });
    // If forming H4 used: close < ema=9999 → BEARISH → BULLISH filter fails → SKIP
    // If confirmed H4 used: close=1.10 > ema=1.08 → BULLISH → passes → BUY
    assert.equal(result, "BUY", "Confirmed H4 bar BULLISH → passes; forming bar excluded; RSI state passes → BUY");
  });

});

// =================================================================
// ─── 5E-11: RSI State Filter Does Not Affect Direction ────────────
// =================================================================

describe("5E-11: RSI State Filter Direction Neutrality", () => {

  test("5E-11: RSI BELOW 60 spec with BEARISH H4/H1 → SKIP; RSI ABOVE 40 spec with BULLISH H4/H1 → SKIP", () => {
    const h1Bull = makeH1Bullish();
    const h4Bull = makeH4Bullish();
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();

    const m5Long  = makeM5LongState(55);  // RSI=55 passes LONG filter
    const m5Short = makeM5ShortState(45); // RSI=45 passes SHORT filter

    // LONG spec applied to BEARISH environment → SKIP (trend filter fails, not RSI)
    const r1 = evaluateStrategy({
      spec:                  make5ELongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5Long.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5Long.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(r1, "SKIP", "LONG spec with RSI=55 in BEARISH environment → SKIP (trend filter fails)");

    // SHORT spec applied to BULLISH environment → SKIP (trend filter fails, not RSI)
    const r2 = evaluateStrategy({
      spec:                  make5EShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5Short.bars, H1: h1Bull.bars, H4: h4Bull.bars },
      indicatorsByTimeframe: { M5: m5Short.inds, H1: h1Bull.inds, H4: h4Bull.inds },
    });
    assert.equal(r2, "SKIP", "SHORT spec with RSI=45 in BULLISH environment → SKIP (trend filter fails)");
  });

});

// =================================================================
// ─── 5E-12: RSI State Only — No Prev Bar Required ────────────────
// =================================================================

describe("5E-12: RSI State Only — Single Bar Sufficient (No Prev Bar)", () => {

  test("5E-12: RSI state filter passes with ONLY confirmed bar (no prev bar) — not timing-dependent", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();

    // Single M5 bar that is just confirmed at EVAL_T:
    //   bar.time + M5_MS <= EVAL_T → bar.time = EVAL_T - M5_MS
    //   barIdx = 0 (only one bar) — no prev bar available
    const barTime = EVAL_T - M5_MS;
    const close   = 1.1002;
    const ema21   = 1.1000;
    const bars    = [makeBar(barTime, close)];
    const ema1    = [ema21] as (number | undefined)[];
    const rsi     = [55] as (number | undefined)[]; // RSI=55 < 60 → passes BELOW 60

    const m5Inds = makeInds(1, { ema1, rsi, params: { ema1Period: 21 } });

    // Phase 5-E BELOW 60 state filter only needs rsi[idx] — no prev bar
    // This contrasts with Phase 5-D CROSS_UP which needs rsi[idx-1] (would return false at barIdx=0)
    let threw = false;
    let result: string = "UNKNOWN";
    try {
      result = evaluateStrategy({
        spec:                  make5ELongSpec(),
        evaluationTime:        EVAL_T,
        barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
        indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "RSI state filter at barIdx=0 must NOT throw");
    // RSI=55 < 60 → BELOW 60 passes → BUY (state filter, no prev bar needed)
    assert.equal(result, "BUY", "RSI=55 < 60 with barIdx=0 → BELOW 60 passes without prev bar → BUY");
  });

  test("5E-12b: Phase 5-D CROSS_UP at barIdx=0 returns SKIP (prev bar missing) — confirms state vs crossover distinction", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();

    // Single bar at barIdx=0, RSI=55 (would pass BELOW 60 but CROSS_UP needs prev bar)
    const barTime = EVAL_T - M5_MS;
    const bars    = [makeBar(barTime, 1.1002)];
    const ema1    = [1.1000] as (number | undefined)[];
    const rsi     = [55] as (number | undefined)[]; // curr=55 >= 50, but no prev bar

    const m5Inds = makeInds(1, { ema1, rsi, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  make5DLongSpec(), // Phase 5-D CROSS_UP
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
    });
    // CROSS_UP at idx=0 → prev doesn't exist → false → SKIP
    assert.equal(result, "SKIP", "Phase 5-D CROSS_UP at barIdx=0 → no prev bar → SKIP (confirms state vs crossover)");
  });

});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 5-E Tests: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) {
  console.log("All tests PASSED");
} else {
  console.log("Some tests FAILED");
  process.exit(1);
}

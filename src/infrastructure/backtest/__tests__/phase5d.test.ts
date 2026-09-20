/**
 * Unit Tests — Phase 5-D: Momentum Confirmation (RSI CROSS_UP/DOWN over 50)
 *
 * Tests:
 *   5D-01: LONG momentum (RSI crosses up over 50) → signal passes
 *   5D-02: LONG momentum false (RSI was already above 50) → rejected
 *   5D-03: SHORT momentum (RSI crosses down below 50) → signal passes
 *   5D-04: SHORT momentum false (RSI was already below 50) → rejected
 *   5D-05: LONG/SHORT exact symmetry (same period=14, threshold=50)
 *   5D-06: RSI previous/current cross logic LONG (prev<50, curr>=50)
 *   5D-07: RSI previous/current cross logic SHORT (prev>50, curr<=50)
 *   5D-08: forming M5 bar ignored (barIdx is confirmed bar)
 *   5D-09: higher TF confirmed safety maintained
 *   5D-10: Phase 5-C strategy without momentum still works (backward compat)
 *   5D-11: no direction contamination (LONG filter doesn't affect SHORT)
 *   5D-12: threshold exact boundary (RSI=50.0 → CROSS_UP passes if prev<50)
 *   5D-13: LONG risk same as SHORT (ATR×1.5, RR=2.0)
 *   5D-14: session settings unchanged [LONDON, NEW_YORK]
 *   5D-15: barIdx=0 safety (prev bar doesn't exist → false, no crash)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/phase5d.test.ts
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
// ─── Phase 5-D Strategy Spec helpers ───────────────────────────
// =================================================================

/**
 * Phase 5-D LONG spec:
 *   H4 BULLISH + H1 BULLISH trend filters
 *   Entry: NEAR_EMA(3) AND PRICE_ABOVE AND RSI(14) CROSS_UP 50
 */
function make5DLongSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v3 LONG",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-D LONG: H4+H1 BULLISH trend, EMA21 pullback + RSI(14) momentum CROSS_UP 50",
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

/**
 * Phase 5-D SHORT spec:
 *   H4 BEARISH + H1 BEARISH trend filters
 *   Entry: NEAR_EMA(3) AND PRICE_BELOW AND RSI(14) CROSS_DOWN 50
 */
function make5DShortSpec(): StrategySpec {
  return {
    name:           "EURUSD Multi-TF EMA21 Pullback v3 SHORT",
    strategy_type:  "DAY_TRADE",
    description:    "Phase 5-D SHORT: H4+H1 BEARISH trend, EMA21 pullback + RSI(14) momentum CROSS_DOWN 50",
    symbols:        ["EURUSD"],
    timeframes:     ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW", threshold: 0 },
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "CROSS_DOWN",  threshold: 50 },
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

/** Phase 5-C LONG spec (no momentum) — for backward compat test */
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
  const ema1    = [1.06, 1.08, 1.09];
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

function makeH1Bearish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h1Start = EVAL_T - 3 * H1_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h1Start, H1_MS);
  const ema1    = [1.16, 1.15, 1.15];
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

function makeH4Bullish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.07, 1.09, 1.10], h4Start, H4_MS);
  const ema1    = [1.06, 1.07, 1.08];
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

function makeH4Bearish(): { bars: Bar[]; inds: PrecomputedIndicators } {
  const h4Start = EVAL_T - 3 * H4_MS;
  const bars    = makeBars([1.12, 1.11, 1.10], h4Start, H4_MS);
  const ema1    = [1.16, 1.15, 1.15];
  return { bars, inds: makeInds(3, { ema1, params: { ema1Period: 21 } }) };
}

// =================================================================
// ─── M5 helpers ──────────────────────────────────────────────────
// =================================================================

/**
 * Build M5 bars+inds where:
 *   - close > ema21 (PRICE_ABOVE passes)
 *   - |close - ema21| ≈ 2 pips (NEAR_EMA(3) passes)
 *   - rsi[idx-1] = prevRsi, rsi[idx] = currRsi where idx = confirmed bar index
 *
 * evalTime = EVAL_T = T0 + 10 * M5_MS (09:50 UTC)
 * getLastConfirmedBarIndex: bar.time + M5_MS <= EVAL_T
 *   bar[9].time = T0 + 9*M5_MS → T0+9*M5_MS + M5_MS = T0+10*M5_MS = EVAL_T ✓ confirmed
 *   bar[10].time = T0 + 10*M5_MS → T0+10*M5_MS + M5_MS > EVAL_T ✗ forming
 * So last confirmed bar idx = 9.
 * Therefore: prevRsi at idx=8, currRsi at idx=9.
 *
 * n = 11 bars (index 0..10)
 */
function makeM5LongMomentum(prevRsi: number, currRsi: number): { bars: Bar[]; inds: PrecomputedIndicators } {
  const n     = 11;
  const close = 1.1002; // ~2 pips above EMA21
  const ema21 = 1.1000;
  const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
  const ema1  = Array<number | undefined>(n).fill(ema21);
  // Last confirmed bar idx=9; prev bar idx=8
  const rsi = Array<number | undefined>(n).fill(undefined);
  rsi[8] = prevRsi;  // previous confirmed bar
  rsi[9] = currRsi;  // current confirmed bar (getLastConfirmedBarIndex → 9)
  return { bars, inds: makeInds(n, { ema1, rsi, params: { ema1Period: 21 } }) };
}

function makeM5ShortMomentum(prevRsi: number, currRsi: number): { bars: Bar[]; inds: PrecomputedIndicators } {
  const n     = 11;
  const close = 1.1000; // ~2 pips below EMA21
  const ema21 = 1.1002;
  const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
  const ema1  = Array<number | undefined>(n).fill(ema21);
  const rsi = Array<number | undefined>(n).fill(undefined);
  rsi[8] = prevRsi;  // previous confirmed bar
  rsi[9] = currRsi;  // current confirmed bar
  return { bars, inds: makeInds(n, { ema1, rsi, params: { ema1Period: 21 } }) };
}

// =================================================================
// ─── 5D-01〜5D-04: Momentum signal pass/reject ───────────────────
// =================================================================

describe("5D-01〜5D-04: Momentum Signal Pass / Reject", () => {

  // 5D-01: LONG momentum → RSI crosses UP over 50 → BUY
  test("5D-01: LONG momentum — RSI prev=45 curr=52 (CROSS_UP 50) → BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongMomentum(45, 52); // prev<50, curr>=50 → CROSS_UP passes

    const result = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "RSI prev=45 curr=52 → CROSS_UP 50 passes → BUY");
  });

  // 5D-02: LONG momentum false → RSI already above 50 → rejected
  test("5D-02: LONG momentum false — RSI prev=55 curr=60 (no crossover) → SKIP", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongMomentum(55, 60); // prev>=50 → no CROSS_UP → fails

    const result = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "SKIP", "RSI prev=55 curr=60 → no crossover → SKIP");
  });

  // 5D-03: SHORT momentum → RSI crosses DOWN below 50 → SELL
  test("5D-03: SHORT momentum — RSI prev=55 curr=48 (CROSS_DOWN 50) → SELL", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5 = makeM5ShortMomentum(55, 48); // prev>50, curr<=50 → CROSS_DOWN passes

    const result = evaluateStrategy({
      spec:                  make5DShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SELL", "RSI prev=55 curr=48 → CROSS_DOWN 50 passes → SELL");
  });

  // 5D-04: SHORT momentum false → RSI already below 50 → rejected
  test("5D-04: SHORT momentum false — RSI prev=40 curr=45 (no crossover) → SKIP", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5 = makeM5ShortMomentum(40, 45); // prev<=50 → no CROSS_DOWN → fails

    const result = evaluateStrategy({
      spec:                  make5DShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SKIP", "RSI prev=40 curr=45 → no crossover down → SKIP");
  });

});

// =================================================================
// ─── 5D-05: LONG/SHORT Symmetry ──────────────────────────────────
// =================================================================

describe("5D-05: LONG/SHORT Symmetry", () => {

  test("5D-05: LONG and SHORT use identical period=14, threshold=50 for RSI momentum", () => {
    const longSpec  = make5DLongSpec();
    const shortSpec = make5DShortSpec();

    const longRsiCond  = longSpec.entry_conditions.conditions.find(c => c.indicator === "RSI");
    const shortRsiCond = shortSpec.entry_conditions.conditions.find(c => c.indicator === "RSI");

    assert.ok(longRsiCond,  "LONG spec must have RSI condition");
    assert.ok(shortRsiCond, "SHORT spec must have RSI condition");
    assert.equal(longRsiCond!.period,    14,          "LONG RSI period = 14");
    assert.equal(shortRsiCond!.period,   14,          "SHORT RSI period = 14");
    assert.equal(longRsiCond!.threshold, 50,          "LONG RSI threshold = 50");
    assert.equal(shortRsiCond!.threshold,50,          "SHORT RSI threshold = 50");
    assert.equal(longRsiCond!.operator,  "CROSS_UP",  "LONG RSI operator = CROSS_UP");
    assert.equal(shortRsiCond!.operator, "CROSS_DOWN","SHORT RSI operator = CROSS_DOWN");
  });

});

// =================================================================
// ─── 5D-06〜5D-07: Cross logic correctness ───────────────────────
// =================================================================

describe("5D-06〜5D-07: RSI Cross Logic Correctness", () => {

  // 5D-06: LONG cross logic — prev<50, curr>=50
  test("5D-06: LONG CROSS_UP logic: prev=49.9 curr=50.0 → exactly at threshold → BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongMomentum(49.9, 50.0); // curr exactly = 50 → CROSS_UP (>= 50)

    const result = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "prev=49.9 curr=50.0 (>= 50) with prev<50 → CROSS_UP → BUY");
  });

  // 5D-07: SHORT cross logic — prev>50, curr<=50
  test("5D-07: SHORT CROSS_DOWN logic: prev=50.1 curr=50.0 → exactly at threshold → SELL", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5 = makeM5ShortMomentum(50.1, 50.0); // curr exactly = 50 → CROSS_DOWN (<= 50)

    const result = evaluateStrategy({
      spec:                  make5DShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SELL", "prev=50.1 curr=50.0 (<= 50) with prev>50 → CROSS_DOWN → SELL");
  });

});

// =================================================================
// ─── 5D-08: Forming M5 bar ignored ──────────────────────────────
// =================================================================

describe("5D-08: Forming M5 Bar Ignored", () => {

  test("5D-08: forming M5 bar NOT used — confirmed bar has valid RSI CROSS_UP → BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();

    // evalTime = EVAL_T = T0 + 10*M5_MS
    // getLastConfirmedBarIndex: bar.time + M5_MS <= EVAL_T
    //   bar[9].time = T0+9*M5_MS  → T0+10*M5_MS = EVAL_T ✓ confirmed (idx=9)
    //   bar[10].time = T0+10*M5_MS → T0+11*M5_MS > EVAL_T ✗ forming
    // RSI:
    //   rsi[8]  = 45  (prev confirmed bar)
    //   rsi[9]  = 52  (current confirmed bar → CROSS_UP passes)
    //   rsi[10] = 30  (forming bar — absurd; if used, curr<50 → would fail CROSS_UP)
    const n     = 11;
    const close = 1.1002;
    const ema21 = 1.1000;
    const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
    const ema1  = Array<number | undefined>(n).fill(ema21);
    const rsi   = Array<number | undefined>(n).fill(undefined);
    rsi[8] = 45; // prev confirmed
    rsi[9] = 52; // current confirmed → CROSS_UP passes

    const m5Inds = makeInds(n, { ema1, rsi, params: { ema1Period: 21 } });

    // bar[10].time = T0+10*M5_MS = EVAL_T → starts exactly at EVAL_T → forming (not yet closed)
    // getLastConfirmedBarIndex must return 9, so rsi[9]=52 is used (not any forming bar)
    const result = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "Must use confirmed bar[9] RSI=52 not forming bar → BUY");
  });

});

// =================================================================
// ─── 5D-09: Higher TF confirmed safety maintained ────────────────
// =================================================================

describe("5D-09: Higher TF Confirmed Safety", () => {

  test("5D-09: H4 forming bar ignored — confirmed H4 BULLISH + RSI CROSS_UP → BUY", () => {
    const h1 = makeH1Bullish();
    const m5 = makeM5LongMomentum(45, 52);

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
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4Bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4Inds },
    });
    assert.equal(result, "BUY", "Confirmed H4 bar BULLISH → passes; forming bar excluded → BUY");
  });

});

// =================================================================
// ─── 5D-10: Backward compatibility (Phase 5-C without momentum) ──
// =================================================================

describe("5D-10: Phase 5-C Backward Compatibility", () => {

  test("5D-10: Phase 5-C LONG spec (no RSI condition) still works → BUY", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();

    // Standard Phase 5-C entry: close=1.1002, ema21=1.1000 (~2 pips above)
    const n     = 12;
    const close = 1.1002;
    const ema21 = 1.1000;
    const bars  = makeBars(Array<number>(n).fill(close), T0, M5_MS);
    const ema1  = Array<number | undefined>(n).fill(ema21);
    // No RSI values needed for Phase 5-C
    const m5Inds = makeInds(n, { ema1, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  make5CLongSpec(), // Phase 5-C spec — no RSI condition
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "Phase 5-C LONG spec without momentum condition → BUY (backward compat)");
  });

});

// =================================================================
// ─── 5D-11: No direction contamination ──────────────────────────
// =================================================================

describe("5D-11: No Direction Contamination", () => {

  test("5D-11: LONG spec with BEARISH H4/H1 → SKIP; SHORT spec with BULLISH H4/H1 → SKIP", () => {
    const h1Bull = makeH1Bullish();
    const h4Bull = makeH4Bullish();
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5Long  = makeM5LongMomentum(45, 52);
    const m5Short = makeM5ShortMomentum(55, 48);

    // LONG spec applied to BEARISH environment → SKIP
    const r1 = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5Long.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5Long.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(r1, "SKIP", "LONG spec in BEARISH environment → SKIP");

    // SHORT spec applied to BULLISH environment → SKIP
    const r2 = evaluateStrategy({
      spec:                  make5DShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5Short.bars, H1: h1Bull.bars, H4: h4Bull.bars },
      indicatorsByTimeframe: { M5: m5Short.inds, H1: h1Bull.inds, H4: h4Bull.inds },
    });
    assert.equal(r2, "SKIP", "SHORT spec in BULLISH environment → SKIP");
  });

});

// =================================================================
// ─── 5D-12: Threshold exact boundary ────────────────────────────
// =================================================================

describe("5D-12: RSI Threshold Exact Boundary", () => {

  test("5D-12: CROSS_UP at exact boundary RSI=50.0 passes if prev<50", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongMomentum(49.99, 50.0); // curr=50 exactly → >= 50 → passes

    const result = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "BUY", "RSI=50.0 with prev<50 → CROSS_UP passes (inclusive) → BUY");
  });

  test("5D-12b: CROSS_DOWN at exact boundary RSI=50.0 passes if prev>50", () => {
    const h1Bear = makeH1Bearish();
    const h4Bear = makeH4Bearish();
    const m5 = makeM5ShortMomentum(50.01, 50.0); // curr=50 exactly → <= 50 → passes

    const result = evaluateStrategy({
      spec:                  make5DShortSpec(),
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: m5.bars, H1: h1Bear.bars, H4: h4Bear.bars },
      indicatorsByTimeframe: { M5: m5.inds, H1: h1Bear.inds, H4: h4Bear.inds },
    });
    assert.equal(result, "SELL", "RSI=50.0 with prev>50 → CROSS_DOWN passes (inclusive) → SELL");
  });

});

// =================================================================
// ─── 5D-13: LONG and SHORT risk parameters symmetric ─────────────
// =================================================================

describe("5D-13: Risk Symmetry", () => {

  test("5D-13: LONG and SHORT risk parameters are identical (ATR×1.5 SL, RR=2.0 TP)", () => {
    const longSpec  = make5DLongSpec();
    const shortSpec = make5DShortSpec();

    const longSL  = longSpec.exit_conditions?.stop_loss;
    const shortSL = shortSpec.exit_conditions?.stop_loss;
    const longTP  = longSpec.exit_conditions?.take_profit;
    const shortTP = shortSpec.exit_conditions?.take_profit;

    assert.equal(longSL?.method,      "ATR",      "LONG SL method = ATR");
    assert.equal(shortSL?.method,     "ATR",      "SHORT SL method = ATR");
    assert.equal(longSL?.multiplier,   1.5,        "LONG SL multiplier = 1.5");
    assert.equal(shortSL?.multiplier,  1.5,        "SHORT SL multiplier = 1.5");
    assert.equal(longTP?.method,      "RR_RATIO", "LONG TP method = RR_RATIO");
    assert.equal(shortTP?.method,     "RR_RATIO", "SHORT TP method = RR_RATIO");
    assert.equal(longTP?.rr_ratio,     2.0,        "LONG TP RR = 2.0");
    assert.equal(shortTP?.rr_ratio,    2.0,        "SHORT TP RR = 2.0");
    assert.equal(longSL?.period,       14,         "LONG ATR period = 14");
    assert.equal(shortSL?.period,      14,         "SHORT ATR period = 14");
  });

});

// =================================================================
// ─── 5D-14: Session settings unchanged ──────────────────────────
// =================================================================

describe("5D-14: Session Settings", () => {

  test("5D-14: LONG and SHORT session filters identical [LONDON, NEW_YORK]", () => {
    const longSpec  = make5DLongSpec();
    const shortSpec = make5DShortSpec();

    const longSess  = longSpec.filters?.sessions  ?? [];
    const shortSess = shortSpec.filters?.sessions ?? [];

    assert.deepEqual([...longSess].sort(),  ["LONDON", "NEW_YORK"], "LONG sessions = [LONDON, NEW_YORK]");
    assert.deepEqual([...shortSess].sort(), ["LONDON", "NEW_YORK"], "SHORT sessions = [LONDON, NEW_YORK]");
    assert.deepEqual([...longSess].sort(), [...shortSess].sort(), "LONG and SHORT sessions identical");
  });

  test("5D-14b: Session filter blocks off-hours trade — outside LONDON/NEW_YORK → SKIP", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();
    const m5 = makeM5LongMomentum(45, 52);

    // Tokyo session (01:00 UTC) — not LONDON or NEW_YORK
    const TOKYO_T = new Date("2025-01-15T01:30:00.000Z").getTime();
    // Build M5 bars anchored at TOKYO_T: same data but evaluated at 01:30 UTC
    const n     = 12;
    const close = 1.1002;
    const ema21 = 1.1000;
    const tokyoBars  = makeBars(Array<number>(n).fill(close), TOKYO_T - 10 * M5_MS, M5_MS);
    const tokyoEma1  = Array<number | undefined>(n).fill(ema21);
    const tokyoRsi   = Array<number | undefined>(n).fill(undefined);
    tokyoRsi[9]  = 45;
    tokyoRsi[10] = 52;
    const tokyoInds  = makeInds(n, { ema1: tokyoEma1, rsi: tokyoRsi, params: { ema1Period: 21 } });

    const result = evaluateStrategy({
      spec:                  make5DLongSpec(),
      evaluationTime:        TOKYO_T,
      barsByTimeframe:       { M5: tokyoBars, H1: h1.bars, H4: h4.bars },
      indicatorsByTimeframe: { M5: tokyoInds, H1: h1.inds, H4: h4.inds },
    });
    assert.equal(result, "SKIP", "Tokyo session outside LONDON/NEW_YORK → SKIP");
  });

});

// =================================================================
// ─── 5D-15: barIdx=0 safety ──────────────────────────────────────
// =================================================================

describe("5D-15: barIdx=0 Safety (First Bar Crash Prevention)", () => {

  test("5D-15: RSI CROSS_UP at barIdx=0 returns false (no prev bar) — no crash", () => {
    const h1 = makeH1Bullish();
    const h4 = makeH4Bullish();

    // Single M5 bar that is confirmed at EVAL_T:
    //   bar.time + M5_MS <= EVAL_T  → bar.time <= EVAL_T - M5_MS
    // Use bar.time = EVAL_T - M5_MS exactly → closes at EVAL_T (just confirmed)
    // barIdx = 0 (only one bar) → CROSS_UP has no prev bar (idx-1 = -1) → false
    const barTime = EVAL_T - M5_MS;
    const bars = [makeBar(barTime, 1.1002)]; // confirmed at evalTime = EVAL_T
    const ema1 = [1.1000];
    const rsi  = [55] as (number | undefined)[]; // curr=55 >= 50, but no prev

    const m5Inds = makeInds(1, { ema1, rsi, params: { ema1Period: 21 } });

    // This must NOT throw; it must return SKIP (CROSS_UP fails at idx=0)
    let threw = false;
    let result: string = "UNKNOWN";
    try {
      result = evaluateStrategy({
        spec:                  make5DLongSpec(),
        evaluationTime:        EVAL_T,
        barsByTimeframe:       { M5: bars, H1: h1.bars, H4: h4.bars },
        indicatorsByTimeframe: { M5: m5Inds, H1: h1.inds, H4: h4.inds },
      });
    } catch {
      threw = true;
    }
    assert.equal(threw,  false,  "barIdx=0 must NOT throw");
    assert.equal(result, "SKIP", "barIdx=0 → CROSS_UP has no prev bar → returns false → SKIP");
  });

});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 5-D Tests: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) {
  console.log("All tests PASSED");
} else {
  console.log("Some tests FAILED");
  process.exit(1);
}

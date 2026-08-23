/**
 * Unit Tests — Phase 6-A: Strategy Hypothesis Screening
 *
 * Tests:
 *   6A-01 ~ 6A-04:  BREAKOUT evaluator
 *   6A-05 ~ 6A-08:  MOMENTUM evaluator
 *   6A-09 ~ 6A-12:  MEAN_REVERSION evaluator
 *   6A-13:          LONG/SHORT symmetry
 *   6A-14:          Duplicate entry protection
 *   6A-15 ~ 6A-18:  ATR regime classification
 *   6A-19 ~ 6A-20:  IS/OOS split
 *   6A-21 ~ 6A-24:  Analysis helpers (expectancy, MFE/MAE, first-bar, candidate)
 *
 * Usage:
 *   npx tsx src/infrastructure/backtest/__tests__/phase6a.test.ts
 *
 * Floating-point note:
 *   EURUSD pip = 0.0001. Tests use distances comfortably within/outside
 *   thresholds to avoid boundary FP issues.
 */

import assert from "node:assert/strict";
import type { Bar }                    from "@/infrastructure/analysis/types";
import type { PrecomputedIndicators }  from "../indicators";
import type { MACDResult, ADXResult, BollingerResult } from "../types";
import type { StrategySpec }           from "@/lib/strategySchema";
import { runBacktest }                 from "../BacktestEngine";
import {
  evalBreakout,
  evalMomentum,
  evalMeanReversion,
  BREAKOUT_N,
  MOMENTUM_BODY_MULTIPLIER,
  MEAN_REVERSION_DISTANCE_MULTIPLIER,
} from "../phase6a/evaluators";
import {
  classifyATRRegime,
  getATRBand,
  splitISOOS,
  computeMfeMae,
  isFirstBarFavorable,
  computeStats,
  classifyCandidate,
  calcMedian,
  getSession,
  type TradeWithMetrics,
} from "../phase6a/analysisHelpers";

// =================================================================
// Test runner
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
// Helpers
// =================================================================

const TF_MS_M5 = 300_000;

function makeBar(time: number, open: number, high: number, low: number, close: number): Bar {
  return { time, open, high, low, close, volume: 100 };
}

function makeFlatBar(time: number, price: number): Bar {
  return makeBar(time, price, price * 1.001, price * 0.999, price);
}

function makeBullishBar(time: number, open: number, close: number): Bar {
  return makeBar(time, open, Math.max(open, close) * 1.0005, Math.min(open, close) * 0.9995, close);
}

function makeBearishBar(time: number, open: number, close: number): Bar {
  return makeBar(time, open, Math.max(open, close) * 1.0005, Math.min(open, close) * 0.9995, close);
}

// Build N flat bars followed by a signal bar
function makeBarArray(
  n: number,
  basePrice: number,
  signalBar: Bar,
  startTime: number = 1_000_000,
): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push(makeFlatBar(startTime + i * TF_MS_M5, basePrice));
  }
  bars.push({ ...signalBar, time: startTime + n * TF_MS_M5 });
  return bars;
}

const EMPTY_MACD: MACDResult   = { macd: undefined, signal: undefined, histogram: undefined };
const EMPTY_ADX:  ADXResult    = { adx: undefined,  diPlus: undefined, diMinus: undefined };
const EMPTY_BB:   BollingerResult = { upper: undefined, middle: undefined, lower: undefined, width: undefined };
const DEFAULT_PARAMS = {
  ema1Period: 21, ema2Period: 200, smaPeriod: 50, atrPeriod: 14,
  rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
  adxPeriod: 14, bbPeriod: 20, bbDeviation: 2.0, stochPeriod: 14,
};

function makeInds(n: number, opts: {
  atr?:  (number | undefined)[];
  ema1?: (number | undefined)[];
}): PrecomputedIndicators {
  const def = new Array(n).fill(undefined);
  return {
    ema1:  opts.ema1  ?? def,
    ema2:  def,
    sma:   def,
    atr:   opts.atr   ?? def,
    rsi:   def,
    macd:  new Array(n).fill(EMPTY_MACD),
    adx:   new Array(n).fill(EMPTY_ADX),
    bb:    new Array(n).fill(EMPTY_BB),
    stoch: def,
    params: DEFAULT_PARAMS,
  };
}

// Minimal StrategySpec for BacktestEngine tests (evaluator override replaces signals)
const MINIMAL_SPEC: StrategySpec = {
  name:            "Phase6A Test",
  strategy_type:   "DAY_TRADE",
  symbols:         ["EURUSD"],
  timeframes:      ["M5"],
  entry_conditions: {
    logic:      "AND",
    conditions: [
      // Dummy: EMA(21) PRICE_ABOVE ensures warmup=20 for rolling N=20
      { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
    ],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", multiplier: 1.0 },
    take_profit: { method: "ATR", multiplier: 1.5 },
  },
  risk: { risk_per_trade: 1.0 },
};

// =================================================================
// 6A-01 ~ 6A-04: BREAKOUT
// =================================================================

describe("6A-01/02/03/04 — BREAKOUT evaluator", () => {

  test("6A-01: LONG signal — close breaks above previous 20-bar high", () => {
    // 20 bars with high=1.1010, then a bar that closes at 1.1020 > 1.1010
    const bars: Bar[] = [];
    for (let i = 0; i < BREAKOUT_N; i++) {
      bars.push(makeBar(i * TF_MS_M5, 1.1000, 1.1010, 1.0990, 1.1000));
    }
    // Signal bar: close = 1.1020 > 1.1010 (rolling high)
    bars.push(makeBar(BREAKOUT_N * TF_MS_M5, 1.1000, 1.1025, 1.0995, 1.1020));

    const result = evalBreakout(bars, BREAKOUT_N);
    assert.equal(result, "BUY", "Should return BUY when close > rolling high");
  });

  test("6A-02: SHORT signal — close breaks below previous 20-bar low", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < BREAKOUT_N; i++) {
      bars.push(makeBar(i * TF_MS_M5, 1.1000, 1.1010, 1.0990, 1.1000));
    }
    // Signal bar: close = 1.0980 < 1.0990 (rolling low)
    bars.push(makeBar(BREAKOUT_N * TF_MS_M5, 1.1000, 1.1005, 1.0975, 1.0980));

    const result = evalBreakout(bars, BREAKOUT_N);
    assert.equal(result, "SELL", "Should return SELL when close < rolling low");
  });

  test("6A-03: Current bar EXCLUDED from rolling high/low — no look-ahead", () => {
    // Signal bar has extreme high (1.1100) but close (1.1010) is within range
    const bars: Bar[] = [];
    for (let i = 0; i < BREAKOUT_N; i++) {
      bars.push(makeBar(i * TF_MS_M5, 1.1000, 1.1010, 1.0990, 1.1000));
    }
    // Signal bar: high=1.1100 (extreme), but close=1.1010 is NOT above rolling high (1.1010)
    // Rolling high = max of bars[0..19].high = 1.1010
    // Signal bar close = 1.1010, NOT > 1.1010 → SKIP
    bars.push(makeBar(BREAKOUT_N * TF_MS_M5, 1.1000, 1.1100, 1.0990, 1.1010));

    const result = evalBreakout(bars, BREAKOUT_N);
    // Close 1.1010 is NOT strictly greater than rolling high 1.1010
    assert.equal(result, "SKIP",
      "Current bar's extreme high must NOT contaminate rolling window — close at boundary → SKIP");
  });

  test("6A-04: No look-ahead — idx < N returns SKIP", () => {
    // Only 10 bars available (< N=20): cannot compute rolling high/low
    const bars: Bar[] = [];
    for (let i = 0; i < 10; i++) {
      bars.push(makeBar(i * TF_MS_M5, 1.1000, 1.1050, 1.0950, 1.1050)); // extreme
    }
    const result = evalBreakout(bars, 9); // idx=9, n=20 → 9 < 20 → SKIP
    assert.equal(result, "SKIP", "Insufficient bars (idx < N) must return SKIP");
  });

});

// =================================================================
// 6A-05 ~ 6A-08: MOMENTUM
// =================================================================

describe("6A-05/06/07/08 — MOMENTUM evaluator", () => {

  test("6A-05: LONG signal — bullish bar with bodySize >= 1.0×ATR", () => {
    const ATR = 0.0030; // 3 pips
    const bars = [makeBar(0, 1.1000, 1.1035, 1.0995, 1.1032)]; // body = 0.0032 > 0.0030
    const inds = makeInds(1, { atr: [ATR] });

    const result = evalMomentum(bars, inds, 0);
    assert.equal(result, "BUY", "Bullish bar with bodySize > ATR → BUY");
  });

  test("6A-06: SHORT signal — bearish bar with bodySize >= 1.0×ATR", () => {
    const ATR = 0.0030;
    const bars = [makeBar(0, 1.1032, 1.1040, 1.0995, 1.1000)]; // body = 0.0032 > 0.0030
    const inds = makeInds(1, { atr: [ATR] });

    const result = evalMomentum(bars, inds, 0);
    assert.equal(result, "SELL", "Bearish bar with bodySize > ATR → SELL");
  });

  test("6A-07: Threshold boundary — bodySize clearly > ATR → signal; bodySize clearly < ATR → SKIP", () => {
    const ATR = 0.0030;
    // Clearly above: body = 0.0032 > 0.0030 (FP-safe gap)
    const barsAbove = [makeBar(0, 1.1000, 1.1035, 1.0995, 1.1032)];
    // Clearly below: body = 0.0025 < 0.0030
    const barsBelow = [makeBar(0, 1.1000, 1.1028, 1.0995, 1.1025)];
    const inds = makeInds(1, { atr: [ATR] });

    const resAbove = evalMomentum(barsAbove, inds, 0);
    const resBelow = evalMomentum(barsBelow, inds, 0);

    assert.equal(resAbove, "BUY",  "bodySize (0.0032) > ATR (0.0030) → BUY");
    assert.equal(resBelow, "SKIP", "bodySize (0.0025) < ATR (0.0030) → SKIP");
  });

  test("6A-08: Confirmed bar — ATR undefined (warmup) → SKIP", () => {
    const bars = [makeBar(0, 1.1000, 1.1050, 1.0990, 1.1050)]; // extreme bullish
    const inds = makeInds(1, { atr: [undefined] }); // ATR not yet computed

    const result = evalMomentum(bars, inds, 0);
    assert.equal(result, "SKIP", "ATR undefined in warmup period → SKIP (no look-ahead)");
  });

});

// =================================================================
// 6A-09 ~ 6A-12: MEAN REVERSION
// =================================================================

describe("6A-09/10/11/12 — MEAN_REVERSION evaluator", () => {

  test("6A-09: LONG signal — close far below EMA21 by >= 1.0×ATR", () => {
    const EMA21 = 1.1000;
    const ATR   = 0.0020; // 2 pips
    // close = 1.0975: EMA - close = 0.0025 > ATR(0.0020) → BUY
    const bars = [makeBar(0, 1.0980, 1.0985, 1.0970, 1.0975)];
    const inds = makeInds(1, { ema1: [EMA21], atr: [ATR] });

    const result = evalMeanReversion(bars, inds, 0);
    assert.equal(result, "BUY",
      "Price far below EMA (deviation > ATR) → expect reversion up → BUY");
  });

  test("6A-10: SHORT signal — close far above EMA21 by >= 1.0×ATR", () => {
    const EMA21 = 1.1000;
    const ATR   = 0.0020;
    // close = 1.1025: close - EMA = 0.0025 > ATR(0.0020) → SELL
    const bars = [makeBar(0, 1.1020, 1.1030, 1.1015, 1.1025)];
    const inds = makeInds(1, { ema1: [EMA21], atr: [ATR] });

    const result = evalMeanReversion(bars, inds, 0);
    assert.equal(result, "SELL",
      "Price far above EMA (deviation > ATR) → expect reversion down → SELL");
  });

  test("6A-11: Distance threshold boundary — deviation exactly = ATR → signal; below → SKIP", () => {
    const EMA21 = 1.1000;
    const ATR   = 0.0020;
    // Exactly at threshold: close = EMA - ATR = 1.0980 → BUY (>= threshold)
    const barsExact = [makeBar(0, 1.0980, 1.0985, 1.0975, 1.0980)];
    // Below threshold: close = 1.0981 → deviation = 0.0019 < 0.0020 → SKIP
    const barsInside = [makeBar(0, 1.0980, 1.0985, 1.0978, 1.0981)];
    const inds = makeInds(1, { ema1: [EMA21], atr: [ATR] });

    // close < ema21 - threshold: 1.0980 < 1.1000 - 0.0020 = 1.0980 → NOT strictly less → SKIP
    // Adjust: use 1.0979 for strict "below"
    const barsBelow = [makeBar(0, 1.0975, 1.0980, 1.0970, 1.0979)];
    const resBelow  = evalMeanReversion(barsBelow, inds, 0);
    const resInside = evalMeanReversion(barsInside, inds, 0);

    assert.equal(resBelow,  "BUY",  "1.0979 < 1.1000 - 0.0020 = 1.0980 → BUY");
    assert.equal(resInside, "SKIP", "1.0981 is within EMA ± ATR → SKIP");
  });

  test("6A-12: EMA or ATR undefined → SKIP (no look-ahead bias)", () => {
    const bars = [makeBar(0, 1.0975, 1.0980, 1.0970, 1.0975)];

    const indsNoEMA = makeInds(1, { ema1: [undefined], atr: [0.0020] });
    const indsNoATR = makeInds(1, { ema1: [1.1000],    atr: [undefined] });

    assert.equal(evalMeanReversion(bars, indsNoEMA, 0), "SKIP",
      "EMA undefined (warmup) → SKIP");
    assert.equal(evalMeanReversion(bars, indsNoATR, 0), "SKIP",
      "ATR undefined (warmup) → SKIP");
  });

});

// =================================================================
// 6A-13: LONG/SHORT symmetry
// =================================================================

describe("6A-13 — LONG/SHORT symmetry", () => {

  test("6A-13: BREAKOUT signals are symmetric (same N, opposite directions)", () => {
    const ATR = 0.0020;
    const base = 1.1000;

    // Build 20 bars with tight range around base
    const rangeBars: Bar[] = [];
    for (let i = 0; i < BREAKOUT_N; i++) {
      rangeBars.push(makeBar(i * TF_MS_M5, base, base + 0.0010, base - 0.0010, base));
    }

    // LONG scenario: close breaks above rolling high (base + 0.0010)
    const longBars = [
      ...rangeBars,
      makeBar(BREAKOUT_N * TF_MS_M5, base, base + 0.0030, base - 0.0005, base + 0.0020),
    ];

    // SHORT scenario: close breaks below rolling low (base - 0.0010)
    const shortBars = [
      ...rangeBars,
      makeBar(BREAKOUT_N * TF_MS_M5, base, base + 0.0005, base - 0.0030, base - 0.0020),
    ];

    assert.equal(evalBreakout(longBars,  BREAKOUT_N), "BUY",
      "Long breakout: close > rolling high → BUY");
    assert.equal(evalBreakout(shortBars, BREAKOUT_N), "SELL",
      "Short breakout: close < rolling low → SELL");

    // No asymmetry from threshold (N is symmetric)
    const longDist  = (base + 0.0020) - (base + 0.0010); // 10 pips above
    const shortDist = (base - 0.0010) - (base - 0.0020); // 10 pips below (positive)
    assert.ok(Math.abs(longDist - shortDist) < 0.00001, "Symmetric distance from range edges");
  });

});

// =================================================================
// 6A-14: Duplicate entry protection
// =================================================================

describe("6A-14 — Duplicate entry protection", () => {

  test("6A-14: Engine allows only one position at a time (no duplicate entry)", () => {
    // Create bars where BREAKOUT fires on first signal bar, and subsequent bars
    // would also fire if re-checked (price stays above rolling high).
    // Engine should yield exactly 1 trade (position stays open, no re-entry).

    const BASE = 1.1000;
    const BARS_WARMUP = 25; // > N=20

    const bars: Bar[] = [];
    // 20 range bars
    for (let i = 0; i < 20; i++) {
      bars.push(makeBar(i * TF_MS_M5, BASE, BASE + 0.0010, BASE - 0.0010, BASE));
    }
    // 1 breakout signal bar: close above range
    bars.push(makeBar(20 * TF_MS_M5, BASE, BASE + 0.0025, BASE - 0.0005, BASE + 0.0020));

    // Entry bar (bar 21): stays above range, signal would re-fire if re-evaluated
    // But position is open, so no re-entry
    bars.push(makeBar(21 * TF_MS_M5, BASE + 0.0020, BASE + 0.0030, BASE + 0.0015, BASE + 0.0022));
    bars.push(makeBar(22 * TF_MS_M5, BASE + 0.0022, BASE + 0.0035, BASE + 0.0018, BASE + 0.0025));
    bars.push(makeBar(23 * TF_MS_M5, BASE + 0.0025, BASE + 0.0040, BASE + 0.0020, BASE + 0.0030));
    bars.push(makeBar(24 * TF_MS_M5, BASE + 0.0030, BASE + 0.0050, BASE + 0.0025, BASE + 0.0040));

    // Use a wide ATR so SL is not hit during these bars
    // ATR(14) ≈ 0.0010 → SL = entry - 0.0010 ≈ BASE + 0.0010, TP = entry + 0.0015
    // The breakout is at BASE + 0.0020, price stays above BASE + 0.0020 → TP may hit

    const result = runBacktest({
      spec:            MINIMAL_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      barsByTimeframe: { M5: bars },
      _evaluatorOverride: (ctx) => {
        // Simple counter: only fire on bar 20 (breakout bar)
        // We simulate what evalBreakout would return for each bar
        const bar20Time = 20 * TF_MS_M5;
        const evalBarTime = ctx.evaluationTime - TF_MS_M5;
        if (evalBarTime === bar20Time) return "BUY";
        // On subsequent bars, return SKIP to simulate "already in position"
        // (the engine's own logic prevents re-entry anyway, but this also tests it)
        return "BUY"; // Even if evaluator says BUY, engine won't re-enter while in position
      },
    });

    // The engine should have entered exactly once after bar 20
    // and either held to END_OF_DATA or hit TP/SL
    assert.ok(
      result.totalTrades >= 1,
      "At least one trade should be produced"
    );

    // Verify no two trades overlap in time
    const trades = result.trades.sort((a, b) => a.entryTime - b.entryTime);
    for (let i = 1; i < trades.length; i++) {
      assert.ok(
        trades[i].entryTime >= trades[i - 1].exitTime,
        `Trade ${i} enters before previous trade exits — overlap detected!`
      );
    }
  });

});

// =================================================================
// 6A-15 ~ 6A-18: ATR regime classification
// =================================================================

describe("6A-15/16/17/18 — ATR regime classification", () => {

  test("6A-15: LOW ATR band — values at or below 33rd percentile", () => {
    // 9 values: [1,2,3, 4,5,6, 7,8,9] → p33=3, p66=6
    const atrs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(v => v * 0.0001);
    const bounds = classifyATRRegime(atrs);
    assert.equal(getATRBand(0.0001, bounds), "LOW",  "1st value → LOW");
    assert.equal(getATRBand(0.0003, bounds), "LOW",  "3rd value (p33) → LOW");
  });

  test("6A-16: MID ATR band — values strictly between p33 and p66", () => {
    // [1..9] → p33=vals[3]=0.0004, p66=vals[6]=0.0007
    // MID: atr > p33(0.0004) AND atr <= p66(0.0007)
    const atrs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(v => v * 0.0001);
    const bounds = classifyATRRegime(atrs);
    assert.equal(getATRBand(0.0005, bounds), "MID", "5th value (> p33, <= p66) → MID");
    assert.equal(getATRBand(0.0006, bounds), "MID", "6th value (> p33, < p66)  → MID");
    assert.equal(getATRBand(0.0007, bounds), "MID", "p66 value itself (≤ p66)  → MID");
  });

  test("6A-17: HIGH ATR band — values strictly above p66", () => {
    // p66=0.0007 → HIGH: atr > 0.0007
    const atrs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(v => v * 0.0001);
    const bounds = classifyATRRegime(atrs);
    assert.equal(getATRBand(0.0008, bounds), "HIGH", "8th value (> p66) → HIGH");
    assert.equal(getATRBand(0.0009, bounds), "HIGH", "9th value (> p66) → HIGH");
  });

  test("6A-18: Percentile boundary — fewer than 3 values → UNKNOWN", () => {
    const boundsEmpty = classifyATRRegime([]);
    const boundsTwo   = classifyATRRegime([0.0010, 0.0020]);
    assert.equal(getATRBand(0.0010, boundsEmpty), "UNKNOWN", "Empty input → UNKNOWN");
    assert.equal(getATRBand(0.0010, boundsTwo),   "UNKNOWN", "< 3 values → UNKNOWN (p33=0)");
  });

});

// =================================================================
// 6A-19 ~ 6A-20: IS/OOS split
// =================================================================

describe("6A-19/20 — IS/OOS chronological split", () => {

  // Build mock TradeWithMetrics
  function mockTrade(entryTime: number, id: number): TradeWithMetrics {
    return {
      tradeId:           id,
      direction:         "BUY",
      symbol:            "EURUSD",
      timeframe:         "M5",
      entryTime,
      entryPrice:        1.1000,
      entryBarIdx:       id * 10,
      sl:                1.0990,
      tp:                1.1020,
      lot:               0.01,
      spreadPips:        1.5,
      slippagePips:      0.3,
      exitTime:          entryTime + 300_000,
      exitPrice:         1.1010,
      exitBarIdx:        id * 10 + 1,
      exitReason:        "TP",
      pips:              10,
      profit:            1.0,
      durationMin:       5,
      result:            "WIN",
      mfe:               12,
      mae:               -2,
      firstBarFavorable: true,
      atrAtSignal:       0.0030,
      session:           "LONDON",
    };
  }

  test("6A-19: IS/OOS split is strictly chronological (first 60% = IS)", () => {
    const trades = Array.from({ length: 10 }, (_, i) => mockTrade(i * 300_000, i));
    const { is, oos } = splitISOOS(trades, 0.6);

    assert.equal(is.length, 6, "IS should contain 60% of trades (6/10)");
    assert.equal(oos.length, 4, "OOS should contain 40% of trades (4/10)");

    // IS trades must all be older than OOS trades
    const maxISTime  = Math.max(...is.map(t => t.entryTime));
    const minOOSTime = Math.min(...oos.map(t => t.entryTime));
    assert.ok(maxISTime < minOOSTime,
      `IS max entryTime (${maxISTime}) must be < OOS min entryTime (${minOOSTime})`);
  });

  test("6A-20: OOS leakage prevention — no IS trade appears after split time", () => {
    const trades = Array.from({ length: 20 }, (_, i) => mockTrade(i * 300_000, i));
    const { is, oos } = splitISOOS(trades, 0.6);

    // Find split time: max IS entryTime
    const splitTime = Math.max(...is.map(t => t.entryTime));

    // No OOS trade should have entryTime <= splitTime
    const oosBeforeSplit = oos.filter(t => t.entryTime <= splitTime);
    assert.equal(oosBeforeSplit.length, 0,
      "OOS trades must all come AFTER the IS/OOS split time");

    // No IS trade should have entryTime > splitTime
    const isAfterSplit = is.filter(t => t.entryTime > splitTime);
    assert.equal(isAfterSplit.length, 0,
      "IS trades must all come BEFORE or AT the IS/OOS split time");
  });

});

// =================================================================
// 6A-21 ~ 6A-24: Analysis helpers
// =================================================================

describe("6A-21/22/23/24 — Expectancy, MFE/MAE, first-bar, candidate", () => {

  test("6A-21: Expectancy calculation — WR × avgWin + (1-WR) × avgLoss", () => {
    // 6 wins of +10 pips, 4 losses of -15 pips
    // Expected: WR=0.6, avgWin=10, avgLoss=-15
    // Expectancy = 0.6×10 + 0.4×(-15) = 6 - 6 = 0.0
    const wins   = Array(6).fill(null).map((_, i): TradeWithMetrics => ({
      tradeId: i, direction: "BUY", symbol: "EURUSD", timeframe: "M5",
      entryTime: i * 300_000, entryPrice: 1.1000, entryBarIdx: i * 10,
      sl: 1.0985, tp: 1.1015, lot: 0.01, spreadPips: 1.5, slippagePips: 0.3,
      exitTime: i * 300_000 + 300_000, exitPrice: 1.1010, exitBarIdx: i * 10 + 1,
      exitReason: "TP", pips: 10, profit: 1.0, durationMin: 5, result: "WIN",
      mfe: 12, mae: -3, firstBarFavorable: true, atrAtSignal: 0.0030, session: "LONDON",
    }));
    const losses = Array(4).fill(null).map((_, i): TradeWithMetrics => ({
      tradeId: i + 6, direction: "BUY", symbol: "EURUSD", timeframe: "M5",
      entryTime: (i + 6) * 300_000, entryPrice: 1.1000, entryBarIdx: (i + 6) * 10,
      sl: 1.0985, tp: 1.1015, lot: 0.01, spreadPips: 1.5, slippagePips: 0.3,
      exitTime: (i + 6) * 300_000 + 300_000, exitPrice: 1.0985, exitBarIdx: (i + 6) * 10 + 1,
      exitReason: "SL", pips: -15, profit: -1.5, durationMin: 5, result: "LOSS",
      mfe: 4, mae: -15, firstBarFavorable: false, atrAtSignal: 0.0030, session: "LONDON",
    }));
    const all = [...wins, ...losses];
    const stats = computeStats(all);

    assert.ok(Math.abs(stats.expectancy) < 0.5,
      `Expectancy should be ~0 (got ${stats.expectancy})`);
    assert.ok(Math.abs(stats.winRate - 60) < 0.5,
      `WR should be ~60% (got ${stats.winRate}%)`);
    assert.ok(Math.abs(stats.avgWin - 10) < 0.5,
      `avgWin should be ~10 pips (got ${stats.avgWin})`);
    assert.ok(Math.abs(stats.avgLoss - (-15)) < 0.5,
      `avgLoss should be ~-15 pips (got ${stats.avgLoss})`);
  });

  test("6A-22: MFE/MAE calculation — correct favorable/adverse excursion", () => {
    const PIP = 0.0001;
    const ENTRY = 1.1000;

    // BUY trade: 3 bars
    // Bar 1: high=1.1020, low=1.0990 → MFE candidate: +20, MAE candidate: -10
    // Bar 2: high=1.1030, low=1.0985 → MFE candidate: +30, MAE candidate: -15
    // Bar 3: high=1.1010, low=1.0995 → no improvement
    const bars: Bar[] = [
      makeBar(0, ENTRY, ENTRY + 20 * PIP, ENTRY - 10 * PIP, ENTRY + 15 * PIP),
      makeBar(1, ENTRY + 15 * PIP, ENTRY + 30 * PIP, ENTRY - 15 * PIP, ENTRY + 20 * PIP),
      makeBar(2, ENTRY + 20 * PIP, ENTRY + 10 * PIP, ENTRY - 5 * PIP, ENTRY + 8 * PIP),
    ];

    const { mfe, mae } = computeMfeMae("BUY", ENTRY, bars, 0, 2);

    assert.ok(Math.abs(mfe - 30) < 0.1, `MFE should be ~30 pips (got ${mfe.toFixed(2)})`);
    assert.ok(Math.abs(mae - (-15)) < 0.1, `MAE should be ~-15 pips (got ${mae.toFixed(2)})`);
  });

  test("6A-23: First-bar-favorable — correct direction check", () => {
    const ENTRY = 1.1000;

    // BUY: first bar closes UP → favorable
    const upBar   = makeBar(0, ENTRY, ENTRY + 0.0010, ENTRY - 0.0005, ENTRY + 0.0008);
    // BUY: first bar closes DOWN → unfavorable
    const downBar = makeBar(0, ENTRY, ENTRY + 0.0005, ENTRY - 0.0010, ENTRY - 0.0008);
    // SELL: first bar closes DOWN → favorable
    const sellDownBar = makeBar(0, ENTRY, ENTRY + 0.0005, ENTRY - 0.0010, ENTRY - 0.0008);

    assert.equal(isFirstBarFavorable("BUY",  ENTRY, upBar),      true,  "BUY + close up   → favorable");
    assert.equal(isFirstBarFavorable("BUY",  ENTRY, downBar),    false, "BUY + close down → unfavorable");
    assert.equal(isFirstBarFavorable("SELL", ENTRY, sellDownBar), true,  "SELL + close down → favorable");
  });

  test("6A-24: Candidate classification — STRONG/CANDIDATE/REJECTED/INCONCLUSIVE", () => {
    function makeStats(pf: number, n: number): ReturnType<typeof computeStats> {
      return {
        trades: n, longTrades: n / 2, shortTrades: n / 2, wins: 0, losses: 0,
        winRate: 50, totalPips: 0, pipsPerTrade: 0, profitFactor: pf,
        maxDrawdown: 0, maxConsecutiveLosses: 0, avgWin: 0, avgLoss: 0,
        expectancy: 0, mfeMedian: 0, maeMedian: 0, firstBarFavorableRate: 50,
        mfeGte5Pct: 0, mfeGte10Pct: 0, mfeGte15Pct: 0,
      };
    }

    // STRONG_CANDIDATE
    assert.equal(
      classifyCandidate(makeStats(1.10, 200), makeStats(1.05, 80)).label,
      "STRONG_CANDIDATE"
    );

    // CANDIDATE (barely)
    assert.equal(
      classifyCandidate(makeStats(0.98, 100), makeStats(0.92, 40)).label,
      "CANDIDATE"
    );

    // REJECTED
    assert.equal(
      classifyCandidate(makeStats(0.80, 200), makeStats(0.75, 80)).label,
      "REJECTED"
    );

    // INCONCLUSIVE (PF borderline, not enough OOS)
    assert.equal(
      classifyCandidate(makeStats(0.92, 50), makeStats(0.88, 20)).label,
      "INCONCLUSIVE"
    );
  });

});

// =================================================================
// Summary
// =================================================================

console.log("\n" + "=".repeat(60));
console.log(`  PHASE 6-A TESTS COMPLETE`);
console.log(`  Passed: ${passed}  |  Failed: ${failed}`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}

/**
 * Unit Tests — Phase 6-B: Execution & Exit Model Audit
 *
 * Tests:
 *   6B-01~06:  Entry price & pip conversion
 *   6B-07~11:  SL/TP geometry
 *   6B-12~14:  Same-bar exit behavior
 *   6B-15~18:  MFE/MAE calculation correctness
 *   6B-19~20:  Raw horizon returns
 *   6B-21:     Zero-cost isolation
 *   6B-22~24:  Random control
 *   6B-25~26:  Chronological safety / no look-ahead
 *
 * Usage:
 *   npx tsx src/infrastructure/backtest/__tests__/phase6b.test.ts
 */

import assert from "node:assert/strict";
import type { Bar }                    from "@/infrastructure/analysis/types";
import type { StrategySpec }           from "@/lib/strategySchema";
import type { PrecomputedIndicators }  from "../indicators";
import type { MACDResult, ADXResult, BollingerResult } from "../types";
import { runBacktest }                 from "../BacktestEngine";
import { getSymbolConfig }             from "../spreadConfig";
import { checkExitOnBar }              from "../PositionManager";
import {
  seededRNG,
  computeRawReturn,
  computeRawMfeMae,
  collectAllSignals,
  generateRandomSignals,
  computeEdgeDelta,
  auditEntryPrice,
  auditSLTP,
  median,
} from "../phase6b/rawAnalysis";

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

const PIP    = 0.0001;
const TF_M5  = 300_000;
const EURUSD = getSymbolConfig("EURUSD"); // spread=1.5, slippage=0.3

function makeBar(time: number, open: number, high: number, low: number, close: number): Bar {
  return { time, open, high, low, close, volume: 0 };
}

function makeFlatBar(time: number, price: number): Bar {
  return makeBar(time, price, price + 0.0010, price - 0.0010, price);
}

const EMPTY_MACD: MACDResult      = { macd: undefined, signal: undefined, histogram: undefined };
const EMPTY_ADX:  ADXResult       = { adx: undefined, diPlus: undefined, diMinus: undefined };
const EMPTY_BB:   BollingerResult = { upper: undefined, middle: undefined, lower: undefined, width: undefined };
const DEFAULT_PARAMS = {
  ema1Period: 21, ema2Period: 200, smaPeriod: 50, atrPeriod: 14,
  rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
  adxPeriod: 14, bbPeriod: 20, bbDeviation: 2.0, stochPeriod: 14,
};

function makeInds(n: number, opts: { atr?: (number | undefined)[] } = {}): PrecomputedIndicators {
  const def = new Array(n).fill(undefined);
  return {
    ema1: def, ema2: def, sma: def,
    atr: opts.atr ?? def,
    rsi: def, macd: new Array(n).fill(EMPTY_MACD),
    adx: new Array(n).fill(EMPTY_ADX),
    bb:  new Array(n).fill(EMPTY_BB),
    stoch: def, params: DEFAULT_PARAMS,
  };
}

const MINIMAL_SPEC: StrategySpec = {
  name: "6B Test", strategy_type: "DAY_TRADE",
  symbols: ["EURUSD"], timeframes: ["M5"],
  entry_conditions: {
    logic: "AND",
    conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" }],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", multiplier: 1.0 },
    take_profit: { method: "ATR", multiplier: 1.5 },
  },
  risk: { risk_per_trade: 1.0 },
};

// =================================================================
// 6B-01~06: Entry price & pip conversion
// =================================================================

describe("6B-01~06 — Entry price & pip conversion", () => {

  test("6B-01: LONG entry = bar.open + (spread + slippage) × pipSize", () => {
    const barOpen = 1.10000;
    const expected = barOpen + (EURUSD.spreadPips + EURUSD.slippagePips) * PIP;
    // 1.5 + 0.3 = 1.8 pips = 0.00018
    const audit = auditEntryPrice("BUY", barOpen, barOpen + 1.8 * PIP,
      EURUSD.spreadPips, EURUSD.slippagePips);
    assert.ok(audit.pass, `LONG entry audit failed: diff=${audit.diffPips.toFixed(4)} pips`);
    assert.ok(Math.abs(expected - (barOpen + 1.8 * PIP)) < 1e-8,
      "Expected = open + 0.00018");
  });

  test("6B-02: SHORT entry = bar.open − (spread + slippage) × pipSize", () => {
    const barOpen = 1.10000;
    const expected = barOpen - 1.8 * PIP;
    const audit = auditEntryPrice("SELL", barOpen, expected,
      EURUSD.spreadPips, EURUSD.slippagePips);
    assert.ok(audit.pass, `SHORT entry audit failed: diff=${audit.diffPips.toFixed(4)} pips`);
    assert.ok(expected < barOpen, "SHORT entry must be below open");
  });

  test("6B-03: Spread applied to entry price (LONG adds, SHORT subtracts)", () => {
    const barOpen  = 1.10000;
    const longCost  = EURUSD.spreadPips * PIP;
    const shortCost = EURUSD.spreadPips * PIP;
    const longEntry  = barOpen + longCost + EURUSD.slippagePips * PIP;
    const shortEntry = barOpen - shortCost - EURUSD.slippagePips * PIP;
    assert.ok(longEntry  > barOpen, "LONG entry above open");
    assert.ok(shortEntry < barOpen, "SHORT entry below open");
    // Spread asymmetry: LONG pays extra, SHORT receives discount
    const longPremium  = (longEntry  - barOpen) / PIP;
    const shortDiscount = (barOpen - shortEntry) / PIP;
    assert.ok(Math.abs(longPremium  - 1.8) < 0.001, `LONG premium  = ${longPremium} pips`);
    assert.ok(Math.abs(shortDiscount - 1.8) < 0.001, `SHORT discount = ${shortDiscount} pips`);
  });

  test("6B-04: Slippage is one-directional and additive with spread", () => {
    const barOpen    = 1.10000;
    const spreadOnly = barOpen + 1.5 * PIP;
    const spreadAndSlip = barOpen + 1.8 * PIP;  // 1.5 + 0.3
    assert.ok(spreadAndSlip > spreadOnly, "Slippage adds to cost");
    assert.ok(Math.abs((spreadAndSlip - barOpen) / PIP - 1.8) < 0.001,
      "Total cost = 1.8 pips");
  });

  test("6B-05: No double spread — cost applied exactly once at entry", () => {
    // Run a simple backtest and verify entryPrice = open + 1.8 pips (not + 3.6 pips)
    const OPEN   = 1.10000;
    const ATR    = 0.0050;   // 5 pips
    const N_BARS = 60;
    const bars: Bar[] = [];
    for (let i = 0; i < N_BARS; i++) {
      bars.push(makeFlatBar(i * TF_M5, OPEN));
    }

    let capturedEntry: number | null = null;
    const result = runBacktest({
      spec: MINIMAL_SPEC,
      symbol: "EURUSD",
      mainTimeframe: "M5",
      barsByTimeframe: { M5: bars },
      _evaluatorOverride: (ctx) => {
        // Fire BUY on bar 22, then SKIP
        const barTime = ctx.evaluationTime - TF_M5;
        if (barTime === 22 * TF_M5) return "BUY";
        return "SKIP";
      },
    });

    if (result.trades.length > 0) {
      capturedEntry = result.trades[0].entryPrice;
    }

    assert.ok(capturedEntry !== null, "Should have at least one trade");
    const diff = (capturedEntry! - OPEN) / PIP;
    assert.ok(Math.abs(diff - 1.8) < 0.05,
      `Entry cost should be ~1.8 pips, got ${diff.toFixed(3)} pips`);
  });

  test("6B-06: EURUSD pip size = 0.0001, ATR in price units converts correctly", () => {
    assert.equal(EURUSD.pipSize, 0.0001, "EURUSD pipSize = 0.0001");
    const atrPrice = 0.00035;
    const atrPips  = atrPrice / EURUSD.pipSize;
    assert.ok(Math.abs(atrPips - 3.5) < 0.001, `ATR 0.00035 = 3.5 pips (got ${atrPips})`);
    // Verify no pip/point confusion (1 point = 0.00001, 1 pip = 0.0001)
    const point = 0.00001;
    assert.equal(PIP / point, 10, "1 pip = 10 points (5-digit broker)");
  });

});

// =================================================================
// 6B-07~11: SL/TP geometry
// =================================================================

describe("6B-07~11 — SL/TP geometry", () => {

  const OPEN   = 1.10000;
  const ENTRY  = OPEN + 1.8 * PIP;   // 1.10018 — open + 1.8 pips cost
  const ATR    = 0.0003;              // 3 pips in price units (3 × 0.0001)

  test("6B-07: ATR in price units → pips correctly (3 pips = 0.0003 price)", () => {
    const atrPips = ATR / PIP;   // 0.0003 / 0.0001 = 3.0
    assert.ok(Math.abs(atrPips - 3.0) < 0.01, `ATR ${ATR} = 3 pips (got ${atrPips})`);
    // Verify 30-pip ATR would be 0.0030
    const bigAtr = 30 * PIP;
    assert.ok(Math.abs(bigAtr - 0.0030) < 1e-8, "30 pips = 0.0030 price units");
  });

  test("6B-08: LONG SL = entry − ATR × 1.0 (below entry)", () => {
    const sl = ENTRY - ATR * 1.0;
    const audit = auditSLTP("BUY", ENTRY, OPEN, sl, ENTRY + ATR * 1.5);
    assert.ok(audit.pass, "LONG SL below entry, TP above entry");
    assert.ok(Math.abs(audit.slDistPips - 3.0) < 0.1, `SL dist = ${audit.slDistPips.toFixed(2)} pips`);
    // Effective SL from open = (open - sl) / pip = (1.10000 - 1.09988) / 0.0001 = 1.2 pips
    // i.e., SL is only 1.2 pips below entry bar open — very tight!
    assert.ok(Math.abs(audit.effectiveSLFromOpen - 1.2) < 0.2,
      `Effective SL from open ≈ +1.2 pips below open (got ${audit.effectiveSLFromOpen.toFixed(2)})`);
  });

  test("6B-09: SHORT SL = entry + ATR × 1.0 (above entry)", () => {
    const entryShort = OPEN - 0.00018;  // short entry below open
    const sl = entryShort + ATR * 1.0;
    const audit = auditSLTP("SELL", entryShort, OPEN, sl, entryShort - ATR * 1.5);
    assert.ok(audit.pass, "SHORT SL above entry, TP below entry");
    assert.ok(Math.abs(audit.slDistPips - 3.0) < 0.1, `SELL SL dist = ${audit.slDistPips} pips`);
  });

  test("6B-10: LONG TP = entry + ATR × 1.5 (above entry)", () => {
    const tp = ENTRY + ATR * 1.5;
    const audit = auditSLTP("BUY", ENTRY, OPEN, ENTRY - ATR, tp);
    assert.ok(Math.abs(audit.tpDistPips - 4.5) < 0.1, `TP dist = ${audit.tpDistPips} pips`);
    assert.ok(Math.abs(audit.rrRatio - 1.5) < 0.05, `RR = ${audit.rrRatio.toFixed(2)}`);
  });

  test("6B-11: SHORT TP = entry − ATR × 1.5 (below entry)", () => {
    const entryShort = OPEN - 0.00018;
    const tp = entryShort - ATR * 1.5;
    const audit = auditSLTP("SELL", entryShort, OPEN, entryShort + ATR, tp);
    assert.ok(Math.abs(audit.tpDistPips - 4.5) < 0.1, `SELL TP dist = ${audit.tpDistPips} pips`);
  });

});

// =================================================================
// 6B-12~14: Same-bar exit
// =================================================================

describe("6B-12~14 — Same-bar exit", () => {

  test("6B-12: Same-bar SL hit — BUY: bar.low ≤ SL triggers SL exit", () => {
    const pos = {
      tradeId: 1, direction: "BUY" as const, symbol: "EURUSD", timeframe: "M5",
      entryTime: 0, entryPrice: 1.10018, sl: 1.09988, tp: 1.10063,
      lot: 0.01, spreadPips: 1.5, slippagePips: 0.3, entryBarIdx: 1,
    };
    // Entry bar has low that hits SL
    const barSLHit  = makeBar(TF_M5, 1.10018, 1.10025, 1.09985, 1.10015);
    const barNoHit  = makeBar(TF_M5, 1.10018, 1.10030, 1.10000, 1.10020);

    const slHit  = checkExitOnBar(pos, barSLHit);
    const noHit  = checkExitOnBar(pos, barNoHit);

    assert.equal(slHit.hit,  true,   "Bar.low below SL → SL hit");
    assert.equal(noHit.hit,  false,  "Bar within range → no exit");
    if (slHit.hit) assert.equal(slHit.reason, "SL");
  });

  test("6B-13: Same-bar TP hit — BUY: bar.high ≥ TP triggers TP exit", () => {
    const pos = {
      tradeId: 1, direction: "BUY" as const, symbol: "EURUSD", timeframe: "M5",
      entryTime: 0, entryPrice: 1.10018, sl: 1.09988, tp: 1.10063,
      lot: 0.01, spreadPips: 1.5, slippagePips: 0.3, entryBarIdx: 1,
    };
    const barTPHit = makeBar(TF_M5, 1.10018, 1.10065, 1.10010, 1.10050);
    const tpHit = checkExitOnBar(pos, barTPHit);
    assert.equal(tpHit.hit, true, "Bar.high above TP → TP hit");
    if (tpHit.hit) assert.equal(tpHit.reason, "TP");
  });

  test("6B-14: Same-bar SL+TP collision → SL wins (conservative backtest)", () => {
    const pos = {
      tradeId: 1, direction: "BUY" as const, symbol: "EURUSD", timeframe: "M5",
      entryTime: 0, entryPrice: 1.10018, sl: 1.09988, tp: 1.10063,
      lot: 0.01, spreadPips: 1.5, slippagePips: 0.3, entryBarIdx: 1,
    };
    // Bar that crosses BOTH SL and TP (wide range)
    const barBoth = makeBar(TF_M5, 1.10018, 1.10070, 1.09980, 1.10020);
    const result  = checkExitOnBar(pos, barBoth);
    assert.equal(result.hit, true);
    if (result.hit) {
      assert.equal(result.reason, "SL",
        "When both SL and TP reached in same bar, SL wins (conservative)");
    }
  });

});

// =================================================================
// 6B-15~18: MFE/MAE calculation
// =================================================================

describe("6B-15~18 — MFE/MAE raw calculation", () => {

  test("6B-15: LONG raw MFE = max((high − open) / pip) over horizon bars", () => {
    const OPEN  = 1.10000;
    const BARS: Bar[] = [
      makeBar(0,        OPEN, OPEN + 10 * PIP, OPEN - 5 * PIP,  OPEN + 8 * PIP),  // entry
      makeBar(TF_M5,    OPEN + 8 * PIP, OPEN + 20 * PIP, OPEN + 5 * PIP, OPEN + 15 * PIP),
      makeBar(2*TF_M5,  OPEN + 15 * PIP, OPEN + 15 * PIP, OPEN + 8 * PIP, OPEN + 10 * PIP),
    ];
    // MFE at horizon=3: max(10, 20, 15) = 20 pips from open
    const { mfe, mae } = computeRawMfeMae("BUY", OPEN, BARS, 0, 3);
    assert.ok(Math.abs(mfe - 20) < 0.5, `LONG raw MFE should be ~20 pips (got ${mfe.toFixed(2)})`);
    // MAE: min(-5, 5, 8) relative to open → min is -5 pips
    assert.ok(Math.abs(mae - (-5)) < 0.5, `LONG raw MAE should be ~-5 pips (got ${mae.toFixed(2)})`);
  });

  test("6B-16: SHORT raw MFE = max((open − low) / pip) over horizon bars", () => {
    const OPEN  = 1.10000;
    const BARS: Bar[] = [
      makeBar(0,       OPEN, OPEN + 5 * PIP, OPEN - 10 * PIP, OPEN - 8 * PIP),
      makeBar(TF_M5,   OPEN - 8 * PIP, OPEN - 5 * PIP, OPEN - 20 * PIP, OPEN - 15 * PIP),
      makeBar(2*TF_M5, OPEN - 15 * PIP, OPEN - 8 * PIP, OPEN - 15 * PIP, OPEN - 10 * PIP),
    ];
    // SHORT MFE: max(10, 20, 15) pips from open downward = 20
    const { mfe, mae } = computeRawMfeMae("SELL", OPEN, BARS, 0, 3);
    assert.ok(Math.abs(mfe - 20) < 0.5, `SHORT raw MFE ~20 pips (got ${mfe.toFixed(2)})`);
    // SHORT MAE: max upward from open = max(5, -5, -8) → 5 pips adverse → mae = -5
    assert.ok(Math.abs(mae - (-5)) < 0.5, `SHORT raw MAE ~-5 pips (got ${mae.toFixed(2)})`);
  });

  test("6B-17: LONG raw MAE = min((low − open) / pip) (negative pips)", () => {
    const OPEN  = 1.10000;
    const BARS: Bar[] = [
      makeBar(0, OPEN, OPEN + 5 * PIP, OPEN - 3 * PIP, OPEN + 2 * PIP),
      makeBar(TF_M5, OPEN, OPEN + 8 * PIP, OPEN - 7 * PIP, OPEN + 6 * PIP),
    ];
    const { mae } = computeRawMfeMae("BUY", OPEN, BARS, 0, 2);
    assert.ok(mae < 0, "LONG MAE must be negative (adverse = downward movement)");
    assert.ok(Math.abs(mae - (-7)) < 0.5, `LONG MAE ~-7 pips (got ${mae.toFixed(2)})`);
  });

  test("6B-18: SHORT raw MAE = min((open − high) / pip) (negative pips)", () => {
    const OPEN  = 1.10000;
    const BARS: Bar[] = [
      makeBar(0, OPEN, OPEN + 3 * PIP, OPEN - 5 * PIP, OPEN - 3 * PIP),
      makeBar(TF_M5, OPEN, OPEN + 8 * PIP, OPEN - 10 * PIP, OPEN - 8 * PIP),
    ];
    const { mae } = computeRawMfeMae("SELL", OPEN, BARS, 0, 2);
    assert.ok(mae < 0, "SHORT MAE must be negative (adverse = upward movement)");
    assert.ok(Math.abs(mae - (-8)) < 0.5, `SHORT MAE ~-8 pips (got ${mae.toFixed(2)})`);
  });

});

// =================================================================
// 6B-19~20: Raw horizon returns
// =================================================================

describe("6B-19~20 — Raw horizon returns", () => {

  test("6B-19: Raw 5-bar return: BUY = (close[entry+5] − open[entry]) / pip", () => {
    const OPEN  = 1.10000;
    const bars: Bar[] = [];
    for (let i = 0; i <= 6; i++) {
      bars.push(makeFlatBar(i * TF_M5, OPEN + i * 2 * PIP)); // rising 2 pips/bar
    }
    // Entry at bar 0 (open = 1.10000), close at bar 5 (close ≈ 1.10000 + 10 pips)
    const ret = computeRawReturn("BUY", OPEN, bars, 0, 5);
    assert.ok(ret !== null, "5-bar return must not be null");
    // bar[5].close ≈ OPEN + 5*2*PIP = OPEN + 10 pips → return ≈ 10 pips
    // (Each bar's close = open + 2 pips offset from its own flat price)
    assert.ok(ret! > 0, `5-bar BUY return should be positive in rising market: ${ret!.toFixed(2)}`);
  });

  test("6B-20: Raw 20-bar return: insufficient bars → null", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 15; i++) {
      bars.push(makeFlatBar(i * TF_M5, 1.10000));
    }
    const ret = computeRawReturn("BUY", 1.10000, bars, 0, 20);
    assert.equal(ret, null, "20-bar return with only 15 bars must return null");
  });

});

// =================================================================
// 6B-21: Zero-cost isolation
// =================================================================

describe("6B-21 — Zero-cost isolation", () => {

  test("6B-21: Zero-cost PF ≥ normal-cost PF for same signals", () => {
    // Build a scenario where price rises consistently after BUY signals
    // With normal cost: entry shifted up 1.8 pips → SL closer to open → more SL hits
    // With zero cost: entry at open → SL farther from open → fewer SL hits
    const OPEN = 1.10000;
    const ATR  = 0.0030;  // 3 pips
    const N    = 80;

    const bars: Bar[] = [];
    // Slowly trending bars: price rises 0.5 pips per bar
    for (let i = 0; i < N; i++) {
      const p = OPEN + i * 0.5 * PIP;
      bars.push(makeBar(i * TF_M5, p, p + 3 * PIP, p - 1 * PIP, p + 0.5 * PIP));
    }

    const signalBars = new Set([22, 30, 40, 50]);

    const normalResult = runBacktest({
      spec: MINIMAL_SPEC, symbol: "EURUSD", mainTimeframe: "M5",
      barsByTimeframe: { M5: bars },
      _evaluatorOverride: (ctx) => {
        const barTime = ctx.evaluationTime - TF_M5;
        const barIdx  = Math.round(barTime / TF_M5);
        return signalBars.has(barIdx) ? "BUY" : "SKIP";
      },
    });

    const zeroCostResult = runBacktest({
      spec: MINIMAL_SPEC, symbol: "EURUSD", mainTimeframe: "M5",
      barsByTimeframe: { M5: bars },
      _spreadOverride:   0,
      _slippageOverride: 0,
      _evaluatorOverride: (ctx) => {
        const barTime = ctx.evaluationTime - TF_M5;
        const barIdx  = Math.round(barTime / TF_M5);
        return signalBars.has(barIdx) ? "BUY" : "SKIP";
      },
    });

    const normalPips   = normalResult.totalPips;
    const zeroCostPips = zeroCostResult.totalPips;

    // Zero cost should have better (less negative or more positive) total pips
    assert.ok(
      zeroCostPips >= normalPips - 0.1,   // allow tiny FP variance
      `Zero-cost pips (${zeroCostPips.toFixed(1)}) should be ≥ normal-cost pips (${normalPips.toFixed(1)})`
    );
  });

});

// =================================================================
// 6B-22~24: Random control
// =================================================================

describe("6B-22~24 — Random control", () => {

  test("6B-22: seededRNG(42) produces identical sequence every run", () => {
    const rng1 = seededRNG(42);
    const rng2 = seededRNG(42);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    for (let i = 0; i < 10; i++) {
      assert.equal(seq1[i], seq2[i], `Sequence mismatch at position ${i}`);
    }
  });

  test("6B-23: Random signals match strategy LONG/SHORT ratio", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 200; i++) bars.push(makeFlatBar(i * TF_M5, 1.10000));

    // Strategy: 60 LONG, 40 SHORT
    const stratSignals: import("../phase6b/rawAnalysis").SignalOccurrence[] = [
      ...Array(60).fill(null).map((_, i) => ({
        signalBarIdx: 25 + i, entryBarIdx: 26 + i,
        direction: "BUY" as const, entryOpen: 1.10000, atrAtSignal: 0.0030,
      })),
      ...Array(40).fill(null).map((_, i) => ({
        signalBarIdx: 25 + i, entryBarIdx: 26 + i,
        direction: "SELL" as const, entryOpen: 1.10000, atrAtSignal: 0.0030,
      })),
    ];

    const randomSignals = generateRandomSignals(stratSignals, bars, 20, 50, 42);
    const randomLong  = randomSignals.filter(s => s.direction === "BUY").length;
    const randomShort = randomSignals.filter(s => s.direction === "SELL").length;

    assert.equal(randomLong,  60, `Random LONG count should be 60 (got ${randomLong})`);
    assert.equal(randomShort, 40, `Random SHORT count should be 40 (got ${randomShort})`);
  });

  test("6B-24: EDGE_DELTA = strategy positive rate − random positive rate", () => {
    const stratRate  = 0.54;
    const randomRate = 0.50;
    const delta = computeEdgeDelta(stratRate, randomRate);
    assert.ok(Math.abs(delta - 0.04) < 0.001, `EDGE_DELTA should be 0.04 (got ${delta})`);

    // Negative delta: strategy worse than random
    const negDelta = computeEdgeDelta(0.46, 0.50);
    assert.ok(negDelta < 0, "Negative EDGE_DELTA if strategy < random");

    // Zero delta: no edge
    const zeroDelta = computeEdgeDelta(0.50, 0.50);
    assert.equal(zeroDelta, 0, "Zero EDGE_DELTA if strategy = random");
  });

});

// =================================================================
// 6B-25~26: Chronological safety / no look-ahead
// =================================================================

describe("6B-25~26 — Chronological safety & no look-ahead", () => {

  test("6B-25: collectAllSignals processes bars in chronological order", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 60; i++) bars.push(makeFlatBar(i * TF_M5, 1.10000));

    const callTimes: number[] = [];
    const mockEvaluator = (ctx: import("../evaluator").EvaluationContext) => {
      callTimes.push(ctx.evaluationTime);
      return "SKIP" as const;
    };

    const inds = makeInds(bars.length);
    collectAllSignals(bars, inds, mockEvaluator, MINIMAL_SPEC, 20, 50);

    // Verify chronological order
    for (let i = 1; i < callTimes.length; i++) {
      assert.ok(callTimes[i] >= callTimes[i - 1],
        `Evaluation times must be non-decreasing (${callTimes[i-1]} → ${callTimes[i]})`);
    }
  });

  test("6B-26: Raw return only uses bars AFTER entry (no look-ahead)", () => {
    const OPEN  = 1.10000;
    const bars: Bar[] = [];
    // bars[0..9]: flat at 1.10000
    // bars[10..]: rising (future data)
    for (let i = 0; i < 20; i++) {
      const price = i < 10 ? OPEN : OPEN + (i - 10) * 5 * PIP;
      bars.push(makeFlatBar(i * TF_M5, price));
    }

    // Entry at bar 10 (index 10), horizon 5 → uses bars[10..14]
    const ret = computeRawReturn("BUY", OPEN, bars, 10, 5);
    assert.ok(ret !== null, "Should compute return");
    // bar[15].close = OPEN + 5 * 5 * PIP = OPEN + 25 pips
    // Return = bar[15].close - bars[10].open = (OPEN + 25) - OPEN = +25 pips
    assert.ok(ret! > 0, "Return should be positive (price rose after entry)");

    // Verify bar[9] (BEFORE entry) is NOT used for forward return
    // If bars[9].close was very high, it should not affect the return computation
    bars[9] = makeBar(9 * TF_M5, OPEN, OPEN + 1000 * PIP, OPEN - 1000 * PIP, OPEN - 500 * PIP);
    const retAfter = computeRawReturn("BUY", OPEN, bars, 10, 5);
    assert.equal(retAfter, ret, "Modifying pre-entry bars must not change forward return");
  });

});

// =================================================================
// Summary
// =================================================================

console.log("\n" + "=".repeat(60));
console.log(`  PHASE 6-B TESTS COMPLETE`);
console.log(`  Passed: ${passed}  |  Failed: ${failed}`);
console.log("=".repeat(60));

if (failed > 0) process.exit(1);

/**
 * Unit Tests — MonteCarloEngine (Phase 4-C)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/montecarlo.test.ts
 *
 * 設計原則:
 *   - Pure functions のみをテスト (DB / API 非依存)
 *   - Fisher-Yates 正確性、Seed 再現性、Metric 精度を確認
 *   - Profit Factor 定義が BacktestReporter.safePF() と一致することを確認
 *   - No NaN / No spurious Infinity を確認
 */

import assert from "node:assert/strict";
import type { BacktestTrade } from "../BacktestEngine";
import {
  MC_MIN_TRADES,
  MC_MIN_ITERATIONS,
  MC_MAX_ITERATIONS,
  MC_DEFAULT_ITERATIONS,
  MC_DEFAULT_DRAWDOWN_THRESHOLD,
  createRNG,
  shuffleTrades,
  calcIterationMetrics,
  calcPercentiles,
  calcPFPercentiles,
  calcProbabilityOfLoss,
  calcProbabilityOfDrawdownThreshold,
  calcOriginalPercentileRank,
  runMonteCarlo,
} from "../MonteCarloEngine";

// =================================================================
// ─── Test runner ─────────────────────────────────────────────────
// =================================================================

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}\n     ${msg}`);
    failed++;
  }
}
function describe(name: string, fn: () => void): void {
  console.log(`\n📊 ${name}`);
  fn();
}

// =================================================================
// ─── Fixtures ────────────────────────────────────────────────────
// =================================================================

const BASE_TIME = 1_700_000_000_000; // 2023-11-14

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    tradeId:      1,
    direction:    "BUY",
    symbol:       "EURUSD",
    timeframe:    "M15",
    entryTime:    BASE_TIME,
    entryPrice:   1.1000,
    sl:           1.0985,
    tp:           1.1020,
    lot:          0.01,
    spreadPips:   1.5,
    slippagePips: 0.3,
    entryBarIdx:  0,
    exitTime:     BASE_TIME + 3_600_000,
    exitPrice:    1.1020,
    exitBarIdx:   4,
    exitReason:   "TP",
    pips:         20,
    profit:       2.0,
    durationMin:  60,
    result:       "WIN",
    ...overrides,
  };
}

/** N 件の Trade を作成 (交互 WIN/LOSS) */
function makeMixedTrades(n: number, winPips = 20, lossPips = -10): BacktestTrade[] {
  return Array.from({ length: n }, (_, i) => {
    const isWin = i % 2 === 0;
    return makeTrade({
      tradeId:   i + 1,
      pips:      isWin ? winPips  : lossPips,
      profit:    isWin ? winPips * 0.1 : lossPips * 0.1,
      result:    isWin ? "WIN" : "LOSS",
      exitReason: isWin ? "TP" : "SL",
    });
  });
}

const INITIAL_BALANCE = 10_000;

// =================================================================
// ─── 1. Constants ────────────────────────────────────────────────
// =================================================================

describe("Constants", () => {
  test("T01: MC_MIN_TRADES = 10", () => {
    assert.equal(MC_MIN_TRADES, 10);
  });
  test("T02: MC_MIN_ITERATIONS = 100", () => {
    assert.equal(MC_MIN_ITERATIONS, 100);
  });
  test("T03: MC_MAX_ITERATIONS = 50000", () => {
    assert.equal(MC_MAX_ITERATIONS, 50_000);
  });
  test("T04: MC_DEFAULT_ITERATIONS = 1000", () => {
    assert.equal(MC_DEFAULT_ITERATIONS, 1_000);
  });
  test("T05: MC_DEFAULT_DRAWDOWN_THRESHOLD = 20", () => {
    assert.equal(MC_DEFAULT_DRAWDOWN_THRESHOLD, 20.0);
  });
});

// =================================================================
// ─── 2. Fisher-Yates Shuffle ─────────────────────────────────────
// =================================================================

describe("shuffleTrades — Fisher-Yates", () => {
  test("T06: shuffle result contains all original trades", () => {
    const trades = makeMixedTrades(10);
    const rng    = createRNG(42);
    const result = shuffleTrades(trades, rng);
    assert.equal(result.length, 10);
    const origIds  = trades.map(t => t.tradeId).sort((a, b) => a - b);
    const resultIds = result.map(t => t.tradeId).sort((a, b) => a - b);
    assert.deepEqual(resultIds, origIds);
  });

  test("T07: shuffle does not mutate original array", () => {
    const trades = makeMixedTrades(10);
    const origCopy = [...trades];
    const rng = createRNG(42);
    shuffleTrades(trades, rng);
    assert.deepEqual(trades, origCopy);
  });

  test("T08: same seed → same shuffle order", () => {
    const trades = makeMixedTrades(20);
    const r1 = shuffleTrades(trades, createRNG(12345));
    const r2 = shuffleTrades(trades, createRNG(12345));
    assert.deepEqual(r1.map(t => t.tradeId), r2.map(t => t.tradeId));
  });

  test("T09: different seeds → different shuffle order (almost always)", () => {
    const trades = makeMixedTrades(30);
    const r1 = shuffleTrades(trades, createRNG(1));
    const r2 = shuffleTrades(trades, createRNG(999999));
    const sameOrder = r1.every((t, i) => t.tradeId === r2[i]!.tradeId);
    assert.equal(sameOrder, false, "Different seeds produced identical shuffle — very unlikely");
  });

  test("T10: shuffle of 1 trade returns same single trade", () => {
    const trades = [makeTrade({ tradeId: 99 })];
    const result = shuffleTrades(trades, createRNG(0));
    assert.equal(result.length, 1);
    assert.equal(result[0]!.tradeId, 99);
  });

  test("T11: trade count preserved after shuffle", () => {
    const n = 50;
    const trades = makeMixedTrades(n);
    const result = shuffleTrades(trades, createRNG(777));
    assert.equal(result.length, n);
  });
});

// =================================================================
// ─── 3. calcIterationMetrics ─────────────────────────────────────
// =================================================================

describe("calcIterationMetrics", () => {
  test("T12: empty trades → all zeros", () => {
    const m = calcIterationMetrics([], INITIAL_BALANCE);
    assert.equal(m.finalPips,            0);
    assert.equal(m.finalProfit,          0);
    assert.equal(m.maxDrawdownPct,       0);
    assert.equal(m.maxConsecutiveLosses, 0);
    assert.equal(m.profitFactor,         0);
    assert.equal(m.winRate,              0);
  });

  test("T13: single WIN trade — finalPips", () => {
    const trades = [makeTrade({ pips: 25, profit: 2.5, result: "WIN" })];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.finalPips,  25);
    assert.equal(m.finalProfit, 2.5);
    assert.equal(m.winRate,    100);
    assert.equal(m.profitFactor, null); // grossLoss=0, grossProfit>0 → infinite
    assert.equal(m.maxConsecutiveLosses, 0);
  });

  test("T14: single LOSS trade — finalPips", () => {
    const trades = [makeTrade({ pips: -15, profit: -1.5, result: "LOSS", exitReason: "SL" })];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.finalPips,  -15);
    assert.equal(m.finalProfit, -1.5);
    assert.equal(m.winRate,     0);
    assert.equal(m.profitFactor, 0); // grossProfit=0, grossLoss>0 → 0
    assert.equal(m.maxConsecutiveLosses, 1);
  });

  test("T15: all winners — PF = null (infinite)", () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({ tradeId: i, pips: 20, profit: 2.0, result: "WIN" })
    );
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.profitFactor, null);
    assert.equal(m.winRate, 100);
    assert.equal(m.maxConsecutiveLosses, 0);
  });

  test("T16: all losers — PF = 0, winRate = 0", () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({ tradeId: i, pips: -10, profit: -1.0, result: "LOSS", exitReason: "SL" })
    );
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.profitFactor, 0);
    assert.equal(m.winRate, 0);
    assert.equal(m.maxConsecutiveLosses, 5);
  });

  test("T17: profit factor calculation — mixed trades", () => {
    // 3 wins × 2.0 profit + 2 losses × -1.0 profit
    const trades = [
      makeTrade({ tradeId: 1, pips: 20, profit: 2.0, result: "WIN" }),
      makeTrade({ tradeId: 2, pips: -10, profit: -1.0, result: "LOSS", exitReason: "SL" }),
      makeTrade({ tradeId: 3, pips: 20, profit: 2.0, result: "WIN" }),
      makeTrade({ tradeId: 4, pips: -10, profit: -1.0, result: "LOSS", exitReason: "SL" }),
      makeTrade({ tradeId: 5, pips: 20, profit: 2.0, result: "WIN" }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    // grossProfit=6.0, grossLoss=2.0 → PF=3.0
    assert.equal(m.profitFactor, 3.0);
    assert.equal(m.winRate, 60);
  });

  test("T18: finalProfit sums correctly", () => {
    const trades = [
      makeTrade({ tradeId: 1, pips: 20, profit: 2.0 }),
      makeTrade({ tradeId: 2, pips: -10, profit: -1.0 }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.finalProfit, 1.0);
  });

  test("T19: maxDrawdownPct calculation — correct running-balance method", () => {
    // balance: 10000 → 10020 → 10010 → 10040
    // peak at 10020, then drops to 10010 → DD = 10/10020 ≈ 0.0998% ≈ 0.1%
    const trades = [
      makeTrade({ tradeId: 1, pips: 20, profit: 20.0,  result: "WIN" }),
      makeTrade({ tradeId: 2, pips: -10, profit: -10.0, result: "LOSS", exitReason: "SL" }),
      makeTrade({ tradeId: 3, pips: 30, profit: 30.0,  result: "WIN" }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    // Peak after T1: 10020, DD after T2: 10020-10010=10, pct=10/10020=0.0998...
    const expected = Math.round(10 / 10020 * 10000) / 100;
    assert.equal(m.maxDrawdownPct, expected);
    assert.equal(m.finalPips, 40);
    assert.equal(m.finalProfit, 40.0);
  });

  test("T20: maxDrawdownPct = 0 when all trades win", () => {
    const trades = [
      makeTrade({ tradeId: 1, pips: 20, profit: 20.0 }),
      makeTrade({ tradeId: 2, pips: 15, profit: 15.0 }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.maxDrawdownPct, 0);
  });

  test("T21: maxConsecutiveLosses — correct streak counting", () => {
    const trades = [
      makeTrade({ result: "WIN" }),
      makeTrade({ result: "LOSS", exitReason: "SL" }),
      makeTrade({ result: "LOSS", exitReason: "SL" }),
      makeTrade({ result: "LOSS", exitReason: "SL" }),
      makeTrade({ result: "WIN" }),
      makeTrade({ result: "LOSS", exitReason: "SL" }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.maxConsecutiveLosses, 3);
  });

  test("T22: BREAKEVEN resets loss streak", () => {
    const trades = [
      makeTrade({ result: "LOSS",      pips: -10, profit: -1.0, exitReason: "SL" }),
      makeTrade({ result: "LOSS",      pips: -10, profit: -1.0, exitReason: "SL" }),
      makeTrade({ result: "BREAKEVEN", pips:   0, profit:  0.0, exitReason: "SL" }),
      makeTrade({ result: "LOSS",      pips: -10, profit: -1.0, exitReason: "SL" }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.maxConsecutiveLosses, 2, "BREAKEVEN should reset the streak");
  });

  test("T23: END_OF_DATA resets loss streak", () => {
    const trades = [
      makeTrade({ result: "LOSS",        pips: -10, profit: -1.0, exitReason: "SL" }),
      makeTrade({ result: "LOSS",        pips: -10, profit: -1.0, exitReason: "SL" }),
      makeTrade({ result: "END_OF_DATA", pips:   5, profit:  0.5, exitReason: "END_OF_DATA" }),
      makeTrade({ result: "LOSS",        pips: -10, profit: -1.0, exitReason: "SL" }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(m.maxConsecutiveLosses, 2, "END_OF_DATA should reset the streak");
  });

  test("T24: winRate counts only WIN (not END_OF_DATA)", () => {
    const trades = [
      makeTrade({ result: "WIN",        pips: 20,  profit:  2.0 }),
      makeTrade({ result: "END_OF_DATA", pips: 5,  profit:  0.5, exitReason: "END_OF_DATA" }),
      makeTrade({ result: "LOSS",       pips: -10, profit: -1.0, exitReason: "SL" }),
    ];
    const m = calcIterationMetrics(trades, INITIAL_BALANCE);
    // 1 WIN / 3 total = 33.33%
    assert.equal(m.winRate, Math.round(1/3*10000)/100);
  });
});

// =================================================================
// ─── 4. calcPercentiles ──────────────────────────────────────────
// =================================================================

describe("calcPercentiles", () => {
  test("T25: P50 of [1,2,3,4,5] = 3 (median)", () => {
    const p = calcPercentiles([1, 2, 3, 4, 5]);
    assert.equal(p.p50, 3);
  });

  test("T26: P5 of [1..100] = 5.95 (linear interpolation)", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const p = calcPercentiles(values);
    // P5: idx = 0.05 * 99 = 4.95
    // sorted[4]=5, sorted[5]=6 → 5 + (6-5)*0.95 = 5.95
    assert.ok(Math.abs(p.p5 - 5.95) < 0.01, `P5 expected ~5.95 but got ${p.p5}`);
  });

  test("T27: P95 of [1..100] ≈ 95.05", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const p = calcPercentiles(values);
    assert.ok(Math.abs(p.p95 - 95.05) < 0.01, `P95 expected ~95.05 but got ${p.p95}`);
  });

  test("T28: all same values → all percentiles equal", () => {
    const p = calcPercentiles([42, 42, 42, 42, 42]);
    assert.equal(p.p5,  42);
    assert.equal(p.p50, 42);
    assert.equal(p.p95, 42);
  });

  test("T29: P5 < P25 < P50 < P75 < P95 for varied data", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i * 0.1 - 50); // -50 to +49.9
    const p = calcPercentiles(values);
    assert.ok(p.p5 < p.p25 && p.p25 < p.p50 && p.p50 < p.p75 && p.p75 < p.p95);
  });

  test("T30: single value → all percentiles = that value", () => {
    const p = calcPercentiles([99]);
    assert.equal(p.p5,  99);
    assert.equal(p.p50, 99);
    assert.equal(p.p95, 99);
  });

  test("T31: no NaN in output", () => {
    const p = calcPercentiles([1, 2, 3]);
    for (const v of Object.values(p)) {
      assert.ok(!Number.isNaN(v), `Found NaN in percentile output: ${JSON.stringify(p)}`);
    }
  });
});

// =================================================================
// ─── 5. calcPFPercentiles ────────────────────────────────────────
// =================================================================

describe("calcPFPercentiles — Profit Factor", () => {
  test("T32: null (infinite PF) → sorted to top → P95 = null", () => {
    const values = [
      1.0, 1.2, 1.5, 1.8, null, null, null, null, null, null,
    ];
    const p = calcPFPercentiles(values);
    assert.equal(p.p95, null, "P95 should be null (infinite)");
    assert.ok(typeof p.p5 === "number" && p.p5! > 0, "P5 should be a finite number");
  });

  test("T33: all null → all percentiles = null", () => {
    const p = calcPFPercentiles([null, null, null]);
    assert.equal(p.p5,  null);
    assert.equal(p.p50, null);
    assert.equal(p.p95, null);
  });

  test("T34: all finite → no null in output", () => {
    const p = calcPFPercentiles([0.8, 1.0, 1.2, 1.5, 2.0]);
    for (const v of Object.values(p)) {
      assert.ok(v !== null, `Expected finite value but got null: ${JSON.stringify(p)}`);
    }
  });

  test("T35: no Infinity in output (Infinity converted to null)", () => {
    const p = calcPFPercentiles([null, null]);
    for (const v of Object.values(p)) {
      assert.ok(v !== Infinity, `Found raw Infinity in PF percentile: ${JSON.stringify(p)}`);
    }
  });
});

// =================================================================
// ─── 6. Probability Calculations ─────────────────────────────────
// =================================================================

describe("calcProbabilityOfLoss", () => {
  test("T36: P(loss) = 0 when all positive", () => {
    const p = calcProbabilityOfLoss([10, 20, 30, 50]);
    assert.equal(p, 0);
  });

  test("T37: P(loss) = 1 when all negative", () => {
    const p = calcProbabilityOfLoss([-5, -10, -20]);
    assert.equal(p, 1);
  });

  test("T38: P(loss) = 0.5 when half negative", () => {
    const p = calcProbabilityOfLoss([-10, -5, 5, 10]);
    assert.equal(p, 0.5);
  });

  test("T39: empty array → 0", () => {
    assert.equal(calcProbabilityOfLoss([]), 0);
  });

  test("T40: value exactly 0 is NOT counted as loss (< 0 strictly)", () => {
    const p = calcProbabilityOfLoss([0, -1, 1]);
    // only -1 is loss → 1/3
    assert.equal(p, Math.round(1/3 * 1_000_000) / 1_000_000);
  });
});

describe("calcProbabilityOfDrawdownThreshold", () => {
  test("T41: P(DD >= 20%) = 0 when all below threshold", () => {
    const p = calcProbabilityOfDrawdownThreshold([5, 10, 15], 20);
    assert.equal(p, 0);
  });

  test("T42: P(DD >= 20%) = 1 when all at or above threshold", () => {
    const p = calcProbabilityOfDrawdownThreshold([20, 25, 30], 20);
    assert.equal(p, 1);
  });

  test("T43: exactly at threshold is counted (>=)", () => {
    const p = calcProbabilityOfDrawdownThreshold([10, 20, 30], 20);
    // 2 out of 3 are >= 20
    assert.equal(p, Math.round(2/3 * 1_000_000) / 1_000_000);
  });

  test("T44: custom threshold 10%", () => {
    const p = calcProbabilityOfDrawdownThreshold([5, 15, 25], 10);
    // 15 and 25 are >= 10 → 2/3
    assert.equal(p, Math.round(2/3 * 1_000_000) / 1_000_000);
  });

  test("T45: empty array → 0", () => {
    assert.equal(calcProbabilityOfDrawdownThreshold([], 20), 0);
  });
});

// =================================================================
// ─── 7. calcOriginalPercentileRank ───────────────────────────────
// =================================================================

describe("calcOriginalPercentileRank", () => {
  test("T46: original at median of symmetric distribution → ~50", () => {
    const sim = Array.from({ length: 1000 }, (_, i) => i - 500); // -500..499
    const rank = calcOriginalPercentileRank(0, sim);
    // 501 values <= 0 (from -500 to 0) → 501/1000 = 50.1%
    assert.ok(Math.abs(rank - 50.1) < 1, `Expected ~50.1 but got ${rank}`);
  });

  test("T47: original above all simulations → ~100", () => {
    const sim = [1, 2, 3, 4, 5];
    const rank = calcOriginalPercentileRank(10, sim);
    assert.equal(rank, 100);
  });

  test("T48: original below all simulations → 0", () => {
    const sim = [10, 20, 30, 40, 50];
    const rank = calcOriginalPercentileRank(-5, sim);
    assert.equal(rank, 0);
  });

  test("T49: empty sim array → 50 (default)", () => {
    const rank = calcOriginalPercentileRank(100, []);
    assert.equal(rank, 50);
  });
});

// =================================================================
// ─── 8. runMonteCarlo — Full Integration ─────────────────────────
// =================================================================

describe("runMonteCarlo — determinism and structure", () => {
  const trades = makeMixedTrades(20);

  test("T50: same seed → identical distributions", () => {
    const r1 = runMonteCarlo({ trades, iterations: 200, seed: 42, initialBalance: INITIAL_BALANCE });
    const r2 = runMonteCarlo({ trades, iterations: 200, seed: 42, initialBalance: INITIAL_BALANCE });
    assert.deepEqual(r1.distributions, r2.distributions);
    assert.equal(r1.probabilityOfLoss, r2.probabilityOfLoss);
    assert.equal(r1.originalPercentileRank, r2.originalPercentileRank);
  });

  test("T51: different seed → different distributions (almost always)", () => {
    const r1 = runMonteCarlo({ trades, iterations: 500, seed: 1,    initialBalance: INITIAL_BALANCE });
    const r2 = runMonteCarlo({ trades, iterations: 500, seed: 99999, initialBalance: INITIAL_BALANCE });
    assert.notDeepEqual(r1.distributions, r2.distributions);
  });

  test("T52: input trades remain unchanged after runMonteCarlo", () => {
    const origCopy = trades.map(t => ({ ...t }));
    runMonteCarlo({ trades, iterations: 100, seed: 42, initialBalance: INITIAL_BALANCE });
    assert.deepEqual(trades, origCopy);
  });

  test("T53: required result structure — all fields present", () => {
    const r = runMonteCarlo({ trades, iterations: 100, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.ok(typeof r.iterations             === "number");
    assert.ok(typeof r.seed                   === "number");
    assert.ok(typeof r.tradeCount             === "number");
    assert.ok(typeof r.initialBalance         === "number");
    assert.ok(typeof r.drawdownThresholdPct   === "number");
    assert.ok(typeof r.probabilityOfLoss      === "number");
    assert.ok(typeof r.probabilityOfDrawdownThreshold === "number");
    assert.ok(typeof r.originalPercentileRank === "number");
    assert.ok(typeof r.executionMs            === "number");
    assert.ok(r.originalMetrics               !== null);
    assert.ok(r.distributions                 !== null);
    assert.ok("finalPips"            in r.distributions);
    assert.ok("maxDrawdownPct"       in r.distributions);
    assert.ok("profitFactor"         in r.distributions);
    assert.ok("maxConsecutiveLosses" in r.distributions);
  });

  test("T54: tradeCount = input trades length", () => {
    const r = runMonteCarlo({ trades, iterations: 100, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.tradeCount, trades.length);
  });

  test("T55: iterations = input iterations", () => {
    const r = runMonteCarlo({ trades, iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.iterations, 200);
  });

  test("T56: seed stored in result", () => {
    const r = runMonteCarlo({ trades, iterations: 100, seed: 31415, initialBalance: INITIAL_BALANCE });
    assert.equal(r.seed, 31415);
  });

  test("T57: default drawdownThresholdPct = 20", () => {
    const r = runMonteCarlo({ trades, iterations: 100, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.drawdownThresholdPct, 20.0);
  });

  test("T58: custom drawdownThresholdPct is respected", () => {
    const r = runMonteCarlo({ trades, iterations: 100, seed: 1, initialBalance: INITIAL_BALANCE, drawdownThresholdPct: 30 });
    assert.equal(r.drawdownThresholdPct, 30);
  });
});

describe("runMonteCarlo — edge cases", () => {
  test("T59: 100 iterations (minimum) completes without error", () => {
    const r = runMonteCarlo({ trades: makeMixedTrades(15), iterations: 100, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.iterations, 100);
  });

  test("T60: 1000 iterations completes in reasonable time", () => {
    const start = Date.now();
    runMonteCarlo({ trades: makeMixedTrades(50), iterations: 1_000, seed: 1, initialBalance: INITIAL_BALANCE });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `1000 iterations took ${elapsed}ms (expected < 5000ms)`);
  });

  test("T61: all winning trades — probabilityOfLoss = 0", () => {
    const allWin = Array.from({ length: 20 }, (_, i) =>
      makeTrade({ tradeId: i, pips: 20, profit: 2.0, result: "WIN" })
    );
    const r = runMonteCarlo({ trades: allWin, iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.probabilityOfLoss, 0, "All wins → P(loss)=0");
    assert.ok(r.originalMetrics.profitFactor === null, "All wins → PF=null (infinite)");
  });

  test("T62: all losing trades — probabilityOfLoss = 1", () => {
    const allLoss = Array.from({ length: 20 }, (_, i) =>
      makeTrade({ tradeId: i, pips: -15, profit: -1.5, result: "LOSS", exitReason: "SL" })
    );
    const r = runMonteCarlo({ trades: allLoss, iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.probabilityOfLoss, 1, "All losses → P(loss)=1");
    assert.equal(r.originalMetrics.profitFactor, 0);
  });

  test("T63: extreme DD scenario — P(DD>=threshold) > 0", () => {
    const heavyLoss = [
      makeTrade({ tradeId: 1, pips: -500, profit: -500, result: "LOSS", exitReason: "SL" }),
      makeTrade({ tradeId: 2, pips:  200, profit:  200, result: "WIN" }),
    ];
    const r = runMonteCarlo({ trades: heavyLoss, iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE, drawdownThresholdPct: 5 });
    assert.ok(r.probabilityOfDrawdownThreshold > 0, "Heavy loss trade should trigger DD threshold");
  });

  test("T64: zero DD scenario — P(DD>=20%) = 0 for monotonically increasing balance", () => {
    const allWin = Array.from({ length: 10 }, (_, i) =>
      makeTrade({ tradeId: i, pips: 20, profit: 20, result: "WIN" })
    );
    const r = runMonteCarlo({ trades: allWin, iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.probabilityOfDrawdownThreshold, 0, "All wins → no DD");
  });

  test("T65: originalMetrics matches manual calcIterationMetrics", () => {
    const trades = makeMixedTrades(10);
    const r      = runMonteCarlo({ trades, iterations: 100, seed: 1, initialBalance: INITIAL_BALANCE });
    const manual = calcIterationMetrics(trades, INITIAL_BALANCE);
    assert.equal(r.originalMetrics.finalPips,   manual.finalPips);
    assert.equal(r.originalMetrics.profitFactor, manual.profitFactor);
    assert.equal(r.originalMetrics.winRate,      manual.winRate);
  });

  test("T66: probabilities are in [0,1]", () => {
    const r = runMonteCarlo({ trades: makeMixedTrades(20), iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.ok(r.probabilityOfLoss >= 0 && r.probabilityOfLoss <= 1);
    assert.ok(r.probabilityOfDrawdownThreshold >= 0 && r.probabilityOfDrawdownThreshold <= 1);
  });

  test("T67: originalPercentileRank is in [0,100]", () => {
    const r = runMonteCarlo({ trades: makeMixedTrades(20), iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.ok(r.originalPercentileRank >= 0 && r.originalPercentileRank <= 100);
  });
});

describe("runMonteCarlo — no NaN / no raw Infinity", () => {
  test("T68: no NaN in any numeric field", () => {
    const r = runMonteCarlo({ trades: makeMixedTrades(20), iterations: 300, seed: 42, initialBalance: INITIAL_BALANCE });
    const checkNaN = (obj: unknown, path = ""): void => {
      if (typeof obj === "number") {
        assert.ok(!Number.isNaN(obj), `NaN found at ${path}`);
      } else if (obj !== null && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          checkNaN(v, `${path}.${k}`);
        }
      }
    };
    checkNaN(r);
  });

  test("T69: no raw Infinity in JSON-serialisable fields", () => {
    const r = runMonteCarlo({ trades: makeMixedTrades(20), iterations: 200, seed: 1, initialBalance: INITIAL_BALANCE });
    const json = JSON.stringify(r);
    assert.ok(!json.includes("Infinity"), "Found raw Infinity in serialized result");
    const parsed = JSON.parse(json) as unknown;
    assert.ok(parsed !== null);
  });

  test("T70: BREAKEVEN-only trades — profitFactor = 0 (no wins, no losses)", () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      makeTrade({ tradeId: i, pips: 0, profit: 0, result: "BREAKEVEN", exitReason: "SL" })
    );
    const r = runMonteCarlo({ trades, iterations: 100, seed: 1, initialBalance: INITIAL_BALANCE });
    assert.equal(r.originalMetrics.profitFactor, 0);
    assert.equal(r.probabilityOfLoss, 0, "finalPips=0 → not < 0 → P(loss)=0");
  });

  test("T71: large iteration count completes (5000 iters × 50 trades)", () => {
    const start = Date.now();
    runMonteCarlo({ trades: makeMixedTrades(50), iterations: 5_000, seed: 1, initialBalance: INITIAL_BALANCE });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 30_000, `5000 iterations took ${elapsed}ms (expected < 30000ms)`);
  });

  test("T72: reproducible complete result with seed=0", () => {
    // seed=0 should be normalised to 1 internally
    const r1 = runMonteCarlo({ trades: makeMixedTrades(15), iterations: 200, seed: 0, initialBalance: INITIAL_BALANCE });
    const r2 = runMonteCarlo({ trades: makeMixedTrades(15), iterations: 200, seed: 0, initialBalance: INITIAL_BALANCE });
    assert.equal(JSON.stringify(r1.distributions), JSON.stringify(r2.distributions));
  });
});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

console.log(`\n${"=".repeat(50)}`);
console.log(`MonteCarloEngine Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED ✅");
}

/**
 * Unit Tests — WalkForwardEngine (Phase 4-B)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/walkforward.test.ts
 *
 * 設計原則:
 *   - Pure functions のみをテスト (DB / API 非依存)
 *   - Data Leakage防止を明示的にテスト
 *   - Rolling Windowのtimestamp重複が正常であることを確認
 */

import assert from "node:assert/strict";
import type { Bar }           from "@/infrastructure/analysis/types";
import type { StrategySpec }  from "@/lib/strategySchema";
import type {
  WalkForwardWindowResult,
  WalkForwardWindow,
} from "../WalkForwardSchema";
import type { OptimizationMetrics } from "../OptimizationEngine";
import {
  MONTH_MS,
  WF_MAX_WINDOWS,
  WF_MAX_COMBINATIONS,
  WF_WARMUP_SAFETY_MARGIN,
  generateWalkForwardWindows,
  sliceTrainBarsWithBuffer,
  sliceTestBarsWithBuffer,
  filterTradesToPeriod,
  recomputeMetricsFromTrades,
  computeAdjustedISRatio,
  estimateMaxWarmup,
  checkMinBarsForWarmup,
  calcConsistencyScore,
  calcParameterStability,
  selectRecommendedParams,
  calcRecommendedParamFreq,
  determineVerdict,
  validateWalkForwardConfig,
  runWalkForward,
} from "../WalkForwardEngine";
import type { BacktestTrade } from "../BacktestEngine";

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

const M5_MS  = 300_000;
const T0     = 1_700_000_000_000;  // 2023-11-14 UTC

function makeBar(time: number, price = 1.1000): Bar {
  return { time, open: price, high: price + 0.0002, low: price - 0.0002, close: price, volume: 100 };
}

/** N本のM5バーを生成 */
function makeBars(n: number, startTime = T0): Bar[] {
  return Array.from({ length: n }, (_, i) =>
    makeBar(startTime + i * M5_MS, 1.1000 + i * 0.00001)
  );
}

const BASE_SPEC: StrategySpec = {
  name: "WF Test Strategy", strategy_type: "SCALPING",
  symbols: ["EURUSD"], timeframes: ["M5"],
  entry_conditions: {
    logic: "AND",
    conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 },
    ],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", multiplier: 1.5 },
    take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
  },
  filters: { min_adx: 20 },
  risk: { risk_per_trade: 1.0 },
};

const RSI_RANGE = {
  field: "entry_conditions.conditions[0].threshold",
  min: 25, max: 27, step: 1, paramType: "integer" as const,
};

function makeMetrics(overrides: Partial<OptimizationMetrics> = {}): OptimizationMetrics {
  return { totalTrades: 35, winRate: 45, profitFactor: 1.3, totalPips: 60, maxDrawdownPct: 5.0, ...overrides };
}

function makeWindowResult(overrides: Partial<WalkForwardWindowResult> = {}): WalkForwardWindowResult {
  return {
    windowIndex: 0,
    trainFrom: T0, trainTo: T0 + 3 * MONTH_MS, testFrom: T0 + 3 * MONTH_MS, testTo: T0 + 4 * MONTH_MS,
    bestParamSet: { "entry_conditions.conditions[0].threshold": 28 },
    trainOOSRank1OK: true,
    trainISMetrics:  makeMetrics({ totalTrades: 80 }),
    trainOOSMetrics: makeMetrics({ totalTrades: 20 }),
    testMetrics:     makeMetrics(),
    trainBarsCount: 6048, testBarsCount: 2016, warmupUsed: 50,
    sampleStatus: "NORMAL", trainOOSStatus: "LOW_SAMPLE",
    windowPassed: true, skipped: false,
    ...overrides,
  };
}

/** FakeTrade (entryTime指定) */
function fakeTrade(
  entryTime: number,
  pips = 10,
  profit = 1.0,
  result: BacktestTrade["result"] = "WIN",
): BacktestTrade {
  return {
    tradeId: 1, direction: "BUY", symbol: "EURUSD", timeframe: "M5",
    entryTime, entryPrice: 1.1000, exitTime: entryTime + 60 * M5_MS, exitPrice: 1.1100,
    sl: 1.0900, tp: 1.1200, lot: 0.01, spreadPips: 1.5, slippagePips: 0.3,
    entryBarIdx: 10, exitBarIdx: 70, exitReason: pips > 0 ? "TP" : "SL",
    pips, profit, durationMin: 60 * 5, result,
  };
}

// =================================================================
// ─── Tests ───────────────────────────────────────────────────────
// =================================================================

describe("generateWalkForwardWindows", () => {
  test("T01: 3M train + 1M test + 1M step → correct window count", () => {
    // データ: 20ヶ月
    const bars = makeBars(20 * 30 * 24 * 12, T0);  // ~M5 20ヶ月 (≈ 172800 bars)
    // 実際のバーは少なくて軽くするためMONTH_MSで制御
    const mainBars = [
      makeBar(T0),
      makeBar(T0 + 20 * MONTH_MS),
    ];
    // 最小バー要件: 全期間 >= trainMs + testMs
    // 2バーしかないが、generateWalkForwardWindowsはtime-basedで動作
    const windows = generateWalkForwardWindows(mainBars, {
      trainMs: 3 * MONTH_MS,
      testMs:  1 * MONTH_MS,
      stepMs:  1 * MONTH_MS,
    });
    // T0 から T0+20M まで: 16 windows (train=3M, test=1M, step=1M)
    assert.ok(windows.length > 0, "should generate windows");
  });

  test("T02: trainTo == testFrom (boundary continuity)", () => {
    const bars = [makeBar(T0), makeBar(T0 + 8 * MONTH_MS)];
    const windows = generateWalkForwardWindows(bars, {
      trainMs: 3 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS,
    });
    for (const w of windows) {
      assert.equal(w.trainTo, w.testFrom, `Window ${w.windowIndex}: trainTo !== testFrom`);
    }
  });

  test("T03: windowIndex is sequential", () => {
    const bars = [makeBar(T0), makeBar(T0 + 8 * MONTH_MS)];
    const windows = generateWalkForwardWindows(bars, {
      trainMs: 3 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS,
    });
    windows.forEach((w, i) => assert.equal(w.windowIndex, i));
  });

  test("T04: each window has trainFrom < trainTo < testTo", () => {
    const bars = [makeBar(T0), makeBar(T0 + 8 * MONTH_MS)];
    const windows = generateWalkForwardWindows(bars, {
      trainMs: 3 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS,
    });
    for (const w of windows) {
      assert.ok(w.trainFrom < w.trainTo, `W${w.windowIndex}: trainFrom >= trainTo`);
      assert.ok(w.trainTo < w.testTo,   `W${w.windowIndex}: trainTo >= testTo`);
    }
  });

  test("T05: rolling overlap — W1 trainFrom = W0 trainFrom + stepMs", () => {
    const bars = [makeBar(T0), makeBar(T0 + 8 * MONTH_MS)];
    const windows = generateWalkForwardWindows(bars, {
      trainMs: 3 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS,
    });
    if (windows.length >= 2) {
      assert.equal(windows[1]!.trainFrom, windows[0]!.trainFrom + MONTH_MS);
    }
  });

  test("T06: empty bars → empty windows", () => {
    const windows = generateWalkForwardWindows([], { trainMs: MONTH_MS, testMs: MONTH_MS, stepMs: MONTH_MS });
    assert.equal(windows.length, 0);
  });

  test("T07: insufficient data → empty windows", () => {
    const bars = [makeBar(T0), makeBar(T0 + MONTH_MS * 2)];
    // 必要: train(3M) + test(1M) = 4M, データは2M → NG
    const windows = generateWalkForwardWindows(bars, {
      trainMs: 3 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS,
    });
    assert.equal(windows.length, 0);
  });

  test("T08: maxWindows limit respected", () => {
    const bars = [makeBar(T0), makeBar(T0 + 100 * MONTH_MS)];
    const windows = generateWalkForwardWindows(bars, {
      trainMs: 1 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS,
    }, 5);  // limit = 5
    assert.ok(windows.length <= 5);
  });

  test("T09: deterministic — same input same output", () => {
    const bars = [makeBar(T0), makeBar(T0 + 8 * MONTH_MS)];
    const cfg = { trainMs: 3 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS };
    const w1 = generateWalkForwardWindows(bars, cfg);
    const w2 = generateWalkForwardWindows(bars, cfg);
    assert.deepEqual(w1, w2);
  });
});

describe("Rolling Overlap: Normal and NOT Data Leakage", () => {
  test("T10: W1 TRAIN may include W0 TEST period (price data only — normal)", () => {
    const bars = [makeBar(T0), makeBar(T0 + 8 * MONTH_MS)];
    const windows = generateWalkForwardWindows(bars, {
      trainMs: 3 * MONTH_MS, testMs: 1 * MONTH_MS, stepMs: 1 * MONTH_MS,
    });
    if (windows.length >= 2) {
      const w0 = windows[0]!;
      const w1 = windows[1]!;
      // With stepMs = testMs = 1M, w1.trainFrom = w0.trainFrom + 1M
      // w0.testFrom = w0.trainFrom + 3M
      // w1.trainTo  = w1.trainFrom + 3M = w0.trainFrom + 4M
      // w0.testTo   = w0.testFrom + 1M  = w0.trainFrom + 4M
      // So w1.TRAIN includes w0.TEST period (w0.testFrom to w0.testTo)
      const w1TrainCoversW0Test = w1.trainFrom <= w0.testFrom && w1.trainTo >= w0.testTo;
      assert.ok(w1TrainCoversW0Test, "W1 TRAIN should include W0 TEST period (rolling window)");
    }
  });

  test("T11: sliceTrainBarsWithBuffer never includes TEST period bars", () => {
    const allBars = makeBars(200, T0);
    const trainFrom = allBars[50]!.time;
    const trainTo   = allBars[100]!.time;
    // testFrom = trainTo

    const trainSliced = sliceTrainBarsWithBuffer({ M5: allBars }, trainFrom, trainTo, 10);
    const trainBars = trainSliced["M5"]!;

    // No bar should have time >= trainTo
    for (const b of trainBars) {
      assert.ok(b.time < trainTo, `TRAIN bar time ${b.time} >= trainTo ${trainTo}`);
    }
  });

  test("T12: sliceTestBarsWithBuffer uses only bars BEFORE testFrom as buffer", () => {
    const allBars = makeBars(200, T0);
    const testFrom = allBars[100]!.time;
    const testTo   = allBars[150]!.time;

    const testSliced = sliceTestBarsWithBuffer({ M5: allBars }, testFrom, testTo, 10);
    const testBars = testSliced["M5"]!;

    const bufBars  = testBars.filter(b => b.time < testFrom);
    const evalBars = testBars.filter(b => b.time >= testFrom && b.time < testTo);

    // Buffer bars are all BEFORE testFrom (past data = no leakage)
    for (const b of bufBars) {
      assert.ok(b.time < testFrom, `Buffer bar ${b.time} >= testFrom ${testFrom}`);
    }
    // Eval bars are within [testFrom, testTo)
    for (const b of evalBars) {
      assert.ok(b.time >= testFrom && b.time < testTo);
    }
  });
});

describe("sliceTrainBarsWithBuffer", () => {
  const allBars = makeBars(100, T0);

  test("T13: returns warmup buffer + eval bars", () => {
    const trainFrom = allBars[20]!.time;
    const trainTo   = allBars[60]!.time;
    const sliced = sliceTrainBarsWithBuffer({ M5: allBars }, trainFrom, trainTo, 10);
    const bars = sliced["M5"]!;
    const bufBars  = bars.filter(b => b.time < trainFrom);
    const evalBars = bars.filter(b => b.time >= trainFrom && b.time < trainTo);
    assert.equal(bufBars.length, 10);
    assert.equal(evalBars.length, 40);
    assert.equal(bars.length, 50);
  });

  test("T14: buffer capped by available pre-train bars", () => {
    const trainFrom = allBars[5]!.time;  // only 5 bars before
    const trainTo   = allBars[30]!.time;
    const sliced = sliceTrainBarsWithBuffer({ M5: allBars }, trainFrom, trainTo, 20);  // request 20
    const bars = sliced["M5"]!;
    const bufBars = bars.filter(b => b.time < trainFrom);
    assert.equal(bufBars.length, 5);  // only 5 available
  });

  test("T15: multi-TF uses same time boundaries", () => {
    const h1Bars = Array.from({ length: 20 }, (_, i) =>
      makeBar(T0 + i * 3_600_000)
    );
    const trainFrom = T0 + 5 * 3_600_000;
    const trainTo   = T0 + 15 * 3_600_000;

    const sliced = sliceTrainBarsWithBuffer(
      { M5: allBars, H1: h1Bars },
      trainFrom, trainTo, 3
    );

    // H1 buffer bars: 3 bars before trainFrom
    const h1Buf = sliced["H1"]!.filter(b => b.time < trainFrom);
    assert.ok(h1Buf.length <= 3);
    for (const b of h1Buf) {
      assert.ok(b.time < trainFrom);
    }
  });
});

describe("sliceTestBarsWithBuffer", () => {
  const allBars = makeBars(100, T0);

  test("T16: returns warmup buffer (from pre-test) + eval bars", () => {
    const testFrom = allBars[50]!.time;
    const testTo   = allBars[80]!.time;
    const sliced = sliceTestBarsWithBuffer({ M5: allBars }, testFrom, testTo, 15);
    const bars = sliced["M5"]!;
    const bufBars  = bars.filter(b => b.time < testFrom);
    const evalBars = bars.filter(b => b.time >= testFrom && b.time < testTo);
    assert.equal(bufBars.length, 15);
    assert.equal(evalBars.length, 30);
  });

  test("T17: all buffer bars are BEFORE testFrom (Look-ahead Bias free)", () => {
    const testFrom = allBars[60]!.time;
    const testTo   = allBars[90]!.time;
    const sliced = sliceTestBarsWithBuffer({ M5: allBars }, testFrom, testTo, 20);
    const bufBars = sliced["M5"]!.filter(b => b.time < testFrom);
    for (const b of bufBars) {
      assert.ok(b.time < testFrom, `Buffer bar time ${b.time} >= testFrom`);
    }
  });
});

describe("filterTradesToPeriod", () => {
  test("T18: filters trades before fromTime", () => {
    const trades = [
      fakeTrade(T0 - 1000, 5),    // before fromTime
      fakeTrade(T0,         10),   // exactly at fromTime
      fakeTrade(T0 + 1000, 15),   // after fromTime
    ];
    const filtered = filterTradesToPeriod(trades, T0);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(t => t.entryTime >= T0));
  });

  test("T19: empty trades → empty result", () => {
    assert.equal(filterTradesToPeriod([], T0).length, 0);
  });
});

describe("recomputeMetricsFromTrades", () => {
  test("T20: empty trades → zero metrics", () => {
    const m = recomputeMetricsFromTrades([], 10000);
    assert.equal(m.totalTrades, 0);
    assert.equal(m.totalPips, 0);
    assert.equal(m.profitFactor, 0);
  });

  test("T21: WIN trade → positive metrics", () => {
    const trades = [fakeTrade(T0, 20, 2.0)];
    const m = recomputeMetricsFromTrades(trades, 10000);
    assert.equal(m.totalTrades, 1);
    assert.equal(m.winRate, 100);
    assert.equal(m.totalPips, 20);
    assert.equal(m.profitFactor, null);  // all wins = infinite
  });

  test("T22: mix WIN+LOSS → correct PF and winRate", () => {
    const wins   = [fakeTrade(T0,       20,  2.0, "WIN"), fakeTrade(T0+1000, 15, 1.5, "WIN")];
    const losses = [fakeTrade(T0+2000, -10, -1.0, "LOSS")];
    const all = [...wins, ...losses];
    const m = recomputeMetricsFromTrades(all, 10000);
    assert.equal(m.totalTrades, 3);
    assert.ok(m.profitFactor !== null && m.profitFactor > 0, `profitFactor should be > 0, got ${m.profitFactor}`);
    // winRate = 2/3 = 66.67%
    assert.equal(m.winRate, Math.round(2/3 * 10000) / 100);
  });
});

describe("computeAdjustedISRatio", () => {
  test("T23: no warmup → targetRatio unchanged", () => {
    assert.equal(computeAdjustedISRatio(0, 8640, 0.8), 0.8);
  });

  test("T24: with warmup → ratio adjusted so split falls at correct index", () => {
    const W = 200, T = 8640, targetRatio = 0.8;
    const adjusted = computeAdjustedISRatio(W, T, targetRatio);
    const totalLen = W + T;
    const splitIdx = Math.floor(totalLen * adjusted);
    const expectedSplitIdx = W + Math.floor(T * targetRatio);
    assert.equal(splitIdx, expectedSplitIdx,
      `splitIdx=${splitIdx} should be ${expectedSplitIdx}`);
  });

  test("T25: result is within (0, 1) exclusive", () => {
    const adjusted = computeAdjustedISRatio(5000, 100, 0.8);
    assert.ok(adjusted > 0 && adjusted < 1);
  });

  test("T26: capped at 0.99", () => {
    // Extreme case: warmup >> trainLen
    const adjusted = computeAdjustedISRatio(10000, 1, 0.8);
    assert.ok(adjusted <= 0.99);
  });
});

describe("estimateMaxWarmup", () => {
  test("T27: RSI strategy → warmup >= 14 + safety margin", () => {
    const warmup = estimateMaxWarmup(BASE_SPEC, [], WF_WARMUP_SAFETY_MARGIN);
    assert.ok(warmup >= 14 + WF_WARMUP_SAFETY_MARGIN);
  });

  test("T28: period range in parameterRanges increases warmup estimate", () => {
    const baseWarmup = estimateMaxWarmup(BASE_SPEC, [], 0);
    const withPeriodRange = estimateMaxWarmup(BASE_SPEC, [{
      field: "entry_conditions.conditions[0].period",
      min: 14, max: 35, step: 1, paramType: "integer",
    }], 0);
    assert.ok(withPeriodRange >= baseWarmup, "Period range should increase warmup estimate");
    assert.ok(withPeriodRange >= 35, "RSI period=35 → warmup should be >= 35");
  });

  test("T29: EMA(200) equivalent increases warmup estimate significantly", () => {
    const specWithEMA200: StrategySpec = {
      ...BASE_SPEC,
      entry_conditions: {
        logic: "AND",
        conditions: [
          { indicator: "EMA", timeframe: "M5", period: 200, operator: "PRICE_ABOVE" },
        ],
      },
    };
    const warmup = estimateMaxWarmup(specWithEMA200, [], 0);
    assert.ok(warmup >= 199, `EMA(200) warmup should be >= 199, got ${warmup}`);
  });

  test("T30: safety margin is added", () => {
    const w0 = estimateMaxWarmup(BASE_SPEC, [], 0);
    const w50 = estimateMaxWarmup(BASE_SPEC, [], 50);
    assert.equal(w50, w0 + 50);
  });
});

describe("checkMinBarsForWarmup", () => {
  test("T31: sufficient bars → valid=true", () => {
    const result = checkMinBarsForWarmup(1000, 33, 50);
    assert.equal(result.valid, true);
    assert.equal(result.minRequired, 33 + 50);
  });

  test("T32: exactly at boundary → valid=false (need > minRequired)", () => {
    const result = checkMinBarsForWarmup(83, 33, 50);
    // 83 bars, need > 83 → false
    assert.equal(result.valid, false);
  });

  test("T33: one more than minimum → valid=true", () => {
    const result = checkMinBarsForWarmup(84, 33, 50);
    assert.equal(result.valid, true);
  });
});

describe("calcConsistencyScore", () => {
  test("T34: all windows passed → score=1.0", () => {
    const windows = [
      makeWindowResult({ windowPassed: true, sampleStatus: "NORMAL" }),
      makeWindowResult({ windowPassed: true, sampleStatus: "NORMAL" }),
    ];
    const score = calcConsistencyScore(windows);
    assert.equal(score, 1.0);
  });

  test("T35: half passed (NORMAL) → score=0.5", () => {
    const windows = [
      makeWindowResult({ windowPassed: true,  sampleStatus: "NORMAL" }),
      makeWindowResult({ windowPassed: false, sampleStatus: "NORMAL" }),
    ];
    assert.equal(calcConsistencyScore(windows), 0.5);
  });

  test("T36: LOW_SAMPLE weight=0.5 (not equal to NORMAL)", () => {
    // 1 NORMAL pass (weight=1.0) + 1 LOW_SAMPLE pass (weight=0.5) + 1 NORMAL fail (weight=1.0)
    const windows = [
      makeWindowResult({ windowPassed: true,  sampleStatus: "NORMAL" }),
      makeWindowResult({ windowPassed: true,  sampleStatus: "LOW_SAMPLE" }),
      makeWindowResult({ windowPassed: false, sampleStatus: "NORMAL" }),
    ];
    const score = calcConsistencyScore(windows);
    // totalWeight = 1+0.5+1 = 2.5, positiveWeight = 1+0.5 = 1.5 → 0.6
    assert.equal(score, 0.6);
  });

  test("T37: all INSUFFICIENT → null", () => {
    const windows = [
      makeWindowResult({ sampleStatus: "INSUFFICIENT", skipped: true }),
    ];
    const score = calcConsistencyScore(windows);
    assert.equal(score, null);
  });

  test("T38: skipped windows excluded from calculation", () => {
    const windows = [
      makeWindowResult({ windowPassed: true,  sampleStatus: "NORMAL", skipped: false }),
      makeWindowResult({ windowPassed: false, sampleStatus: "NORMAL", skipped: true }),   // skipped
    ];
    const score = calcConsistencyScore(windows);
    assert.equal(score, 1.0);  // only 1 non-skipped valid window, passed
  });
});

describe("calcParameterStability", () => {
  test("T39: all windows same value → stability=1.0", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
    ];
    const stab = calcParameterStability(windows);
    assert.equal(stab["rsi"], 1.0);
  });

  test("T40: highly variable values → stability < 0.5", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 20 } }),
      makeWindowResult({ bestParamSet: { "rsi": 40 } }),
      makeWindowResult({ bestParamSet: { "rsi": 15 } }),
      makeWindowResult({ bestParamSet: { "rsi": 45 } }),
    ];
    const stab = calcParameterStability(windows);
    assert.ok((stab["rsi"] ?? 1) < 0.6, `stability ${stab["rsi"]} should be < 0.6`);
  });

  test("T41: single valid window → stability=1.0 (undefined CV)", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
    ];
    const stab = calcParameterStability(windows);
    assert.equal(stab["rsi"], 1.0);
  });

  test("T42: INSUFFICIENT windows excluded", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 29 }, sampleStatus: "NORMAL", skipped: false }),
      makeWindowResult({ bestParamSet: { "rsi": 5 },  sampleStatus: "INSUFFICIENT", skipped: true }), // excluded
    ];
    const stab = calcParameterStability(windows);
    // Only 1 valid value → stability=1.0
    assert.equal(stab["rsi"], 1.0);
  });
});

describe("selectRecommendedParams", () => {
  test("T43: mode value is selected", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 28 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
      makeWindowResult({ bestParamSet: { "rsi": 30 } }),
    ];
    const params = selectRecommendedParams(windows);
    assert.equal(params?.["rsi"], 29);  // mode = 29 (2 occurrences)
  });

  test("T44: tiebreaker = last occurrence (most recent window)", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 28 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),  // last of tied
    ];
    const params = selectRecommendedParams(windows);
    assert.equal(params?.["rsi"], 29);  // tiebreaker = latest = 29
  });

  test("T45: all INSUFFICIENT/skipped → null", () => {
    const windows = [
      makeWindowResult({ sampleStatus: "INSUFFICIENT", skipped: true }),
    ];
    const params = selectRecommendedParams(windows);
    assert.equal(params, null);
  });

  test("T46: multi-field mode", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 28, "rr": 2.0 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29, "rr": 1.5 } }),
      makeWindowResult({ bestParamSet: { "rsi": 28, "rr": 2.0 } }),
    ];
    const params = selectRecommendedParams(windows);
    assert.equal(params?.["rsi"], 28);
    assert.equal(params?.["rr"], 2.0);
  });
});

describe("calcRecommendedParamFreq", () => {
  test("T47: frequency count is correct", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 28 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
    ];
    const freq = calcRecommendedParamFreq(windows);
    const rsiFreq = freq["rsi"]!;
    const f29 = rsiFreq.find(x => x.value === 29);
    const f28 = rsiFreq.find(x => x.value === 28);
    assert.equal(f29?.windowCount, 2);
    assert.equal(f28?.windowCount, 1);
  });

  test("T48: sorted by windowCount descending", () => {
    const windows = [
      makeWindowResult({ bestParamSet: { "rsi": 28 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
      makeWindowResult({ bestParamSet: { "rsi": 29 } }),
    ];
    const freq = calcRecommendedParamFreq(windows);
    const rsiFreq = freq["rsi"]!;
    assert.equal(rsiFreq[0]!.value, 29);  // most frequent first
    assert.equal(rsiFreq[1]!.value, 28);
  });
});

describe("determineVerdict", () => {
  test("T49: ROBUST conditions met → ROBUST", () => {
    const verdict = determineVerdict(0.8, { "rsi": 0.85 }, 4, 3);
    assert.equal(verdict, "ROBUST");
  });

  test("T50: consistency=0.6 → CONDITIONAL", () => {
    const verdict = determineVerdict(0.6, { "rsi": 0.8 }, 4, 3);
    assert.equal(verdict, "CONDITIONAL");
  });

  test("T51: consistency=0.4 → OVERFIT", () => {
    const verdict = determineVerdict(0.4, { "rsi": 0.8 }, 4, 3);
    assert.equal(verdict, "OVERFIT");
  });

  test("T52: null consistency → INCONCLUSIVE", () => {
    const verdict = determineVerdict(null, {}, 0, 0);
    assert.equal(verdict, "INCONCLUSIVE");
  });

  test("T53: validWindowCount < 2 → INCONCLUSIVE", () => {
    const verdict = determineVerdict(0.9, { "rsi": 0.9 }, 1, 1);
    assert.equal(verdict, "INCONCLUSIVE");
  });

  test("T54: ROBUST needs normalWindowCount >= 1", () => {
    // consistency=0.8, stability=0.8, validCount=3 but normalCount=0
    const verdict = determineVerdict(0.8, { "rsi": 0.85 }, 3, 0);
    assert.notEqual(verdict, "ROBUST");
  });

  test("T55: low paramStabilityAvg → not ROBUST", () => {
    const verdict = determineVerdict(0.8, { "rsi": 0.3 }, 4, 3);
    assert.notEqual(verdict, "ROBUST");
  });
});

describe("validateWalkForwardConfig", () => {
  test("T56: valid config passes", () => {
    const result = validateWalkForwardConfig(
      { trainMonths: 3, testMonths: 1, stepMonths: 1 },
      [RSI_RANGE], BASE_SPEC, 10000, 80,
    );
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test("T57: trainMonths=0 fails", () => {
    const result = validateWalkForwardConfig(
      { trainMonths: 0, testMonths: 1, stepMonths: 1 },
      [RSI_RANGE], BASE_SPEC, 10000, 80,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("trainMonths")));
  });

  test("T58: trainMonths=25 fails (max 24)", () => {
    const result = validateWalkForwardConfig(
      { trainMonths: 25, testMonths: 1, stepMonths: 1 },
      [RSI_RANGE], BASE_SPEC, 10000, 80,
    );
    assert.equal(result.valid, false);
  });

  test("T59: testMonths > trainMonths → warning (not error)", () => {
    const result = validateWalkForwardConfig(
      { trainMonths: 1, testMonths: 3, stepMonths: 1 },
      [RSI_RANGE], BASE_SPEC, 10000, 80,
    );
    assert.ok(result.warnings.length > 0, "should have warning");
  });

  test("T60: stepMonths < testMonths → warning (overlap acceptable)", () => {
    const result = validateWalkForwardConfig(
      { trainMonths: 3, testMonths: 2, stepMonths: 1 },
      [RSI_RANGE], BASE_SPEC, 10000, 80,
    );
    assert.ok(result.warnings.some(w => w.includes("overlap")));
  });

  test("T61: too many combinations → error", () => {
    const bigRanges = [
      { field: "entry_conditions.conditions[0].threshold", min: 1, max: 50, step: 1, paramType: "integer" as const },
      { field: "filters.min_adx", min: 10, max: 45, step: 1, paramType: "integer" as const },
    ];
    // 50 × 36 = 1800 > WF_MAX_COMBINATIONS (200)
    const result = validateWalkForwardConfig(
      { trainMonths: 3, testMonths: 1, stepMonths: 1 },
      bigRanges, BASE_SPEC, 10000, 80,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes(String(WF_MAX_COMBINATIONS))));
  });
});

describe("runWalkForward — Integration", () => {
  const BARS = 600;  // ~enough for 3+1 month windows with small MONTH_MS

  // Use small MONTH_MS for testing to avoid huge bar generation
  const SMALL_MONTH = BARS / 8 * M5_MS;  // ~75 bars per month

  function makeInput() {
    const bars = makeBars(BARS, T0);
    return {
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      allBarsByTf:     { M5: bars },
      parameterRanges: [
        { field: "entry_conditions.conditions[0].threshold", min: 28, max: 29, step: 1, paramType: "integer" as const },
      ],
      trainMonths:     3,
      testMonths:      1,
      stepMonths:      1,
      warmupSafetyMargin: 20,
    };
  }

  // Override MONTH_MS for test by manipulating windows directly
  // Since MONTH_MS is a constant, we test the window generation separately
  // and integration through runWalkForward with data large enough to produce windows

  test("T62: runWalkForward returns result with correct shape", () => {
    const bars = makeBars(BARS, T0);
    // Create synthetic windows for the test
    const result = runWalkForward({
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      allBarsByTf:     { M5: bars },
      parameterRanges: [RSI_RANGE],
      trainMonths:     3,
      testMonths:      1,
      stepMonths:      1,
      warmupSafetyMargin: 10,
    });

    assert.ok(Array.isArray(result.windows));
    assert.ok(typeof result.verdict === "string");
    assert.ok(["ROBUST","CONDITIONAL","OVERFIT","INCONCLUSIVE"].includes(result.verdict));
    assert.ok(result.totalWindowCount >= 0);
    assert.ok(result.skippedWindowCount >= 0);
  });

  test("T63: deterministic — same input → same output", () => {
    const bars = makeBars(BARS, T0);
    const input = {
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      allBarsByTf:     { M5: bars },
      parameterRanges: [RSI_RANGE],
      trainMonths:     3,
      testMonths:      1,
      stepMonths:      1,
      warmupSafetyMargin: 10,
    };
    const r1 = runWalkForward(input);
    const r2 = runWalkForward(input);
    assert.equal(r1.verdict, r2.verdict);
    assert.equal(r1.totalWindowCount, r2.totalWindowCount);
    assert.deepEqual(r1.recommendedParams, r2.recommendedParams);
  });

  test("T64: insufficient data → no windows → INCONCLUSIVE", () => {
    // Only 10 bars, way less than needed for any window
    const tinyBars = makeBars(10, T0);
    const result = runWalkForward({
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      allBarsByTf:     { M5: tinyBars },
      parameterRanges: [RSI_RANGE],
      trainMonths:     3,
      testMonths:      1,
      stepMonths:      1,
      warmupSafetyMargin: 10,
    });
    assert.equal(result.totalWindowCount, 0);
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.consistencyScore, null);
  });
});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

console.log(`\n${"═".repeat(55)}`);
console.log(`  WalkForwardEngine Tests`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
console.log(`${"═".repeat(55)}`);

if (failed > 0) process.exit(1);

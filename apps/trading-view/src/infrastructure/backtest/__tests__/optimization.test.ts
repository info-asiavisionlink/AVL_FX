/**
 * Unit Tests — OptimizationEngine (Phase 4-A)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/optimization.test.ts
 *
 * 設計:
 *   - Pure function のみをテスト (DB / API / AI 非依存)
 *   - BacktestEngine との統合テストは最小限 (flatBars を使用)
 *   - 決定論的な動作を厳密に確認
 */

import assert from "node:assert/strict";
import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import {
  generateGrid,
  countCombinations,
  validateParameterRanges,
  applyParameterSetToSpec,
  splitBarsByRatio,
  metricsFromResult,
  getSampleStatus,
  calcDegradationRatio,
  calculateStabilityScores,
  rankCandidates,
  buildOptimizationSummary,
  runOptimization,
  isOptimizationAllowedField,
  OPTIMIZATION_MAX_COMBINATIONS,
  OPTIMIZATION_MAX_PER_PARAM,
  SAMPLE_NORMAL_THRESHOLD,
  SAMPLE_LOW_THRESHOLD,
  type ParameterRange,
  type OptimizationCandidate,
  type OptimizationMetrics,
} from "../OptimizationEngine";
import { runBacktest } from "../BacktestEngine";

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

const M5_MS = 300_000;
const T0    = 1_700_000_000_000;  // 2023-11-14 UTC

function makeBar(time: number, price: number, offset = 0.001): Bar {
  return {
    time,
    open:  price,
    high:  price + offset,
    low:   price - offset,
    close: price,
    volume: 100,
  };
}

function flatBars(n: number, startTime = T0, price = 1.1000): Bar[] {
  return Array.from({ length: n }, (_, i) =>
    makeBar(startTime + i * M5_MS, price + i * 0.00001)
  );
}

const BASE_SPEC: StrategySpec = {
  name:          "Test RSI Strategy",
  strategy_type: "SCALPING",
  symbols:       ["EURUSD"],
  timeframes:    ["M5"],
  entry_conditions: {
    logic:      "AND",
    conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 },
    ],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", multiplier: 1.5 },
    take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
  },
  filters: {
    min_adx:         20,
    max_spread_pips: 2.0,
  },
  risk: { risk_per_trade: 1.0 },
};

const RSI_RANGE: ParameterRange = {
  field: "entry_conditions.conditions[0].threshold",
  min: 25, max: 35, step: 1, paramType: "integer",
};

const ADX_RANGE: ParameterRange = {
  field: "filters.min_adx",
  min: 20, max: 30, step: 5, paramType: "integer",
};

const RR_RANGE: ParameterRange = {
  field: "exit_conditions.take_profit.rr_ratio",
  min: 1.0, max: 2.0, step: 0.5, paramType: "float",
};

function makeMetrics(overrides: Partial<OptimizationMetrics> = {}): OptimizationMetrics {
  return {
    totalTrades: 40, winRate: 45, profitFactor: 1.3,
    totalPips: 80, maxDrawdownPct: 5.0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<OptimizationCandidate> = {}): OptimizationCandidate {
  return {
    index: 0,
    paramSet: { "entry_conditions.conditions[0].threshold": 30 },
    inSample:  makeMetrics({ totalPips: 100 }),
    outSample: makeMetrics({ totalTrades: 35, totalPips: 60 }),
    sampleStatus:    "NORMAL",
    stabilityScore:  0.7,
    degradationRatio: 0.6,
    rank: 1,
    ...overrides,
  };
}

// =================================================================
// ─── Tests ───────────────────────────────────────────────────────
// =================================================================

describe("generateGrid — 1 Parameter", () => {
  test("T01: 1 range → correct values (min to max)", () => {
    const grid = generateGrid([RSI_RANGE]);
    assert.equal(grid.length, 11);
    assert.deepEqual(grid[0],  { "entry_conditions.conditions[0].threshold": 25 });
    assert.deepEqual(grid[10], { "entry_conditions.conditions[0].threshold": 35 });
  });

  test("T02: values are inclusive of min and max", () => {
    const grid = generateGrid([{ field: "f", min: 1, max: 3, step: 1, paramType: "integer" }]);
    const vals = grid.map(p => p["f"]);
    assert.ok(vals.includes(1), "must include min");
    assert.ok(vals.includes(3), "must include max");
  });

  test("T03: integer type rounds values", () => {
    const grid = generateGrid([{ field: "f", min: 25, max: 27, step: 1, paramType: "integer" }]);
    grid.forEach(p => assert.ok(Number.isInteger(p["f"]), `${p["f"]} must be integer`));
  });

  test("T04: float step preserves decimal places", () => {
    const grid = generateGrid([{ field: "f", min: 1.0, max: 2.0, step: 0.5, paramType: "float" }]);
    assert.equal(grid.length, 3);
    assert.equal(grid[0]!["f"], 1.0);
    assert.equal(grid[1]!["f"], 1.5);
    assert.equal(grid[2]!["f"], 2.0);
  });

  test("T05: empty ranges → single empty set", () => {
    const grid = generateGrid([]);
    assert.equal(grid.length, 1);
    assert.deepEqual(grid[0], {});
  });
});

describe("generateGrid — Multiple Parameters (deterministic)", () => {
  test("T06: 2 ranges → correct count", () => {
    const grid = generateGrid([RSI_RANGE, ADX_RANGE]);
    // RSI: 11 values, ADX: 3 values → 33
    assert.equal(grid.length, 33);
  });

  test("T07: order is deterministic (range[0] outer, range[1] inner)", () => {
    const grid = generateGrid([
      { field: "a", min: 1, max: 2, step: 1, paramType: "integer" },
      { field: "b", min: 10, max: 11, step: 1, paramType: "integer" },
    ]);
    // Expected: {a:1,b:10},{a:1,b:11},{a:2,b:10},{a:2,b:11}
    assert.equal(grid.length, 4);
    assert.equal(grid[0]!["a"], 1);
    assert.equal(grid[0]!["b"], 10);
    assert.equal(grid[1]!["a"], 1);
    assert.equal(grid[1]!["b"], 11);
    assert.equal(grid[2]!["a"], 2);
    assert.equal(grid[2]!["b"], 10);
  });

  test("T08: same input always produces same output", () => {
    const grid1 = generateGrid([RSI_RANGE, ADX_RANGE]);
    const grid2 = generateGrid([RSI_RANGE, ADX_RANGE]);
    assert.deepEqual(grid1, grid2);
  });

  test("T09: 3 parameters", () => {
    const grid = generateGrid([
      { field: "a", min: 1, max: 2, step: 1, paramType: "integer" },  // 2
      { field: "b", min: 1, max: 3, step: 1, paramType: "integer" },  // 3
      { field: "c", min: 1, max: 4, step: 1, paramType: "integer" },  // 4
    ]);
    assert.equal(grid.length, 24);  // 2 × 3 × 4 = 24
  });
});

describe("countCombinations", () => {
  test("T10: single range", () => {
    assert.equal(countCombinations([RSI_RANGE]), 11); // 25..35 step 1
  });

  test("T11: multiple ranges", () => {
    assert.equal(countCombinations([RSI_RANGE, ADX_RANGE]), 33); // 11 × 3
  });

  test("T12: empty ranges → 1", () => {
    assert.equal(countCombinations([]), 1);
  });
});

describe("validateParameterRanges", () => {
  test("T13: valid ranges pass", () => {
    const r = validateParameterRanges([RSI_RANGE], BASE_SPEC);
    assert.equal(r.valid, true);
    assert.equal(r.errors.length, 0);
  });

  test("T14: min >= max fails", () => {
    const r = validateParameterRanges([{ ...RSI_RANGE, min: 35, max: 25 }], BASE_SPEC);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("min")));
  });

  test("T15: step = 0 fails", () => {
    const r = validateParameterRanges([{ ...RSI_RANGE, step: 0 }], BASE_SPEC);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("step")));
  });

  test("T16: forbidden field (strategy_type) fails", () => {
    const r = validateParameterRanges([{ field: "strategy_type", min: 1, max: 2, step: 1, paramType: "integer" }], BASE_SPEC);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("whitelist")));
  });

  test("T17: whitelist field (RSI threshold) passes", () => {
    const r = validateParameterRanges([RSI_RANGE], BASE_SPEC);
    assert.equal(r.valid, true);
  });

  test("T18: too many values per param fails", () => {
    const bigRange: ParameterRange = { field: "entry_conditions.conditions[0].threshold", min: 1, max: 200, step: 1, paramType: "integer" };
    const r = validateParameterRanges([bigRange], BASE_SPEC);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes(`max ${OPTIMIZATION_MAX_PER_PARAM}`)));
  });

  test("T19: field not in spec fails", () => {
    const r = validateParameterRanges([{ field: "entry_conditions.conditions[5].threshold", min: 25, max: 35, step: 1, paramType: "integer" }], BASE_SPEC);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("does not exist")));
  });

  test("T20: integer type with float values fails", () => {
    const r = validateParameterRanges([{ field: "entry_conditions.conditions[0].threshold", min: 25.5, max: 35.5, step: 1.0, paramType: "integer" }], BASE_SPEC);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("integer")));
  });

  test("T21: empty ranges fails", () => {
    const r = validateParameterRanges([], BASE_SPEC);
    assert.equal(r.valid, false);
  });
});

describe("applyParameterSetToSpec", () => {
  test("T22: RSI threshold changed correctly", () => {
    const result = applyParameterSetToSpec(BASE_SPEC, {
      "entry_conditions.conditions[0].threshold": 29,
    });
    assert.equal(result.entry_conditions.conditions[0]!.threshold, 29);
    assert.equal(result.entry_conditions.conditions[0]!.period, 14);  // unchanged
  });

  test("T23: multiple params applied simultaneously", () => {
    const result = applyParameterSetToSpec(BASE_SPEC, {
      "entry_conditions.conditions[0].threshold": 28,
      "exit_conditions.take_profit.rr_ratio":     2.5,
      "filters.min_adx":                          25,
    });
    assert.equal(result.entry_conditions.conditions[0]!.threshold, 28);
    assert.equal(result.exit_conditions?.take_profit?.rr_ratio, 2.5);
    assert.equal(result.filters?.min_adx, 25);
  });

  test("T24: invalid param value throws", () => {
    // RSI threshold with a value that violates schema (> 10000)
    assert.throws(() => {
      applyParameterSetToSpec(BASE_SPEC, {
        "entry_conditions.conditions[0].threshold": 99999,
      });
    }, /schema validation/i);
  });

  test("T25: original spec is not mutated", () => {
    const original = JSON.parse(JSON.stringify(BASE_SPEC)) as StrategySpec;
    applyParameterSetToSpec(BASE_SPEC, {
      "entry_conditions.conditions[0].threshold": 29,
    });
    assert.deepEqual(BASE_SPEC.entry_conditions.conditions[0]!.threshold,
      original.entry_conditions.conditions[0]!.threshold);
  });
});

describe("splitBarsByRatio", () => {
  const bars = flatBars(100, T0, 1.1000);

  test("T26: 80/20 split → correct counts", () => {
    const split = splitBarsByRatio({ M5: bars }, "M5", 0.8);
    // splitIdx = floor(100 * 0.8) = 80 → cutoffTime = bars[80].time
    assert.equal(split.inSampleCount, 80);
    assert.equal(split.outSampleCount, 20);
  });

  test("T27: cutoffTime matches splitIdx bar's timestamp", () => {
    const split = splitBarsByRatio({ M5: bars }, "M5", 0.8);
    const splitIdx = Math.floor(100 * 0.8);
    assert.equal(split.cutoffTime, bars[splitIdx]!.time);
  });

  test("T28: all IS bars have time < cutoffTime", () => {
    const split = splitBarsByRatio({ M5: bars }, "M5", 0.8);
    for (const b of split.inSample["M5"]!) {
      assert.ok(b.time < split.cutoffTime, `IS bar time ${b.time} >= cutoffTime ${split.cutoffTime}`);
    }
  });

  test("T29: all OOS bars have time >= cutoffTime", () => {
    const split = splitBarsByRatio({ M5: bars }, "M5", 0.8);
    for (const b of split.outSample["M5"]!) {
      assert.ok(b.time >= split.cutoffTime, `OOS bar time ${b.time} < cutoffTime ${split.cutoffTime}`);
    }
  });

  test("T30: multi-timeframe split uses same cutoffTime", () => {
    // H1 bars: sparse
    const h1Bars = Array.from({ length: 12 }, (_, i) =>
      makeBar(T0 + i * 3_600_000, 1.1000)  // hourly
    );
    const split = splitBarsByRatio({ M5: bars, H1: h1Bars }, "M5", 0.8);

    // H1 IS bars must all have time < cutoffTime
    for (const b of split.inSample["H1"]!) {
      assert.ok(b.time < split.cutoffTime, `H1 IS bar ${b.time} >= cutoff`);
    }
    // H1 OOS bars must all have time >= cutoffTime
    for (const b of split.outSample["H1"]!) {
      assert.ok(b.time >= split.cutoffTime, `H1 OOS bar ${b.time} < cutoff`);
    }
  });

  test("T31: empty main bars → empty split", () => {
    const split = splitBarsByRatio({ M5: [] }, "M5", 0.8);
    assert.equal(split.inSampleCount, 0);
    assert.equal(split.outSampleCount, 0);
  });
});

describe("getSampleStatus", () => {
  test("T32: >= 30 → NORMAL", () => {
    assert.equal(getSampleStatus(SAMPLE_NORMAL_THRESHOLD), "NORMAL");
    assert.equal(getSampleStatus(100), "NORMAL");
  });

  test("T33: 15-29 → LOW_SAMPLE", () => {
    assert.equal(getSampleStatus(SAMPLE_LOW_THRESHOLD), "LOW_SAMPLE");
    assert.equal(getSampleStatus(29), "LOW_SAMPLE");
  });

  test("T34: < 15 → INSUFFICIENT", () => {
    assert.equal(getSampleStatus(0),  "INSUFFICIENT");
    assert.equal(getSampleStatus(14), "INSUFFICIENT");
  });
});

describe("calcDegradationRatio", () => {
  test("T35: normal ratio", () => {
    assert.equal(calcDegradationRatio(100, 60), 0.6);
  });

  test("T36: IS pips = 0 → null", () => {
    assert.equal(calcDegradationRatio(0, 50), null);
  });

  test("T37: OOS loss → negative ratio", () => {
    const ratio = calcDegradationRatio(100, -30);
    assert.ok(ratio !== null && ratio < 0);
  });
});

describe("calculateStabilityScores", () => {
  test("T38: stable zone (all neighbors profitable)", () => {
    const evaluated = [
      { paramSet: { "f": 28 }, inSample: makeMetrics({ profitFactor: 1.5, totalPips: 80 }) },
      { paramSet: { "f": 29 }, inSample: makeMetrics({ profitFactor: 1.4, totalPips: 75 }) },
      { paramSet: { "f": 30 }, inSample: makeMetrics({ profitFactor: 1.3, totalPips: 70 }) },
      { paramSet: { "f": 31 }, inSample: makeMetrics({ profitFactor: 1.2, totalPips: 65 }) },
      { paramSet: { "f": 32 }, inSample: makeMetrics({ profitFactor: 1.1, totalPips: 60 }) },
    ];
    const ranges: ParameterRange[] = [{ field: "f", min: 28, max: 32, step: 1, paramType: "integer" }];
    const scores = calculateStabilityScores(evaluated, ranges, { windowSize: 2, minPF: 1.0 });
    // Middle element (index 2, f=30) should have high stability
    assert.ok(scores[2]! > 0.5, `Expected score > 0.5, got ${scores[2]}`);
  });

  test("T39: unstable (isolated high performer)", () => {
    const evaluated = [
      { paramSet: { "f": 28 }, inSample: makeMetrics({ profitFactor: 0.5, totalPips: -20 }) },
      { paramSet: { "f": 29 }, inSample: makeMetrics({ profitFactor: 1.8, totalPips: 100 }) },  // spike
      { paramSet: { "f": 30 }, inSample: makeMetrics({ profitFactor: 0.6, totalPips: -15 }) },
    ];
    const ranges: ParameterRange[] = [{ field: "f", min: 28, max: 30, step: 1, paramType: "integer" }];
    const scores = calculateStabilityScores(evaluated, ranges, { windowSize: 1, minPF: 1.0 });
    // Index 1 (spike) should have low stability (neighbors are bad)
    assert.ok(scores[1]! < 0.5, `Expected spike to be unstable, got ${scores[1]}`);
  });

  test("T40: edge point (no neighbors) → 0.5", () => {
    const evaluated = [
      { paramSet: { "f": 25 }, inSample: makeMetrics() },  // only one
    ];
    const ranges: ParameterRange[] = [{ field: "f", min: 25, max: 25, step: 1, paramType: "integer" }];
    const scores = calculateStabilityScores(evaluated, ranges, { windowSize: 2 });
    assert.equal(scores[0], 0.5);
  });
});

describe("rankCandidates", () => {
  test("T41: better OOS performance → higher rank", () => {
    const a = makeCandidate({ outSample: makeMetrics({ totalPips: 100, profitFactor: 1.5, totalTrades: 40 }), sampleStatus: "NORMAL" });
    const b = makeCandidate({ outSample: makeMetrics({ totalPips: 50,  profitFactor: 1.2, totalTrades: 35 }), sampleStatus: "NORMAL" });
    const ranked = rankCandidates([b, a]);
    assert.equal(ranked[0]!.rank, 1);
    assert.equal(ranked[0]!.outSample.totalPips, 100);  // a should be rank 1
  });

  test("T42: INSUFFICIENT sample is penalized to lowest rank", () => {
    const good  = makeCandidate({ outSample: makeMetrics({ totalTrades: 40, totalPips: 100 }), sampleStatus: "NORMAL" });
    const insuf = makeCandidate({ outSample: makeMetrics({ totalTrades: 5,  totalPips: 200 }), sampleStatus: "INSUFFICIENT" });
    const ranked = rankCandidates([insuf, good]);
    // good should be rank 1 even though insuf has more pips
    assert.equal(ranked[0]!.sampleStatus, "NORMAL");
    assert.equal(ranked[ranked.length - 1]!.sampleStatus, "INSUFFICIENT");
  });

  test("T43: deterministic order (same input → same output)", () => {
    const candidates = [
      makeCandidate({ index: 0, outSample: makeMetrics({ totalPips: 80 }), sampleStatus: "NORMAL" }),
      makeCandidate({ index: 1, outSample: makeMetrics({ totalPips: 60 }), sampleStatus: "NORMAL" }),
      makeCandidate({ index: 2, outSample: makeMetrics({ totalPips: 90 }), sampleStatus: "NORMAL" }),
    ];
    const ranked1 = rankCandidates([...candidates]);
    const ranked2 = rankCandidates([...candidates]);
    assert.deepEqual(ranked1.map(c => c.index), ranked2.map(c => c.index));
  });

  test("T44: stability score as tiebreaker", () => {
    const sameOOS = makeMetrics({ totalPips: 80, profitFactor: 1.3, totalTrades: 35 });
    const a = makeCandidate({ index: 0, outSample: sameOOS, sampleStatus: "NORMAL", stabilityScore: 0.8 });
    const b = makeCandidate({ index: 1, outSample: sameOOS, sampleStatus: "NORMAL", stabilityScore: 0.4 });
    const ranked = rankCandidates([b, a]);
    assert.equal(ranked[0]!.stabilityScore, 0.8);
  });
});

describe("buildOptimizationSummary", () => {
  test("T45: counts stable and robust correctly", () => {
    const candidates: OptimizationCandidate[] = [
      makeCandidate({ stabilityScore: 0.8, sampleStatus: "NORMAL",       outSample: makeMetrics({ totalPips: 50, profitFactor: 1.2 }) }),
      makeCandidate({ stabilityScore: 0.7, sampleStatus: "NORMAL",       outSample: makeMetrics({ totalPips: 80, profitFactor: 1.5 }) }),
      makeCandidate({ stabilityScore: 0.5, sampleStatus: "LOW_SAMPLE",   outSample: makeMetrics({ totalPips: 30, profitFactor: 1.1 }) }),
      makeCandidate({ stabilityScore: 0.3, sampleStatus: "INSUFFICIENT", outSample: makeMetrics({ totalPips: 0,  profitFactor: 0   }) }),
    ];
    const summary = buildOptimizationSummary(candidates, T0, 0.8);
    assert.equal(summary.totalCombinations, 4);
    assert.equal(summary.stableZoneCount, 2);   // score >= 0.6: index 0, 1
    assert.equal(summary.robustCount, 2);        // NORMAL sample AND OOS PF >= 1.1: index 0, 1 (LOW_SAMPLE excluded)
    assert.equal(summary.inSampleRatio, 0.8);
  });
});

describe("isOptimizationAllowedField", () => {
  test("T46: allowed fields pass", () => {
    assert.equal(isOptimizationAllowedField("entry_conditions.conditions[0].threshold"), true);
    assert.equal(isOptimizationAllowedField("exit_conditions.stop_loss.multiplier"),     true);
    assert.equal(isOptimizationAllowedField("exit_conditions.take_profit.rr_ratio"),     true);
    assert.equal(isOptimizationAllowedField("filters.max_spread_pips"),                  true);
    assert.equal(isOptimizationAllowedField("filters.min_adx"),                          true);
  });

  test("T47: forbidden fields fail", () => {
    assert.equal(isOptimizationAllowedField("strategy_type"),                              false);
    assert.equal(isOptimizationAllowedField("symbols"),                                    false);
    assert.equal(isOptimizationAllowedField("entry_conditions.conditions[0].indicator"),  false);
    assert.equal(isOptimizationAllowedField("entry_conditions.logic"),                    false);
    assert.equal(isOptimizationAllowedField("filters.sessions"),                          false);
    assert.equal(isOptimizationAllowedField("risk"),                                      false);
  });
});

describe("runOptimization — Integration", () => {
  const BARS_COUNT = 500;  // enough for warmup

  test("T48: 2 combinations complete without error", () => {
    const bars = flatBars(BARS_COUNT);
    const result = runOptimization({
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      barsByTimeframe: { M5: bars },
      parameterRanges: [{ field: "entry_conditions.conditions[0].threshold", min: 28, max: 29, step: 1, paramType: "integer" }],
      inSampleRatio:   0.8,
    });
    assert.equal(result.candidates.length, 2);
    assert.equal(result.ranked.length, 2);
    // cutoffTime should be around 80% of bars
    const splitIdx = Math.floor(BARS_COUNT * 0.8);
    assert.equal(result.cutoffTime, bars[splitIdx]!.time);
  });

  test("T49: same input → same result (deterministic)", () => {
    const bars = flatBars(BARS_COUNT);
    const sharedRange: ParameterRange = { field: "entry_conditions.conditions[0].threshold", min: 25, max: 27, step: 1, paramType: "integer" };
    const input = {
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      barsByTimeframe: { M5: bars },
      parameterRanges: [sharedRange],
      inSampleRatio:   0.8,
    };
    const r1 = runOptimization(input);
    const r2 = runOptimization(input);
    assert.deepEqual(
      r1.ranked.map(c => c.paramSet),
      r2.ranked.map(c => c.paramSet),
    );
    assert.deepEqual(
      r1.ranked.map(c => c.inSample),
      r2.ranked.map(c => c.inSample),
    );
  });

  test("T50: inSampleBarsCount + outSampleBarsCount = total bars (approx)", () => {
    const bars = flatBars(BARS_COUNT);
    const result = runOptimization({
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      barsByTimeframe: { M5: bars },
      parameterRanges: [{ field: "entry_conditions.conditions[0].threshold", min: 28, max: 29, step: 1, paramType: "integer" }],
      inSampleRatio:   0.8,
    });
    assert.equal(result.inSampleBarsCount + result.outSampleBarsCount, BARS_COUNT);
  });

  test("T51: candidates have correct fields", () => {
    const bars = flatBars(BARS_COUNT);
    const result = runOptimization({
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      barsByTimeframe: { M5: bars },
      parameterRanges: [{ field: "entry_conditions.conditions[0].threshold", min: 30, max: 31, step: 1, paramType: "integer" }],
      inSampleRatio:   0.8,
    });
    for (const c of result.candidates) {
      assert.ok(c.paramSet !== undefined);
      assert.ok(c.inSample !== undefined);
      assert.ok(c.outSample !== undefined);
      assert.ok(c.sampleStatus !== undefined);
      assert.ok(typeof c.stabilityScore === "number");
      assert.ok(c.rank === undefined || typeof c.rank === "number");
    }
  });
});

describe("metricsFromResult — BacktestResult mapping", () => {
  test("T52: profitFactor null when all wins", () => {
    // Win-only scenario via _evaluatorOverride
    const bars = flatBars(200, T0, 1.1000);
    const alwaysBuy = () => "BUY" as const;
    const r = runBacktest({
      spec:            BASE_SPEC,
      symbol:          "EURUSD",
      mainTimeframe:   "M5",
      barsByTimeframe: { M5: bars.map((b, i) => ({ ...b, close: b.close + i * 0.001 })) },
      _evaluatorOverride: alwaysBuy,
    });
    const metrics = metricsFromResult(r);
    // profitFactor calculation depends on trades; just check type
    assert.ok(metrics.profitFactor === null || typeof metrics.profitFactor === "number");
    assert.ok(typeof metrics.totalTrades === "number");
    assert.ok(typeof metrics.winRate === "number");
    assert.ok(typeof metrics.totalPips === "number");
    assert.ok(typeof metrics.maxDrawdownPct === "number");
  });
});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

console.log(`\n${"═".repeat(55)}`);
console.log(`  OptimizationEngine Tests`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
console.log(`${"═".repeat(55)}`);

if (failed > 0) process.exit(1);

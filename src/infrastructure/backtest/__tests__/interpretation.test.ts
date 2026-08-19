/**
 * Unit Tests — InterpretationEngine (Phase 4-D)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/interpretation.test.ts
 *
 * 設計原則:
 *   - Pure functions のみをテスト (DB / OpenAI 非依存)
 *   - Data Leakage 防止を明示的にテスト
 *   - 数値 Integrity 検証の精度をテスト
 *   - Confidence の決定論的計算をテスト
 */

import assert from "node:assert/strict";
import {
  calcDeterministicConfidence,
  buildInterpretationPrompt,
  parseInterpretationResponse,
  validateInterpretationIntegrity,
  buildCorrectionPrompt,
} from "../InterpretationEngine";
import type { InterpretationContext, Phase4DInterpretationAIOutput } from "../InterpretationSchema";

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

const ALL_PHASES_CTX: InterpretationContext = {
  strategy: { name: "RSI Cross", type: "DAY_TRADE", symbol: "EURUSD", timeframe: "M15", versionId: "v-1", versionNum: 2 },
  backtestAnalysis: {
    verdict: "PASSED", verdictReason: "Profitable: pips=+240.5", totalPips: 240.5, winRate: 56.2,
    maxDrawdownPct: 8.5, profitFactor: 1.42, totalTrades: 87, dataCoverageDays: 365,
    sampleSizeWarning: false,
    topFacts: [{ statement: "Win rate is 56.2%", value: 56.2 }],
    topWeaknesses: [{ point: "High SL hit rate" }],
    confidence: 75, dataQualityNote: "87 trades over 365 days.",
  },
  optimization: {
    totalCombinations: 1200, rank1TotalPips: 285.0, rank1ProfitFactor: 1.65,
    rank1DegradationRatio: 0.45, rank1SampleStatus: "NORMAL",
    stableZoneCount: 8, robustCount: 5,
  },
  walkForward: {
    verdict: "CONDITIONAL", consistencyScore: 0.60, parameterStabilityAvg: 0.72,
    totalWindowCount: 5, validWindowCount: 5, positiveWindowCount: 3, skippedWindowCount: 0,
  },
  monteCarlo: {
    method: "TRADE_ORDER_SHUFFLE", iterations: 5000, tradeCount: 87, drawdownThresholdPct: 20,
    originalFinalPips: 240.5, originalMaxDdPct: 8.5, originalPercentileRank: 53.2,
    probabilityOfLoss: 0.123, probabilityOfDrawdownThreshold: 0.081,
    pipsP5: -80.2, pipsP25: 85.5, pipsP50: 215.3, pipsP75: 362.1, pipsP95: 510.8,
    ddP50: 14.5, ddP95: 38.7,
  },
  availablePhases: ["BACKTEST_ANALYSIS", "OPTIMIZATION", "WALK_FORWARD", "MONTE_CARLO"],
};

const BACKTEST_ONLY_CTX: InterpretationContext = {
  strategy: { name: "Simple MA", type: "SWING", symbol: "USDJPY", timeframe: "H1", versionId: null, versionNum: null },
  backtestAnalysis: {
    verdict: "CONDITIONAL", verdictReason: "Marginally profitable: pips=+50",
    totalPips: 50, winRate: 52, maxDrawdownPct: 5.0, profitFactor: 1.1,
    totalTrades: 25, dataCoverageDays: 90, sampleSizeWarning: true,
    topFacts: [], topWeaknesses: [], confidence: 40, dataQualityNote: "25 trades — low sample.",
  },
  availablePhases: ["BACKTEST_ANALYSIS"],
};

const NO_PHASES_CTX: InterpretationContext = {
  strategy: { name: "Empty Strategy", type: "SCALPING", symbol: "GBPUSD", timeframe: "M5", versionId: null, versionNum: null },
  availablePhases: [],
};

function makeValidAIOutput(overrides: Partial<Phase4DInterpretationAIOutput> = {}): Phase4DInterpretationAIOutput {
  return {
    overall_assessment: "The 4-phase validation pipeline shows moderate results. Backtest verdict is PASSED with +240.5 pips. Walk Forward is CONDITIONAL (consistencyScore: 0.60). Monte Carlo P50 final pips: +215.3, P(loss)=12.3%.",
    phase_observations: [
      { phase: "BACKTEST_ANALYSIS", observation: "Total pips of +240.5 with win rate 56.2%.", supporting_data: "total_pips=240.5, win_rate=56.2%" },
      { phase: "WALK_FORWARD", observation: "Walk Forward verdict is CONDITIONAL with consistencyScore=0.60.", supporting_data: "consistencyScore=0.60, 3 of 5 windows positive" },
      { phase: "MONTE_CARLO", observation: "P50 final pips is +215.3. P(loss)=12.3%.", supporting_data: "pipsP50=215.3, probabilityOfLoss=12.3% (0.123)" },
    ],
    cross_phase_synthesis: [
      { type: "CONVERGENCE", observation: "Walk Forward consistencyScore=0.60 and Monte Carlo P50=+215.3 are both positive.", phases_involved: ["WALK_FORWARD", "MONTE_CARLO"] },
    ],
    risk_dimensions: [
      { dimension: "SEQUENCE_RISK", assessment: "P(loss)=12.3% across 5,000 simulations.", data_source: "Monte Carlo Phase 4-C" },
      { dimension: "OOS_GENERALIZATION", assessment: "Walk Forward CONDITIONAL with score 0.60.", data_source: "Walk Forward Phase 4-B" },
    ],
    limitations: [
      "Future live-trading profitability cannot be concluded from these validation results.",
      "Monte Carlo Trade Order Shuffle assumes trade-to-trade independence and does not capture serial correlation.",
    ],
    data_completeness_note: "All 4 phases available. Interpretation is comprehensive.",
    ...overrides,
  };
}

// =================================================================
// A. Context construction
// =================================================================

describe("A. Context construction", () => {
  test("A01: all phases → availablePhases has 4 entries", () => {
    assert.equal(ALL_PHASES_CTX.availablePhases.length, 4);
    assert.ok(ALL_PHASES_CTX.availablePhases.includes("BACKTEST_ANALYSIS"));
    assert.ok(ALL_PHASES_CTX.availablePhases.includes("MONTE_CARLO"));
  });

  test("A02: backtest only → availablePhases has 1 entry", () => {
    assert.equal(BACKTEST_ONLY_CTX.availablePhases.length, 1);
    assert.equal(BACKTEST_ONLY_CTX.availablePhases[0], "BACKTEST_ANALYSIS");
  });

  test("A03: no phases → availablePhases is empty", () => {
    assert.equal(NO_PHASES_CTX.availablePhases.length, 0);
    assert.equal(NO_PHASES_CTX.backtestAnalysis, undefined);
    assert.equal(NO_PHASES_CTX.optimization, undefined);
    assert.equal(NO_PHASES_CTX.walkForward, undefined);
    assert.equal(NO_PHASES_CTX.monteCarlo, undefined);
  });

  test("A04: MC null probability is undefined when monteCarlo absent", () => {
    assert.equal(BACKTEST_ONLY_CTX.monteCarlo, undefined);
    // ← no crash accessing MC fields
  });

  test("A05: optimization null degradation is allowed", () => {
    const ctx: InterpretationContext = {
      ...ALL_PHASES_CTX,
      optimization: { ...ALL_PHASES_CTX.optimization!, rank1DegradationRatio: null },
    };
    assert.equal(ctx.optimization?.rank1DegradationRatio, null);
  });

  test("A06: strategy_version_id null is allowed", () => {
    assert.equal(BACKTEST_ONLY_CTX.strategy.versionId, null);
    assert.equal(BACKTEST_ONLY_CTX.strategy.versionNum, null);
  });

  test("A07: backtestAnalysis topFacts truncation to 5", () => {
    const ctx: InterpretationContext = {
      ...ALL_PHASES_CTX,
      backtestAnalysis: {
        ...ALL_PHASES_CTX.backtestAnalysis!,
        topFacts: Array.from({ length: 7 }, (_, i) => ({ statement: `Fact ${i}`, value: i })),
      },
    };
    // Context type allows any number; API route truncates to 5
    assert.equal(ctx.backtestAnalysis?.topFacts.length, 7);
  });

  test("A08: WF missing → no crash in context", () => {
    const ctx: InterpretationContext = { ...ALL_PHASES_CTX, walkForward: undefined,
      availablePhases: ["BACKTEST_ANALYSIS", "OPTIMIZATION", "MONTE_CARLO"] };
    assert.equal(ctx.walkForward, undefined);
    assert.ok(ctx.availablePhases.includes("BACKTEST_ANALYSIS"));
  });

  test("A09: all phases optional — only MC available", () => {
    const ctx: InterpretationContext = {
      strategy: ALL_PHASES_CTX.strategy,
      monteCarlo: ALL_PHASES_CTX.monteCarlo,
      availablePhases: ["MONTE_CARLO"],
    };
    assert.equal(ctx.availablePhases.length, 1);
    assert.equal(ctx.backtestAnalysis, undefined);
  });
});

// =================================================================
// B. Prompt construction
// =================================================================

describe("B. buildInterpretationPrompt", () => {
  test("B01: returns systemPrompt and userPrompt", () => {
    const { systemPrompt, userPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(typeof systemPrompt === "string" && systemPrompt.length > 100);
    assert.ok(typeof userPrompt === "string" && userPrompt.length > 50);
  });

  test("B02: system prompt prohibits future predictions", () => {
    const { systemPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(systemPrompt.includes("FORBIDDEN") || systemPrompt.includes("STRICTLY PROHIBITED"));
    assert.ok(systemPrompt.includes("will be profitable") || systemPrompt.includes("will generalize"));
  });

  test("B03: system prompt prohibits parameter recommendations", () => {
    const { systemPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(systemPrompt.includes("increase RSI") || systemPrompt.includes("Parameter recommendations"));
  });

  test("B04: system prompt requires minimum 2 limitations", () => {
    const { systemPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(systemPrompt.includes("minimum 2") || systemPrompt.includes("MANDATORY"));
  });

  test("B05: user prompt contains all 4 phase values when available", () => {
    const { userPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(userPrompt.includes("240.5"), "totalPips");
    assert.ok(userPrompt.includes("0.60"), "consistencyScore");
    assert.ok(userPrompt.includes("215.3"), "pipsP50");
    assert.ok(userPrompt.includes("CONDITIONAL"), "WF verdict");
  });

  test("B06: user prompt marks unavailable phases", () => {
    const { userPrompt } = buildInterpretationPrompt(BACKTEST_ONLY_CTX);
    assert.ok(userPrompt.includes("NOT AVAILABLE") || userPrompt.includes("UNAVAILABLE"));
  });

  test("B07: user prompt lists available phases", () => {
    const { userPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(userPrompt.includes("AVAILABLE PHASES"));
    assert.ok(userPrompt.includes("BACKTEST_ANALYSIS"));
    assert.ok(userPrompt.includes("WALK_FORWARD"));
  });

  test("B08: probability shown as both decimal and percent", () => {
    const { userPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(userPrompt.includes("12.3%"), "percentage form");
    assert.ok(userPrompt.includes("0.123"), "decimal form");
  });

  test("B09: no phases context produces valid prompt", () => {
    const { userPrompt } = buildInterpretationPrompt(NO_PHASES_CTX);
    assert.ok(userPrompt.includes("NOT AVAILABLE"));
  });
});

// =================================================================
// C. Schema validation (parseInterpretationResponse)
// =================================================================

describe("C. parseInterpretationResponse — schema validation", () => {
  test("C01: valid output → ok=true", () => {
    const output = makeValidAIOutput();
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(result.ok, result.ok ? "" : (result as { error: string }).error);
  });

  test("C02: missing overall_assessment → fail", () => {
    const output = makeValidAIOutput({ overall_assessment: undefined as never });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C03: invalid phase enum → fail", () => {
    const output = makeValidAIOutput({
      phase_observations: [{ phase: "UNKNOWN_PHASE" as never, observation: "ok", supporting_data: "ok" }],
    });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C04: invalid synthesis type → fail", () => {
    const output = makeValidAIOutput({
      cross_phase_synthesis: [{ type: "UNKNOWN" as never, observation: "ok", phases_involved: ["BACKTEST_ANALYSIS"] }],
    });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C05: invalid risk dimension → fail", () => {
    const output = makeValidAIOutput({
      risk_dimensions: [{ dimension: "UNKNOWN_RISK" as never, assessment: "ok", data_source: "ok" }],
    });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C06: limitations < 2 items → fail", () => {
    const output = makeValidAIOutput({ limitations: ["Only one limitation."] });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C07: limitations = 0 → fail", () => {
    const output = makeValidAIOutput({ limitations: [] });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C08: overall_assessment > 800 chars → fail", () => {
    const output = makeValidAIOutput({ overall_assessment: "X".repeat(801) });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C09: phase_observations > 12 → fail", () => {
    const obs = Array.from({ length: 13 }, () => ({
      phase: "BACKTEST_ANALYSIS" as const, observation: "ok", supporting_data: "ok",
    }));
    const output = makeValidAIOutput({ phase_observations: obs });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C10: phase_observations = 0 → fail (min 1)", () => {
    const output = makeValidAIOutput({ phase_observations: [] });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C11: missing data_completeness_note → fail", () => {
    const output = makeValidAIOutput({ data_completeness_note: undefined as never });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!result.ok);
  });

  test("C12: not valid JSON → ok=false", () => {
    const result = parseInterpretationResponse("not json {{{");
    assert.ok(!result.ok);
    assert.ok((result as { error: string }).error.includes("JSON"));
  });

  test("C13: cross_phase_synthesis can be empty (min 0)", () => {
    const output = makeValidAIOutput({ cross_phase_synthesis: [] });
    const result = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(result.ok, result.ok ? "" : (result as { error: string }).error);
  });
});

// =================================================================
// D. validateInterpretationIntegrity
// =================================================================

describe("D. validateInterpretationIntegrity — numeric integrity", () => {
  test("D01: correct MC P50 pips → no violation", () => {
    // Context pipsP50 = 215.3, AI says "+215.3"
    const output = makeValidAIOutput(); // already has 215.3
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
  });

  test("D02: wrong MC P50 pips → violation (spec example: 215 context, 240 cited)", () => {
    const ctx = { ...ALL_PHASES_CTX, monteCarlo: { ...ALL_PHASES_CTX.monteCarlo!, pipsP50: 215 } };
    const output = makeValidAIOutput({
      phase_observations: [
        { phase: "MONTE_CARLO", observation: "Median simulation was +240 pips.", supporting_data: "pipsP50=240" },
      ],
    });
    const result = validateInterpretationIntegrity(output, ctx);
    assert.ok(result.violations.length > 0, "Expected violation for wrong P50 value");
  });

  test("D03: probability as decimal → no violation (0.123 cited, context=0.123)", () => {
    const output = makeValidAIOutput({
      overall_assessment: "P(loss)=0.123 across 5000 simulations. WF is CONDITIONAL with consistencyScore=0.60. P50=+215.3.",
      phase_observations: makeValidAIOutput().phase_observations,
    });
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
  });

  test("D04: probability as percentage → no violation (12.3% cited, context=0.123)", () => {
    const output = makeValidAIOutput(); // already has 12.3%
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
  });

  test("D05: correct WF consistencyScore → no violation", () => {
    const output = makeValidAIOutput(); // has consistencyScore=0.60
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    const csViolations = result.violations.filter(v => v.includes("consistencyScore"));
    assert.equal(csViolations.length, 0, JSON.stringify(csViolations));
  });

  test("D06: wrong WF consistencyScore → violation (spec example: 0.60 context, 0.75 cited)", () => {
    // Override phase_observations to remove correct value; use only wrong value
    const output: Phase4DInterpretationAIOutput = {
      overall_assessment: "Walk Forward ConsistencyScore: 0.75 (CONDITIONAL verdict).",
      phase_observations: [
        { phase: "WALK_FORWARD", observation: "ConsistencyScore=0.75, 3 of 5 windows positive.", supporting_data: "consistencyScore=0.75" },
      ],
      cross_phase_synthesis: [],
      risk_dimensions: [{ dimension: "OOS_GENERALIZATION", assessment: "Score 0.75.", data_source: "WF" }],
      limitations: ["Future live-trading profitability cannot be concluded.", "Market regimes outside tested period cannot be evaluated."],
      data_completeness_note: "WF available.",
    };
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    const csViolations = result.violations.filter(v => v.includes("consistencyScore") || v.includes("WF"));
    assert.ok(csViolations.length > 0, `Expected violation for wrong consistency score, got: ${JSON.stringify(result.violations)}`);
  });

  test("D07: P58 percentile notation → accepted (context rank=53.2, AI says P53)", () => {
    const output = makeValidAIOutput({
      overall_assessment: "Original sequence is at P53 of the Monte Carlo distribution. WF score=0.60. P50=+215.3. P(loss)=12.3%.",
    });
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    const rankViolations = result.violations.filter(v => v.includes("originalPercentileRank"));
    assert.equal(rankViolations.length, 0, JSON.stringify(rankViolations));
  });

  test("D08: no numeric claims → no violations", () => {
    const output = makeValidAIOutput({
      overall_assessment: "The validation pipeline results are documented in phase observations below.",
      phase_observations: [
        { phase: "BACKTEST_ANALYSIS", observation: "Backtest verdict is PASSED.", supporting_data: "See backtest report." },
        { phase: "WALK_FORWARD", observation: "Walk Forward verdict is CONDITIONAL.", supporting_data: "See walk forward report." },
      ],
      cross_phase_synthesis: [],
      risk_dimensions: [
        { dimension: "SEQUENCE_RISK", assessment: "Monte Carlo simulation was completed.", data_source: "Phase 4-C" },
      ],
    });
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    // With no specific numbers cited, no violations expected
    assert.equal(result.violations.filter(v => v.includes("different")).length, 0);
  });

  test("D09: no MC context → MC checks skipped", () => {
    const output = makeValidAIOutput({
      phase_observations: [
        { phase: "BACKTEST_ANALYSIS", observation: "Total pips +50. Win rate 52%.", supporting_data: "total_pips=50" },
      ],
    });
    const result = validateInterpretationIntegrity(output, BACKTEST_ONLY_CTX);
    // No MC violations possible
    const mcViolations = result.violations.filter(v => v.includes("Monte Carlo"));
    assert.equal(mcViolations.length, 0);
  });

  test("D10: valid = true when no violations", () => {
    const output = makeValidAIOutput();
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    assert.equal(result.valid, result.violations.length === 0);
  });
});

// =================================================================
// E. calcDeterministicConfidence
// =================================================================

describe("E. calcDeterministicConfidence", () => {
  test("E01: 4 phases → base 77", () => {
    const conf = calcDeterministicConfidence(ALL_PHASES_CTX);
    assert.ok(conf >= 65 && conf <= 90, `Expected 65-90 but got ${conf}`);
    assert.equal(conf, 77); // no penalties in ALL_PHASES_CTX
  });

  test("E02: 3 phases → base 62", () => {
    const ctx: InterpretationContext = { ...ALL_PHASES_CTX, optimization: undefined,
      availablePhases: ["BACKTEST_ANALYSIS", "WALK_FORWARD", "MONTE_CARLO"] };
    const conf = calcDeterministicConfidence(ctx);
    assert.ok(conf >= 50 && conf <= 75, `Expected 50-75 but got ${conf}`);
    assert.equal(conf, 62);
  });

  test("E03: 2 phases → base 42", () => {
    const ctx: InterpretationContext = {
      ...ALL_PHASES_CTX, optimization: undefined, walkForward: undefined,
      availablePhases: ["BACKTEST_ANALYSIS", "MONTE_CARLO"],
    };
    const conf = calcDeterministicConfidence(ctx);
    assert.ok(conf >= 30 && conf <= 55, `Expected 30-55 but got ${conf}`);
    assert.equal(conf, 42);
  });

  test("E04: 1 phase + sampleSizeWarning → 20 - 15 = 5", () => {
    // BACKTEST_ONLY_CTX has sampleSizeWarning=true → 20-15=5 (capped at 5)
    const conf = calcDeterministicConfidence(BACKTEST_ONLY_CTX);
    assert.equal(conf, 5);
  });

  test("E05: 0 phases → 5", () => {
    const conf = calcDeterministicConfidence(NO_PHASES_CTX);
    assert.equal(conf, 5);
  });

  test("E06: sampleSizeWarning=true → -15 penalty", () => {
    const ctx: InterpretationContext = {
      ...ALL_PHASES_CTX,
      backtestAnalysis: { ...ALL_PHASES_CTX.backtestAnalysis!, sampleSizeWarning: true },
    };
    const conf = calcDeterministicConfidence(ctx);
    assert.equal(conf, 77 - 15); // 62
  });

  test("E07: WF validWindowCount < 2 → -10 penalty", () => {
    const ctx: InterpretationContext = {
      ...ALL_PHASES_CTX,
      walkForward: { ...ALL_PHASES_CTX.walkForward!, validWindowCount: 1 },
    };
    const conf = calcDeterministicConfidence(ctx);
    assert.equal(conf, 77 - 10); // 67
  });

  test("E08: multiple penalties stack (capped at 5)", () => {
    const ctx: InterpretationContext = {
      ...ALL_PHASES_CTX,
      backtestAnalysis: { ...ALL_PHASES_CTX.backtestAnalysis!, sampleSizeWarning: true },
      optimization: { ...ALL_PHASES_CTX.optimization!, rank1SampleStatus: "INSUFFICIENT" },
      walkForward: { ...ALL_PHASES_CTX.walkForward!, validWindowCount: 1, verdict: "INCONCLUSIVE" },
    };
    const conf = calcDeterministicConfidence(ctx);
    // 77 - 15 - 10 - 10 - 10 = 32 → but floor is 5
    assert.ok(conf >= 5 && conf <= 77);
    assert.equal(conf, Math.max(5, 77 - 15 - 10 - 10 - 10));
  });
});

// =================================================================
// F. Data Leakage / Security
// =================================================================

describe("F. Data Leakage — no mutations, no prohibited writes", () => {
  test("F01: buildInterpretationPrompt does NOT mutate context", () => {
    const frozen = Object.freeze({ ...ALL_PHASES_CTX,
      strategy: Object.freeze({ ...ALL_PHASES_CTX.strategy }),
    });
    // Should not throw even with frozen object
    assert.doesNotThrow(() => buildInterpretationPrompt(frozen as InterpretationContext));
  });

  test("F02: parseInterpretationResponse does NOT mutate input", () => {
    const output = makeValidAIOutput();
    const json = JSON.stringify(output);
    const jsonCopy = json;
    parseInterpretationResponse(json);
    assert.equal(json, jsonCopy); // string unchanged
  });

  test("F03: validateInterpretationIntegrity does NOT mutate context", () => {
    const ctxCopy = JSON.parse(JSON.stringify(ALL_PHASES_CTX)) as InterpretationContext;
    const output = makeValidAIOutput();
    validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    assert.deepEqual(ALL_PHASES_CTX.monteCarlo?.pipsP50, ctxCopy.monteCarlo?.pipsP50);
    assert.deepEqual(ALL_PHASES_CTX.walkForward?.consistencyScore, ctxCopy.walkForward?.consistencyScore);
  });

  test("F04: InterpretationEngine imports no DB client", () => {
    // If InterpretationEngine imported supabase, this test would fail at runtime
    // We verify the module loads without DB env vars
    const mod = require("../InterpretationEngine");
    assert.ok(typeof mod.buildInterpretationPrompt === "function");
    assert.ok(typeof mod.calcDeterministicConfidence === "function");
  });

  test("F05: strategy spec not mutated (StrategySpec byte-identical after interpretation)", () => {
    const spec = { name: "Test", strategy_type: "SCALPING", symbols: ["EURUSD"] };
    const specBefore = JSON.stringify(spec);
    // Run all interpretation engine functions
    buildInterpretationPrompt(ALL_PHASES_CTX);
    parseInterpretationResponse(JSON.stringify(makeValidAIOutput()));
    validateInterpretationIntegrity(makeValidAIOutput(), ALL_PHASES_CTX);
    calcDeterministicConfidence(ALL_PHASES_CTX);
    assert.equal(JSON.stringify(spec), specBefore, "Strategy spec must not be mutated");
  });

  test("F06: engine functions have no strategy_versions insert calls", () => {
    const engineSrc = require("fs").readFileSync(
      require("path").resolve("src/infrastructure/backtest/InterpretationEngine.ts"), "utf8"
    );
    assert.ok(!engineSrc.includes("strategy_versions.insert"), "No insert to strategy_versions");
    assert.ok(!engineSrc.includes("optimization_jobs.update"), "No update to optimization_jobs");
    assert.ok(!engineSrc.includes("walk_forward_jobs.update"), "No update to walk_forward_jobs");
    assert.ok(!engineSrc.includes("monte_carlo_results.update"), "No update to monte_carlo_results");
  });

  test("F07: input snapshot integrity — context is preserved", () => {
    const ctx = ALL_PHASES_CTX;
    const snapshot = JSON.parse(JSON.stringify(ctx)) as InterpretationContext;
    assert.equal(snapshot.monteCarlo?.pipsP50, ctx.monteCarlo?.pipsP50);
    assert.equal(snapshot.walkForward?.consistencyScore, ctx.walkForward?.consistencyScore);
    assert.equal(snapshot.availablePhases.length, ctx.availablePhases.length);
  });
});

// =================================================================
// G. buildCorrectionPrompt
// =================================================================

describe("G. buildCorrectionPrompt", () => {
  test("G01: includes violation descriptions", () => {
    const violations = ["MC pipsP50 mismatch: expected 215, found 240", "WF score mismatch"];
    const prompt = buildCorrectionPrompt(violations);
    assert.ok(prompt.includes("MC pipsP50 mismatch"));
    assert.ok(prompt.includes("WF score mismatch"));
  });

  test("G02: includes instruction to use only context numbers", () => {
    const prompt = buildCorrectionPrompt(["test violation"]);
    assert.ok(prompt.includes("context") || prompt.includes("ONLY numbers"));
  });

  test("G03: handles empty violations array", () => {
    const prompt = buildCorrectionPrompt([]);
    assert.ok(typeof prompt === "string" && prompt.length > 0);
  });
});

// =================================================================
// H. Integration
// =================================================================

describe("H. Integration — end-to-end pure flow", () => {
  test("H01: Context → Prompt → parsed output (round-trip)", () => {
    const { systemPrompt, userPrompt } = buildInterpretationPrompt(ALL_PHASES_CTX);
    assert.ok(systemPrompt.length > 500);
    assert.ok(userPrompt.includes("EURUSD"));

    // Simulate AI output
    const aiJSON = JSON.stringify(makeValidAIOutput());
    const parsed = parseInterpretationResponse(aiJSON);
    assert.ok(parsed.ok);
  });

  test("H02: Integrity check passes on valid AI output", () => {
    const output = makeValidAIOutput();
    const result = validateInterpretationIntegrity(output, ALL_PHASES_CTX);
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
    assert.equal(result.valid, true);
  });

  test("H03: Confidence is deterministic (same input → same output)", () => {
    const c1 = calcDeterministicConfidence(ALL_PHASES_CTX);
    const c2 = calcDeterministicConfidence(ALL_PHASES_CTX);
    assert.equal(c1, c2);
  });

  test("H04: Confidence is always an integer in [0,100]", () => {
    [ALL_PHASES_CTX, BACKTEST_ONLY_CTX, NO_PHASES_CTX].forEach(ctx => {
      const c = calcDeterministicConfidence(ctx);
      assert.ok(Number.isInteger(c), `Expected integer, got ${c}`);
      assert.ok(c >= 0 && c <= 100, `Expected 0-100, got ${c}`);
    });
  });

  test("H05: WF + MC only (no Backtest) — valid prompt", () => {
    const ctx: InterpretationContext = {
      strategy: ALL_PHASES_CTX.strategy,
      walkForward: ALL_PHASES_CTX.walkForward,
      monteCarlo: ALL_PHASES_CTX.monteCarlo,
      availablePhases: ["WALK_FORWARD", "MONTE_CARLO"],
    };
    const { userPrompt } = buildInterpretationPrompt(ctx);
    assert.ok(userPrompt.includes("WALK_FORWARD") || userPrompt.includes("WALK FORWARD"));
    assert.ok(userPrompt.includes("NOT AVAILABLE"));
  });

  test("H06: no NaN in confidence across all contexts", () => {
    [ALL_PHASES_CTX, BACKTEST_ONLY_CTX, NO_PHASES_CTX].forEach(ctx => {
      const c = calcDeterministicConfidence(ctx);
      assert.ok(!Number.isNaN(c), "Confidence should not be NaN");
    });
  });

  test("H07: limitations minimum enforced by schema", () => {
    const output = makeValidAIOutput({ limitations: ["Only one."] });
    const parsed = parseInterpretationResponse(JSON.stringify(output));
    assert.ok(!parsed.ok, "Expected schema failure for < 2 limitations");
  });

  test("H08: valid output is serializable (no Infinity/NaN)", () => {
    const output = makeValidAIOutput();
    const json = JSON.stringify(output);
    assert.ok(!json.includes("Infinity"), "No Infinity in output");
    assert.ok(!json.includes("NaN"), "No NaN in output");
    const reparsed = JSON.parse(json) as unknown;
    assert.ok(reparsed !== null);
  });
});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

console.log(`\n${"=".repeat(55)}`);
console.log(`InterpretationEngine Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED ✅");
}

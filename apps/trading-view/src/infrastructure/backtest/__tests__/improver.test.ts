/**
 * Unit Tests — StrategyImprover + ImprovementSchema (Phase 3-B)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/improver.test.ts
 */

import assert from "node:assert/strict";
import {
  buildImprovementPrompt,
  parseImprovementResponse,
  applyChangesToSpec,
  conditionIndexExists,
  isAllowedField,
} from "../StrategyImprover";
import {
  validateWhitelist,
  validateFromValues,
  parseFieldPath,
} from "../ImprovementSchema";
import type { StrategySpec } from "@/lib/strategySchema";
import type { StrategyAIAnalysisRecord } from "../analysisSchema";

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

const SPEC: StrategySpec = {
  name:          "EURUSD RSI Reversal Scalping",
  strategy_type: "SCALPING",
  symbols:       ["EURUSD"],
  timeframes:    ["M5", "H1"],
  entry_conditions: {
    logic:      "AND",
    conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "REVERSAL", threshold: 30 },
    ],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
    take_profit: { method: "RR_RATIO", rr_ratio: 2 },
  },
  filters: {
    trend_filter:    { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
    max_spread_pips: 2,
  },
  risk: { risk_per_trade: 1.0 },
};

const SPEC_JSON = JSON.parse(JSON.stringify(SPEC)) as Record<string, unknown>;

const ANALYSIS: Pick<StrategyAIAnalysisRecord,
  "summary" | "facts" | "observations" | "hypotheses" | "weaknesses" | "recommendations"
  | "confidence" | "data_quality_note"> = {
  summary:    "Strategy is unprofitable with 21.4% win rate and -16.8 total pips.",
  confidence: 35,
  data_quality_note: "Only 14 trades; sample is insufficient.",
  facts: [
    { statement: "Win rate was 21.4%", source: "backtest_stats", value: 21.4 },
    { statement: "SL hit rate was 78.57%", source: "exit_stats", value: 78.57 },
    { statement: "Total pips: -16.8", source: "backtest_stats", value: -16.8 },
  ],
  observations: [
    { observation: "Most trades hit stop loss.", basis: "SL hit rate=78.57%", confidence: "HIGH" },
  ],
  hypotheses: [
    { hypothesis: "Hypothesis: RSI threshold may be too aggressive, causing premature entries.",
      rationale: "High SL rate suggests poor entry timing.", confidence: "LOW" },
  ],
  weaknesses: [
    { point: "Low win rate", detail: "21.4% wins only" },
    { point: "High SL hit rate", detail: "78.57% of trades hit SL" },
  ],
  recommendations: [
    { action: "Re-evaluate RSI threshold", priority: "HIGH",
      rationale: "Consider raising from 30 to reduce false reversals" },
  ],
};

// =================================================================
// ─── Tests ───────────────────────────────────────────────────────
// =================================================================

describe("1. isAllowedField — whitelist check", () => {
  test("threshold change is allowed", () => {
    assert.ok(isAllowedField("entry_conditions.conditions[0].threshold"));
  });
  test("period change is allowed", () => {
    assert.ok(isAllowedField("entry_conditions.conditions[0].period"));
  });
  test("operator change is allowed", () => {
    assert.ok(isAllowedField("entry_conditions.conditions[0].operator"));
  });
  test("entry_conditions.logic is allowed", () => {
    assert.ok(isAllowedField("entry_conditions.logic"));
  });
  test("filters.max_spread_pips is allowed", () => {
    assert.ok(isAllowedField("filters.max_spread_pips"));
  });
  test("exit_conditions.stop_loss.multiplier is allowed", () => {
    assert.ok(isAllowedField("exit_conditions.stop_loss.multiplier"));
  });
  test("exit_conditions.take_profit.rr_ratio is allowed", () => {
    assert.ok(isAllowedField("exit_conditions.take_profit.rr_ratio"));
  });
  test("add_condition is allowed", () => {
    assert.ok(isAllowedField("add_condition"));
  });
  test("strategy_type is FORBIDDEN", () => {
    assert.ok(!isAllowedField("strategy_type"));
  });
  test("symbols is FORBIDDEN", () => {
    assert.ok(!isAllowedField("symbols"));
  });
  test("timeframes is FORBIDDEN", () => {
    assert.ok(!isAllowedField("timeframes"));
  });
  test("risk.risk_per_trade is FORBIDDEN", () => {
    assert.ok(!isAllowedField("risk.risk_per_trade"));
  });
  test("risk is FORBIDDEN (prefix)", () => {
    assert.ok(!isAllowedField("risk"));
  });
  test("indicator change is FORBIDDEN", () => {
    assert.ok(!isAllowedField("entry_conditions.conditions[0].indicator"));
  });
  test("timeframe change is FORBIDDEN", () => {
    assert.ok(!isAllowedField("entry_conditions.conditions[0].timeframe"));
  });
  test("name is FORBIDDEN", () => {
    assert.ok(!isAllowedField("name"));
  });
});

describe("2. parseFieldPath", () => {
  test("condition path parses correctly", () => {
    const r = parseFieldPath("entry_conditions.conditions[2].threshold");
    assert.ok(r !== null && r.type === "condition");
    if (r?.type === "condition") {
      assert.equal(r.index, 2);
      assert.equal(r.leaf, "threshold");
    }
  });
  test("add_condition returns correct type", () => {
    const r = parseFieldPath("add_condition");
    assert.ok(r !== null && r.type === "add_condition");
  });
  test("simple path parses correctly", () => {
    const r = parseFieldPath("filters.max_spread_pips");
    assert.ok(r !== null && r.type === "simple");
    if (r?.type === "simple") assert.equal(r.path, "filters.max_spread_pips");
  });
  test("unknown path returns null", () => {
    assert.equal(parseFieldPath("symbols[0]"), null);
  });
});

describe("3. validateWhitelist — normal cases", () => {
  test("single modify threshold → valid", () => {
    const r = validateWhitelist([{
      field: "entry_conditions.conditions[0].threshold", type: "modify",
      from: 30, to: 25, reason: "reduce false entries", confidence: 0.6, fact_basis: "SL=78%",
    }]);
    assert.equal(r.valid, true, r.violations.join("; "));
  });

  test("3 changes → valid (max)", () => {
    const r = validateWhitelist([
      { field: "entry_conditions.conditions[0].threshold", type: "modify", from: 30, to: 28, reason: "r", confidence: 0.5, fact_basis: "f" },
      { field: "filters.max_spread_pips",                  type: "modify", from: 2,  to: 1.5, reason: "r", confidence: 0.4, fact_basis: "f" },
      { field: "exit_conditions.stop_loss.multiplier",     type: "modify", from: 1.5, to: 2.0, reason: "r", confidence: 0.5, fact_basis: "f" },
    ]);
    assert.equal(r.valid, true, r.violations.join("; "));
  });

  test("add_condition → valid", () => {
    const r = validateWhitelist([{
      field: "add_condition", type: "add",
      from: null, to: { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      reason: "add trend filter", confidence: 0.5, fact_basis: "f",
    }]);
    assert.equal(r.valid, true, r.violations.join("; "));
  });
});

describe("4. validateWhitelist — violation cases", () => {
  test("4 changes → FAIL (max is 3)", () => {
    const changes = Array(4).fill(null).map((_, i) => ({
      field: `entry_conditions.conditions[${i}].threshold`, type: "modify" as const,
      from: 30, to: 25, reason: "reason longer than 10 chars", confidence: 0.5, fact_basis: "f",
    }));
    const r = validateWhitelist(changes);
    assert.equal(r.valid, false, "Should fail: 4 changes");
    assert.ok(r.violations.some(v => v.includes("maximum") || v.includes("Duplicate") || v.includes("whitelist")));
  });

  test("forbidden: strategy_type → FAIL", () => {
    const r = validateWhitelist([{
      field: "strategy_type", type: "modify",
      from: "SCALPING", to: "DAY_TRADE",
      reason: "change strategy type", confidence: 0.5, fact_basis: "f",
    }]);
    assert.equal(r.valid, false);
    assert.ok(r.violations.some(v => v.includes("Forbidden field")));
  });

  test("forbidden: symbols → FAIL", () => {
    const r = validateWhitelist([{
      field: "symbols", type: "modify",
      from: ["EURUSD"], to: ["USDJPY"],
      reason: "change symbol", confidence: 0.5, fact_basis: "f",
    }]);
    assert.equal(r.valid, false);
    assert.ok(r.violations.some(v => v.includes("Forbidden field")));
  });

  test("forbidden: timeframes → FAIL", () => {
    const r = validateWhitelist([{
      field: "timeframes", type: "modify",
      from: ["M5"], to: ["H1"],
      reason: "change timeframe", confidence: 0.5, fact_basis: "f",
    }]);
    assert.equal(r.valid, false);
  });

  test("forbidden: risk.risk_per_trade → FAIL", () => {
    const r = validateWhitelist([{
      field: "risk.risk_per_trade", type: "modify",
      from: 1.0, to: 2.0,
      reason: "increase risk", confidence: 0.5, fact_basis: "f",
    }]);
    assert.equal(r.valid, false);
  });

  test("forbidden: indicator change → FAIL", () => {
    const r = validateWhitelist([{
      field: "entry_conditions.conditions[0].indicator", type: "modify",
      from: "RSI", to: "MACD",
      reason: "change indicator", confidence: 0.5, fact_basis: "f",
    }]);
    assert.equal(r.valid, false);
    assert.ok(r.violations.some(v => v.includes("Forbidden field")));
  });

  test("2 add_condition changes → FAIL", () => {
    const r = validateWhitelist([
      { field: "add_condition", type: "add", from: null,
        to: { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
        reason: "add first condition", confidence: 0.5, fact_basis: "f" },
      { field: "add_condition", type: "add", from: null,
        to: { indicator: "ADX", timeframe: "M5", period: 14, operator: "ABOVE", threshold: 25 },
        reason: "add second condition", confidence: 0.5, fact_basis: "f" },
    ]);
    assert.equal(r.valid, false);
    assert.ok(r.violations.some(v => v.includes("add_condition") || v.includes("Duplicate")));
  });

  test("duplicate field → FAIL", () => {
    const r = validateWhitelist([
      { field: "entry_conditions.conditions[0].threshold", type: "modify",
        from: 30, to: 25, reason: "reason10chars+", confidence: 0.5, fact_basis: "f" },
      { field: "entry_conditions.conditions[0].threshold", type: "modify",
        from: 25, to: 20, reason: "reason10chars+", confidence: 0.5, fact_basis: "f" },
    ]);
    assert.equal(r.valid, false);
    assert.ok(r.violations.some(v => v.includes("Duplicate")));
  });

  test("field not in whitelist → FAIL", () => {
    const r = validateWhitelist([{
      field: "entry_conditions.conditions[0].condition", type: "modify",
      from: "old", to: "new",
      reason: "change description text", confidence: 0.5, fact_basis: "f",
    }]);
    assert.equal(r.valid, false);
  });
});

describe("5. validateFromValues", () => {
  test("matching from value → valid", () => {
    const r = validateFromValues([{
      field: "entry_conditions.conditions[0].threshold", type: "modify",
      from: 30, to: 25,
      reason: "adjustment", confidence: 0.5, fact_basis: "f",
    }], SPEC_JSON);
    assert.equal(r.valid, true, r.violations.join("; "));
  });

  test("non-matching from value → FAIL", () => {
    const r = validateFromValues([{
      field: "entry_conditions.conditions[0].threshold", type: "modify",
      from: 28, to: 25,  // actual is 30, not 28
      reason: "adjustment", confidence: 0.5, fact_basis: "f",
    }], SPEC_JSON);
    assert.equal(r.valid, false);
    assert.ok(r.violations.some(v => v.includes("from=28") || v.includes("from")));
  });

  test("add type skips from validation", () => {
    const r = validateFromValues([{
      field: "add_condition", type: "add",
      from: null,
      to: { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      reason: "add filter", confidence: 0.5, fact_basis: "f",
    }], SPEC_JSON);
    assert.equal(r.valid, true);
  });

  test("matching multiplier from value → valid", () => {
    const r = validateFromValues([{
      field: "exit_conditions.stop_loss.multiplier", type: "modify",
      from: 1.5, to: 2.0,
      reason: "widen SL", confidence: 0.5, fact_basis: "f",
    }], SPEC_JSON);
    assert.equal(r.valid, true, r.violations.join("; "));
  });
});

describe("6. applyChangesToSpec — valid changes", () => {
  test("modify threshold produces valid spec", () => {
    const proposed = applyChangesToSpec(SPEC, [{
      field: "entry_conditions.conditions[0].threshold", type: "modify",
      from: 30, to: 25,
      reason: "raise RSI threshold to reduce false signals", confidence: 0.6, fact_basis: "SL=78%",
    }]);
    assert.equal(proposed.entry_conditions.conditions[0]!.threshold, 25);
    // Other fields unchanged
    assert.equal(proposed.entry_conditions.conditions[0]!.indicator, "RSI");
    assert.equal(proposed.symbols[0], "EURUSD");
  });

  test("modify max_spread_pips produces valid spec", () => {
    const proposed = applyChangesToSpec(SPEC, [{
      field: "filters.max_spread_pips", type: "modify",
      from: 2, to: 1.5,
      reason: "tighten spread filter", confidence: 0.5, fact_basis: "spread quality",
    }]);
    assert.equal(proposed.filters?.max_spread_pips, 1.5);
  });

  test("modify exit stop_loss multiplier", () => {
    const proposed = applyChangesToSpec(SPEC, [{
      field: "exit_conditions.stop_loss.multiplier", type: "modify",
      from: 1.5, to: 2.0,
      reason: "widen SL to reduce premature hits", confidence: 0.6, fact_basis: "SL=78%",
    }]);
    assert.equal(proposed.exit_conditions?.stop_loss?.multiplier, 2.0);
  });

  test("add_condition appends new condition", () => {
    const proposed = applyChangesToSpec(SPEC, [{
      field: "add_condition", type: "add",
      from: null,
      to: { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      reason: "add trend confirmation", confidence: 0.5, fact_basis: "trend hypothesis",
    }]);
    assert.equal(proposed.entry_conditions.conditions.length, 2);
    assert.equal(proposed.entry_conditions.conditions[1]!.indicator, "EMA");
  });

  test("proposed_spec passes StrategySpecSchema", () => {
    // If applyChangesToSpec doesn't throw, schema passed
    const proposed = applyChangesToSpec(SPEC, [{
      field: "entry_conditions.conditions[0].threshold", type: "modify",
      from: 30, to: 25,
      reason: "adjust threshold for better signals", confidence: 0.6, fact_basis: "WR=21%",
    }]);
    assert.equal(typeof proposed, "object");
    assert.equal(proposed.name, SPEC.name);
  });
});

describe("7. applyChangesToSpec — invalid changes rejected", () => {
  test("invalid threshold (out of range) → throws", () => {
    assert.throws(() => applyChangesToSpec(SPEC, [{
      field: "entry_conditions.conditions[0].threshold", type: "modify",
      from: 30, to: 99999,  // StrategySpecSchema max is 10000
      reason: "extreme threshold", confidence: 0.5, fact_basis: "f",
    }]), /validation|failed|threshold/i);
  });

  test("invalid period (negative) → throws", () => {
    assert.throws(() => applyChangesToSpec(SPEC, [{
      field: "entry_conditions.conditions[0].period", type: "modify",
      from: 14, to: -5,
      reason: "negative period", confidence: 0.5, fact_basis: "f",
    }]), /validation|failed|period/i);
  });

  test("invalid operator → throws", () => {
    assert.throws(() => applyChangesToSpec(SPEC, [{
      field: "entry_conditions.conditions[0].operator", type: "modify",
      from: "REVERSAL", to: "INVALID_OP",
      reason: "bad operator", confidence: 0.5, fact_basis: "f",
    }]), /validation|failed|operator/i);
  });
});

describe("8. parseImprovementResponse", () => {
  const validProposal = JSON.stringify({
    changes: [{
      field: "entry_conditions.conditions[0].threshold",
      type:  "modify",
      from:  30,
      to:    28,
      reason: "Slightly raising RSI threshold may reduce premature reversal entries.",
      confidence: 0.55,
      fact_basis: "SL hit rate=78.57%, win_rate=21.4%",
    }],
    expected_effects: {
      hypothesis: "Hypothesis: Raising threshold from 30 to 28 may reduce false reversal signals.",
      metric_targets: {
        win_rate:      "May improve from 21% to 28-32%",
        profit_factor: "May improve from 0.70 to 0.85-1.0",
      },
    },
    risks: [
      "May reduce trade frequency significantly.",
      "Insufficient data to confirm this hypothesis.",
    ],
    confidence:         42,
    requires_more_data: true,
  });

  test("valid JSON → ok=true", () => {
    const r = parseImprovementResponse(validProposal);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  test("changes array has 1 item", () => {
    const r = parseImprovementResponse(validProposal);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.proposal.changes.length, 1);
  });

  test("requires_more_data=true is preserved", () => {
    const r = parseImprovementResponse(validProposal);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.proposal.requires_more_data, true);
  });

  test("invalid JSON → error", () => {
    const r = parseImprovementResponse("not json");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.includes("not valid JSON"));
  });

  test("missing changes → error", () => {
    const r = parseImprovementResponse(JSON.stringify({
      expected_effects: { hypothesis: "h", metric_targets: {} },
      risks: ["r"], confidence: 50, requires_more_data: false,
    }));
    assert.equal(r.ok, false);
  });

  test("empty changes array → error (min 1)", () => {
    const r = parseImprovementResponse(JSON.stringify({
      changes: [],
      expected_effects: { hypothesis: "h", metric_targets: {} },
      risks: ["r"], confidence: 50, requires_more_data: false,
    }));
    assert.equal(r.ok, false);
  });

  test("confidence > 100 → error", () => {
    const r = parseImprovementResponse(JSON.stringify({
      changes: [{
        field: "entry_conditions.conditions[0].threshold", type: "modify",
        from: 30, to: 25,
        reason: "long enough reason here", confidence: 0.5, fact_basis: "facts",
      }],
      expected_effects: { hypothesis: "h", metric_targets: {} },
      risks: ["r"], confidence: 150, requires_more_data: false,
    }));
    assert.equal(r.ok, false);
  });
});

describe("9. buildImprovementPrompt", () => {
  const { systemPrompt, userPrompt } = buildImprovementPrompt(ANALYSIS, SPEC, true);

  test("systemPrompt contains whitelist", () => {
    assert.ok(systemPrompt.includes("entry_conditions.conditions[N].threshold"),
      "Missing threshold in whitelist");
  });

  test("systemPrompt forbids strategy_type", () => {
    assert.ok(systemPrompt.includes("strategy_type") && systemPrompt.includes("FORBIDDEN"),
      "Missing strategy_type in forbidden list");
  });

  test("systemPrompt requires 'from' to match current spec", () => {
    assert.ok(systemPrompt.includes("from") && systemPrompt.includes("MUST match"),
      "Missing from-value requirement");
  });

  test("systemPrompt requires hypothesis language", () => {
    assert.ok(systemPrompt.includes("may") || systemPrompt.includes("hypothesis"),
      "Missing hypothesis language requirement");
  });

  test("systemPrompt max 3 changes", () => {
    assert.ok(systemPrompt.includes("3") && systemPrompt.includes("MAXIMUM"),
      "Missing 3-change limit");
  });

  test("userPrompt contains strategy name", () => {
    assert.ok(userPrompt.includes("EURUSD RSI Reversal Scalping"));
  });

  test("userPrompt contains current spec values", () => {
    assert.ok(userPrompt.includes("threshold=30"), "Missing threshold=30 in spec");
    assert.ok(userPrompt.includes("multiplier"), "Missing multiplier in spec");
  });

  test("userPrompt contains analysis facts", () => {
    assert.ok(userPrompt.includes("21.4") || userPrompt.includes("SL"),
      "Missing analysis facts");
  });

  test("requires_more_data=true → sample warning in prompt", () => {
    assert.ok(userPrompt.includes("SAMPLE SIZE WARNING") || userPrompt.includes("sample"),
      "Missing sample size warning");
  });
});

describe("10. conditionIndexExists", () => {
  test("index 0 exists (spec has 1 condition)", () => {
    assert.equal(conditionIndexExists(SPEC, 0), true);
  });
  test("index 1 does not exist", () => {
    assert.equal(conditionIndexExists(SPEC, 1), false);
  });
  test("index -1 does not exist", () => {
    assert.equal(conditionIndexExists(SPEC, -1), false);
  });
});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

console.log(`\n${"─".repeat(55)}`);
console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}`);
if (failed > 0) process.exit(1);

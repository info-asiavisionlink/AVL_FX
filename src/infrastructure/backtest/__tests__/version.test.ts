/**
 * Unit Tests — VersionSchema + VersionComparator (Phase 3-C)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/version.test.ts
 */

import assert from "node:assert/strict";
import {
  extractBacktestSummary,
  getNextVersion,
  isValidTransition,
  generateChangeSummary,
  type BacktestSummary,
} from "../VersionSchema";
import { compareVersions } from "../VersionComparator";
import type { ChangeItem } from "../ImprovementSchema";

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

function makeSummary(overrides: Partial<BacktestSummary> = {}): BacktestSummary {
  return {
    totalTrades:       40,
    wins:              18,
    losses:            22,
    winRate:           45.0,
    totalPips:         32.5,
    profitFactor:      1.35,
    maxDrawdown:       120,
    maxDrawdownPct:    1.2,
    maxConsWins:       5,
    maxConsLosses:     6,
    avgDurationMin:    72,
    sampleSizeWarning: false,
    bestSession:       "LONDON",
    worstSession:      "NEW_YORK",
    verdict:           "PASSED",
    dataCoverageDays:  90,
    ...overrides,
  };
}

// EURUSD RSI Reversal "失敗" ベースライン（実データ相当）
const FAILING_V1 = makeSummary({
  totalTrades:       14,
  wins:              3,
  losses:            11,
  winRate:           21.43,
  totalPips:         -16.8,
  profitFactor:      0.70,
  maxDrawdownPct:    0.05,
  maxConsWins:       1,
  maxConsLosses:     9,
  sampleSizeWarning: true,
  verdict:           "FAILED",
  dataCoverageDays:  5,
});

// =================================================================
// ─── Tests ───────────────────────────────────────────────────────
// =================================================================

describe("1. extractBacktestSummary", () => {
  test("full DB row → BacktestSummary", () => {
    const row = {
      total_trades: "40", wins: "18", losses: "22",
      win_rate: "45.0", total_pips: "32.5", profit_factor: "1.35",
      max_drawdown: "120", max_drawdown_pct: "1.2",
      max_cons_wins: "5", max_cons_losses: "6",
      avg_duration_min: "72", sample_size_warning: false,
      best_session: "LONDON", worst_session: "NEW_YORK",
      verdict: "PASSED", data_coverage_days: "90",
    };
    const s = extractBacktestSummary(row);
    assert.ok(s !== null);
    assert.equal(s!.totalTrades, 40);
    assert.equal(s!.winRate, 45.0);
    assert.equal(s!.profitFactor, 1.35);
    assert.equal(s!.bestSession, "LONDON");
    assert.equal(s!.verdict, "PASSED");
  });

  test("null profit_factor → null", () => {
    const row = {
      total_trades: 5, wins: 5, losses: 0,
      win_rate: 100, total_pips: 20, profit_factor: null,
      max_drawdown: 0, max_drawdown_pct: 0,
      max_cons_wins: 5, max_cons_losses: 0,
      avg_duration_min: 60, sample_size_warning: true,
      best_session: null, worst_session: null,
      verdict: "PASSED", data_coverage_days: 10,
    };
    const s = extractBacktestSummary(row);
    assert.equal(s!.profitFactor, null);
  });

  test("null/undefined input → null", () => {
    assert.equal(extractBacktestSummary(null), null);
    assert.equal(extractBacktestSummary(undefined), null);
  });
});

describe("2. getNextVersion", () => {
  test("empty list → 1 (initial version)", () => {
    assert.equal(getNextVersion([]), 1);
  });

  test("single version [v1] → 2", () => {
    assert.equal(getNextVersion([{ version: 1 }]), 2);
  });

  test("out of order [v3, v1, v2] → 4", () => {
    assert.equal(getNextVersion([{ version: 3 }, { version: 1 }, { version: 2 }]), 4);
  });

  test("large version number → increments correctly", () => {
    assert.equal(getNextVersion([{ version: 99 }]), 100);
  });
});

describe("3. isValidTransition", () => {
  test("PROPOSED → apply → valid", () => {
    assert.equal(isValidTransition("PROPOSED", "apply"), true);
  });
  test("PROPOSED → reject → valid", () => {
    assert.equal(isValidTransition("PROPOSED", "reject"), true);
  });
  test("APPLIED → apply → INVALID", () => {
    assert.equal(isValidTransition("APPLIED", "apply"), false);
  });
  test("APPLIED → reject → INVALID", () => {
    assert.equal(isValidTransition("APPLIED", "reject"), false);
  });
  test("REJECTED → apply → INVALID", () => {
    assert.equal(isValidTransition("REJECTED", "apply"), false);
  });
  test("REJECTED → reject → INVALID", () => {
    assert.equal(isValidTransition("REJECTED", "reject"), false);
  });
  test("unknown status → INVALID", () => {
    assert.equal(isValidTransition("UNKNOWN", "apply"), false);
  });
});

describe("4. generateChangeSummary", () => {
  const changes: ChangeItem[] = [
    {
      field: "exit_conditions.stop_loss.multiplier", type: "modify",
      from: 1.5, to: 1.0,
      reason: "reduce SL hits", confidence: 0.6, fact_basis: "SL=78%",
    },
  ];

  test("single modify → readable summary", () => {
    const s = generateChangeSummary(changes);
    assert.ok(s.includes("1.5") || s.includes("multiplier"), `got: ${s}`);
  });

  test("add condition → mentions 'Added'", () => {
    const addChange: ChangeItem[] = [{
      field: "add_condition", type: "add",
      from: null,
      to: { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      reason: "add EMA filter", confidence: 0.5, fact_basis: "trend hypothesis",
    }];
    const s = generateChangeSummary(addChange);
    assert.ok(s.includes("Added") && s.includes("EMA"), `got: ${s}`);
  });

  test("empty changes → empty string", () => {
    assert.equal(generateChangeSummary([]), "");
  });

  test("multiple changes → semicolon separated", () => {
    const multi: ChangeItem[] = [
      { field: "exit_conditions.stop_loss.multiplier", type: "modify", from: 1.5, to: 1.0,
        reason: "r", confidence: 0.5, fact_basis: "f" },
      { field: "filters.sessions", type: "modify", from: null, to: ["NEW_YORK"],
        reason: "r", confidence: 0.5, fact_basis: "f" },
    ];
    const s = generateChangeSummary(multi);
    assert.ok(s.includes(";"), `Should have semicolon: ${s}`);
  });
});

describe("5. compareVersions — IMPROVED verdict", () => {
  test("all metrics improved → IMPROVED", () => {
    const v1 = makeSummary({ totalPips: 10, winRate: 40, profitFactor: 1.1, maxDrawdownPct: 3.0 });
    const v2 = makeSummary({ totalPips: 30, winRate: 50, profitFactor: 1.4, maxDrawdownPct: 1.5 });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "IMPROVED", `Got: ${r.verdict}`);
    assert.ok(r.improvements.length > 0);
    assert.equal(r.regressions.length, 0);
  });

  test("pips +20, PF +0.3 → IMPROVED (no sample warning)", () => {
    const v1 = makeSummary({ totalPips: 10, profitFactor: 1.0 });
    const v2 = makeSummary({ totalPips: 30, profitFactor: 1.3 });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "IMPROVED");
  });

  test("v1 FAILED, v2 PASSED → IMPROVED", () => {
    const v1 = makeSummary({ totalPips: -20, profitFactor: 0.7, winRate: 25, verdict: "FAILED" });
    const v2 = makeSummary({ totalPips: 30, profitFactor: 1.4, winRate: 55, maxDrawdownPct: 1.0 });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "IMPROVED");
  });

  test("improvements list populated correctly", () => {
    const v1 = makeSummary({ totalPips: 0, winRate: 40 });
    const v2 = makeSummary({ totalPips: 20, winRate: 50 });
    const r = compareVersions(v1, v2);
    const metrics = r.improvements.map(i => i.metric);
    assert.ok(metrics.includes("totalPips"),  `improvements: ${metrics.join(", ")}`);
    assert.ok(metrics.includes("winRate"),     `improvements: ${metrics.join(", ")}`);
  });
});

describe("6. compareVersions — REGRESSION verdict", () => {
  test("all metrics regressed → REGRESSION", () => {
    const v1 = makeSummary({ totalPips: 30, winRate: 50, profitFactor: 1.4, maxDrawdownPct: 1.0 });
    const v2 = makeSummary({ totalPips: 10, winRate: 38, profitFactor: 1.0, maxDrawdownPct: 3.0 });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "REGRESSION", `Got: ${r.verdict}`);
    assert.ok(r.regressions.length > 0);
  });

  test("pips dropped -20, PF dropped -0.3 → REGRESSION", () => {
    const v1 = makeSummary({ totalPips: 30, profitFactor: 1.4 });
    const v2 = makeSummary({ totalPips: 5,  profitFactor: 1.0 });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "REGRESSION");
  });

  test("v1 PASSED, v2 FAILED → REGRESSION", () => {
    const v1 = makeSummary({ totalPips: 30, profitFactor: 1.5, winRate: 55, verdict: "PASSED" });
    const v2 = makeSummary({ totalPips: -10, profitFactor: 0.8, winRate: 30, verdict: "FAILED" });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "REGRESSION");
  });

  test("regressions list populated correctly", () => {
    const v1 = makeSummary({ totalPips: 30, maxDrawdownPct: 1.0 });
    const v2 = makeSummary({ totalPips: 10, maxDrawdownPct: 5.0 });
    const r = compareVersions(v1, v2);
    const metrics = r.regressions.map(i => i.metric);
    assert.ok(metrics.includes("totalPips"),      `regressions: ${metrics.join(", ")}`);
    assert.ok(metrics.includes("maxDrawdownPct"), `regressions: ${metrics.join(", ")}`);
  });
});

describe("7. compareVersions — CONDITIONAL verdict", () => {
  test("pips improved but WR dropped → CONDITIONAL", () => {
    const v1 = makeSummary({ totalPips: 10, winRate: 55 });
    const v2 = makeSummary({ totalPips: 25, winRate: 40 });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "CONDITIONAL", `Got: ${r.verdict}`);
  });

  test("IMPROVED metrics but sample warning → CONDITIONAL", () => {
    const v1 = makeSummary({ totalPips: 10, winRate: 35, sampleSizeWarning: false });
    const v2 = makeSummary({ totalPips: 25, winRate: 50, sampleSizeWarning: true });
    const r = compareVersions(v1, v2);
    // improvements > 0, but sampleSizeWarning → CONDITIONAL
    assert.equal(r.verdict, "CONDITIONAL");
  });

  test("below-threshold changes → CONDITIONAL (effectively unchanged)", () => {
    const v1 = makeSummary({ totalPips: 10.0, winRate: 45.0, profitFactor: 1.2 });
    const v2 = makeSummary({ totalPips: 12.0, winRate: 46.0, profitFactor: 1.25 }); // all within threshold
    const r = compareVersions(v1, v2);
    // No meaningful improvements, no regressions → CONDITIONAL
    assert.ok(["CONDITIONAL", "INCONCLUSIVE"].includes(r.verdict), `Got: ${r.verdict}`);
  });

  test("both FAILED but v2 less bad → CONDITIONAL", () => {
    const v1 = makeSummary({ totalPips: -30, winRate: 20, profitFactor: 0.5, verdict: "FAILED", sampleSizeWarning: false });
    const v2 = makeSummary({ totalPips: -10, winRate: 35, profitFactor: 0.9, verdict: "FAILED", sampleSizeWarning: false });
    const r = compareVersions(v1, v2);
    // Improvement even though both FAILED
    assert.ok(["CONDITIONAL", "IMPROVED"].includes(r.verdict), `Got: ${r.verdict}`);
  });
});

describe("8. compareVersions — INCONCLUSIVE verdict", () => {
  test("both sampleSizeWarning=true → INCONCLUSIVE", () => {
    const v1 = makeSummary({ totalPips: -16.8, sampleSizeWarning: true, totalTrades: 14 });
    const v2 = makeSummary({ totalPips: -8.4,  sampleSizeWarning: true, totalTrades: 10 });
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "INCONCLUSIVE", `Got: ${r.verdict}`);
  });

  test("trade count dropped > 50% → INCONCLUSIVE", () => {
    const v1 = makeSummary({ totalTrades: 40, sampleSizeWarning: false });
    const v2 = makeSummary({ totalTrades: 15, sampleSizeWarning: false });  // 15/40 = 37.5% < 50%
    const r = compareVersions(v1, v2);
    assert.equal(r.verdict, "INCONCLUSIVE", `Got: ${r.verdict}`);
  });

  test("trade count drop warning is generated", () => {
    const v1 = makeSummary({ totalTrades: 40 });
    const v2 = makeSummary({ totalTrades: 15 });
    const r = compareVersions(v1, v2);
    assert.ok(r.warnings.some(w => w.includes("Trade count dropped")), `warnings: ${r.warnings}`);
  });

  test("sample size warning is generated when curr has warning", () => {
    const v1 = makeSummary({ sampleSizeWarning: false });
    const v2 = makeSummary({ sampleSizeWarning: true, totalTrades: 14 });
    const r = compareVersions(v1, v2);
    assert.ok(r.warnings.some(w => w.includes("insufficient sample")), `warnings: ${r.warnings}`);
  });
});

describe("9. compareVersions — unchanged metrics", () => {
  test("below-threshold change goes to unchanged", () => {
    const v1 = makeSummary({ totalPips: 10.0 });
    const v2 = makeSummary({ totalPips: 12.0 }); // diff=2 < threshold=5
    const r = compareVersions(v1, v2);
    const unch = r.unchanged.map(u => u.metric);
    assert.ok(unch.includes("totalPips"), `unchanged: ${unch.join(", ")}`);
  });

  test("unchanged list contains metrics not in improvements or regressions", () => {
    const v1 = makeSummary({ totalPips: 10, maxDrawdownPct: 1.2 });
    const v2 = makeSummary({ totalPips: 25, maxDrawdownPct: 1.3 }); // DD within threshold
    const r = compareVersions(v1, v2);
    const allMetrics = [
      ...r.improvements.map(i => i.metric),
      ...r.regressions.map(i => i.metric),
      ...r.unchanged.map(u => u.metric),
    ];
    // No metric should appear twice
    const unique = new Set(allMetrics.filter(m => m !== "bestSession"));
    assert.equal(unique.size, allMetrics.filter(m => m !== "bestSession").length,
      `Duplicate metric: ${allMetrics}`);
  });
});

describe("10. compareVersions — null profitFactor handling", () => {
  test("both null → unchanged (cannot compare)", () => {
    const v1 = makeSummary({ profitFactor: null });
    const v2 = makeSummary({ profitFactor: null });
    const r = compareVersions(v1, v2);
    const pfItems = [...r.improvements, ...r.regressions, ...r.unchanged]
      .filter(i => i.metric === "profitFactor");
    assert.equal(pfItems.length, 1);
    assert.equal(pfItems[0]!.delta, null);
  });

  test("prev null, curr non-null → goes to unchanged (not comparable)", () => {
    const v1 = makeSummary({ profitFactor: null });
    const v2 = makeSummary({ profitFactor: 1.5 });
    const r = compareVersions(v1, v2);
    const pfItem = [...r.improvements, ...r.regressions, ...r.unchanged]
      .find(i => i.metric === "profitFactor");
    assert.ok(pfItem !== undefined);
    assert.equal(pfItem!.delta, null);
  });
});

describe("11. compareVersions — summary text", () => {
  test("IMPROVED → summary mentions 'improvement'", () => {
    const v1 = makeSummary({ totalPips: 10, winRate: 35, profitFactor: 1.0 });
    const v2 = makeSummary({ totalPips: 40, winRate: 55, profitFactor: 1.6, maxDrawdownPct: 0.5 });
    const r = compareVersions(v1, v2);
    assert.ok(r.summary.toLowerCase().includes("improve"), `summary: ${r.summary}`);
  });

  test("REGRESSION → summary mentions 'regression'", () => {
    const v1 = makeSummary({ totalPips: 30, winRate: 50 });
    const v2 = makeSummary({ totalPips: 5,  winRate: 30 });
    const r = compareVersions(v1, v2);
    assert.ok(r.summary.toLowerCase().includes("regress"), `summary: ${r.summary}`);
  });

  test("INCONCLUSIVE → summary mentions 'insufficient'", () => {
    const v1 = FAILING_V1;
    const v2 = { ...FAILING_V1, totalTrades: 8 };
    const r = compareVersions(v1, v2);
    assert.ok(r.summary.toLowerCase().includes("insufficient") || r.summary.toLowerCase().includes("cannot"),
      `summary: ${r.summary}`);
  });
});

describe("12. compareVersions — delta calculations", () => {
  test("delta is curr - prev for pips", () => {
    const v1 = makeSummary({ totalPips: 10 });
    const v2 = makeSummary({ totalPips: 25 });
    const r = compareVersions(v1, v2);
    const pipItem = [...r.improvements, ...r.unchanged].find(i => i.metric === "totalPips");
    assert.ok(pipItem !== undefined);
    assert.equal(pipItem!.delta, 15);  // 25 - 10
  });

  test("before/after values are preserved", () => {
    const v1 = makeSummary({ winRate: 35 });
    const v2 = makeSummary({ winRate: 50 });
    const r = compareVersions(v1, v2);
    const wrItem = [...r.improvements, ...r.unchanged].find(i => i.metric === "winRate");
    assert.ok(wrItem !== undefined);
    assert.equal(wrItem!.before, 35);
    assert.equal(wrItem!.after,  50);
  });
});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

console.log(`\n${"─".repeat(55)}`);
console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}`);
if (failed > 0) process.exit(1);

/**
 * Unit Tests — BacktestAnalyzer (Phase 3-A)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/analyzer.test.ts
 */

import assert from "node:assert/strict";
import {
  buildAnalysisContext,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  validateFactIntegrity,
  type TradeForAnalysis,
} from "../BacktestAnalyzer";
import type { BacktestReport }    from "../BacktestReporter";
import type { StrategySpec }      from "@/lib/strategySchema";
import type { AnalysisContext }   from "../analysisSchema";

// =================================================================
// ─── Test runner ────────────────────────────────────────────────
// =================================================================

let passed = 0;
let failed = 0;
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
// ─── Fixtures ───────────────────────────────────────────────────
// =================================================================

const SPEC: StrategySpec = {
  name:          "RSI Reversal EURUSD",
  strategy_type: "DAY_TRADE",
  symbols:       ["EURUSD"],
  timeframes:    ["H1"],
  entry_conditions: {
    logic:      "AND",
    conditions: [
      { indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 30 },
      { indicator: "EMA", timeframe: "H1", period: 50, operator: "PRICE_ABOVE" },
    ],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
    take_profit: { method: "ATR", period: 14, multiplier: 3.0 },
  },
  risk: { risk_per_trade: 1.0 },
};

function makeReport(overrides: Partial<BacktestReport> = {}): BacktestReport {
  return {
    periodLabel:      "3M",
    dataFrom:         new Date("2024-01-01").getTime(),
    dataTo:           new Date("2024-04-01").getTime(),
    dataCoverageDays: 90,
    barCount:         2160,
    totalTrades:      40,
    wins:             18,
    losses:           20,
    breakevens:       2,
    winRate:          45.0,
    totalPips:        32.5,
    avgPips:          0.81,
    totalProfit:      325,
    grossProfit:      450,
    grossLoss:        125,
    profitFactor:     3.60,
    initialBalance:   10000,
    finalBalance:     10325,
    maxDrawdown:      150,
    maxDrawdownPct:   1.5,
    maxDrawdownPips:  45.0,
    maxConsecutiveWins:   5,
    maxConsecutiveLosses: 6,
    avgDurationMin:   72,
    sessionStats: {
      LONDON: {
        tradeCount:   20, wins: 12, losses: 7, winRate: 60.0,
        totalPips: 28.0, profitFactor: 2.5,
      },
      NEW_YORK: {
        tradeCount:   15, wins: 5,  losses: 9, winRate: 33.3,
        totalPips: -8.0, profitFactor: 0.7,
      },
      OFF: {
        tradeCount:   5, wins: 1, losses: 4, winRate: 20.0,
        totalPips: 12.5, profitFactor: null,
      },
    },
    bestSession:          "LONDON",
    worstSession:         "NEW_YORK",
    sampleSizeWarning:    false,
    minRecommendedTrades: 30,
    verdict:              "PASSED",
    verdictReason:        "Profitable: pips=32.5, PF=3.60, WR=45%",
    symbol:               "EURUSD",
    mainTimeframe:        "H1",
    ...overrides,
  };
}

function makeTrades(n: number): TradeForAnalysis[] {
  const trades: TradeForAnalysis[] = [];
  // 18 wins, 20 losses, 2 breakevens
  const results: TradeForAnalysis["result"][] = [
    ...Array(18).fill("WIN"),
    ...Array(20).fill("LOSS"),
    ...Array(2).fill("BREAKEVEN"),
  ];
  const sessions = ["LONDON", "LONDON", "NEW_YORK", "OFF", "LONDON"];

  for (let i = 0; i < n; i++) {
    const res = results[i % results.length] as TradeForAnalysis["result"];
    const pips =
      res === "WIN"       ?  8.0 + (i % 5) :
      res === "LOSS"      ? -5.0 - (i % 3) :
                             0.0;
    trades.push({
      pips,
      result:      res,
      exitReason:  res === "WIN" ? "TP" : res === "LOSS" ? "SL" : "END_OF_DATA",
      direction:   i % 2 === 0 ? "BUY" : "SELL",
      durationMin: 60 + (i % 120),
      session:     sessions[i % sessions.length]!,
    });
  }
  return trades;
}

// =================================================================
// ─── Tests ──────────────────────────────────────────────────────
// =================================================================

describe("1. buildAnalysisContext — basic structure", () => {
  const report = makeReport();
  const trades = makeTrades(40);
  const ctx    = buildAnalysisContext(report, trades, SPEC);

  test("returns AnalysisContext with correct totalTrades", () => {
    assert.equal(ctx.totalTrades, 40);
  });

  test("strategyName / type / symbols / timeframes are set", () => {
    assert.equal(ctx.strategyName, "RSI Reversal EURUSD");
    assert.equal(ctx.strategyType, "DAY_TRADE");
    assert.deepEqual(ctx.symbols, ["EURUSD"]);
    assert.deepEqual(ctx.timeframes, ["H1"]);
  });

  test("entryLogic and conditionCount are correct", () => {
    assert.equal(ctx.entryLogic, "AND");
    assert.equal(ctx.conditionCount, 2);
  });

  test("win/loss counts match report", () => {
    assert.equal(ctx.wins,      report.wins);
    assert.equal(ctx.losses,    report.losses);
    assert.equal(ctx.winRate,   report.winRate);
    assert.equal(ctx.totalPips, report.totalPips);
  });

  test("profitFactor preserved (including null)", () => {
    assert.equal(ctx.profitFactor, report.profitFactor);
  });

  test("sessionStats keys match report", () => {
    assert.deepEqual(
      Object.keys(ctx.sessionStats).sort(),
      Object.keys(report.sessionStats).sort(),
    );
  });

  test("bestSession / worstSession correct", () => {
    assert.equal(ctx.bestSession,  "LONDON");
    assert.equal(ctx.worstSession, "NEW_YORK");
  });

  test("sampleSizeWarning false for 40 trades", () => {
    assert.equal(ctx.sampleSizeWarning, false);
  });
});

describe("2. buildAnalysisContext — exit reason rates", () => {
  const trades: TradeForAnalysis[] = [
    ...Array(18).fill(null).map(() => ({
      pips: 8, result: "WIN" as const, exitReason: "TP" as const,
      direction: "BUY" as const, durationMin: 60, session: "LONDON",
    })),
    ...Array(20).fill(null).map(() => ({
      pips: -5, result: "LOSS" as const, exitReason: "SL" as const,
      direction: "SELL" as const, durationMin: 30, session: "NEW_YORK",
    })),
    ...Array(2).fill(null).map(() => ({
      pips: 0, result: "BREAKEVEN" as const, exitReason: "END_OF_DATA" as const,
      direction: "BUY" as const, durationMin: 180, session: "OFF",
    })),
  ];
  const ctx = buildAnalysisContext(makeReport(), trades, SPEC);

  test("TP hit rate = 18/40 = 45%", () => {
    assert.equal(ctx.tpHitRate, 45.0);
  });

  test("SL hit rate = 20/40 = 50%", () => {
    assert.equal(ctx.slHitRate, 50.0);
  });

  test("END_OF_DATA rate = 2/40 = 5%", () => {
    assert.equal(ctx.endOfDataRate, 5.0);
  });
});

describe("3. buildAnalysisContext — direction statistics", () => {
  // 20 BUY + 20 SELL
  const trades: TradeForAnalysis[] = [
    ...Array(20).fill(null).map((_, i) => ({
      pips: i % 2 === 0 ? 10.0 : -5.0,
      result: (i % 2 === 0 ? "WIN" : "LOSS") as TradeForAnalysis["result"],
      exitReason: (i % 2 === 0 ? "TP" : "SL") as TradeForAnalysis["exitReason"],
      direction: "BUY" as const,
      durationMin: 60, session: "LONDON",
    })),
    ...Array(20).fill(null).map((_, i) => ({
      pips: i % 3 === 0 ? 6.0 : -4.0,
      result: (i % 3 === 0 ? "WIN" : "LOSS") as TradeForAnalysis["result"],
      exitReason: (i % 3 === 0 ? "TP" : "SL") as TradeForAnalysis["exitReason"],
      direction: "SELL" as const,
      durationMin: 90, session: "NEW_YORK",
    })),
  ];
  const ctx = buildAnalysisContext(makeReport(), trades, SPEC);

  test("buyStats.count = 20", () => {
    assert.equal(ctx.buyStats.count, 20);
  });

  test("sellStats.count = 20", () => {
    assert.equal(ctx.sellStats.count, 20);
  });

  test("winningStats has positive avgPips", () => {
    assert.ok(ctx.winningStats.avgPips > 0, `avgPips=${ctx.winningStats.avgPips}`);
  });

  test("losingStats has negative avgPips", () => {
    assert.ok(ctx.losingStats.avgPips < 0, `avgPips=${ctx.losingStats.avgPips}`);
  });
});

describe("4. buildAnalysisContext — representative trades", () => {
  const trades: TradeForAnalysis[] = [
    { pips: 50.0, result: "WIN",       exitReason: "TP",          direction: "BUY",  durationMin: 200, session: "LONDON" },
    { pips: -30.0, result: "LOSS",     exitReason: "SL",          direction: "SELL", durationMin: 15,  session: "NEW_YORK" },
    { pips: 8.0,  result: "WIN",       exitReason: "TP",          direction: "BUY",  durationMin: 60,  session: "LONDON" },
    { pips: -5.0, result: "LOSS",      exitReason: "SL",          direction: "SELL", durationMin: 45,  session: "LONDON" },
    { pips: 0.0,  result: "BREAKEVEN", exitReason: "END_OF_DATA", direction: "BUY",  durationMin: 5,   session: "OFF" },
  ];
  const ctx = buildAnalysisContext(makeReport({ totalTrades: 5, wins: 2, losses: 2, breakevens: 1 }), trades, SPEC);

  test("representative trades are present", () => {
    assert.ok(ctx.representativeTrades.length > 0);
  });

  test("Max Win has highest pips", () => {
    const maxWin = ctx.representativeTrades.find(t => t.label === "Max Win");
    assert.ok(maxWin, "Max Win should exist");
    assert.equal(maxWin!.pips, 50.0);
  });

  test("Max Loss has most negative pips", () => {
    const maxLoss = ctx.representativeTrades.find(t => t.label === "Max Loss");
    assert.ok(maxLoss, "Max Loss should exist");
    assert.equal(maxLoss!.pips, -30.0);
  });

  test("Shortest Trade has smallest durationMin", () => {
    const shortest = ctx.representativeTrades.find(t => t.label === "Shortest Trade");
    assert.ok(shortest, "Shortest should exist");
    assert.equal(shortest!.durationMin, 5.0);
  });
});

describe("5. buildAnalysisContext — sample size warning", () => {
  test("sampleSizeWarning true when totalTrades < 30", () => {
    const report = makeReport({ totalTrades: 14, wins: 3, losses: 11, sampleSizeWarning: true });
    const trades = makeTrades(14);
    const ctx    = buildAnalysisContext(report, trades, SPEC);
    assert.equal(ctx.sampleSizeWarning, true);
  });

  test("empty trades produces zero stats without throwing", () => {
    const ctx = buildAnalysisContext(
      makeReport({ totalTrades: 0, wins: 0, losses: 0, sampleSizeWarning: true }),
      [],
      SPEC,
    );
    assert.equal(ctx.totalTrades, 0);
    assert.equal(ctx.tpHitRate, 0);
    assert.equal(ctx.buyStats.count, 0);
    assert.equal(ctx.representativeTrades.length, 0);
  });
});

describe("6. buildAnalysisPrompt", () => {
  const ctx = buildAnalysisContext(makeReport(), makeTrades(40), SPEC);
  const { systemPrompt, userPrompt } = buildAnalysisPrompt(ctx);

  test("systemPrompt contains FACT / OBSERVATION / HYPOTHESIS sections", () => {
    assert.ok(systemPrompt.includes("FACT"), "Missing FACT section");
    assert.ok(systemPrompt.includes("OBSERVATION"), "Missing OBSERVATION section");
    assert.ok(systemPrompt.includes("HYPOTHESIS"), "Missing HYPOTHESIS section");
  });

  test("systemPrompt prohibits inventing numbers", () => {
    assert.ok(systemPrompt.includes("DO NOT invent numbers"), "Missing number prohibition");
  });

  test("systemPrompt requires hypothesis labeling", () => {
    assert.ok(systemPrompt.includes("Hypothesis:"), "Missing hypothesis label requirement");
  });

  test("userPrompt contains strategy name", () => {
    assert.ok(userPrompt.includes("RSI Reversal EURUSD"), "Missing strategy name");
  });

  test("userPrompt contains verdict", () => {
    assert.ok(userPrompt.includes("PASSED"), "Missing verdict");
  });

  test("userPrompt contains session names", () => {
    assert.ok(userPrompt.includes("LONDON"),    "Missing LONDON session");
    assert.ok(userPrompt.includes("NEW_YORK"),  "Missing NEW_YORK session");
  });

  test("userPrompt contains total pips", () => {
    assert.ok(userPrompt.includes("32.5"), "Missing total pips value");
  });

  test("userPrompt contains win rate", () => {
    assert.ok(userPrompt.includes("45.0"), "Missing win rate");
  });
});

describe("7. parseAnalysisResponse — valid JSON", () => {
  const validJson = JSON.stringify({
    summary: "Strategy shows marginal performance with 45% win rate.",
    facts: [
      { statement: "Total trades: 40", source: "backtest_stats", value: 40 },
      { statement: "Win rate: 45%", source: "backtest_stats", value: 45.0 },
      { statement: "Total pips: +32.5", source: "backtest_stats", value: 32.5 },
    ],
    observations: [
      { observation: "London session outperforms other sessions", basis: "session_stats show London 60% WR vs 33% NY", confidence: "HIGH" },
    ],
    hypotheses: [
      { hypothesis: "Hypothesis: NY session underperformance may be due to higher volatility", rationale: "NY session shows -8 pips despite 15 trades", confidence: "MEDIUM" },
    ],
    weaknesses: [
      { point: "Low win rate overall", detail: "45% may be insufficient for the 3.6 PF to sustain" },
    ],
    strengths: [
      { point: "Strong London session performance", detail: "60% win rate in London" },
    ],
    session_analysis: [
      { session: "LONDON", observation: "Best performing session with 60% WR", recommendation: "Focus trading on London hours" },
    ],
    risk_analysis: {
      drawdown_assessment:    "Max drawdown of 1.5% is acceptable",
      sl_tp_assessment:       "ATR-based SL/TP appears well-calibrated",
      consistency_assessment: "6 consecutive losses is a concern",
      overall:                "Risk profile is moderate",
    },
    recommendations: [
      { action: "Consider avoiding NY session", rationale: "Negative pips in NY", priority: "HIGH" },
    ],
    confidence: 72,
    data_quality_note: "90 days of data with 40 trades. Sample size is adequate.",
  });

  test("returns ok=true for valid JSON", () => {
    const r = parseAnalysisResponse(validJson);
    assert.equal(r.ok, true);
  });

  test("parsed analysis has correct summary", () => {
    const r = parseAnalysisResponse(validJson);
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.analysis.summary.length > 0);
  });

  test("parsed facts array has 3 items", () => {
    const r = parseAnalysisResponse(validJson);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.analysis.facts.length, 3);
  });

  test("confidence is correctly parsed as integer", () => {
    const r = parseAnalysisResponse(validJson);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.analysis.confidence, 72);
  });
});

describe("8. parseAnalysisResponse — malformed / missing fields", () => {
  test("returns error for invalid JSON text", () => {
    const r = parseAnalysisResponse("not json at all");
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("not valid JSON"), `Unexpected error: ${r.ok ? "" : r.error}`);
  });

  test("returns error for empty JSON object", () => {
    const r = parseAnalysisResponse("{}");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.includes("Schema validation failed"), `Unexpected error: ${r.ok ? "" : r.error}`);
  });

  test("returns error when facts is empty array", () => {
    const obj = {
      summary: "test", facts: [], observations: [{ observation: "o", basis: "b" }],
      hypotheses: [], weaknesses: [], strengths: [], session_analysis: [],
      risk_analysis: { drawdown_assessment: "ok", sl_tp_assessment: "ok", consistency_assessment: "ok", overall: "ok" },
      recommendations: [{ action: "do something" }],
      confidence: 50, data_quality_note: "note",
    };
    const r = parseAnalysisResponse(JSON.stringify(obj));
    assert.equal(r.ok, false);  // facts must have min 1 item
  });

  test("returns error when confidence is out of range", () => {
    const obj = {
      summary: "test",
      facts: [{ statement: "s", source: "backtest_stats", value: 40 }],
      observations: [{ observation: "o", basis: "b" }],
      hypotheses: [], weaknesses: [], strengths: [], session_analysis: [],
      risk_analysis: { drawdown_assessment: "ok", sl_tp_assessment: "ok", consistency_assessment: "ok", overall: "ok" },
      recommendations: [{ action: "do something" }],
      confidence: 150,  // INVALID
      data_quality_note: "note",
    };
    const r = parseAnalysisResponse(JSON.stringify(obj));
    assert.equal(r.ok, false);
  });

  test("returns error when recommendations is empty", () => {
    const obj = {
      summary: "test",
      facts: [{ statement: "s", source: "backtest_stats", value: 40 }],
      observations: [{ observation: "o", basis: "b" }],
      hypotheses: [], weaknesses: [], strengths: [], session_analysis: [],
      risk_analysis: { drawdown_assessment: "ok", sl_tp_assessment: "ok", consistency_assessment: "ok", overall: "ok" },
      recommendations: [],  // INVALID — min 1
      confidence: 50,
      data_quality_note: "note",
    };
    const r = parseAnalysisResponse(JSON.stringify(obj));
    assert.equal(r.ok, false);
  });
});

describe("9. validateFactIntegrity — correct values pass", () => {
  const report = makeReport();
  const ctx    = buildAnalysisContext(report, makeTrades(40), SPEC);

  test("fact with exact total_trades value passes", () => {
    const result = validateFactIntegrity([
      { statement: "total trades: 40", source: "backtest_stats", value: 40 },
    ], ctx);
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.cleanFacts.length, 1);
  });

  test("fact with exact win_rate value passes", () => {
    const result = validateFactIntegrity([
      { statement: "win rate is 45%", source: "backtest_stats", value: 45.0 },
    ], ctx);
    assert.equal(result.valid, true);
  });

  test("string-valued fact always passes (no numeric check)", () => {
    const result = validateFactIntegrity([
      { statement: "Strategy uses RSI indicator", source: "strategy_spec", value: "RSI" },
    ], ctx);
    assert.equal(result.valid, true);
    assert.equal(result.cleanFacts.length, 1);
  });

  test("null-valued fact passes", () => {
    const result = validateFactIntegrity([
      { statement: "Profit factor is infinite", source: "backtest_stats", value: null },
    ], ctx);
    assert.equal(result.valid, true);
  });
});

describe("10. validateFactIntegrity — violations detected and removed", () => {
  const report = makeReport();
  const ctx    = buildAnalysisContext(report, makeTrades(40), SPEC);

  test("fact claiming wrong total_trades is a violation", () => {
    const result = validateFactIntegrity([
      { statement: "total trades: 99", source: "backtest_stats total_trades", value: 99 },
    ], ctx);
    assert.equal(result.violations.length, 1);
    assert.equal(result.cleanFacts.length, 0);
  });

  test("violating fact is removed from cleanFacts", () => {
    const goodFact = { statement: "win rate is 45%", source: "win_rate", value: 45.0 };
    const badFact  = { statement: "99 total trades", source: "total_trades", value: 99 };
    const result   = validateFactIntegrity([goodFact, badFact], ctx);
    assert.equal(result.cleanFacts.length, 1);
    assert.equal(result.cleanFacts[0]!.statement, goodFact.statement);
  });

  test("wrong win_rate outside tolerance triggers violation", () => {
    const result = validateFactIntegrity([
      { statement: "win rate 80%", source: "win_rate", value: 80.0 },
    ], ctx);
    assert.equal(result.violations.length, 1);
  });

  test("win_rate within tolerance (±1) does not trigger violation", () => {
    const result = validateFactIntegrity([
      { statement: "win rate approx 45.5%", source: "win_rate", value: 45.5 },
    ], ctx);
    assert.equal(result.valid, true);
  });
});

// =================================================================
// ─── Summary ───────────────────────────────────────────────────
// =================================================================
// ─── Regression Tests: semantic/scope validation ─────────────────
// Covers the 3 Phase 3-A false-positives and 5 new edge cases
// =================================================================

// 実データに近い Fixture (EURUSD RSI Reversal Scalping 風)
const REG_REPORT = makeReport({
  totalTrades:          14,
  wins:                 3,
  losses:               11,
  breakevens:           0,
  winRate:              21.43,
  totalPips:            -16.8,
  avgPips:              -1.2,
  profitFactor:         0.6989,
  maxDrawdownPct:       0.05,
  maxConsecutiveWins:   1,
  maxConsecutiveLosses: 9,
  sampleSizeWarning:    true,
  sessionStats: {
    OVERLAP:  { tradeCount: 8, wins: 0, losses: 8, winRate:  0,   totalPips: -39.8, profitFactor: 0 },
    NEW_YORK: { tradeCount: 5, wins: 3, losses: 2, winRate: 60.0, totalPips:  27.4, profitFactor: 3.36 },
    LONDON:   { tradeCount: 1, wins: 0, losses: 1, winRate:  0,   totalPips:  -4.4, profitFactor: 0 },
  },
});

// 14 件のトレード（SELL=0, BUY=14, セッション分布は実データ準拠）
const REG_TRADES: TradeForAnalysis[] = [
  ...Array(8).fill(null).map((_, i) => ({
    pips: -5.0 - (i % 3), result: "LOSS" as const, exitReason: "SL" as const,
    direction: "BUY" as const, durationMin: 20 + i, session: "OVERLAP",
  })),
  { pips: 10.0, result: "WIN" as const, exitReason: "TP" as const,
    direction: "BUY" as const, durationMin: 1200, session: "NEW_YORK" },
  { pips:  8.0, result: "WIN" as const, exitReason: "TP" as const,
    direction: "BUY" as const, durationMin:  900, session: "NEW_YORK" },
  { pips: -4.0, result: "LOSS" as const, exitReason: "SL" as const,
    direction: "BUY" as const, durationMin:   30, session: "NEW_YORK" },
  { pips: -3.0, result: "LOSS" as const, exitReason: "SL" as const,
    direction: "BUY" as const, durationMin:   25, session: "NEW_YORK" },
  {  pips:  9.5, result: "WIN" as const, exitReason: "TP" as const,
    direction: "BUY" as const, durationMin:  170, session: "NEW_YORK" },
  { pips: -4.4, result: "LOSS" as const, exitReason: "SL" as const,
    direction: "BUY" as const, durationMin:   15, session: "LONDON" },
];

const REG_CTX = buildAnalysisContext(REG_REPORT, REG_TRADES, SPEC);

describe("11. Regression: semantic/scope Fact validation", () => {

  // ── Case 1: max_cons_losses=9 が正しく PASS ────────────────────
  test("[Regression FP1] max_cons_losses=9 → PASS", () => {
    const r = validateFactIntegrity([
      { statement: "Maximum consecutive losses was 9",
        source: "streak_stats", value: 9 },
    ], REG_CTX);
    assert.equal(r.valid, true, `violations: ${r.violations.join("; ")}`);
    assert.equal(r.cleanFacts.length, 1);
  });

  // ── Case 2: 「max consecutive losses = 11」は losses=11 ではなく max_cons_losses=9 と比較すべき
  test("[Regression] max_cons_losses=11 claimed but actual=9 → FAIL", () => {
    const r = validateFactIntegrity([
      { statement: "Maximum consecutive losses was 11",
        source: "streak_stats", value: 11 },
    ], REG_CTX);
    assert.equal(r.valid, false, "Should fail: max_cons_losses=9, not 11");
    assert.equal(r.violations.length, 1);
    assert.equal(r.cleanFacts.length, 0);
  });

  // ── Case 3: "NEW_YORK +27.4 pips" → session.totalPips で PASS ─
  test("[Regression FP3] NEW_YORK +27.4 pips → PASS (session totalPips)", () => {
    const r = validateFactIntegrity([
      { statement: "NEW_YORK generated +27.4 pips",
        source: "session_stats", value: 27.4 },
    ], REG_CTX);
    assert.equal(r.valid, true, `violations: ${r.violations.join("; ")}`);
  });

  // ── Case 4: "NEW_YORK win rate was 27.4%" → NEW_YORK winRate=60, not 27.4 → FAIL
  test("[Regression] NEW_YORK win rate was 27.4% → FAIL (winRate=60, not 27.4)", () => {
    const r = validateFactIntegrity([
      { statement: "NEW_YORK win rate was 27.4%",
        source: "session_stats", value: 27.4 },
    ], REG_CTX);
    assert.equal(r.valid, false,
      "Should fail: 27.4 exists as totalPips but NOT as NEW_YORK win rate");
    assert.equal(r.violations.length, 1);
  });

  // ── Case 5: "OVERLAP win rate was 21.43%" → OVERLAP winRate=0, not 21.43 → FAIL
  test("[Regression] OVERLAP win rate was 21.43% → FAIL (OVERLAP winRate=0)", () => {
    const r = validateFactIntegrity([
      { statement: "OVERLAP win rate was 21.43%",
        source: "session_stats", value: 21.43 },
    ], REG_CTX);
    assert.equal(r.valid, false,
      "Should fail: 21.43 is overall winRate, NOT OVERLAP winRate=0");
    assert.equal(r.violations.length, 1);
  });

  // ── Bonus: "OVERLAP pips = -39.8" → session.totalPips で PASS (元 FP2)
  test("[Regression FP2] OVERLAP −39.8 pips → PASS (session totalPips)", () => {
    const r = validateFactIntegrity([
      { statement: "The OVERLAP session had 8 trades with 0% win rate and -39.8 pips.",
        source: "session_stats", value: -39.8 },
    ], REG_CTX);
    assert.equal(r.valid, true, `violations: ${r.violations.join("; ")}`);
  });

  // ── Bonus: 全体 total_trades=14 は PASS
  test("[Regression] total_trades=14 → PASS", () => {
    const r = validateFactIntegrity([
      { statement: "The backtest recorded a total of 14 trades.",
        source: "backtest_stats", value: 14 },
    ], REG_CTX);
    assert.equal(r.valid, true);
  });

  // ── Bonus: wins=3 は全体 wins で PASS
  test("[Regression] overall wins=3 → PASS", () => {
    const r = validateFactIntegrity([
      { statement: "The strategy won 3 trades.",
        source: "backtest_stats", value: 3 },
    ], REG_CTX);
    assert.equal(r.valid, true);
  });

});

// =================================================================

console.log(`\n${"─".repeat(50)}`);
console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}`);
if (failed > 0) process.exit(1);

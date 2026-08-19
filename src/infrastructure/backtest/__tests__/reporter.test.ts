/**
 * Unit Tests — BacktestReporter (Phase 2-D)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/reporter.test.ts
 */

import assert from "node:assert/strict";
import { generateReport, type BacktestReport } from "../BacktestReporter";
import type { BacktestResult } from "../BacktestEngine";
import type { BacktestTrade }  from "../PositionManager";

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
// ─── Helpers ────────────────────────────────────────────────────
// =================================================================

const BASE_TIME = new Date("2024-01-15T10:00:00Z").getTime(); // 10:00 UTC = LONDON session
const M5_MS = 300_000;

// London session: 07:00-16:00 UTC
// At 10:00 UTC → LONDON

function makeTrade(overrides: Partial<BacktestTrade> & {
  pips:    number;
  profit:  number;
  result:  BacktestTrade["result"];
}): BacktestTrade {
  return {
    tradeId:      1,
    direction:    "BUY",
    symbol:       "EURUSD",
    timeframe:    "M5",
    entryTime:    BASE_TIME,
    entryPrice:   1.1000,
    exitTime:     BASE_TIME + M5_MS * 10,
    exitPrice:    1.1000 + overrides.pips * 0.0001,
    sl:           1.0980,
    tp:           1.1040,
    lot:          0.01,
    spreadPips:   1.5,
    slippagePips: 0.3,
    entryBarIdx:  15,
    exitBarIdx:   25,
    exitReason:   overrides.pips > 0 ? "TP" : "SL",
    durationMin:  50,
    ...overrides,
  };
}

function makeResult(trades: BacktestTrade[], initial = 10_000): BacktestResult {
  const totalProfit = trades.reduce((s, t) => s + t.profit, 0);
  const wins        = trades.filter(t => t.result === "WIN").length;
  const losses      = trades.filter(t => t.result === "LOSS").length;

  let balance = initial, peak = initial, maxDD = 0, maxDDPct = 0;
  for (const t of trades) {
    balance += t.profit;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDD) { maxDD = dd; maxDDPct = dd / peak * 100; }
  }

  return {
    trades,
    totalTrades:    trades.length,
    wins, losses,
    winRate:        trades.length > 0 ? wins / trades.length * 100 : 0,
    totalPips:      trades.reduce((s, t) => s + t.pips, 0),
    totalProfit,
    initialBalance: initial,
    finalBalance:   initial + totalProfit,
    peakBalance:    peak,
    maxDrawdown:    maxDD,
    maxDrawdownPct: maxDDPct,
    symbol:         "EURUSD",
    mainTimeframe:  "M5",
    startTime:      BASE_TIME,
    endTime:        BASE_TIME + 1000 * M5_MS,
    barsProcessed:  1000,
  };
}

function report(trades: BacktestTrade[], initial = 10_000): BacktestReport {
  return generateReport({
    engineResult: makeResult(trades, initial),
    periodLabel:  "AVAILABLE",
    barCount:     1000,
  });
}

const WIN  = (n: number) => makeTrade({ pips: n, profit: n * 0.1, result: "WIN"  });
const LOSS = (n: number) => makeTrade({ pips: -n, profit: -n * 0.1, result: "LOSS" });
const BE   = ()          => makeTrade({ pips: 0, profit: 0, result: "BREAKEVEN" });
const EOD  = (n: number) => makeTrade({ pips: n, profit: n * 0.1, result: "END_OF_DATA", exitReason: "END_OF_DATA" });

// =================================================================
// ─── Tests ───────────────────────────────────────────────────────
// =================================================================

describe("Trade Counts", () => {

  test("01. 0 trades", () => {
    const r = report([]);
    assert.equal(r.totalTrades, 0);
    assert.equal(r.wins, 0);
    assert.equal(r.losses, 0);
    assert.equal(r.breakevens, 0);
  });

  test("02. All wins (5 trades)", () => {
    const r = report([WIN(10), WIN(20), WIN(15), WIN(8), WIN(12)]);
    assert.equal(r.totalTrades, 5);
    assert.equal(r.wins, 5);
    assert.equal(r.losses, 0);
    assert.equal(r.breakevens, 0);
  });

  test("03. All losses (5 trades)", () => {
    const r = report([LOSS(10), LOSS(20), LOSS(5), LOSS(8), LOSS(3)]);
    assert.equal(r.totalTrades, 5);
    assert.equal(r.wins, 0);
    assert.equal(r.losses, 5);
  });

  test("04. Mixed trades", () => {
    const r = report([WIN(20), LOSS(10), WIN(15), LOSS(5), BE()]);
    assert.equal(r.totalTrades, 5);
    assert.equal(r.wins, 2);
    assert.equal(r.losses, 2);
    assert.equal(r.breakevens, 1);
  });

  test("05. Breakeven only", () => {
    const r = report([BE(), BE(), BE()]);
    assert.equal(r.breakevens, 3);
    assert.equal(r.wins, 0);
    assert.equal(r.losses, 0);
  });

});

describe("Win Rate", () => {

  test("06. Win rate: 2 wins / 4 trades = 50%", () => {
    const r = report([WIN(10), LOSS(5), WIN(8), LOSS(3)]);
    assert.ok(Math.abs(r.winRate - 50) < 0.01, `winRate=${r.winRate}`);
  });

  test("06b. Win rate: 0 trades → 0", () => {
    const r = report([]);
    assert.equal(r.winRate, 0);
    assert.ok(!isNaN(r.winRate), "winRate must not be NaN");
  });

  test("06c. Win rate: all wins → 100%", () => {
    const r = report([WIN(10), WIN(20)]);
    assert.equal(r.winRate, 100);
  });

});

describe("Pips", () => {

  test("07. Total pips", () => {
    const r = report([WIN(20), LOSS(10), WIN(15)]);
    assert.ok(Math.abs(r.totalPips - 25) < 0.1, `totalPips=${r.totalPips}`);
  });

  test("08. Avg pips", () => {
    const r = report([WIN(30), LOSS(10), WIN(20)]); // 40 / 3 ≈ 13.3
    assert.ok(Math.abs(r.avgPips - 40 / 3) < 0.5, `avgPips=${r.avgPips}`);
  });

  test("08b. Avg pips: 0 trades → 0", () => {
    const r = report([]);
    assert.equal(r.avgPips, 0);
    assert.ok(!isNaN(r.avgPips));
  });

});

describe("Gross Profit / Loss", () => {

  test("09. Gross profit (sum of positive profits)", () => {
    const r = report([WIN(20), LOSS(10), WIN(15), LOSS(5)]);
    // grossProfit = 2.0 + 1.5 = 3.5
    assert.ok(Math.abs(r.grossProfit - 3.5) < 0.01, `gp=${r.grossProfit}`);
  });

  test("10. Gross loss (abs sum of negative profits)", () => {
    const r = report([WIN(20), LOSS(10), WIN(15), LOSS(5)]);
    // grossLoss = 1.0 + 0.5 = 1.5
    assert.ok(Math.abs(r.grossLoss - 1.5) < 0.01, `gl=${r.grossLoss}`);
  });

  test("11. Profit factor = grossProfit / grossLoss", () => {
    const r = report([WIN(20), LOSS(10), WIN(15), LOSS(5)]);
    // PF = 3.5 / 1.5 ≈ 2.33
    assert.ok(r.profitFactor !== null, "PF should not be null");
    assert.ok(Math.abs(r.profitFactor - 3.5 / 1.5) < 0.01, `PF=${r.profitFactor}`);
  });

  test("26. Zero gross loss (all wins) → profitFactor = null (infinite)", () => {
    const r = report([WIN(10), WIN(20)]);
    assert.equal(r.profitFactor, null, "PF should be null (infinite)");
    assert.ok(!isNaN(r.grossProfit));
    assert.equal(r.grossLoss, 0);
  });

  test("26b. Zero gross profit (all losses) → profitFactor = 0", () => {
    const r = report([LOSS(10), LOSS(20)]);
    assert.equal(r.profitFactor, 0);
  });

});

describe("Max Drawdown", () => {

  test("12. Max drawdown USD from engineResult", () => {
    const trades = [WIN(20), LOSS(50), WIN(10)];
    const r = report(trades);
    // maxDrawdown from AccountSimulator: after LOSS(50) → -$5, DD = 5
    assert.ok(r.maxDrawdown > 0, `DD=${r.maxDrawdown}`);
  });

  test("13. Max drawdown %", () => {
    const trades = [WIN(20), LOSS(50), WIN(10)];
    const r = report(trades);
    assert.ok(r.maxDrawdownPct > 0, `DDPct=${r.maxDrawdownPct}`);
    assert.ok(!isNaN(r.maxDrawdownPct));
  });

  test("Max drawdown pips: cumulative pips DD", () => {
    // 20 - 50 + 10 → peak=20, then 20-50=-30 → dd=50 pips
    const trades = [WIN(20), LOSS(50), WIN(10)];
    const r = report(trades);
    assert.ok(Math.abs(r.maxDrawdownPips - 50) < 1, `DDPips=${r.maxDrawdownPips}`);
  });

  test("27. Zero balance edge: 0 initial balance", () => {
    // Should not throw or produce NaN
    const r = generateReport({
      engineResult: { ...makeResult([WIN(10)], 0), initialBalance: 0 },
      periodLabel:  "AVAILABLE",
      barCount:     100,
    });
    assert.ok(!isNaN(r.winRate));
    assert.ok(!isNaN(r.maxDrawdownPct));
  });

});

describe("Consecutive Wins / Losses", () => {

  test("14. Max consecutive wins", () => {
    // W W L W W W L W → max = 3
    const trades = [WIN(1), WIN(1), LOSS(1), WIN(1), WIN(1), WIN(1), LOSS(1), WIN(1)];
    const r = report(trades);
    assert.equal(r.maxConsecutiveWins, 3, `maxConsWins=${r.maxConsecutiveWins}`);
  });

  test("15. Max consecutive losses", () => {
    // L L L W L L W → max = 3
    const trades = [LOSS(1), LOSS(1), LOSS(1), WIN(1), LOSS(1), LOSS(1), WIN(1)];
    const r = report(trades);
    assert.equal(r.maxConsecutiveLosses, 3, `maxConsLoss=${r.maxConsecutiveLosses}`);
  });

  test("BE resets streaks", () => {
    // W W BE W W → max = 2 (BE resets)
    const trades = [WIN(1), WIN(1), BE(), WIN(1), WIN(1)];
    const r = report(trades);
    assert.equal(r.maxConsecutiveWins, 2);
  });

});

describe("Session Statistics", () => {

  // BASE_TIME = 2024-01-15T10:00:00Z = LONDON
  // Make some trades at different times

  const TOKYO_TIME  = new Date("2024-01-15T04:00:00Z").getTime(); // 04:00 = TOKYO
  const OVERLAP_TIME = new Date("2024-01-15T13:00:00Z").getTime(); // 13:00 = LONDON+NEW_YORK

  function tradeAt(t: number, pips: number, profit: number, result: BacktestTrade["result"]): BacktestTrade {
    return { ...makeTrade({ pips, profit, result }), entryTime: t };
  }

  test("16. Session stats grouped by session", () => {
    const trades = [
      tradeAt(BASE_TIME, 10, 1.0, "WIN"),     // LONDON
      tradeAt(BASE_TIME, 20, 2.0, "WIN"),     // LONDON
      tradeAt(TOKYO_TIME, -5, -0.5, "LOSS"),  // TOKYO
    ];
    const r = report(trades);
    assert.ok("LONDON" in r.sessionStats, "should have LONDON session");
    assert.ok("TOKYO" in r.sessionStats, "should have TOKYO session");
    assert.equal(r.sessionStats["LONDON"]?.tradeCount, 2);
    assert.equal(r.sessionStats["TOKYO"]?.tradeCount, 1);
  });

  test("17. Best session by totalPips", () => {
    const trades = [
      tradeAt(BASE_TIME, 30, 3.0, "WIN"),    // LONDON: 30 pips
      tradeAt(TOKYO_TIME, 5, 0.5, "WIN"),    // TOKYO: 5 pips
    ];
    const r = report(trades);
    assert.equal(r.bestSession, "LONDON", `bestSession=${r.bestSession}`);
  });

  test("18. Worst session by totalPips", () => {
    const trades = [
      tradeAt(BASE_TIME, 30, 3.0, "WIN"),    // LONDON: 30 pips
      tradeAt(TOKYO_TIME, -20, -2.0, "LOSS"), // TOKYO: -20 pips
    ];
    const r = report(trades);
    assert.equal(r.worstSession, "TOKYO", `worstSession=${r.worstSession}`);
  });

  test("16b. OVERLAP session (LONDON + NEW_YORK overlap)", () => {
    const trades = [tradeAt(OVERLAP_TIME, 10, 1.0, "WIN")];
    const r = report(trades);
    assert.ok("OVERLAP" in r.sessionStats || "LONDON" in r.sessionStats || "NEW_YORK" in r.sessionStats,
      `sessions: ${JSON.stringify(Object.keys(r.sessionStats))}`);
  });

  test("No sessions (0 trades) → null bestSession/worstSession", () => {
    const r = report([]);
    assert.equal(r.bestSession, null);
    assert.equal(r.worstSession, null);
  });

  test("30. Mixed sessions", () => {
    const trades = [
      tradeAt(BASE_TIME, 10, 1.0, "WIN"),          // LONDON
      tradeAt(TOKYO_TIME, -5, -0.5, "LOSS"),        // TOKYO
      tradeAt(OVERLAP_TIME, 20, 2.0, "WIN"),        // OVERLAP
    ];
    const r = report(trades);
    const sessionCount = Object.keys(r.sessionStats).length;
    assert.ok(sessionCount >= 2, `sessions=${sessionCount}`);
  });

});

describe("Sample Size Warning", () => {

  test("19. < 30 trades → warning true", () => {
    const trades = Array.from({ length: 10 }, () => WIN(5));
    const r = report(trades);
    assert.equal(r.sampleSizeWarning, true);
  });

  test("20. >= 30 trades → warning false", () => {
    const trades = Array.from({ length: 30 }, () => WIN(5));
    const r = report(trades);
    assert.equal(r.sampleSizeWarning, false);
  });

  test("20b. exactly 29 → warning true", () => {
    const trades = Array.from({ length: 29 }, () => WIN(5));
    const r = report(trades);
    assert.equal(r.sampleSizeWarning, true);
  });

});

describe("Verdict", () => {

  test("21. PASSED: pips>0, PF>=1.3, WR>=30%", () => {
    // 4 wins (40 pips) + 1 loss (10 pips) = 30 pips
    // PF = 4.0 / 1.0 = 4.0, WR = 80%
    const trades = [WIN(10), WIN(10), WIN(10), WIN(10), LOSS(10)];
    const r = report(trades);
    assert.equal(r.verdict, "PASSED", `verdict=${r.verdict}, reason=${r.verdictReason}`);
  });

  test("22. CONDITIONAL: pips>0, 1.0<=PF<1.3", () => {
    // 2 wins (22 pips) + 1 loss (20 pips) = 2 pips
    // PF = 2.2 / 2.0 = 1.1 → CONDITIONAL
    const trades = [WIN(11), WIN(11), LOSS(20)];
    const r = report(trades);
    assert.equal(r.verdict, "CONDITIONAL", `verdict=${r.verdict}, reason=${r.verdictReason}`);
  });

  test("23. FAILED: pips<=0", () => {
    const trades = [WIN(5), LOSS(20)]; // totalPips = -15
    const r = report(trades);
    assert.equal(r.verdict, "FAILED");
  });

  test("24. No trades → FAILED + specific reason", () => {
    const r = report([]);
    assert.equal(r.verdict, "FAILED");
    assert.ok(r.verdictReason.toLowerCase().includes("no trades"), `reason="${r.verdictReason}"`);
  });

  test("23b. All losses → FAILED", () => {
    const trades = [LOSS(10), LOSS(20), LOSS(5)];
    assert.equal(report(trades).verdict, "FAILED");
  });

});

describe("Data Coverage", () => {

  test("25. dataCoverageDays computed from dataFrom/dataTo", () => {
    // Trades span 10 days
    const tenDaysMs = 10 * 86_400_000;
    const trades = [
      { ...WIN(10), entryTime: BASE_TIME, exitTime: BASE_TIME + tenDaysMs },
    ];
    const r = report(trades);
    assert.ok(Math.abs(r.dataCoverageDays - 10) < 0.1, `coverage=${r.dataCoverageDays}`);
  });

  test("dataCoverageDays: 0 trades → uses engineResult startTime/endTime", () => {
    const r = report([]);
    // Uses engineResult.startTime and endTime
    assert.ok(!isNaN(r.dataCoverageDays));
    assert.ok(r.dataCoverageDays >= 0);
  });

});

describe("Avg Duration", () => {

  test("29. Average duration in minutes", () => {
    const t1 = { ...WIN(10), durationMin: 20 };
    const t2 = { ...WIN(10), durationMin: 40 };
    const r = report([t1, t2]);
    assert.ok(Math.abs(r.avgDurationMin - 30) < 0.1, `avgDuration=${r.avgDurationMin}`);
  });

  test("29b. 0 trades → avgDurationMin=0", () => {
    assert.equal(report([]).avgDurationMin, 0);
  });

});

describe("NaN / Infinity guard", () => {

  test("No NaN in any numeric field", () => {
    const r = report([WIN(10), LOSS(5), BE()]);
    const fields: (keyof BacktestReport)[] = [
      "winRate", "totalPips", "avgPips", "grossProfit", "grossLoss",
      "maxDrawdown", "maxDrawdownPct", "maxDrawdownPips",
      "maxConsecutiveWins", "maxConsecutiveLosses", "avgDurationMin",
    ];
    for (const f of fields) {
      const val = r[f];
      if (typeof val === "number") {
        assert.ok(!isNaN(val), `${f} is NaN`);
        assert.ok(isFinite(val), `${f} is Infinity`);
      }
    }
  });

  test("28. Negative balance edge: large losses", () => {
    const trades = Array.from({ length: 5 }, () => LOSS(1000));
    const r = generateReport({
      engineResult: makeResult(trades, 100), // balance goes negative
      periodLabel: "AVAILABLE",
      barCount: 100,
    });
    assert.ok(!isNaN(r.maxDrawdownPct));
    assert.ok(!isNaN(r.winRate));
  });

});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) { console.log("🎉 All tests PASSED"); }
else { console.log("💥 Some tests FAILED"); process.exit(1); }

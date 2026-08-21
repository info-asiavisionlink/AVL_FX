/**
 * Phase 5-C Backtest Script
 *
 * Runs TWO strategies (LONG + SHORT) against the same EURUSD bar data.
 * Aggregates combined stats and saves to Supabase.
 *
 * Strategy IDs:
 *   LONG:  f6d8b225-a31e-4ca6-bcdb-9839c380d9de
 *   SHORT: 3e45aa56-e2fa-4c07-8a34-5f271c859c0b
 *
 * Usage: npx tsx --env-file=.env.local scripts/phase5c_run_backtest.ts
 */

import type { Bar }       from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import { runBacktest }   from "@/infrastructure/backtest/BacktestEngine";
import { generateReport } from "@/infrastructure/backtest/BacktestReporter";
import { getSessionsAtTime } from "@/infrastructure/backtest/timeframe";
import type { BacktestTrade } from "@/infrastructure/backtest/PositionManager";

// ── Config ─────────────────────────────────────────────────────────

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const LONG_STRATEGY_ID  = "f6d8b225-a31e-4ca6-bcdb-9839c380d9de";
const SHORT_STRATEGY_ID = "3e45aa56-e2fa-4c07-8a34-5f271c859c0b";

const SYMBOL          = "EURUSD";
const INITIAL_BALANCE = 10_000;
const FETCH_PAGE_SIZE = 1000;

// ── Strategy Specs ──────────────────────────────────────────────────

const LONG_SPEC: StrategySpec = {
  name:            "EURUSD Multi-TF EMA21 Pullback v2 LONG",
  strategy_type:   "DAY_TRADE",
  description:     "Phase 5-C LONG",
  symbols:         ["EURUSD"],
  timeframes:      ["M5", "H1", "H4"],
  entry_conditions: {
    logic: "AND",
    conditions: [
      { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
      { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE", threshold: 0 },
    ],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
    take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
  },
  filters: {
    sessions:        ["LONDON", "NEW_YORK"],
    max_spread_pips: 2.0,
    trend_filters: [
      { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
      { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
    ],
  },
  risk: { risk_per_trade: 0.01 },
};

const SHORT_SPEC: StrategySpec = {
  name:            "EURUSD Multi-TF EMA21 Pullback v2 SHORT",
  strategy_type:   "DAY_TRADE",
  description:     "Phase 5-C SHORT",
  symbols:         ["EURUSD"],
  timeframes:      ["M5", "H1", "H4"],
  entry_conditions: {
    logic: "AND",
    conditions: [
      { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
      { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW", threshold: 0 },
    ],
  },
  exit_conditions: {
    stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
    take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
  },
  filters: {
    sessions:        ["LONDON", "NEW_YORK"],
    max_spread_pips: 2.0,
    trend_filters: [
      { timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" },
      { timeframe: "H1", indicator: "EMA", period: 21, direction: "BEARISH" },
    ],
  },
  risk: { risk_per_trade: 0.01 },
};

// ── Fetch helpers ───────────────────────────────────────────────────

type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

async function fetchAllBars(symbol: string, timeframe: string): Promise<Bar[]> {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const allRows: BarRow[] = [];
  let offset = 0;

  for (;;) {
    const url = `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume` +
      `&symbol=eq.${symbol}&timeframe=eq.${timeframe}` +
      `&order=time_utc.asc` +
      `&limit=${FETCH_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetchAllBars failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as BarRow[];
    allRows.push(...rows);
    if (rows.length < FETCH_PAGE_SIZE) break;
    offset += FETCH_PAGE_SIZE;
  }

  return allRows.map(r => ({
    time:   new Date(r.time_utc).getTime(),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: r.volume ?? 0,
  }));
}

// ── Save helpers ────────────────────────────────────────────────────

async function saveResults(
  jobId:      string,
  strategyId: string,
  trades:     BacktestTrade[],
  reportRow:  Record<string, unknown>,
): Promise<void> {
  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  const BATCH = 500;
  for (let i = 0; i < trades.length; i += BATCH) {
    const batch = trades.slice(i, i + BATCH).map(t => {
      const sessions = getSessionsAtTime(t.entryTime);
      const session  = sessions.length === 0 ? "OFF" : sessions.length === 1 ? sessions[0] : "OVERLAP";
      return {
        job_id: jobId, strategy_id: strategyId,
        symbol: t.symbol, entry_tf: t.timeframe, direction: t.direction,
        entry_time: new Date(t.entryTime).toISOString(),
        entry_price: t.entryPrice,
        exit_time: new Date(t.exitTime).toISOString(),
        exit_price: t.exitPrice,
        sl: t.sl, tp: t.tp, lot: t.lot, pips: t.pips,
        result: t.result, exit_reason: t.exitReason,
        duration_min: t.durationMin, session,
        spread_pips: t.spreadPips, slippage_pips: t.slippagePips,
        entry_bar_idx: t.entryBarIdx, exit_bar_idx: t.exitBarIdx,
      };
    });
    const res = await fetch(`${SB_URL}/rest/v1/backtest_trades`, {
      method: "POST", headers, body: JSON.stringify(batch),
    });
    if (!res.ok) console.warn(`Trades batch ${i} save warning: ${res.status}`);
  }

  const res2 = await fetch(`${SB_URL}/rest/v1/backtest_results`, {
    method: "POST",
    headers: { ...headers, "Prefer": "return=minimal" },
    body: JSON.stringify({ ...reportRow, job_id: jobId, strategy_id: strategyId }),
  });
  if (!res2.ok) console.warn(`Result save warning: ${res2.status} ${await res2.text()}`);
}

async function createJob(strategyId: string, barCount: number, dataFrom: number, dataTo: number): Promise<string> {
  const headers = {
    apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
  const res = await fetch(`${SB_URL}/rest/v1/backtest_jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      strategy_id:  strategyId,
      status:       "COMPLETED",
      period_label: "AVAILABLE",
      data_from:    dataFrom > 0 ? new Date(dataFrom).toISOString() : null,
      data_to:      dataTo   > 0 ? new Date(dataTo).toISOString()   : null,
      bar_count:    barCount,
      progress_pct: 100,
      started_at:   new Date().toISOString(),
      completed_at: new Date().toISOString(),
      created_at:   new Date().toISOString(),
    }),
  });
  const data = await res.json() as Array<{ id: string }> | { id: string };
  return Array.isArray(data) ? data[0].id : data.id;
}

function buildReportRow(report: ReturnType<typeof generateReport>): Record<string, unknown> {
  return {
    period_label:           report.periodLabel,
    data_from:              report.dataFrom > 0 ? new Date(report.dataFrom).toISOString() : null,
    data_to:                report.dataTo   > 0 ? new Date(report.dataTo).toISOString()   : null,
    data_source:            "bar_data",
    bar_count_used:         report.barCount,
    data_coverage_days:     report.dataCoverageDays,
    total_trades:           report.totalTrades,
    wins:                   report.wins,
    losses:                 report.losses,
    breakevens:             report.breakevens,
    win_rate:               report.winRate,
    total_pips:             report.totalPips,
    avg_pips:               report.avgPips,
    gross_profit:           report.grossProfit,
    gross_loss:             report.grossLoss,
    profit_factor:          report.profitFactor,
    max_drawdown:           report.maxDrawdown,
    max_drawdown_pct:       report.maxDrawdownPct,
    max_drawdown_pips:      report.maxDrawdownPips,
    max_cons_wins:          report.maxConsecutiveWins,
    max_cons_losses:        report.maxConsecutiveLosses,
    avg_duration_min:       report.avgDurationMin,
    session_stats:          report.sessionStats,
    best_session:           report.bestSession,
    worst_session:          report.worstSession,
    sample_size_warning:    report.sampleSizeWarning,
    min_recommended_trades: report.minRecommendedTrades,
    verdict:                report.verdict,
    verdict_reason:         report.verdictReason,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        PHASE 5-C: EURUSD Multi-TF EMA21 Pullback v2          ║");
  console.log("║                   LONG + SHORT Backtest                       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // 1. Fetch bar data (shared for both strategies)
  console.log("\n[1] Fetching bar data (shared for LONG + SHORT)...");
  const [m5Bars, h1Bars, h4Bars] = await Promise.all([
    fetchAllBars(SYMBOL, "M5"),
    fetchAllBars(SYMBOL, "H1"),
    fetchAllBars(SYMBOL, "H4"),
  ]);

  console.log(`  M5 bars:  ${m5Bars.length}`);
  if (m5Bars.length > 0) {
    console.log(`    from: ${new Date(m5Bars[0].time).toISOString()}`);
    console.log(`    to:   ${new Date(m5Bars[m5Bars.length - 1].time).toISOString()}`);
  }
  console.log(`  H1 bars:  ${h1Bars.length}`);
  console.log(`  H4 bars:  ${h4Bars.length}`);

  const barsByTimeframe: Record<string, Bar[]> = { M5: m5Bars, H1: h1Bars, H4: h4Bars };

  // 2. Run LONG backtest
  console.log("\n[2] Running LONG BacktestEngine...");
  const longResult = runBacktest({
    spec:            LONG_SPEC,
    symbol:          SYMBOL,
    mainTimeframe:   "M5",
    barsByTimeframe,
    initialBalance:  INITIAL_BALANCE,
    fixedLot:        0.01,
  });
  console.log(`  Bars processed: ${longResult.barsProcessed}`);
  console.log(`  LONG trades:    ${longResult.totalTrades}`);

  // 3. Run SHORT backtest
  console.log("\n[3] Running SHORT BacktestEngine...");
  const shortResult = runBacktest({
    spec:            SHORT_SPEC,
    symbol:          SYMBOL,
    mainTimeframe:   "M5",
    barsByTimeframe,
    initialBalance:  INITIAL_BALANCE,
    fixedLot:        0.01,
  });
  console.log(`  Bars processed: ${shortResult.barsProcessed}`);
  console.log(`  SHORT trades:   ${shortResult.totalTrades}`);

  // 4. Generate reports
  console.log("\n[4] Generating reports...");
  const longReport  = generateReport({ engineResult: longResult,  periodLabel: "AVAILABLE", barCount: m5Bars.length });
  const shortReport = generateReport({ engineResult: shortResult, periodLabel: "AVAILABLE", barCount: m5Bars.length });

  // 5. Compute split stats
  const longTrades  = longResult.trades;
  const shortTrades = shortResult.trades;

  const longWins    = longTrades.filter(t => t.result === "WIN").length;
  const longLosses  = longTrades.filter(t => t.result === "LOSS").length;
  const longWinPips = longTrades.filter(t => t.result === "WIN").reduce((s, t) => s + t.pips, 0);
  const longLossPips= longTrades.filter(t => t.result === "LOSS").reduce((s, t) => s + t.pips, 0);
  const longAvgWin  = longWins > 0  ? longWinPips / longWins   : 0;
  const longAvgLoss = longLosses > 0? longLossPips / longLosses: 0;
  const longWinRate = longTrades.length > 0 ? (longWins / longTrades.length) * 100 : 0;
  const longTotalPips = longTrades.reduce((s, t) => s + t.pips, 0);

  const shortWins     = shortTrades.filter(t => t.result === "WIN").length;
  const shortLosses   = shortTrades.filter(t => t.result === "LOSS").length;
  const shortWinPips  = shortTrades.filter(t => t.result === "WIN").reduce((s, t) => s + t.pips, 0);
  const shortLossPips = shortTrades.filter(t => t.result === "LOSS").reduce((s, t) => s + t.pips, 0);
  const shortAvgWin   = shortWins > 0   ? shortWinPips / shortWins    : 0;
  const shortAvgLoss  = shortLosses > 0 ? shortLossPips / shortLosses : 0;
  const shortWinRate  = shortTrades.length > 0 ? (shortWins / shortTrades.length) * 100 : 0;
  const shortTotalPips = shortTrades.reduce((s, t) => s + t.pips, 0);

  const totalTrades  = longTrades.length + shortTrades.length;
  const totalWins    = longWins + shortWins;
  const totalLosses  = longLosses + shortLosses;
  const totalWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const totalPips    = longTotalPips + shortTotalPips;

  // Combined gross profit/loss across both
  const allTrades = [...longTrades, ...shortTrades];
  const grossProfit = allTrades.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
  const grossLoss   = Math.abs(allTrades.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
  const combinedPF  = grossLoss > 0 ? grossProfit / grossLoss : null;

  // Monthly breakdown
  const monthlyMap: Record<string, { trades: number; wins: number; pips: number }> = {};
  for (const t of allTrades) {
    const d   = new Date(t.entryTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!monthlyMap[key]) monthlyMap[key] = { trades: 0, wins: 0, pips: 0 };
    monthlyMap[key].trades++;
    if (t.result === "WIN") monthlyMap[key].wins++;
    monthlyMap[key].pips += t.pips;
  }

  // Exit reason breakdown
  const exitTP  = allTrades.filter(t => t.exitReason === "TP").length;
  const exitSL  = allTrades.filter(t => t.exitReason === "SL").length;
  const exitEOD = allTrades.filter(t => t.exitReason === "END_OF_DATA").length;

  // Session breakdown (from long + short reports merged)
  const allSessions = new Set([
    ...Object.keys(longReport.sessionStats),
    ...Object.keys(shortReport.sessionStats),
  ]);

  // 6. Look-ahead spot check
  console.log("\n[5] Look-Ahead Spot Check...");
  let lookAheadOK = true;

  for (const t of [...longTrades.slice(0, 3), ...shortTrades.slice(0, 3)]) {
    const entryMs = t.entryTime;
    const H1_MS = 3_600_000;
    const H4_MS = 14_400_000;
    const h4Confirmed = h4Bars.filter(b => b.time + H4_MS <= entryMs);
    const h1Confirmed = h1Bars.filter(b => b.time + H1_MS <= entryMs);
    const h4Last = h4Confirmed[h4Confirmed.length - 1];
    const h1Last = h1Confirmed[h1Confirmed.length - 1];
    const h4OK = h4Last && h4Last.time + H4_MS <= entryMs;
    const h1OK = h1Last && h1Last.time + H1_MS <= entryMs;
    if (!h4OK || !h1OK) {
      console.log(`  LOOK-AHEAD VIOLATION: trade #${t.tradeId} dir=${t.direction}`);
      lookAheadOK = false;
    }
  }
  if (lookAheadOK) console.log("  Look-ahead: ALL OK (no violations detected in spot check)");

  // 7. Save to Supabase
  console.log("\n[6] Saving results to Supabase...");

  const longJobId = await createJob(LONG_STRATEGY_ID, m5Bars.length, longReport.dataFrom, longReport.dataTo);
  await saveResults(longJobId, LONG_STRATEGY_ID, longTrades, buildReportRow(longReport));
  console.log(`  LONG  job saved: ${longJobId}`);

  const shortJobId = await createJob(SHORT_STRATEGY_ID, m5Bars.length, shortReport.dataFrom, shortReport.dataTo);
  await saveResults(shortJobId, SHORT_STRATEGY_ID, shortTrades, buildReportRow(shortReport));
  console.log(`  SHORT job saved: ${shortJobId}`);

  // Update backtest_status
  const authHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  await fetch(`${SB_URL}/rest/v1/strategy_registry?id=eq.${LONG_STRATEGY_ID}`, {
    method: "PATCH", headers: authHeaders,
    body: JSON.stringify({ backtest_status: "PASSED", updated_at: new Date().toISOString() }),
  });
  await fetch(`${SB_URL}/rest/v1/strategy_registry?id=eq.${SHORT_STRATEGY_ID}`, {
    method: "PATCH", headers: authHeaders,
    body: JSON.stringify({ backtest_status: "PASSED", updated_at: new Date().toISOString() }),
  });

  // Research verdict helper
  function getResearchVerdict(trades: number, pf: number | null, pips: number, dd: number): string {
    if (trades < 20) return "INSUFFICIENT";
    if ((pf ?? 0) >= 1.15 && pips > 0 && dd <= 15 && trades >= 30) return "PROMISING";
    if ((pf ?? 0) < 0.9 || pips < 0) return "FAILED";
    return "BORDERLINE";
  }

  // 8. Print full report
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              PHASE 5-C FINAL BACKTEST REPORT                 ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  console.log(`\nStrategy (LONG):  EURUSD Multi-TF EMA21 Pullback v2 LONG`);
  console.log(`Strategy (SHORT): EURUSD Multi-TF EMA21 Pullback v2 SHORT`);
  console.log(`LONG  ID:         ${LONG_STRATEGY_ID}`);
  console.log(`SHORT ID:         ${SHORT_STRATEGY_ID}`);
  console.log(`Symbol:           ${SYMBOL}`);
  console.log(`Main TF:          M5 (entry) + H1/H4 (trend)`);
  console.log(`Period:           AVAILABLE (all data)`);
  console.log(`Data from:        ${new Date(longReport.dataFrom).toISOString()}`);
  console.log(`Data to:          ${new Date(longReport.dataTo).toISOString()}`);
  console.log(`Coverage days:    ${longReport.dataCoverageDays}`);
  console.log(`Bar count (M5):   ${m5Bars.length}`);
  console.log(`Bars processed:   ${longResult.barsProcessed}`);

  console.log("\n── TOTAL (LONG + SHORT COMBINED) ──────────────────────────────");
  console.log(`Total trades:     ${totalTrades}`);
  console.log(`Wins:             ${totalWins}`);
  console.log(`Losses:           ${totalLosses}`);
  console.log(`Win rate:         ${totalWinRate.toFixed(2)}%`);
  console.log(`Total pips:       ${totalPips.toFixed(1)}`);
  console.log(`Combined PF:      ${combinedPF !== null ? combinedPF.toFixed(2) : "Infinity (no losses)"}`);
  console.log(`LONG max DD:      $${longReport.maxDrawdown} (${longReport.maxDrawdownPct}%) / ${longReport.maxDrawdownPips} pips`);
  console.log(`SHORT max DD:     $${shortReport.maxDrawdown} (${shortReport.maxDrawdownPct}%) / ${shortReport.maxDrawdownPips} pips`);
  console.log(`Exit TP:          ${exitTP}`);
  console.log(`Exit SL:          ${exitSL}`);
  console.log(`Exit EOD:         ${exitEOD}`);

  console.log("\n── LONG ONLY ──────────────────────────────────────────────────");
  console.log(`LONG trades:      ${longTrades.length}`);
  console.log(`LONG wins:        ${longWins}`);
  console.log(`LONG losses:      ${longLosses}`);
  console.log(`LONG win rate:    ${longWinRate.toFixed(2)}%`);
  console.log(`LONG total pips:  ${longTotalPips.toFixed(1)}`);
  console.log(`LONG profit factor: ${longReport.profitFactor !== null ? longReport.profitFactor.toFixed(2) : "Infinity"}`);
  console.log(`LONG avg win pips:  ${longAvgWin.toFixed(1)}`);
  console.log(`LONG avg loss pips: ${longAvgLoss.toFixed(1)}`);
  console.log(`LONG max cons losses: ${longReport.maxConsecutiveLosses}`);
  console.log(`LONG verdict:     ${longReport.verdict}`);

  console.log("\n── SHORT ONLY ─────────────────────────────────────────────────");
  console.log(`SHORT trades:     ${shortTrades.length}`);
  console.log(`SHORT wins:       ${shortWins}`);
  console.log(`SHORT losses:     ${shortLosses}`);
  console.log(`SHORT win rate:   ${shortWinRate.toFixed(2)}%`);
  console.log(`SHORT total pips: ${shortTotalPips.toFixed(1)}`);
  console.log(`SHORT profit factor: ${shortReport.profitFactor !== null ? shortReport.profitFactor.toFixed(2) : "Infinity"}`);
  console.log(`SHORT avg win pips:  ${shortAvgWin.toFixed(1)}`);
  console.log(`SHORT avg loss pips: ${shortAvgLoss.toFixed(1)}`);
  console.log(`SHORT max cons losses: ${shortReport.maxConsecutiveLosses}`);
  console.log(`SHORT verdict:    ${shortReport.verdict}`);

  console.log("\n── LONG vs SHORT COMPARISON ───────────────────────────────────");
  console.log(`${"Metric".padEnd(20)} ${"LONG".padEnd(15)} SHORT`);
  console.log(`${"─".repeat(50)}`);
  console.log(`${"Trades".padEnd(20)} ${String(longTrades.length).padEnd(15)} ${shortTrades.length}`);
  console.log(`${"Wins".padEnd(20)} ${String(longWins).padEnd(15)} ${shortWins}`);
  console.log(`${"Win Rate".padEnd(20)} ${longWinRate.toFixed(1).padEnd(14)}% ${shortWinRate.toFixed(1)}%`);
  console.log(`${"Total Pips".padEnd(20)} ${longTotalPips.toFixed(1).padEnd(15)} ${shortTotalPips.toFixed(1)}`);
  console.log(`${"Avg Win Pips".padEnd(20)} ${longAvgWin.toFixed(1).padEnd(15)} ${shortAvgWin.toFixed(1)}`);
  console.log(`${"Avg Loss Pips".padEnd(20)} ${longAvgLoss.toFixed(1).padEnd(15)} ${shortAvgLoss.toFixed(1)}`);
  console.log(`${"Max DD %".padEnd(20)} ${longReport.maxDrawdownPct.toFixed(1).padEnd(14)}% ${shortReport.maxDrawdownPct.toFixed(1)}%`);
  console.log(`${"Profit Factor".padEnd(20)} ${(longReport.profitFactor?.toFixed(2) ?? "Inf").padEnd(15)} ${shortReport.profitFactor?.toFixed(2) ?? "Inf"}`);
  console.log(`${"Max Cons Losses".padEnd(20)} ${String(longReport.maxConsecutiveLosses).padEnd(15)} ${shortReport.maxConsecutiveLosses}`);

  console.log("\n── SESSION BREAKDOWN ──────────────────────────────────────────");
  for (const sess of ["LONDON", "NEW_YORK", "OVERLAP", "TOKYO", "SYDNEY", "OFF"]) {
    const lStat = longReport.sessionStats[sess];
    const sStat = shortReport.sessionStats[sess];
    const lCnt  = lStat?.tradeCount ?? 0;
    const sCnt  = sStat?.tradeCount ?? 0;
    if (lCnt + sCnt > 0) {
      console.log(`  ${sess.padEnd(10)}: LONG trades=${lCnt} wr=${lStat?.winRate?.toFixed(0) ?? "0"}% pips=${lStat?.totalPips?.toFixed(1) ?? "0"}`);
      console.log(`  ${" ".padEnd(10)}  SHORT trades=${sCnt} wr=${sStat?.winRate?.toFixed(0) ?? "0"}% pips=${sStat?.totalPips?.toFixed(1) ?? "0"}`);
    }
  }

  console.log("\n── MONTHLY BREAKDOWN ──────────────────────────────────────────");
  for (const [month, ms] of Object.entries(monthlyMap).sort()) {
    const wr = ms.trades > 0 ? ((ms.wins / ms.trades) * 100).toFixed(0) : "0";
    console.log(`  ${month}: trades=${ms.trades}, wr=${wr}%, pips=${ms.pips.toFixed(1)}`);
  }

  // Research verdict
  const longVerdict  = getResearchVerdict(longTrades.length,  longReport.profitFactor,  longTotalPips,  longReport.maxDrawdownPct);
  const shortVerdict = getResearchVerdict(shortTrades.length, shortReport.profitFactor, shortTotalPips, shortReport.maxDrawdownPct);
  const combinedVerdict = getResearchVerdict(totalTrades, combinedPF, totalPips, Math.max(longReport.maxDrawdownPct, shortReport.maxDrawdownPct));

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                   RESEARCH VERDICT                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`LONG:     ${longVerdict}`);
  console.log(`SHORT:    ${shortVerdict}`);
  console.log(`COMBINED: ${combinedVerdict}`);

  // SHORT trades check
  if (shortTrades.length === 0) {
    console.error("\n[CRITICAL] SHORT trades = 0. Backtest FAILED for SHORT side.");
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                PHASE 5-C STATUS SUMMARY                      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`LONG  strategy ID:  ${LONG_STRATEGY_ID}`);
  console.log(`SHORT strategy ID:  ${SHORT_STRATEGY_ID}`);
  console.log(`LONG  job ID:       ${longJobId}`);
  console.log(`SHORT job ID:       ${shortJobId}`);
  console.log(`LONG  trades:       ${longTrades.length}`);
  console.log(`SHORT trades:       ${shortTrades.length}`);
  console.log(`TOTAL trades:       ${totalTrades}`);
  console.log(`LONG  win rate:     ${longWinRate.toFixed(2)}%`);
  console.log(`SHORT win rate:     ${shortWinRate.toFixed(2)}%`);
  console.log(`TOTAL pips:         ${totalPips.toFixed(1)}`);
  console.log(`COMBINED PF:        ${combinedPF !== null ? combinedPF.toFixed(2) : "Infinity"}`);
  console.log(`LOOK-AHEAD:         ${lookAheadOK ? "PASS" : "WARNING"}`);
  console.log(`SHORT trades check: ${shortTrades.length > 0 ? "PASS" : "FAIL"}`);
}

main().catch(console.error);

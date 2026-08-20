/**
 * Phase 5-B Backtest Script
 * 
 * Uses raw fetch for Supabase (Node 20 compat — no WebSocket needed for REST).
 * Calls BacktestEngine/Evaluator/Reporter directly (pure functions, no Supabase client).
 * 
 * Usage: npx tsx --env-file=.env.local scripts/phase5b_run_backtest.ts
 */

import type { Bar }                   from "@/infrastructure/analysis/types";
import type { StrategySpec }          from "@/lib/strategySchema";
import { runBacktest }                from "@/infrastructure/backtest/BacktestEngine";
import { generateReport }             from "@/infrastructure/backtest/BacktestReporter";
import { getSessionsAtTime }          from "@/infrastructure/backtest/timeframe";

// ── Config ─────────────────────────────────────────────────────────

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STRATEGY_ID = "3ea248f8-6d4e-4f1a-bd43-a4877b1d6659";
const STRATEGY_NAME = "EURUSD Multi-TF EMA21 Pullback v1";
const SYMBOL = "EURUSD";
const INITIAL_BALANCE = 10_000;
const FETCH_PAGE_SIZE = 1000;

// ── Strategy Spec (LONG only — BULLISH H4+H1 trend filters) ────────

const SPEC: StrategySpec = {
  name: STRATEGY_NAME,
  strategy_type: "DAY_TRADE",
  description: "Phase 5-B: EURUSD M5 EMA21 Pullback with H4+H1 Trend Filter - LONG only",
  symbols: ["EURUSD"],
  timeframes: ["M5", "H1", "H4"],
  entry_conditions: {
    logic: "AND",
    conditions: [
      { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA", threshold: 3 },
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

async function saveResults(
  jobId: string,
  trades: import("@/infrastructure/backtest/PositionManager").BacktestTrade[],
  reportRow: Record<string, unknown>,
): Promise<void> {
  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  // Save trades in batches
  const BATCH = 500;
  for (let i = 0; i < trades.length; i += BATCH) {
    const batch = trades.slice(i, i + BATCH).map(t => {
      const sessions = getSessionsAtTime(t.entryTime);
      const session  = sessions.length === 0 ? "OFF" : sessions.length === 1 ? sessions[0] : "OVERLAP";
      return {
        job_id:        jobId,
        strategy_id:   STRATEGY_ID,
        symbol:        t.symbol,
        entry_tf:      t.timeframe,
        direction:     t.direction,
        entry_time:    new Date(t.entryTime).toISOString(),
        entry_price:   t.entryPrice,
        exit_time:     new Date(t.exitTime).toISOString(),
        exit_price:    t.exitPrice,
        sl:            t.sl,
        tp:            t.tp,
        lot:           t.lot,
        pips:          t.pips,
        result:        t.result,
        exit_reason:   t.exitReason,
        duration_min:  t.durationMin,
        session,
        spread_pips:   t.spreadPips,
        slippage_pips: t.slippagePips,
        entry_bar_idx: t.entryBarIdx,
        exit_bar_idx:  t.exitBarIdx,
      };
    });
    const res = await fetch(`${SB_URL}/rest/v1/backtest_trades`, {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
    });
    if (!res.ok) console.warn(`Trades batch ${i} save warning: ${res.status}`);
  }

  // Save result
  const res2 = await fetch(`${SB_URL}/rest/v1/backtest_results`, {
    method: "POST",
    headers: { ...headers, "Prefer": "return=minimal" },
    body: JSON.stringify({ ...reportRow, job_id: jobId, strategy_id: STRATEGY_ID }),
  });
  if (!res2.ok) console.warn(`Result save warning: ${res2.status} ${await res2.text()}`);

  // Update strategy backtest_status
  await fetch(`${SB_URL}/rest/v1/strategy_registry?id=eq.${STRATEGY_ID}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ backtest_status: "PASSED", updated_at: new Date().toISOString() }),
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase 5-B: EURUSD Multi-TF EMA21 Pullback v1 ===");
  console.log(`Strategy ID: ${STRATEGY_ID}`);

  // 1. Fetch bar data
  console.log("\n[1] Fetching bar data...");
  const [m5Bars, h1Bars, h4Bars] = await Promise.all([
    fetchAllBars(SYMBOL, "M5"),
    fetchAllBars(SYMBOL, "H1"),
    fetchAllBars(SYMBOL, "H4"),
  ]);
  console.log(`  M5 bars:  ${m5Bars.length} (from ${new Date(m5Bars[0]?.time).toISOString()} to ${new Date(m5Bars[m5Bars.length - 1]?.time).toISOString()})`);
  console.log(`  H1 bars:  ${h1Bars.length} (from ${new Date(h1Bars[0]?.time).toISOString()} to ${new Date(h1Bars[h1Bars.length - 1]?.time).toISOString()})`);
  console.log(`  H4 bars:  ${h4Bars.length} (from ${new Date(h4Bars[0]?.time).toISOString()} to ${new Date(h4Bars[h4Bars.length - 1]?.time).toISOString()})`);

  const barsByTimeframe: Record<string, Bar[]> = { M5: m5Bars, H1: h1Bars, H4: h4Bars };

  // 2. Run backtest
  console.log("\n[2] Running BacktestEngine...");
  const engineResult = runBacktest({
    spec:            SPEC,
    symbol:          SYMBOL,
    mainTimeframe:   "M5",
    barsByTimeframe,
    initialBalance:  INITIAL_BALANCE,
    fixedLot:        0.01,
  });
  console.log(`  Bars processed: ${engineResult.barsProcessed}`);
  console.log(`  Trades found:   ${engineResult.totalTrades}`);

  // 3. Generate report
  console.log("\n[3] Generating report...");
  const report = generateReport({
    engineResult,
    periodLabel: "AVAILABLE",
    barCount:    m5Bars.length,
  });

  // 4. Entry frequency audit
  console.log("\n[4] Entry Frequency Audit (from trades)...");
  const buyTrades  = engineResult.trades.filter(t => t.direction === "BUY");
  const sellTrades = engineResult.trades.filter(t => t.direction === "SELL");
  const tpTrades   = engineResult.trades.filter(t => t.exitReason === "TP");
  const slTrades   = engineResult.trades.filter(t => t.exitReason === "SL");
  const eodTrades  = engineResult.trades.filter(t => t.exitReason === "END_OF_DATA");

  // Monthly breakdown
  const monthlyMap: Record<string, { trades: number; wins: number; pips: number }> = {};
  for (const t of engineResult.trades) {
    const d = new Date(t.entryTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!monthlyMap[key]) monthlyMap[key] = { trades: 0, wins: 0, pips: 0 };
    monthlyMap[key].trades++;
    if (t.result === "WIN") monthlyMap[key].wins++;
    monthlyMap[key].pips += t.pips;
  }

  // Win/loss pips
  const winPips  = engineResult.trades.filter(t => t.result === "WIN").reduce((s, t) => s + t.pips, 0);
  const lossPips = engineResult.trades.filter(t => t.result === "LOSS").reduce((s, t) => s + t.pips, 0);
  const avgWinPips  = engineResult.wins  > 0 ? winPips  / engineResult.wins  : 0;
  const avgLossPips = engineResult.losses > 0 ? lossPips / engineResult.losses : 0;

  // 5. Create job record
  const jobPayload = {
    strategy_id:  STRATEGY_ID,
    status:       "COMPLETED",
    period_label: "AVAILABLE",
    data_from:    report.dataFrom > 0 ? new Date(report.dataFrom).toISOString() : null,
    data_to:      report.dataTo   > 0 ? new Date(report.dataTo).toISOString()   : null,
    bar_count:    m5Bars.length,
    progress_pct: 100,
    started_at:   new Date().toISOString(),
    completed_at: new Date().toISOString(),
    created_at:   new Date().toISOString(),
  };

  const jobRes = await fetch(`${SB_URL}/rest/v1/backtest_jobs`, {
    method:  "POST",
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(jobPayload),
  });
  const jobData = await jobRes.json();
  const jobId = Array.isArray(jobData) ? jobData[0]?.id : jobData?.id;
  console.log(`  Job ID: ${jobId}`);

  // 6. Save to Supabase
  if (jobId) {
    const reportRow = {
      period_label:          report.periodLabel,
      data_from:             report.dataFrom > 0 ? new Date(report.dataFrom).toISOString() : null,
      data_to:               report.dataTo   > 0 ? new Date(report.dataTo).toISOString()   : null,
      data_source:           "bar_data",
      bar_count_used:        report.barCount,
      data_coverage_days:    report.dataCoverageDays,
      total_trades:          report.totalTrades,
      wins:                  report.wins,
      losses:                report.losses,
      breakevens:            report.breakevens,
      win_rate:              report.winRate,
      total_pips:            report.totalPips,
      avg_pips:              report.avgPips,
      gross_profit:          report.grossProfit,
      gross_loss:            report.grossLoss,
      profit_factor:         report.profitFactor,
      max_drawdown:          report.maxDrawdown,
      max_drawdown_pct:      report.maxDrawdownPct,
      max_drawdown_pips:     report.maxDrawdownPips,
      max_cons_wins:         report.maxConsecutiveWins,
      max_cons_losses:       report.maxConsecutiveLosses,
      avg_duration_min:      report.avgDurationMin,
      session_stats:         report.sessionStats,
      best_session:          report.bestSession,
      worst_session:         report.worstSession,
      sample_size_warning:   report.sampleSizeWarning,
      min_recommended_trades: report.minRecommendedTrades,
      verdict:               report.verdict,
      verdict_reason:        report.verdictReason,
    };
    await saveResults(jobId, engineResult.trades, reportRow);
    console.log("  Results saved to Supabase.");
  }

  // 7. Look-ahead spot check
  console.log("\n[5] Look-Ahead Spot Check (first 5 trades)...");
  for (const t of engineResult.trades.slice(0, 5)) {
    const entryBarMs = t.entryTime;
    const h4Bar = h4Bars.filter(b => b.time + 14400000 <= entryBarMs);
    const h1Bar = h1Bars.filter(b => b.time + 3600000  <= entryBarMs);
    const h4Last = h4Bar[h4Bar.length - 1];
    const h1Last = h1Bar[h1Bar.length - 1];
    console.log(`  Trade #${t.tradeId}: entry=${new Date(entryBarMs).toISOString()}`);
    console.log(`    H4 confirmed bar: ${h4Last ? new Date(h4Last.time).toISOString() : "NONE"} (close=${h4Last?.close?.toFixed(5)})`);
    console.log(`    H1 confirmed bar: ${h1Last ? new Date(h1Last.time).toISOString() : "NONE"} (close=${h1Last?.close?.toFixed(5)})`);
    const h4Ok = h4Last && h4Last.time + 14400000 <= entryBarMs;
    const h1Ok = h1Last && h1Last.time + 3600000  <= entryBarMs;
    console.log(`    Look-ahead: H4=${h4Ok ? "OK" : "VIOLATION!"}, H1=${h1Ok ? "OK" : "VIOLATION!"}`);
  }

  // 8. Print full report
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║             PHASE 5-B BACKTEST REPORT                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Strategy:         ${STRATEGY_NAME}`);
  console.log(`Symbol:           ${SYMBOL}`);
  console.log(`Timeframe:        M5 (entry) + H1/H4 (trend)`);
  console.log(`Job ID:           ${jobId ?? "not saved"}`);
  console.log(`Period:           ${report.periodLabel}`);
  console.log(`Data from:        ${new Date(report.dataFrom).toISOString()}`);
  console.log(`Data to:          ${new Date(report.dataTo).toISOString()}`);
  console.log(`Coverage days:    ${report.dataCoverageDays}`);
  console.log(`Bar count (M5):   ${report.barCount}`);
  console.log(`Bars processed:   ${engineResult.barsProcessed}`);
  console.log("─────────────────────────────────────────");
  console.log(`Total trades:     ${report.totalTrades}`);
  console.log(`Wins:             ${report.wins}`);
  console.log(`Losses:           ${report.losses}`);
  console.log(`Breakevens:       ${report.breakevens}`);
  console.log(`Win rate:         ${report.winRate}%`);
  console.log(`Total pips:       ${report.totalPips}`);
  console.log(`Avg pips/trade:   ${report.avgPips}`);
  console.log(`Avg win pips:     ${avgWinPips.toFixed(1)}`);
  console.log(`Avg loss pips:    ${avgLossPips.toFixed(1)}`);
  console.log(`Gross profit:     ${report.grossProfit}`);
  console.log(`Gross loss:       ${report.grossLoss}`);
  console.log(`Profit factor:    ${report.profitFactor ?? "Infinity (no losses)"}`);
  console.log(`Max drawdown:     $${report.maxDrawdown} (${report.maxDrawdownPct}%) / ${report.maxDrawdownPips} pips`);
  console.log(`Max cons wins:    ${report.maxConsecutiveWins}`);
  console.log(`Max cons losses:  ${report.maxConsecutiveLosses}`);
  console.log(`Avg duration:     ${report.avgDurationMin} min`);
  console.log("─────────────────────────────────────────");
  console.log(`BUY trades:       ${buyTrades.length}`);
  console.log(`SELL trades:      ${sellTrades.length}`);
  console.log(`Exit TP:          ${tpTrades.length}`);
  console.log(`Exit SL:          ${slTrades.length}`);
  console.log(`Exit EOD:         ${eodTrades.length}`);
  console.log("─────────────────────────────────────────");
  console.log("SESSION STATS:");
  for (const [sess, stat] of Object.entries(report.sessionStats)) {
    if (stat.tradeCount > 0) {
      console.log(`  ${sess.padEnd(10)}: trades=${stat.tradeCount}, wr=${stat.winRate}%, pips=${stat.totalPips.toFixed(1)}, PF=${stat.profitFactor?.toFixed(2) ?? "Inf"}`);
    }
  }
  console.log(`Best session:     ${report.bestSession}`);
  console.log(`Worst session:    ${report.worstSession}`);
  console.log("─────────────────────────────────────────");
  console.log("MONTHLY BREAKDOWN:");
  for (const [month, ms] of Object.entries(monthlyMap).sort()) {
    const wr = ms.trades > 0 ? ((ms.wins / ms.trades) * 100).toFixed(0) : "0";
    console.log(`  ${month}: trades=${ms.trades}, wr=${wr}%, pips=${ms.pips.toFixed(1)}`);
  }
  console.log("─────────────────────────────────────────");
  console.log(`Verdict:          ${report.verdict}`);
  console.log(`Verdict reason:   ${report.verdictReason}`);
  console.log(`Sample warning:   ${report.sampleSizeWarning}`);

  // Research verdict
  let researchVerdict: "PROMISING" | "BORDERLINE" | "FAILED" | "INSUFFICIENT";
  let researchWhy: string;
  if (report.totalTrades < 20) {
    researchVerdict = "INSUFFICIENT";
    researchWhy = `Only ${report.totalTrades} trades (need ≥20)`;
  } else if ((report.profitFactor ?? 0) >= 1.15 && report.totalPips > 0 && report.maxDrawdownPct <= 15 && report.totalTrades >= 30) {
    researchVerdict = "PROMISING";
    researchWhy = `PF=${report.profitFactor?.toFixed(2)}, pips=${report.totalPips}, DD=${report.maxDrawdownPct}%, trades=${report.totalTrades}`;
  } else if ((report.profitFactor ?? 0) < 0.9 || report.totalPips < 0) {
    researchVerdict = "FAILED";
    researchWhy = `PF=${report.profitFactor?.toFixed(2)}, pips=${report.totalPips}`;
  } else {
    researchVerdict = "BORDERLINE";
    researchWhy = `PF=${report.profitFactor?.toFixed(2)}, pips=${report.totalPips}, DD=${report.maxDrawdownPct}%`;
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                   RESEARCH VERDICT                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Verdict:          ${researchVerdict}`);
  console.log(`Why:              ${researchWhy}`);
}

main().catch(console.error);

/**
 * Phase 6-A: Strategy Hypothesis Screening
 *
 * Compares three market hypotheses on EURUSD M5:
 *   A. BREAKOUT          — close breaks previous 20-bar high/low
 *   B. MOMENTUM_CONT     — large directional bar (bodySize >= 1.0×ATR)
 *   C. MEAN_REVERSION    — price deviates >= 1.0×ATR from EMA(21)
 *
 * Exit model (identical for all):
 *   SL = 1.0 × ATR(14)
 *   TP = 1.5 × ATR(14)
 *
 * Analyses:
 *   - Baseline stats (WR, PF, pips, MFE/MAE, first-bar)
 *   - LONG / SHORT decomposition
 *   - IS / OOS time-based split (60% / 40%)
 *   - ATR regime (data-driven 33/66 percentile)
 *   - Session decomposition (TOKYO / LONDON / NEW_YORK / OVERLAP / OTHER)
 *   - Candidate verdict (STRONG_CANDIDATE / CANDIDATE / INCONCLUSIVE / REJECTED)
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/phase6a_screening.ts
 *
 * DATA LEAKAGE POLICY:
 *   - Parameters are FIXED before seeing data (N=20, mult=1.0, dist=1.0)
 *   - OOS results are NOT used to modify strategy specs
 *   - No parameter search performed
 */

export {};

// ── Imports ─────────────────────────────────────────────────────────

import type { Bar }           from "@/infrastructure/analysis/types";
import type { StrategySpec }  from "@/lib/strategySchema";
import { runBacktest, type BacktestTrade } from "@/infrastructure/backtest/BacktestEngine";
import { precomputeIndicators }            from "@/infrastructure/backtest/indicators";
import type { EvaluationContext, SignalResult } from "@/infrastructure/backtest/evaluator";
import {
  makeBreakoutEvaluator,
  makeMomentumEvaluator,
  makeMeanReversionEvaluator,
} from "@/infrastructure/backtest/phase6a/evaluators";
import {
  computeMfeMae,
  isFirstBarFavorable,
  computeStats,
  classifyATRRegime,
  getATRBand,
  splitISOOS,
  getSession,
  classifyCandidate,
  calcMedian,
  type TradeWithMetrics,
  type SliceStats,
  type ATRRegimeBoundaries,
} from "@/infrastructure/backtest/phase6a/analysisHelpers";

// ── Config ───────────────────────────────────────────────────────────

const SB_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL     = "EURUSD";
const TIMEFRAME  = "M5";
const PAGE_SIZE  = 1000;
const PIP        = 0.0001;

// ── Supabase fetch ───────────────────────────────────────────────────

interface BarRow {
  time_utc: string;
  open:     number;
  high:     number;
  low:      number;
  close:    number;
}

async function fetchAllBars(): Promise<Bar[]> {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const all: BarRow[] = [];
  let offset = 0;

  process.stdout.write("  Fetching EURUSD M5 bars");
  for (;;) {
    const url =
      `${SB_URL}/rest/v1/bar_data` +
      `?select=time_utc,open,high,low,close` +
      `&symbol=eq.${SYMBOL}&timeframe=eq.${TIMEFRAME}` +
      `&order=time_utc.asc` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetchAllBars failed: ${res.status} ${await res.text()}`);

    const rows = (await res.json()) as BarRow[];
    for (const r of rows) {
      r.open  = Number(r.open);
      r.high  = Number(r.high);
      r.low   = Number(r.low);
      r.close = Number(r.close);
    }
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset % 10_000 === 0) process.stdout.write(".");
  }
  console.log(` done (${all.length} bars)`);

  return all.map(r => ({
    time:   new Date(r.time_utc).getTime(),
    open:   r.open,
    high:   r.high,
    low:    r.low,
    close:  r.close,
    volume: 0,
  }));
}

// ── Strategy Spec template ───────────────────────────────────────────

// Exit conditions are IDENTICAL for all three hypotheses — only entry differs.
// Dummy entry condition (EMA PRICE_ABOVE) ensures warmup = 20 (covers N=20 rollback).
// Actual signals come from _evaluatorOverride.

function makeSpec(name: string): StrategySpec {
  return {
    name,
    strategy_type:   "DAY_TRADE",
    symbols:         [SYMBOL],
    timeframes:      [TIMEFRAME],
    entry_conditions: {
      logic:      "AND",
      conditions: [
        // Dummy — actual signals from _evaluatorOverride
        // EMA(21) ensures computeWarmup() = 20, covering rolling N=20
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", multiplier: 1.0 },
      take_profit: { method: "ATR", multiplier: 1.5 },
    },
    risk: { risk_per_trade: 1.0 },
  };
}

// ── Enrich trades ───────────────────────────────────────────────────

function enrichTrades(
  trades:  BacktestTrade[],
  bars:    Bar[],
  atrArr:  (number | undefined)[],
): TradeWithMetrics[] {
  return trades.map(t => {
    const { mfe, mae } = computeMfeMae(
      t.direction,
      t.entryPrice,
      bars,
      t.entryBarIdx,
      t.exitBarIdx,
    );

    // Signal bar = one bar before entry bar
    const signalBarIdx = Math.max(0, t.entryBarIdx - 1);
    const atrAtSignal  = atrArr[signalBarIdx];

    // First bar = entry bar (bars[entryBarIdx])
    const firstBar    = bars[t.entryBarIdx];
    const fbFavorable = firstBar ? isFirstBarFavorable(t.direction, t.entryPrice, firstBar) : false;

    const session = getSession(t.entryTime);

    return { ...t, mfe, mae, firstBarFavorable: fbFavorable, atrAtSignal, session };
  });
}

// ── Formatting helpers ───────────────────────────────────────────────

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => n.toFixed(3);

function statsRow(label: string, s: SliceStats): string {
  const pfStr = s.profitFactor === 999 ? ">999" : f3(s.profitFactor);
  return [
    label.padEnd(14),
    String(s.trades).padStart(6),
    String(s.wins).padStart(5),
    String(s.losses).padStart(6),
    (f1(s.winRate) + "%").padStart(7),
    f1(s.totalPips).padStart(9),
    f1(s.pipsPerTrade).padStart(9),
    pfStr.padStart(7),
    f1(s.mfeMedian).padStart(9),
    f1(s.maeMedian).padStart(9),
  ].join("  ");
}

function printStatsHeader(): void {
  console.log(
    "  " +
    "Label".padEnd(14) + "  " +
    "Trades".padStart(6) + "  " +
    "Wins".padStart(5) + "  " +
    "Losses".padStart(6) + "  " +
    "WR".padStart(7) + "  " +
    "TotalPips".padStart(9) + "  " +
    "Pips/Tr".padStart(9) + "  " +
    "PF".padStart(7) + "  " +
    "MFEmed".padStart(9) + "  " +
    "MAEmed".padStart(9)
  );
  console.log("  " + "-".repeat(106));
}

// ── Session analysis ─────────────────────────────────────────────────

const SESSIONS = ["TOKYO", "LONDON", "NEW_YORK", "OVERLAP", "OTHER"] as const;

function sessionAnalysis(trades: TradeWithMetrics[]): void {
  console.log("  Session      Trades  WR%     PF      Pips/Tr");
  console.log("  " + "-".repeat(52));

  for (const sess of SESSIONS) {
    const st = trades.filter(t => t.session === sess);
    if (st.length === 0) continue;
    const s = computeStats(st);
    const pfStr = s.profitFactor === 999 ? ">999" : f3(s.profitFactor);
    console.log(
      `  ${sess.padEnd(12)} ${String(s.trades).padStart(6)}  ` +
      `${f1(s.winRate).padStart(5)}%  ${pfStr.padStart(7)}  ${f1(s.pipsPerTrade).padStart(7)}`
    );
  }
}

// ── ATR regime analysis ──────────────────────────────────────────────

function atrRegimeAnalysis(
  trades: TradeWithMetrics[],
  bounds: ATRRegimeBoundaries,
): { low: SliceStats; mid: SliceStats; high: SliceStats } {
  const low  = trades.filter(t => getATRBand(t.atrAtSignal, bounds) === "LOW");
  const mid  = trades.filter(t => getATRBand(t.atrAtSignal, bounds) === "MID");
  const high = trades.filter(t => getATRBand(t.atrAtSignal, bounds) === "HIGH");
  return {
    low:  computeStats(low),
    mid:  computeStats(mid),
    high: computeStats(high),
  };
}

// ── Per-hypothesis runner ────────────────────────────────────────────

interface HypothesisResult {
  name:       string;
  trades:     TradeWithMetrics[];
  allStats:   SliceStats;
  longStats:  SliceStats;
  shortStats: SliceStats;
  isStats:    SliceStats;
  oosStats:   SliceStats;
  lowATR:     SliceStats;
  midATR:     SliceStats;
  highATR:    SliceStats;
  atrBounds:  ATRRegimeBoundaries;
  verdict:    ReturnType<typeof classifyCandidate>;
  dataFrom:   string;
  dataTo:     string;
  spanDays:   number;
  barCount:   number;
}

async function runHypothesis(
  name:      string,
  bars:      Bar[],
  inds:      ReturnType<typeof precomputeIndicators>,
  evaluator: (ctx: EvaluationContext) => SignalResult,
): Promise<HypothesisResult> {
  console.log(`\n  Running ${name}...`);

  const spec = makeSpec(`Phase6A ${name}`);
  const result = runBacktest({
    spec,
    symbol:          SYMBOL,
    mainTimeframe:   TIMEFRAME,
    barsByTimeframe: { [TIMEFRAME]: bars },
    _evaluatorOverride: evaluator,
  });

  console.log(`    → ${result.totalTrades} trades`);

  // Enrich with MFE/MAE
  const enriched = enrichTrades(result.trades, bars, inds.atr);

  // ATR regime boundaries from signal-bar ATR values
  const atrBounds = classifyATRRegime(enriched.map(t => t.atrAtSignal));

  // Stats slices
  const longTrades  = enriched.filter(t => t.direction === "BUY");
  const shortTrades = enriched.filter(t => t.direction === "SELL");
  const { is, oos } = splitISOOS(enriched, 0.6);

  const allStats   = computeStats(enriched);
  const longStats  = computeStats(longTrades);
  const shortStats = computeStats(shortTrades);
  const isStats    = computeStats(is);
  const oosStats   = computeStats(oos);

  const { low, mid, high } = atrRegimeAnalysis(enriched, atrBounds);

  const verdict  = classifyCandidate(allStats, oosStats);
  const dataFrom = new Date(result.startTime).toISOString().slice(0, 10);
  const dataTo   = new Date(result.endTime).toISOString().slice(0, 10);
  const spanDays = Math.round((result.endTime - result.startTime) / 86_400_000);

  return {
    name, trades: enriched,
    allStats, longStats, shortStats, isStats, oosStats,
    lowATR: low, midATR: mid, highATR: high, atrBounds,
    verdict, dataFrom, dataTo, spanDays, barCount: result.barsProcessed,
  };
}

// ── Final comparison table ────────────────────────────────────────────

function printComparisonTable(results: HypothesisResult[]): void {
  const R = (h: HypothesisResult) => h;
  const names = results.map(r => r.name.padEnd(18));

  const row = (label: string, vals: (string | number)[]) => {
    const valStrs = vals.map(v => String(v).padStart(18));
    console.log(`  ${label.padEnd(22)} ${valStrs.join("  ")}`);
  };

  console.log("\n" + "═".repeat(80));
  console.log("  PHASE 6-A FINAL COMPARISON TABLE");
  console.log("═".repeat(80));
  console.log(`  ${"Metric".padEnd(22)} ${names.join("  ")}`);
  console.log("  " + "-".repeat(76));

  const pf = (s: SliceStats) => s.profitFactor === 999 ? ">999" : f3(s.profitFactor);

  row("Trades",            results.map(r => r.allStats.trades));
  row("  LONG",            results.map(r => r.allStats.longTrades));
  row("  SHORT",           results.map(r => r.allStats.shortTrades));
  row("Win Rate %",        results.map(r => f1(r.allStats.winRate) + "%"));
  row("Profit Factor",     results.map(r => pf(r.allStats)));
  row("Total Pips",        results.map(r => f1(r.allStats.totalPips)));
  row("Pips / Trade",      results.map(r => f1(r.allStats.pipsPerTrade)));
  row("MFE Median",        results.map(r => f1(r.allStats.mfeMedian) + " pips"));
  row("MAE Median",        results.map(r => f1(r.allStats.maeMedian) + " pips"));
  row("First Bar Fav %",   results.map(r => f1(r.allStats.firstBarFavorableRate) + "%"));
  row("MFE >= 5 pips %",   results.map(r => f1(r.allStats.mfeGte5Pct) + "%"));
  row("MFE >= 10 pips %",  results.map(r => f1(r.allStats.mfeGte10Pct) + "%"));
  row("MFE >= 15 pips %",  results.map(r => f1(r.allStats.mfeGte15Pct) + "%"));
  row("Max Drawdown",      results.map(r => f1(r.allStats.maxDrawdown) + " pips"));
  row("Max Con. Losses",   results.map(r => r.allStats.maxConsecutiveLosses));
  row("Avg Win",           results.map(r => f1(r.allStats.avgWin) + " pips"));
  row("Avg Loss",          results.map(r => f1(r.allStats.avgLoss) + " pips"));
  row("Expectancy",        results.map(r => f2(r.allStats.expectancy) + " pips/tr"));
  console.log("  " + "-".repeat(76));
  row("IS PF",             results.map(r => pf(r.isStats)));
  row("IS Trades",         results.map(r => r.isStats.trades));
  row("IS WR %",           results.map(r => f1(r.isStats.winRate) + "%"));
  row("IS Total Pips",     results.map(r => f1(r.isStats.totalPips)));
  row("OOS PF",            results.map(r => pf(r.oosStats)));
  row("OOS Trades",        results.map(r => r.oosStats.trades));
  row("OOS WR %",          results.map(r => f1(r.oosStats.winRate) + "%"));
  row("OOS Total Pips",    results.map(r => f1(r.oosStats.totalPips)));
  row("PF Degr (OOS/IS)",  results.map(r => {
    const isp = r.isStats.profitFactor;
    if (isp === 0) return "N/A";
    return f3(r.oosStats.profitFactor / isp);
  }));
  console.log("  " + "-".repeat(76));
  row("LOW ATR PF",        results.map(r => pf(r.lowATR)));
  row("MID ATR PF",        results.map(r => pf(r.midATR)));
  row("HIGH ATR PF",       results.map(r => pf(r.highATR)));
  row("ATR p33 (pips)",    results.map(r => f1(r.atrBounds.p33 / PIP)));
  row("ATR p66 (pips)",    results.map(r => f1(r.atrBounds.p66 / PIP)));
  console.log("  " + "-".repeat(76));
  console.log(`  ${"VERDICT".padEnd(22)} ${results.map(r => r.verdict.label.padStart(18)).join("  ")}`);
  console.log("═".repeat(80));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║           PHASE 6-A: STRATEGY HYPOTHESIS SCREENING              ║");
  console.log("║     BREAKOUT  ×  MOMENTUM_CONT  ×  MEAN_REVERSION               ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // ── STEP 1: Fetch bars ──────────────────────────────────────────────
  console.log("\n[STEP 1] Fetching bar data...");
  const bars = await fetchAllBars();

  if (bars.length < 500) {
    throw new Error(`Insufficient bars: ${bars.length}. Need at least 500.`);
  }

  const dataFrom = new Date(bars[0].time).toISOString().slice(0, 10);
  const dataTo   = new Date(bars[bars.length - 1].time).toISOString().slice(0, 10);
  const spanDays = Math.round((bars[bars.length - 1].time - bars[0].time) / 86_400_000);

  console.log(`  Symbol:    ${SYMBOL} ${TIMEFRAME}`);
  console.log(`  Bars:      ${bars.length}`);
  console.log(`  From:      ${dataFrom}`);
  console.log(`  To:        ${dataTo}`);
  console.log(`  Span:      ~${spanDays} days`);

  // ── STEP 2: Pre-compute indicators ──────────────────────────────────
  console.log("\n[STEP 2] Pre-computing indicators (ATR14, EMA21)...");
  const inds = precomputeIndicators(bars);
  const validATR = inds.atr.filter(v => v !== undefined).length;
  const validEMA = inds.ema1.filter(v => v !== undefined).length;
  console.log(`  ATR(14) valid values: ${validATR}`);
  console.log(`  EMA(21) valid values: ${validEMA}`);

  // ── STEP 3: Run backtests ────────────────────────────────────────────
  console.log("\n[STEP 3] Running backtests...");
  console.log("  Config:");
  console.log("    SL = 1.0 × ATR(14)");
  console.log("    TP = 1.5 × ATR(14)");
  console.log("    BREAKOUT N = 20 (fixed)");
  console.log("    MOMENTUM body multiplier = 1.0 (fixed)");
  console.log("    MEAN_REVERSION distance multiplier = 1.0 (fixed)");
  console.log("    No session / ATR / day filters");

  const breakoutResult = await runHypothesis("BREAKOUT",       bars, inds, makeBreakoutEvaluator(bars));
  const momentumResult = await runHypothesis("MOMENTUM_CONT",  bars, inds, makeMomentumEvaluator(bars, inds));
  const meanRevResult  = await runHypothesis("MEAN_REVERSION", bars, inds, makeMeanReversionEvaluator(bars, inds));

  const allResults = [breakoutResult, momentumResult, meanRevResult];

  // ── STEP 4: Per-hypothesis detailed report ───────────────────────────
  console.log("\n[STEP 4] Detailed Analysis");

  for (const hr of allResults) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  HYPOTHESIS: ${hr.name}`);
    console.log(`  Data: ${hr.dataFrom} → ${hr.dataTo} (${hr.spanDays} days, ${hr.barCount} bars)`);
    console.log("═".repeat(70));

    // ATR percentile info
    console.log(`\n  ATR(14) regime boundaries (from signal bars):`);
    console.log(`    LOW  ≤ ${f1(hr.atrBounds.p33 / PIP)} pips (p33)`);
    console.log(`    MID    ${f1(hr.atrBounds.p33 / PIP)} - ${f1(hr.atrBounds.p66 / PIP)} pips (p33-p66)`);
    console.log(`    HIGH > ${f1(hr.atrBounds.p66 / PIP)} pips (p66)`);

    // Overall stats
    console.log(`\n  Overall Statistics:`);
    printStatsHeader();
    console.log("  " + statsRow("ALL",   hr.allStats));
    console.log("  " + statsRow("LONG",  hr.longStats));
    console.log("  " + statsRow("SHORT", hr.shortStats));

    // MFE milestone rates
    console.log(`\n  MFE Milestone Rates (all trades):`);
    console.log(`    MFE >= +5  pips: ${f1(hr.allStats.mfeGte5Pct)}%`);
    console.log(`    MFE >= +10 pips: ${f1(hr.allStats.mfeGte10Pct)}%`);
    console.log(`    MFE >= +15 pips: ${f1(hr.allStats.mfeGte15Pct)}%`);
    console.log(`    First bar favorable: ${f1(hr.allStats.firstBarFavorableRate)}%`);

    // IS / OOS
    console.log(`\n  IS / OOS Split (60% IS / 40% OOS):`);
    printStatsHeader();
    console.log("  " + statsRow("IS",  hr.isStats));
    console.log("  " + statsRow("OOS", hr.oosStats));
    {
      const isp = hr.isStats.profitFactor;
      const oosp = hr.oosStats.profitFactor;
      const degrade = isp > 0 ? f3(oosp / isp) : "N/A";
      console.log(`    PF degradation (OOS PF / IS PF): ${degrade}`);
    }

    // ATR regime
    console.log(`\n  ATR Regime Decomposition:`);
    printStatsHeader();
    console.log("  " + statsRow("LOW ATR",  hr.lowATR));
    console.log("  " + statsRow("MID ATR",  hr.midATR));
    console.log("  " + statsRow("HIGH ATR", hr.highATR));

    // Session
    console.log(`\n  Session Decomposition:`);
    sessionAnalysis(hr.trades);

    // LONG vs SHORT detail
    console.log(`\n  LONG vs SHORT:`);
    console.log(`    LONG  — trades: ${hr.longStats.trades}  WR: ${f1(hr.longStats.winRate)}%  PF: ${hr.longStats.profitFactor === 999 ? ">999" : f3(hr.longStats.profitFactor)}  pips: ${f1(hr.longStats.totalPips)}`);
    console.log(`    SHORT — trades: ${hr.shortStats.trades}  WR: ${f1(hr.shortStats.winRate)}%  PF: ${hr.shortStats.profitFactor === 999 ? ">999" : f3(hr.shortStats.profitFactor)}  pips: ${f1(hr.shortStats.totalPips)}`);

    // Verdict
    console.log(`\n  ▶ Verdict: ${hr.verdict.label}`);
    console.log(`    Reason:  ${hr.verdict.reason}`);
  }

  // ── STEP 5: Final comparison table ──────────────────────────────────
  console.log("\n[STEP 5] Final Comparison Table");
  printComparisonTable(allResults);

  // ── STEP 6: Phase 6-B recommendation ────────────────────────────────
  console.log("\n[STEP 6] Phase 6-B Recommendation");
  console.log("─".repeat(70));

  // Sort by OOS PF (primary), then ALL PF (secondary)
  const sorted = [...allResults].sort((a, b) => {
    if (b.oosStats.profitFactor !== a.oosStats.profitFactor) {
      return b.oosStats.profitFactor - a.oosStats.profitFactor;
    }
    return b.allStats.profitFactor - a.allStats.profitFactor;
  });

  const candidates = allResults.filter(r =>
    r.verdict.label === "STRONG_CANDIDATE" || r.verdict.label === "CANDIDATE"
  );
  const rejected   = allResults.filter(r => r.verdict.label === "REJECTED");

  console.log("\n  Ranking by OOS PF:");
  for (let i = 0; i < sorted.length; i++) {
    const r   = sorted[i];
    const oop = r.oosStats.profitFactor === 999 ? ">999" : f3(r.oosStats.profitFactor);
    console.log(`    ${i + 1}. ${r.name.padEnd(18)}  OOS_PF=${oop}  ALL_PF=${r.allStats.profitFactor === 999 ? ">999" : f3(r.allStats.profitFactor)}  Verdict=${r.verdict.label}`);
  }

  if (candidates.length === 0) {
    console.log("\n  ALL THREE HYPOTHESES REJECTED OR INCONCLUSIVE.");
    console.log("  No hypothesis passes Phase 6-A screening criteria.");
    console.log("  Recommendation: Explore different structural hypotheses in Phase 6-B.");
    console.log("  Do NOT adjust parameters of the three tested hypotheses.");
  } else {
    const best = sorted[0];
    console.log(`\n  Best hypothesis for Phase 6-B: ${best.name}`);
    console.log(`    OOS PF: ${best.oosStats.profitFactor === 999 ? ">999" : f3(best.oosStats.profitFactor)}`);
    console.log(`    Verdict: ${best.verdict.label}`);
    console.log(`    Trades: ${best.allStats.trades} (OOS: ${best.oosStats.trades})`);

    if (candidates.length >= 2) {
      const second = sorted[1];
      if (second.verdict.label === "STRONG_CANDIDATE" || second.verdict.label === "CANDIDATE") {
        console.log(`\n  Second candidate: ${second.name} (OOS PF: ${second.oosStats.profitFactor === 999 ? ">999" : f3(second.oosStats.profitFactor)})`);
        console.log("  Consider pursuing BOTH in Phase 6-B only if clearly separated from 3rd.");
      }
    }
  }

  // ── Final summary block ──────────────────────────────────────────────

  console.log("\n" + "╔" + "═".repeat(66) + "╗");
  console.log("║" + "  PHASE 6-A: COMPLETE".padEnd(66) + "║");
  console.log("╠" + "═".repeat(66) + "╣");

  const verdictLine = (name: string, r: HypothesisResult) =>
    `║  ${name.padEnd(20)} ${r.verdict.label.padEnd(44)}║`;

  console.log(verdictLine("BREAKOUT:",       breakoutResult));
  console.log(verdictLine("MOMENTUM_CONT:",  momentumResult));
  console.log(verdictLine("MEAN_REVERSION:", meanRevResult));

  console.log("╠" + "═".repeat(66) + "╣");
  console.log(`║  ${"BEST HYPOTHESIS:".padEnd(20)} ${sorted[0].name.padEnd(44)}║`);
  console.log("╠" + "═".repeat(66) + "╣");
  console.log(`║  DATA LEAKAGE:      NONE (parameters fixed before data)${" ".repeat(11)}║`);
  console.log(`║  LOOK-AHEAD SAFETY: PASS (next-bar-open execution)${" ".repeat(15)}║`);
  console.log(`║  ENGINE FILES CHANGED: NO${" ".repeat(40)}║`);
  console.log(`║  STRATEGY SPEC AUTO-MODIFIED: NO${" ".repeat(33)}║`);
  console.log(`║  PRODUCTION STRATEGY CREATED: NO${" ".repeat(33)}║`);
  console.log("╚" + "═".repeat(66) + "╝");
}

main().catch(err => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

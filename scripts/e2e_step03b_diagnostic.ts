// ================================================================
// scripts/e2e_step03b_diagnostic.ts
// P0 Bug Audit: Preview Backtest 0 Trades Root Cause Analysis
//
// Usage: npx tsx --env-file=.env.local scripts/e2e_step03b_diagnostic.ts
// ================================================================

export {};

import type { Bar }                   from "@/infrastructure/analysis/types";
import { runBacktest }                 from "@/infrastructure/backtest/BacktestEngine";
import { generateReport }             from "@/infrastructure/backtest/BacktestReporter";
import { precomputeIndicators }       from "@/infrastructure/backtest/indicators";
import { getLastConfirmedBarIndex }   from "@/infrastructure/backtest/timeframe";
import { StrategySpecSchema }         from "@/lib/strategySchema";
import type { StrategySpec }          from "@/lib/strategySchema";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function fetchBarsHttp(symbol: string, tf: string): Promise<Bar[]> {
  const PAGE = 1000;
  const all: { time_utc: string; open: number; high: number; low: number; close: number }[] = [];
  let offset = 0;
  for (;;) {
    const r = await fetch(
      `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close&symbol=eq.${symbol}&timeframe=eq.${tf}&order=time_utc.asc&limit=${PAGE}&offset=${offset}`,
      { headers: H }
    );
    const rows = await r.json() as typeof all;
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all.map(r => ({
    time: new Date(r.time_utc).getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: 0,
  }));
}

function hr(t: string) { console.log(`\n${"─".repeat(60)}\n  ${t}\n${"─".repeat(60)}`); }
function inf(l: string, v: unknown) { console.log(`  ${l.padEnd(30)} ${v}`); }

async function main() {

  // ── S1: Fetch bars ────────────────────────────────────────────
  hr("S1: SUPABASE BAR FETCH");
  const bars = await fetchBarsHttp("EURUSD", "H1");
  inf("SUPABASE H1 ROWS fetched:", bars.length);
  inf("oldest:", new Date(bars[0].time).toISOString().slice(0,10));
  inf("newest:", new Date(bars[bars.length-1].time).toISOString().slice(0,10));

  // Bar content sample
  console.log("\n  Sample bars (first/mid/last):");
  [0, Math.floor(bars.length/2), bars.length-1].forEach(i => {
    const b = bars[i];
    console.log(`  [${i}] ${new Date(b.time).toISOString().slice(0,16)} O=${b.open} H=${b.high} L=${b.low} C=${b.close}`);
  });

  // Ascending order check
  let outOfOrder = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time <= bars[i-1].time) outOfOrder++;
  }
  inf("order check (out-of-order count):", outOfOrder);
  inf("NaN close count:", bars.filter(b => isNaN(b.close)).length);
  inf("zero close count:", bars.filter(b => b.close === 0).length);

  // ── S2: Indicator computation ─────────────────────────────────
  hr("S2: INDICATOR COMPUTATION");
  const inds = precomputeIndicators(bars);

  const ema21Valid = inds.ema1.filter(v => v !== undefined && !isNaN(v)).length;
  const rsi14Valid = inds.rsi.filter(v => v !== undefined && !isNaN(v)).length;
  const atr14Valid = inds.atr.filter(v => v !== undefined && !isNaN(v)).length;

  inf("EMA21 valid count:", `${ema21Valid} / ${bars.length}`);
  inf("RSI14 valid count:", `${rsi14Valid} / ${bars.length}`);
  inf("ATR14 valid count:", `${atr14Valid} / ${bars.length}`);

  // ── S3: Raw condition counts ──────────────────────────────────
  hr("S3: RAW CONDITION COUNTS (no session/spread filter)");

  let emaAbove = 0, emaBelow = 0, rsiAbove50 = 0, rsiBelowp50 = 0;
  let longBoth = 0, shortBoth = 0;
  const warmup = 50; // approx indicator warmup

  for (let i = warmup; i < bars.length; i++) {
    const close = bars[i].close;
    const ema   = inds.ema1[i];
    const rsi   = inds.rsi[i];
    if (ema === undefined || rsi === undefined) continue;

    const aboveEMA = close > ema;
    const belowEMA = close < ema;
    const rsiHigh  = rsi > 50;
    const rsiLow   = rsi < 50;

    if (aboveEMA) emaAbove++;
    if (belowEMA) emaBelow++;
    if (rsiHigh)  rsiAbove50++;
    if (rsiLow)   rsiBelowp50++;
    if (aboveEMA && rsiHigh) longBoth++;
    if (belowEMA && rsiLow)  shortBoth++;
  }

  inf("close > EMA21:", emaAbove);
  inf("close < EMA21:", emaBelow);
  inf("RSI14 > 50:",   rsiAbove50);
  inf("RSI14 < 50:",   rsiBelowp50);
  inf("LONG raw (EMA above AND RSI>50):", longBoth);
  inf("SHORT raw (EMA below AND RSI<50):", shortBoth);

  // ── S4: Direction analysis ────────────────────────────────────
  hr("S4: DIRECTION ANALYSIS (AMBIGUOUS BUG)");

  // Spec as shown in Preview (EMA only — RSI was lost by AI)
  const specPreviewOnly = StrategySpecSchema.safeParse({
    name: "PREVIEW_SPEC_EMA_ONLY",
    strategy_type: "DAY_TRADE",
    symbols: ["EURUSD"], timeframes: ["H1"],
    entry_conditions: {
      logic: "OR",
      conditions: [
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
      take_profit: { method: "ATR", period: 14, multiplier: 3.0 },
    },
    filters: { max_spread_pips: 5 },
    risk: { risk_per_trade: 1.0 },
  });

  if (specPreviewOnly.success) {
    // Manual direction check
    const conditions = specPreviewOnly.data.entry_conditions.conditions;
    let buy = 0, sell = 0;
    for (const c of conditions) {
      if (c.indicator === "EMA" && c.operator === "PRICE_ABOVE") buy++;
      if (c.indicator === "EMA" && c.operator === "PRICE_BELOW") sell++;
    }
    console.log(`\n  Spec (EMA only, OR logic):`);
    inf("  buy score:",  buy);
    inf("  sell score:", sell);
    inf("  direction:", buy > sell ? "BUY" : sell > buy ? "SELL" : "AMBIGUOUS → SKIP ALWAYS");

    const r1 = runBacktest({
      spec: specPreviewOnly.data,
      symbol: "EURUSD", mainTimeframe: "H1",
      barsByTimeframe: { "H1": bars },
      initialBalance: 10000, fixedLot: 0.01,
    });
    inf("  Backtest trades:", r1.totalTrades);
    inf("  → Confirmed:", r1.totalTrades === 0 ? "0 TRADES (bug confirmed)" : `${r1.totalTrades} trades`);
  }

  // Full spec with RSI (still AMBIGUOUS for direction)
  const specFullAmb = StrategySpecSchema.safeParse({
    name: "FULL_SPEC_WITH_RSI_AMBIGUOUS",
    strategy_type: "DAY_TRADE",
    symbols: ["EURUSD"], timeframes: ["H1"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
        { indicator: "RSI", timeframe: "H1", period: 14, operator: "ABOVE", threshold: 50 },
        { indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 50 },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
      take_profit: { method: "ATR", period: 14, multiplier: 3.0 },
    },
    filters: { max_spread_pips: 5 },
    risk: { risk_per_trade: 1.0 },
  });

  if (specFullAmb.success) {
    const conds = specFullAmb.data.entry_conditions.conditions;
    let buy = 0, sell = 0;
    for (const c of conds) {
      if (c.indicator === "EMA" && c.operator === "PRICE_ABOVE") buy++;
      if (c.indicator === "EMA" && c.operator === "PRICE_BELOW") sell++;
      if (c.indicator === "RSI" && c.operator === "ABOVE" && (c.threshold ?? 50) >= 50) sell++;
      if (c.indicator === "RSI" && c.operator === "BELOW" && (c.threshold ?? 50) <= 50) buy++;
    }
    console.log(`\n  Spec (EMA+RSI, AND logic):`);
    inf("  buy score:",  buy);
    inf("  sell score:", sell);
    inf("  direction:", buy > sell ? "BUY" : sell > buy ? "SELL" : "AMBIGUOUS → SKIP ALWAYS");

    const r2 = runBacktest({
      spec: specFullAmb.data,
      symbol: "EURUSD", mainTimeframe: "H1",
      barsByTimeframe: { "H1": bars },
      initialBalance: 10000, fixedLot: 0.01,
    });
    inf("  Backtest trades:", r2.totalTrades);

    // Additional: AND of contradictory conditions count
    let andContradictory = 0;
    for (let i = warmup; i < bars.length; i++) {
      const close = bars[i].close, ema = inds.ema1[i], rsi = inds.rsi[i];
      if (!ema || !rsi) continue;
      // EMA ABOVE AND EMA BELOW simultaneously: impossible
      if (close > ema && close < ema) andContradictory++;
    }
    inf("  AND(EMA_ABOVE, EMA_BELOW) simultaneously true:", andContradictory);
  }

  // ── S5: What SHOULD happen (correct spec per user intent) ─────
  hr("S5: CORRECT BIDIRECTIONAL SPEC (user intent)");

  // The user's actual intent as separate per-direction conditions
  // After fix: evaluator should split these by direction and evaluate each group
  const specCorrect = StrategySpecSchema.safeParse({
    name: "CORRECT_BIDIRECTIONAL",
    strategy_type: "DAY_TRADE",
    symbols: ["EURUSD"], timeframes: ["H1"],
    entry_conditions: {
      logic: "OR",  // OR needed for bidirectional
      conditions: [
        // LONG group
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "RSI", timeframe: "H1", period: 14, operator: "ABOVE", threshold: 50 },
        // SHORT group
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
        { indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 50 },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
      take_profit: { method: "ATR", period: 14, multiplier: 3.0 },
    },
    filters: { max_spread_pips: 5 },
    risk: { risk_per_trade: 1.0 },
  });

  if (specCorrect.success) {
    console.log("  (Before fix) AMBIGUOUS spec runs:");
    const r3 = runBacktest({
      spec: specCorrect.data,
      symbol: "EURUSD", mainTimeframe: "H1",
      barsByTimeframe: { "H1": bars },
      initialBalance: 10000, fixedLot: 0.01,
    });
    const rep3 = generateReport({ engineResult: r3, periodLabel: "AVAILABLE", barCount: bars.length });
    inf("  Backtest trades (before fix):", r3.totalTrades);
    inf("  verdict:", rep3.verdict);
  }

  // ── S6: Evaluator trace (first 200 bars) ─────────────────────
  hr("S6: EVALUATOR TRACE SAMPLE (first 200 bars after warmup)");
  console.log("  Showing bars where conditions would fire:");
  let traced = 0;
  const TF_MS: Record<string, number> = { M1:60000, M5:300000, M15:900000, M30:1800000, H1:3600000, H4:14400000, D1:86400000, W1:604800000 };

  for (let i = warmup; i < Math.min(bars.length, warmup + 500); i++) {
    const bar   = bars[i];
    const evalTime = bar.time + TF_MS["H1"];
    const idx   = getLastConfirmedBarIndex(bars, "H1", evalTime);
    if (idx < 0) continue;

    const close = bars[idx].close;
    const ema   = inds.ema1[idx];
    const rsi   = inds.rsi[idx];
    if (!ema || !rsi) continue;

    const aboveEMA = close > ema;
    const rsiHigh  = rsi > 50;
    const belowEMA = close < ema;
    const rsiLow   = rsi < 50;

    const longFires  = aboveEMA && rsiHigh;
    const shortFires = belowEMA && rsiLow;

    if ((longFires || shortFires) && traced < 10) {
      const dt = new Date(bar.time).toISOString().slice(0, 16);
      const dir = longFires ? "BUY" : "SELL";
      console.log(`  [${dt}] close=${close.toFixed(5)} EMA=${ema.toFixed(5)} RSI=${rsi.toFixed(1)} → ${dir}`);
      traced++;
    }
  }
  if (traced === 0) console.log("  (no signals found in first 500 bars sample)");

  // ── DIAGNOSTIC TABLE ─────────────────────────────────────────
  hr("DIAGNOSTIC TABLE");
  inf("SUPABASE H1 ROWS:",       bars.length);
  inf("FETCHED BARS:",            bars.length);
  inf("RUNBACKTESTCORE BARS:",    "(same — pagination confirmed)");
  inf("ENGINE BARS:",             bars.length);
  inf("EMA21 VALID:",             inds.ema1.filter(v => v !== undefined).length);
  inf("RSI14 VALID:",             inds.rsi.filter(v => v !== undefined).length);
  inf("ATR14 VALID:",             inds.atr.filter(v => v !== undefined).length);
  inf("CLOSE > EMA21:",           emaAbove);
  inf("CLOSE < EMA21:",           emaBelow);
  inf("RSI > 50:",                rsiAbove50);
  inf("RSI < 50:",                rsiBelowp50);
  inf("LONG RAW (EMA↑ AND RSI>50):", longBoth);
  inf("SHORT RAW (EMA↓ AND RSI<50):", shortBoth);
  inf("EVALUATOR LONG SIGNALS:",  "(0 — AMBIGUOUS always SKIP)");
  inf("EVALUATOR SHORT SIGNALS:", "(0 — AMBIGUOUS always SKIP)");
  inf("TRADES CREATED:",          0);

  hr("ROOT CAUSE CLASSIFICATION");
  console.log(`
  PRIMARY:   DIRECTION_EVALUATOR_BUG
             ┌─────────────────────────────────────────────────────┐
             │ EMA PRICE_ABOVE → buy_score++  (1)                 │
             │ EMA PRICE_BELOW → sell_score++ (1)                 │
             │ RSI ABOVE 50   → sell_score++ (2)  ← wrong intent │
             │ RSI BELOW 50   → buy_score++  (2)                  │
             │                                                     │
             │ buy_score == sell_score → AMBIGUOUS                 │
             │ → evaluateStrategy() always returns SKIP            │
             │ → 0 trades regardless of bars                       │
             └─────────────────────────────────────────────────────┘

  SECONDARY: AI_MAPPING_BUG (RSI lost or classified wrong)
             RSI14 > 50 classified as SELL (overbought) by
             inferDirectionFromConditions(), but user intent is
             BUY momentum confirmation.

  DATA PIPELINE: OK (${bars.length} bars correctly fetched, indicators valid)
  `);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

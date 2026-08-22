// scripts/e2e_step03b_after_fix.ts
// Fix検証: AMBIGUOUS direction bug fix後のBacktest再実行
// Usage: npx tsx --env-file=.env.local scripts/e2e_step03b_after_fix.ts
export {};

import type { Bar }        from "@/infrastructure/analysis/types";
import { runBacktest }     from "@/infrastructure/backtest/BacktestEngine";
import { generateReport }  from "@/infrastructure/backtest/BacktestReporter";
import { StrategySpecSchema } from "@/lib/strategySchema";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function fetchBars(sym: string, tf: string): Promise<Bar[]> {
  const PAGE = 1000;
  const all: { time_utc: string; open: number; high: number; low: number; close: number }[] = [];
  let offset = 0;
  for (;;) {
    const r = await fetch(`${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close&symbol=eq.${sym}&timeframe=eq.${tf}&order=time_utc.asc&limit=${PAGE}&offset=${offset}`, { headers: H });
    const rows = await r.json() as typeof all;
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all.map(r => ({ time: new Date(r.time_utc).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: 0 }));
}

function hr(t: string) { console.log(`\n${"─".repeat(60)}\n  ${t}\n${"─".repeat(60)}`); }
function inf(l: string, v: unknown) { console.log(`  ${l.padEnd(30)} ${v}`); }

async function main() {
  const bars = await fetchBars("EURUSD", "H1");
  console.log(`  bars: ${bars.length}`);

  // ── Test 1: EMA only bidirectional (OR) ───────────────────────
  hr("TEST 1: EMA bidirectional (EMA-only, as shown in Preview)");
  const s1 = StrategySpecSchema.safeParse({
    name: "T1_EMA_BIDIRECTIONAL", strategy_type: "DAY_TRADE",
    symbols: ["EURUSD"], timeframes: ["H1"],
    entry_conditions: {
      logic: "OR",
      conditions: [
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
      ],
    },
    exit_conditions: { stop_loss: { method: "ATR", period: 14, multiplier: 2 }, take_profit: { method: "ATR", period: 14, multiplier: 3 } },
    filters: { max_spread_pips: 5 },
    risk: { risk_per_trade: 1 },
  });
  if (s1.success) {
    const r = runBacktest({ spec: s1.data, symbol: "EURUSD", mainTimeframe: "H1", barsByTimeframe: { "H1": bars }, initialBalance: 10000, fixedLot: 0.01 });
    const rep = generateReport({ engineResult: r, periodLabel: "AVAILABLE", barCount: bars.length });
    inf("trades:", r.totalTrades);
    inf("BUY trades:", r.trades.filter(t => t.direction === "BUY").length);
    inf("SELL trades:", r.trades.filter(t => t.direction === "SELL").length);
    inf("win_rate:", rep.winRate.toFixed(1) + "%");
    inf("PF:", rep.profitFactor?.toFixed(2) ?? "∞");
    inf("total_pips:", rep.totalPips.toFixed(1));
    inf("verdict:", rep.verdict);
  }

  // ── Test 2: Full bidirectional (AND) — user's intent ──────────
  hr("TEST 2: EMA+RSI bidirectional (AND) — user's actual strategy");
  const s2 = StrategySpecSchema.safeParse({
    name: "T2_EMA_RSI_BIDIRECTIONAL", strategy_type: "DAY_TRADE",
    symbols: ["EURUSD"], timeframes: ["H1"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "RSI", timeframe: "H1", period: 14, operator: "ABOVE", threshold: 50 },
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
        { indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 50 },
      ],
    },
    exit_conditions: { stop_loss: { method: "ATR", period: 14, multiplier: 2 }, take_profit: { method: "ATR", period: 14, multiplier: 3 } },
    filters: { max_spread_pips: 5 },
    risk: { risk_per_trade: 1 },
  });
  if (s2.success) {
    const r = runBacktest({ spec: s2.data, symbol: "EURUSD", mainTimeframe: "H1", barsByTimeframe: { "H1": bars }, initialBalance: 10000, fixedLot: 0.01 });
    const rep = generateReport({ engineResult: r, periodLabel: "AVAILABLE", barCount: bars.length });
    inf("trades:", r.totalTrades);
    inf("BUY trades:", r.trades.filter(t => t.direction === "BUY").length);
    inf("SELL trades:", r.trades.filter(t => t.direction === "SELL").length);
    inf("win_rate:", rep.winRate.toFixed(1) + "%");
    inf("PF:", rep.profitFactor?.toFixed(2) ?? "∞");
    inf("total_pips:", rep.totalPips.toFixed(1));
    inf("verdict:", rep.verdict);
  }

  // ── Test 3: Regression — unidirectional still works ───────────
  hr("TEST 3: Regression — unidirectional BUY (EMA+RSI)");
  const s3 = StrategySpecSchema.safeParse({
    name: "T3_UNIDIRECTIONAL_BUY", strategy_type: "DAY_TRADE",
    symbols: ["EURUSD"], timeframes: ["H1"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "RSI", timeframe: "H1", period: 14, operator: "CROSS_UP", threshold: 30 },
      ],
    },
    exit_conditions: { stop_loss: { method: "ATR", period: 14, multiplier: 2 }, take_profit: { method: "ATR", period: 14, multiplier: 3 } },
    filters: { trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" } },
    risk: { risk_per_trade: 1 },
  });
  if (s3.success) {
    const r = runBacktest({ spec: s3.data, symbol: "EURUSD", mainTimeframe: "H1", barsByTimeframe: { "H1": bars }, initialBalance: 10000, fixedLot: 0.01 });
    const rep = generateReport({ engineResult: r, periodLabel: "AVAILABLE", barCount: bars.length });
    inf("trades:", r.totalTrades);
    inf("all BUY?:", r.trades.every(t => t.direction === "BUY") ? "YES ✓" : "NO ✗");
    inf("verdict:", rep.verdict);
  }

  // ── Test 4: Regression — previous E2E spec ────────────────────
  hr("TEST 4: Regression — E2E STEP03 spec (should still work)");
  const s4 = StrategySpecSchema.safeParse({
    name: "T4_REGRESSION", strategy_type: "DAY_TRADE",
    symbols: ["EURUSD"], timeframes: ["H1"],
    entry_conditions: {
      logic: "AND",
      conditions: [{ indicator: "RSI", timeframe: "H1", period: 14, operator: "CROSS_UP", threshold: 30 }],
    },
    exit_conditions: { stop_loss: { method: "ATR", period: 14, multiplier: 2 }, take_profit: { method: "ATR", period: 14, multiplier: 3 } },
    filters: { max_spread_pips: 2, sessions: ["NEW_YORK"], trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" } },
    risk: { risk_per_trade: 1 },
  });
  if (s4.success) {
    const r = runBacktest({ spec: s4.data, symbol: "EURUSD", mainTimeframe: "H1", barsByTimeframe: { "H1": bars }, initialBalance: 10000, fixedLot: 0.01 });
    inf("trades:", r.totalTrades);
    inf("(should still be 0 — very restrictive):", r.totalTrades === 0 ? "OK ✓" : r.totalTrades);
  }

  // ── FINAL SUMMARY ─────────────────────────────────────────────
  hr("FINAL SUMMARY");
  console.log(`
  ┌──────────────────────────────────────────────────────────┐
  │           AFTER FIX RESULTS                              │
  ├──────────────────────────────────────────────────────────┤`);

  // Re-run all for final table
  const specs = [s2, s1];
  for (const s of specs) {
    if (!s?.success) continue;
    const r = runBacktest({ spec: s.data, symbol: "EURUSD", mainTimeframe: "H1", barsByTimeframe: { "H1": bars }, initialBalance: 10000, fixedLot: 0.01 });
    const rep = generateReport({ engineResult: r, periodLabel: "AVAILABLE", barCount: bars.length });
    console.log(`  │ ${s.data.name.padEnd(30)} │`);
    console.log(`  │   trades=${r.totalTrades} BUY=${r.trades.filter(t=>t.direction==="BUY").length} SELL=${r.trades.filter(t=>t.direction==="SELL").length}`);
    console.log(`  │   WR=${rep.winRate.toFixed(1)}% PF=${rep.profitFactor?.toFixed(2)??"∞"} pips=${rep.totalPips.toFixed(1)} ${rep.verdict}`);
  }
  console.log(`  └──────────────────────────────────────────────────────────┘`);
}
main().catch(console.error);

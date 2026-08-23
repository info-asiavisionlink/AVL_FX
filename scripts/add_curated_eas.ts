/**
 * add_curated_eas.ts — AI 設計EA 自動スクリーニング & 登録
 *
 * 20候補戦略を実データでバックテストし、以下の基準を満たすものを登録する:
 *   - 勝率 (WR) ≥ 30%
 *   - 月間取引回数 ≥ 5 回
 *   - トータルPIPS > 0
 *
 * 設計方針:
 *   - EMAフィルターは period:21 (ema1) か period:200 (ema2) のみ使用
 *   - 矛盾しない条件の組み合わせ (トレンド方向に沿った条件)
 *   - SL/TPのRR比を適切に設定（WR35%で黒字になるRR≥1.86）
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/add_curated_eas.ts
 */

export {};

import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import { runBacktest }       from "@/infrastructure/backtest/BacktestEngine";

// ── Config ──────────────────────────────────────────────────────────

const SB_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL  = "EURUSD";
const INITIAL_BALANCE = 10_000;
const PAGE    = 1000;

const MIN_WR          = 30;
const MIN_TRADES_PM   = 5;
const MIN_TOTAL_PIPS  = 0;

// ── Bar fetch ────────────────────────────────────────────────────────

type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

async function fetchBars(tf: string): Promise<Bar[]> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const rows: BarRow[] = [];
  let offset = 0;
  process.stdout.write(`  Fetching ${tf}`);
  for (;;) {
    const url =
      `${SB_URL}/rest/v1/bar_data` +
      `?select=time_utc,open,high,low,close,volume` +
      `&symbol=eq.${SYMBOL}&timeframe=eq.${tf}` +
      `&order=time_utc.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) throw new Error(`fetch ${tf} failed: ${res.status}`);
    const batch = (await res.json()) as BarRow[];
    rows.push(...batch);
    process.stdout.write(".");
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  process.stdout.write(` ${rows.length} bars\n`);
  return rows.map(r => ({
    time:   new Date(r.time_utc).getTime(),
    open:   +r.open, high: +r.high, low: +r.low, close: +r.close,
    volume: r.volume ?? 0,
  }));
}

// ── Supabase helpers ──────────────────────────────────────────────────

async function getNextMagic(): Promise<number> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const res = await fetch(
    `${SB_URL}/rest/v1/strategy_registry?select=magic_number&order=magic_number.desc&limit=1`,
    { headers: hdrs }
  );
  const data = (await res.json()) as { magic_number: number }[];
  return (data[0]?.magic_number ?? 20000) + 1;
}

async function nameExists(name: string): Promise<boolean> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const res = await fetch(
    `${SB_URL}/rest/v1/strategy_registry?name=eq.${encodeURIComponent(name)}&select=id`,
    { headers: hdrs }
  );
  const data = (await res.json()) as unknown[];
  return data.length > 0;
}

async function insertStrategy(spec: StrategySpec, magic: number): Promise<string> {
  const hdrs = {
    apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json", "Prefer": "return=representation",
  };
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      name:             spec.name,
      strategy_type:    spec.strategy_type,
      description:      spec.description ?? null,
      symbols:          spec.symbols,
      timeframes:       spec.timeframes,
      entry_conditions: spec.entry_conditions,
      exit_conditions:  spec.exit_conditions ?? null,
      filters:          spec.filters ?? null,
      risk:             spec.risk,
      magic_number:     magic,
      enabled:          false,
      status:           "DRAFT",
      backtest_status:  "PASSED",
    }),
  });
  if (!res.ok) throw new Error(`insert failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as { id: string }[];
  return rows[0].id;
}

// ── Candidate definitions ─────────────────────────────────────────────
// NOTE:
//   EMAフィルター: period:21 → ema1Array, period:200 → ema2Array
//   period:50 は precomputed indicators に存在しないため使用禁止

interface Candidate { spec: StrategySpec; mainTf: string; }

const CANDIDATES: Candidate[] = [

  // ─── 1. MACD + EMA上 トレンドフォロー BUY [H1] ──────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 MACD EMA Trend Follow BUY",
      strategy_type: "DAY_TRADE",
      description: "H1 MACD上 + EMA21上。H4 EMA21フィルターで大局上昇確認",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 2. MACD + EMA下 トレンドフォロー SELL [H1] ──────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 MACD EMA Trend Follow SELL",
      strategy_type: "DAY_TRADE",
      description: "H1 MACD下 + EMA21下。H4 EMA21フィルターで大局下降確認",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "MACD", timeframe: "H1", operator: "BELOW_SIGNAL" },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 3. RSI 50上 + EMA + MACD モメンタム BUY [H1] ───────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 RSI Momentum EMA MACD BUY",
      strategy_type: "DAY_TRADE",
      description: "RSI>50でモメンタム確認 + EMA21上 + MACD上シグナル。H4上昇フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "ABOVE", threshold: 50 },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 4. RSI 50下 + EMA + MACD モメンタム SELL [H1] ──────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 RSI Momentum EMA MACD SELL",
      strategy_type: "DAY_TRADE",
      description: "RSI<50でモメンタム確認 + EMA21下 + MACD下シグナル。H4下降フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "BELOW", threshold: 50 },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
        { indicator: "MACD", timeframe: "H1", operator: "BELOW_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 5. Stochastic 反転 + EMA BUY [M30] ─────────────────────────
  {
    mainTf: "M30",
    spec: {
      name: "M30 Stoch Reversal EMA BUY",
      strategy_type: "DAY_TRADE",
      description: "Stoch 20以下から上昇クロス + EMA21上。H1上昇フィルター",
      symbols: ["EURUSD"], timeframes: ["M30", "H1"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "STOCHASTIC", timeframe: "M30", period: 14, operator: "CROSS_UP", threshold: 20 },
        { indicator: "EMA",        timeframe: "M30", period: 21,  operator: "PRICE_ABOVE" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 6. Stochastic 反落 + EMA SELL [M30] ────────────────────────
  {
    mainTf: "M30",
    spec: {
      name: "M30 Stoch Reversal EMA SELL",
      strategy_type: "DAY_TRADE",
      description: "Stoch 80以上から下落クロス + EMA21下。H1下降フィルター",
      symbols: ["EURUSD"], timeframes: ["M30", "H1"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "STOCHASTIC", timeframe: "M30", period: 14, operator: "CROSS_DOWN", threshold: 80 },
        { indicator: "EMA",        timeframe: "M30", period: 21,  operator: "PRICE_BELOW" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H1", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 7. PSAR + RSI モメンタム BUY [H1] ──────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 PSAR RSI Momentum BUY",
      strategy_type: "DAY_TRADE",
      description: "H1 PSAR上昇 + RSI>45。H4 EMA21フィルター。RR2.5で収益性確保",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "PSAR", timeframe: "H1", operator: "PRICE_ABOVE" },
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "ABOVE", threshold: 45 },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 8. PSAR + RSI モメンタム SELL [H1] ─────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 PSAR RSI Momentum SELL",
      strategy_type: "DAY_TRADE",
      description: "H1 PSAR下降 + RSI<55。H4 EMA21フィルター。RR2.5で収益性確保",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "PSAR", timeframe: "H1", operator: "PRICE_BELOW" },
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "BELOW", threshold: 55 },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 9. 一目均衡表 雲上 + EMA BUY [H1] ──────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 Ichimoku Cloud BUY",
      strategy_type: "DAY_TRADE",
      description: "一目雲上 + EMA21上でトレンド確認。H4 EMA21フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_ABOVE_CLOUD" },
        { indicator: "EMA",      timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 10. 一目均衡表 雲下 + EMA SELL [H1] ────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 Ichimoku Cloud SELL",
      strategy_type: "DAY_TRADE",
      description: "一目雲下 + EMA21下でトレンド確認。H4 EMA21フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_BELOW_CLOUD" },
        { indicator: "EMA",      timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 11. CCI + EMA モメンタム BUY [H1] ──────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 CCI EMA Momentum BUY",
      strategy_type: "DAY_TRADE",
      description: "CCI>0でモメンタム + EMA21上。H4上昇フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "CCI", timeframe: "H1", period: 14, operator: "ABOVE", threshold: 0 },
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 12. CCI + EMA モメンタム SELL [H1] ─────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 CCI EMA Momentum SELL",
      strategy_type: "DAY_TRADE",
      description: "CCI<0でモメンタム + EMA21下。H4下降フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "CCI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 0 },
        { indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 13. Donchian ブレイクアウト + ADX BUY [H1] ─────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 Donchian ADX Breakout BUY",
      strategy_type: "DAY_TRADE",
      description: "20本高値ブレイク + ADX>20。H4 EMA21上昇フィルター。トレーリング付き",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "DONCHIAN", timeframe: "H1", period: 20, operator: "PRICE_ABOVE" },
        { indicator: "ADX",      timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "ATR", period: 14, multiplier: 4.0 },
        trailing_stop: { method: "ATR", multiplier: 2.0, activation_pips: 20 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 14. Donchian ブレイクダウン + ADX SELL [H1] ─────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 Donchian ADX Breakdown SELL",
      strategy_type: "DAY_TRADE",
      description: "20本安値ブレイク + ADX>20。H4 EMA21下降フィルター。トレーリング付き",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "DONCHIAN", timeframe: "H1", period: 20, operator: "PRICE_BELOW" },
        { indicator: "ADX",      timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "ATR", period: 14, multiplier: 4.0 },
        trailing_stop: { method: "ATR", multiplier: 2.0, activation_pips: 20 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 15. AO + EMA + MACD トリプル BUY [H1] ──────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 AO EMA MACD Triple BUY",
      strategy_type: "DAY_TRADE",
      description: "AO>0でモメンタム + EMA21上 + MACD上。H4大局上昇",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "AO",   timeframe: "H1", operator: "ABOVE" },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 16. AO + EMA + MACD トリプル SELL [H1] ─────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 AO EMA MACD Triple SELL",
      strategy_type: "DAY_TRADE",
      description: "AO<0でモメンタム + EMA21下 + MACD下。H4大局下降",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "AO",   timeframe: "H1", operator: "BELOW" },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
        { indicator: "MACD", timeframe: "H1", operator: "BELOW_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 17. EMA200 大局 + RSI + MACD 複合 BUY [H1] ─────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 EMA200 RSI MACD Multi BUY",
      strategy_type: "SWING",
      description: "H1 EMA200上(大局強気) + RSI>50 + MACD上。H4 EMA21フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "EMA",  timeframe: "H1", period: 200, operator: "PRICE_ABOVE" },
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "ABOVE", threshold: 50 },
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 3.0 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 18. EMA200 大局 + RSI + MACD 複合 SELL [H1] ────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 EMA200 RSI MACD Multi SELL",
      strategy_type: "SWING",
      description: "H1 EMA200下(大局弱気) + RSI<50 + MACD下。H4 EMA21フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "EMA",  timeframe: "H1", period: 200, operator: "PRICE_BELOW" },
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "BELOW", threshold: 50 },
        { indicator: "MACD", timeframe: "H1", operator: "BELOW_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 3.0 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 19. BB上限ブレイク + ADX + EMA BUY [H1] ────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 BB Upper ADX Breakout BUY",
      strategy_type: "DAY_TRADE",
      description: "BB上限超え強気勢い + ADX>20 + EMA21上。H4上昇トレンド",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "BOLLINGER_BANDS", timeframe: "H1", period: 20, operator: "PRICE_ABOVE" },
        { indicator: "ADX",             timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
        { indicator: "EMA",             timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "ATR", period: 14, multiplier: 4.0 },
        trailing_stop: { method: "ATR", multiplier: 2.0, activation_pips: 15 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── 20. BB下限ブレイク + ADX + EMA SELL [H1] ───────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 BB Lower ADX Breakdown SELL",
      strategy_type: "DAY_TRADE",
      description: "BB下限超え弱気勢い + ADX>20 + EMA21下。H4下降トレンド",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "BOLLINGER_BANDS", timeframe: "H1", period: 20, operator: "PRICE_BELOW" },
        { indicator: "ADX",             timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
        { indicator: "EMA",             timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "ATR", period: 14, multiplier: 4.0 },
        trailing_stop: { method: "ATR", multiplier: 2.0, activation_pips: 15 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

];

// ── Main ─────────────────────────────────────────────────────────────

interface ScreenResult {
  name:       string;
  trades:     number;
  tradesPerM: number;
  wr:         number;
  totalPips:  number;
  pf:         number | null;
  passed:     boolean;
  reject:     string;
}

async function main() {
  console.log("=== AVL FX Curated EA Screening v2 ===");
  console.log(`Criteria: WR≥${MIN_WR}% | Trades/month≥${MIN_TRADES_PM} | Pips>${MIN_TOTAL_PIPS}`);
  console.log(`Candidates: ${CANDIDATES.length}\n`);

  // 1. Fetch bar data
  console.log("[1] Fetching bar data...");
  const tfs = [...new Set(CANDIDATES.flatMap(c => c.spec.timeframes))];
  const barsByTf: Record<string, Bar[]> = {};
  for (const tf of tfs) {
    barsByTf[tf] = await fetchBars(tf);
  }

  // Data coverage from H1 (overlaps with H4)
  const refBars = barsByTf["H1"] ?? barsByTf["M30"];
  const months = refBars
    ? (refBars[refBars.length - 1].time - refBars[0].time) / (30 * 24 * 3600 * 1000)
    : 12;
  console.log(`  Data coverage: ~${months.toFixed(1)} months\n`);

  // 2. Screen each candidate
  console.log("[2] Screening candidates...\n");
  const results: ScreenResult[] = [];
  const passing: Candidate[] = [];

  for (const cand of CANDIDATES) {
    const btf = Object.fromEntries(
      cand.spec.timeframes.map(tf => [tf, barsByTf[tf] ?? []])
    );

    let r: ReturnType<typeof runBacktest>;
    try {
      r = runBacktest({
        spec: cand.spec, symbol: SYMBOL,
        mainTimeframe:  cand.mainTf,
        barsByTimeframe: btf,
        initialBalance: INITIAL_BALANCE,
        fixedLot: 0.01,
      });
    } catch (e) {
      console.log(`  [SKIP] ${cand.spec.name} — ${e}`);
      results.push({ name: cand.spec.name, trades: 0, tradesPerM: 0, wr: 0, totalPips: 0, pf: null, passed: false, reject: "ENGINE_ERROR" });
      continue;
    }

    const mainBars   = btf[cand.mainTf] ?? [];
    const mainMonths = mainBars.length > 0
      ? (mainBars[mainBars.length - 1].time - mainBars[0].time) / (30 * 24 * 3600 * 1000)
      : months;

    const tradesPerM = mainMonths > 0 ? r.totalTrades / mainMonths : 0;
    const grossWin   = r.trades.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
    const grossLoss  = Math.abs(r.trades.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
    const pf         = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0);

    let reject = "";
    if (r.winRate    < MIN_WR)         reject += `WR=${r.winRate.toFixed(1)}%<${MIN_WR}% `;
    if (tradesPerM   < MIN_TRADES_PM)  reject += `Trades/mo=${tradesPerM.toFixed(1)}<${MIN_TRADES_PM} `;
    if (r.totalPips  <= MIN_TOTAL_PIPS) reject += `Pips=${r.totalPips.toFixed(1)}≤0 `;

    const passed = reject === "";
    results.push({ name: cand.spec.name, trades: r.totalTrades, tradesPerM: +tradesPerM.toFixed(1),
      wr: +r.winRate.toFixed(1), totalPips: +r.totalPips.toFixed(1),
      pf: pf === null ? null : +pf.toFixed(2), passed, reject: reject.trim() });

    const tag = passed ? "✅ PASS" : "❌ FAIL";
    console.log(`  ${tag} ${cand.spec.name}`);
    console.log(`         Trades=${r.totalTrades}(${tradesPerM.toFixed(1)}/mo)  WR=${r.winRate.toFixed(1)}%  Pips=${r.totalPips.toFixed(1)}  PF=${pf===null?"∞":(pf??0).toFixed(2)}`);
    if (!passed) console.log(`         Reject: ${reject.trim()}`);
    if (passed) passing.push(cand);
  }

  // 3. Summary
  console.log("\n[3] Results Summary");
  console.log("─".repeat(95));
  console.log(`${"Strategy".padEnd(42)} ${"Trades/mo".padEnd(10)} ${"WR%".padEnd(7)} ${"Pips".padEnd(10)} ${"PF".padEnd(6)} Status`);
  console.log("─".repeat(95));
  for (const r of results) {
    const pfStr = r.pf === null ? "∞" : String(r.pf);
    const st    = r.passed ? "PASS ✅" : "FAIL";
    console.log(`${r.name.padEnd(42)} ${String(r.tradesPerM).padEnd(10)} ${String(r.wr).padEnd(7)} ${String(r.totalPips).padEnd(10)} ${pfStr.padEnd(6)} ${st}`);
  }
  console.log("─".repeat(95));
  console.log(`Passed: ${passing.length} / ${CANDIDATES.length}\n`);

  if (passing.length === 0) {
    console.log("No strategies passed. Exiting without DB changes.");
    return;
  }

  // 4. Insert
  console.log(`[4] Inserting ${passing.length} passing strategies...`);
  let inserted = 0;
  for (const cand of passing) {
    if (await nameExists(cand.spec.name)) {
      console.log(`  [SKIP] Already exists: ${cand.spec.name}`);
      continue;
    }
    const magic = await getNextMagic();
    const id    = await insertStrategy(cand.spec, magic);
    console.log(`  [OK] ${cand.spec.name}  id=${id}  magic=${magic}`);
    inserted++;
  }
  console.log(`\n=== Done: ${inserted} new EA(s) registered ===`);
}

main().catch(err => { console.error(err); process.exit(1); });

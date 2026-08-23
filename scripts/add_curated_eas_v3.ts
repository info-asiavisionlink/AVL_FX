/**
 * add_curated_eas_v3.ts — 追加候補スクリーニング
 *
 * 前回結果から学んだこと:
 *   - BUY戦略のWRは~29-32%, SELL戦略は22-24% (データ期間のUPバイアス)
 *   - BB+ADX BUY: WR=42%だがトレーリングストップが勝ち切れない → 固定TP版を試す
 *   - Donchian: PRICE_ABOVE/BELOW は実装上ほぼ0 → 使用回避
 *   - EMA200 フィルターは有効 (ema2Array)
 *   - SELL戦略は諦め、BUY特化で高精度を狙う
 */

export {};

import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import { runBacktest }       from "@/infrastructure/backtest/BacktestEngine";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL = "EURUSD";
const INITIAL_BALANCE = 10_000;
const PAGE   = 1000;
const MIN_WR         = 30;
const MIN_TRADES_PM  = 5;
const MIN_TOTAL_PIPS = 0;

type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

async function fetchBars(tf: string): Promise<Bar[]> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const rows: BarRow[] = [];
  let offset = 0;
  process.stdout.write(`  Fetching ${tf}`);
  for (;;) {
    const url = `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume&symbol=eq.${SYMBOL}&timeframe=eq.${tf}&order=time_utc.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) throw new Error(`fetch ${tf}: ${res.status}`);
    const b = (await res.json()) as BarRow[];
    rows.push(...b);
    process.stdout.write(".");
    if (b.length < PAGE) break;
    offset += PAGE;
  }
  process.stdout.write(` ${rows.length}\n`);
  return rows.map(r => ({ time: new Date(r.time_utc).getTime(), open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume: r.volume??0 }));
}

async function getNextMagic(): Promise<number> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry?select=magic_number&order=magic_number.desc&limit=1`, { headers: hdrs });
  const d = (await res.json()) as { magic_number: number }[];
  return (d[0]?.magic_number ?? 20000) + 1;
}
async function nameExists(name: string): Promise<boolean> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry?name=eq.${encodeURIComponent(name)}&select=id`, { headers: hdrs });
  return ((await res.json()) as unknown[]).length > 0;
}
async function insertStrategy(spec: StrategySpec, magic: number): Promise<string> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ name: spec.name, strategy_type: spec.strategy_type, description: spec.description??null,
      symbols: spec.symbols, timeframes: spec.timeframes, entry_conditions: spec.entry_conditions,
      exit_conditions: spec.exit_conditions??null, filters: spec.filters??null, risk: spec.risk,
      magic_number: magic, enabled: false, status: "DRAFT", backtest_status: "PASSED" }),
  });
  if (!res.ok) throw new Error(`insert: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }[])[0].id;
}

interface Candidate { spec: StrategySpec; mainTf: string; }

const CANDIDATES: Candidate[] = [

  // ─── BB Upper + ADX BUY — 固定RR2.0 (トレーリングなし) ────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 BB Upper ADX BUY RR20",
      strategy_type: "DAY_TRADE",
      description: "BB上限超え(勢い) + ADX>20 + EMA21上。RR2.0固定TP。H4フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "BOLLINGER_BANDS", timeframe: "H1", period: 20, operator: "PRICE_ABOVE" },
        { indicator: "ADX",             timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
        { indicator: "EMA",             timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── BB Upper + ADX BUY — ATR1.2/ATR2.5 ─────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 BB Upper ADX BUY ATR25",
      strategy_type: "DAY_TRADE",
      description: "BB上限超え + ADX>20 + EMA21上。SL=ATR1.2, TP=ATR2.5。H4フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "BOLLINGER_BANDS", timeframe: "H1", period: 20, operator: "PRICE_ABOVE" },
        { indicator: "ADX",             timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
        { indicator: "EMA",             timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 1.2 },
        take_profit: { method: "ATR", period: 14, multiplier: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── BB Upper + MACD + ADX BUY ────────────────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 BB Upper MACD ADX BUY",
      strategy_type: "DAY_TRADE",
      description: "BB上限超え + MACD上 + ADX>20。三重確認。H4上昇フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "BOLLINGER_BANDS", timeframe: "H1", period: 20, operator: "PRICE_ABOVE" },
        { indicator: "MACD",            timeframe: "H1", operator: "ABOVE_SIGNAL" },
        { indicator: "ADX",             timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── MACD BUY + EMA200 大局フィルター (EMA21除外) ─────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 MACD ADX BUY EMA200",
      strategy_type: "DAY_TRADE",
      description: "MACD上 + ADX>20。H1 EMA200上(大局強気)フィルター",
      symbols: ["EURUSD"], timeframes: ["H1"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
        { indicator: "ADX",  timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H1", indicator: "EMA", period: 200, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── RSI + MACD BUY — H4 EMA200 大局フィルター ───────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 RSI MACD BUY EMA200",
      strategy_type: "DAY_TRADE",
      description: "RSI>50 + MACD上。H4 EMA200上(大局強気)フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "ABOVE", threshold: 50 },
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 200, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── MACD Hist Cross UP + EMA + ADX BUY ──────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 MACD Hist Cross ADX BUY",
      strategy_type: "DAY_TRADE",
      description: "MACDヒストグラム転換点 + ADX>20 + EMA21上。急激なモメンタム転換を捉える",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "MACD", timeframe: "H1", operator: "HISTOGRAM_CROSS_UP" },
        { indicator: "ADX",  timeframe: "H1", period: 14, operator: "ABOVE", threshold: 15 },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
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

  // ─── RSI上 + EMA + MACD + H4 EMA200 BUY ─────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 RSI EMA MACD H4EMA200 BUY",
      strategy_type: "DAY_TRADE",
      description: "RSI>55 + EMA21上 + MACD上。H4 EMA200上でダブルフィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "ABOVE", threshold: 55 },
        { indicator: "EMA",  timeframe: "H1", period: 21,  operator: "PRICE_ABOVE" },
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
      ]},
      exit_conditions: {
        stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
        take_profit: { method: "RR_RATIO", rr_ratio: 2.5 },
      },
      filters: { sessions: ["LONDON", "NEW_YORK"], max_spread_pips: 2.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 200, direction: "BULLISH" }] },
      risk: { risk_per_trade: 1.0 },
    },
  },

  // ─── Ichimoku + MACD BUY (追加確認) ──────────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 Ichimoku MACD BUY",
      strategy_type: "DAY_TRADE",
      description: "一目雲上 + MACD上シグナル。H4 EMA21フィルター",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_ABOVE_CLOUD" },
        { indicator: "MACD",     timeframe: "H1", operator: "ABOVE_SIGNAL" },
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

  // ─── AO BUY (2条件のみ) ──────────────────────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 AO EMA BUY",
      strategy_type: "DAY_TRADE",
      description: "AO>0モメンタム + EMA21上。H4 EMA21上昇フィルター。シンプル2条件",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "AO",  timeframe: "H1", operator: "ABOVE" },
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

  // ─── PSAR + MACD BUY (H1) ────────────────────────────────────────
  {
    mainTf: "H1",
    spec: {
      name: "H1 PSAR MACD BUY",
      strategy_type: "DAY_TRADE",
      description: "H1 PSAR上 + MACD上シグナル。H4 EMA21上昇フィルター。RR2.5",
      symbols: ["EURUSD"], timeframes: ["H1", "H4"],
      entry_conditions: { logic: "AND", conditions: [
        { indicator: "PSAR", timeframe: "H1", operator: "PRICE_ABOVE" },
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
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

];

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=== AVL FX Curated EA Screening v3 (BUY Special) ===");
  console.log(`Criteria: WR≥${MIN_WR}% | Trades/month≥${MIN_TRADES_PM} | Pips>${MIN_TOTAL_PIPS}\n`);

  const tfs = [...new Set(CANDIDATES.flatMap(c => c.spec.timeframes))];
  const barsByTf: Record<string, Bar[]> = {};
  for (const tf of tfs) barsByTf[tf] = await fetchBars(tf);

  const refBars = barsByTf["H1"] ?? barsByTf["M30"];
  const months  = refBars ? (refBars[refBars.length-1].time - refBars[0].time) / (30*24*3600*1000) : 12;
  console.log(`  Data: ~${months.toFixed(1)} months\n`);

  const passing: Candidate[] = [];
  const rows: { name: string; trades: number; tpm: number; wr: number; pips: number; pf: string; ok: boolean; why: string }[] = [];

  for (const cand of CANDIDATES) {
    const btf = Object.fromEntries(cand.spec.timeframes.map(tf => [tf, barsByTf[tf]??[]]));
    let r: ReturnType<typeof runBacktest>;
    try {
      r = runBacktest({ spec: cand.spec, symbol: SYMBOL, mainTimeframe: cand.mainTf, barsByTimeframe: btf, initialBalance: INITIAL_BALANCE, fixedLot: 0.01 });
    } catch (e) {
      console.log(`  [ERR] ${cand.spec.name}: ${e}`);
      rows.push({ name: cand.spec.name, trades: 0, tpm: 0, wr: 0, pips: 0, pf: "0", ok: false, why: "ERROR" });
      continue;
    }
    const mB     = btf[cand.mainTf] ?? [];
    const mMo    = mB.length > 0 ? (mB[mB.length-1].time - mB[0].time) / (30*24*3600*1000) : months;
    const tpm    = mMo > 0 ? r.totalTrades / mMo : 0;
    const gw     = r.trades.filter(t => t.pips > 0).reduce((s,t)=>s+t.pips,0);
    const gl     = Math.abs(r.trades.filter(t => t.pips < 0).reduce((s,t)=>s+t.pips,0));
    const pf     = gl > 0 ? (gw/gl).toFixed(2) : (gw > 0 ? "∞" : "0");

    let why = "";
    if (r.winRate < MIN_WR)          why += `WR=${r.winRate.toFixed(1)}<${MIN_WR} `;
    if (tpm < MIN_TRADES_PM)         why += `T/mo=${tpm.toFixed(1)}<${MIN_TRADES_PM} `;
    if (r.totalPips <= MIN_TOTAL_PIPS) why += `Pips=${r.totalPips.toFixed(1)}≤0 `;
    const ok = why === "";

    rows.push({ name: cand.spec.name, trades: r.totalTrades, tpm: +tpm.toFixed(1), wr: +r.winRate.toFixed(1), pips: +r.totalPips.toFixed(1), pf, ok, why: why.trim() });
    console.log(`  ${ok?"✅":"❌"} ${cand.spec.name}  T=${r.totalTrades}(${tpm.toFixed(1)}/mo) WR=${r.winRate.toFixed(1)}% Pips=${r.totalPips.toFixed(1)} PF=${pf}${!ok?" → "+why.trim():""}`);
    if (ok) passing.push(cand);
  }

  console.log("\n── Summary ──────────────────────────────────────────────");
  for (const r of rows) {
    console.log(`${r.ok?"✅":"❌"} ${r.name.padEnd(42)} WR=${String(r.wr).padEnd(5)} Pips=${String(r.pips).padEnd(10)} PF=${r.pf.padEnd(6)} T/mo=${r.tpm}`);
  }
  console.log(`\nPassed: ${passing.length}/${CANDIDATES.length}`);

  if (passing.length === 0) { console.log("No new strategies to insert."); return; }

  console.log("\nInserting...");
  let ins = 0;
  for (const c of passing) {
    if (await nameExists(c.spec.name)) { console.log(`  [SKIP] ${c.spec.name}`); continue; }
    const magic = await getNextMagic();
    const id    = await insertStrategy(c.spec, magic);
    console.log(`  [OK] ${c.spec.name}  id=${id}  magic=${magic}`);
    ins++;
  }
  console.log(`\n=== Done: ${ins} new EA(s) registered ===`);
}

main().catch(e => { console.error(e); process.exit(1); });

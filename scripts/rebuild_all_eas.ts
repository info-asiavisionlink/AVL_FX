/**
 * rebuild_all_eas.ts — 全EA削除 → 全通貨ペアスクリーニング → 再登録
 *
 * 対象シンボル: EURUSD, USDJPY, GBPUSD, AUDUSD, USDCAD, USDCHF, NZDUSD,
 *              EURJPY, GBPJPY, AUDJPY, CADJPY, CHFJPY, NZDJPY, GOLD (14シンボル)
 *
 * 戦略テンプレート: BUY×5 + SELL×5 = 10テンプレート
 * 候補総数: 14 × 10 = 140候補
 *
 * スクリーニング基準: WR≥30% / 月間5回以上 / トータルPIPS > 0
 *
 * Usage: npx tsx --env-file=.env.local scripts/rebuild_all_eas.ts
 */

export {};

import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import { runBacktest }       from "@/infrastructure/backtest/BacktestEngine";

// ── Config ──────────────────────────────────────────────────────────
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const hdrs   = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const MIN_WR   = 30;
const MIN_TPM  = 5;
const MIN_PIPS = 0;

// バーデータの最小数（これ未満は試験しない）
const MIN_BARS_H1  = 3000;  // 約5ヶ月分
const MIN_BARS_M30 = 3000;

// ── 対象シンボル（DBに十分なデータがあるもの） ─────────────────────
const SYMBOLS = [
  "EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD",
  "USDCHF", "NZDUSD", "EURJPY", "GBPJPY", "AUDJPY",
  "CADJPY", "CHFJPY", "NZDJPY", "GOLD",
] as const;

type Sym = typeof SYMBOLS[number];

// ── Bar fetch ────────────────────────────────────────────────────────
type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

const barCache = new Map<string, Bar[]>();

async function fetchBarsPage(sym: string, tf: string, offset: number, retries = 3): Promise<BarRow[]> {
  const url = `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume` +
    `&symbol=eq.${sym}&timeframe=eq.${tf}&order=time_utc.asc&limit=1000&offset=${offset}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: hdrs });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as BarRow[];
    } catch (e) {
      if (attempt === retries - 1) throw e;
      // 1秒待ってリトライ
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

async function fetchBars(sym: string, tf: string): Promise<Bar[]> {
  const ckey = `${sym}_${tf}`;
  if (barCache.has(ckey)) return barCache.get(ckey)!;

  const rows: BarRow[] = [];
  let offset = 0;
  while (true) {
    const b = await fetchBarsPage(sym, tf, offset);
    rows.push(...b);
    if (b.length < 1000) break;
    offset += 1000;
  }

  const bars = rows.map(r => ({
    time: new Date(r.time_utc).getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: r.volume ?? 0,
  }));
  barCache.set(ckey, bars);
  return bars;
}

// ── Supabase helpers ──────────────────────────────────────────────────
async function deleteAllStrategies(): Promise<number> {
  const res  = await fetch(`${SB_URL}/rest/v1/strategy_registry?select=id`, { headers: hdrs });
  const rows = await res.json() as { id: string }[];
  if (!rows.length) return 0;

  // cascade delete: 関連テーブルは FK CASCADE に任せる
  const del = await fetch(`${SB_URL}/rest/v1/strategy_registry?id=in.(${rows.map(r => r.id).join(",")})`, {
    method: "DELETE",
    headers: { ...hdrs, "Prefer": "return=minimal" },
  });
  return rows.length;
}

async function getNextMagic(): Promise<number> {
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry?select=magic_number&order=magic_number.desc&limit=1`, { headers: hdrs });
  const d   = await res.json() as { magic_number: number }[];
  return (d[0]?.magic_number ?? 20000) + 1;
}

async function nameExists(name: string): Promise<boolean> {
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry?name=eq.${encodeURIComponent(name)}&select=id`, { headers: hdrs });
  return ((await res.json()) as unknown[]).length > 0;
}

async function insertStrategy(spec: StrategySpec, magic: number): Promise<string> {
  const h = { ...hdrs, "Content-Type": "application/json", "Prefer": "return=representation" };
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      name: spec.name, strategy_type: spec.strategy_type,
      description: spec.description ?? null,
      symbols: spec.symbols, timeframes: spec.timeframes,
      entry_conditions: spec.entry_conditions,
      exit_conditions: spec.exit_conditions ?? null,
      filters: spec.filters ?? null,
      risk: spec.risk,
      magic_number: magic,
      enabled: false, status: "DRAFT", backtest_status: "PASSED",
    }),
  });
  if (!res.ok) throw new Error(`insert: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }[])[0].id;
}

// ── 戦略テンプレート生成 ──────────────────────────────────────────────
interface TplResult {
  spec:   StrategySpec;
  mainTf: string;
}

function makeBuyTemplates(sym: string): TplResult[] {
  const s    = sym;
  const tpl  = (name: string, entry: StrategySpec["entry_conditions"], exit: StrategySpec["exit_conditions"], strategy_type: StrategySpec["strategy_type"] = "DAY_TRADE"): TplResult => ({
    mainTf: "H1",
    spec: {
      name, strategy_type,
      description: `${sym} H1 BUY: ${name.replace(`${sym} `, "")}`,
      symbols: [s], timeframes: ["H1", "H4"],
      entry_conditions: entry,
      exit_conditions:  exit,
      filters: {
        sessions: ["LONDON", "NEW_YORK"],
        max_spread_pips: sym.includes("JPY") ? 5.0 : sym === "GOLD" ? 60.0 : 3.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" }],
      },
      risk: { risk_per_trade: 1.0 },
    },
  });

  const SL_ATR = { method: "ATR" as const, period: 14, multiplier: 2.0 };
  const TP_RR2 = { method: "RR_RATIO" as const, rr_ratio: 2.0 };
  const TP_RR25 = { method: "RR_RATIO" as const, rr_ratio: 2.5 };

  return [
    // A: Ichimoku + EMA BUY
    tpl(`${sym} H1 Ichimoku EMA BUY`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_ABOVE_CLOUD" },
        { indicator: "EMA",      timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR2 }
    ),
    // B: Ichimoku + MACD BUY
    tpl(`${sym} H1 Ichimoku MACD BUY`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_ABOVE_CLOUD" },
        { indicator: "MACD",     timeframe: "H1", operator: "ABOVE_SIGNAL" },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR25 }
    ),
    // C: Ichimoku + RSI BUY
    tpl(`${sym} H1 Ichimoku RSI BUY`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_ABOVE_CLOUD" },
        { indicator: "RSI",      timeframe: "H1", period: 14, operator: "ABOVE", threshold: 50 },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR2 }
    ),
    // D: Ichimoku + ADX BUY
    tpl(`${sym} H1 Ichimoku ADX BUY`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_ABOVE_CLOUD" },
        { indicator: "ADX",      timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR2 }
    ),
    // E: AO + EMA + MACD BUY
    tpl(`${sym} H1 AO EMA MACD BUY`,
      { logic: "AND", conditions: [
        { indicator: "AO",   timeframe: "H1", operator: "ABOVE" },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_ABOVE" },
        { indicator: "MACD", timeframe: "H1", operator: "ABOVE_SIGNAL" },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR25 }
    ),
  ];
}

function makeSellTemplates(sym: string): TplResult[] {
  const s    = sym;
  const tpl  = (name: string, entry: StrategySpec["entry_conditions"], exit: StrategySpec["exit_conditions"], strategy_type: StrategySpec["strategy_type"] = "DAY_TRADE"): TplResult => ({
    mainTf: "H1",
    spec: {
      name, strategy_type,
      description: `${sym} H1 SELL: ${name.replace(`${sym} `, "")}`,
      symbols: [s], timeframes: ["H1", "H4"],
      entry_conditions: entry,
      exit_conditions:  exit,
      filters: {
        sessions: ["LONDON", "NEW_YORK"],
        max_spread_pips: sym.includes("JPY") ? 5.0 : sym === "GOLD" ? 60.0 : 3.0,
        trend_filters: [{ timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" }],
      },
      risk: { risk_per_trade: 1.0 },
    },
  });

  const SL_ATR  = { method: "ATR" as const, period: 14, multiplier: 2.0 };
  const TP_RR2  = { method: "RR_RATIO" as const, rr_ratio: 2.0 };
  const TP_RR25 = { method: "RR_RATIO" as const, rr_ratio: 2.5 };

  return [
    // F: Ichimoku + EMA SELL
    tpl(`${sym} H1 Ichimoku EMA SELL`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_BELOW_CLOUD" },
        { indicator: "EMA",      timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR2 }
    ),
    // G: Ichimoku + MACD SELL
    tpl(`${sym} H1 Ichimoku MACD SELL`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_BELOW_CLOUD" },
        { indicator: "MACD",     timeframe: "H1", operator: "BELOW_SIGNAL" },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR25 }
    ),
    // H: Ichimoku + RSI SELL
    tpl(`${sym} H1 Ichimoku RSI SELL`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_BELOW_CLOUD" },
        { indicator: "RSI",      timeframe: "H1", period: 14, operator: "BELOW", threshold: 50 },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR2 }
    ),
    // I: Ichimoku + ADX SELL
    tpl(`${sym} H1 Ichimoku ADX SELL`,
      { logic: "AND", conditions: [
        { indicator: "ICHIMOKU", timeframe: "H1", operator: "PRICE_BELOW_CLOUD" },
        { indicator: "ADX",      timeframe: "H1", period: 14, operator: "ABOVE", threshold: 20 },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR2 }
    ),
    // J: AO + EMA + MACD SELL
    tpl(`${sym} H1 AO EMA MACD SELL`,
      { logic: "AND", conditions: [
        { indicator: "AO",   timeframe: "H1", operator: "BELOW" },
        { indicator: "EMA",  timeframe: "H1", period: 21, operator: "PRICE_BELOW" },
        { indicator: "MACD", timeframe: "H1", operator: "BELOW_SIGNAL" },
      ]},
      { stop_loss: SL_ATR, take_profit: TP_RR25 }
    ),
  ];
}

// ── Screen one candidate ────────────────────────────────────────────
interface ScreenRow {
  name:    string;
  sym:     string;
  trades:  number;
  tpm:     number;
  wr:      number;
  pips:    number;
  pf:      string;
  passed:  boolean;
  reject:  string;
}

async function screen(cand: TplResult, sym: string): Promise<{ passed: boolean; row: ScreenRow }> {
  const btf = Object.fromEntries(
    cand.spec.timeframes.map(tf => [tf, barCache.get(`${sym}_${tf}`) ?? []])
  );

  let r: ReturnType<typeof runBacktest>;
  try {
    r = runBacktest({
      spec: cand.spec, symbol: sym,
      mainTimeframe: cand.mainTf,
      barsByTimeframe: btf,
      initialBalance: 10_000,
      fixedLot: 0.01,
    });
  } catch {
    return { passed: false, row: { name: cand.spec.name, sym, trades: 0, tpm: 0, wr: 0, pips: 0, pf: "0", passed: false, reject: "ERR" } };
  }

  const mB    = btf[cand.mainTf] ?? [];
  const mo    = mB.length > 0 ? (mB[mB.length - 1].time - mB[0].time) / (30 * 24 * 3600 * 1000) : 12;
  const tpm   = mo > 0 ? r.totalTrades / mo : 0;
  const gw    = r.trades.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
  const gl    = Math.abs(r.trades.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
  const pf    = gl > 0 ? (gw / gl).toFixed(2) : (gw > 0 ? "∞" : "0");

  let reject = "";
  if (r.winRate    < MIN_WR)   reject += `WR=${r.winRate.toFixed(0)}% `;
  if (tpm          < MIN_TPM)  reject += `T/mo=${tpm.toFixed(1)} `;
  if (r.totalPips  <= MIN_PIPS) reject += `Pips=${r.totalPips.toFixed(0)} `;
  const passed = reject === "";

  return {
    passed,
    row: {
      name: cand.spec.name, sym,
      trades: r.totalTrades, tpm: +tpm.toFixed(1),
      wr: +r.winRate.toFixed(1), pips: +r.totalPips.toFixed(1),
      pf, passed, reject: reject.trim(),
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log("=== AVL FX — 全通貨ペア EA 再構築 ===");
  console.log(`対象シンボル: ${SYMBOLS.length}`);
  console.log(`スクリーニング基準: WR≥${MIN_WR}% / T/mo≥${MIN_TPM} / Pips>${MIN_PIPS}\n`);

  // ── 1. 全既存EA削除 ───────────────────────────────────────────────
  console.log("[1] 既存EAを全削除...");
  const deleted = await deleteAllStrategies();
  if (deleted > 0) console.log(`  ${deleted} 件削除完了\n`);
  else console.log("  既に空（前回削除済み）\n");

  // ── 2. バーデータ一括取得 ─────────────────────────────────────────
  console.log("[2] バーデータ取得中...");
  const validSymbols: Sym[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym}`);
    const h1  = await fetchBars(sym, "H1");
    const h4  = await fetchBars(sym, "H4");
    process.stdout.write(` H1:${h1.length} H4:${h4.length}`);
    if (h1.length >= MIN_BARS_H1) {
      validSymbols.push(sym);
      process.stdout.write(" ✓\n");
    } else {
      process.stdout.write(" — 不足\n");
    }
  }
  console.log(`\n  有効シンボル: ${validSymbols.join(", ")}\n`);

  // ── 3. スクリーニング ──────────────────────────────────────────────
  console.log("[3] スクリーニング実行中...\n");
  const allRows: ScreenRow[] = [];
  const passing: TplResult[] = [];

  for (const sym of validSymbols) {
    const candidates = [...makeBuyTemplates(sym), ...makeSellTemplates(sym)];
    const symResults: ScreenRow[] = [];
    for (const cand of candidates) {
      const { passed, row } = await screen(cand, sym);
      symResults.push(row);
      if (passed) {
        console.log(`  ✅ ${row.name.padEnd(38)} T/mo=${row.tpm} WR=${row.wr}% Pips=${row.pips} PF=${row.pf}`);
        passing.push(cand);
      }
    }
    allRows.push(...symResults);
  }

  // ── 4. 結果サマリー ───────────────────────────────────────────────
  console.log(`\n[4] サマリー`);
  console.log("─".repeat(90));
  console.log(`${"Strategy".padEnd(42)} ${"T/mo".padEnd(6)} ${"WR%".padEnd(6)} ${"Pips".padEnd(10)} ${"PF".padEnd(6)} Status`);
  console.log("─".repeat(90));
  for (const r of allRows) {
    const st = r.passed ? "PASS ✅" : "fail";
    console.log(`${r.name.padEnd(42)} ${String(r.tpm).padEnd(6)} ${String(r.wr).padEnd(6)} ${String(r.pips).padEnd(10)} ${r.pf.padEnd(6)} ${st}`);
  }
  console.log("─".repeat(90));
  console.log(`合格: ${passing.length} / ${allRows.length}\n`);

  if (passing.length === 0) {
    console.log("合格戦略なし。DB変更なし。");
    return;
  }

  // ── 5. 登録 ──────────────────────────────────────────────────────
  console.log(`[5] ${passing.length} 件を登録中...`);
  let inserted = 0;
  for (const cand of passing) {
    if (await nameExists(cand.spec.name)) {
      console.log(`  [SKIP] ${cand.spec.name}`);
      continue;
    }
    const magic = await getNextMagic();
    const id    = await insertStrategy(cand.spec, magic);
    console.log(`  [OK] ${cand.spec.name}  magic=${magic}  id=${id.slice(0, 8)}...`);
    inserted++;
  }

  console.log(`\n=== 完了: ${inserted} EA 登録 ===`);
}

main().catch(e => { console.error(e); process.exit(1); });

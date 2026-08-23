/**
 * add_curated_eas_v4.ts — H4ベース + 一目/AO特化追加候補
 */
export {};

import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import { runBacktest }       from "@/infrastructure/backtest/BacktestEngine";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL = "EURUSD";
const PAGE   = 1000;
const MIN_WR = 30, MIN_TPM = 5, MIN_PIPS = 0;

type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };
async function fetchBars(tf: string): Promise<Bar[]> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const rows: BarRow[] = []; let offset = 0;
  process.stdout.write(`  ${tf}`);
  for (;;) {
    const res = await fetch(`${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume&symbol=eq.${SYMBOL}&timeframe=eq.${tf}&order=time_utc.asc&limit=${PAGE}&offset=${offset}`, { headers: hdrs });
    const b = (await res.json()) as BarRow[];
    rows.push(...b); process.stdout.write("."); if (b.length < PAGE) break; offset += PAGE;
  }
  process.stdout.write(` ${rows.length}\n`);
  return rows.map(r => ({ time: new Date(r.time_utc).getTime(), open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume: r.volume??0 }));
}
async function getNextMagic(): Promise<number> {
  const d = (await (await fetch(`${SB_URL}/rest/v1/strategy_registry?select=magic_number&order=magic_number.desc&limit=1`, { headers: { apikey: SB_KEY, Authorization:`Bearer ${SB_KEY}` } })).json()) as { magic_number: number }[];
  return (d[0]?.magic_number ?? 20000) + 1;
}
async function nameExists(name: string): Promise<boolean> {
  return ((await (await fetch(`${SB_URL}/rest/v1/strategy_registry?name=eq.${encodeURIComponent(name)}&select=id`, { headers: { apikey: SB_KEY, Authorization:`Bearer ${SB_KEY}` } })).json()) as unknown[]).length > 0;
}
async function insertStrategy(spec: StrategySpec, magic: number): Promise<string> {
  const hdrs = { apikey: SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", "Prefer":"return=representation" };
  const res = await fetch(`${SB_URL}/rest/v1/strategy_registry`, { method:"POST", headers: hdrs,
    body: JSON.stringify({ name:spec.name, strategy_type:spec.strategy_type, description:spec.description??null, symbols:spec.symbols, timeframes:spec.timeframes, entry_conditions:spec.entry_conditions, exit_conditions:spec.exit_conditions??null, filters:spec.filters??null, risk:spec.risk, magic_number:magic, enabled:false, status:"DRAFT", backtest_status:"PASSED" })});
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { id:string }[])[0].id;
}

interface C { spec: StrategySpec; mainTf: string; }

const CANDIDATES: C[] = [

  // H4 一目均衡表 雲上 + EMA21 BUY
  { mainTf:"H4", spec: { name:"H4 Ichimoku Cloud EMA BUY", strategy_type:"SWING",
    description:"H4 一目雲上 + EMA21上。H1 EMA21でセカンドフィルター",
    symbols:["EURUSD"], timeframes:["H4","H1"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"ICHIMOKU", timeframe:"H4", operator:"PRICE_ABOVE_CLOUD" },
      { indicator:"EMA",      timeframe:"H4", period:21, operator:"PRICE_ABOVE" },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.0 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0,
      trend_filters:[{ timeframe:"H1", indicator:"EMA", period:21, direction:"BULLISH" }] },
    risk:{ risk_per_trade:1.0 } }},

  // H4 一目 + MACD BUY
  { mainTf:"H4", spec: { name:"H4 Ichimoku MACD BUY", strategy_type:"SWING",
    description:"H4 一目雲上 + MACD上シグナル。H1 EMA21フィルター",
    symbols:["EURUSD"], timeframes:["H4","H1"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"ICHIMOKU", timeframe:"H4", operator:"PRICE_ABOVE_CLOUD" },
      { indicator:"MACD",     timeframe:"H4", operator:"ABOVE_SIGNAL" },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.5 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0,
      trend_filters:[{ timeframe:"H1", indicator:"EMA", period:21, direction:"BULLISH" }] },
    risk:{ risk_per_trade:1.0 } }},

  // H4 MACD + EMA21 BUY
  { mainTf:"H4", spec: { name:"H4 MACD EMA Trend BUY", strategy_type:"SWING",
    description:"H4 MACD上 + EMA21上。大局上昇トレンドフォロー",
    symbols:["EURUSD"], timeframes:["H4"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"MACD", timeframe:"H4", operator:"ABOVE_SIGNAL" },
      { indicator:"EMA",  timeframe:"H4", period:21, operator:"PRICE_ABOVE" },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.5 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0 },
    risk:{ risk_per_trade:1.0 } }},

  // H4 RSI + MACD + EMA BUY
  { mainTf:"H4", spec: { name:"H4 RSI MACD EMA BUY", strategy_type:"SWING",
    description:"H4 RSI>50 + MACD上 + EMA21上。トリプル確認スウィング",
    symbols:["EURUSD"], timeframes:["H4"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"RSI",  timeframe:"H4", period:14, operator:"ABOVE", threshold:50 },
      { indicator:"MACD", timeframe:"H4", operator:"ABOVE_SIGNAL" },
      { indicator:"EMA",  timeframe:"H4", period:21, operator:"PRICE_ABOVE" },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.5 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0 },
    risk:{ risk_per_trade:1.0 } }},

  // H1 Ichimoku + RSI>50 BUY
  { mainTf:"H1", spec: { name:"H1 Ichimoku RSI BUY", strategy_type:"DAY_TRADE",
    description:"H1 一目雲上 + RSI>50モメンタム。H4 EMA21フィルター",
    symbols:["EURUSD"], timeframes:["H1","H4"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"ICHIMOKU", timeframe:"H1", operator:"PRICE_ABOVE_CLOUD" },
      { indicator:"RSI",      timeframe:"H1", period:14, operator:"ABOVE", threshold:50 },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.0 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0,
      trend_filters:[{ timeframe:"H4", indicator:"EMA", period:21, direction:"BULLISH" }] },
    risk:{ risk_per_trade:1.0 } }},

  // H1 Ichimoku + ADX>20 BUY
  { mainTf:"H1", spec: { name:"H1 Ichimoku ADX BUY", strategy_type:"DAY_TRADE",
    description:"H1 一目雲上 + ADX>20(トレンド強度)。H4 EMA21フィルター",
    symbols:["EURUSD"], timeframes:["H1","H4"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"ICHIMOKU", timeframe:"H1", operator:"PRICE_ABOVE_CLOUD" },
      { indicator:"ADX",      timeframe:"H1", period:14, operator:"ABOVE", threshold:20 },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.0 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0,
      trend_filters:[{ timeframe:"H4", indicator:"EMA", period:21, direction:"BULLISH" }] },
    risk:{ risk_per_trade:1.0 } }},

  // H1 AO + MACD BUY (2条件のみ、シンプル)
  { mainTf:"H1", spec: { name:"H1 AO MACD BUY", strategy_type:"DAY_TRADE",
    description:"AO>0 + MACD上。シンプル2条件。H4 EMA21フィルター",
    symbols:["EURUSD"], timeframes:["H1","H4"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"AO",   timeframe:"H1", operator:"ABOVE" },
      { indicator:"MACD", timeframe:"H1", operator:"ABOVE_SIGNAL" },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.5 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0,
      trend_filters:[{ timeframe:"H4", indicator:"EMA", period:21, direction:"BULLISH" }] },
    risk:{ risk_per_trade:1.0 } }},

  // H1 Ichimoku 3条件 BUY (最強版)
  { mainTf:"H1", spec: { name:"H1 Ichimoku RSI MACD BUY", strategy_type:"DAY_TRADE",
    description:"一目雲上 + RSI>50 + MACD上。三重確認の強気エントリー",
    symbols:["EURUSD"], timeframes:["H1","H4"],
    entry_conditions:{ logic:"AND", conditions:[
      { indicator:"ICHIMOKU", timeframe:"H1", operator:"PRICE_ABOVE_CLOUD" },
      { indicator:"RSI",      timeframe:"H1", period:14, operator:"ABOVE", threshold:50 },
      { indicator:"MACD",     timeframe:"H1", operator:"ABOVE_SIGNAL" },
    ]},
    exit_conditions:{ stop_loss:{ method:"ATR", period:14, multiplier:2.0 }, take_profit:{ method:"RR_RATIO", rr_ratio:2.5 } },
    filters:{ sessions:["LONDON","NEW_YORK"], max_spread_pips:2.0,
      trend_filters:[{ timeframe:"H4", indicator:"EMA", period:21, direction:"BULLISH" }] },
    risk:{ risk_per_trade:1.0 } }},

];

async function main() {
  console.log("=== AVL FX EA Screening v4 ===");
  const tfs = [...new Set(CANDIDATES.flatMap(c => c.spec.timeframes))];
  const btf: Record<string, Bar[]> = {};
  for (const tf of tfs) btf[tf] = await fetchBars(tf);

  const passing: C[] = [];
  for (const cand of CANDIDATES) {
    const bars = Object.fromEntries(cand.spec.timeframes.map(tf => [tf, btf[tf]??[]]));
    let r: ReturnType<typeof runBacktest>;
    try { r = runBacktest({ spec:cand.spec, symbol:SYMBOL, mainTimeframe:cand.mainTf, barsByTimeframe:bars, initialBalance:10000, fixedLot:0.01 }); }
    catch(e) { console.log(`  [ERR] ${cand.spec.name}: ${e}`); continue; }
    const mB   = bars[cand.mainTf] ?? [];
    const mo   = mB.length > 0 ? (mB[mB.length-1].time - mB[0].time) / (30*24*3600*1000) : 12;
    const tpm  = mo > 0 ? r.totalTrades/mo : 0;
    const gw   = r.trades.filter(t=>t.pips>0).reduce((s,t)=>s+t.pips,0);
    const gl   = Math.abs(r.trades.filter(t=>t.pips<0).reduce((s,t)=>s+t.pips,0));
    const pf   = gl>0 ? (gw/gl).toFixed(2) : (gw>0?"∞":"0");
    let why = "";
    if (r.winRate < MIN_WR)         why += `WR=${r.winRate.toFixed(1)}<${MIN_WR} `;
    if (tpm < MIN_TPM)              why += `T/mo=${tpm.toFixed(1)}<${MIN_TPM} `;
    if (r.totalPips <= MIN_PIPS)    why += `Pips=${r.totalPips.toFixed(1)}≤0 `;
    const ok = why==="";
    console.log(`  ${ok?"✅":"❌"} ${cand.spec.name}  [${cand.mainTf}] T=${r.totalTrades}(${tpm.toFixed(1)}/mo) WR=${r.winRate.toFixed(1)}% Pips=${r.totalPips.toFixed(1)} PF=${pf}${why?" → "+why.trim():""}`);
    if (ok) passing.push(cand);
  }

  console.log(`\nPassed: ${passing.length}/${CANDIDATES.length}`);
  if (!passing.length) return;
  let ins=0;
  for (const c of passing) {
    if (await nameExists(c.spec.name)) { console.log(`  [SKIP] ${c.spec.name}`); continue; }
    const magic = await getNextMagic();
    const id = await insertStrategy(c.spec, magic);
    console.log(`  [OK] ${c.spec.name}  id=${id}  magic=${magic}`);
    ins++;
  }
  console.log(`=== +${ins} EA(s) registered ===`);
}

main().catch(e=>{console.error(e);process.exit(1);});

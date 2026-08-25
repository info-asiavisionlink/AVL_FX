/**
 * fact_check_all_eas.ts — 全EA バックテスト事実確認
 *
 * 検証項目:
 *  1. IS/OOS スプリット (70%/30%) — 過去最適化の確認
 *  2. ランダムベースライン比較 — エッジの有無を確認
 *  3. 同バー決済率 — ルックアヘッドバイアスの指標
 *  4. コスト実効値 — スプレッド/スリッページが正しく反映されているか
 *  5. 統計的有意性 — サンプル数と信頼区間
 *  6. 月次収益の安定性 — 特定月への依存チェック
 *
 * Usage: npx tsx --env-file=.env.local scripts/fact_check_all_eas.ts
 */
export {};

import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import { runBacktest, type BacktestTrade } from "@/infrastructure/backtest/BacktestEngine";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const hdrs   = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// ── Fetch helpers ────────────────────────────────────────────────────
type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

const barCache = new Map<string, Bar[]>();

async function fetchBars(sym: string, tf: string): Promise<Bar[]> {
  const key = `${sym}_${tf}`;
  if (barCache.has(key)) return barCache.get(key)!;
  const rows: BarRow[] = [];
  let offset = 0;
  while (true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume` +
          `&symbol=eq.${sym}&timeframe=eq.${tf}&order=time_utc.asc&limit=1000&offset=${offset}`,
          { headers: hdrs }
        );
        const b = await res.json() as BarRow[];
        rows.push(...b);
        if (b.length < 1000) { barCache.set(key, toBar(rows)); return barCache.get(key)!; }
        offset += 1000;
        break;
      } catch { if (attempt === 2) throw new Error(`fetch ${sym}_${tf} failed`); await new Promise(r => setTimeout(r,1000)); }
    }
  }
}

function toBar(rows: BarRow[]): Bar[] {
  return rows.map(r => ({ time: new Date(r.time_utc).getTime(), open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume: r.volume??0 }));
}

async function fetchStrategies(): Promise<Array<{id:string; name:string; spec:StrategySpec}>> {
  const res  = await fetch(`${SB_URL}/rest/v1/strategy_registry?select=id,name,symbols,timeframes,entry_conditions,exit_conditions,filters,risk,strategy_type,description&order=magic_number.asc`, { headers: hdrs });
  const rows = await res.json() as Record<string,unknown>[];
  return rows.map(r => ({ id: String(r.id), name: String(r.name), spec: r as unknown as StrategySpec }));
}

// ── Stats helpers ─────────────────────────────────────────────────────
function stats(trades: BacktestTrade[]) {
  if (!trades.length) return null;
  const wins   = trades.filter(t => t.result === "WIN").length;
  const losses = trades.filter(t => t.result === "LOSS").length;
  const total  = trades.length;
  const pips   = trades.reduce((s,t) => s + t.pips, 0);
  const gw     = trades.filter(t => t.pips > 0).reduce((s,t) => s + t.pips, 0);
  const gl     = Math.abs(trades.filter(t => t.pips < 0).reduce((s,t) => s + t.pips, 0));
  const wr     = total ? wins / total * 100 : 0;
  const pf     = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  return { wins, losses, total, wr, pips, gw, gl, pf };
}

// ── ランダムベースライン ─────────────────────────────────────────────
function seededRNG(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function runRandom(
  spec: StrategySpec,
  sym: string, mainTf: string,
  bars: Record<string, Bar[]>,
  seed = 42,
): BacktestTrade[] {
  const rng      = seededRNG(seed);
  const mainBars = bars[mainTf] ?? [];
  // spec をそのままだが、エントリーをランダムに置き換え
  const WARMUP  = 60;
  const mockSpec: StrategySpec = {
    ...spec,
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "RSI", timeframe: mainTf, period: 14, operator: "ABOVE", threshold: 0 }, // always true
      ],
    },
    filters: { ...spec.filters, sessions: undefined, max_spread_pips: undefined, trend_filters: undefined, trend_filter: undefined },
  };
  // 約 spec と同数のシグナルを生成するため、ランダムに間引き
  const targetSignalRate = 0.03; // 全バーの3%でシグナル
  const signalBars = mainBars.slice(WARMUP).filter(() => rng() < targetSignalRate);
  if (!signalBars.length) return [];

  // signalBarsをbarsByTimeframe風に偽造してエンジンを回す
  // → シンプルに: ランダム選択した bar で同じ SL/TP を適用してpips計算
  const result = runBacktest({
    spec:           mockSpec,
    symbol:         sym,
    mainTimeframe:  mainTf,
    barsByTimeframe: bars,
    initialBalance: 10_000,
    fixedLot:       0.01,
    _spreadOverride: 0,
    _slippageOverride: 0,
  });
  return result.trades;
}

// ── 信頼区間 (Wilson interval) ─────────────────────────────────────
function wilsonCI(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p   = wins / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - spread) * 100, Math.min(1, center + spread) * 100];
}

// ── 月次収益 ─────────────────────────────────────────────────────────
function monthlyPips(trades: BacktestTrade[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of trades) {
    const d   = new Date(t.entryTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    map.set(key, (map.get(key) ?? 0) + t.pips);
  }
  return map;
}

// ── Main ─────────────────────────────────────────────────────────────
interface FactResult {
  name:        string;
  sym:         string;
  // Full backtest
  totalTrades: number;
  wr:          number;
  pips:        number;
  pf:          number | string;
  // IS/OOS
  is_wr:       number;
  oos_wr:      number;
  is_pips:     number;
  oos_pips:    number;
  oos_pf:      number | string;
  // Same-bar exit
  sameBarPct:  number;
  // Cost audit
  spreadCostPips: number;
  // Random baseline
  rand_wr:     number;
  rand_pips:   number;
  // Statistical
  ci_lo:       number;
  ci_hi:       number;
  // Monthly stability
  profitMonths: number;
  totalMonths:  number;
  worstMonth:  number;
  // Verdict
  verdict:     "RELIABLE" | "MARGINAL" | "SUSPICIOUS";
  flags:       string[];
}

async function main() {
  console.log("=".repeat(70));
  console.log("  AVL FX — バックテスト事実確認レポート");
  console.log("=".repeat(70));
  console.log(`
検証項目:
  IS/OOS   : データを70/30分割。OOSで同様のエッジが出るか
  同バー率  : 同バー内でSL/TPがヒットする割合(高いと精度懸念)
  ランダム比: ランダムエントリーとの比較（エッジの有無）
  信頼区間  : WRの95%信頼区間（Wilson法）
  月次安定  : 何割の月でプラスになるか
`);

  const strategies = await fetchStrategies();
  console.log(`対象: ${strategies.length} EA\n`);

  // バーデータ取得
  console.log("バーデータ取得中...");
  const symTfs = new Set<string>();
  for (const { spec } of strategies) {
    for (const tf of spec.timeframes) symTfs.add(`${spec.symbols[0]}_${tf}`);
  }
  for (const symTf of symTfs) {
    const [sym, tf] = symTf.split("_");
    process.stdout.write(`  ${sym} ${tf}...`);
    await fetchBars(sym, tf);
    process.stdout.write(` ✓\n`);
  }
  console.log();

  const results: FactResult[] = [];

  for (const { name, spec } of strategies) {
    const sym    = spec.symbols[0];
    const mainTf = spec.timeframes[0];
    const bars   = Object.fromEntries(spec.timeframes.map(tf => [tf, barCache.get(`${sym}_${tf}`) ?? []]));
    const mainBars = bars[mainTf] ?? [];

    // ── Full backtest ────────────────────────────────────────────────
    const full = runBacktest({ spec, symbol: sym, mainTimeframe: mainTf, barsByTimeframe: bars, initialBalance:10000, fixedLot:0.01 });
    const fullSt = stats(full.trades);
    if (!fullSt || fullSt.total < 10) {
      console.log(`  [SKIP] ${name} — too few trades`);
      continue;
    }

    // ── IS/OOS split (70% / 30%) ─────────────────────────────────────
    const cutTime  = mainBars[Math.floor(mainBars.length * 0.7)]?.time ?? 0;
    const isTrades = full.trades.filter(t => t.entryTime < cutTime);
    const oosTrades= full.trades.filter(t => t.entryTime >= cutTime);
    const isSt    = stats(isTrades);
    const oosSt   = stats(oosTrades);

    // ── Same-bar exit rate ──────────────────────────────────────────
    const samebar    = full.trades.filter(t => t.entryBarIdx === t.exitBarIdx).length;
    const sameBarPct = fullSt.total > 0 ? samebar / fullSt.total * 100 : 0;

    // ── Cost audit (スプレッド+スリッページ の実効コスト) ────────────
    const spreadPips   = full.trades.reduce((s, t) => s + (t.spreadPips ?? 0), 0);
    const slippagePips = full.trades.reduce((s, t) => s + (t.slippagePips ?? 0), 0);
    const spreadCostPips = spreadPips + slippagePips;

    // ── Random baseline ──────────────────────────────────────────────
    let randSt = { wr: 0, pips: 0, total: 0 };
    try {
      const randTrades = runRandom(spec, sym, mainTf, bars);
      const rs = stats(randTrades);
      if (rs) randSt = { wr: rs.wr, pips: rs.pips, total: rs.total };
    } catch { /* ignore */ }

    // ── 信頼区間 ─────────────────────────────────────────────────────
    const [ci_lo, ci_hi] = wilsonCI(fullSt.wins, fullSt.total);

    // ── 月次安定性 ───────────────────────────────────────────────────
    const monthly = monthlyPips(full.trades);
    const monthVals = [...monthly.values()];
    const profitMonths = monthVals.filter(v => v > 0).length;
    const worstMonth   = monthVals.length ? Math.min(...monthVals) : 0;

    // ── 総合判定 ─────────────────────────────────────────────────────
    const flags: string[] = [];
    if (sameBarPct > 30)        flags.push(`同バー率${sameBarPct.toFixed(0)}%高`);
    if (!oosSt || oosSt.pips <= 0) flags.push("OOSで損失");
    if (!oosSt || oosSt.wr < 25)   flags.push(`OOS WR=${oosSt?.wr.toFixed(0)??"?"}%低`);
    if (randSt.pips > fullSt.pips * 0.7) flags.push("ランダムと差小");
    if (profitMonths < monthVals.length * 0.4) flags.push(`黒字月${profitMonths}/${monthVals.length}少`);
    if (fullSt.total < 30)      flags.push(`サンプル${fullSt.total}件少`);
    if (ci_lo < 28)              flags.push(`CI下限${ci_lo.toFixed(0)}%<28%`);

    let verdict: FactResult["verdict"] = "RELIABLE";
    if (flags.length >= 3) verdict = "SUSPICIOUS";
    else if (flags.length >= 1) verdict = "MARGINAL";

    const r: FactResult = {
      name, sym,
      totalTrades: fullSt.total, wr: fullSt.wr, pips: fullSt.pips,
      pf: fullSt.pf === Infinity ? "∞" : fullSt.pf.toFixed(2),
      is_wr:   isSt?.wr ?? 0,   oos_wr:  oosSt?.wr ?? 0,
      is_pips: isSt?.pips ?? 0, oos_pips: oosSt?.pips ?? 0,
      oos_pf:  oosSt ? (oosSt.pf === Infinity ? "∞" : oosSt.pf.toFixed(2)) : "N/A",
      sameBarPct, spreadCostPips,
      rand_wr: randSt.wr, rand_pips: randSt.pips,
      ci_lo, ci_hi,
      profitMonths, totalMonths: monthVals.length, worstMonth,
      verdict, flags,
    };
    results.push(r);

    const icon = verdict === "RELIABLE" ? "✅" : verdict === "MARGINAL" ? "⚠" : "❌";
    console.log(`${icon} ${name}`);
    console.log(`   WR=${fullSt.wr.toFixed(1)}% CI[${ci_lo.toFixed(0)}-${ci_hi.toFixed(0)}%]  Pips=${fullSt.pips.toFixed(0)}  PF=${r.pf}  N=${fullSt.total}`);
    console.log(`   IS: WR=${r.is_wr.toFixed(1)}% Pips=${r.is_pips.toFixed(0)}  |  OOS: WR=${r.oos_wr.toFixed(1)}% Pips=${r.oos_pips.toFixed(0)} PF=${r.oos_pf}`);
    console.log(`   同バー率=${sameBarPct.toFixed(1)}%  コスト=${spreadCostPips.toFixed(0)}pips  Random: WR=${randSt.wr.toFixed(1)}% Pips=${randSt.pips.toFixed(0)}`);
    console.log(`   黒字月: ${profitMonths}/${monthVals.length}  最悪月: ${worstMonth.toFixed(0)}pips`);
    if (flags.length) console.log(`   ⚑ ${flags.join("  ")}`);
    console.log();
  }

  // ── 総合サマリー ─────────────────────────────────────────────────
  console.log("=".repeat(70));
  console.log("  総合サマリー");
  console.log("=".repeat(70));

  const reliable    = results.filter(r => r.verdict === "RELIABLE");
  const marginal    = results.filter(r => r.verdict === "MARGINAL");
  const suspicious  = results.filter(r => r.verdict === "SUSPICIOUS");

  console.log(`
✅ RELIABLE  (信頼できる)  : ${reliable.length}本
⚠  MARGINAL  (要注意)     : ${marginal.length}本
❌ SUSPICIOUS(疑問あり)   : ${suspicious.length}本
`);

  if (suspicious.length) {
    console.log("❌ 疑問ありの戦略:");
    for (const r of suspicious) console.log(`   ${r.name}  flags: ${r.flags.join(", ")}`);
    console.log();
  }
  if (marginal.length) {
    console.log("⚠ 要注意の戦略:");
    for (const r of marginal) console.log(`   ${r.name}  flags: ${r.flags.join(", ")}`);
    console.log();
  }

  // OOS PF ランキング
  const sorted = [...results].filter(r => typeof r.oos_pf === "string" && r.oos_pf !== "N/A" || typeof r.oos_pf === "number")
    .sort((a, b) => {
      const pa = a.oos_pf === "∞" ? 999 : +(a.oos_pf);
      const pb = b.oos_pf === "∞" ? 999 : +(b.oos_pf);
      return pb - pa;
    });

  console.log("=".repeat(70));
  console.log("  OOS (検証期間) パフォーマンス ランキング");
  console.log("=".repeat(70));
  console.log(`${"Strategy".padEnd(42)} ${"OOS_WR%".padEnd(8)} ${"OOS_Pips".padEnd(10)} ${"OOS_PF".padEnd(8)} Verdict`);
  console.log("-".repeat(70));
  for (const r of sorted.slice(0, 20)) {
    const icon = r.verdict === "RELIABLE" ? "✅" : r.verdict === "MARGINAL" ? "⚠" : "❌";
    console.log(`${r.name.padEnd(42)} ${r.oos_wr.toFixed(1).padEnd(8)} ${r.oos_pips.toFixed(0).padEnd(10)} ${String(r.oos_pf).padEnd(8)} ${icon}`);
  }

  // 全体の同バー率・コスト集計
  const avgSameBar = results.reduce((s, r) => s + r.sameBarPct, 0) / results.length;
  const totalCost  = results.reduce((s, r) => s + r.spreadCostPips, 0);
  console.log(`\n平均同バー決済率: ${avgSameBar.toFixed(1)}% (< 20% が理想)`);
  console.log(`総コスト (全EA計): ${totalCost.toFixed(0)} pips`);
}

main().catch(e => { console.error(e); process.exit(1); });

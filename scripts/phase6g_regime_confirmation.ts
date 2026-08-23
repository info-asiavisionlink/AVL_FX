/**
 * Phase 6-G: Regime Hypothesis Confirmation
 *
 * Tests whether Phase 6-F's discovery (DOWN_REGIME LONG PF=1.350) is a
 * reproducible edge or a post-hoc artifact.
 *
 * G1: H1 MEAN_REVERSION LONG  — DOWN_REGIME only
 * G2: H1 MEAN_REVERSION SHORT — UP_REGIME only (symmetry control)
 *
 * CASE A: No engine changes. Regime filter applied via _evaluatorOverride.
 * All data was used in Phase 6-F → TRUE UNSEEN DATA: NO → result is
 * PROMISING_BUT_UNCONFIRMED at best.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/phase6g_regime_confirmation.ts
 */

export {};

import type { Bar }                                           from "@/infrastructure/analysis/types";
import type { StrategySpec }                                  from "@/lib/strategySchema";
import type { EvaluationContext, SignalResult }               from "@/infrastructure/backtest/evaluator";
import { runBacktest, type BacktestTrade }                    from "@/infrastructure/backtest/BacktestEngine";
import { precomputeIndicators, type PrecomputedIndicators }   from "@/infrastructure/backtest/indicators";
import { getSymbolConfig }                                    from "@/infrastructure/backtest/spreadConfig";
import { getLastConfirmedBarIndex, TF_MS }                   from "@/infrastructure/backtest/timeframe";
import { evalMeanReversion }                                  from "@/infrastructure/backtest/phase6a/evaluators";
import { calcMedian }                                         from "@/infrastructure/backtest/phase6a/analysisHelpers";
import { seededRNG }                                          from "@/infrastructure/backtest/phase6b/rawAnalysis";

// ── Constants ──────────────────────────────────────────────────────────

const SB_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL    = "EURUSD";
const PIP       = 0.0001;
const PAGE_SIZE = 1000;
const CFG       = getSymbolConfig(SYMBOL);
const COST_PIPS = CFG.spreadPips + CFG.slippagePips;   // 1.8

// Fixed — Phase 6-D E2 / Phase 6-E/F CONTROL
const H1_SL_MULT       = 3.0;
const H1_TP_MULT       = 4.5;

// Regime definition — Phase 6-G fixed, no variation allowed
const REGIME_LOOKBACK  = 20;   // confirmed H1 bars
const SLOPE_THRESHOLD  = 0.5;  // pips: |EMA200Δ| < threshold → FLAT

// Windows
const DAY_MS           = 86_400_000;
const ROLL_WINDOW_DAYS = 365;  // 12-month rolling
const ROLL_STEP_DAYS   = 183;  // 6-month step

// Sample thresholds
const VALID_N          = 30;
const LOW_N            = 20;

// ── Fetch ──────────────────────────────────────────────────────────────

async function fetchBars(tf: string): Promise<Bar[]> {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const all: { time_utc: string; open: number; high: number; low: number; close: number }[] = [];
  let offset = 0;
  for (;;) {
    const url = `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close&symbol=eq.${SYMBOL}&timeframe=eq.${tf}&order=time_utc.asc&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetch ${tf}: ${res.status}`);
    const rows = (await res.json()) as typeof all;
    rows.forEach(r => { r.open=+r.open; r.high=+r.high; r.low=+r.low; r.close=+r.close; });
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all.map(r => ({
    time: new Date(r.time_utc).getTime(),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: 0,
  }));
}

// ── Regime classification ──────────────────────────────────────────────

type Regime = "UP" | "DOWN" | "FLAT";

function regimeAt(inds: PrecomputedIndicators, idx: number): Regime {
  const now  = inds.ema2[idx];
  const prev = inds.ema2[Math.max(0, idx - REGIME_LOOKBACK)];
  if (now === undefined || prev === undefined) return "FLAT";
  const diff = (now - prev) / PIP;
  if (diff >  SLOPE_THRESHOLD) return "UP";
  if (diff < -SLOPE_THRESHOLD) return "DOWN";
  return "FLAT";
}

// ── Spec helper ─────────────────────────────────────────────────────────

function makeSpec(name: string): StrategySpec {
  return {
    name,
    strategy_type: "DAY_TRADE",
    symbols:    [SYMBOL],
    timeframes: ["H1"],
    entry_conditions: {
      logic: "AND",
      conditions: [{ indicator: "EMA", timeframe: "H1", period: 21, operator: "PRICE_ABOVE" }],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", multiplier: H1_SL_MULT },
      take_profit: { method: "ATR", multiplier: H1_TP_MULT },
    },
    risk: { risk_per_trade: 1.0 },
  };
}

// ── Evaluator overrides ────────────────────────────────────────────────

function makeG1Eval(bars: Bar[], inds: PrecomputedIndicators) {
  return (ctx: EvaluationContext): SignalResult => {
    const idx = getLastConfirmedBarIndex(bars, "H1", ctx.evaluationTime);
    if (idx < REGIME_LOOKBACK) return "SKIP";
    if (regimeAt(inds, idx) !== "DOWN") return "SKIP";
    const sig = evalMeanReversion(bars, inds, idx);
    return sig === "BUY" ? "BUY" : "SKIP";
  };
}

function makeG2Eval(bars: Bar[], inds: PrecomputedIndicators) {
  return (ctx: EvaluationContext): SignalResult => {
    const idx = getLastConfirmedBarIndex(bars, "H1", ctx.evaluationTime);
    if (idx < REGIME_LOOKBACK) return "SKIP";
    if (regimeAt(inds, idx) !== "UP") return "SKIP";
    const sig = evalMeanReversion(bars, inds, idx);
    return sig === "SELL" ? "SELL" : "SKIP";
  };
}

// ── Trade enrichment ──────────────────────────────────────────────────

interface G7Trade extends BacktestTrade {
  mfe:    number;
  mae:    number;
  regime: Regime;
}

function enrichTrades(trades: BacktestTrade[], bars: Bar[], inds: PrecomputedIndicators): G7Trade[] {
  return trades.map(t => {
    const sigIdx = Math.max(0, t.entryBarIdx - 1);
    let mfe = 0, mae = 0;
    const dir = t.direction;
    const ep  = t.entryPrice;
    for (let i = t.entryBarIdx; i <= t.exitBarIdx && i < bars.length; i++) {
      const b = bars[i];
      if (dir === "BUY") {
        const fav = (b.high - ep) / PIP, unf = (b.low - ep) / PIP;
        if (fav > mfe) mfe = fav;
        if (unf < mae) mae = unf;
      } else {
        const fav = (ep - b.low) / PIP, unf = (ep - b.high) / PIP;
        if (fav > mfe) mfe = fav;
        if (unf < mae) mae = unf;
      }
    }
    return { ...t, mfe, mae, regime: regimeAt(inds, sigIdx) };
  });
}

// ── Stats ──────────────────────────────────────────────────────────────

interface Stats {
  n:           number;
  wr:          number;
  pf:          number;
  ppt:         number;
  mfeMed:      number;
  maeMed:      number;
  totalPips:   number;
  sampleClass: "VALID" | "LOW_SAMPLE" | "INSUFFICIENT";
}

const EMPTY_STATS: Stats = {
  n: 0, wr: 0, pf: 0, ppt: 0, mfeMed: 0, maeMed: 0, totalPips: 0, sampleClass: "INSUFFICIENT",
};

function calcPF(trades: { pips: number; result: string }[]): number {
  const cl = trades.filter(t => t.result !== "END_OF_DATA");
  const gw = cl.filter(t => t.result === "WIN").reduce((s, t) => s + t.pips, 0);
  const gl = Math.abs(cl.filter(t => t.result === "LOSS").reduce((s, t) => s + t.pips, 0));
  return gl === 0 ? (gw > 0 ? 999 : 0) : gw / gl;
}

function computeStats(trades: G7Trade[]): Stats {
  const cl = trades.filter(t => t.result !== "END_OF_DATA");
  const n  = cl.length;
  if (n === 0) return EMPTY_STATS;
  const wins = cl.filter(t => t.result === "WIN");
  const tp   = cl.reduce((s, t) => s + t.pips, 0);
  return {
    n,
    wr:         wins.length / n * 100,
    pf:         calcPF(cl),
    ppt:        tp / n,
    mfeMed:     calcMedian(trades.map(t => t.mfe)),
    maeMed:     calcMedian(trades.map(t => t.mae)),
    totalPips:  tp,
    sampleClass: n >= VALID_N ? "VALID" : (n >= LOW_N ? "LOW_SAMPLE" : "INSUFFICIENT"),
  };
}

// ── Market direction ───────────────────────────────────────────────────

function marketDir(bars: Bar[], startMs: number, endMs: number) {
  const w = bars.filter(b => b.time >= startMs && b.time <= endMs);
  if (w.length < 2) return { changePips: 0, dir: "FLAT" as "UP" | "DOWN" | "FLAT" };
  const ch = (w[w.length - 1].close - w[0].close) / PIP;
  return { changePips: ch, dir: (ch > 20 ? "UP" : ch < -20 ? "DOWN" : "FLAT") as "UP" | "DOWN" | "FLAT" };
}

// ── Regime-filtered random control ────────────────────────────────────

interface SimResult { pips: number; result: "WIN" | "LOSS" | "END_OF_DATA" }

function simulateTrade(
  dir: "BUY" | "SELL", entryBarIdx: number, bars: Bar[], inds: PrecomputedIndicators,
  slMult: number, tpMult: number,
): SimResult | null {
  const entryBar = bars[entryBarIdx];
  if (!entryBar) return null;
  const atr = inds.atr[Math.max(0, entryBarIdx - 1)];
  if (atr === undefined) return null;
  const cp    = COST_PIPS * PIP;
  const entry = dir === "BUY" ? entryBar.open + cp : entryBar.open - cp;
  const sl    = dir === "BUY" ? entry - atr * slMult : entry + atr * slMult;
  const tp    = dir === "BUY" ? entry + atr * tpMult : entry - atr * tpMult;

  for (let i = entryBarIdx; i < bars.length; i++) {
    const b = bars[i];
    if (dir === "BUY") {
      if (b.open <= sl) return { pips: (b.open - entry) / PIP, result: "LOSS" };
      if (b.open >= tp) return { pips: (b.open - entry) / PIP, result: "WIN" };
      if (b.low  <= sl) return { pips: (sl - entry)    / PIP, result: "LOSS" };
      if (b.high >= tp) return { pips: (tp - entry)    / PIP, result: "WIN" };
    } else {
      if (b.open >= sl) return { pips: (entry - b.open) / PIP, result: "LOSS" };
      if (b.open <= tp) return { pips: (entry - b.open) / PIP, result: "WIN" };
      if (b.high >= sl) return { pips: (entry - sl)     / PIP, result: "LOSS" };
      if (b.low  <= tp) return { pips: (entry - tp)     / PIP, result: "WIN" };
    }
  }
  const ep2 = bars[bars.length - 1]?.close ?? entry;
  return { pips: dir === "BUY" ? (ep2 - entry) / PIP : (entry - ep2) / PIP, result: "END_OF_DATA" };
}

function regimeRandomControl(
  n: number, dir: "BUY" | "SELL", targetRegime: Regime,
  bars: Bar[], inds: PrecomputedIndicators,
  slMult: number, tpMult: number, seed: number = 42,
): { pf: number; ppt: number } {
  // Build index of bars that belong to target regime (with warmup)
  const validIdx: number[] = [];
  for (let i = REGIME_LOOKBACK + 200; i < bars.length - 50; i++) {
    if (regimeAt(inds, i) === targetRegime) validIdx.push(i + 1); // entry = next bar
  }
  if (validIdx.length === 0) return { pf: 0, ppt: 0 };

  const rng     = seededRNG(seed);
  const results: SimResult[] = [];
  let   attempts = 0;
  while (results.length < n && attempts < n * 10) {
    const ri = Math.floor(rng() * validIdx.length);
    const r  = simulateTrade(dir, validIdx[ri], bars, inds, slMult, tpMult);
    if (r !== null) results.push(r);
    attempts++;
  }
  const cl  = results.filter(r => r.result !== "END_OF_DATA");
  const pf  = calcPF(cl);
  const ppt = cl.length > 0 ? cl.reduce((s, r) => s + r.pips, 0) / cl.length : 0;
  return { pf, ppt };
}

// ── Zero-cost run ──────────────────────────────────────────────────────

function runZeroCost(trades: G7Trade[]): { pf: number; ppt: number } {
  const adj = trades.map(t => {
    const pips = t.result === "WIN"
      ? t.pips + COST_PIPS
      : t.result === "LOSS" ? t.pips - COST_PIPS : t.pips;
    return { ...t, pips };
  });
  const cl  = adj.filter(t => t.result !== "END_OF_DATA");
  const pf  = calcPF(cl);
  const ppt = cl.length > 0 ? cl.reduce((s, t) => s + t.pips, 0) / cl.length : 0;
  return { pf, ppt };
}

// ── Window analysis ────────────────────────────────────────────────────

interface WinResult {
  label:      string;
  startDate:  string;
  endDate:    string;
  stats:      Stats;
  randPF:     number;
  mktChange:  number;
  mktDir:     "UP" | "DOWN" | "FLAT";
  success:    boolean; // PF > 1 AND PF > randPF
}

function windowAnalysis(
  label: string, trades: G7Trade[], bars: Bar[], inds: PrecomputedIndicators,
  startMs: number, endMs: number,
  dir: "BUY" | "SELL", targetRegime: Regime,
): WinResult {
  const w     = trades.filter(t => t.entryTime >= startMs && t.entryTime <= endMs);
  const stats = computeStats(w);
  const mkt   = marketDir(bars, startMs, endMs);
  let   randPF = 0;
  if (stats.n > 0) {
    const barsInWindow = bars.filter(b => b.time >= startMs && b.time <= endMs);
    const indsInWindow: PrecomputedIndicators = {
      ...inds,
      ema1: inds.ema1.slice(
        bars.findIndex(b => b.time >= startMs),
        bars.findIndex(b => b.time > endMs) + 1,
      ),
    };
    // Use full bars for simulation (entry prices outside window may be needed for exits)
    randPF = regimeRandomControl(stats.n, dir, targetRegime, bars, inds, H1_SL_MULT, H1_TP_MULT).pf;
  }
  return {
    label,
    startDate:  new Date(startMs).toISOString().slice(0, 10),
    endDate:    new Date(endMs).toISOString().slice(0, 10),
    stats,
    randPF,
    mktChange:  mkt.changePips,
    mktDir:     mkt.dir,
    success:    stats.pf > 1.0 && stats.pf > randPF && stats.sampleClass !== "INSUFFICIENT",
  };
}

// ── Formatting ─────────────────────────────────────────────────────────

const f2   = (n: number)  => n.toFixed(2);
const f3   = (n: number)  => n.toFixed(3);
const pct  = (n: number)  => n.toFixed(1) + "%";
const EQ   = "═";
const sign = (n: number)  => (n >= 0 ? "+" : "") + f2(n);
const pfS  = (n: number)  => n === 999 ? ">999" : f3(n);
const cls  = (s: Stats)   => s.sampleClass !== "VALID" ? ` [${s.sampleClass}]` : "";

function printWindowRow(w: WinResult): void {
  const sc = w.stats;
  const flag = sc.sampleClass !== "INSUFFICIENT"
    ? (w.success ? " ✓" : "  ")
    : " ~";
  console.log(
    `  ${w.label.padEnd(14)} ` +
    `${w.startDate.slice(2, 10).padEnd(9)} ` +
    `${String(sc.n).padStart(4)} ` +
    `${pfS(sc.pf).padStart(7)} ` +
    `${pfS(w.randPF).padStart(8)} ` +
    `${(sc.pf > 0 ? sign(sc.pf - w.randPF) : "  n/a").padStart(8)} ` +
    `${f2(sc.ppt).padStart(7)} ` +
    `${w.mktDir.padEnd(5)} ${f2(w.mktChange).padStart(8)}pip` +
    `${sc.sampleClass !== "VALID" ? ` [${sc.sampleClass}]` : ""}` +
    flag,
  );
}

// ── Classification ─────────────────────────────────────────────────────

type G7Class =
  | "CONFIRMED_REGIME_EDGE"
  | "PROMISING_BUT_UNCONFIRMED"
  | "REGIME_DEPENDENT_NO_ROBUST_EDGE"
  | "COST_DESTROYED_EDGE"
  | "NO_EDGE"
  | "INCONCLUSIVE";

function classify(
  fullStats: Stats,
  fullRandPF: number,
  zeroCostPF: number,
  successRate: number,
  validWindows: number,
  trueOOS: boolean,
): G7Class {
  if (fullStats.sampleClass === "INSUFFICIENT") return "INCONCLUSIVE";
  const pfOk  = fullStats.pf > 1.0;
  const normOk = zeroCostPF > 1.0 && fullStats.pf > 1.0;
  if (!pfOk && zeroCostPF > 1.0) return "COST_DESTROYED_EDGE";
  if (!pfOk && zeroCostPF <= 1.0) return "NO_EDGE";
  const beatsRand = fullStats.pf > fullRandPF;
  if (!beatsRand) return "NO_EDGE";
  if (successRate >= 0.6 && validWindows >= 2 && trueOOS) return "CONFIRMED_REGIME_EDGE";
  if (pfOk && beatsRand && successRate >= 0.5) return "PROMISING_BUT_UNCONFIRMED";
  if (successRate < 0.4 || validWindows < 2)   return "REGIME_DEPENDENT_NO_ROBUST_EDGE";
  return "PROMISING_BUT_UNCONFIRMED";
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 6-G: REGIME HYPOTHESIS CONFIRMATION" + " ".repeat(29) + "║");
  console.log("║  G1: DOWN_REGIME × H1 MR LONG   G2: UP_REGIME × H1 MR SHORT" + " ".repeat(9) + "║");
  console.log("╚" + EQ.repeat(72) + "╝");

  console.log("\n[AUDIT] Pre-Implementation");
  console.log("  CASE: A — Regime filter via _evaluatorOverride only.");
  console.log("  evalMeanReversion unchanged. BacktestEngine unchanged.");
  console.log("  NOTE: All data was used in Phase 6-F → TRUE UNSEEN DATA: NO");
  console.log("        Maximum classification: PROMISING_BUT_UNCONFIRMED");

  // ── STEP 1: Data ─────────────────────────────────────────────────────
  console.log("\n[STEP 1] Fetching H1 bars...");
  const bars = await fetchBars("H1");
  const inds = precomputeIndicators(bars);
  const t0 = bars[0].time, tN = bars[bars.length - 1].time;
  console.log(`  H1: ${bars.length} bars  ${new Date(t0).toISOString().slice(0,10)} → ${new Date(tN).toISOString().slice(0,10)}`);
  console.log(`  (all data was used in Phase 6-F discovery)`);

  // ── STEP 2: Regime inventory ──────────────────────────────────────────
  console.log("\n[STEP 2] Regime inventory...");
  let upN = 0, downN = 0, flatN = 0;
  for (let i = REGIME_LOOKBACK; i < bars.length; i++) {
    const r = regimeAt(inds, i);
    if (r === "UP") upN++; else if (r === "DOWN") downN++; else flatN++;
  }
  console.log(`  UP:   ${upN} bars (${pct(upN / (upN+downN+flatN) * 100)})`);
  console.log(`  DOWN: ${downN} bars (${pct(downN / (upN+downN+flatN) * 100)})`);
  console.log(`  FLAT: ${flatN} bars`);

  // ── STEP 3: Run G1 (DOWN_REGIME × LONG) ──────────────────────────────
  console.log("\n[STEP 3] Running G1: DOWN_REGIME × H1 MR LONG...");
  const specG1  = makeSpec("Phase6G G1 DOWN×LONG");
  const evalG1  = makeG1Eval(bars, inds);
  const resG1   = runBacktest({
    spec: specG1, symbol: SYMBOL, mainTimeframe: "H1",
    barsByTimeframe: { H1: bars }, _evaluatorOverride: evalG1,
  });
  const g1Trades = enrichTrades(resG1.trades, bars, inds);
  console.log(`  G1: ${resG1.totalTrades} trades`);

  // ── STEP 4: Run G2 (UP_REGIME × SHORT) ───────────────────────────────
  console.log("\n[STEP 4] Running G2: UP_REGIME × H1 MR SHORT...");
  const specG2  = makeSpec("Phase6G G2 UP×SHORT");
  const evalG2  = makeG2Eval(bars, inds);
  const resG2   = runBacktest({
    spec: specG2, symbol: SYMBOL, mainTimeframe: "H1",
    barsByTimeframe: { H1: bars }, _evaluatorOverride: evalG2,
  });
  const g2Trades = enrichTrades(resG2.trades, bars, inds);
  console.log(`  G2: ${resG2.totalTrades} trades`);

  // ── STEP 5: Also run ALL-REGIME MR LONG (baseline control A) ─────────
  console.log("\n[STEP 5] Baseline Control A: ALL_REGIME × H1 MR LONG...");
  const specALL = makeSpec("Phase6G ALL×LONG");
  const evalALL = (ctx: EvaluationContext): SignalResult => {
    const idx = getLastConfirmedBarIndex(bars, "H1", ctx.evaluationTime);
    if (idx < 0) return "SKIP";
    const sig = evalMeanReversion(bars, inds, idx);
    return sig === "BUY" ? "BUY" : "SKIP";
  };
  const resALL  = runBacktest({
    spec: specALL, symbol: SYMBOL, mainTimeframe: "H1",
    barsByTimeframe: { H1: bars }, _evaluatorOverride: evalALL,
  });
  const allTrades = enrichTrades(resALL.trades, bars, inds);
  console.log(`  ALL REGIME MR LONG: ${resALL.totalTrades} trades`);

  // ── STEP 6: FULL PERIOD stats ──────────────────────────────────────────
  console.log("\n" + EQ.repeat(74));
  console.log("[STEP 6] FULL PERIOD STATS");
  console.log(EQ.repeat(74));

  const g1Full    = computeStats(g1Trades);
  const g2Full    = computeStats(g2Trades);
  const allFull   = computeStats(allTrades);
  const g1Rand    = regimeRandomControl(g1Full.n, "BUY",  "DOWN", bars, inds, H1_SL_MULT, H1_TP_MULT);
  const g2Rand    = regimeRandomControl(g2Full.n, "SELL", "UP",   bars, inds, H1_SL_MULT, H1_TP_MULT);
  const g1Zero    = runZeroCost(g1Trades);
  const g2Zero    = runZeroCost(g2Trades);
  const fullMkt   = marketDir(bars, t0, tN);

  console.log(`\n  Market full: ${f2(fullMkt.changePips)} pips (${fullMkt.dir})`);
  console.log(`\n  ${"Strategy".padEnd(22)} ${"N".padStart(5)} ${"WR%".padStart(7)} ${"PF".padStart(8)} ${"PPT".padStart(7)} ${"MFEm".padStart(7)} ${"MAEm".padStart(7)}`);
  console.log("  " + "-".repeat(70));
  const pr = (lbl: string, s: Stats) => console.log(
    `  ${lbl.padEnd(22)} ${String(s.n).padStart(5)} ` +
    `${pct(s.wr).padStart(7)} ${pfS(s.pf).padStart(8)} ` +
    `${f2(s.ppt).padStart(7)} ` +
    `${f2(s.mfeMed).padStart(7)} ${f2(s.maeMed).padStart(7)}` +
    cls(s),
  );
  pr("G1 DOWN×LONG", g1Full);
  pr("G2 UP×SHORT",  g2Full);
  pr("BASELINE ALL×LONG", allFull);

  console.log(`\n  Random Controls (same-regime):`);
  console.log(`  ${"".padEnd(22)} ${"Strat PF".padStart(9)} ${"Rand PF".padStart(9)} ${"Δ".padStart(8)} ${"ZeroCost PF".padStart(13)}`);
  console.log("  " + "-".repeat(66));
  console.log(`  ${"G1 DOWN×LONG".padEnd(22)} ${pfS(g1Full.pf).padStart(9)} ${pfS(g1Rand.pf).padStart(9)} ${sign(g1Full.pf - g1Rand.pf).padStart(8)} ${pfS(g1Zero.pf).padStart(13)}`);
  console.log(`  ${"G2 UP×SHORT".padEnd(22)} ${pfS(g2Full.pf).padStart(9)} ${pfS(g2Rand.pf).padStart(9)} ${sign(g2Full.pf - g2Rand.pf).padStart(8)} ${pfS(g2Zero.pf).padStart(13)}`);

  // ── STEP 7: Discovery vs ALL-REGIME LONG separation ──────────────────
  console.log("\n[STEP 7] Regime Isolation: Does DOWN filter add edge vs ALL_REGIME LONG?");
  console.log(EQ.repeat(74));
  console.log(`  ALL REGIME MR LONG PF:     ${pfS(allFull.pf)}  N=${allFull.n}`);
  console.log(`  DOWN_REGIME MR LONG PF:    ${pfS(g1Full.pf)}  N=${g1Full.n}  (G1)`);
  console.log(`  DOWN_REGIME RANDOM LONG PF:${pfS(g1Rand.pf)}  N=${g1Full.n}`);
  console.log(`\n  G1 vs ALL_REGIME:  ${sign(g1Full.pf - allFull.pf)}`);
  console.log(`  G1 vs RAND:        ${sign(g1Full.pf - g1Rand.pf)}`);
  const regimeAddsEdge = g1Full.pf > allFull.pf && g1Full.pf > g1Rand.pf;
  console.log(`  Regime filter adds edge over ALL_REGIME + RANDOM: ${regimeAddsEdge ? "YES" : "NO"}`);

  // ── STEP 8: Yearly windows ─────────────────────────────────────────────
  console.log("\n[STEP 8] Yearly Windows");
  console.log(EQ.repeat(74));

  const years: Array<{ label: string; start: number; end: number }> = [];
  const startYear = new Date(t0).getUTCFullYear();
  const endYear   = new Date(tN).getUTCFullYear();
  for (let y = startYear; y <= endYear; y++) {
    years.push({
      label: String(y),
      start: new Date(`${y}-01-01T00:00:00Z`).getTime(),
      end:   new Date(`${y}-12-31T23:59:59Z`).getTime(),
    });
  }
  const firstHalfMs = t0 + (tN - t0) / 2;
  years.unshift(
    { label: "FIRST_HALF",  start: t0,         end: firstHalfMs },
    { label: "SECOND_HALF", start: firstHalfMs, end: tN },
  );

  const g1YearWindows: WinResult[] = [];
  const g2YearWindows: WinResult[] = [];

  console.log(`\n  G1 — DOWN_REGIME × MR LONG`);
  console.log(`  ${"Period".padEnd(12)} ${"Start".padEnd(9)} ${"N".padStart(4)} ${"PF".padStart(7)} ${"RandPF".padStart(8)} ${"Δ".padStart(8)} ${"PPT".padStart(7)} ${"MktDir".padStart(6)} ${"Mkt_Δ".padStart(9)}`);
  console.log("  " + "-".repeat(80));
  for (const p of years) {
    const w = windowAnalysis("G1", g1Trades, bars, inds, p.start, p.end, "BUY", "DOWN");
    w.label = p.label;
    g1YearWindows.push(w);
    printWindowRow(w);
  }

  console.log(`\n  G2 — UP_REGIME × MR SHORT`);
  console.log(`  ${"Period".padEnd(12)} ${"Start".padEnd(9)} ${"N".padStart(4)} ${"PF".padStart(7)} ${"RandPF".padStart(8)} ${"Δ".padStart(8)} ${"PPT".padStart(7)} ${"MktDir".padStart(6)} ${"Mkt_Δ".padStart(9)}`);
  console.log("  " + "-".repeat(80));
  for (const p of years) {
    const w = windowAnalysis("G2", g2Trades, bars, inds, p.start, p.end, "SELL", "UP");
    w.label = p.label;
    g2YearWindows.push(w);
    printWindowRow(w);
  }

  // ── STEP 9: Rolling 12-month / 6-month step ──────────────────────────
  console.log("\n[STEP 9] Rolling Windows (12-month window, 6-month step)");
  console.log(EQ.repeat(74));

  const g1Rolling: WinResult[] = [];
  const g2Rolling: WinResult[] = [];
  let rStart = t0;
  let rIdx   = 1;
  while (rStart < tN) {
    const rEnd = Math.min(rStart + ROLL_WINDOW_DAYS * DAY_MS, tN);
    const lbl  = `W${rIdx}`;
    g1Rolling.push(windowAnalysis(lbl, g1Trades, bars, inds, rStart, rEnd, "BUY",  "DOWN"));
    g2Rolling.push(windowAnalysis(lbl, g2Trades, bars, inds, rStart, rEnd, "SELL", "UP"));
    rStart += ROLL_STEP_DAYS * DAY_MS;
    rIdx++;
    if (rEnd >= tN) break;
  }

  console.log(`\n  G1 — DOWN_REGIME × MR LONG`);
  console.log(`  ${"Window".padEnd(12)} ${"Start".padEnd(9)} ${"N".padStart(4)} ${"PF".padStart(7)} ${"RandPF".padStart(8)} ${"Δ".padStart(8)} ${"PPT".padStart(7)} ${"MktDir".padStart(6)} ${"Mkt_Δ".padStart(9)}`);
  console.log("  " + "-".repeat(80));
  for (const w of g1Rolling) printWindowRow(w);

  console.log(`\n  G2 — UP_REGIME × MR SHORT`);
  console.log(`  ${"Window".padEnd(12)} ${"Start".padEnd(9)} ${"N".padStart(4)} ${"PF".padStart(7)} ${"RandPF".padStart(8)} ${"Δ".padStart(8)} ${"PPT".padStart(7)} ${"MktDir".padStart(6)} ${"Mkt_Δ".padStart(9)}`);
  console.log("  " + "-".repeat(80));
  for (const w of g2Rolling) printWindowRow(w);

  // ── STEP 10: Temporal consistency stats ──────────────────────────────
  console.log("\n[STEP 10] Temporal Consistency");
  console.log(EQ.repeat(74));

  const consistency = (windows: WinResult[], label: string) => {
    const valid   = windows.filter(w => w.stats.sampleClass !== "INSUFFICIENT");
    const success = valid.filter(w => w.success);
    const pfs     = valid.map(w => w.stats.pf).sort((a, b) => a - b);
    console.log(`\n  ${label}:`);
    console.log(`    Valid windows: ${valid.length}/${windows.length}`);
    if (valid.length === 0) { console.log("    INSUFFICIENT data for consistency"); return; }
    console.log(`    Successful (PF>1 AND PF>rand): ${success.length}/${valid.length} = ${pct(success.length / valid.length * 100)}`);
    console.log(`    PF>1 windows: ${valid.filter(w => w.stats.pf > 1).length}/${valid.length}`);
    console.log(`    Median PF:  ${pfS(calcMedian(pfs))}`);
    console.log(`    Worst PF:   ${pfS(pfs[0])}`);
    console.log(`    Best PF:    ${pfS(pfs[pfs.length - 1])}`);
    console.log(`    Market UP periods:   G1 success ${valid.filter(w=>w.mktDir==="UP"   && w.success).length}/${valid.filter(w=>w.mktDir==="UP").length}`);
    console.log(`    Market DOWN periods: G1 success ${valid.filter(w=>w.mktDir==="DOWN" && w.success).length}/${valid.filter(w=>w.mktDir==="DOWN").length}`);
  };
  consistency(g1Rolling, "G1 Rolling Windows");
  consistency(g2Rolling, "G2 Rolling Windows");

  // ── STEP 11: Classification ────────────────────────────────────────────
  console.log("\n[STEP 11] Classification");
  console.log(EQ.repeat(74));

  const g1ValidW    = g1Rolling.filter(w => w.stats.sampleClass !== "INSUFFICIENT");
  const g2ValidW    = g2Rolling.filter(w => w.stats.sampleClass !== "INSUFFICIENT");
  const g1SuccRate  = g1ValidW.length > 0 ? g1ValidW.filter(w => w.success).length / g1ValidW.length : 0;
  const g2SuccRate  = g2ValidW.length > 0 ? g2ValidW.filter(w => w.success).length / g2ValidW.length : 0;

  const TRUE_OOS = false; // all data used in Phase 6-F

  const g1Class = classify(g1Full, g1Rand.pf, g1Zero.pf, g1SuccRate, g1ValidW.length, TRUE_OOS);
  const g2Class = classify(g2Full, g2Rand.pf, g2Zero.pf, g2SuccRate, g2ValidW.length, TRUE_OOS);

  console.log(`\n  G1 Classification: ${g1Class}`);
  console.log(`  G2 Classification: ${g2Class}`);

  // ── FINAL REPORT ──────────────────────────────────────────────────────

  const g1RollingPFs = g1ValidW.map(w => w.stats.pf).sort((a, b) => a - b);
  const g2RollingPFs = g2ValidW.map(w => w.stats.pf).sort((a, b) => a - b);

  const nextStep = (() => {
    if (g1Class === "CONFIRMED_REGIME_EDGE")              return "Phase 6-H: Robustness Validation (Walk Forward, Monte Carlo)";
    if (g1Class === "PROMISING_BUT_UNCONFIRMED")          return "Acquire new unseen H1 data for True OOS Confirmation";
    if (g1Class === "REGIME_DEPENDENT_NO_ROBUST_EDGE")    return "Hypothesis terminated. Design new hypothesis.";
    if (g1Class === "COST_DESTROYED_EDGE")                return "Re-design execution structure in new hypothesis (no post-hoc adjustment).";
    if (g1Class === "NO_EDGE")                            return "H1 MEAN_REVERSION direction hypothesis terminated.";
    return "Collect more data (INCONCLUSIVE).";
  })();

  console.log("\n╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 6-G FINAL REPORT" + " ".repeat(49) + "║");
  console.log("╠" + EQ.repeat(72) + "╣");
  const L = (lbl: string, val: string) => {
    const c = `  ${lbl.padEnd(40)} ${val}`;
    console.log(`║${c.padEnd(72)}║`);
  };
  L("PHASE 6-G:", "COMPLETE");
  L("TRUE UNSEEN DATA:", "NO — all data used in Phase 6-F discovery");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("HYPOTHESIS G1:", "DOWN_REGIME × H1 MEAN_REVERSION LONG");
  L("DISCOVERY PF (Phase 6-F):", "1.350");
  L("CONFIRMATION PF:", pfS(g1Full.pf) + `  N=${g1Full.n}`);
  L("RANDOM REGIME PF:", pfS(g1Rand.pf));
  L("ZERO COST PF:", pfS(g1Zero.pf));
  L("NORMAL COST PF:", pfS(g1Full.pf));
  L("VALID ROLLING WINDOWS:", String(g1ValidW.length) + "/" + String(g1Rolling.length));
  L("SUCCESSFUL WINDOWS:", `${g1ValidW.filter(w => w.success).length}/${g1ValidW.length} (PF>1 AND PF>rand)`);
  L("SUCCESS RATE:", pct(g1SuccRate * 100));
  L("MEDIAN WINDOW PF:", g1RollingPFs.length > 0 ? pfS(calcMedian(g1RollingPFs)) : "N/A");
  L("WORST WINDOW PF:", g1RollingPFs.length > 0 ? pfS(g1RollingPFs[0])                   : "N/A");
  L("BEST WINDOW PF:", g1RollingPFs.length > 0 ? pfS(g1RollingPFs[g1RollingPFs.length-1]): "N/A");
  L("G1 CLASSIFICATION:", g1Class);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("HYPOTHESIS G2:", "UP_REGIME × H1 MEAN_REVERSION SHORT");
  L("CONFIRMATION PF:", pfS(g2Full.pf) + `  N=${g2Full.n}`);
  L("RANDOM REGIME PF:", pfS(g2Rand.pf));
  L("ZERO COST PF:", pfS(g2Zero.pf));
  L("VALID ROLLING WINDOWS:", String(g2ValidW.length) + "/" + String(g2Rolling.length));
  L("SUCCESSFUL WINDOWS:", `${g2ValidW.filter(w => w.success).length}/${g2ValidW.length}`);
  L("SUCCESS RATE:", pct(g2SuccRate * 100));
  L("MEDIAN WINDOW PF:", g2RollingPFs.length > 0 ? pfS(calcMedian(g2RollingPFs)) : "N/A");
  L("G2 CLASSIFICATION:", g2Class);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("BASELINE ALL_REGIME MR LONG PF:", pfS(allFull.pf) + `  N=${allFull.n}`);
  L("G1 vs BASELINE DELTA:", sign(g1Full.pf - allFull.pf));
  L("REGIME FILTER ADDS EDGE:", regimeAddsEdge ? "YES" : "NO");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("DATA LEAKAGE:", "NONE");
  L("LOOK-AHEAD SAFETY:", "PASS");
  L("ENGINE FILES CHANGED:", "NO");
  L("PRODUCTION DEFAULTS CHANGED:", "NO");
  L("PRODUCTION STRATEGY CREATED:", "NO");
  L("LIVE TRADING:", "NOT ENABLED");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("NEXT:", nextStep);
  console.log("╚" + EQ.repeat(72) + "╝");
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });

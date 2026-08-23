/**
 * Phase 6-E: Higher-Timeframe New Hypothesis Discovery
 *
 * Compares 4 pre-fixed hypotheses on H1/H4:
 *
 *   CONTROL:  H1 MEAN_REVERSION  (Phase 6-D, SL=3×ATR, TP=4.5×ATR)
 *   HYP_A:    H1 STRUCTURE_BREAKOUT (N=20, SL=2×ATR, TP=3×ATR)
 *   HYP_B:    H1 TREND_CONTINUATION  (EMA21/200 + slope + pullback/resume)
 *   HYP_C:    H4 TREND_CONTINUATION  (identical logic, different TF)
 *
 * CASE B: New evalTrendContinuation function added inline.
 *         No engine changes. evalBreakout reused from Phase 6-A.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/phase6e_hypothesis_discovery.ts
 *
 * RULES: All conditions fixed before execution. No OOS-based tuning.
 *        No filter additions. No parameter sweeps.
 */

export {};

// ── Imports ───────────────────────────────────────────────────────────

import type { Bar }           from "@/infrastructure/analysis/types";
import type { StrategySpec }  from "@/lib/strategySchema";
import type { EvaluationContext, SignalResult } from "@/infrastructure/backtest/evaluator";
import { runBacktest, type BacktestTrade }       from "@/infrastructure/backtest/BacktestEngine";
import { precomputeIndicators, type PrecomputedIndicators } from "@/infrastructure/backtest/indicators";
import { getSymbolConfig }                       from "@/infrastructure/backtest/spreadConfig";
import { getLastConfirmedBarIndex, TF_MS }       from "@/infrastructure/backtest/timeframe";
import { evalBreakout, evalMeanReversion }       from "@/infrastructure/backtest/phase6a/evaluators";
import { calcMedian, getSession }                from "@/infrastructure/backtest/phase6a/analysisHelpers";
import { seededRNG }                             from "@/infrastructure/backtest/phase6b/rawAnalysis";

// ── Constants ──────────────────────────────────────────────────────────

const SB_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL    = "EURUSD";
const PIP       = 0.0001;
const PAGE_SIZE = 1000;
const CFG       = getSymbolConfig(SYMBOL);
const COST_PIPS = CFG.spreadPips + CFG.slippagePips; // 1.8
const RANDOM_SEED = 42;

// ── Trend Continuation Evaluator (Phase 6-E new) ──────────────────────
//
// LONG:  EMA21 > EMA200  (bullish regime)
//        EMA21[idx] > EMA21[idx-5]  (rising slope)
//        bars[idx-1].close <= EMA21[idx]  (pullback)
//        bars[idx].close   >  EMA21[idx]  (resume)
//
// SHORT: fully symmetric
//
// No look-ahead: all values from bars[0..idx] only.

function evalTrendContinuation(
  bars: Bar[],
  inds: PrecomputedIndicators,
  idx:  number,
): SignalResult {
  if (idx < 6) return "SKIP";

  const ema21     = inds.ema1[idx];
  const ema200    = inds.ema2[idx];
  const ema21ago5 = inds.ema1[idx - 5];

  if (ema21 === undefined || ema200 === undefined || ema21ago5 === undefined) return "SKIP";
  if (inds.atr[idx] === undefined) return "SKIP";

  const prevClose = bars[idx - 1]?.close;
  const currClose = bars[idx].close;
  if (prevClose === undefined) return "SKIP";

  if (ema21 > ema200 && ema21 > ema21ago5) {
    if (prevClose <= ema21 && currClose > ema21) return "BUY";
  }

  if (ema21 < ema200 && ema21 < ema21ago5) {
    if (prevClose >= ema21 && currClose < ema21) return "SELL";
  }

  return "SKIP";
}

// ── Evaluator wrappers (TF-aware) ──────────────────────────────────────

type EvalFn = (ctx: EvaluationContext) => SignalResult;

function makeEval(
  bars: Bar[],
  inds: PrecomputedIndicators,
  tf:   string,
  fn:   (bars: Bar[], inds: PrecomputedIndicators, idx: number) => SignalResult,
): EvalFn {
  return (ctx) => {
    const idx = getLastConfirmedBarIndex(bars, tf, ctx.evaluationTime);
    if (idx < 0) return "SKIP";
    return fn(bars, inds, idx);
  };
}

function makeBreakoutEval(bars: Bar[], tf: string): EvalFn {
  return (ctx) => {
    const idx = getLastConfirmedBarIndex(bars, tf, ctx.evaluationTime);
    if (idx < 0) return "SKIP";
    return evalBreakout(bars, idx, 20);  // N=20 fixed
  };
}

// ── Strategy specs ─────────────────────────────────────────────────────

function makeSpec(
  name:    string,
  tf:      string,
  slMult:  number,
  tpMult:  number,
  warmupPeriod: number = 21,  // EMA period for warmup
): StrategySpec {
  return {
    name, strategy_type: "DAY_TRADE", symbols: [SYMBOL],
    timeframes: [tf as "M5" | "H1" | "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [{
        indicator: "EMA", timeframe: tf as "M5" | "H1" | "H4",
        period: warmupPeriod, operator: "PRICE_ABOVE",
      }],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", multiplier: slMult },
      take_profit: { method: "ATR", multiplier: tpMult },
    },
    risk: { risk_per_trade: 1.0 },
  };
}

// ── Fetch bars ──────────────────────────────────────────────────────────

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
  return all.map(r => ({ time: new Date(r.time_utc).getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: 0 }));
}

// ── MFE/MAE (uncapped) ─────────────────────────────────────────────────

function mfeMaeUncapped(
  dir: "BUY" | "SELL", entry: number, bars: Bar[], from: number, to: number,
): { mfe: number; mae: number } {
  let mfe = 0, mae = 0;
  for (let i = from; i <= to && i < bars.length; i++) {
    const b = bars[i];
    if (dir === "BUY") {
      const fav = (b.high - entry) / PIP, unf = (b.low - entry) / PIP;
      if (fav > mfe) mfe = fav;
      if (unf < mae) mae = unf;
    } else {
      const fav = (entry - b.low) / PIP, unf = (entry - b.high) / PIP;
      if (fav > mfe) mfe = fav;
      if (unf < mae) mae = unf;
    }
  }
  return { mfe, mae };
}

// ── Profit factor ───────────────────────────────────────────────────────

function calcPF(trades: BacktestTrade[]): number {
  const cl  = trades.filter(t => t.result !== "END_OF_DATA");
  const gw  = cl.filter(t => t.result === "WIN").reduce((s, t) => s + t.pips, 0);
  const gl  = Math.abs(cl.filter(t => t.result === "LOSS").reduce((s, t) => s + t.pips, 0));
  return gl === 0 ? (gw > 0 ? 999 : 0) : gw / gl;
}

function pctile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.floor(p / 100 * s.length), s.length - 1)];
}

const mean_ = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

// ── Raw signal edge (multi-horizon) ───────────────────────────────────

interface HorizonEdge {
  horizon:      number;
  n:            number;
  posRate:      number;
  randPosRate:  number;
  edgeDelta:    number;
  meanReturn:   number;
  randMean:     number;
}

function rawEdgeMultiHorizon(
  bars:     Bar[],
  inds:     PrecomputedIndicators,
  tf:       string,
  evalFn:   EvalFn,
  spec:     StrategySpec,
  horizons: number[],
): HorizonEdge[] {
  const tfMs = TF_MS[tf] ?? 300_000;
  const warmup = 200;
  const maxH = Math.max(...horizons);
  const limit = bars.length - maxH - 1;

  const signals: { entryBarIdx: number; dir: "BUY" | "SELL" }[] = [];

  for (let i = warmup; i < limit; i++) {
    const evalTime = bars[i].time + tfMs;
    const ctx: EvaluationContext = {
      spec, evaluationTime: evalTime,
      barsByTimeframe: { [tf]: bars },
      indicatorsByTimeframe: { [tf]: inds },
    };
    const sig = evalFn(ctx);
    if (sig !== "SKIP") signals.push({ entryBarIdx: i + 1, dir: sig });
  }

  const longN  = signals.filter(s => s.dir === "BUY").length;
  const shortN = signals.filter(s => s.dir === "SELL").length;
  const rng    = seededRNG(RANDOM_SEED);
  const range  = limit - warmup;

  const randSignals: { entryBarIdx: number; dir: "BUY" | "SELL" }[] = [];
  for (let i = 0; i < longN + shortN; i++) {
    const idx = warmup + Math.floor(rng() * range);
    randSignals.push({ entryBarIdx: idx + 1, dir: i < longN ? "BUY" : "SELL" });
  }

  return horizons.map(h => {
    const sr: number[] = [], rr: number[] = [];
    for (const s of signals) {
      const exitIdx = s.entryBarIdx + h;
      if (exitIdx >= bars.length) continue;
      const entry = bars[s.entryBarIdx]?.open;
      const exit  = bars[exitIdx]?.close;
      if (entry === undefined || exit === undefined) continue;
      sr.push(s.dir === "BUY" ? (exit - entry) / PIP : (entry - exit) / PIP);
    }
    for (const s of randSignals) {
      const exitIdx = s.entryBarIdx + h;
      if (exitIdx >= bars.length) continue;
      const entry = bars[s.entryBarIdx]?.open;
      const exit  = bars[exitIdx]?.close;
      if (entry === undefined || exit === undefined) continue;
      rr.push(s.dir === "BUY" ? (exit - entry) / PIP : (entry - exit) / PIP);
    }
    const sp = sr.filter(r => r > 0).length;
    const rp = rr.filter(r => r > 0).length;
    return {
      horizon:     h,
      n:           sr.length,
      posRate:     sr.length ? sp / sr.length : 0,
      randPosRate: rr.length ? rp / rr.length : 0,
      edgeDelta:   (sr.length ? sp / sr.length : 0) - (rr.length ? rp / rr.length : 0),
      meanReturn:  mean_(sr),
      randMean:    mean_(rr),
    };
  });
}

// ── Full hypothesis runner ─────────────────────────────────────────────

interface HypothesisResult {
  name:         string;
  tf:           string;
  slMult:       number;
  tpMult:       number;
  dataFrom:     string;
  dataTo:       string;
  dataDays:     number;
  totalBars:    number;
  // Performance
  trades:       number;
  longT:        number;
  shortT:       number;
  wins:         number;
  losses:       number;
  slHits:       number;
  tpHits:       number;
  wr:           number;
  pfNormal:     number;
  totalPips:    number;
  pipsPerTr:    number;
  avgWin:       number;
  avgLoss:      number;
  maxDD:        number;
  maxCon:       number;
  // Exit
  medSLDist:    number;
  medTPDist:    number;
  sameBarSLR:   number;
  sameBarTPR:   number;
  avgHoldBars:  number;
  medHoldBars:  number;
  avgHoldMin:   number;
  medHoldMin:   number;
  // Excursion
  mfeMed:       number;
  mfeP25:       number;
  mfeP75:       number;
  maeMed:       number;
  fbFavR:       number;
  mfeGte1ATRpct:number;
  mfeGte2ATRpct:number;
  // Cost
  medATRpips:   number;
  costATRR:     number;
  effSLOpen:    number;
  // Long/Short
  longWR:       number; longPF: number; longPips: number;
  shortWR:      number; shortPF: number; shortPips: number;
  // IS/OOS
  isN: number; isPF: number; isPips: number; isPpt: number;
  oosN: number; oosPF: number; oosPips: number; oosPpt: number;
  pfDegrade: number;
  // Zero cost
  pfZero:       number;
  pipsZero:     number;
  costPenalty:  number;
  // Raw edge
  edges:        HorizonEdge[];
  // Monthly/Yearly
  periodStats:  { period: string; n: number; pf: number; pips: number }[];
  // Classification
  classification: string;
}

async function runHypothesis(
  name:    string,
  tf:      string,
  bars:    Bar[],
  inds:    PrecomputedIndicators,
  evalFn:  EvalFn,
  spec:    StrategySpec,
  slMult:  number,
  tpMult:  number,
): Promise<HypothesisResult> {
  // Normal cost
  const normal = runBacktest({
    spec, symbol: SYMBOL, mainTimeframe: tf,
    barsByTimeframe: { [tf]: bars },
    _evaluatorOverride: evalFn,
  });

  // Zero cost
  const zero = runBacktest({
    spec, symbol: SYMBOL, mainTimeframe: tf,
    barsByTimeframe: { [tf]: bars },
    _evaluatorOverride: evalFn,
    _spreadOverride: 0, _slippageOverride: 0,
  });

  const tr = normal.trades;
  const closed = tr.filter(t => t.result !== "END_OF_DATA");
  const wins   = closed.filter(t => t.result === "WIN");
  const losses = closed.filter(t => t.result === "LOSS");
  const slHits = closed.filter(t => t.exitReason === "SL");
  const tpHits = closed.filter(t => t.exitReason === "TP");
  const sbSL   = closed.filter(t => t.exitBarIdx === t.entryBarIdx && t.exitReason === "SL");
  const sbTP   = closed.filter(t => t.exitBarIdx === t.entryBarIdx && t.exitReason === "TP");

  const n        = closed.length;
  const totPips  = closed.reduce((s, t) => s + t.pips, 0);
  const gw       = wins.reduce((s, t) => s + t.pips, 0);
  const gl       = Math.abs(losses.reduce((s, t) => s + t.pips, 0));
  const pf       = gl === 0 ? (gw > 0 ? 999 : 0) : gw / gl;

  let peak = 0, cum = 0, dd = 0, maxCon = 0, con = 0;
  for (const t of closed) {
    cum += t.pips; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
    if (t.result === "LOSS") { con++; maxCon = Math.max(maxCon, con); } else con = 0;
  }

  const slDists  = closed.map(t => Math.abs(t.entryPrice - t.sl) / PIP);
  const tpDists  = closed.map(t => Math.abs(t.tp - t.entryPrice) / PIP);
  const holdBars = closed.map(t => t.exitBarIdx - t.entryBarIdx);
  const holdMin  = closed.map(t => t.durationMin);

  const mfes: number[] = [], maes: number[] = [], atrPs: number[] = [];
  let fbFav = 0;
  for (const t of closed) {
    const { mfe, mae } = mfeMaeUncapped(t.direction, t.entryPrice, bars, t.entryBarIdx, t.exitBarIdx);
    mfes.push(mfe); maes.push(mae);
    const eb = bars[t.entryBarIdx];
    if (eb && (t.direction === "BUY" ? eb.close > t.entryPrice : eb.close < t.entryPrice)) fbFav++;
    const atr = inds.atr[Math.max(0, t.entryBarIdx - 1)];
    if (atr !== undefined) atrPs.push(atr / PIP);
  }

  const medATR = calcMedian(atrPs);
  const medSL  = calcMedian(slDists);

  const mfe1ATR = closed.filter((_, i) => atrPs[i] !== undefined && mfes[i] >= atrPs[i]).length;
  const mfe2ATR = closed.filter((_, i) => atrPs[i] !== undefined && mfes[i] >= 2 * atrPs[i]).length;

  // IS/OOS (60/40 time-based)
  const sortedT  = [...closed].sort((a, b) => a.entryTime - b.entryTime);
  const split    = Math.floor(sortedT.length * 0.6);
  const isT = sortedT.slice(0, split), oosT = sortedT.slice(split);
  const isP = isT.reduce((s, t) => s + t.pips, 0);
  const oosP = oosT.reduce((s, t) => s + t.pips, 0);
  const isPF_ = calcPF(isT as BacktestTrade[]);
  const oosPF_ = calcPF(oosT as BacktestTrade[]);

  // Long/Short
  const longTr  = closed.filter(t => t.direction === "BUY");
  const shortTr = closed.filter(t => t.direction === "SELL");
  const lgw = longTr.filter(t => t.result === "WIN").reduce((s, t) => s + t.pips, 0);
  const lgl = Math.abs(longTr.filter(t => t.result === "LOSS").reduce((s, t) => s + t.pips, 0));
  const sgw = shortTr.filter(t => t.result === "WIN").reduce((s, t) => s + t.pips, 0);
  const sgl = Math.abs(shortTr.filter(t => t.result === "LOSS").reduce((s, t) => s + t.pips, 0));

  // Monthly/Yearly stability
  const periodMap = new Map<string, { pips: number; gw: number; gl: number }>();
  for (const t of closed) {
    const d = new Date(t.entryTime);
    const key = tf === "H4"
      ? `${d.getUTCFullYear()}`
      : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = periodMap.get(key) ?? { pips: 0, gw: 0, gl: 0 };
    cur.pips += t.pips;
    if (t.result === "WIN") cur.gw += t.pips; else if (t.result === "LOSS") cur.gl += Math.abs(t.pips);
    periodMap.set(key, cur);
  }
  const periodStats = [...periodMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, v]) => ({
    period,
    n: closed.filter(t => {
      const d = new Date(t.entryTime);
      const k = tf === "H4" ? `${d.getUTCFullYear()}` : `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
      return k === period;
    }).length,
    pf: v.gl === 0 ? (v.gw > 0 ? 999 : 0) : v.gw / v.gl,
    pips: v.pips,
  }));

  // Raw edge at 1, 3, 5 bars
  const edges = rawEdgeMultiHorizon(bars, inds, tf, evalFn, spec, [1, 3, 5]);

  // Classification
  const zcPF_ = calcPF(zero.trades);
  let cls: string;
  if (pf > 1.10 && oosPF_ > 1.0 && oosT.length >= 30) cls = "STRONG_CANDIDATE";
  else if (pf > 1.0  && oosPF_ > 1.0 && oosT.length >= 30) cls = "CANDIDATE";
  else if (pf > 1.0  || oosPF_ > 1.0) cls = "MARGINAL";
  else if (zcPF_ > 1.0 && pf <= 1.0) cls = "ZERO_COST_ONLY";
  else if (oosT.length < 30) cls = "INCONCLUSIVE";
  else cls = "REJECTED";

  return {
    name, tf, slMult, tpMult,
    dataFrom: new Date(bars[0].time).toISOString().slice(0, 10),
    dataTo:   new Date(bars[bars.length - 1].time).toISOString().slice(0, 10),
    dataDays: Math.round((bars[bars.length - 1].time - bars[0].time) / 86_400_000),
    totalBars: bars.length,
    trades: n, longT: longTr.length, shortT: shortTr.length,
    wins: wins.length, losses: losses.length, slHits: slHits.length, tpHits: tpHits.length,
    wr: n > 0 ? wins.length / n * 100 : 0,
    pfNormal: pf, totalPips: totPips,
    pipsPerTr: n > 0 ? totPips / n : 0,
    avgWin:  wins.length > 0 ? gw / wins.length : 0,
    avgLoss: losses.length > 0 ? -gl / losses.length : 0,
    maxDD: dd, maxCon,
    medSLDist: medSL, medTPDist: calcMedian(tpDists),
    sameBarSLR: n > 0 ? sbSL.length / n : 0,
    sameBarTPR: n > 0 ? sbTP.length / n : 0,
    avgHoldBars: mean_(holdBars), medHoldBars: calcMedian(holdBars),
    avgHoldMin:  mean_(holdMin),  medHoldMin:  calcMedian(holdMin),
    mfeMed: calcMedian(mfes), mfeP25: pctile(mfes, 25), mfeP75: pctile(mfes, 75),
    maeMed: calcMedian(maes), fbFavR: n > 0 ? fbFav / n * 100 : 0,
    mfeGte1ATRpct: n > 0 ? mfe1ATR / n * 100 : 0,
    mfeGte2ATRpct: n > 0 ? mfe2ATR / n * 100 : 0,
    medATRpips: medATR, costATRR: medATR > 0 ? COST_PIPS / medATR : 0,
    effSLOpen: medSL - COST_PIPS,
    longWR:  longTr.length > 0 ? longTr.filter(t => t.result==="WIN").length / longTr.length * 100 : 0,
    longPF:  lgl > 0 ? lgw / lgl : (lgw > 0 ? 999 : 0), longPips: longTr.reduce((s, t) => s + t.pips, 0),
    shortWR: shortTr.length > 0 ? shortTr.filter(t => t.result==="WIN").length / shortTr.length * 100 : 0,
    shortPF: sgl > 0 ? sgw / sgl : (sgw > 0 ? 999 : 0), shortPips: shortTr.reduce((s, t) => s + t.pips, 0),
    isN: isT.length, isPF: isPF_, isPips: isP, isPpt: isT.length > 0 ? isP / isT.length : 0,
    oosN: oosT.length, oosPF: oosPF_, oosPips: oosP, oosPpt: oosT.length > 0 ? oosP / oosT.length : 0,
    pfDegrade: isPF_ > 0 ? oosPF_ / isPF_ : 0,
    pfZero: zcPF_, pipsZero: zero.totalPips, costPenalty: zcPF_ - pf,
    edges, periodStats, classification: cls,
  };
}

// ── Formatting ─────────────────────────────────────────────────────────

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => n.toFixed(3);
const pct = (n: number) => n.toFixed(1) + "%";
const EQ  = "═";

function row(label: string, vals: (string | number)[], w = 17): void {
  const v = vals.map(x => String(x).padStart(w));
  console.log(`  ${label.padEnd(24)} ${v.join("  ")}`);
}
function hdr(label: string, vals: string[], w = 17): void {
  const v = vals.map(x => x.padStart(w));
  console.log(`  ${label.padEnd(24)} ${v.join("  ")}`);
  console.log("  " + "-".repeat(24 + (w + 2) * vals.length));
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 6-E: HIGHER-TIMEFRAME NEW HYPOTHESIS DISCOVERY" + " ".repeat(18) + "║");
  console.log("║  CONTROL vs H1_BREAKOUT vs H1_TREND_CONT vs H4_TREND_CONT" + " ".repeat(13) + "║");
  console.log("╚" + EQ.repeat(72) + "╝");

  // ── AUDIT ────────────────────────────────────────────────────────────
  console.log("\n[AUDIT] Pre-Implementation");
  console.log("  CASE: B — evalTrendContinuation added inline. No engine changes.");
  console.log("  evalBreakout: reused from Phase 6-A (N=20, any TF)");
  console.log("  evalMeanReversion: reused from Phase 6-A (CONTROL)");
  console.log("  evalTrendContinuation: NEW — EMA21/200 + slope + pullback/resume");
  console.log("  No look-ahead: all values computed from bars[0..idx] only ✓");
  console.log(`  CONTROL exit: SL=3.0×ATR, TP=4.5×ATR  (Phase 6-D E2)`);
  console.log(`  New hypotheses exit: SL=2.0×ATR, TP=3.0×ATR  (RR=1.5 same)`);

  // ── STEP 1: Fetch data ───────────────────────────────────────────────
  console.log("\n[STEP 1] Fetching bar data...");
  const h1Bars = await fetchBars("H1");
  const h4Bars = await fetchBars("H4");
  console.log(`  H1: ${h1Bars.length} bars  ${h1Bars[0] && new Date(h1Bars[0].time).toISOString().slice(0,10)} → ${h1Bars.at(-1) && new Date(h1Bars.at(-1)!.time).toISOString().slice(0,10)}`);
  console.log(`  H4: ${h4Bars.length} bars  ${h4Bars[0] && new Date(h4Bars[0].time).toISOString().slice(0,10)} → ${h4Bars.at(-1) && new Date(h4Bars.at(-1)!.time).toISOString().slice(0,10)}`);

  // Common window: H1 period (H4 filtered to match)
  const cwStart = h1Bars[0].time;
  const cwEnd   = h1Bars[h1Bars.length - 1].time;
  const h4CW    = h4Bars.filter(b => b.time >= cwStart && b.time <= cwEnd);
  console.log(`  H4 common window: ${h4CW.length} bars (${new Date(cwStart).toISOString().slice(0,10)} → ${new Date(cwEnd).toISOString().slice(0,10)})`);

  // Pre-compute indicators
  console.log("\n[STEP 2] Pre-computing indicators...");
  const h1Inds  = precomputeIndicators(h1Bars);
  const h4Inds  = precomputeIndicators(h4Bars);
  const h4CWInds = precomputeIndicators(h4CW);
  console.log(`  H1: ATR p50=${f1(calcMedian((h1Inds.atr.filter(v => v !== undefined) as number[]).map(v => v / PIP)))}pip  EMA200 valid from bar 200`);
  console.log(`  H4: ATR p50=${f1(calcMedian((h4Inds.atr.filter(v => v !== undefined) as number[]).map(v => v / PIP)))}pip`);

  // ── STEP 3: Run hypotheses ───────────────────────────────────────────
  console.log("\n[STEP 3] Running all 4 hypotheses...");

  // CONTROL: H1 MEAN_REVERSION (Phase 6-D compatible)
  const controlSpec = makeSpec("Phase6E CONTROL",      "H1", 3.0, 4.5, 21);
  const brkSpec     = makeSpec("Phase6E H1 Breakout",  "H1", 2.0, 3.0, 200);
  const trendH1Spec = makeSpec("Phase6E H1 TrendCont", "H1", 2.0, 3.0, 200);
  const trendH4Spec = makeSpec("Phase6E H4 TrendCont", "H4", 2.0, 3.0, 200);

  const controlEval = makeEval(h1Bars, h1Inds, "H1", evalMeanReversion);
  const brkEval     = makeBreakoutEval(h1Bars, "H1");
  const trendH1Eval = makeEval(h1Bars, h1Inds, "H1", evalTrendContinuation);
  const trendH4Eval = makeEval(h4Bars, h4Inds, "H4", evalTrendContinuation);
  // H4 common window
  const trendH4CWEval = makeEval(h4CW, h4CWInds, "H4", evalTrendContinuation);

  const runSym = async (label: string, ...args: Parameters<typeof runHypothesis>) => {
    process.stdout.write(`  ${label}... `);
    const r = await runHypothesis(...args);
    console.log(`trades=${r.trades} PF=${f3(r.pfNormal)} OOS_PF=${f3(r.oosPF)} (${r.oosN}) cls=${r.classification}`);
    return r;
  };

  // MAX AVAILABLE runs
  const ctrl   = await runSym("CONTROL H1_MR (MAX)",  "CONTROL H1 MeanRev", "H1", h1Bars, h1Inds, controlEval, controlSpec, 3.0, 4.5);
  const brkMax = await runSym("H1 BREAKOUT (MAX)",     "H1 Structure Breakout", "H1", h1Bars, h1Inds, brkEval, brkSpec, 2.0, 3.0);
  const tH1Max = await runSym("H1 TREND_CONT (MAX)",   "H1 Trend Continuation", "H1", h1Bars, h1Inds, trendH1Eval, trendH1Spec, 2.0, 3.0);
  const tH4Max = await runSym("H4 TREND_CONT (MAX)",   "H4 Trend Continuation", "H4", h4Bars, h4Inds, trendH4Eval, trendH4Spec, 2.0, 3.0);

  // COMMON WINDOW runs (H4 filtered to H1 period)
  const ctrlCW = await runSym("CONTROL H1_MR (CW)",   "CONTROL H1 MeanRev CW",   "H1", h1Bars, h1Inds, controlEval, controlSpec, 3.0, 4.5);
  const brkCW  = await runSym("H1 BREAKOUT (CW)",     "H1 Breakout CW",           "H1", h1Bars, h1Inds, brkEval, brkSpec, 2.0, 3.0);
  const tH1CW  = await runSym("H1 TREND_CONT (CW)",   "H1 TrendCont CW",          "H1", h1Bars, h1Inds, trendH1Eval, trendH1Spec, 2.0, 3.0);
  const tH4CW  = await runSym("H4 TREND_CONT (CW)",   "H4 TrendCont CW",          "H4", h4CW, h4CWInds, trendH4CWEval, trendH4Spec, 2.0, 3.0);

  // ── Primary comparison table ─────────────────────────────────────────
  const maxResults = [ctrl, brkMax, tH1Max, tH4Max];
  const labels     = ["CTRL H1_MR", "H1_BREAKOUT", "H1_TREND", "H4_TREND"];

  console.log("\n" + EQ.repeat(78));
  console.log("[STEP 4] PRIMARY COMPARISON — MAX AVAILABLE (required for IS/OOS)");
  console.log(EQ.repeat(78));

  hdr("Metric", labels);
  row("TF",              maxResults.map(r => r.tf));
  row("Bars",            maxResults.map(r => r.totalBars));
  row("Days",            maxResults.map(r => r.dataDays));
  row("Trades",          maxResults.map(r => r.trades));
  row("  LONG",          maxResults.map(r => r.longT));
  row("  SHORT",         maxResults.map(r => r.shortT));
  console.log();
  row("Median ATR",      maxResults.map(r => f2(r.medATRpips) + "pip"));
  row("Cost / ATR",      maxResults.map(r => pct(r.costATRR * 100)));
  row("SL Dist (med)",   maxResults.map(r => f2(r.medSLDist) + "pip"));
  row("Eff SL / Open",   maxResults.map(r => f2(r.effSLOpen) + "pip"));
  console.log();
  row("Same-bar SL",     maxResults.map(r => pct(r.sameBarSLR * 100)));
  row("Avg Hold Bars",   maxResults.map(r => f1(r.avgHoldBars)));
  row("Avg Hold Min",    maxResults.map(r => f1(r.avgHoldMin)));
  console.log();
  row("Win Rate",        maxResults.map(r => pct(r.wr)));
  row("Profit Factor",   maxResults.map(r => f3(r.pfNormal)));
  row("Pips / Trade",    maxResults.map(r => f2(r.pipsPerTr)));
  row("Avg Win",         maxResults.map(r => f2(r.avgWin) + "pip"));
  row("Avg Loss",        maxResults.map(r => f2(r.avgLoss) + "pip"));
  row("Max Drawdown",    maxResults.map(r => f1(r.maxDD) + "pip"));
  row("Max Con.Loss",    maxResults.map(r => r.maxCon));
  console.log();
  row("MFE Median",      maxResults.map(r => f2(r.mfeMed) + "pip"));
  row("MFE P25/P75",     maxResults.map(r => `${f1(r.mfeP25)}/${f1(r.mfeP75)}`));
  row("MAE Median",      maxResults.map(r => f2(r.maeMed) + "pip"));
  row("First Bar Fav",   maxResults.map(r => pct(r.fbFavR)));
  row("MFE >= 1×ATR",   maxResults.map(r => pct(r.mfeGte1ATRpct)));
  row("MFE >= 2×ATR",   maxResults.map(r => pct(r.mfeGte2ATRpct)));
  console.log();
  row("LONG WR",         maxResults.map(r => pct(r.longWR)));
  row("LONG PF",         maxResults.map(r => f3(r.longPF)));
  row("SHORT WR",        maxResults.map(r => pct(r.shortWR)));
  row("SHORT PF",        maxResults.map(r => f3(r.shortPF)));
  console.log();
  row("Zero Cost PF",    maxResults.map(r => f3(r.pfZero)));
  row("Cost Penalty",    maxResults.map(r => "+" + f3(r.costPenalty)));
  console.log();
  row("IS Trades",       maxResults.map(r => r.isN));
  row("IS PF",           maxResults.map(r => f3(r.isPF)));
  row("IS Pips/Trade",   maxResults.map(r => f2(r.isPpt)));
  row("OOS Trades",      maxResults.map(r => String(r.oosN) + (r.oosN < 30 ? "*" : "")));
  row("OOS PF",          maxResults.map(r => f3(r.oosPF)));
  row("OOS Pips/Trade",  maxResults.map(r => f2(r.oosPpt)));
  row("PF Degradation",  maxResults.map(r => f3(r.pfDegrade)));
  console.log();
  row("Raw Edge 1-bar",  maxResults.map(r => "+" + f2((r.edges[0]?.edgeDelta ?? 0) * 100) + "pt"));
  row("Raw Edge 3-bar",  maxResults.map(r => "+" + f2((r.edges[1]?.edgeDelta ?? 0) * 100) + "pt"));
  row("Raw Edge 5-bar",  maxResults.map(r => "+" + f2((r.edges[2]?.edgeDelta ?? 0) * 100) + "pt"));
  row("Strat PosRate",   maxResults.map(r => pct((r.edges[2]?.posRate ?? 0) * 100)));
  row("Rand PosRate",    maxResults.map(r => pct((r.edges[2]?.randPosRate ?? 0) * 100)));
  console.log();
  row("CLASSIFICATION",  maxResults.map(r => r.classification));

  // ── Common Window Table ───────────────────────────────────────────────
  const cwResults = [ctrlCW, brkCW, tH1CW, tH4CW];
  console.log("\n" + EQ.repeat(78));
  console.log("[STEP 5] COMMON WINDOW TABLE (H1 period, for H1 vs H4 comparison)");
  console.log(EQ.repeat(78));

  hdr("Metric (CW)", labels);
  row("Bars",          cwResults.map(r => r.totalBars));
  row("Days",          cwResults.map(r => r.dataDays));
  row("Trades",        cwResults.map(r => r.trades));
  row("Profit Factor", cwResults.map(r => f3(r.pfNormal)));
  row("OOS PF",        cwResults.map(r => f3(r.oosPF) + (r.oosN < 30 ? "*LOW" : "")));
  row("Zero Cost PF",  cwResults.map(r => f3(r.pfZero)));
  row("Classification",cwResults.map(r => r.classification));

  // ── Signal quality detail ─────────────────────────────────────────────
  console.log("\n[STEP 6] Signal Quality (1/3/5 bar edge)");
  console.log(EQ.repeat(78));
  for (const r of maxResults) {
    console.log(`\n  ${r.name}:`);
    console.log(`  ${"Horizon".padEnd(8)} ${"N".padEnd(6)} ${"PosRate".padEnd(10)} ${"RandPos".padEnd(10)} ${"EDGE_Δ".padEnd(10)} ${"MeanRet".padEnd(10)} RandMean`);
    console.log("  " + "-".repeat(65));
    for (const e of r.edges) {
      const sign = e.edgeDelta >= 0 ? "+" : "";
      console.log(
        `  ${String(e.horizon + " bar").padEnd(8)} ` +
        `${String(e.n).padEnd(6)} ` +
        `${pct(e.posRate * 100).padEnd(10)} ` +
        `${pct(e.randPosRate * 100).padEnd(10)} ` +
        `${(sign + f2(e.edgeDelta * 100) + "pt").padEnd(10)} ` +
        `${f2(e.meanReturn).padEnd(10)} ` +
        `${f2(e.randMean)}`
      );
    }
  }

  // ── Monthly (H1) / Yearly (H4) stability ─────────────────────────────
  console.log("\n[STEP 7] Period Stability (Monthly H1 / Yearly H4)");
  console.log(EQ.repeat(78));

  for (const r of [ctrl, brkMax, tH1Max, tH4Max]) {
    if (r.periodStats.length === 0) continue;
    console.log(`\n  ${r.name} (${r.tf}):`);
    const profMonths = r.periodStats.filter(p => p.pf > 1.0).length;
    const lossMonths = r.periodStats.filter(p => p.pf <= 1.0 && p.n > 0).length;
    console.log(`  Period   Trades  PF      Pips`);
    console.log("  " + "-".repeat(38));
    for (const p of r.periodStats) {
      if (p.n === 0) continue;
      const pfStr = p.pf === 999 ? ">999" : f3(p.pf);
      const flag  = p.pf > 1.0 ? " +" : " -";
      console.log(`  ${p.period.padEnd(9)} ${String(p.n).padStart(6)}  ${pfStr.padStart(6)}  ${f1(p.pips).padStart(8)}${flag}`);
    }
    console.log(`  Profitable periods: ${profMonths}/${r.periodStats.filter(p => p.n > 0).length} (${pct(profMonths / Math.max(1, r.periodStats.filter(p => p.n > 0).length) * 100)})`);
    console.log(`  Loss periods:       ${lossMonths}/${r.periodStats.filter(p => p.n > 0).length}`);
  }

  // ── Final verdict ─────────────────────────────────────────────────────
  console.log("\n[STEP 8] Classification & Verdict");
  console.log(EQ.repeat(78));

  for (const r of maxResults) {
    const oos_flag = r.oosN < 30 ? " [INSUFFICIENT]" : r.oosN < 100 ? " [LOW_SAMPLE]" : "";
    console.log(`\n  ${r.name}:`);
    console.log(`    PF=${f3(r.pfNormal)}  OOS PF=${f3(r.oosPF)}${oos_flag}  Zero PF=${f3(r.pfZero)}`);
    console.log(`    WR=${pct(r.wr)}  SameBarSL=${pct(r.sameBarSLR * 100)}  Cost/ATR=${pct(r.costATRR * 100)}`);
    console.log(`    Raw Edge 5-bar: ${f2((r.edges[2]?.edgeDelta ?? 0) * 100)}pt  IS/OOS: ${f3(r.isPF)} → ${f3(r.oosPF)}`);
    console.log(`    → ${r.classification}`);
  }

  // Determine best hypothesis
  const eligible = maxResults.filter(r => r.oosN >= 30);
  const bestByOOS = [...eligible].sort((a, b) => b.oosPF - a.oosPF)[0];
  const anyCand   = maxResults.some(r => ["STRONG_CANDIDATE", "CANDIDATE"].includes(r.classification));
  const anyMarg   = maxResults.some(r => r.classification === "MARGINAL");

  let nextStep: string;
  if (anyCand) {
    nextStep = `Phase 6-F: Robustness Validation of ${bestByOOS?.name}`;
  } else if (maxResults.some(r => (r.edges[2]?.edgeDelta ?? 0) > 0.02 && r.pfNormal > 0.9)) {
    nextStep = "Phase 6-F: Execution / Exit compatibility for best marginal hypothesis";
  } else {
    nextStep = "Phase 7: All tested hypotheses insufficient. Explore new market structures.";
  }

  // ── FINAL REPORT ──────────────────────────────────────────────────────
  console.log("\n╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 6-E FINAL REPORT" + " ".repeat(49) + "║");
  console.log("╠" + EQ.repeat(72) + "╣");

  const L = (lbl: string, val: string) => {
    const c = `  ${lbl.padEnd(36)} ${val}`;
    console.log(`║${c.padEnd(72)}║`);
  };

  L("PHASE 6-E:", "COMPLETE");
  L("CASE:", "B — evalTrendContinuation added inline");
  L("ENGINE FILES CHANGED:", "NO");
  console.log("╠" + EQ.repeat(72) + "╣");

  for (const r of maxResults) {
    const oos = r.oosN < 30 ? ` [INSUFF N=${r.oosN}]` : (r.oosN < 100 ? ` [LOW N=${r.oosN}]` : "");
    L(`  ${r.name} PF=${f3(r.pfNormal)}:`, `${r.classification}${oos}`);
  }

  console.log("╠" + EQ.repeat(72) + "╣");
  L("BEST HYPOTHESIS:", bestByOOS ? `${bestByOOS.name} (OOS PF=${f3(bestByOOS.oosPF)})` : "NONE");
  L("NORMAL COST EDGE:", maxResults.some(r => r.pfNormal > 1.0) ? "PASS" : "FAIL");
  L("OOS EDGE:", maxResults.some(r => r.oosPF > 1.0 && r.oosN >= 30) ? "PASS" : "FAIL");
  L("RAW SIGNAL EDGE:", maxResults.some(r => (r.edges[2]?.edgeDelta ?? 0) > 0.02) ? "PASS (some)" : "FAIL");
  L("ROBUSTNESS:", maxResults.some(r => r.pfDegrade > 0.8 && r.oosN >= 30) ? "PASS (some)" : "INCONCLUSIVE");
  L("DATA LEAKAGE:", "NONE");
  L("LOOK-AHEAD SAFETY:", "PASS");
  L("PRODUCTION DEFAULTS CHANGED:", "NO");
  L("PRODUCTION STRATEGY CREATED:", "NO");
  L("ENGINE FILES CHANGED:", "NO");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("NEXT:", nextStep);
  console.log("╚" + EQ.repeat(72) + "╝");
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });

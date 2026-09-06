// =================================================================
// Phase 6-A: Analysis Helper Functions (Pure)
//
// Statistics, ATR regime classification, IS/OOS split,
// MFE/MAE computation, session labeling, and candidate verdict.
//
// All functions are pure — no I/O, no external dependencies.
// =================================================================

import type { Bar }           from "@/infrastructure/analysis/types";
import type { BacktestTrade } from "../BacktestEngine";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface TradeWithMetrics extends BacktestTrade {
  mfe:               number;    // Maximum Favorable Excursion (pips, >= 0)
  mae:               number;    // Maximum Adverse Excursion  (pips, <= 0)
  firstBarFavorable: boolean;   // first bar moved toward profit
  atrAtSignal:       number | undefined; // ATR(14) at signal bar (inds.atr[entryBarIdx - 1])
  session:           string;    // TOKYO / LONDON / NEW_YORK / OVERLAP / OTHER
}

export interface SliceStats {
  trades:               number;
  longTrades:           number;
  shortTrades:          number;
  wins:                 number;
  losses:               number;
  winRate:              number;   // %
  totalPips:            number;
  pipsPerTrade:         number;
  profitFactor:         number;
  maxDrawdown:          number;   // pips
  maxConsecutiveLosses: number;
  avgWin:               number;   // pips
  avgLoss:              number;   // pips (negative)
  expectancy:           number;   // pips per trade
  mfeMedian:            number;   // pips
  maeMedian:            number;   // pips
  firstBarFavorableRate: number;  // %
  mfeGte5Pct:           number;   // % of trades where MFE >= 5 pips
  mfeGte10Pct:          number;
  mfeGte15Pct:          number;
}

export interface ATRRegimeBoundaries {
  p33: number; // price units (not pips)
  p66: number;
}

export interface CandidateVerdict {
  label:       "STRONG_CANDIDATE" | "CANDIDATE" | "INCONCLUSIVE" | "REJECTED";
  reason:      string;
}

// ------------------------------------------------------------------
// Math helpers
// ------------------------------------------------------------------

export function calcMedian(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function calcPercentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor((p / 100) * s.length), s.length - 1);
  return s[idx];
}

// ------------------------------------------------------------------
// ATR regime classification
//
// Uses data-driven 33/66 percentile split — NOT a fixed threshold.
// Input: ATR values at signal bars (raw price units, not pips).
// ------------------------------------------------------------------

export function classifyATRRegime(
  atrValues: (number | undefined)[],
): ATRRegimeBoundaries {
  const valid = atrValues
    .filter((v): v is number => v !== undefined && v > 0)
    .sort((a, b) => a - b);

  if (valid.length < 3) return { p33: 0, p66: 0 };

  const p33 = valid[Math.floor(valid.length / 3)];
  const p66 = valid[Math.floor((valid.length * 2) / 3)];
  return { p33, p66 };
}

export type ATRBand = "LOW" | "MID" | "HIGH" | "UNKNOWN";

export function getATRBand(
  atr:      number | undefined,
  bounds:   ATRRegimeBoundaries,
): ATRBand {
  if (atr === undefined || bounds.p33 === 0) return "UNKNOWN";
  if (atr <= bounds.p33) return "LOW";
  if (atr <= bounds.p66) return "MID";
  return "HIGH";
}

// ------------------------------------------------------------------
// Session classification
//
// Consistent with existing timeframe.ts SESSION_UTC definition.
// OVERLAP = LONDON + NEW_YORK overlap (12:00-16:00 UTC).
// ------------------------------------------------------------------

export function getSession(utcMs: number): string {
  const h         = new Date(utcMs).getUTCHours();
  const inTokyo   = h >= 0  && h < 9;
  const inLondon  = h >= 7  && h < 16;
  const inNewYork = h >= 12 && h < 21;

  if (inLondon && inNewYork) return "OVERLAP";
  if (inLondon)              return "LONDON";
  if (inNewYork)             return "NEW_YORK";
  if (inTokyo)               return "TOKYO";
  return "OTHER";
}

// ------------------------------------------------------------------
// IS / OOS time-based split (60% IS / 40% OOS)
//
// Trades are sorted by entryTime (chronological). First 60% → IS,
// last 40% → OOS. No random shuffling — strictly time-based.
// ------------------------------------------------------------------

export function splitISOOS(
  trades:  TradeWithMetrics[],
  isRatio: number = 0.6,
): { is: TradeWithMetrics[]; oos: TradeWithMetrics[] } {
  if (trades.length === 0) return { is: [], oos: [] };
  const sorted   = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const splitIdx = Math.floor(sorted.length * isRatio);
  return {
    is:  sorted.slice(0, splitIdx),
    oos: sorted.slice(splitIdx),
  };
}

// ------------------------------------------------------------------
// MFE / MAE computation
//
// Iterates over bars from entryBarIdx to exitBarIdx (capped at 50).
// MFE = max favorable excursion (pips, >= 0).
// MAE = max adverse excursion  (pips, <= 0).
// ------------------------------------------------------------------

const MFE_MAE_MAX_BARS = 50;
const EURUSD_PIP       = 0.0001;

export function computeMfeMae(
  direction:   "BUY" | "SELL",
  entryPrice:  number,
  bars:        Bar[],
  entryBarIdx: number,
  exitBarIdx:  number,
): { mfe: number; mae: number } {
  let mfe = 0;
  let mae = 0;

  const capIdx = Math.min(exitBarIdx, entryBarIdx + MFE_MAE_MAX_BARS - 1);

  for (let i = entryBarIdx; i <= capIdx && i < bars.length; i++) {
    const bar = bars[i];
    if (direction === "BUY") {
      const fav = (bar.high - entryPrice) / EURUSD_PIP;
      const unf = (bar.low  - entryPrice) / EURUSD_PIP; // negative
      if (fav > mfe) mfe = fav;
      if (unf < mae) mae = unf;
    } else {
      const fav = (entryPrice - bar.low)  / EURUSD_PIP;
      const unf = (entryPrice - bar.high) / EURUSD_PIP; // negative
      if (fav > mfe) mfe = fav;
      if (unf < mae) mae = unf;
    }
  }

  return { mfe, mae };
}

// ------------------------------------------------------------------
// First-bar-favorable
//
// True if the entry bar's close moved toward profit direction.
// ------------------------------------------------------------------

export function isFirstBarFavorable(
  direction:   "BUY" | "SELL",
  entryPrice:  number,
  entryBar:    Bar,
): boolean {
  if (direction === "BUY")  return entryBar.close > entryPrice;
  return entryBar.close < entryPrice;
}

// ------------------------------------------------------------------
// Stats computation
//
// Excludes END_OF_DATA trades from PF / WR calculations.
// MFE/MAE stats use all trades (including END_OF_DATA).
// ------------------------------------------------------------------

export function computeStats(trades: TradeWithMetrics[]): SliceStats {
  if (trades.length === 0) {
    return {
      trades: 0, longTrades: 0, shortTrades: 0, wins: 0, losses: 0,
      winRate: 0, totalPips: 0, pipsPerTrade: 0, profitFactor: 0,
      maxDrawdown: 0, maxConsecutiveLosses: 0, avgWin: 0, avgLoss: 0,
      expectancy: 0, mfeMedian: 0, maeMedian: 0, firstBarFavorableRate: 0,
      mfeGte5Pct: 0, mfeGte10Pct: 0, mfeGte15Pct: 0,
    };
  }

  // For PF / WR: closed trades only (exclude END_OF_DATA)
  const closed  = trades.filter(t => t.result !== "END_OF_DATA");
  const wins    = closed.filter(t => t.result === "WIN");
  const losses  = closed.filter(t => t.result === "LOSS");

  const grossWin  = wins.reduce((s, t) => s + t.pips, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pips, 0));
  const pf        = grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss;

  // Sequential drawdown (pips)
  let peakPips = 0, cumPips = 0, maxDD = 0;
  for (const t of closed) {
    cumPips += t.pips;
    if (cumPips > peakPips) peakPips = cumPips;
    const dd = peakPips - cumPips;
    if (dd > maxDD) maxDD = dd;
  }

  // Max consecutive losses
  let maxCon = 0, con = 0;
  for (const t of closed) {
    if (t.result === "LOSS") { con++; if (con > maxCon) maxCon = con; }
    else                       con = 0;
  }

  const n          = closed.length;
  const totalPips  = closed.reduce((s, t) => s + t.pips, 0);
  const avgWin     = wins.length   > 0 ? grossWin   / wins.length   : 0;
  const avgLoss    = losses.length > 0 ? -grossLoss / losses.length : 0; // negative
  const wr         = n > 0 ? wins.length / n : 0;
  const expectancy = wr * avgWin + (1 - wr) * avgLoss;

  // MFE/MAE use ALL trades (including END_OF_DATA for completeness)
  const mfes    = trades.map(t => t.mfe);
  const maes    = trades.map(t => t.mae);
  const fbFav   = trades.filter(t => t.firstBarFavorable).length;
  const nt      = trades.length;
  const mfe5    = trades.filter(t => t.mfe >= 5).length;
  const mfe10   = trades.filter(t => t.mfe >= 10).length;
  const mfe15   = trades.filter(t => t.mfe >= 15).length;

  const r = (x: number, d = 10) => Math.round(x * d) / d;

  return {
    trades:               n,
    longTrades:           trades.filter(t => t.direction === "BUY").length,
    shortTrades:          trades.filter(t => t.direction === "SELL").length,
    wins:                 wins.length,
    losses:               losses.length,
    winRate:              r(wr * 100, 100),
    totalPips:            r(totalPips, 10),
    pipsPerTrade:         n > 0 ? r(totalPips / n, 10) : 0,
    profitFactor:         r(pf, 1000),
    maxDrawdown:          r(maxDD, 10),
    maxConsecutiveLosses: maxCon,
    avgWin:               r(avgWin, 10),
    avgLoss:              r(avgLoss, 10),
    expectancy:           r(expectancy, 100),
    mfeMedian:            r(calcMedian(mfes), 100),
    maeMedian:            r(calcMedian(maes), 100),
    firstBarFavorableRate: nt > 0 ? r(fbFav / nt * 100, 10) : 0,
    mfeGte5Pct:           nt > 0 ? r(mfe5  / nt * 100, 10) : 0,
    mfeGte10Pct:          nt > 0 ? r(mfe10 / nt * 100, 10) : 0,
    mfeGte15Pct:          nt > 0 ? r(mfe15 / nt * 100, 10) : 0,
  };
}

// ------------------------------------------------------------------
// Candidate verdict (Phase 6-A screening threshold)
//
// These are RESEARCH CONTINUATION thresholds, NOT production criteria.
// ------------------------------------------------------------------

export function classifyCandidate(
  allStats: SliceStats,
  oosStats: SliceStats,
): CandidateVerdict {
  const { trades, profitFactor }                 = allStats;
  const { trades: oosTrades, profitFactor: oosPF } = oosStats;

  if (
    trades >= 150 &&
    profitFactor > 1.05 &&
    oosTrades >= 60 &&
    oosPF > 1.00
  ) {
    return {
      label:  "STRONG_CANDIDATE",
      reason: `ALL PF ${profitFactor.toFixed(3)} > 1.05, OOS PF ${oosPF.toFixed(3)} > 1.00 (N_all=${trades}, N_oos=${oosTrades})`,
    };
  }

  if (
    trades >= 100 &&
    profitFactor >= 0.95 &&
    oosTrades >= 40 &&
    oosPF >= 0.90
  ) {
    return {
      label:  "CANDIDATE",
      reason: `ALL PF ${profitFactor.toFixed(3)} >= 0.95, OOS PF ${oosPF.toFixed(3)} >= 0.90 (N_all=${trades}, N_oos=${oosTrades})`,
    };
  }

  if (profitFactor < 0.85 && oosPF < 0.85) {
    return {
      label:  "REJECTED",
      reason: `ALL PF ${profitFactor.toFixed(3)} < 0.85 AND OOS PF ${oosPF.toFixed(3)} < 0.85`,
    };
  }

  return {
    label:  "INCONCLUSIVE",
    reason: `Borderline stats: ALL PF ${profitFactor.toFixed(3)}, OOS PF ${oosPF.toFixed(3)}, N_all=${trades}, N_oos=${oosTrades}`,
  };
}

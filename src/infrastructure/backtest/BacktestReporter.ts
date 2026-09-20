// =================================================================
// BacktestReporter.ts — Backtest 統計レポート生成 (Phase 2-D)
//
// BacktestEngine.BacktestResult → BacktestReport
//
// 設計原則:
//   - Pure Function: DB / MT5 / AI 非依存
//   - NaN / Infinity を返さない
//   - Session は entryTime から動的計算
// =================================================================

import type { BacktestResult } from "./BacktestEngine";
import type { BacktestTrade }  from "./PositionManager";
import { getSessionsAtTime }   from "./timeframe";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface SessionStat {
  tradeCount:   number;
  wins:         number;
  losses:       number;
  winRate:      number;    // 0-100
  totalPips:    number;
  profitFactor: number | null;  // null = infinite
}

export interface BacktestReport {
  // --- Period metadata ---
  periodLabel:      string;
  dataFrom:         number;   // Unix ms
  dataTo:           number;
  dataCoverageDays: number;
  barCount:         number;

  // --- Trade counts ---
  totalTrades: number;
  wins:        number;
  losses:      number;
  breakevens:  number;   // result="BREAKEVEN"

  // --- Win rate (0-100) ---
  winRate: number;

  // --- Pips ---
  totalPips: number;
  avgPips:   number;

  // --- Money ---
  totalProfit:  number;
  grossProfit:  number;
  grossLoss:    number;
  profitFactor: number | null;  // null = infinite (all wins, no losses)

  // --- Balance ---
  initialBalance: number;
  finalBalance:   number;

  // --- Drawdown ---
  maxDrawdown:     number;   // USD
  maxDrawdownPct:  number;   // %
  maxDrawdownPips: number;   // pips

  // --- Streaks ---
  maxConsecutiveWins:   number;
  maxConsecutiveLosses: number;

  // --- Duration ---
  avgDurationMin: number;

  // --- Sessions ---
  sessionStats: Record<string, SessionStat>;
  bestSession:  string | null;   // by totalPips
  worstSession: string | null;

  // --- Sample quality ---
  sampleSizeWarning:    boolean;
  minRecommendedTrades: number;

  // --- Verdict ---
  verdict:       "PASSED" | "CONDITIONAL" | "FAILED";
  verdictReason: string;

  // --- Symbol info ---
  symbol:        string;
  mainTimeframe: string;
}

// ------------------------------------------------------------------
// Session label from entryTime
// ------------------------------------------------------------------

function tradeSession(entryMs: number): string {
  const sessions = getSessionsAtTime(entryMs);
  if (sessions.length === 0)  return "OFF";
  if (sessions.length === 1)  return sessions[0];
  return "OVERLAP";
}

// ------------------------------------------------------------------
// Profit factor helper (never returns NaN / Infinity)
// ------------------------------------------------------------------

function safePF(grossProfit: number, grossLoss: number): number | null {
  if (grossLoss > 0)     return grossProfit / grossLoss;
  if (grossProfit > 0)   return null;  // infinite
  return 0;                            // no trades or all breakeven
}

// ------------------------------------------------------------------
// Main function
// ------------------------------------------------------------------

export function generateReport(params: {
  engineResult: BacktestResult;
  periodLabel:  string;
  barCount:     number;
}): BacktestReport {
  const { engineResult, periodLabel, barCount } = params;
  const { trades, initialBalance, finalBalance, symbol, mainTimeframe,
          maxDrawdown, maxDrawdownPct, totalProfit, startTime, endTime } = engineResult;

  const totalTrades = trades.length;
  const dataFrom = totalTrades > 0 ? trades[0].entryTime          : startTime;
  const dataTo   = totalTrades > 0 ? trades[totalTrades - 1].exitTime : endTime;
  const dataCoverageDays = Math.round((dataTo - dataFrom) / 86_400_000 * 10) / 10;

  // --- Trade counts ---
  const wins      = trades.filter(t => t.result === "WIN").length;
  const losses    = trades.filter(t => t.result === "LOSS").length;
  const breakevens = trades.filter(t => t.result === "BREAKEVEN").length;
  const winRate   = totalTrades > 0 ? round2(wins / totalTrades * 100) : 0;

  // --- Pips ---
  const totalPips = round1(trades.reduce((s, t) => s + t.pips, 0));
  const avgPips   = totalTrades > 0 ? round1(totalPips / totalTrades) : 0;

  // --- Money ---
  const grossProfit = round2(trades.reduce((s, t) => t.profit > 0 ? s + t.profit : s, 0));
  const grossLoss   = round2(trades.reduce((s, t) => t.profit < 0 ? s + Math.abs(t.profit) : s, 0));
  const profitFactor = safePF(grossProfit, grossLoss);

  // --- Max Drawdown (pips) ---
  let cumPips = 0, peakPips = 0, maxDDPips = 0;
  for (const t of trades) {
    cumPips += t.pips;
    if (cumPips > peakPips) peakPips = cumPips;
    const dd = peakPips - cumPips;
    if (dd > maxDDPips) maxDDPips = dd;
  }

  // --- Streaks ---
  let maxConWins = 0, maxConLoss = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.result === "WIN")  { curW++; curL = 0; }
    else if (t.result === "LOSS") { curL++; curW = 0; }
    else { curW = 0; curL = 0; }  // BREAKEVEN / END_OF_DATA
    if (curW > maxConWins) maxConWins = curW;
    if (curL > maxConLoss) maxConLoss = curL;
  }

  // --- Duration ---
  const avgDurationMin = totalTrades > 0
    ? round1(trades.reduce((s, t) => s + t.durationMin, 0) / totalTrades)
    : 0;

  // --- Session stats ---
  type RawSession = { tradeCount: number; wins: number; losses: number; totalPips: number; gp: number; gl: number };
  const raw: Record<string, RawSession> = {};

  for (const t of trades) {
    const sess = tradeSession(t.entryTime);
    if (!raw[sess]) raw[sess] = { tradeCount: 0, wins: 0, losses: 0, totalPips: 0, gp: 0, gl: 0 };
    const s = raw[sess];
    s.tradeCount++;
    if (t.result === "WIN")  s.wins++;
    if (t.result === "LOSS") s.losses++;
    s.totalPips += t.pips;
    if (t.profit > 0) s.gp += t.profit;
    if (t.profit < 0) s.gl += Math.abs(t.profit);
  }

  const sessionStats: Record<string, SessionStat> = {};
  for (const [name, s] of Object.entries(raw)) {
    sessionStats[name] = {
      tradeCount:   s.tradeCount,
      wins:         s.wins,
      losses:       s.losses,
      winRate:      s.tradeCount > 0 ? round2(s.wins / s.tradeCount * 100) : 0,
      totalPips:    round1(s.totalPips),
      profitFactor: safePF(round2(s.gp), round2(s.gl)),
    };
  }

  // Best/worst session by totalPips
  let bestSession: string | null = null;
  let worstSession: string | null = null;
  for (const [name, s] of Object.entries(sessionStats)) {
    if (bestSession  === null || s.totalPips > sessionStats[bestSession]!.totalPips)  bestSession  = name;
    if (worstSession === null || s.totalPips < sessionStats[worstSession]!.totalPips) worstSession = name;
  }

  // --- Sample warning ---
  const sampleSizeWarning = totalTrades < 30;

  // --- Verdict ---
  const pf = profitFactor ?? (grossProfit > 0 ? Infinity : 0);
  let verdict: "PASSED" | "CONDITIONAL" | "FAILED";
  let verdictReason: string;

  if (totalTrades === 0) {
    verdict = "FAILED";
    verdictReason = "No trades generated";
  } else if (totalPips > 0 && pf >= 1.3 && winRate >= 30) {
    verdict = "PASSED";
    const pfStr = profitFactor !== null ? profitFactor.toFixed(2) : "∞";
    verdictReason = `Profitable: pips=${totalPips}, PF=${pfStr}, WR=${winRate}%`;
  } else if (totalPips > 0 && pf >= 1.0) {
    verdict = "CONDITIONAL";
    const pfStr = profitFactor !== null ? profitFactor.toFixed(2) : "∞";
    verdictReason = `Marginally profitable: pips=${totalPips}, PF=${pfStr}`;
  } else {
    verdict = "FAILED";
    const pfStr = isFinite(pf) ? pf.toFixed(2) : "∞";
    verdictReason = `Unprofitable: pips=${totalPips}, PF=${pfStr}`;
  }

  return {
    periodLabel, dataFrom, dataTo, dataCoverageDays, barCount,
    totalTrades, wins, losses, breakevens, winRate,
    totalPips, avgPips,
    totalProfit: round2(totalProfit),
    grossProfit, grossLoss,
    profitFactor: profitFactor !== null ? round4(profitFactor) : null,
    initialBalance, finalBalance: round2(finalBalance),
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPct: round2(maxDrawdownPct),
    maxDrawdownPips: round1(maxDDPips),
    maxConsecutiveWins:   maxConWins,
    maxConsecutiveLosses: maxConLoss,
    avgDurationMin,
    sessionStats,
    bestSession: Object.keys(sessionStats).length > 0 ? bestSession : null,
    worstSession: Object.keys(sessionStats).length > 0 ? worstSession : null,
    sampleSizeWarning,
    minRecommendedTrades: 30,
    verdict, verdictReason,
    symbol, mainTimeframe,
  };
}

// ------------------------------------------------------------------
// Rounding helpers
// ------------------------------------------------------------------

function round1(n: number): number { return Math.round(n * 10)    / 10; }
function round2(n: number): number { return Math.round(n * 100)   / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

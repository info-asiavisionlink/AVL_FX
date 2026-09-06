// =================================================================
// MonteCarloEngine.ts — Monte Carlo Simulation Engine (Phase 4-C)
//
// Pure functions のみ。DB / Supabase / AI 非依存。
//
// 設計原則:
//   1. Trade Order Shuffle (Fisher-Yates)
//      - Original Trade[] を変更しない (slice() でコピー)
//   2. 完全決定論的: 同一 Input → 同一 Output (Mulberry32 PRNG)
//   3. Profit Factor 定義は BacktestReporter.safePF() と完全一致
//   4. maxConsecutiveLosses 計算は BacktestReporter と完全一致
//   5. Data Leakage 防止: MC 結果は Optimization / Walk Forward に渡さない
//
// 対応 Simulation 数: 100–50000
// 最小 Trade 数: 10 (未満は API が弾く)
// =================================================================

import type { BacktestTrade } from "./BacktestEngine";
import type {
  MonteCarloInput,
  MonteCarloResult,
  IterationMetrics,
  PercentileSet,
  PFPercentileSet,
  MonteCarloDistributions,
} from "./MonteCarloSchema";

export type {
  MonteCarloResult,
  MonteCarloInput,
  IterationMetrics,
  PercentileSet,
  PFPercentileSet,
  MonteCarloDistributions,
};

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

export const MC_MIN_TRADES                  = 10;
export const MC_MIN_ITERATIONS              = 100;
export const MC_MAX_ITERATIONS              = 50_000;
export const MC_DEFAULT_ITERATIONS          = 1_000;
export const MC_DEFAULT_DRAWDOWN_THRESHOLD  = 20.0;

// ------------------------------------------------------------------
// Mulberry32 PRNG
//
// シード付き擬似乱数生成器 (Math.random() は使用しない)
// 同一 seed → 同一乱数列 (完全再現性保証)
// seed = 0 は 1 に変換 (ゼロシードの縮退防止)
// ------------------------------------------------------------------

export function createRNG(seed: number): () => number {
  let s = (seed >>> 0) || 1; // unsigned 32-bit, non-zero
  return function rng(): number {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
// Fisher-Yates Shuffle
//
// Original Trade[] は変更しない — 必ず slice() コピーを使用
// ------------------------------------------------------------------

export function shuffleTrades(
  trades: readonly BacktestTrade[],
  rng:    () => number,
): BacktestTrade[] {
  const arr = trades.slice(); // shallow copy (trades[i] は immutable object)
  for (let i = arr.length - 1; i > 0; i--) {
    const j   = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i]    = arr[j]!;
    arr[j]    = tmp;
  }
  return arr;
}

// ------------------------------------------------------------------
// Metric Calculation (per iteration)
//
// Profit Factor: BacktestReporter.safePF() と完全一致
//   grossLoss > 0               → Math.round(gp/gl * 10000) / 10000
//   grossLoss = 0, grossProfit > 0 → null (infinite)
//   else                        → 0
//
// maxConsecutiveLosses: BacktestReporter と完全一致
//   WIN  → curL = 0
//   LOSS → curL++
//   BREAKEVEN / END_OF_DATA → curL = 0 (リセット)
//
// maxDrawdownPct: WalkForwardEngine.recomputeMetricsFromTrades() と同一
//   running balance を更新し、peak-to-trough / peak で計算
// ------------------------------------------------------------------

export function calcIterationMetrics(
  trades:         readonly BacktestTrade[],
  initialBalance: number,
): IterationMetrics {
  if (trades.length === 0) {
    return {
      finalPips:            0,
      finalProfit:          0,
      maxDrawdownPct:       0,
      maxConsecutiveLosses: 0,
      profitFactor:         0,
      winRate:              0,
    };
  }

  // --- Win rate ---
  const wins    = trades.filter(t => t.result === "WIN").length;
  const winRate = Math.round(wins / trades.length * 10000) / 100;

  // --- Pips / Profit ---
  const finalPips   = Math.round(trades.reduce((s, t) => s + t.pips,   0) * 10)  / 10;
  const finalProfit = Math.round(trades.reduce((s, t) => s + t.profit, 0) * 100) / 100;

  // --- Profit Factor (safePF 互換) ---
  const grossProfit = trades.reduce((s, t) => t.profit > 0 ? s + t.profit          : s, 0);
  const grossLoss   = trades.reduce((s, t) => t.profit < 0 ? s + Math.abs(t.profit): s, 0);

  let profitFactor: number | null;
  if (grossLoss > 0) {
    profitFactor = Math.round(grossProfit / grossLoss * 10000) / 10000;
  } else if (grossProfit > 0) {
    profitFactor = null; // infinite
  } else {
    profitFactor = 0;
  }

  // --- MaxDrawdownPct (running balance, peak を分母) ---
  let balance = initialBalance;
  let peak    = initialBalance;
  let maxDD   = 0;
  for (const t of trades) {
    balance += t.profit;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownPct = peak > 0
    ? Math.round(maxDD / peak * 10000) / 100
    : 0;

  // --- MaxConsecutiveLosses (BacktestReporter 互換) ---
  let maxConLoss = 0;
  let curL       = 0;
  for (const t of trades) {
    if (t.result === "LOSS") {
      curL++;
      if (curL > maxConLoss) maxConLoss = curL;
    } else {
      curL = 0; // WIN, BREAKEVEN, END_OF_DATA はいずれもリセット
    }
  }

  return {
    finalPips,
    finalProfit,
    maxDrawdownPct,
    maxConsecutiveLosses: maxConLoss,
    profitFactor,
    winRate,
  };
}

// ------------------------------------------------------------------
// Percentile Calculation (Linear Interpolation)
// ------------------------------------------------------------------

function pickPercentile(sortedAsc: number[], pct: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const idx = pct / 100 * (n - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  // linear interpolation
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

/** 数値配列から Percentile セットを計算 (4桁丸め) */
export function calcPercentiles(values: number[]): PercentileSet {
  const sorted = values.slice().sort((a, b) => a - b);
  const r = (n: number): number => Math.round(n * 10000) / 10000;
  return {
    p5:  r(pickPercentile(sorted,  5)),
    p10: r(pickPercentile(sorted, 10)),
    p25: r(pickPercentile(sorted, 25)),
    p50: r(pickPercentile(sorted, 50)),
    p75: r(pickPercentile(sorted, 75)),
    p90: r(pickPercentile(sorted, 90)),
    p95: r(pickPercentile(sorted, 95)),
  };
}

/** Profit Factor 用 Percentile セット
 *  null (infinite) は Infinity として扱い最高値にソート
 *  Infinity 区間の percentile は null として返す (JSON 非対応のため) */
export function calcPFPercentiles(pfValues: (number | null)[]): PFPercentileSet {
  const mapped = pfValues.map(v => (v === null ? Infinity : v));
  const sorted = mapped.slice().sort((a, b) => a - b);

  const getP = (pct: number): number | null => {
    const val = pickPercentile(sorted, pct);
    if (!isFinite(val)) return null;
    return Math.round(val * 10000) / 10000;
  };

  return {
    p5:  getP(5),
    p10: getP(10),
    p25: getP(25),
    p50: getP(50),
    p75: getP(75),
    p90: getP(90),
    p95: getP(95),
  };
}

// ------------------------------------------------------------------
// Probability Calculations
// ------------------------------------------------------------------

/** P(finalPips < 0): 最終 Pips がマイナスになる確率 (0.0–1.0) */
export function calcProbabilityOfLoss(finalPipsValues: number[]): number {
  if (finalPipsValues.length === 0) return 0;
  const count = finalPipsValues.filter(p => p < 0).length;
  return Math.round(count / finalPipsValues.length * 1_000_000) / 1_000_000;
}

/** P(maxDrawdownPct >= thresholdPct): Drawdown が閾値以上になる確率 (0.0–1.0)
 *  "Ruin" とは命名しない。UI では "P(DD ≥ X%)" と表示する。 */
export function calcProbabilityOfDrawdownThreshold(
  maxDDPctValues: number[],
  thresholdPct:   number,
): number {
  if (maxDDPctValues.length === 0) return 0;
  const count = maxDDPctValues.filter(d => d >= thresholdPct).length;
  return Math.round(count / maxDDPctValues.length * 1_000_000) / 1_000_000;
}

// ------------------------------------------------------------------
// Original Percentile Rank
//
// P(simulation finalPips ≤ original finalPips) × 100
// UI では "Original Sequence: P[XX]" と表示
// ------------------------------------------------------------------

export function calcOriginalPercentileRank(
  originalFinalPips:  number,
  simulatedFinalPips: number[],
): number {
  if (simulatedFinalPips.length === 0) return 50;
  const count = simulatedFinalPips.filter(p => p <= originalFinalPips).length;
  return Math.round(count / simulatedFinalPips.length * 10000) / 100;
}

// ------------------------------------------------------------------
// Main Runner
// ------------------------------------------------------------------

export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const {
    trades,
    iterations,
    seed,
    initialBalance,
    drawdownThresholdPct = MC_DEFAULT_DRAWDOWN_THRESHOLD,
  } = input;

  const startMs = Date.now();

  // 1. Original sequence (unshuffled)
  const originalMetrics = calcIterationMetrics(trades, initialBalance);

  // 2. Simulation
  const rng = createRNG(seed);

  const finalPipsArr:   number[]          = new Array(iterations) as number[];
  const maxDDPctArr:    number[]          = new Array(iterations) as number[];
  const maxConsLossArr: number[]          = new Array(iterations) as number[];
  const pfArr:          (number | null)[] = new Array(iterations) as (number | null)[];

  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffleTrades(trades, rng);
    const m        = calcIterationMetrics(shuffled, initialBalance);
    finalPipsArr[i]   = m.finalPips;
    maxDDPctArr[i]    = m.maxDrawdownPct;
    maxConsLossArr[i] = m.maxConsecutiveLosses;
    pfArr[i]          = m.profitFactor;
  }

  // 3. Distributions
  const distributions: MonteCarloDistributions = {
    finalPips:            calcPercentiles(finalPipsArr),
    maxDrawdownPct:       calcPercentiles(maxDDPctArr),
    profitFactor:         calcPFPercentiles(pfArr),
    maxConsecutiveLosses: calcPercentiles(maxConsLossArr),
  };

  return {
    iterations,
    seed,
    tradeCount:                     trades.length,
    initialBalance,
    drawdownThresholdPct,
    originalMetrics,
    distributions,
    probabilityOfLoss:              calcProbabilityOfLoss(finalPipsArr),
    probabilityOfDrawdownThreshold: calcProbabilityOfDrawdownThreshold(maxDDPctArr, drawdownThresholdPct),
    originalPercentileRank:         calcOriginalPercentileRank(originalMetrics.finalPips, finalPipsArr),
    executionMs:                    Date.now() - startMs,
  };
}

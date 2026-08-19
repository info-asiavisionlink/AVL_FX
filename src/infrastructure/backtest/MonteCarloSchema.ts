// =================================================================
// MonteCarloSchema.ts — Monte Carlo Simulation の型定義 (Phase 4-C)
//
// 設計原則:
//   - Trade Order Shuffle (Fisher-Yates) のみ
//   - AI 非依存 / DB 非依存
//   - Data Leakage なし: MC 結果は Optimization / Walk Forward に影響しない
//   - Profit Factor 定義: BacktestReporter.safePF() と完全一致
//     grossLoss > 0               → grossProfit / grossLoss
//     grossLoss = 0, grossProfit > 0 → null (infinite)
//     else                        → 0
// =================================================================

import type { BacktestTrade } from "./BacktestEngine";

export type { BacktestTrade };

// ------------------------------------------------------------------
// Input
// ------------------------------------------------------------------

/** runMonteCarlo() への入力 */
export interface MonteCarloInput {
  /** BacktestEngine が返した Trade[] — Engine 内でコピー、原本は変更しない */
  trades:               BacktestTrade[];
  iterations:           number;   // 100–50000
  seed:                 number;   // Mulberry32 seed (unsigned 32-bit)
  initialBalance:       number;   // maxDrawdownPct 計算のベース
  /** P(maxDrawdownPct >= threshold) の閾値 (%) — default 20.0
   *  命名: "Ruin" は誤解を招くため "DrawdownThreshold" を使用 */
  drawdownThresholdPct?: number;
}

// ------------------------------------------------------------------
// Per-Iteration Metrics
// ------------------------------------------------------------------

export interface IterationMetrics {
  finalPips:            number;        // Σ pips (round 1 decimal)
  finalProfit:          number;        // Σ profit USD (round 2 decimal)
  maxDrawdownPct:       number;        // running-balance 法 (round 2 decimal)
  maxConsecutiveLosses: number;        // BREAKEVEN / END_OF_DATA はリセット (= BacktestReporter)
  /** null = infinite (grossLoss=0, grossProfit>0) — BacktestReporter.safePF() と同定義 */
  profitFactor:         number | null;
  winRate:              number;        // result==="WIN" のみカウント (round 2, 0-100)
}

// ------------------------------------------------------------------
// Percentile Sets
// ------------------------------------------------------------------

/** 数値のみの Percentile セット (finalPips / maxDrawdownPct / maxConsecutiveLosses) */
export interface PercentileSet {
  p5:  number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

/** Profit Factor 専用 Percentile セット (null = infinite) */
export interface PFPercentileSet {
  p5:  number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
}

// ------------------------------------------------------------------
// Distributions
// ------------------------------------------------------------------

export interface MonteCarloDistributions {
  finalPips:            PercentileSet;
  maxDrawdownPct:       PercentileSet;
  profitFactor:         PFPercentileSet;
  maxConsecutiveLosses: PercentileSet;
}

// ------------------------------------------------------------------
// Result
// ------------------------------------------------------------------

export interface MonteCarloResult {
  // --- Settings ---
  iterations:                     number;
  seed:                           number;
  tradeCount:                     number;
  initialBalance:                 number;
  drawdownThresholdPct:           number;

  // --- Original (unshuffled) sequence ---
  originalMetrics:                IterationMetrics;

  // --- Simulation Percentile Distributions ---
  distributions:                  MonteCarloDistributions;

  // --- Probability Metrics ---
  /** P(finalPips < 0): 0.0–1.0 */
  probabilityOfLoss:              number;
  /** P(maxDrawdownPct >= drawdownThresholdPct): 0.0–1.0
   *  UI では "P(DD ≥ X%)" と表示。"Ruin" とは表示しない。 */
  probabilityOfDrawdownThreshold: number;

  // --- Original Sequence Position ---
  /** P(simulation finalPips ≤ original finalPips) × 100 (0–100)
   *  UI では "Original Sequence: P[XX]" と表示 */
  originalPercentileRank:         number;

  executionMs:                    number;
}

// =================================================================
// WalkForwardSchema.ts — Walk Forward Validation の型定義 (Phase 4-B)
//
// 設計原則:
//   - TEST barsをOptimizationへ渡さない
//   - TEST metricsをParameter選択へ渡さない
//   - Window N TEST結果をWindow N+1 Optimizationへフィードバックしない
//   - TRAIN-OOS INSUFFICIENTの場合はTESTを実行せずスキップ
// =================================================================

import type { StrategySpec }    from "@/lib/strategySchema";
import type { Bar }             from "@/infrastructure/analysis/types";
import type {
  ParameterRange,
  ParameterSet,
  OptimizationMetrics,
  SampleStatus,
} from "./OptimizationEngine";

// Re-export for consumers of this schema
export type { ParameterRange, ParameterSet, OptimizationMetrics, SampleStatus };

// ------------------------------------------------------------------
// Walk Forward Verdict
// ------------------------------------------------------------------

export type WalkForwardVerdict =
  | "ROBUST"        // 高ConsistencyScore + 高ParameterStability + 十分なWindow数
  | "CONDITIONAL"   // 中ConsistencyScore または不安定なParameter
  | "OVERFIT"       // 低ConsistencyScore (TRAINは良いがTESTが悪い)
  | "INCONCLUSIVE"; // データ不足で判定不能

// ------------------------------------------------------------------
// Window 定義 (TRAIN/TEST 境界)
// ------------------------------------------------------------------

/** 1 Walk Forward Window の時間境界 */
export interface WalkForwardWindow {
  windowIndex: number;
  /** TRAIN 開始時刻 (inclusive, Unix ms) */
  trainFrom:   number;
  /** TRAIN 終了時刻 (exclusive) = testFrom */
  trainTo:     number;
  /** TEST 開始時刻 (inclusive, Unix ms) = trainTo */
  testFrom:    number;
  /** TEST 終了時刻 (exclusive, Unix ms) */
  testTo:      number;
}

// ------------------------------------------------------------------
// Window 結果
// ------------------------------------------------------------------

/** 1 Window の完全な評価結果 */
export interface WalkForwardWindowResult extends WalkForwardWindow {
  // --- Optimization (TRAIN IS 80% + TRAIN OOS 20%) ---
  /** TRAIN-OOS RankingのRank1候補のParameterSet */
  bestParamSet:       ParameterSet;
  /**
   * true  = TRAIN-OOS が LOW_SAMPLE 以上 → rankCandidates() で選択
   * false = TRAIN-OOS が INSUFFICIENT  → TESTをスキップ (skipped=true)
   */
  trainOOSRank1OK:    boolean;
  /** Rank1候補の TRAIN IS (80%) メトリクス */
  trainISMetrics:     OptimizationMetrics;
  /** Rank1候補の TRAIN OOS (20%) メトリクス — Rankingの実際の基準 */
  trainOOSMetrics:    OptimizationMetrics;

  // --- TEST (Walk Forward Validation) ---
  /** bestParamSetで TRAIN後のTEST期間を検証した結果 */
  testMetrics:        OptimizationMetrics;

  // --- Bar counts ---
  trainBarsCount:     number;   // TRAIN評価バー数 (warmup除く)
  testBarsCount:      number;   // TEST評価バー数 (warmup除く)
  warmupUsed:         number;   // 実際に付加したwarmup bufferバー数

  // --- Status ---
  /** TEST期間のtrade数に基づくサンプル品質 */
  sampleStatus:       SampleStatus;
  /** TRAIN-OOSのtrade数に基づくサンプル品質 (skipの判断に使用) */
  trainOOSStatus:     SampleStatus;
  /**
   * testMetrics.totalPips > 0 AND testMetrics.profitFactor >= 1.0
   * ConsistencyScore計算に使用
   */
  windowPassed:       boolean;
  /**
   * true = TRAIN-OOS INSUFFICIENTのためTESTを実行しなかった
   * testMetricsはゼロ値
   */
  skipped:            boolean;
}

// ------------------------------------------------------------------
// Walk Forward 全体結果
// ------------------------------------------------------------------

export interface WalkForwardResult {
  windows:               WalkForwardWindowResult[];
  /**
   * 0.0〜1.0 : 有効Windowのうち windowPassed の加重割合
   * null     : 有効Windowなし (全INCONCLUSIVE)
   * 重み: NORMAL=1.0, LOW_SAMPLE=0.5
   */
  consistencyScore:      number | null;
  /**
   * field → 0.0-1.0
   * 1.0 = 全Windowで同一値 (完全安定)
   * CV (変動係数) から計算: stability = 1 - CV
   */
  parameterStability:    Record<string, number>;
  /**
   * 各fieldのMode値 (最頻値) の組み合わせ
   * 注意: この組み合わせは必ずしもどこかのWindowのbestParamSetとは限らない
   *       ただしCartesian Product上は常に存在する有効な組み合わせ
   */
  recommendedParams:     ParameterSet | null;
  /**
   * 各field → {value: 値, windowCount: その値がbestだったWindow数}[]
   * UIでの表示用: "RSI=29 (3/5 windows)"
   */
  recommendedParamFreq:  Record<string, Array<{ value: number; windowCount: number }>>;
  verdict:               WalkForwardVerdict;
  /** INSUFFICIENT以外のWindow (TEST sampleStatus != INSUFFICIENT かつ skipped=false) */
  validWindowCount:      number;
  /** TEST sampleStatus == NORMAL のWindow */
  normalWindowCount:     number;
  /** windowPassed == true のWindow */
  positiveWindowCount:   number;
  /** TRAIN-OOS INSUFFICIENTによりスキップされたWindow */
  skippedWindowCount:    number;
  totalWindowCount:      number;
}

// ------------------------------------------------------------------
// Input
// ------------------------------------------------------------------

/** runWalkForward への入力 */
export interface WalkForwardInput {
  spec:                StrategySpec;
  symbol:              string;
  mainTimeframe:       string;
  /** 全期間の全 TF バー (Walk Forward Engine がWindow別にスライスする) */
  allBarsByTf:         Record<string, Bar[]>;
  parameterRanges:     ParameterRange[];
  trainMonths:         number;              // 1〜24
  testMonths:          number;              // 1〜12
  stepMonths?:         number;              // default = testMonths (Rolling)
  /** TRAIN内のIS/OOS分割比率 (Phase 4-A のdefaultと同じ 0.8) */
  inSampleRatio?:      number;
  initialBalance?:     number;
  fixedLot?:           number;
  /**
   * computeWarmup推定値に加算する追加バー数
   * period最適化による warmup増加を吸収するためのマージン
   */
  warmupSafetyMargin?: number;
}

// ------------------------------------------------------------------
// Config (内部計算用)
// ------------------------------------------------------------------

export interface WalkForwardConfig {
  trainMs: number;   // trainMonths × MONTH_MS
  testMs:  number;
  stepMs:  number;
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

export interface WFValidationResult {
  valid:    boolean;
  errors:   string[];
  warnings: string[];
}

export interface MinBarsCheckResult {
  valid:       boolean;
  minRequired: number;
  actual:      number;
  warmupEstimate: number;
}

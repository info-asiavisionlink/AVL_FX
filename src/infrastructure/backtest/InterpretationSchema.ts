// =================================================================
// InterpretationSchema.ts — Phase 4-D AI Interpretation の型定義
//
// Phase 4-D: Cross-Phase AI Interpretation
//
// 設計原則:
//   - Phase 3-A / 4-A / 4-B / 4-C の結果を横断的に解釈
//   - AI への入力 (InterpretationContext) と出力 (Phase4DInterpretation)
//   - Confidence は AI が生成しない → コードで決定論的に計算
//   - 全フェーズ Optional: 一部未実施でも動作 (Graceful Degradation)
//   - STRICTLY READ-ONLY: DB書き込みは strategy_phase4d_interpretations のみ
// =================================================================

import { z } from "zod";

// ------------------------------------------------------------------
// InterpretationContext — AI に渡す構造化コンテキスト
// ------------------------------------------------------------------

export interface InterpretationContext {
  // --- Strategy 基本情報 ---
  strategy: {
    name:       string;
    type:       string;
    symbol:     string;
    timeframe:  string;
    versionId:  string | null;
    versionNum: number | null;
  };

  // --- Phase 3-A: Backtest AI Analysis (optional) ---
  backtestAnalysis?: {
    verdict:           "PASSED" | "CONDITIONAL" | "FAILED";
    verdictReason:     string;
    totalPips:         number;
    winRate:           number;
    maxDrawdownPct:    number;
    profitFactor:      number | null;
    totalTrades:       number;
    dataCoverageDays:  number;
    sampleSizeWarning: boolean;
    /** Phase 3-A の上位 Facts (最大5件) */
    topFacts:          Array<{ statement: string; value: number | string | null }>;
    /** Phase 3-A の上位 Weaknesses (最大5件) */
    topWeaknesses:     Array<{ point: string }>;
    confidence:        number;
    dataQualityNote:   string;
  };

  // --- Phase 4-A: Optimization (optional) ---
  optimization?: {
    totalCombinations:    number;
    rank1TotalPips:       number;
    rank1ProfitFactor:    number | null;
    /** OOS totalPips / IS totalPips (null = IS pips がゼロ) */
    rank1DegradationRatio: number | null;
    rank1SampleStatus:    "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT";
    stableZoneCount:      number;
    robustCount:          number;
  };

  // --- Phase 4-B: Walk Forward (optional) ---
  walkForward?: {
    verdict:               "ROBUST" | "CONDITIONAL" | "OVERFIT" | "INCONCLUSIVE";
    consistencyScore:      number | null;
    /** 全 Parameter field の stability の平均値 */
    parameterStabilityAvg: number;
    totalWindowCount:      number;
    validWindowCount:      number;
    positiveWindowCount:   number;
    skippedWindowCount:    number;
  };

  // --- Phase 4-C: Monte Carlo (optional) ---
  monteCarlo?: {
    method:                         "TRADE_ORDER_SHUFFLE";
    iterations:                     number;
    tradeCount:                     number;
    drawdownThresholdPct:           number;
    originalFinalPips:              number;
    originalMaxDdPct:               number;
    /** P(simulation finalPips ≤ original) × 100 (0-100) */
    originalPercentileRank:         number;
    /** P(finalPips < 0): 0.0–1.0 */
    probabilityOfLoss:              number;
    /** P(maxDrawdownPct >= threshold): 0.0–1.0 */
    probabilityOfDrawdownThreshold: number;
    pipsP5:   number;
    pipsP25:  number;
    pipsP50:  number;
    pipsP75:  number;
    pipsP95:  number;
    ddP50:    number;
    ddP95:    number;
  };

  /** 実際に利用可能なフェーズ一覧 (AIがコンテキスト不足を認識するために使用) */
  availablePhases: Array<
    "BACKTEST_ANALYSIS" | "OPTIMIZATION" | "WALK_FORWARD" | "MONTE_CARLO"
  >;
}

// ------------------------------------------------------------------
// AI 出力スキーマ (Confidence はコードで計算するため AI は出力しない)
// ------------------------------------------------------------------

const PhaseEnum = z.enum([
  "BACKTEST_ANALYSIS",
  "OPTIMIZATION",
  "WALK_FORWARD",
  "MONTE_CARLO",
]);

const SynthesisTypeEnum = z.enum([
  "CONVERGENCE",
  "DIVERGENCE",
  "UNCERTAINTY",
]);

const RiskDimensionEnum = z.enum([
  "SEQUENCE_RISK",       // Monte Carlo 由来
  "OOS_GENERALIZATION",  // Walk Forward 由来
  "DRAWDOWN_RISK",       // Monte Carlo + Backtest
  "SAMPLE_QUALITY",      // データ量の問題
  "PARAMETER_STABILITY", // Walk Forward 由来
]);

/** フェーズ別 Observation */
export const PhaseObservationSchema = z.object({
  phase:          PhaseEnum,
  /** Factベースの1文 (予測禁止) */
  observation:    z.string().min(1).max(500),
  /** このObservationを支持するデータ (数値を含む) */
  supporting_data: z.string().min(1).max(300),
});

/** フェーズ横断 Synthesis */
export const CrossPhaseSynthesisItemSchema = z.object({
  type:             SynthesisTypeEnum,
  /** 複数フェーズにまたがる観察 (数値を含む) */
  observation:      z.string().min(1).max(600),
  phases_involved:  z.array(PhaseEnum).min(1).max(4),
});

/** リスク次元 */
export const RiskDimensionSchema = z.object({
  dimension:   RiskDimensionEnum,
  /** Factベースの評価 (断定・予測禁止) */
  assessment:  z.string().min(1).max(400),
  data_source: z.string().min(1).max(200),
});

/** AI が生成する解釈出力 (confidence はコード側で付与) */
export const Phase4DInterpretationAIOutputSchema = z.object({
  overall_assessment:    z.string().min(1).max(800),
  phase_observations:    z.array(PhaseObservationSchema).min(1).max(12),
  cross_phase_synthesis: z.array(CrossPhaseSynthesisItemSchema).min(0).max(6),
  risk_dimensions:       z.array(RiskDimensionSchema).min(1).max(5),
  /** 最低2件必須 */
  limitations:           z.array(z.string().min(1).max(300)).min(2).max(8),
  data_completeness_note: z.string().max(400),
});

/** DB 保存用スキーマ (confidence はコード側で付与) */
export const Phase4DInterpretationSchema = Phase4DInterpretationAIOutputSchema.extend({
  /** 決定論的に計算した Confidence (0-100) */
  confidence: z.number().int().min(0).max(100),
});

// ------------------------------------------------------------------
// TypeScript types
// ------------------------------------------------------------------

export type PhaseObservation        = z.infer<typeof PhaseObservationSchema>;
export type CrossPhaseSynthesisItem = z.infer<typeof CrossPhaseSynthesisItemSchema>;
export type RiskDimension           = z.infer<typeof RiskDimensionSchema>;
export type Phase4DInterpretationAIOutput = z.infer<typeof Phase4DInterpretationAIOutputSchema>;
export type Phase4DInterpretation   = z.infer<typeof Phase4DInterpretationSchema>;

// ------------------------------------------------------------------
// DB Record 型
// ------------------------------------------------------------------

export interface Phase4DInterpretationRecord {
  id:                     string;
  strategy_id:            string;
  strategy_version_id:    string | null;
  analysis_id:            string | null;
  wf_job_id:              string | null;
  mc_result_id:           string | null;
  opt_job_id:             string | null;
  available_phases:       string[];
  model:                  string;
  input_snapshot:         Record<string, unknown>;
  overall_assessment:     string;
  phase_observations:     PhaseObservation[];
  cross_phase_synthesis:  CrossPhaseSynthesisItem[];
  risk_dimensions:        RiskDimension[];
  limitations:            string[];
  confidence:             number;
  data_completeness_note: string;
  integrity_violations:   string[];
  created_at:             string;
}

// ------------------------------------------------------------------
// Integrity Validation Result
// ------------------------------------------------------------------

export interface IntegrityResult {
  valid:      boolean;
  violations: string[];
}

// =================================================================
// analysisSchema.ts — AI Analysis 出力の Zod バリデーション
//
// Phase 3-A: BacktestReport → OpenAI → StrategyAnalysis
//
// 設計原則:
//   - AI 出力がこの Schema に合格しなければ DB 保存しない
//   - FACT / OBSERVATION / HYPOTHESIS の分離を型レベルで強制
//   - confidence は 0-100 の整数値（AI の自己評価）
// =================================================================

import { z } from "zod";

// ------------------------------------------------------------------
// Sub-schemas
// ------------------------------------------------------------------

/** FACT: Backtest データから直接確認できる事実 */
export const FactItemSchema = z.object({
  statement: z.string().min(1).max(500),
  source:    z.string().min(1).max(100),  // "backtest_stats", "session_stats", etc.
  value:     z.union([z.string(), z.number()]).nullable().optional(),
});

/** OBSERVATION: FACT から観察できるパターン */
export const ObservationItemSchema = z.object({
  observation: z.string().min(1).max(500),
  basis:       z.string().min(1).max(500), // どの FACT に基づくか
  confidence:  z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
});

/** HYPOTHESIS: 原因の仮説（確定ではない） */
export const HypothesisItemSchema = z.object({
  hypothesis: z.string().min(1).max(500),
  rationale:  z.string().min(1).max(500),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
});

/** STRENGTH / WEAKNESS の共通構造 */
export const StrengthWeaknessItemSchema = z.object({
  point:  z.string().min(1).max(300),
  detail: z.string().max(500).optional(),
});

/** SESSION ANALYSIS エントリ */
export const SessionAnalysisItemSchema = z.object({
  session:        z.string().min(1).max(20),
  observation:    z.string().min(1).max(500),
  recommendation: z.string().max(300).optional(),
});

/** RISK ANALYSIS 全体 */
export const RiskAnalysisSchema = z.object({
  drawdown_assessment:     z.string().min(1).max(500),
  sl_tp_assessment:        z.string().min(1).max(500),
  consistency_assessment:  z.string().min(1).max(500),
  overall:                 z.string().min(1).max(300),
});

/** RECOMMENDATION エントリ */
export const RecommendationItemSchema = z.object({
  action:    z.string().min(1).max(400),
  rationale: z.string().max(300).optional(),
  priority:  z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
});

// ------------------------------------------------------------------
// Main schema — AI 出力全体の検証
// ------------------------------------------------------------------

export const StrategyAnalysisSchema = z.object({
  summary:          z.string().min(1).max(1000),

  facts:            z.array(FactItemSchema).min(1).max(20),
  observations:     z.array(ObservationItemSchema).min(1).max(15),
  hypotheses:       z.array(HypothesisItemSchema).min(0).max(10),
  weaknesses:       z.array(StrengthWeaknessItemSchema).min(0).max(10),
  strengths:        z.array(StrengthWeaknessItemSchema).min(0).max(10),
  session_analysis: z.array(SessionAnalysisItemSchema).min(0).max(10),
  risk_analysis:    RiskAnalysisSchema,
  recommendations:  z.array(RecommendationItemSchema).min(1).max(10),

  /** AI の自己評価 0-100。データが少ないほど低い値を期待 */
  confidence:       z.number().int().min(0).max(100),

  /** データ品質の注記（サンプル不足・期間短い等） */
  data_quality_note: z.string().max(500),
});

// ------------------------------------------------------------------
// TypeScript types
// ------------------------------------------------------------------

export type FactItem            = z.infer<typeof FactItemSchema>;
export type ObservationItem     = z.infer<typeof ObservationItemSchema>;
export type HypothesisItem      = z.infer<typeof HypothesisItemSchema>;
export type StrengthWeaknessItem = z.infer<typeof StrengthWeaknessItemSchema>;
export type SessionAnalysisItem = z.infer<typeof SessionAnalysisItemSchema>;
export type RiskAnalysis        = z.infer<typeof RiskAnalysisSchema>;
export type RecommendationItem  = z.infer<typeof RecommendationItemSchema>;

/** AI 分析の全出力 */
export type StrategyAnalysis = z.infer<typeof StrategyAnalysisSchema>;

// ------------------------------------------------------------------
// DB Record型 (strategy_ai_analyses テーブル)
// ------------------------------------------------------------------

export interface StrategyAIAnalysisRecord {
  id:               string;
  strategy_id:      string;
  job_id:           string;
  version:          number;
  input_snapshot:   Record<string, unknown>;
  model:            string;
  summary:          string;
  facts:            FactItem[];
  observations:     ObservationItem[];
  hypotheses:       HypothesisItem[];
  weaknesses:       StrengthWeaknessItem[];
  strengths:        StrengthWeaknessItem[];
  session_analysis: SessionAnalysisItem[];
  risk_analysis:    RiskAnalysis;
  recommendations:  RecommendationItem[];
  confidence:       number;
  data_quality_note: string;
  created_at:       string;
}

// ------------------------------------------------------------------
// Analysis Context型 (AI に渡す統計コンテキスト)
// ------------------------------------------------------------------

export interface TradeStat {
  count:     number;
  avgPips:   number;
  totalPips: number;
  avgDurationMin: number;
}

export interface RepresentativeTrade {
  label:        string;   // "Max Win", "Max Loss", "Shortest", "Longest", etc.
  direction:    "BUY" | "SELL";
  pips:         number;
  durationMin:  number;
  exitReason:   "TP" | "SL" | "END_OF_DATA";
  session:      string;
}

export interface AnalysisContext {
  // Strategy 情報
  strategyName:  string;
  strategyType:  string;
  symbols:       string[];
  timeframes:    string[];
  entryLogic:    string;    // "AND" / "OR"
  conditionCount: number;

  // 全体統計
  totalTrades:   number;
  wins:          number;
  losses:        number;
  breakevens:    number;
  winRate:       number;
  totalPips:     number;
  avgPips:       number;
  profitFactor:  number | null;

  // DD
  maxDrawdown:     number;
  maxDrawdownPct:  number;
  maxDrawdownPips: number;

  // Streak
  maxConsWins:   number;
  maxConsLosses: number;

  // Duration
  avgDurationMin: number;

  // Exit reason rates (%)
  tpHitRate:       number;
  slHitRate:       number;
  endOfDataRate:   number;

  // Direction stats
  buyStats:  TradeStat;
  sellStats: TradeStat;

  // Session stats (BacktestReport.sessionStats 由来)
  sessionStats: Record<string, {
    tradeCount:   number;
    wins?:        number;   // optional: backward compat
    losses?:      number;   // optional: backward compat
    winRate:      number;
    totalPips:    number;
    profitFactor: number | null;
  }>;
  bestSession:  string | null;
  worstSession: string | null;

  // Winning / Losing trade patterns
  winningStats: TradeStat;
  losingStats:  TradeStat;

  // Representative trades
  representativeTrades: RepresentativeTrade[];

  // Data quality
  dataCoverageDays: number;
  barCount:         number;
  sampleSizeWarning: boolean;
  verdict:          "PASSED" | "CONDITIONAL" | "FAILED";
  verdictReason:    string;
}

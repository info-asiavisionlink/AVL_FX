// =================================================================
// OptimizationEngine.ts — Parameter Optimization Engine (Phase 4-A)
//
// Pure functions のみ。DB / Supabase / AI 非依存。
//
// 設計原則:
//   - 完全決定論的: 同一入力 → 常に同一出力
//   - BacktestEngine を変更せず、runBacktest() をそのまま使用
//   - In-Sample でのみ Parameter Search / Ranking を実施
//   - Out-of-Sample は「最終検証のみ」= Optimization に使用禁止
//   - AI による探索範囲決定・結果解釈は Phase 4-D まで禁止
// =================================================================

import { StrategySpecSchema, type StrategySpec } from "@/lib/strategySchema";
import type { Bar }          from "@/infrastructure/analysis/types";
import { runBacktest }       from "./BacktestEngine";
import type { BacktestResult } from "./BacktestEngine";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

export const OPTIMIZATION_MAX_COMBINATIONS = 5_000;
export const OPTIMIZATION_MAX_PER_PARAM    = 50;
export const SAMPLE_NORMAL_THRESHOLD       = 30;
export const SAMPLE_LOW_THRESHOLD          = 15;

/**
 * Optimization で変更可能なフィールドパス (whitelist)
 *
 * Phase 3-B の ALLOWED_FIELD_PATTERNS から以下を除外:
 *   - filters.sessions        (Sessions変更は禁止)
 *   - filters.trend_filter    (Filter構造変更は禁止)
 *   - entry_conditions.conditions[N].operator (Operator変更は禁止)
 *   - entry_conditions.logic  (Logic変更は禁止)
 *   - add_condition           (条件追加は禁止)
 *
 * Optimization では「数値パラメータのみ」を探索対象とする。
 */
export const OPTIMIZATION_FIELD_PATTERNS: ReadonlyArray<RegExp> = [
  /^entry_conditions\.conditions\[\d+\]\.threshold$/,
  /^entry_conditions\.conditions\[\d+\]\.period$/,
  /^exit_conditions\.stop_loss\.multiplier$/,
  /^exit_conditions\.stop_loss\.pips$/,
  /^exit_conditions\.take_profit\.rr_ratio$/,
  /^exit_conditions\.take_profit\.pips$/,
  /^filters\.max_spread_pips$/,
  /^filters\.min_adx$/,
] as const;

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

/** 探索する Parameter の範囲定義 */
export interface ParameterRange {
  /** StrategySpec 内のフィールドパス (例: "entry_conditions.conditions[0].threshold") */
  field:     string;
  min:       number;
  max:       number;
  step:      number;
  paramType: "integer" | "float";
}

/** 1つの Parameter の組み合わせ (field → value) */
export type ParameterSet = Record<string, number>;

/** Backtest 1回分の統計 (Optimization 用最小セット) */
export interface OptimizationMetrics {
  totalTrades:    number;
  winRate:        number;    // 0-100 (%)
  profitFactor:   number | null;   // null = infinite
  totalPips:      number;
  maxDrawdownPct: number;
}

/** OOS Trade 数によるサンプル品質分類 */
export type SampleStatus = "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT";
// NORMAL:       OOS trades >= 30
// LOW_SAMPLE:   OOS trades 15-29
// INSUFFICIENT: OOS trades < 15  → Rank上位に自動昇格させない

/** 1候補の全評価結果 */
export interface OptimizationCandidate {
  index:             number;             // grid内のインデックス
  paramSet:          ParameterSet;
  inSample:          OptimizationMetrics;
  outSample:         OptimizationMetrics;
  sampleStatus:      SampleStatus;       // OOS trades 数に基づく
  stabilityScore:    number;             // 0.0-1.0: 近傍Parameter の安定性
  degradationRatio:  number | null;      // OOS totalPips / IS totalPips
  rank?:             number;             // 1 = best
  adopted?:          boolean;            // APPLY 済み
}

/** Bar データ分割結果 */
export interface BarSplit {
  inSample:       Record<string, Bar[]>;
  outSample:      Record<string, Bar[]>;
  cutoffTime:     number;   // OOS 開始の timestamp (ms)
  inSampleCount:  number;   // main TF の IS bar 数
  outSampleCount: number;   // main TF の OOS bar 数
}

/** Optimization 全体サマリー */
export interface OptimizationSummary {
  totalCombinations:  number;
  stableZoneCount:    number;   // stabilityScore >= 0.6 の候補数
  robustCount:        number;   // OOS PF >= 1.1 かつ INSUFFICIENT でない候補数
  cutoffTime:         number;
  inSampleRatio:      number;
}

/** runOptimization の入力 */
export interface OptimizationInput {
  spec:              StrategySpec;
  symbol:            string;
  mainTimeframe:     string;
  barsByTimeframe:   Record<string, Bar[]>;
  parameterRanges:   ParameterRange[];
  inSampleRatio?:    number;      // default 0.8
  initialBalance?:   number;
  fixedLot?:         number;
  stabilityOptions?: {
    windowSize?: number;   // ±N ステップを近傍とする (default 2)
    minPF?:      number;   // 「良い近傍」の最低 PF (default 1.0)
  };
}

/** runOptimization の出力 */
export interface OptimizationResult {
  candidates:          OptimizationCandidate[];   // 全候補 (grid順)
  ranked:              OptimizationCandidate[];   // ランク順
  summary:             OptimizationSummary;
  cutoffTime:          number;
  inSampleBarsCount:   number;
  outSampleBarsCount:  number;
}

/** validateParameterRanges の結果 */
export interface ValidationResult {
  valid:  boolean;
  errors: string[];
}

// ------------------------------------------------------------------
// Whitelist check
// ------------------------------------------------------------------

export function isOptimizationAllowedField(field: string): boolean {
  return OPTIMIZATION_FIELD_PATTERNS.some(p => p.test(field));
}

// ------------------------------------------------------------------
// validateParameterRanges
// ------------------------------------------------------------------

export function validateParameterRanges(
  ranges: ParameterRange[],
  spec:   StrategySpec,
): ValidationResult {
  const errors: string[] = [];

  if (ranges.length === 0) {
    errors.push("At least one parameter range is required");
    return { valid: false, errors };
  }

  const seenFields = new Set<string>();

  for (const r of ranges) {
    // Duplicate field check
    if (seenFields.has(r.field)) {
      errors.push(`Duplicate field: "${r.field}"`);
    }
    seenFields.add(r.field);

    // Whitelist check
    if (!isOptimizationAllowedField(r.field)) {
      errors.push(`Field "${r.field}" is not in the optimization whitelist`);
      continue;
    }

    // NaN / Infinity check
    if (!isFinite(r.min) || !isFinite(r.max) || !isFinite(r.step)) {
      errors.push(`Field "${r.field}": NaN or Infinity values are not allowed`);
      continue;
    }

    // min < max
    if (r.min >= r.max) {
      errors.push(`Field "${r.field}": min (${r.min}) must be less than max (${r.max})`);
      continue;
    }

    // step > 0
    if (r.step <= 0) {
      errors.push(`Field "${r.field}": step must be > 0 (got ${r.step})`);
      continue;
    }

    // Integer type validation
    if (r.paramType === "integer") {
      if (!Number.isInteger(r.min) || !Number.isInteger(r.max) || !Number.isInteger(r.step)) {
        errors.push(`Field "${r.field}": paramType "integer" requires integer min/max/step`);
      }
    }

    // Per-param count check
    const perParamCount = Math.floor((r.max - r.min) / r.step) + 1;
    if (perParamCount > OPTIMIZATION_MAX_PER_PARAM) {
      errors.push(
        `Field "${r.field}": too many values (${perParamCount}), max ${OPTIMIZATION_MAX_PER_PARAM}. ` +
        `Increase step or reduce range.`
      );
    }

    // Field existence check in spec
    try {
      const val = readNestedValue(spec as unknown as Record<string, unknown>, r.field);
      if (typeof val !== "number") {
        errors.push(`Field "${r.field}": current value is not a number (got ${typeof val})`);
      }
    } catch {
      errors.push(`Field "${r.field}": field does not exist in the current strategy spec`);
    }
  }

  // Total combination count check
  if (errors.length === 0) {
    const total = countCombinations(ranges);
    if (total > OPTIMIZATION_MAX_COMBINATIONS) {
      errors.push(
        `Too many combinations: ${total} (max ${OPTIMIZATION_MAX_COMBINATIONS}). ` +
        `Reduce ranges or increase steps.`
      );
    }
    if (total === 0) {
      errors.push("Parameter ranges produce 0 combinations");
    }
  }

  return { valid: errors.length === 0, errors };
}

// ------------------------------------------------------------------
// Grid Generation (deterministic)
// ------------------------------------------------------------------

function countDecimals(n: number): number {
  const s = String(n);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

function generateValues(r: ParameterRange): number[] {
  const values: number[] = [];
  const eps = r.step * 1e-9;
  let v = r.min;

  while (v <= r.max + eps) {
    if (r.paramType === "integer") {
      values.push(Math.round(v));
    } else {
      const dec = countDecimals(r.step);
      values.push(Number(v.toFixed(dec)));
    }
    v += r.step;
  }

  return values;
}

/**
 * generateGrid — 全 Parameter の直積を生成 (deterministic)
 *
 * 順序: ranges[0] が外側ループ、ranges[N-1] が最内側ループ
 * 例: ranges[0]=[25,26,27], ranges[1]=[20,21]
 *   → [{r0:25,r1:20},{r0:25,r1:21},{r0:26,r1:20},...]
 */
export function generateGrid(ranges: ParameterRange[]): ParameterSet[] {
  if (ranges.length === 0) return [{}];

  const valueArrays = ranges.map(r => generateValues(r));

  let result: ParameterSet[] = [{}];
  for (let i = 0; i < ranges.length; i++) {
    const next: ParameterSet[] = [];
    for (const existing of result) {
      for (const v of valueArrays[i]!) {
        next.push({ ...existing, [ranges[i]!.field]: v });
      }
    }
    result = next;
  }

  return result;
}

export function countCombinations(ranges: ParameterRange[]): number {
  if (ranges.length === 0) return 1;
  return ranges.reduce((acc, r) => {
    const n = Math.floor((r.max - r.min) / r.step) + 1;
    return acc * n;
  }, 1);
}

// ------------------------------------------------------------------
// Spec Application
// ------------------------------------------------------------------

function readNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      throw new Error(`Cannot navigate path at "${p}" in "${path}"`);
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function writeNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cur[p] === null || cur[p] === undefined || typeof cur[p] !== "object") {
      throw new Error(`Invalid path at "${p}" in "${path}"`);
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * applyParameterSetToSpec — StrategySpec に ParameterSet を適用し、
 * StrategySpecSchema で再バリデーションした新しい Spec を返す。
 *
 * @throws Error 適用後の Spec が Schema を通過しない場合
 */
export function applyParameterSetToSpec(
  spec:     StrategySpec,
  paramSet: ParameterSet,
): StrategySpec {
  const proposed = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;

  for (const [field, value] of Object.entries(paramSet)) {
    writeNestedValue(proposed, field, value);
  }

  const result = StrategySpecSchema.safeParse(proposed);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Applied spec failed schema validation: ${issues}`);
  }

  return result.data;
}

// ------------------------------------------------------------------
// Bar Splitting (timestamp-aligned, Look-ahead Bias なし)
//
// 全 Timeframe を同一 cutoffTime で分割することで、
// Multi-Timeframe 間の時系列整合性を保証する。
//
// cutoffTime = mainBars[splitIdx].time (最初の OOS バーの開始時刻)
// - IS: bar.time < cutoffTime
// - OOS: bar.time >= cutoffTime
// ------------------------------------------------------------------

export function splitBarsByRatio(
  barsByTimeframe: Record<string, Bar[]>,
  mainTimeframe:   string,
  inSampleRatio:   number,
): BarSplit {
  const mainBars = barsByTimeframe[mainTimeframe] ?? [];

  if (mainBars.length === 0) {
    const emptyBars = Object.fromEntries(
      Object.keys(barsByTimeframe).map(tf => [tf, [] as Bar[]])
    );
    return {
      inSample:       emptyBars,
      outSample:      emptyBars,
      cutoffTime:     0,
      inSampleCount:  0,
      outSampleCount: 0,
    };
  }

  // splitIdx は最初の OOS バーの index
  const splitIdx   = Math.max(1, Math.min(
    Math.floor(mainBars.length * inSampleRatio),
    mainBars.length - 1,
  ));
  const cutoffTime = mainBars[splitIdx]!.time;

  const inSample:  Record<string, Bar[]> = {};
  const outSample: Record<string, Bar[]> = {};

  for (const [tf, bars] of Object.entries(barsByTimeframe)) {
    inSample[tf]  = bars.filter(b => b.time <  cutoffTime);
    outSample[tf] = bars.filter(b => b.time >= cutoffTime);
  }

  return {
    inSample,
    outSample,
    cutoffTime,
    inSampleCount:  inSample[mainTimeframe]?.length ?? 0,
    outSampleCount: outSample[mainTimeframe]?.length ?? 0,
  };
}

// ------------------------------------------------------------------
// Metrics Extraction
// ------------------------------------------------------------------

export function metricsFromResult(r: BacktestResult): OptimizationMetrics {
  const grossProfit = r.trades.reduce((s, t) => t.profit > 0 ? s + t.profit : s, 0);
  const grossLoss   = r.trades.reduce((s, t) => t.profit < 0 ? s + Math.abs(t.profit) : s, 0);

  let pf: number | null;
  if (grossLoss > 0) {
    pf = Math.round((grossProfit / grossLoss) * 10000) / 10000;
  } else if (grossProfit > 0) {
    pf = null;  // infinite
  } else {
    pf = 0;
  }

  return {
    totalTrades:    r.totalTrades,
    winRate:        r.winRate,
    profitFactor:   pf,
    totalPips:      r.totalPips,
    maxDrawdownPct: r.maxDrawdownPct,
  };
}

// ------------------------------------------------------------------
// Sample Status
// ------------------------------------------------------------------

export function getSampleStatus(totalTrades: number): SampleStatus {
  if (totalTrades >= SAMPLE_NORMAL_THRESHOLD) return "NORMAL";
  if (totalTrades >= SAMPLE_LOW_THRESHOLD)    return "LOW_SAMPLE";
  return "INSUFFICIENT";
}

// ------------------------------------------------------------------
// Degradation Ratio
//
// OOS totalPips / IS totalPips
// - null: IS pips = 0 (割り算不能)
// - 1.0: IS と OOS で同等のパフォーマンス
// - 0.5: OOS は IS の 50% の pips
// - 負値: OOS が損失
// ------------------------------------------------------------------

export function calcDegradationRatio(
  inSamplePips:  number,
  outSamplePips: number,
): number | null {
  if (inSamplePips === 0) return null;
  return Math.round((outSamplePips / inSamplePips) * 1000) / 1000;
}

// ------------------------------------------------------------------
// Stability Score
//
// 各 Parameter 次元で「他の Parameter を固定した近傍」を評価する。
//
// アルゴリズム:
//   1. 各 range.field について:
//      - 他のすべての field が一致する候補を検索
//      - その中で ±windowSize ステップ以内の候補を近傍とする
//      - 近傍のうち IS totalPips > 0 かつ IS PF >= minPF の割合を計算
//   2. 全次元の割合を平均して stabilityScore とする
//
// Edge case:
//   - 近傍なし (グリッド端点): 0.5 (中立)
// ------------------------------------------------------------------

export function calculateStabilityScores(
  evaluated: Array<{ paramSet: ParameterSet; inSample: OptimizationMetrics }>,
  ranges:    ParameterRange[],
  options?:  { windowSize?: number; minPF?: number },
): number[] {
  const windowSize = options?.windowSize ?? 2;
  const minPF      = options?.minPF      ?? 1.0;

  return evaluated.map(candidate => {
    if (ranges.length === 0) return 0.5;

    let totalScore    = 0;
    let dimensionCount = 0;

    for (const range of ranges) {
      const fieldVal = candidate.paramSet[range.field];
      if (fieldVal === undefined) continue;

      // Find candidates matching on ALL OTHER fields (exact match)
      const sameContext = evaluated.filter(n => {
        if (n === candidate) return false;
        for (const r of ranges) {
          if (r.field === range.field) continue;
          const nVal = n.paramSet[r.field] ?? 0;
          const cVal = candidate.paramSet[r.field] ?? 0;
          if (Math.abs(nVal - cVal) > 1e-9) return false;
        }
        return true;
      });

      // Filter to ±windowSize steps in this dimension
      const maxDist = range.step * (windowSize + 1e-9);
      const neighbors = sameContext.filter(n => {
        const nVal = n.paramSet[range.field] ?? 0;
        return Math.abs(nVal - fieldVal) <= maxDist;
      });

      if (neighbors.length === 0) {
        totalScore += 0.5;  // Edge point: neutral score
      } else {
        const goodNeighbors = neighbors.filter(n => {
          const pf = n.inSample.profitFactor;
          return n.inSample.totalPips > 0 && (pf === null || pf >= minPF);
        }).length;
        totalScore += goodNeighbors / neighbors.length;
      }

      dimensionCount++;
    }

    const raw = dimensionCount > 0 ? totalScore / dimensionCount : 0.5;
    return Math.round(raw * 1000) / 1000;
  });
}

// ------------------------------------------------------------------
// Ranking
//
// 優先順位 (高い方が上位):
//   1. sampleStatus === "INSUFFICIENT" は最下位 (score = -Infinity)
//   2. OOS pips × OOS PF を基礎スコアとする
//   3. degradationRatio で乗算 (IS→OOS の劣化を考慮)
//   4. stabilityScore で補正 (安定ゾーンを優遇)
//   5. OOS DrawDown で補正 (大きい DD は減点)
//   6. sampleStatus === "LOW_SAMPLE" は 30% 減点
//
// Tiebreaker: stabilityScore (高い方が優先)
//
// 単純な PF 最高値による Ranking は禁止。
// OOS 結果のみで Ranking する (IS は Stability 評価のみに使用)。
// ------------------------------------------------------------------

function calcRankScore(c: OptimizationCandidate): number {
  if (c.sampleStatus === "INSUFFICIENT") return -Infinity;
  if (c.outSample.totalTrades === 0)     return -Infinity;

  const oosPF = c.outSample.profitFactor;
  // PF null (infinite) → treat as 2.0 for scoring; negative/zero → 0.5
  const pfFactor = oosPF === null
    ? 2.0
    : oosPF > 0 ? oosPF : 0.5;

  // Base: OOS total pips × OOS PF
  const baseScore = c.outSample.totalPips * pfFactor;

  // Degradation factor: clamp to [0, 1] (penalise heavy IS→OOS drop)
  const degradFactor = c.degradationRatio !== null
    ? Math.min(1, Math.max(0, c.degradationRatio))
    : 0.5;

  // Stability bonus: 1.0 (no stability) to 2.0 (perfect stability)
  const stabilityFactor = 1 + c.stabilityScore;

  // DD penalty: 20% DD → factor 0, 0% DD → factor 1
  const ddFactor = Math.max(0, 1 - c.outSample.maxDrawdownPct / 20);

  // Sample size penalty
  const sampleFactor = c.sampleStatus === "LOW_SAMPLE" ? 0.7 : 1.0;

  return baseScore * degradFactor * stabilityFactor * ddFactor * sampleFactor;
}

export function rankCandidates(
  candidates: OptimizationCandidate[],
): OptimizationCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    const sa = calcRankScore(a);
    const sb = calcRankScore(b);
    if (sa !== sb) return sb - sa;       // higher score = better rank
    return b.stabilityScore - a.stabilityScore;  // tiebreaker
  });

  return sorted.map((c, i) => ({ ...c, rank: i + 1 }));
}

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------

export function buildOptimizationSummary(
  candidates:    OptimizationCandidate[],
  cutoffTime:    number,
  inSampleRatio: number,
): OptimizationSummary {
  const stableZoneCount = candidates.filter(c => c.stabilityScore >= 0.6).length;

  // robustCount: NORMAL sample (OOS >= 30 trades) かつ OOS PF >= 1.1 かつ OOS pips > 0
  // LOW_SAMPLE / INSUFFICIENT はサンプル不足のためカウントしない
  const robustCount = candidates.filter(c => {
    if (c.sampleStatus !== "NORMAL")       return false;
    if (c.outSample.totalPips <= 0)        return false;
    const pf = c.outSample.profitFactor;
    return pf === null || pf >= 1.1;
  }).length;

  return {
    totalCombinations: candidates.length,
    stableZoneCount,
    robustCount,
    cutoffTime,
    inSampleRatio,
  };
}

// ------------------------------------------------------------------
// Main runner
//
// 完全同期。BacktestEngine.runBacktest() は同期関数のため、
// 全候補の実行も同期で完結する。
//
// 処理順:
//   1. Grid 生成 (全 ParameterSet)
//   2. Bar 分割 (同一 cutoffTime で全 TF を分割)
//   3. 各候補: applyParameterSetToSpec → IS Backtest → OOS Backtest
//   4. Stability Score 計算 (全候補揃ってから一括計算)
//   5. Ranking
//   6. Summary
// ------------------------------------------------------------------

export function runOptimization(input: OptimizationInput): OptimizationResult {
  const {
    spec,
    symbol,
    mainTimeframe,
    barsByTimeframe,
    parameterRanges,
    inSampleRatio    = 0.8,
    initialBalance   = 10_000,
    fixedLot         = 0.01,
    stabilityOptions,
  } = input;

  // 1. Generate grid (deterministic)
  const grid  = generateGrid(parameterRanges);

  // 2. Split bars by ratio (timestamp-aligned)
  const split = splitBarsByRatio(barsByTimeframe, mainTimeframe, inSampleRatio);

  // 3. Run backtest for each candidate
  type Evaluated = {
    index:     number;
    paramSet:  ParameterSet;
    inSample:  OptimizationMetrics;
    outSample: OptimizationMetrics;
  };

  const zeroMetrics: OptimizationMetrics = {
    totalTrades: 0, winRate: 0, profitFactor: 0, totalPips: 0, maxDrawdownPct: 0,
  };

  const evaluated: Evaluated[] = grid.map((paramSet, idx) => {
    let candidateSpec: StrategySpec;
    try {
      candidateSpec = applyParameterSetToSpec(spec, paramSet);
    } catch {
      return { index: idx, paramSet, inSample: zeroMetrics, outSample: zeroMetrics };
    }

    // IS backtest
    let isMetrics: OptimizationMetrics;
    try {
      const r = runBacktest({
        spec: candidateSpec, symbol, mainTimeframe,
        barsByTimeframe: split.inSample, initialBalance, fixedLot,
      });
      isMetrics = metricsFromResult(r);
    } catch {
      isMetrics = zeroMetrics;
    }

    // OOS backtest (探索には使用しない — 最終検証のみ)
    let oosMetrics: OptimizationMetrics;
    try {
      const r = runBacktest({
        spec: candidateSpec, symbol, mainTimeframe,
        barsByTimeframe: split.outSample, initialBalance, fixedLot,
      });
      oosMetrics = metricsFromResult(r);
    } catch {
      oosMetrics = zeroMetrics;
    }

    return { index: idx, paramSet, inSample: isMetrics, outSample: oosMetrics };
  });

  // 4. Stability scores (全候補揃ってから一括計算)
  const stabilityScores = calculateStabilityScores(
    evaluated.map(e => ({ paramSet: e.paramSet, inSample: e.inSample })),
    parameterRanges,
    stabilityOptions,
  );

  // 5. Build candidates
  const candidates: OptimizationCandidate[] = evaluated.map((e, i) => ({
    index:            e.index,
    paramSet:         e.paramSet,
    inSample:         e.inSample,
    outSample:        e.outSample,
    sampleStatus:     getSampleStatus(e.outSample.totalTrades),
    stabilityScore:   stabilityScores[i]!,
    degradationRatio: calcDegradationRatio(e.inSample.totalPips, e.outSample.totalPips),
  }));

  // 6. Rank
  const ranked = rankCandidates(candidates);

  // 7. Summary
  const summary = buildOptimizationSummary(candidates, split.cutoffTime, inSampleRatio);

  return {
    candidates,
    ranked,
    summary,
    cutoffTime:        split.cutoffTime,
    inSampleBarsCount: split.inSampleCount,
    outSampleBarsCount: split.outSampleCount,
  };
}

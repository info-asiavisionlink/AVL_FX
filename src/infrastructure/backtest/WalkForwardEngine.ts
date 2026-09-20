// =================================================================
// WalkForwardEngine.ts — Walk Forward Validation Engine (Phase 4-B)
//
// Pure functions のみ。DB / Supabase / AI 非依存。
//
// 設計原則:
//   1. Data Leakage 完全防止
//      - TEST barsをOptimizationへ渡さない
//      - Window N TEST結果をWindow N+1 Optimizationへフィードバックしない
//   2. Warmup Buffer
//      - 各Window(TRAIN/TEST)にEvaluation期間前の過去barを付加
//      - Indicator初期化精度を向上 (EMA200等)
//      - Look-ahead Bias なし: bufferはすべて過去データ
//   3. TRAIN-OOS INSUFFICIENT → Window skip (IS Fallback禁止)
//      - IS Fallbackは過剰最適化を再導入するため禁止
//   4. Rolling Windowのtimestampオーバーラップは正常仕様
//      - Window N+1 TRAINにWindow N TESTのbar(価格データ)が含まれるのは正常
//      - 禁止はWindow N TEST結果(メトリクス/パラメータ選択)への影響のみ
//   5. 完全決定論的: 同一入力 → 同一出力
// =================================================================

import type { StrategySpec }    from "@/lib/strategySchema";
import type { Bar }             from "@/infrastructure/analysis/types";
import { WARMUP_BARS }          from "./types";
import {
  runOptimization,
  applyParameterSetToSpec,
  getSampleStatus,
  countCombinations,
  validateParameterRanges,
  OPTIMIZATION_MAX_COMBINATIONS,
  SAMPLE_NORMAL_THRESHOLD,
  SAMPLE_LOW_THRESHOLD,
  type ParameterRange,
  type ParameterSet,
  type OptimizationMetrics,
  type SampleStatus,
} from "./OptimizationEngine";
import { runBacktest, BacktestError } from "./BacktestEngine";
import type { BacktestTrade }   from "./BacktestEngine";
import type {
  WalkForwardWindow,
  WalkForwardWindowResult,
  WalkForwardResult,
  WalkForwardInput,
  WalkForwardConfig,
  WFValidationResult,
  MinBarsCheckResult,
  WalkForwardVerdict,
} from "./WalkForwardSchema";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** 1ヶ月 = 30日 (既存 PERIOD_DAYS と同じ規約: "1M": 30) */
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export const WF_MAX_WINDOWS           = 30;
/** Phase 4-Aの5000より厳格: Window数×組み合わせで300s以内を保証 */
export const WF_MAX_COMBINATIONS      = 200;
/** computeWarmup推定値に加えるデフォルト安全マージン */
export const WF_WARMUP_SAFETY_MARGIN  = 50;
/** TEST検証で必要な最低評価バー数 (warmup後) */
export const WF_MIN_EVAL_BARS         = 50;

// ------------------------------------------------------------------
// Zero metrics sentinel
// ------------------------------------------------------------------

const ZERO_METRICS: OptimizationMetrics = {
  totalTrades: 0, winRate: 0, profitFactor: 0, totalPips: 0, maxDrawdownPct: 0,
};

// ------------------------------------------------------------------
// Warmup Estimation
// ------------------------------------------------------------------

/**
 * Spec + ParameterRanges から必要な最大 Warmup バー数を推定する。
 *
 * BacktestEngine の computeWarmup() は private なので、同等ロジックを実装。
 * period を最適化する場合 (field: "*.period") は max period でwarmupを計算する。
 */
export function estimateMaxWarmup(
  spec:              StrategySpec,
  parameterRanges:   ParameterRange[],
  safetyMargin = WF_WARMUP_SAFETY_MARGIN,
): number {
  const indicators = new Set<string>();
  let maxEmaPeriod = 21;

  // Base spec indicators
  for (const c of spec.entry_conditions.conditions) {
    indicators.add(c.indicator);
    if (c.indicator === "EMA" && c.period) maxEmaPeriod = Math.max(maxEmaPeriod, c.period);
  }
  if (spec.filters?.trend_filter) {
    indicators.add(spec.filters.trend_filter.indicator);
    if (spec.filters.trend_filter.indicator === "EMA" && spec.filters.trend_filter.period) {
      maxEmaPeriod = Math.max(maxEmaPeriod, spec.filters.trend_filter.period);
    }
  }

  let warmup = WARMUP_BARS.atr(14); // ATR常時使用

  for (const ind of indicators) {
    switch (ind) {
      case "EMA":            warmup = Math.max(warmup, maxEmaPeriod - 1); break;
      case "SMA":            warmup = Math.max(warmup, WARMUP_BARS.sma(50)); break;
      case "RSI":            warmup = Math.max(warmup, WARMUP_BARS.rsi(14)); break;
      case "MACD":           warmup = Math.max(warmup, WARMUP_BARS.macd(26, 9)); break;
      case "ADX":            warmup = Math.max(warmup, WARMUP_BARS.adx(14)); break;
      case "BOLLINGER_BANDS":warmup = Math.max(warmup, WARMUP_BARS.bb(20)); break;
      case "STOCHASTIC":     warmup = Math.max(warmup, WARMUP_BARS.stoch(14)); break;
    }
  }

  // period最適化によるwarmup増加を考慮
  // "entry_conditions.conditions[N].period" が範囲探索される場合、
  // max periodでの warmup を推定して加算
  for (const range of parameterRanges) {
    const condMatch = range.field.match(/^entry_conditions\.conditions\[(\d+)\]\.period$/);
    if (!condMatch) continue;

    const idx = parseInt(condMatch[1]!, 10);
    const cond = spec.entry_conditions.conditions[idx];
    if (!cond) continue;

    const maxPeriod = Math.ceil(range.max);
    let periodWarmup = 0;
    switch (cond.indicator) {
      case "EMA":            periodWarmup = maxPeriod - 1; break;
      case "SMA":            periodWarmup = maxPeriod - 1; break;
      case "RSI":            periodWarmup = maxPeriod;     break;
      case "ADX":            periodWarmup = 2 * maxPeriod - 1; break;
      case "BOLLINGER_BANDS":periodWarmup = maxPeriod - 1; break;
      case "STOCHASTIC":     periodWarmup = maxPeriod - 1; break;
    }
    warmup = Math.max(warmup, periodWarmup);
  }

  return warmup + safetyMargin;
}

/**
 * TRAIN / TEST 期間が warmup + 最低評価barを満たすか確認する。
 */
export function checkMinBarsForWarmup(
  mainBarsCount: number,
  warmupNeeded:  number,
  minEvalBars = WF_MIN_EVAL_BARS,
): MinBarsCheckResult {
  const minRequired = warmupNeeded + minEvalBars;
  return {
    valid:          mainBarsCount > minRequired,
    minRequired,
    actual:         mainBarsCount,
    warmupEstimate: warmupNeeded,
  };
}

// ------------------------------------------------------------------
// Adjusted IS Ratio
//
// warmup buffer bars を TRAIN IS に付加した場合、
// splitBarsByRatio の分割点がTRAIN評価期間の80%に来るよう調整する。
//
// 数学的保証:
//   combined = [...warmupBars(W), ...trainEvalBars(T)]
//   splitIdx = W + floor(T * targetRatio)
//   adjustedRatio = splitIdx / (W + T)
//   → floor((W+T) * adjustedRatio) = splitIdx ✓
// ------------------------------------------------------------------

export function computeAdjustedISRatio(
  warmupLen:    number,
  trainLen:     number,
  targetRatio:  number,
): number {
  if (warmupLen === 0) return targetRatio;
  const totalLen     = warmupLen + trainLen;
  const targetSplitIdx = warmupLen + Math.floor(trainLen * targetRatio);
  const adjusted = targetSplitIdx / totalLen;
  // inSampleRatio は (0, 1) exclusive (DBの CHECK制約と整合)
  return Math.min(0.99, Math.max(0.01, adjusted));
}

// ------------------------------------------------------------------
// Window Generation
// ------------------------------------------------------------------

/**
 * generateWalkForwardWindows — Rolling Window を生成する (deterministic)
 *
 * 設計:
 *   Window 0: trainFrom=firstBar.time, trainTo=trainFrom+trainMs
 *   Window 1: trainFrom += stepMs
 *   ...
 *
 * 終了条件: testTo > lastBar.time + testMs * 0.5
 *   (最後のWindowのTESTにデータが半分未満しかない場合は作らない)
 *
 * Rolling OverlapはData Leakageではない:
 *   Window N+1 のTRAINがWindow N のTEST期間と重複するのは正常。
 *   禁止はWindow N TEST結果をWindow N+1のOptimization inputに使うことのみ。
 */
export function generateWalkForwardWindows(
  mainBars:   Bar[],
  config:     WalkForwardConfig,
  maxWindows = WF_MAX_WINDOWS,
): WalkForwardWindow[] {
  if (mainBars.length < 2) return [];

  const { trainMs, testMs, stepMs } = config;
  const firstTime = mainBars[0]!.time;
  const lastTime  = mainBars[mainBars.length - 1]!.time;

  // 最低限必要な期間: train + test
  if (lastTime - firstTime < trainMs + testMs) return [];

  const windows: WalkForwardWindow[] = [];
  let trainFrom = firstTime;
  let windowIndex = 0;

  while (windowIndex < maxWindows) {
    const trainTo = trainFrom + trainMs;
    const testTo  = trainTo   + testMs;

    // TESTの終端が利用可能データの後半 0.5 testMs 以降に入る場合は終了
    if (testTo > lastTime + testMs * 0.5) break;

    windows.push({
      windowIndex,
      trainFrom,
      trainTo,
      testFrom: trainTo,
      testTo,
    });

    windowIndex++;
    trainFrom += stepMs;
  }

  return windows;
}

// ------------------------------------------------------------------
// Bar Slicing with Warmup Buffer
//
// Look-ahead Bias 防止:
//   TRAIN buffer: time < trainFrom の最新N本 (過去データのみ)
//   TEST  buffer: time < testFrom  の最新N本 (= TRAINバーの末尾 = 過去データ)
//
// 全Timeframeで同一のtimestamp境界を使用 (splitBarsByRatioと同じ原則)。
// ------------------------------------------------------------------

/**
 * TRAIN評価バー + warmup buffer バーを返す。
 * buffer = trainFrom より前の最新 warmupBars 本 (すべて過去データ)
 */
export function sliceTrainBarsWithBuffer(
  allBarsByTf: Record<string, Bar[]>,
  trainFrom:   number,
  trainTo:     number,
  warmupBars:  number,
): Record<string, Bar[]> {
  const result: Record<string, Bar[]> = {};
  for (const [tf, bars] of Object.entries(allBarsByTf)) {
    const preBars  = bars.filter(b => b.time < trainFrom);
    const evalBars = bars.filter(b => b.time >= trainFrom && b.time < trainTo);
    const bufBars  = preBars.slice(-warmupBars);  // 最新N本
    result[tf] = [...bufBars, ...evalBars];
  }
  return result;
}

/**
 * TEST評価バー + warmup buffer バーを返す。
 * buffer = testFrom (= trainTo) より前の最新 warmupBars 本 (TRAINバー末尾)
 * これらはすべてTEST期間に対して過去データ → Look-ahead Bias なし
 */
export function sliceTestBarsWithBuffer(
  allBarsByTf: Record<string, Bar[]>,
  testFrom:    number,
  testTo:      number,
  warmupBars:  number,
): Record<string, Bar[]> {
  const result: Record<string, Bar[]> = {};
  for (const [tf, bars] of Object.entries(allBarsByTf)) {
    const preBars  = bars.filter(b => b.time < testFrom);
    const evalBars = bars.filter(b => b.time >= testFrom && b.time < testTo);
    const bufBars  = preBars.slice(-warmupBars);  // TRAINバー末尾 = 過去データ
    result[tf] = [...bufBars, ...evalBars];
  }
  return result;
}

// ------------------------------------------------------------------
// Trade Filtering & Metrics Recomputation
//
// BacktestEngineにwarmup buffer付きのbarsを渡すと、
// warmup < bufferLen の場合、buffer期間中にもTradeが生成される。
// (BacktestEngineはbars[warmup]から評価開始)
//
// → warmup buffer期間のTradeをMetricsから除外するため、
//   evalFrom以降のTradeのみでMetricsを再計算する。
// ------------------------------------------------------------------

/**
 * BacktestEngine出力のtrades[]からevalFrom以降のTradeだけを返す。
 * Walk Forward TESTでwarmup buffer期間のTradeを除外するために使用。
 */
export function filterTradesToPeriod(
  trades:   BacktestTrade[],
  fromTime: number,
): BacktestTrade[] {
  return trades.filter(t => t.entryTime >= fromTime);
}

/**
 * Trade[]からOptimizationMetricsを再計算する。
 * (metricsFromResult()はBacktestResult全体を受け取るが、
 *  こちらはフィルタ済みTrades[]から直接計算する)
 */
export function recomputeMetricsFromTrades(
  trades:         BacktestTrade[],
  initialBalance: number,
): OptimizationMetrics {
  if (trades.length === 0) return { ...ZERO_METRICS };

  const wins = trades.filter(t => t.result === "WIN").length;
  const totalPips = Math.round(
    trades.reduce((s, t) => s + t.pips, 0) * 10
  ) / 10;

  const grossProfit = trades.reduce((s, t) => t.profit > 0 ? s + t.profit : s, 0);
  const grossLoss   = trades.reduce((s, t) => t.profit < 0 ? s + Math.abs(t.profit) : s, 0);

  let pf: number | null;
  if (grossLoss > 0) {
    pf = Math.round(grossProfit / grossLoss * 10000) / 10000;
  } else if (grossProfit > 0) {
    pf = null;  // infinite
  } else {
    pf = 0;
  }

  // MaxDrawdownPct: running balance から計算
  let balance = initialBalance;
  let peak    = initialBalance;
  let maxDD   = 0;
  for (const t of trades) {
    balance += t.profit;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownPct = peak > 0 ? Math.round(maxDD / peak * 10000) / 100 : 0;

  return {
    totalTrades:    trades.length,
    winRate:        Math.round(wins / trades.length * 10000) / 100,
    profitFactor:   pf,
    totalPips,
    maxDrawdownPct,
  };
}

// ------------------------------------------------------------------
// Window Execution
//
// 1 Window の TRAIN Optimization + TEST Validation を実行。
//
// TRAIN-OOS INSUFFICIENT → skip (仕様書の要件):
//   "ISだけを利用してBest Candidateを選択するFallbackは禁止"
//   IS Fallbackは過剰最適化リスクを再導入するため
// ------------------------------------------------------------------

function makeSkippedWindowResult(
  window:      WalkForwardWindow,
  warmupUsed:  number,
  trainBarsCount: number,
  reason: string,
  bestParamSet: ParameterSet,
  trainISMetrics: OptimizationMetrics,
  trainOOSMetrics: OptimizationMetrics,
  trainOOSStatus: SampleStatus,
): WalkForwardWindowResult {
  void reason; // for documentation only
  return {
    ...window,
    bestParamSet,
    trainOOSRank1OK:  false,
    trainISMetrics,
    trainOOSMetrics,
    testMetrics:      { ...ZERO_METRICS },
    trainBarsCount,
    testBarsCount:    0,
    warmupUsed,
    sampleStatus:     "INSUFFICIENT",
    trainOOSStatus,
    windowPassed:     false,
    skipped:          true,
  };
}

/** 最もシンプルなスキップ結果 (Optimization自体が失敗した場合) */
function makeHardSkip(
  window: WalkForwardWindow,
  warmupUsed = 0,
): WalkForwardWindowResult {
  const empty: ParameterSet = {};
  return {
    ...window,
    bestParamSet:     empty,
    trainOOSRank1OK:  false,
    trainISMetrics:   { ...ZERO_METRICS },
    trainOOSMetrics:  { ...ZERO_METRICS },
    testMetrics:      { ...ZERO_METRICS },
    trainBarsCount:   0,
    testBarsCount:    0,
    warmupUsed,
    sampleStatus:     "INSUFFICIENT",
    trainOOSStatus:   "INSUFFICIENT",
    windowPassed:     false,
    skipped:          true,
  };
}

export function runWalkForwardWindow(
  window:           WalkForwardWindow,
  spec:             StrategySpec,
  symbol:           string,
  mainTimeframe:    string,
  allBarsByTf:      Record<string, Bar[]>,
  parameterRanges:  ParameterRange[],
  warmupBufSize:    number,
  inSampleRatio:    number,
  initialBalance:   number,
  fixedLot:         number,
): WalkForwardWindowResult {
  const { trainFrom, trainTo, testFrom, testTo } = window;

  // ── Step 1: TRAIN bars with warmup buffer ──────────────────────
  const trainWithBuf = sliceTrainBarsWithBuffer(
    allBarsByTf, trainFrom, trainTo, warmupBufSize
  );

  const mainTrainWithBuf = trainWithBuf[mainTimeframe] ?? [];
  // warmup buffer = time < trainFrom
  const actualWarmupLen = mainTrainWithBuf.filter(b => b.time < trainFrom).length;
  const trainEvalBars   = mainTrainWithBuf.filter(b => b.time >= trainFrom && b.time < trainTo);
  const trainEvalCount  = trainEvalBars.length;

  // ── Step 2: Adjusted IS ratio (warmup buffer を考慮) ──────────
  const adjustedISRatio = computeAdjustedISRatio(
    actualWarmupLen, trainEvalCount, inSampleRatio
  );

  // ── Step 3: Optimization on TRAIN (with warmup buffer) ──────
  let optResult;
  try {
    optResult = runOptimization({
      spec,
      symbol,
      mainTimeframe,
      barsByTimeframe:  trainWithBuf,
      parameterRanges,
      inSampleRatio:    adjustedISRatio,
      initialBalance,
      fixedLot,
    });
  } catch {
    // Optimization完全失敗 (Bar不足等) → Window skip
    return makeHardSkip(window, actualWarmupLen);
  }

  const best = optResult.ranked[0];
  if (!best) return makeHardSkip(window, actualWarmupLen);

  // ── Step 4: TRAIN-OOS sample check ────────────────────────────
  const trainOOSStatus = getSampleStatus(best.outSample.totalTrades);

  // 仕様: TRAIN-OOS INSUFFICIENT → TESTスキップ (IS Fallback禁止)
  if (trainOOSStatus === "INSUFFICIENT") {
    return makeSkippedWindowResult(
      window, actualWarmupLen, trainEvalCount,
      "TRAIN-OOS INSUFFICIENT",
      best.paramSet, best.inSample, best.outSample,
      trainOOSStatus,
    );
  }

  // ── Step 5: TEST bars with warmup buffer ───────────────────────
  // buffer = testFromより前の最新N本 = TRAINバー末尾 (過去データのみ)
  const testWithBuf = sliceTestBarsWithBuffer(
    allBarsByTf, testFrom, testTo, warmupBufSize
  );
  const mainTestWithBuf = testWithBuf[mainTimeframe] ?? [];
  const testEvalCount   = mainTestWithBuf.filter(b => b.time >= testFrom && b.time < testTo).length;

  // ── Step 6: Apply best param set to spec ──────────────────────
  let bestSpec: StrategySpec;
  try {
    bestSpec = applyParameterSetToSpec(spec, best.paramSet);
  } catch {
    return makeSkippedWindowResult(
      window, actualWarmupLen, trainEvalCount,
      "applyParameterSetToSpec failed",
      best.paramSet, best.inSample, best.outSample,
      trainOOSStatus,
    );
  }

  // ── Step 7: TEST backtest with warmup buffer ───────────────────
  let testMetrics: OptimizationMetrics = { ...ZERO_METRICS };

  try {
    const testResult = runBacktest({
      spec:            bestSpec,
      symbol,
      mainTimeframe,
      barsByTimeframe: testWithBuf,
      initialBalance,
      fixedLot,
    });

    // warmup buffer期間(time < testFrom)のTradeを除外
    // BacktestEngineがbars[warmup]から評価開始するため、
    // warmup < warmupBufLen の場合にbuffer期間のTradeが生成される
    const testTrades = filterTradesToPeriod(testResult.trades, testFrom);
    testMetrics = recomputeMetricsFromTrades(testTrades, initialBalance);

  } catch (err) {
    if (!(err instanceof BacktestError)) throw err;
    // BacktestError (bars不足等) → testMetrics = ZERO → INSUFFICIENT
  }

  const sampleStatus = getSampleStatus(testMetrics.totalTrades);
  const windowPassed =
    testMetrics.totalPips > 0 &&
    (testMetrics.profitFactor === null ||
     (testMetrics.profitFactor !== null && testMetrics.profitFactor >= 1.0));

  return {
    ...window,
    bestParamSet:      best.paramSet,
    trainOOSRank1OK:   true,
    trainISMetrics:    best.inSample,
    trainOOSMetrics:   best.outSample,
    testMetrics,
    trainBarsCount:    trainEvalCount,
    testBarsCount:     testEvalCount,
    warmupUsed:        actualWarmupLen,
    sampleStatus,
    trainOOSStatus,
    windowPassed,
    skipped:           false,
  };
}

// ------------------------------------------------------------------
// Aggregation Functions
// ------------------------------------------------------------------

/**
 * ConsistencyScore
 *
 * 有効Window (skipped=false かつ TEST sampleStatus != INSUFFICIENT) のうち
 * windowPassed の加重割合。
 * 重み: NORMAL=1.0, LOW_SAMPLE=0.5
 *
 * null = 有効Windowなし
 */
export function calcConsistencyScore(
  windows: WalkForwardWindowResult[],
): number | null {
  const valid = windows.filter(w => !w.skipped && w.sampleStatus !== "INSUFFICIENT");
  if (valid.length === 0) return null;

  let totalWeight    = 0;
  let positiveWeight = 0;

  for (const w of valid) {
    const weight = w.sampleStatus === "NORMAL" ? 1.0 : 0.5;
    totalWeight    += weight;
    if (w.windowPassed) positiveWeight += weight;
  }

  return totalWeight > 0 ? Math.round(positiveWeight / totalWeight * 1000) / 1000 : null;
}

/**
 * Cross-Window Parameter Stability
 *
 * 各fieldについて、有効WindowのbestParamSet値の変動係数(CV = σ/μ)を計算。
 * stability = max(0, 1 - CV)
 * 1.0 = 全Window同一値 (完全安定)
 * <0.7 = 不安定
 */
export function calcParameterStability(
  windows: WalkForwardWindowResult[],
): Record<string, number> {
  const valid = windows.filter(w => !w.skipped && w.sampleStatus !== "INSUFFICIENT");

  const fieldValues: Record<string, number[]> = {};
  for (const w of valid) {
    for (const [field, val] of Object.entries(w.bestParamSet)) {
      fieldValues[field] ??= [];
      fieldValues[field]!.push(val);
    }
  }

  const stability: Record<string, number> = {};
  for (const [field, values] of Object.entries(fieldValues)) {
    if (values.length < 2) { stability[field] = 1.0; continue; }

    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    if (mean === 0) { stability[field] = 1.0; continue; }

    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const cv       = Math.sqrt(variance) / Math.abs(mean);

    stability[field] = Math.round(Math.max(0, Math.min(1, 1 - cv)) * 1000) / 1000;
  }

  return stability;
}

/**
 * Recommended Parameters — Mode per Field
 *
 * 各fieldの最頻値の組み合わせ。
 * 同数の場合はtiebreaker = 最新Window (最後の出現値)。
 *
 * 注意: この組み合わせはどこかのWindowのbestParamSetとは限らない。
 * ただしGridはCartesian Productのため必ずGrid内に存在する有効な組み合わせ。
 */
export function selectRecommendedParams(
  windows: WalkForwardWindowResult[],
): ParameterSet | null {
  const valid = windows.filter(w => !w.skipped && w.sampleStatus !== "INSUFFICIENT");
  if (valid.length === 0) return null;

  const fieldValues: Record<string, number[]> = {};
  for (const w of valid) {
    for (const [field, val] of Object.entries(w.bestParamSet)) {
      fieldValues[field] ??= [];
      fieldValues[field]!.push(val);
    }
  }

  const result: ParameterSet = {};
  for (const [field, values] of Object.entries(fieldValues)) {
    const freq = new Map<number, number>();
    for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
    const maxFreq = Math.max(...freq.values());

    // 最頻値が複数ある場合、最後の出現値 (most recent window) を採用
    let chosen = values[values.length - 1]!;
    for (let i = values.length - 1; i >= 0; i--) {
      if (freq.get(values[i]!) === maxFreq) { chosen = values[i]!; break; }
    }
    result[field] = chosen;
  }

  return result;
}

/**
 * Recommended Parameter Frequency
 *
 * 各fieldの値ごとの出現Windowカウント。
 * UIで "RSI=29 (3/5 windows)" のような表示に使用。
 */
export function calcRecommendedParamFreq(
  windows: WalkForwardWindowResult[],
): Record<string, Array<{ value: number; windowCount: number }>> {
  const valid = windows.filter(w => !w.skipped && w.sampleStatus !== "INSUFFICIENT");

  const fieldFreq: Record<string, Map<number, number>> = {};
  for (const w of valid) {
    for (const [field, val] of Object.entries(w.bestParamSet)) {
      fieldFreq[field] ??= new Map();
      fieldFreq[field]!.set(val, (fieldFreq[field]!.get(val) ?? 0) + 1);
    }
  }

  const result: Record<string, Array<{ value: number; windowCount: number }>> = {};
  for (const [field, freq] of Object.entries(fieldFreq)) {
    result[field] = [...freq.entries()]
      .map(([value, windowCount]) => ({ value, windowCount }))
      .sort((a, b) => b.windowCount - a.windowCount || a.value - b.value);
  }

  return result;
}

/**
 * Verdict
 *
 * ROBUST:      consistencyScore >= 0.7 AND paramStabilityAvg >= 0.7
 *              AND validWindowCount >= 3 AND normalWindowCount >= 1
 * CONDITIONAL: consistencyScore >= 0.5 AND validWindowCount >= 2
 * OVERFIT:     consistencyScore < 0.5 AND validWindowCount >= 2
 * INCONCLUSIVE: データ不足 (validWindowCount < 2 or consistencyScore null)
 */
export function determineVerdict(
  consistencyScore:   number | null,
  parameterStability: Record<string, number>,
  validWindowCount:   number,
  normalWindowCount:  number,
): WalkForwardVerdict {
  if (consistencyScore === null || validWindowCount < 2) return "INCONCLUSIVE";

  const stabilityValues = Object.values(parameterStability);
  const avgStability = stabilityValues.length > 0
    ? stabilityValues.reduce((s, v) => s + v, 0) / stabilityValues.length
    : 0.5;

  if (
    consistencyScore >= 0.7 &&
    avgStability     >= 0.7 &&
    validWindowCount >= 3   &&
    normalWindowCount >= 1
  ) return "ROBUST";

  if (consistencyScore >= 0.5) return "CONDITIONAL";

  return "OVERFIT";
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

export function validateWalkForwardConfig(
  cfg: { trainMonths: number; testMonths: number; stepMonths: number },
  parameterRanges:  ParameterRange[],
  spec:             StrategySpec,
  mainBarsCount:    number,
  warmupEstimate:   number,
): WFValidationResult {
  const errors:   string[] = [];
  const warnings: string[] = [];

  // trainMonths
  if (!Number.isInteger(cfg.trainMonths) || cfg.trainMonths < 1 || cfg.trainMonths > 24) {
    errors.push(`trainMonths must be integer between 1 and 24 (got ${cfg.trainMonths})`);
  }
  // testMonths
  if (!Number.isInteger(cfg.testMonths) || cfg.testMonths < 1 || cfg.testMonths > 12) {
    errors.push(`testMonths must be integer between 1 and 12 (got ${cfg.testMonths})`);
  }
  // stepMonths
  if (!Number.isInteger(cfg.stepMonths) || cfg.stepMonths < 1 || cfg.stepMonths > 12) {
    errors.push(`stepMonths must be integer between 1 and 12 (got ${cfg.stepMonths})`);
  }

  // testMonths > trainMonths は非推奨
  if (cfg.testMonths > 0 && cfg.trainMonths > 0 && cfg.testMonths > cfg.trainMonths) {
    warnings.push(`testMonths (${cfg.testMonths}) > trainMonths (${cfg.trainMonths}): unusual configuration`);
  }

  // stepMonths < testMonths → TEST期間が重複 (許容だが警告)
  if (cfg.stepMonths > 0 && cfg.testMonths > 0 && cfg.stepMonths < cfg.testMonths) {
    warnings.push(
      `stepMonths (${cfg.stepMonths}) < testMonths (${cfg.testMonths}): ` +
      `consecutive TEST windows will overlap (acceptable in Rolling Walk Forward)`
    );
  }

  // Parameter ranges
  const rangeValidation = validateParameterRanges(parameterRanges, spec);
  if (!rangeValidation.valid) {
    errors.push(...rangeValidation.errors.map(e => `parameterRanges: ${e}`));
  }

  // Combinations limit (WF専用の制限: Phase 4-Aの5000より厳格)
  if (parameterRanges.length > 0) {
    const combos = countCombinations(parameterRanges);
    if (combos > WF_MAX_COMBINATIONS) {
      errors.push(
        `Too many combinations for Walk Forward: ${combos} (max ${WF_MAX_COMBINATIONS}). ` +
        `Reduce ranges or increase steps.`
      );
    }
  }

  // Min bars check for TRAIN IS (80%)
  if (mainBarsCount > 0 && warmupEstimate > 0) {
    const minCheck = checkMinBarsForWarmup(mainBarsCount, warmupEstimate);
    if (!minCheck.valid) {
      errors.push(
        `Insufficient bars: ${mainBarsCount} available, need > ${minCheck.minRequired} ` +
        `(warmup ${warmupEstimate} + min eval ${WF_MIN_EVAL_BARS})`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ------------------------------------------------------------------
// Main Runner
// ------------------------------------------------------------------

/**
 * runWalkForward — Walk Forward Validation を実行する
 *
 * 処理順:
 *   1. Window生成
 *   2. Warmup buffer size推定
 *   3. 各Window: runWalkForwardWindow (TRAIN Opt + TEST Backtest)
 *   4. ConsistencyScore, ParameterStability, RecommendedParams
 *   5. Verdict
 */
export function runWalkForward(input: WalkForwardInput): WalkForwardResult {
  const {
    spec,
    symbol,
    mainTimeframe,
    allBarsByTf,
    parameterRanges,
    trainMonths,
    testMonths,
    stepMonths      = testMonths,  // default = testMonths (Rolling)
    inSampleRatio   = 0.8,
    initialBalance  = 10_000,
    fixedLot        = 0.01,
    warmupSafetyMargin = WF_WARMUP_SAFETY_MARGIN,
  } = input;

  const config: WalkForwardConfig = {
    trainMs: trainMonths * MONTH_MS,
    testMs:  testMonths  * MONTH_MS,
    stepMs:  stepMonths  * MONTH_MS,
  };

  const mainBars = allBarsByTf[mainTimeframe] ?? [];

  // 1. Window生成
  const windows = generateWalkForwardWindows(mainBars, config);

  // 2. Warmup buffer size推定
  const warmupBufSize = estimateMaxWarmup(spec, parameterRanges, warmupSafetyMargin);

  // 3. 各Window実行 (完全独立 — Window N結果はWindow N+1に影響しない)
  const windowResults: WalkForwardWindowResult[] = windows.map(w =>
    runWalkForwardWindow(
      w, spec, symbol, mainTimeframe,
      allBarsByTf, parameterRanges,
      warmupBufSize, inSampleRatio,
      initialBalance, fixedLot,
    )
  );

  // 4. 集計
  const consistencyScore    = calcConsistencyScore(windowResults);
  const parameterStability  = calcParameterStability(windowResults);
  const recommendedParams   = selectRecommendedParams(windowResults);
  const recommendedParamFreq = calcRecommendedParamFreq(windowResults);

  const validWindowCount    = windowResults.filter(w => !w.skipped && w.sampleStatus !== "INSUFFICIENT").length;
  const normalWindowCount   = windowResults.filter(w => !w.skipped && w.sampleStatus === "NORMAL").length;
  const positiveWindowCount = windowResults.filter(w => w.windowPassed).length;
  const skippedWindowCount  = windowResults.filter(w => w.skipped).length;

  // 5. Verdict
  const verdict = determineVerdict(
    consistencyScore,
    parameterStability,
    validWindowCount,
    normalWindowCount,
  );

  return {
    windows:              windowResults,
    consistencyScore,
    parameterStability,
    recommendedParams,
    recommendedParamFreq,
    verdict,
    validWindowCount,
    normalWindowCount,
    positiveWindowCount,
    skippedWindowCount,
    totalWindowCount:     windowResults.length,
  };
}

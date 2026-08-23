// =================================================================
// evaluator.ts — Strategy Condition Evaluator (Phase 2-B)
//
// Strategy Spec + Historical Bars + Precomputed Indicators
//   → BUY / SELL / SKIP
//
// 設計原則:
//   - Pure Function: Supabase/MT5/OpenAI 非依存
//   - Look-ahead Bias 完全防止 (getLastConfirmedBarIndex 利用)
//   - Multi-Timeframe: 各条件が独立した TF を指定可能
//   - Direction: trend_filter.direction が最優先、次に条件から推論
// =================================================================

import type { Bar }                   from "@/infrastructure/analysis/types";
import type { MACDResult, ADXResult, BollingerResult, IchimokuResult, DonchianResult, KeltnerResult, AroonResult } from "./types";
import type { PrecomputedIndicators } from "./indicators";
import type { StrategySpec }          from "@/lib/strategySchema";
import { getLastConfirmedBarIndex, isWithinSessions } from "./timeframe";

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type SignalResult = "BUY" | "SELL" | "SKIP";

export interface EvaluationContext {
  spec:                  StrategySpec;
  /** 評価基準時刻 (Unix ms) — 通常はメイン TF 確定バー終了時刻 */
  evaluationTime:        number;
  /** TF 文字列 → bars (time 昇順ソート済み) */
  barsByTimeframe:       Record<string, Bar[]>;
  /** TF 文字列 → precomputeIndicators() の結果 */
  indicatorsByTimeframe: Record<string, PrecomputedIndicators>;
  /** 現在スプレッド (pips) — 未指定時はスプレッドフィルター適用なし */
  spreadPips?:           number;
  debug?:                boolean;
}

// ------------------------------------------------------------------
// Internal: direction type
// ------------------------------------------------------------------

type Direction = "BUY" | "SELL" | "AMBIGUOUS";

// ------------------------------------------------------------------
// Direction inference from entry conditions
// ------------------------------------------------------------------

function inferDirectionFromConditions(
  conditions: StrategySpec["entry_conditions"]["conditions"],
): Direction {
  let buy = 0;
  let sell = 0;

  for (const c of conditions) {
    const op  = c.operator;
    const thr = c.threshold ?? 50;

    switch (c.indicator) {
      case "EMA":
      case "SMA":
        if (op === "PRICE_ABOVE" || op === "BULLISH_CROSS") buy++;
        if (op === "PRICE_BELOW" || op === "BEARISH_CROSS") sell++;
        break;
      case "RSI":
        if (op === "CROSS_UP")                               buy++;
        if (op === "CROSS_DOWN")                             sell++;
        if (op === "BELOW" && thr <= 50)                     buy++;   // oversold
        if (op === "ABOVE" && thr >= 50)                     sell++;  // overbought
        if (op === "REVERSAL") { thr <= 50 ? buy++ : sell++; }
        break;
      case "MACD":
        if (op === "ABOVE_SIGNAL" || op === "HISTOGRAM_POSITIVE" || op === "HISTOGRAM_CROSS_UP") buy++;
        if (op === "BELOW_SIGNAL" || op === "HISTOGRAM_NEGATIVE" || op === "HISTOGRAM_CROSS_DOWN") sell++;
        break;
      case "BOLLINGER_BANDS":
        if (op === "PRICE_BELOW") buy++;   // price < lower band → oversold
        if (op === "PRICE_ABOVE") sell++;  // price > upper band → overbought
        break;
      case "STOCHASTIC":
        if (op === "CROSS_UP")                               buy++;
        if (op === "CROSS_DOWN")                             sell++;
        if (op === "BELOW" && thr <= 50)                     buy++;
        if (op === "ABOVE" && thr >= 50)                     sell++;
        if (op === "REVERSAL") { thr <= 50 ? buy++ : sell++; }
        break;
      case "WMA":
      case "VWMA":
        if (op === "PRICE_ABOVE") buy++;
        if (op === "PRICE_BELOW") sell++;
        break;
      case "CCI":
        // ABOVE 100 → オーバーボート = SELL, BELOW -100 → オーバーソールド = BUY
        if (op === "ABOVE" && thr >= 0)   sell++;
        if (op === "BELOW" && thr <= 0)   buy++;
        if (op === "REVERSAL") { thr <= 0 ? buy++ : sell++; }
        if (op === "CROSS_UP")  buy++;
        if (op === "CROSS_DOWN") sell++;
        break;
      case "WILLIAMS_R":
        // ABOVE -20 → オーバーボート = SELL, BELOW -80 → オーバーソールド = BUY
        if (op === "ABOVE" && thr >= -50)  sell++;
        if (op === "BELOW" && thr <= -50)  buy++;
        if (op === "REVERSAL") { thr <= -50 ? buy++ : sell++; }
        break;
      case "MOMENTUM":
        if (op === "ABOVE" || op === "CROSS_UP")    buy++;
        if (op === "BELOW" || op === "CROSS_DOWN")  sell++;
        break;
      case "OBV":
        if (op === "ABOVE" || op === "CROSS_UP") buy++;
        if (op === "BELOW")                      sell++;
        break;
      case "HMA":
      case "DEMA":
        if (op === "PRICE_ABOVE") buy++;
        if (op === "PRICE_BELOW") sell++;
        break;
      case "ICHIMOKU":
        if (op === "PRICE_ABOVE_CLOUD" || op === "BULLISH_CROSS" || op === "PRICE_ABOVE") buy++;
        if (op === "PRICE_BELOW_CLOUD" || op === "BEARISH_CROSS" || op === "PRICE_BELOW") sell++;
        break;
      case "DONCHIAN":
        if (op === "PRICE_ABOVE") buy++;
        if (op === "PRICE_BELOW") sell++;
        break;
      case "KELTNER":
        // PRICE_ABOVE = overbought → sell signal; PRICE_BELOW = oversold → buy signal
        if (op === "PRICE_ABOVE") sell++;
        if (op === "PRICE_BELOW") buy++;
        break;
      case "STOCH_RSI":
        if (op === "ABOVE" && thr >= 0.5)  sell++;
        if (op === "BELOW" && thr <= 0.5)  buy++;
        if (op === "REVERSAL") { thr <= 0.5 ? buy++ : sell++; }
        break;
      case "ROC":
      case "AO":
      case "FORCE_INDEX":
        if (op === "ABOVE" || op === "CROSS_UP")   buy++;
        if (op === "BELOW" || op === "CROSS_DOWN") sell++;
        break;
      case "AROON":
        if (op === "ABOVE" || op === "CROSS_UP")   buy++;
        if (op === "BELOW" || op === "CROSS_DOWN") sell++;
        break;
      case "MFI":
        if (op === "ABOVE" && thr >= 50)  sell++;
        if (op === "BELOW" && thr <= 50)  buy++;
        if (op === "REVERSAL") { thr <= 50 ? buy++ : sell++; }
        break;
      case "CMF":
        if (op === "ABOVE" || op === "CROSS_UP")   buy++;
        if (op === "BELOW" || op === "CROSS_DOWN") sell++;
        break;
      case "PSAR":
        if (op === "PRICE_ABOVE") buy++;
        if (op === "PRICE_BELOW") sell++;
        break;
      // ATR は方向中立
      // VOLUME_RATIO, ADX, PRICE_ACTION, MARKET_STRUCTURE 等は方向中立
    }
  }

  if (buy > sell)  return "BUY";
  if (sell > buy)  return "SELL";
  return "AMBIGUOUS";
}

function determineDirection(spec: StrategySpec): Direction {
  // Phase 5-A: resolve effective trend filters (trend_filters[] takes precedence)
  const filters = spec.filters;
  if (filters) {
    const effectiveFilters = resolveEffectiveTrendFilters(filters);
    // Use the first non-NEUTRAL filter to determine direction
    for (const tf of effectiveFilters) {
      if (tf.direction === "BULLISH") return "BUY";
      if (tf.direction === "BEARISH") return "SELL";
    }
    // All filters are NEUTRAL or none present → fall through to condition inference
  }
  // Infer from entry conditions when no directional trend filter exists
  return inferDirectionFromConditions(spec.entry_conditions.conditions);
}

// ------------------------------------------------------------------
// Bidirectional condition classifier
//
// Used when direction = AMBIGUOUS. Classifies each condition into the
// direction group it naturally belongs to, using MOMENTUM semantics:
//   RSI ABOVE 50  → BUY  (momentum above neutral line)
//   RSI BELOW 50  → SELL (momentum below neutral line)
//   RSI ABOVE 70+ → SELL (overbought reversal)
//   RSI BELOW 30- → BUY  (oversold reversal)
//
// This differs from inferDirectionFromConditions (reversal semantics)
// and is only applied during bidirectional evaluation.
// ------------------------------------------------------------------

type ConditionDirection = "BUY" | "SELL" | "NEUTRAL";

function getConditionDirection(c: StrategySpec["entry_conditions"]["conditions"][number]): ConditionDirection {
  const op  = c.operator;
  const thr = c.threshold ?? 50;

  switch (c.indicator) {
    case "EMA":
    case "SMA":
      if (op === "PRICE_ABOVE" || op === "BULLISH_CROSS" || op === "NEAR_EMA") return "BUY";
      if (op === "PRICE_BELOW" || op === "BEARISH_CROSS")                       return "SELL";
      return "NEUTRAL";

    case "RSI":
    case "STOCHASTIC":
      if (op === "CROSS_UP")                  return "BUY";
      if (op === "CROSS_DOWN")                return "SELL";
      // Momentum: ABOVE neutral (≤50) = bullish, ABOVE overbought (>50) = bearish
      if (op === "ABOVE") return thr <= 50 ? "BUY" : "SELL";
      // Momentum: BELOW neutral (≥50) = bearish, BELOW oversold (<50) = bullish
      if (op === "BELOW") return thr >= 50 ? "SELL" : "BUY";
      if (op === "REVERSAL") return thr <= 50 ? "BUY" : "SELL";
      return "NEUTRAL";

    case "MACD":
      if (op === "ABOVE_SIGNAL" || op === "HISTOGRAM_POSITIVE" || op === "HISTOGRAM_CROSS_UP") return "BUY";
      if (op === "BELOW_SIGNAL" || op === "HISTOGRAM_NEGATIVE" || op === "HISTOGRAM_CROSS_DOWN") return "SELL";
      return "NEUTRAL";

    case "BOLLINGER_BANDS":
      if (op === "PRICE_BELOW") return "BUY";   // below lower band = oversold
      if (op === "PRICE_ABOVE") return "SELL";  // above upper band = overbought
      return "NEUTRAL";

    case "WMA":
    case "VWMA":
      if (op === "PRICE_ABOVE") return "BUY";
      if (op === "PRICE_BELOW") return "SELL";
      return "NEUTRAL";

    case "CCI":
      // Momentum semantics: ABOVE neutral (≤0) = bullish, ABOVE overbought (>0) = bearish
      if (op === "CROSS_UP")   return "BUY";
      if (op === "CROSS_DOWN") return "SELL";
      if (op === "ABOVE") return thr <= 0 ? "BUY" : "SELL";
      if (op === "BELOW") return thr >= 0 ? "SELL" : "BUY";
      if (op === "REVERSAL") return thr <= 0 ? "BUY" : "SELL";
      return "NEUTRAL";

    case "WILLIAMS_R":
      // %R range -100..0; ABOVE -50 = overbought territory = SELL, BELOW -50 = oversold = BUY
      if (op === "ABOVE") return thr >= -50 ? "SELL" : "BUY";
      if (op === "BELOW") return thr <= -50 ? "BUY" : "SELL";
      if (op === "REVERSAL") return thr <= -50 ? "BUY" : "SELL";
      return "NEUTRAL";

    case "MOMENTUM":
      if (op === "ABOVE" || op === "CROSS_UP")   return "BUY";
      if (op === "BELOW" || op === "CROSS_DOWN") return "SELL";
      return "NEUTRAL";

    case "OBV":
      if (op === "ABOVE" || op === "CROSS_UP") return "BUY";
      if (op === "BELOW")                      return "SELL";
      return "NEUTRAL";

    case "HMA":
    case "DEMA":
      if (op === "PRICE_ABOVE") return "BUY";
      if (op === "PRICE_BELOW") return "SELL";
      return "NEUTRAL";

    case "ICHIMOKU":
      if (op === "PRICE_ABOVE_CLOUD" || op === "BULLISH_CROSS" || op === "PRICE_ABOVE") return "BUY";
      if (op === "PRICE_BELOW_CLOUD" || op === "BEARISH_CROSS" || op === "PRICE_BELOW") return "SELL";
      return "NEUTRAL";

    case "DONCHIAN":
      if (op === "PRICE_ABOVE") return "BUY";
      if (op === "PRICE_BELOW") return "SELL";
      return "NEUTRAL";

    case "KELTNER":
      if (op === "PRICE_ABOVE") return "SELL";  // overbought
      if (op === "PRICE_BELOW") return "BUY";   // oversold
      return "NEUTRAL";

    case "STOCH_RSI":
      if (op === "CROSS_UP")  return "BUY";
      if (op === "CROSS_DOWN") return "SELL";
      if (op === "ABOVE") return thr <= 0.5 ? "BUY" : "SELL";
      if (op === "BELOW") return thr >= 0.5 ? "SELL" : "BUY";
      if (op === "REVERSAL") return thr <= 0.5 ? "BUY" : "SELL";
      return "NEUTRAL";

    case "ROC":
    case "AO":
    case "FORCE_INDEX":
    case "AROON":
    case "CMF":
      if (op === "ABOVE" || op === "CROSS_UP")   return "BUY";
      if (op === "BELOW" || op === "CROSS_DOWN") return "SELL";
      return "NEUTRAL";

    case "MFI":
      if (op === "ABOVE") return thr <= 50 ? "BUY" : "SELL";
      if (op === "BELOW") return thr >= 50 ? "SELL" : "BUY";
      if (op === "REVERSAL") return thr <= 50 ? "BUY" : "SELL";
      return "NEUTRAL";

    case "PSAR":
      if (op === "PRICE_ABOVE") return "BUY";
      if (op === "PRICE_BELOW") return "SELL";
      return "NEUTRAL";

    // ATR, VOLUME_RATIO, ADX, PRICE_ACTION, MARKET_STRUCTURE 等は方向中立
    default:
      return "NEUTRAL";
  }
}

// ------------------------------------------------------------------
// EMA value lookup: period → ema1 or ema2
// ------------------------------------------------------------------

function getEMAValue(
  inds:   PrecomputedIndicators,
  idx:    number,
  period: number | undefined,
): number | undefined {
  if (period === undefined)                     return inds.ema1[idx];
  if (period === inds.params.ema1Period)        return inds.ema1[idx];
  if (period === inds.params.ema2Period)        return inds.ema2[idx];
  return undefined; // 該当する precomputed EMA なし
}

// ------------------------------------------------------------------
// Pip normalization (Phase 5-A)
// ------------------------------------------------------------------

/**
 * 1 pip のサイズを symbol から算出する。
 *   EURUSD, GBPUSD 等の5桁通貨: 0.0001
 *   USDJPY 等の JPY ペア:        0.01
 *   XAUUSD / GOLD:               0.10
 *   XAGUSD / SILVER:             0.01
 *   US30/US500/US100/OIL/BRENT:  1.0 (index/commodity)
 */
export function getPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes("JPY"))                                  return 0.01;
  if (s === "XAUUSD" || s === "GOLD")                    return 0.10;
  if (s === "XAGUSD" || s === "SILVER")                  return 0.01;
  if (s === "US30CASH" || s === "US500CASH" ||
      s === "US100CASH" || s === "OILCASH" ||
      s === "BRENTCASH")                                  return 1.0;
  return 0.0001; // default FOREX (4/5 digit)
}

// ------------------------------------------------------------------
// Trend filter evaluator
// ------------------------------------------------------------------

type TrendFilter = NonNullable<NonNullable<StrategySpec["filters"]>["trend_filter"]>;

function evalTrendFilter(
  tf:       TrendFilter,
  evalTime: number,
  barsByTf: Record<string, Bar[]>,
  indsByTf: Record<string, PrecomputedIndicators>,
): boolean {
  if (tf.direction === "NEUTRAL") return true;

  const bars = barsByTf[tf.timeframe];
  const inds = indsByTf[tf.timeframe];
  if (!bars || !inds || bars.length === 0) return false;

  const idx = getLastConfirmedBarIndex(bars, tf.timeframe, evalTime);
  if (idx < 0) return false;

  const close = bars[idx].close;

  if (tf.indicator === "EMA") {
    const emaVal = getEMAValue(inds, idx, tf.period);
    if (emaVal === undefined) return false;
    if (tf.direction === "BULLISH") return close > emaVal;
    if (tf.direction === "BEARISH") return close < emaVal;
  }

  if (tf.indicator === "SMA") {
    const smaVal = inds.sma[idx];
    if (smaVal === undefined) return false;
    if (tf.direction === "BULLISH") return close > smaVal;
    if (tf.direction === "BEARISH") return close < smaVal;
  }

  return true; // 他インジケーターは実装対象外 (Phase 2-B)
}

/**
 * Phase 5-A: 複数トレンドフィルターの正規化
 *   - trend_filters[] が存在する場合はそちらを優先
 *   - trend_filter (singular) のみの場合は 1 要素配列に変換
 *   - どちらもなければ空配列（フィルターなし）
 */
function resolveEffectiveTrendFilters(
  filters: NonNullable<StrategySpec["filters"]>,
): TrendFilter[] {
  if (filters.trend_filters && filters.trend_filters.length > 0) {
    return filters.trend_filters as TrendFilter[];
  }
  if (filters.trend_filter) {
    return [filters.trend_filter];
  }
  return [];
}

// ------------------------------------------------------------------
// Individual operator evaluators
// ------------------------------------------------------------------

function evalRSI(
  rsi:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
  direction: "BUY" | "SELL",
): boolean {
  const curr = rsi[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "BELOW":
      return threshold !== undefined && curr < threshold;
    case "ABOVE":
      return threshold !== undefined && curr > threshold;

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = rsi[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 50;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = rsi[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 50;
      return prev > thr && curr <= thr;
    }

    // REVERSAL:
    //   BUY  → RSI が threshold(default 30) 以下に到達後、上昇転換
    //   SELL → RSI が threshold(default 70) 以上に到達後、下落転換
    //
    //   条件: prev <= thr AND curr > prev  (BUY)
    //         prev >= thr AND curr < prev  (SELL)
    case "REVERSAL": {
      if (idx < 1) return false;
      const prev = rsi[idx - 1];
      if (prev === undefined) return false;
      if (direction === "BUY") {
        const thr = threshold ?? 30;
        return prev <= thr && curr > prev;
      } else {
        const thr = threshold ?? 70;
        return prev >= thr && curr < prev;
      }
    }

    default:
      return false;
  }
}

function evalEMA(
  bars:   Bar[],
  inds:   PrecomputedIndicators,
  idx:    number,
  op:     string | undefined,
  period: number | undefined,
): boolean {
  const close = bars[idx].close;

  switch (op) {
    case "PRICE_ABOVE": {
      const v = getEMAValue(inds, idx, period);
      return v !== undefined && close > v;
    }
    case "PRICE_BELOW": {
      const v = getEMAValue(inds, idx, period);
      return v !== undefined && close < v;
    }

    // EMA21 が EMA200 を下から上へ抜ける = BULLISH_CROSS
    case "BULLISH_CROSS": {
      if (idx < 1) return false;
      const e1c = inds.ema1[idx],     e2c = inds.ema2[idx];
      const e1p = inds.ema1[idx - 1], e2p = inds.ema2[idx - 1];
      if (e1c === undefined || e2c === undefined || e1p === undefined || e2p === undefined) return false;
      return e1p < e2p && e1c >= e2c;
    }

    // EMA21 が EMA200 を上から下へ抜ける = BEARISH_CROSS
    case "BEARISH_CROSS": {
      if (idx < 1) return false;
      const e1c = inds.ema1[idx],     e2c = inds.ema2[idx];
      const e1p = inds.ema1[idx - 1], e2p = inds.ema2[idx - 1];
      if (e1c === undefined || e2c === undefined || e1p === undefined || e2p === undefined) return false;
      return e1p > e2p && e1c <= e2c;
    }

    default:
      return false;
  }
}

function evalSMA(
  bars: Bar[],
  inds: PrecomputedIndicators,
  idx:  number,
  op:   string | undefined,
): boolean {
  const close  = bars[idx].close;
  const smaVal = inds.sma[idx];
  if (smaVal === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > smaVal;
    case "PRICE_BELOW": return close < smaVal;
    default:            return false;
  }
}

function evalMACD(
  macd: MACDResult[],
  idx:  number,
  op:   string | undefined,
): boolean {
  const m = macd[idx];
  if (!m || m.macd === undefined || m.signal === undefined || m.histogram === undefined) return false;

  switch (op) {
    case "ABOVE_SIGNAL":       return m.macd > m.signal;
    case "BELOW_SIGNAL":       return m.macd < m.signal;
    case "HISTOGRAM_POSITIVE": return m.histogram > 0;
    case "HISTOGRAM_NEGATIVE": return m.histogram < 0;

    // ヒストグラムがマイナスからプラスへ転換（ゴールデンクロス相当）
    case "HISTOGRAM_CROSS_UP": {
      if (idx < 1) return false;
      const prev = macd[idx - 1];
      if (!prev || prev.histogram === undefined) return false;
      return prev.histogram < 0 && m.histogram >= 0;
    }
    // ヒストグラムがプラスからマイナスへ転換（デッドクロス相当）
    case "HISTOGRAM_CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = macd[idx - 1];
      if (!prev || prev.histogram === undefined) return false;
      return prev.histogram > 0 && m.histogram <= 0;
    }

    default: return false;
  }
}

function evalADX(
  adx:       ADXResult[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const a = adx[idx];
  if (!a || a.adx === undefined) return false;

  switch (op) {
    case "ABOVE": return threshold !== undefined && a.adx > threshold;
    case "BELOW": return threshold !== undefined && a.adx < threshold;
    default:      return false;
  }
}

function evalBB(
  bars: Bar[],
  bb:   BollingerResult[],
  idx:  number,
  op:   string | undefined,
): boolean {
  const b     = bb[idx];
  const close = bars[idx].close;
  if (!b || b.upper === undefined || b.lower === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > b.upper;
    case "PRICE_BELOW": return close < b.lower;
    default:            return false;
  }
}

function evalWMA(
  bars: Bar[],
  inds: PrecomputedIndicators,
  idx:  number,
  op:   string | undefined,
): boolean {
  const close   = bars[idx].close;
  const wmaVal  = inds.wma[idx];
  if (wmaVal === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > wmaVal;
    case "PRICE_BELOW": return close < wmaVal;
    default:            return false;
  }
}

function evalVWMA(
  bars: Bar[],
  inds: PrecomputedIndicators,
  idx:  number,
  op:   string | undefined,
): boolean {
  const close    = bars[idx].close;
  const vwmaVal  = inds.vwma[idx];
  if (vwmaVal === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > vwmaVal;
    case "PRICE_BELOW": return close < vwmaVal;
    default:            return false;
  }
}

function evalCCI(
  cci:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
  direction: "BUY" | "SELL",
): boolean {
  const curr = cci[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return threshold !== undefined && curr > threshold;
    case "BELOW":
      return threshold !== undefined && curr < threshold;

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = cci[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = cci[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev > thr && curr <= thr;
    }

    // REVERSAL:
    //   BUY  → CCI が threshold(default -100) 以下に到達後、上昇転換
    //   SELL → CCI が threshold(default +100) 以上に到達後、下落転換
    case "REVERSAL": {
      if (idx < 1) return false;
      const prev = cci[idx - 1];
      if (prev === undefined) return false;
      if (direction === "BUY") {
        const thr = threshold ?? -100;
        return prev <= thr && curr > prev;
      } else {
        const thr = threshold ?? 100;
        return prev >= thr && curr < prev;
      }
    }

    default:
      return false;
  }
}

function evalWilliamsR(
  wr:        (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
  direction: "BUY" | "SELL",
): boolean {
  const curr = wr[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return threshold !== undefined && curr > threshold;
    case "BELOW":
      return threshold !== undefined && curr < threshold;

    // REVERSAL:
    //   BUY  → %R が threshold(default -80) 以下に到達後、上昇転換
    //   SELL → %R が threshold(default -20) 以上に到達後、下落転換
    case "REVERSAL": {
      if (idx < 1) return false;
      const prev = wr[idx - 1];
      if (prev === undefined) return false;
      if (direction === "BUY") {
        const thr = threshold ?? -80;
        return prev <= thr && curr > prev;
      } else {
        const thr = threshold ?? -20;
        return prev >= thr && curr < prev;
      }
    }

    default:
      return false;
  }
}

function evalMomentum(
  mom:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = mom[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return threshold !== undefined ? curr > threshold : curr > 0;
    case "BELOW":
      return threshold !== undefined ? curr < threshold : curr < 0;

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = mom[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = mom[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev > thr && curr <= thr;
    }

    default:
      return false;
  }
}

function evalOBV(
  obv:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = obv[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 0);
    case "BELOW":
      return curr < (threshold ?? 0);

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = obv[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }

    default:
      return false;
  }
}

function evalVolumeRatio(
  vr:        (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = vr[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 1.5);
    case "BELOW":
      return curr < (threshold ?? 1.0);
    default:
      return false;
  }
}

function evalStochastic(
  stoch:     (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
  direction: "BUY" | "SELL",
): boolean {
  const curr = stoch[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE": return threshold !== undefined && curr > threshold;
    case "BELOW": return threshold !== undefined && curr < threshold;

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = stoch[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 20;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = stoch[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 80;
      return prev > thr && curr <= thr;
    }

    // REVERSAL: RSI と同様の反転検知
    //   BUY  → Stochastic が threshold(default 20) 以下に到達後、上昇転換
    //   SELL → Stochastic が threshold(default 80) 以上に到達後、下落転換
    case "REVERSAL": {
      if (idx < 1) return false;
      const prev = stoch[idx - 1];
      if (prev === undefined) return false;
      if (direction === "BUY") {
        const thr = threshold ?? 20;
        return prev <= thr && curr > prev;
      } else {
        const thr = threshold ?? 80;
        return prev >= thr && curr < prev;
      }
    }

    default:
      return false;
  }
}

function evalHMA(
  bars: Bar[],
  hma:  (number | undefined)[],
  idx:  number,
  op:   string | undefined,
): boolean {
  const close  = bars[idx].close;
  const hmaVal = hma[idx];
  if (hmaVal === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > hmaVal;
    case "PRICE_BELOW": return close < hmaVal;
    default:            return false;
  }
}

function evalDEMA(
  bars: Bar[],
  dema: (number | undefined)[],
  idx:  number,
  op:   string | undefined,
): boolean {
  const close   = bars[idx].close;
  const demaVal = dema[idx];
  if (demaVal === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > demaVal;
    case "PRICE_BELOW": return close < demaVal;
    default:            return false;
  }
}

function evalIchimoku(
  bars:     Bar[],
  ichimoku: IchimokuResult[],
  idx:      number,
  op:       string | undefined,
): boolean {
  const close = bars[idx].close;
  const ich   = ichimoku[idx];
  if (!ich) return false;

  switch (op) {
    case "PRICE_ABOVE_CLOUD":
      return ich.cloudTop !== undefined && close > ich.cloudTop;
    case "PRICE_BELOW_CLOUD":
      return ich.cloudBottom !== undefined && close < ich.cloudBottom;
    case "PRICE_ABOVE":
      return ich.kijun !== undefined && close > ich.kijun;
    case "PRICE_BELOW":
      return ich.kijun !== undefined && close < ich.kijun;
    case "BULLISH_CROSS": {
      if (idx < 1) return false;
      const prev = ichimoku[idx - 1];
      if (!prev || ich.tenkan === undefined || ich.kijun === undefined ||
          prev.tenkan === undefined || prev.kijun === undefined) return false;
      return prev.tenkan < prev.kijun && ich.tenkan >= ich.kijun;
    }
    case "BEARISH_CROSS": {
      if (idx < 1) return false;
      const prev = ichimoku[idx - 1];
      if (!prev || ich.tenkan === undefined || ich.kijun === undefined ||
          prev.tenkan === undefined || prev.kijun === undefined) return false;
      return prev.tenkan > prev.kijun && ich.tenkan <= ich.kijun;
    }
    default:
      return false;
  }
}

function evalDonchian(
  bars:     Bar[],
  donchian: DonchianResult[],
  idx:      number,
  op:       string | undefined,
): boolean {
  const close = bars[idx].close;
  const d     = donchian[idx];
  if (!d || d.upper === undefined || d.lower === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > d.upper;
    case "PRICE_BELOW": return close < d.lower;
    default:            return false;
  }
}

function evalKeltner(
  bars:    Bar[],
  keltner: KeltnerResult[],
  idx:     number,
  op:      string | undefined,
): boolean {
  const close = bars[idx].close;
  const k     = keltner[idx];
  if (!k || k.upper === undefined || k.lower === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > k.upper;
    case "PRICE_BELOW": return close < k.lower;
    default:            return false;
  }
}

function evalStochRSI(
  stochRsi:  (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
  direction: "BUY" | "SELL",
): boolean {
  const curr = stochRsi[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 0.8);
    case "BELOW":
      return curr < (threshold ?? 0.2);

    case "REVERSAL": {
      if (idx < 1) return false;
      const prev = stochRsi[idx - 1];
      if (prev === undefined) return false;
      if (direction === "BUY") {
        const thr = threshold ?? 0.2;
        return prev <= thr && curr > prev;
      } else {
        const thr = threshold ?? 0.8;
        return prev >= thr && curr < prev;
      }
    }

    default:
      return false;
  }
}

function evalROC(
  roc:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = roc[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 0);
    case "BELOW":
      return curr < (threshold ?? 0);

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = roc[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = roc[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev > thr && curr <= thr;
    }

    default:
      return false;
  }
}

function evalAO(
  ao:        (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = ao[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 0);
    case "BELOW":
      return curr < (threshold ?? 0);

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = ao[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = ao[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev > thr && curr <= thr;
    }

    default:
      return false;
  }
}

function evalAroon(
  aroon:     AroonResult[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const a    = aroon[idx];
  const curr = a?.oscillator;
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 0);
    case "BELOW":
      return curr < (threshold ?? 0);

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = aroon[idx - 1]?.oscillator;
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = aroon[idx - 1]?.oscillator;
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev > thr && curr <= thr;
    }

    default:
      return false;
  }
}

function evalForceIndex(
  fi:        (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = fi[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 0);
    case "BELOW":
      return curr < (threshold ?? 0);

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = fi[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = fi[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev > thr && curr <= thr;
    }

    default:
      return false;
  }
}

function evalMFI(
  mfi:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
  direction: "BUY" | "SELL",
): boolean {
  const curr = mfi[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 80);
    case "BELOW":
      return curr < (threshold ?? 20);

    case "REVERSAL": {
      if (idx < 1) return false;
      const prev = mfi[idx - 1];
      if (prev === undefined) return false;
      if (direction === "BUY") {
        const thr = threshold ?? 20;
        return prev <= thr && curr > prev;
      } else {
        const thr = threshold ?? 80;
        return prev >= thr && curr < prev;
      }
    }

    default:
      return false;
  }
}

function evalCMF(
  cmf:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = cmf[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return curr > (threshold ?? 0);
    case "BELOW":
      return curr < (threshold ?? 0);

    case "CROSS_UP": {
      if (idx < 1) return false;
      const prev = cmf[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev < thr && curr >= thr;
    }
    case "CROSS_DOWN": {
      if (idx < 1) return false;
      const prev = cmf[idx - 1];
      if (prev === undefined) return false;
      const thr = threshold ?? 0;
      return prev > thr && curr <= thr;
    }

    default:
      return false;
  }
}

function evalATRCondition(
  atr:       (number | undefined)[],
  idx:       number,
  op:        string | undefined,
  threshold: number | undefined,
): boolean {
  const curr = atr[idx];
  if (curr === undefined) return false;

  switch (op) {
    case "ABOVE":
      return threshold !== undefined && curr > threshold;
    case "BELOW":
      return threshold !== undefined && curr < threshold;
    default:
      return false;
  }
}

function evalPSAR(
  bars: Bar[],
  psar: (number | undefined)[],
  idx:  number,
  op:   string | undefined,
): boolean {
  const close   = bars[idx].close;
  const psarVal = psar[idx];
  if (psarVal === undefined) return false;

  switch (op) {
    case "PRICE_ABOVE": return close > psarVal;
    case "PRICE_BELOW": return close < psarVal;
    default:            return false;
  }
}

// ------------------------------------------------------------------
// Single condition dispatcher
// ------------------------------------------------------------------

type Condition = StrategySpec["entry_conditions"]["conditions"][number];

function evalCondition(
  cond:     Condition,
  dir:      "BUY" | "SELL",
  evalTime: number,
  barsByTf: Record<string, Bar[]>,
  indsByTf: Record<string, PrecomputedIndicators>,
  symbol:   string,
): boolean {
  const bars = barsByTf[cond.timeframe];
  const inds = indsByTf[cond.timeframe];
  if (!bars || !inds || bars.length === 0) return false;

  const idx = getLastConfirmedBarIndex(bars, cond.timeframe, evalTime);
  if (idx < 0) return false;

  // Phase 5-A: NEAR_EMA — direction-free proximity check
  if (cond.operator === "NEAR_EMA") {
    const emaVal = getEMAValue(inds, idx, cond.period);
    if (emaVal === undefined) return false;
    const threshold = cond.threshold;
    if (threshold === undefined || threshold <= 0) return false;
    const pip         = getPipSize(symbol);
    const distancePips = Math.abs(bars[idx].close - emaVal) / pip;
    return distancePips <= threshold;
  }

  switch (cond.indicator) {
    case "RSI":
      return evalRSI(inds.rsi, idx, cond.operator, cond.threshold, dir);
    case "EMA":
      return evalEMA(bars, inds, idx, cond.operator, cond.period);
    case "SMA":
      return evalSMA(bars, inds, idx, cond.operator);
    case "MACD":
      return evalMACD(inds.macd, idx, cond.operator);
    case "ADX":
      return evalADX(inds.adx, idx, cond.operator, cond.threshold);
    case "BOLLINGER_BANDS":
      return evalBB(bars, inds.bb, idx, cond.operator);
    case "STOCHASTIC":
      return evalStochastic(inds.stoch, idx, cond.operator, cond.threshold, dir);
    case "WMA":
      return evalWMA(bars, inds, idx, cond.operator);
    case "VWMA":
      return evalVWMA(bars, inds, idx, cond.operator);
    case "CCI":
      return evalCCI(inds.cci, idx, cond.operator, cond.threshold, dir);
    case "WILLIAMS_R":
      return evalWilliamsR(inds.williamsR, idx, cond.operator, cond.threshold, dir);
    case "MOMENTUM":
      return evalMomentum(inds.momentum, idx, cond.operator, cond.threshold);
    case "OBV":
      return evalOBV(inds.obv, idx, cond.operator, cond.threshold);
    case "VOLUME_RATIO":
      return evalVolumeRatio(inds.volumeRatio, idx, cond.operator, cond.threshold);
    case "HMA":
      return evalHMA(bars, inds.hma, idx, cond.operator);
    case "DEMA":
      return evalDEMA(bars, inds.dema, idx, cond.operator);
    case "ICHIMOKU":
      return evalIchimoku(bars, inds.ichimoku, idx, cond.operator);
    case "DONCHIAN":
      return evalDonchian(bars, inds.donchian, idx, cond.operator);
    case "KELTNER":
      return evalKeltner(bars, inds.keltner, idx, cond.operator);
    case "STOCH_RSI":
      return evalStochRSI(inds.stochRsi, idx, cond.operator, cond.threshold, dir);
    case "ROC":
      return evalROC(inds.roc, idx, cond.operator, cond.threshold);
    case "AO":
      return evalAO(inds.ao, idx, cond.operator, cond.threshold);
    case "AROON":
      return evalAroon(inds.aroon, idx, cond.operator, cond.threshold);
    case "FORCE_INDEX":
      return evalForceIndex(inds.forceIndex, idx, cond.operator, cond.threshold);
    case "MFI":
      return evalMFI(inds.mfi, idx, cond.operator, cond.threshold, dir);
    case "CMF":
      return evalCMF(inds.cmf, idx, cond.operator, cond.threshold);
    case "ATR":
      return evalATRCondition(inds.atr, idx, cond.operator, cond.threshold);
    case "PSAR":
      return evalPSAR(bars, inds.psar, idx, cond.operator);
    default:
      return false; // PRICE_ACTION, MARKET_STRUCTURE 等は Phase 2-B 対象外
  }
}

// ------------------------------------------------------------------
// Main evaluator
// ------------------------------------------------------------------

export function evaluateStrategy(ctx: EvaluationContext): SignalResult {
  const { spec, evaluationTime, barsByTimeframe, indicatorsByTimeframe, spreadPips } = ctx;
  const filters = spec.filters;

  // 1. Spread filter
  if (filters?.max_spread_pips !== undefined && spreadPips !== undefined) {
    if (spreadPips > filters.max_spread_pips) return "SKIP";
  }

  // 2. Session filter
  if (!isWithinSessions(filters?.sessions ?? [], evaluationTime)) return "SKIP";

  // 3. Direction determination
  const rawDir = determineDirection(spec);
  const symbol = spec.symbols[0] ?? "EURUSD";
  const { logic, conditions } = spec.entry_conditions;

  // AMBIGUOUS: bidirectional strategy (e.g. LONG on EMA↑+RSI>50, SHORT on EMA↓+RSI<50)
  // Evaluate each direction independently using condition direction classification.
  if (rawDir === "AMBIGUOUS") {
    // Apply min_adx (symmetric — strength filter applies to both directions)
    if (filters?.min_adx !== undefined) {
      const mainTf = spec.timeframes[0];
      const mBars  = barsByTimeframe[mainTf];
      const mInds  = indicatorsByTimeframe[mainTf];
      if (!mBars || !mInds) return "SKIP";
      const idx    = getLastConfirmedBarIndex(mBars, mainTf, evaluationTime);
      if (idx < 0) return "SKIP";
      const adxVal = mInds.adx[idx]?.adx;
      if (adxVal === undefined || adxVal < filters.min_adx) return "SKIP";
    }

    // Try BUY, then SELL
    for (const dir of ["BUY", "SELL"] as const) {
      // Filter to direction-appropriate conditions (own direction + neutral)
      const dirConds = conditions.filter(c => {
        const cd = getConditionDirection(c);
        return cd === dir || cd === "NEUTRAL";
      });
      if (dirConds.length === 0) continue;

      const results = dirConds.map(c =>
        evalCondition(c, dir, evaluationTime, barsByTimeframe, indicatorsByTimeframe, symbol)
      );
      const passed = logic === "AND" ? results.every(Boolean) : results.some(Boolean);
      if (passed) return dir;
    }
    return "SKIP";
  }

  const dir: "BUY" | "SELL" = rawDir;

  // 4. Trend filter (Look-ahead Bias 防止: 確定済み TF バーを使用)
  //    Phase 5-A: 複数フィルターは AND ロジック (全て true で通過)
  if (filters) {
    const effectiveTrendFilters = resolveEffectiveTrendFilters(filters);
    for (const tf of effectiveTrendFilters) {
      if (tf.direction === "NEUTRAL") continue; // NEUTRAL は常に通過
      if (!evalTrendFilter(tf, evaluationTime, barsByTimeframe, indicatorsByTimeframe)) {
        return "SKIP";
      }
    }
  }

  // 5. Global min_adx filter (メイン TF の ADX で判定)
  if (filters?.min_adx !== undefined) {
    const mainTf = spec.timeframes[0];
    const bars   = barsByTimeframe[mainTf];
    const inds   = indicatorsByTimeframe[mainTf];
    if (!bars || !inds) return "SKIP";
    const idx    = getLastConfirmedBarIndex(bars, mainTf, evaluationTime);
    if (idx < 0) return "SKIP";
    const adxVal = inds.adx[idx]?.adx;
    if (adxVal === undefined || adxVal < filters.min_adx) return "SKIP";
  }

  // 6. Entry conditions
  const results = conditions.map(c =>
    evalCondition(c, dir, evaluationTime, barsByTimeframe, indicatorsByTimeframe, symbol)
  );

  const passed = logic === "AND"
    ? results.every(Boolean)
    : results.some(Boolean);

  return passed ? dir : "SKIP";
}

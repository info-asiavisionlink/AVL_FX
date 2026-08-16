// =================================================================
// Pure Indicator Calculator
// src/infrastructure/backtest/indicators.ts
//
// MT5 の計算済み値ではなく、OHLC bars から直接指標値を計算する。
// バックテストエンジン専用。リアルタイム処理には使用しない。
//
// 設計原則:
//   - Pure Function: 副作用なし、同一入力から同一出力
//   - Index Alignment: result[i] は bars[i] に対応する値
//   - Look-ahead Bias なし: bars[0..i] の情報のみを使用
//   - Warm-up 期間は undefined (配列長は変えない)
//   - O(n) アルゴリズムを優先（O(n²) 回避）
//
// 既存コードとの関係:
//   - calcStochastic() in indicatorEngine.ts:
//       同一アルゴリズムだが単一値返却・非公開。
//       本ファイルでは全バー位置の配列を返す形式に変更。
//   - calcBollingerBands() in MarketSnapshotBuilder.ts:
//       同一アルゴリズムだが単一値返却・非公開。
//       フィールド名 "mid" → "middle" に統一。
//   - EMA/RSI/ATR/MACD/ADX:
//       プロジェクト内に bars からの計算実装が存在しないため新規実装。
//       MT5 の iMA/iATR/iRSI/iMACD/iADX と同一の Wilder 平滑化を採用。
//
// MT5 との計算誤差について:
//   MT5 は過去に遡って多数のバーで指標を初期化するため、
//   本計算は warmup 直後の数十バーにおいて MT5 値と微差が生じる場合がある。
//   十分な historical data (200本以上) があれば実用上収束する。
// =================================================================

import type { Bar }           from "@/infrastructure/analysis/types";
import type { MACDResult, ADXResult, BollingerResult } from "./types";

// ------------------------------------------------------------------
// 内部ユーティリティ
// ------------------------------------------------------------------

/** EMA の乗数 k = 2 / (period + 1)  ← MT5 MODE_EMA と同一 */
function emaK(period: number): number {
  return 2 / (period + 1);
}

/**
 * Wilder 平滑化の乗数 k = 1 / period
 * ATR, RSI, ADX の平滑化に使用（MT5 の Wilder smoothing と同一）
 */
function wilderK(period: number): number {
  return 1 / period;
}

// ------------------------------------------------------------------
// SMA — 単純移動平均
// ------------------------------------------------------------------

/**
 * Simple Moving Average
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → bars[i-period+1..i] の終値平均
 *
 * O(n) 実装（スライディングウィンドウ）
 *
 * @param closes  終値配列
 * @param period  期間
 */
export function calculateSMA(
  closes: number[],
  period: number,
): (number | undefined)[] {
  if (period <= 0 || closes.length === 0) return new Array(closes.length).fill(undefined);

  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);
  let sum = 0;

  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];   // 古い値を除去
    if (i >= period - 1) result[i] = sum / period;
  }

  return result;
}

// ------------------------------------------------------------------
// EMA — 指数移動平均
// ------------------------------------------------------------------

/**
 * Exponential Moving Average（標準 EMA）
 * k = 2 / (period + 1)  ← MT5 iMA MODE_EMA と同一
 *
 * 初期値 = SMA(period)（MT5 の動作と同じ）
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → EMA 値
 *
 * @param closes  終値配列
 * @param period  期間
 */
export function calculateEMA(
  closes: number[],
  period: number,
): (number | undefined)[] {
  if (period <= 0 || closes.length < period) return new Array(closes.length).fill(undefined);

  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);
  const k = emaK(period);

  // 初期値: 最初の period 本の SMA
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  result[period - 1] = ema;

  // 以降: EMA[i] = close[i] * k + EMA[i-1] * (1-k)
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }

  return result;
}

// ------------------------------------------------------------------
// ATR — Average True Range（Wilder 平滑化）
// ------------------------------------------------------------------

/**
 * Average True Range
 * 平滑化方式: Wilder（MT5 iATR と同一）
 *
 * True Range:
 *   TR[0] = High[0] - Low[0]（前バーなし）
 *   TR[i] = max(H[i]-L[i], |H[i]-C[i-1]|, |L[i]-C[i-1]|)
 *
 * 初期 ATR = SMA(TR[0..period-1])
 * 以降:      ATR[i] = (ATR[i-1] * (period-1) + TR[i]) / period
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → ATR 値（>= 0）
 *
 * @param bars    OHLCバー配列
 * @param period  期間（標準 14）
 */
export function calculateATR(
  bars: Bar[],
  period: number,
): (number | undefined)[] {
  if (period <= 0 || bars.length === 0) return new Array(bars.length).fill(undefined);

  const result: (number | undefined)[] = new Array(bars.length).fill(undefined);

  // True Range 計算
  const tr = new Array<number>(bars.length);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].high  - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low  - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  if (bars.length < period) return result;

  // 初期 ATR = SMA(TR[0..period-1])
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  result[period - 1] = atr;

  // Wilder 平滑化
  const wk = wilderK(period); // = 1/period
  for (let i = period; i < bars.length; i++) {
    atr = atr * (1 - wk) + tr[i] * wk;
    result[i] = atr;
  }

  return result;
}

// ------------------------------------------------------------------
// RSI — Relative Strength Index（Wilder 平滑化）
// ------------------------------------------------------------------

/**
 * Relative Strength Index
 * 平滑化方式: Wilder（MT5 iRSI と同一）
 *
 * Gain[i] = max(close[i] - close[i-1], 0)
 * Loss[i] = max(close[i-1] - close[i], 0)
 *
 * 初期 AvgGain/AvgLoss = SMA(Gain[1..period]) ※ index 1 から始まる
 * 以降: Wilder 平滑化
 *
 * result[i]:
 *   i < period   → undefined
 *   i >= period  → RSI (0-100)
 *
 * エッジケース:
 *   AvgLoss = 0 かつ AvgGain > 0 → RSI = 100（純粋上昇）
 *   AvgLoss = 0 かつ AvgGain = 0 → RSI = 50（横ばい）
 *
 * @param bars    OHLCバー配列
 * @param period  期間（標準 14）
 */
export function calculateRSI(
  bars: Bar[],
  period: number,
): (number | undefined)[] {
  if (period <= 0 || bars.length <= period) return new Array(bars.length).fill(undefined);

  const result: (number | undefined)[] = new Array(bars.length).fill(undefined);

  // 変化量の計算（index 1 から有効）
  const gains = new Array<number>(bars.length).fill(0);
  const losses = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d > 0) gains[i]  = d;
    else       losses[i] = -d;
  }

  // 初期 AvgGain/AvgLoss = SMA(index 1..period)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = rsiValue(avgGain, avgLoss);

  // Wilder 平滑化
  const wk = wilderK(period);
  for (let i = period + 1; i < bars.length; i++) {
    avgGain = avgGain * (1 - wk) + gains[i]  * wk;
    avgLoss = avgLoss * (1 - wk) + losses[i] * wk;
    result[i] = rsiValue(avgGain, avgLoss);
  }

  return result;
}

/** RSI 値の計算（0-100）。エッジケース処理込み */
function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ------------------------------------------------------------------
// MACD — Moving Average Convergence Divergence
// ------------------------------------------------------------------

/**
 * MACD
 * MACD ライン  = EMA(fast) - EMA(slow)
 * シグナルライン = EMA(signal, MACDライン)
 * ヒストグラム   = MACD - Signal
 *
 * Warm-up インデックス（index = 0 始まり）:
 *   MACD ライン: slow - 1
 *   Signal:     slow - 1 + signal - 1 = slow + signal - 2
 *   例: MACD(12,26,9) → Signal 初期値 index 33
 *
 * result[i].macd:      i < slow-1    → undefined
 * result[i].signal:    i < slow+sig-2 → undefined
 * result[i].histogram: signal と同じ
 *
 * @param bars         OHLCバー配列
 * @param fastPeriod   短期 EMA 期間（標準 12）
 * @param slowPeriod   長期 EMA 期間（標準 26）
 * @param signalPeriod シグナル EMA 期間（標準 9）
 */
export function calculateMACD(
  bars: Bar[],
  fastPeriod  = 12,
  slowPeriod  = 26,
  signalPeriod = 9,
): MACDResult[] {
  const n = bars.length;
  const empty = (): MACDResult => ({ macd: undefined, signal: undefined, histogram: undefined });
  const result: MACDResult[] = Array.from({ length: n }, empty);

  if (n < slowPeriod + signalPeriod - 1) return result;

  const closes = bars.map(b => b.close);
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  // MACD ライン（EMA(slow) が有効になる index slowPeriod-1 から）
  const macdLine: (number | undefined)[] = new Array(n).fill(undefined);
  const firstMACDIdx = slowPeriod - 1;
  for (let i = firstMACDIdx; i < n; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f !== undefined && s !== undefined) {
      macdLine[i] = f - s;
      result[i].macd = macdLine[i];
    }
  }

  // シグナルライン = EMA(signalPeriod, MACDライン)
  // 初期値: MACD ライン[firstMACDIdx..firstMACDIdx+signalPeriod-1] の SMA
  const firstSignalIdx = firstMACDIdx + signalPeriod - 1;
  if (n <= firstSignalIdx) return result;

  let sig = 0;
  for (let i = 0; i < signalPeriod; i++) {
    sig += macdLine[firstMACDIdx + i]!;
  }
  sig /= signalPeriod;

  result[firstSignalIdx].signal    = sig;
  result[firstSignalIdx].histogram = (result[firstSignalIdx].macd ?? 0) - sig;

  // 以降のシグナル: EMA 平滑化
  const sigK = emaK(signalPeriod);
  for (let i = firstSignalIdx + 1; i < n; i++) {
    const m = macdLine[i];
    if (m !== undefined) {
      sig = m * sigK + sig * (1 - sigK);
      result[i].signal    = sig;
      result[i].histogram = m - sig;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// ADX / DI+ / DI- — Average Directional Index（Wilder 平滑化）
// ------------------------------------------------------------------

/**
 * ADX + Directional Indicators
 * MT5 iADX と同一の Wilder 平滑化を使用。
 *
 * 計算ステップ:
 *   1. +DM, -DM, TR を各バーで計算（index 1 から有効）
 *   2. Wilder 平滑: Smooth[n] + Smooth[n-1] - Smooth[n-1]/p + Value
 *      初期値は SMA(period, values[1..period])
 *   3. +DI = 100 × Smooth(+DM) / Smooth(TR)  （index period から有効）
 *   4. DX  = 100 × |+DI - -DI| / (+DI + -DI)
 *   5. ADX = Wilder smooth(DX, period)
 *      初期値: SMA(DX[period..2*period-1])  → index 2*period-1 から有効
 *
 * result[i].diPlus / diMinus:  i < period    → undefined
 * result[i].adx:               i < 2*period-1 → undefined
 *
 * @param bars    OHLCバー配列
 * @param period  期間（標準 14）
 */
export function calculateADX(
  bars: Bar[],
  period: number,
): ADXResult[] {
  const n = bars.length;
  const empty = (): ADXResult => ({ adx: undefined, diPlus: undefined, diMinus: undefined });
  const result: ADXResult[] = Array.from({ length: n }, empty);

  if (n < 2 * period) return result;

  // Step 1: +DM, -DM, TR（index 1 から有効）
  const dmPlus  = new Array<number>(n).fill(0);
  const dmMinus = new Array<number>(n).fill(0);
  const tr      = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const hl = bars[i].high  - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low  - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);

    const up   = bars[i].high     - bars[i - 1].high;
    const down = bars[i - 1].low  - bars[i].low;
    dmPlus[i]  = up   > down && up   > 0 ? up   : 0;
    dmMinus[i] = down > up  && down  > 0 ? down : 0;
  }

  // Step 2: Wilder 平滑（初期値 = SMA(index 1..period)）
  let sTR    = 0;
  let sDMPlus = 0;
  let sDMMinus = 0;
  for (let i = 1; i <= period; i++) {
    sTR      += tr[i];
    sDMPlus  += dmPlus[i];
    sDMMinus += dmMinus[i];
  }

  // Step 3: DI+, DI-, DX（index period から有効）
  const dx: (number | undefined)[] = new Array(n).fill(undefined);

  function computeDI(idx: number): void {
    if (sTR <= 0) return;
    const diP = 100 * sDMPlus  / sTR;
    const diM = 100 * sDMMinus / sTR;
    result[idx].diPlus  = diP;
    result[idx].diMinus = diM;
    const s = diP + diM;
    dx[idx] = s > 0 ? 100 * Math.abs(diP - diM) / s : 0;
  }

  computeDI(period); // 最初の平滑値

  const wk = wilderK(period);
  for (let i = period + 1; i < n; i++) {
    // Wilder 更新: Smooth[i] = Smooth[i-1] - Smooth[i-1]/period + Value[i]
    sTR      = sTR      * (1 - wk) + tr[i]      * wk;
    sDMPlus  = sDMPlus  * (1 - wk) + dmPlus[i]  * wk;
    sDMMinus = sDMMinus * (1 - wk) + dmMinus[i] * wk;
    computeDI(i);
  }

  // Step 4: ADX = Wilder smooth(DX, period)
  // 初期 ADX = SMA(DX[period..2*period-1])
  const firstADXIdx = 2 * period - 1;
  let dxSum = 0;
  let dxCount = 0;
  for (let i = period; i <= firstADXIdx; i++) {
    if (dx[i] !== undefined) { dxSum += dx[i]!; dxCount++; }
  }
  if (dxCount === 0) return result;

  let adx = dxSum / dxCount;
  result[firstADXIdx].adx = adx;

  for (let i = firstADXIdx + 1; i < n; i++) {
    if (dx[i] !== undefined) {
      adx = adx * (1 - wk) + dx[i]! * wk;
    }
    result[i].adx = adx;
  }

  return result;
}

// ------------------------------------------------------------------
// Bollinger Bands
// ------------------------------------------------------------------

/**
 * Bollinger Bands（20期間、2σ 標準）
 *
 * Middle = SMA(period, close)
 * StdDev = 母標準偏差（MT5 の iBands と同一: 標本ではなく母分散）
 * Upper  = Middle + deviation × StdDev
 * Lower  = Middle - deviation × StdDev
 * Width  = (Upper - Lower) / Middle × 100
 *
 * 既存実装との比較:
 *   MarketSnapshotBuilder.ts / calcBollingerBands():
 *     - 同一アルゴリズム（SMA + 母標準偏差）
 *     - 返却フィールド名が "mid" → 本関数では "middle" に統一
 *     - 単一値返却 → 本関数は全バー配列
 *
 * result[i]:
 *   i < period-1 → 全フィールド undefined
 *   i >= period-1 → 有効値
 *
 * @param bars       OHLCバー配列
 * @param period     期間（標準 20）
 * @param deviation  偏差乗数（標準 2.0）
 */
export function calculateBollingerBands(
  bars: Bar[],
  period    = 20,
  deviation = 2.0,
): BollingerResult[] {
  const n = bars.length;
  const empty = (): BollingerResult => ({
    upper: undefined, middle: undefined, lower: undefined, width: undefined,
  });
  const result: BollingerResult[] = Array.from({ length: n }, empty);

  const closes = bars.map(b => b.close);
  const sma    = calculateSMA(closes, period);

  for (let i = period - 1; i < n; i++) {
    const mid = sma[i];
    if (mid === undefined) continue;

    // 母標準偏差（除数 = period、MT5 と同一）
    const window  = closes.slice(i - period + 1, i + 1);
    const variance = window.reduce((sum, c) => sum + (c - mid) ** 2, 0) / period;
    const std      = Math.sqrt(variance);

    const upper = mid + deviation * std;
    const lower = mid - deviation * std;
    const width = mid > 0 ? (upper - lower) / mid * 100 : 0;

    result[i] = { upper, middle: mid, lower, width };
  }

  return result;
}

// ------------------------------------------------------------------
// Stochastic %K — Fast Stochastic
// ------------------------------------------------------------------

/**
 * Stochastic Oscillator — Fast %K
 *
 * %K = (Close - LowestLow(period)) / (HighestHigh(period) - LowestLow(period)) × 100
 *
 * 既存実装との比較:
 *   indicatorEngine.ts / calcStochastic(bars, k=14):
 *     - 同一アルゴリズム（HH/LL ルックバック + %K 計算）
 *     - 最後の1バーのみ返却 → 本関数は全バー配列
 *     - 分母 0 の処理: 既存は "|| 0.00001" → 本関数は 50 を返す
 *       （どちらも「横ばい＝中立」を表すが、50 の方が直感的）
 *   MarketSnapshotBuilder.ts / calcStochastic():
 *     - indicatorEngine.ts と同一実装
 *
 * result[i]:
 *   i < period-1 → undefined
 *   i >= period-1 → 0-100
 *
 * @param bars    OHLCバー配列
 * @param period  期間（標準 14）
 */
export function calculateStochastic(
  bars: Bar[],
  period = 14,
): (number | undefined)[] {
  const n = bars.length;
  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period - 1; i < n; i++) {
    let highest = -Infinity;
    let lowest  =  Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].high > highest) highest = bars[j].high;
      if (bars[j].low  < lowest)  lowest  = bars[j].low;
    }
    const denom = highest - lowest;
    result[i] = denom === 0 ? 50 : ((bars[i].close - lowest) / denom) * 100;
  }

  return result;
}

// ------------------------------------------------------------------
// PrecomputedIndicators — バー配列に対する全指標の事前計算
// ------------------------------------------------------------------

/**
 * 指定された bars 配列に対して全 Indicator を一括計算する。
 *
 * バックテストエンジンはこの結果を事前計算して
 * ループ内でインデックスアクセスするだけで済む。
 *
 * params は省略可能。省略時は標準パラメーターを使用する。
 */
export interface PrecomputeParams {
  ema1Period?:    number;  // 短期 EMA (デフォルト 21)
  ema2Period?:    number;  // 長期 EMA (デフォルト 200)
  smaPeriod?:     number;  // SMA (デフォルト 50)
  atrPeriod?:     number;  // ATR (デフォルト 14)
  rsiPeriod?:     number;  // RSI (デフォルト 14)
  macdFast?:      number;  // MACD fast (デフォルト 12)
  macdSlow?:      number;  // MACD slow (デフォルト 26)
  macdSignal?:    number;  // MACD signal (デフォルト 9)
  adxPeriod?:     number;  // ADX (デフォルト 14)
  bbPeriod?:      number;  // BB period (デフォルト 20)
  bbDeviation?:   number;  // BB deviation (デフォルト 2.0)
  stochPeriod?:   number;  // Stochastic (デフォルト 14)
}

export interface PrecomputedIndicators {
  ema1:    (number | undefined)[];
  ema2:    (number | undefined)[];
  sma:     (number | undefined)[];
  atr:     (number | undefined)[];
  rsi:     (number | undefined)[];
  macd:    MACDResult[];
  adx:     ADXResult[];
  bb:      BollingerResult[];
  stoch:   (number | undefined)[];
  params:  Required<PrecomputeParams>;
}

export function precomputeIndicators(
  bars: Bar[],
  p: PrecomputeParams = {},
): PrecomputedIndicators {
  const params: Required<PrecomputeParams> = {
    ema1Period:   p.ema1Period   ?? 21,
    ema2Period:   p.ema2Period   ?? 200,
    smaPeriod:    p.smaPeriod    ?? 50,
    atrPeriod:    p.atrPeriod    ?? 14,
    rsiPeriod:    p.rsiPeriod    ?? 14,
    macdFast:     p.macdFast     ?? 12,
    macdSlow:     p.macdSlow     ?? 26,
    macdSignal:   p.macdSignal   ?? 9,
    adxPeriod:    p.adxPeriod    ?? 14,
    bbPeriod:     p.bbPeriod     ?? 20,
    bbDeviation:  p.bbDeviation  ?? 2.0,
    stochPeriod:  p.stochPeriod  ?? 14,
  };

  const closes = bars.map(b => b.close);

  return {
    ema1:  calculateEMA(closes, params.ema1Period),
    ema2:  calculateEMA(closes, params.ema2Period),
    sma:   calculateSMA(closes, params.smaPeriod),
    atr:   calculateATR(bars, params.atrPeriod),
    rsi:   calculateRSI(bars, params.rsiPeriod),
    macd:  calculateMACD(bars, params.macdFast, params.macdSlow, params.macdSignal),
    adx:   calculateADX(bars, params.adxPeriod),
    bb:    calculateBollingerBands(bars, params.bbPeriod, params.bbDeviation),
    stoch: calculateStochastic(bars, params.stochPeriod),
    params,
  };
}

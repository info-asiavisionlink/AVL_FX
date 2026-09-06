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
import type { MACDResult, ADXResult, BollingerResult, IchimokuResult, DonchianResult, KeltnerResult, AroonResult } from "./types";

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
// WMA — Weighted Moving Average
// ------------------------------------------------------------------

/**
 * Weighted Moving Average
 * 最近のバーに線形に大きなウェイトを与える移動平均。
 *
 * WMA[i] = Σ(close[j] × weight(j)) / Σ weight(j)
 *   j = i-period+1 .. i
 *   weight(j) = j - (i - period + 1) + 1  (1 から period)
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → WMA 値
 *
 * @param closes  終値配列
 * @param period  期間（デフォルト 14）
 */
export function calculateWMA(
  closes: number[],
  period: number,
): (number | undefined)[] {
  if (period <= 0 || closes.length === 0) return new Array(closes.length).fill(undefined);

  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);
  // 分母 = 1+2+...+period = period*(period+1)/2
  const denominator = (period * (period + 1)) / 2;

  for (let i = period - 1; i < closes.length; i++) {
    let weightedSum = 0;
    for (let j = 0; j < period; j++) {
      // weight: 最古のバーが1、最新のバーが period
      weightedSum += closes[i - period + 1 + j] * (j + 1);
    }
    result[i] = weightedSum / denominator;
  }

  return result;
}

// ------------------------------------------------------------------
// VWMA — Volume Weighted Moving Average
// ------------------------------------------------------------------

/**
 * Volume Weighted Moving Average
 * ボリュームで加重した移動平均。
 *
 * VWMA[i] = Σ(close[j] × volume[j]) / Σ volume[j]
 *   j = i-period+1 .. i
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → VWMA 値
 *
 * @param closes   終値配列
 * @param volumes  ボリューム配列
 * @param period   期間（デフォルト 14）
 */
export function calculateVWMA(
  closes:  number[],
  volumes: number[],
  period:  number,
): (number | undefined)[] {
  if (period <= 0 || closes.length === 0) return new Array(closes.length).fill(undefined);
  if (closes.length !== volumes.length) return new Array(closes.length).fill(undefined);

  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);

  for (let i = period - 1; i < closes.length; i++) {
    let pvSum   = 0; // Σ price × volume
    let volSum  = 0; // Σ volume
    for (let j = i - period + 1; j <= i; j++) {
      pvSum  += closes[j] * volumes[j];
      volSum += volumes[j];
    }
    result[i] = volSum > 0 ? pvSum / volSum : closes[i];
  }

  return result;
}

// ------------------------------------------------------------------
// CCI — Commodity Channel Index
// ------------------------------------------------------------------

/**
 * Commodity Channel Index
 *
 * TP[i]  = (high[i] + low[i] + close[i]) / 3
 * SMA_TP = SMA(TP, period)
 * MeanDev = Σ|TP[j] - SMA_TP| / period  (mean absolute deviation)
 * CCI[i] = (TP[i] - SMA_TP) / (0.015 × MeanDev)
 *
 * 値域: 通常 -200 〜 +200 (±100 がオーバーソールド/オーバーボート基準)
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → CCI 値
 *
 * @param highs   高値配列
 * @param lows    安値配列
 * @param closes  終値配列
 * @param period  期間（デフォルト 14）
 */
export function calculateCCI(
  highs:  number[],
  lows:   number[],
  closes: number[],
  period: number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  // Typical Price
  const tp = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
  }

  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period - 1; i < n; i++) {
    // SMA of TP over window
    let tpSum = 0;
    for (let j = i - period + 1; j <= i; j++) tpSum += tp[j];
    const tpSMA = tpSum / period;

    // Mean Absolute Deviation
    let madSum = 0;
    for (let j = i - period + 1; j <= i; j++) madSum += Math.abs(tp[j] - tpSMA);
    const mad = madSum / period;

    // CCI
    result[i] = mad === 0 ? 0 : (tp[i] - tpSMA) / (0.015 * mad);
  }

  return result;
}

// ------------------------------------------------------------------
// Williams %R
// ------------------------------------------------------------------

/**
 * Williams %R
 *
 * %R[i] = -100 × (HH - Close[i]) / (HH - LL)
 *   HH = HighestHigh(period)
 *   LL = LowestLow(period)
 *
 * 値域: -100 〜 0
 *   -80 以下: オーバーソールド
 *   -20 以上: オーバーボート
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → Williams %R 値
 *
 * @param highs   高値配列
 * @param lows    安値配列
 * @param closes  終値配列
 * @param period  期間（デフォルト 14）
 */
export function calculateWilliamsR(
  highs:  number[],
  lows:   number[],
  closes: number[],
  period: number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll =  Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j]  < ll) ll = lows[j];
    }
    const denom = hh - ll;
    result[i] = denom === 0 ? -50 : -100 * (hh - closes[i]) / denom;
  }

  return result;
}

// ------------------------------------------------------------------
// Momentum
// ------------------------------------------------------------------

/**
 * Momentum
 *
 * Momentum[i] = Close[i] - Close[i - period]
 *
 * 正値: 上昇モメンタム
 * 負値: 下降モメンタム
 *
 * result[i]:
 *   i < period  → undefined
 *   i >= period → Momentum 値
 *
 * @param closes  終値配列
 * @param period  期間（デフォルト 10）
 */
export function calculateMomentum(
  closes: number[],
  period: number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period; i < n; i++) {
    result[i] = closes[i] - closes[i - period];
  }

  return result;
}

// ------------------------------------------------------------------
// OBV — On Balance Volume
// ------------------------------------------------------------------

/**
 * On Balance Volume
 *
 * OBV[0] = 0 (起点)
 * OBV[i] = OBV[i-1] + volume[i]   if close[i] > close[i-1]
 *         = OBV[i-1] - volume[i]   if close[i] < close[i-1]
 *         = OBV[i-1]               if close[i] = close[i-1]
 *
 * OBV の累積方向でトレンドの方向性を判定する。
 * 絶対値に意味はなく、傾向（増加/減少）が重要。
 *
 * result[i]: index 0 から全て有効（ウォームアップ不要）
 *
 * @param closes   終値配列
 * @param volumes  ボリューム配列
 */
export function calculateOBV(
  closes:  number[],
  volumes: number[],
): (number | undefined)[] {
  const n = closes.length;
  if (n === 0) return [];
  if (closes.length !== volumes.length) return new Array(n).fill(undefined);

  const result: (number | undefined)[] = new Array(n).fill(undefined);
  let obv = 0;
  result[0] = obv;

  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1])      obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    // 変化なしの場合は OBV 維持
    result[i] = obv;
  }

  return result;
}

// ------------------------------------------------------------------
// Volume Ratio — ボリューム÷SMA(ボリューム)
// ------------------------------------------------------------------

/**
 * Volume SMA Ratio
 *
 * VolRatio[i] = Volume[i] / SMA(Volume, period)[i]
 *
 * 1.0 より大: 平均より高ボリューム（重要な動き）
 * 1.5 以上:   高ボリューム確認
 *
 * result[i]:
 *   i < period-1  → undefined
 *   i >= period-1 → VolRatio 値 (>= 0)
 *
 * @param volumes  ボリューム配列
 * @param period   期間（デフォルト 20）
 */
export function calculateVolumeRatio(
  volumes: number[],
  period:  number,
): (number | undefined)[] {
  const n = volumes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  const volSMA = calculateSMA(volumes, period);
  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period - 1; i < n; i++) {
    const sma = volSMA[i];
    if (sma !== undefined && sma > 0) {
      result[i] = volumes[i] / sma;
    }
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
// HMA — Hull Moving Average
// ------------------------------------------------------------------

/**
 * Hull Moving Average
 * HMA = WMA(2×WMA(n/2) - WMA(n), sqrt(n))
 *
 * result[i]:
 *   i < floor(sqrt(n)) + floor(n/2) - 1 → undefined
 *   i >= ... → HMA 値
 *
 * @param closes  終値配列
 * @param period  期間（デフォルト 14）
 */
export function calculateHMA(
  closes: number[],
  period: number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.floor(Math.sqrt(period));

  const wmaHalf = calculateWMA(closes, halfPeriod);
  const wmaFull = calculateWMA(closes, period);

  // diff = 2×WMA(n/2) - WMA(n)
  const diff: (number | undefined)[] = new Array(n).fill(undefined);
  for (let i = 0; i < n; i++) {
    const h = wmaHalf[i];
    const f = wmaFull[i];
    if (h !== undefined && f !== undefined) {
      diff[i] = 2 * h - f;
    }
  }

  // Extract valid diff values for WMA calculation
  // We need to apply WMA(sqrtPeriod) to the diff array
  // Build a dense array of diff values preserving indices
  const result: (number | undefined)[] = new Array(n).fill(undefined);
  const denominator = (sqrtPeriod * (sqrtPeriod + 1)) / 2;

  for (let i = sqrtPeriod - 1; i < n; i++) {
    let weightedSum = 0;
    let valid = true;
    for (let j = 0; j < sqrtPeriod; j++) {
      const d = diff[i - sqrtPeriod + 1 + j];
      if (d === undefined) { valid = false; break; }
      weightedSum += d * (j + 1);
    }
    if (valid) result[i] = weightedSum / denominator;
  }

  return result;
}

// ------------------------------------------------------------------
// DEMA — Double Exponential Moving Average
// ------------------------------------------------------------------

/**
 * Double Exponential Moving Average
 * DEMA = 2×EMA(n) - EMA(EMA(n))
 *
 * result[i]:
 *   i < 2*(period-1) → undefined
 *   i >= ... → DEMA 値
 *
 * @param closes  終値配列
 * @param period  期間（デフォルト 14）
 */
export function calculateDEMA(
  closes: number[],
  period: number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  const ema1 = calculateEMA(closes, period);

  // EMA of EMA: extract valid EMA values
  const ema1Valid: number[] = [];
  const ema1StartIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ema1[i] !== undefined) {
      ema1Valid.push(ema1[i]!);
      ema1StartIdx.push(i);
    }
  }

  if (ema1Valid.length < period) return new Array(n).fill(undefined);

  // Calculate EMA of ema1Valid
  const ema1Closes = ema1Valid;
  const ema2Valid = calculateEMA(ema1Closes, period);

  const result: (number | undefined)[] = new Array(n).fill(undefined);
  for (let j = period - 1; j < ema2Valid.length; j++) {
    const e2 = ema2Valid[j];
    if (e2 === undefined) continue;
    const origIdx = ema1StartIdx[j];
    const e1 = ema1[origIdx];
    if (e1 !== undefined) {
      result[origIdx] = 2 * e1 - e2;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// Ichimoku — 一目均衡表
// ------------------------------------------------------------------

/**
 * 一目均衡表 (Ichimoku Cloud)
 *
 * Tenkan-sen  = (最高値[9期間] + 最安値[9期間]) / 2
 * Kijun-sen   = (最高値[26期間] + 最安値[26期間]) / 2
 * Senkou A    = (Tenkan + Kijun) / 2
 * Senkou B    = (最高値[52期間] + 最安値[52期間]) / 2
 * CloudTop    = max(Senkou A, Senkou B)
 * CloudBottom = min(Senkou A, Senkou B)
 *
 * @param highs  高値配列
 * @param lows   安値配列
 */
export function calculateIchimoku(
  highs: number[],
  lows:  number[],
): IchimokuResult[] {
  const n = highs.length;
  const empty = (): IchimokuResult => ({
    tenkan: undefined, kijun: undefined,
    senkouA: undefined, senkouB: undefined,
    cloudTop: undefined, cloudBottom: undefined,
  });
  const result: IchimokuResult[] = Array.from({ length: n }, empty);

  function midpoint(arr_h: number[], arr_l: number[], i: number, period: number): number | undefined {
    if (i < period - 1) return undefined;
    let hh = -Infinity;
    let ll =  Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (arr_h[j] > hh) hh = arr_h[j];
      if (arr_l[j] < ll) ll = arr_l[j];
    }
    return (hh + ll) / 2;
  }

  for (let i = 0; i < n; i++) {
    const tenkan = midpoint(highs, lows, i, 9);
    const kijun  = midpoint(highs, lows, i, 26);
    const senkouB = midpoint(highs, lows, i, 52);

    let senkouA: number | undefined;
    if (tenkan !== undefined && kijun !== undefined) {
      senkouA = (tenkan + kijun) / 2;
    }

    let cloudTop: number | undefined;
    let cloudBottom: number | undefined;
    if (senkouA !== undefined && senkouB !== undefined) {
      cloudTop    = Math.max(senkouA, senkouB);
      cloudBottom = Math.min(senkouA, senkouB);
    }

    result[i] = { tenkan, kijun, senkouA, senkouB, cloudTop, cloudBottom };
  }

  return result;
}

// ------------------------------------------------------------------
// Donchian Channel
// ------------------------------------------------------------------

/**
 * Donchian Channel
 *
 * Upper  = max(High[period])
 * Lower  = min(Low[period])
 * Middle = (Upper + Lower) / 2
 *
 * @param highs   高値配列
 * @param lows    安値配列
 * @param period  期間（デフォルト 20）
 */
export function calculateDonchian(
  highs:  number[],
  lows:   number[],
  period: number,
): DonchianResult[] {
  const n = highs.length;
  const empty = (): DonchianResult => ({ upper: undefined, lower: undefined, middle: undefined });
  const result: DonchianResult[] = Array.from({ length: n }, empty);

  for (let i = period - 1; i < n; i++) {
    let upper = -Infinity;
    let lower =  Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > upper) upper = highs[j];
      if (lows[j]  < lower) lower = lows[j];
    }
    result[i] = { upper, lower, middle: (upper + lower) / 2 };
  }

  return result;
}

// ------------------------------------------------------------------
// Keltner Channel
// ------------------------------------------------------------------

/**
 * Keltner Channel
 *
 * Middle = EMA(close, period)
 * Upper  = Middle + multiplier × ATR(atrPeriod)
 * Lower  = Middle - multiplier × ATR(atrPeriod)
 *
 * @param bars        OHLCバー配列
 * @param emaPeriod   EMA 期間（デフォルト 20）
 * @param atrPeriod   ATR 期間（デフォルト 10）
 * @param multiplier  ATR 乗数（デフォルト 2.0）
 */
export function calculateKeltner(
  bars:       Bar[],
  emaPeriod:  number,
  atrPeriod:  number,
  multiplier: number,
): KeltnerResult[] {
  const n = bars.length;
  const empty = (): KeltnerResult => ({ upper: undefined, lower: undefined, middle: undefined });
  const result: KeltnerResult[] = Array.from({ length: n }, empty);

  const closes = bars.map(b => b.close);
  const ema    = calculateEMA(closes, emaPeriod);
  const atr    = calculateATR(bars, atrPeriod);

  for (let i = 0; i < n; i++) {
    const mid = ema[i];
    const a   = atr[i];
    if (mid === undefined || a === undefined) continue;
    result[i] = {
      middle: mid,
      upper:  mid + multiplier * a,
      lower:  mid - multiplier * a,
    };
  }

  return result;
}

// ------------------------------------------------------------------
// Stochastic RSI
// ------------------------------------------------------------------

/**
 * Stochastic RSI
 *
 * RSI      = calculateRSI(closes, rsiPeriod)
 * StochRSI = (RSI - min(RSI[stochPeriod])) / (max(RSI[stochPeriod]) - min(RSI[stochPeriod]))
 * 値域: 0〜1
 *
 * @param bars        OHLCバー配列
 * @param rsiPeriod   RSI 期間（デフォルト 14）
 * @param stochPeriod Stochastic 期間（デフォルト 14）
 */
export function calculateStochRSI(
  bars:        Bar[],
  rsiPeriod:   number,
  stochPeriod: number,
): (number | undefined)[] {
  const n = bars.length;
  const result: (number | undefined)[] = new Array(n).fill(undefined);

  const rsi = calculateRSI(bars, rsiPeriod);

  for (let i = stochPeriod - 1; i < n; i++) {
    let minRSI = Infinity;
    let maxRSI = -Infinity;
    let valid = true;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      const r = rsi[j];
      if (r === undefined) { valid = false; break; }
      if (r < minRSI) minRSI = r;
      if (r > maxRSI) maxRSI = r;
    }
    if (!valid) continue;
    const currRSI = rsi[i];
    if (currRSI === undefined) continue;
    const denom = maxRSI - minRSI;
    result[i] = denom === 0 ? 0 : (currRSI - minRSI) / denom;
  }

  return result;
}

// ------------------------------------------------------------------
// ROC — Rate of Change
// ------------------------------------------------------------------

/**
 * Rate of Change
 * ROC[i] = ((Close[i] - Close[i-period]) / Close[i-period]) × 100
 *
 * @param closes  終値配列
 * @param period  期間（デフォルト 14）
 */
export function calculateROC(
  closes: number[],
  period: number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period; i < n; i++) {
    const prev = closes[i - period];
    if (prev !== 0) {
      result[i] = ((closes[i] - prev) / prev) * 100;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// AO — Awesome Oscillator (Bill Williams)
// ------------------------------------------------------------------

/**
 * Awesome Oscillator
 * Midpoint = (High + Low) / 2
 * AO = SMA(Midpoint, 5) - SMA(Midpoint, 34)
 *
 * @param highs  高値配列
 * @param lows   安値配列
 */
export function calculateAO(
  highs: number[],
  lows:  number[],
): (number | undefined)[] {
  const n = highs.length;
  if (n === 0) return [];

  const midpoints = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    midpoints[i] = (highs[i] + lows[i]) / 2;
  }

  const sma5  = calculateSMA(midpoints, 5);
  const sma34 = calculateSMA(midpoints, 34);

  const result: (number | undefined)[] = new Array(n).fill(undefined);
  for (let i = 0; i < n; i++) {
    const s5  = sma5[i];
    const s34 = sma34[i];
    if (s5 !== undefined && s34 !== undefined) {
      result[i] = s5 - s34;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// Aroon
// ------------------------------------------------------------------

/**
 * Aroon Indicator
 *
 * AroonUp   = ((period - periods since highest high) / period) × 100
 * AroonDown = ((period - periods since lowest low)  / period) × 100
 * Oscillator = AroonUp - AroonDown (値域 -100〜+100)
 *
 * @param highs   高値配列
 * @param lows    安値配列
 * @param period  期間（デフォルト 14）
 */
export function calculateAroon(
  highs:  number[],
  lows:   number[],
  period: number,
): AroonResult[] {
  const n = highs.length;
  const empty = (): AroonResult => ({ up: undefined, down: undefined, oscillator: undefined });
  const result: AroonResult[] = Array.from({ length: n }, empty);

  for (let i = period; i < n; i++) {
    let highestIdx = i;
    let lowestIdx  = i;
    for (let j = i - period; j <= i; j++) {
      if (highs[j] >= highs[highestIdx]) highestIdx = j;
      if (lows[j]  <= lows[lowestIdx])   lowestIdx  = j;
    }
    const periodsSinceHigh = i - highestIdx;
    const periodsSinceLow  = i - lowestIdx;
    const up   = ((period - periodsSinceHigh) / period) * 100;
    const down = ((period - periodsSinceLow)  / period) * 100;
    result[i] = { up, down, oscillator: up - down };
  }

  return result;
}

// ------------------------------------------------------------------
// Force Index
// ------------------------------------------------------------------

/**
 * Force Index (Elder)
 *
 * Force[i]       = (Close[i] - Close[i-1]) × Volume[i]
 * ForceEMA[i]    = EMA(Force, period)
 *
 * @param closes   終値配列
 * @param volumes  ボリューム配列
 * @param period   平滑化期間（デフォルト 13）
 */
export function calculateForceIndex(
  closes:  number[],
  volumes: number[],
  period:  number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  // Raw force (index 1 から有効)
  const force: (number | undefined)[] = new Array(n).fill(undefined);
  for (let i = 1; i < n; i++) {
    force[i] = (closes[i] - closes[i - 1]) * volumes[i];
  }

  // EMA of force — extract valid values from index 1
  if (n < period + 1) return new Array(n).fill(undefined);

  const result: (number | undefined)[] = new Array(n).fill(undefined);
  const k = emaK(period);

  // Initial EMA = SMA(force[1..period])
  let ema = 0;
  for (let i = 1; i <= period; i++) {
    ema += force[i]!;
  }
  ema /= period;
  result[period] = ema;

  for (let i = period + 1; i < n; i++) {
    const f = force[i];
    if (f !== undefined) {
      ema = f * k + ema * (1 - k);
      result[i] = ema;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// MFI — Money Flow Index
// ------------------------------------------------------------------

/**
 * Money Flow Index
 *
 * TypicalPrice = (High + Low + Close) / 3
 * MoneyFlow    = TypicalPrice × Volume
 * MFI          = 100 - (100 / (1 + PositiveMF / NegativeMF))
 * 値域: 0〜100
 *
 * @param highs   高値配列
 * @param lows    安値配列
 * @param closes  終値配列
 * @param volumes ボリューム配列
 * @param period  期間（デフォルト 14）
 */
export function calculateMFI(
  highs:   number[],
  lows:    number[],
  closes:  number[],
  volumes: number[],
  period:  number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  // Typical Prices and Money Flows
  const tp = new Array<number>(n);
  const mf = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
    mf[i] = tp[i] * volumes[i];
  }

  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period; i < n; i++) {
    let posMF = 0;
    let negMF = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1])      posMF += mf[j];
      else if (tp[j] < tp[j - 1]) negMF += mf[j];
      // 変化なし: 中立として扱う
    }
    if (negMF === 0) {
      result[i] = posMF > 0 ? 100 : 50;
    } else {
      result[i] = 100 - 100 / (1 + posMF / negMF);
    }
  }

  return result;
}

// ------------------------------------------------------------------
// CMF — Chaikin Money Flow
// ------------------------------------------------------------------

/**
 * Chaikin Money Flow
 *
 * MoneyFlowMultiplier = ((Close - Low) - (High - Close)) / (High - Low)
 * MoneyFlowVolume     = MFM × Volume
 * CMF = Σ MFV[period] / Σ Volume[period]
 * 値域: -1〜+1
 *
 * @param highs   高値配列
 * @param lows    安値配列
 * @param closes  終値配列
 * @param volumes ボリューム配列
 * @param period  期間（デフォルト 20）
 */
export function calculateCMF(
  highs:   number[],
  lows:    number[],
  closes:  number[],
  volumes: number[],
  period:  number,
): (number | undefined)[] {
  const n = closes.length;
  if (period <= 0 || n === 0) return new Array(n).fill(undefined);

  const mfv = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const hl = highs[i] - lows[i];
    if (hl === 0) {
      mfv[i] = 0;
    } else {
      const mfm = ((closes[i] - lows[i]) - (highs[i] - closes[i])) / hl;
      mfv[i] = mfm * volumes[i];
    }
  }

  const result: (number | undefined)[] = new Array(n).fill(undefined);

  for (let i = period - 1; i < n; i++) {
    let sumMFV = 0;
    let sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumMFV += mfv[j];
      sumVol += volumes[j];
    }
    result[i] = sumVol > 0 ? sumMFV / sumVol : 0;
  }

  return result;
}

// ------------------------------------------------------------------
// Parabolic SAR
// ------------------------------------------------------------------

/**
 * Parabolic SAR (標準 MT5 実装に準拠)
 *
 * SAR[i] = SAR[i-1] + AF × (EP - SAR[i-1])
 * EP     = 期間中の最高値（上昇）または最安値（下降）
 * AF     = 加速係数（初期 step、最大 max、EP 更新ごとに step 加算）
 *
 * @param highs  高値配列
 * @param lows   安値配列
 * @param step   加速係数の刻み（デフォルト 0.02）
 * @param maxAF  加速係数の最大値（デフォルト 0.2）
 */
export function calculatePSAR(
  highs: number[],
  lows:  number[],
  step:  number,
  maxAF: number,
): (number | undefined)[] {
  const n = highs.length;
  if (n < 2) return new Array(n).fill(undefined);

  const result: (number | undefined)[] = new Array(n).fill(undefined);

  // 最初のトレンド方向を決定
  let isLong = highs[1] > highs[0];
  let af     = step;
  let ep     = isLong ? highs[0] : lows[0];
  let sar    = isLong ? lows[0]  : highs[0];

  result[0] = sar;

  for (let i = 1; i < n; i++) {
    // SAR 更新
    let newSar = sar + af * (ep - sar);

    if (isLong) {
      // 上昇トレンド: SAR は前2本の安値より下
      newSar = Math.min(newSar, lows[i - 1]);
      if (i >= 2) newSar = Math.min(newSar, lows[i - 2]);

      if (lows[i] < newSar) {
        // トレンド転換: 下降へ
        isLong = false;
        newSar = ep; // SAR = 直前 EP (最高値)
        ep     = lows[i];
        af     = step;
      } else {
        if (highs[i] > ep) {
          ep = highs[i];
          af = Math.min(af + step, maxAF);
        }
      }
    } else {
      // 下降トレンド: SAR は前2本の高値より上
      newSar = Math.max(newSar, highs[i - 1]);
      if (i >= 2) newSar = Math.max(newSar, highs[i - 2]);

      if (highs[i] > newSar) {
        // トレンド転換: 上昇へ
        isLong = true;
        newSar = ep; // SAR = 直前 EP (最安値)
        ep     = highs[i];
        af     = step;
      } else {
        if (lows[i] < ep) {
          ep = lows[i];
          af = Math.min(af + step, maxAF);
        }
      }
    }

    sar = newSar;
    result[i] = sar;
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
  ema1Period?:         number;  // 短期 EMA (デフォルト 21)
  ema2Period?:         number;  // 長期 EMA (デフォルト 200)
  smaPeriod?:          number;  // SMA (デフォルト 50)
  atrPeriod?:          number;  // ATR (デフォルト 14)
  rsiPeriod?:          number;  // RSI (デフォルト 14)
  macdFast?:           number;  // MACD fast (デフォルト 12)
  macdSlow?:           number;  // MACD slow (デフォルト 26)
  macdSignal?:         number;  // MACD signal (デフォルト 9)
  adxPeriod?:          number;  // ADX (デフォルト 14)
  bbPeriod?:           number;  // BB period (デフォルト 20)
  bbDeviation?:        number;  // BB deviation (デフォルト 2.0)
  stochPeriod?:        number;  // Stochastic (デフォルト 14)
  wmaPeriod?:          number;  // WMA (デフォルト 14)
  vwmaPeriod?:         number;  // VWMA (デフォルト 14)
  cciPeriod?:          number;  // CCI (デフォルト 14)
  williamsRPeriod?:    number;  // Williams %R (デフォルト 14)
  momentumPeriod?:     number;  // Momentum (デフォルト 10)
  volumeRatioPeriod?:  number;  // Volume Ratio (デフォルト 20)
  // New indicators
  hmaPeriod?:          number;  // HMA (デフォルト 14)
  demaPeriod?:         number;  // DEMA (デフォルト 14)
  donchianPeriod?:     number;  // Donchian Channel (デフォルト 20)
  keltnerPeriod?:      number;  // Keltner EMA 期間 (デフォルト 20)
  keltnerAtrPeriod?:   number;  // Keltner ATR 期間 (デフォルト 10)
  keltnerMultiplier?:  number;  // Keltner ATR 乗数 (デフォルト 2.0)
  stochRsiRsiPeriod?:  number;  // StochRSI の RSI 期間 (デフォルト 14)
  stochRsiPeriod?:     number;  // StochRSI の Stoch 期間 (デフォルト 14)
  rocPeriod?:          number;  // ROC 期間 (デフォルト 14)
  aroonPeriod?:        number;  // Aroon 期間 (デフォルト 14)
  forceIndexPeriod?:   number;  // Force Index EMA 期間 (デフォルト 13)
  mfiPeriod?:          number;  // MFI 期間 (デフォルト 14)
  cmfPeriod?:          number;  // CMF 期間 (デフォルト 20)
  psarStep?:           number;  // PSAR 加速係数刻み (デフォルト 0.02)
  psarMax?:            number;  // PSAR 加速係数最大値 (デフォルト 0.2)
}

export interface PrecomputedIndicators {
  ema1:        (number | undefined)[];
  ema2:        (number | undefined)[];
  sma:         (number | undefined)[];
  atr:         (number | undefined)[];
  rsi:         (number | undefined)[];
  macd:        MACDResult[];
  adx:         ADXResult[];
  bb:          BollingerResult[];
  stoch:       (number | undefined)[];
  wma:         (number | undefined)[];
  vwma:        (number | undefined)[];
  cci:         (number | undefined)[];
  williamsR:   (number | undefined)[];
  momentum:    (number | undefined)[];
  obv:         (number | undefined)[];
  volumeRatio: (number | undefined)[];
  // New indicators
  hma:         (number | undefined)[];
  dema:        (number | undefined)[];
  ichimoku:    IchimokuResult[];
  donchian:    DonchianResult[];
  keltner:     KeltnerResult[];
  stochRsi:    (number | undefined)[];
  roc:         (number | undefined)[];
  ao:          (number | undefined)[];
  aroon:       AroonResult[];
  forceIndex:  (number | undefined)[];
  mfi:         (number | undefined)[];
  cmf:         (number | undefined)[];
  psar:        (number | undefined)[];
  params:      Required<PrecomputeParams>;
}

export function precomputeIndicators(
  bars: Bar[],
  p: PrecomputeParams = {},
): PrecomputedIndicators {
  const params: Required<PrecomputeParams> = {
    ema1Period:          p.ema1Period          ?? 21,
    ema2Period:          p.ema2Period          ?? 200,
    smaPeriod:           p.smaPeriod           ?? 50,
    atrPeriod:           p.atrPeriod           ?? 14,
    rsiPeriod:           p.rsiPeriod           ?? 14,
    macdFast:            p.macdFast            ?? 12,
    macdSlow:            p.macdSlow            ?? 26,
    macdSignal:          p.macdSignal          ?? 9,
    adxPeriod:           p.adxPeriod           ?? 14,
    bbPeriod:            p.bbPeriod            ?? 20,
    bbDeviation:         p.bbDeviation         ?? 2.0,
    stochPeriod:         p.stochPeriod         ?? 14,
    wmaPeriod:           p.wmaPeriod           ?? 14,
    vwmaPeriod:          p.vwmaPeriod          ?? 14,
    cciPeriod:           p.cciPeriod           ?? 14,
    williamsRPeriod:     p.williamsRPeriod     ?? 14,
    momentumPeriod:      p.momentumPeriod      ?? 10,
    volumeRatioPeriod:   p.volumeRatioPeriod   ?? 20,
    hmaPeriod:           p.hmaPeriod           ?? 14,
    demaPeriod:          p.demaPeriod          ?? 14,
    donchianPeriod:      p.donchianPeriod      ?? 20,
    keltnerPeriod:       p.keltnerPeriod       ?? 20,
    keltnerAtrPeriod:    p.keltnerAtrPeriod    ?? 10,
    keltnerMultiplier:   p.keltnerMultiplier   ?? 2.0,
    stochRsiRsiPeriod:   p.stochRsiRsiPeriod   ?? 14,
    stochRsiPeriod:      p.stochRsiPeriod      ?? 14,
    rocPeriod:           p.rocPeriod           ?? 14,
    aroonPeriod:         p.aroonPeriod         ?? 14,
    forceIndexPeriod:    p.forceIndexPeriod    ?? 13,
    mfiPeriod:           p.mfiPeriod           ?? 14,
    cmfPeriod:           p.cmfPeriod           ?? 20,
    psarStep:            p.psarStep            ?? 0.02,
    psarMax:             p.psarMax             ?? 0.2,
  };

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume ?? 0);

  return {
    ema1:        calculateEMA(closes, params.ema1Period),
    ema2:        calculateEMA(closes, params.ema2Period),
    sma:         calculateSMA(closes, params.smaPeriod),
    atr:         calculateATR(bars, params.atrPeriod),
    rsi:         calculateRSI(bars, params.rsiPeriod),
    macd:        calculateMACD(bars, params.macdFast, params.macdSlow, params.macdSignal),
    adx:         calculateADX(bars, params.adxPeriod),
    bb:          calculateBollingerBands(bars, params.bbPeriod, params.bbDeviation),
    stoch:       calculateStochastic(bars, params.stochPeriod),
    wma:         calculateWMA(closes, params.wmaPeriod),
    vwma:        calculateVWMA(closes, volumes, params.vwmaPeriod),
    cci:         calculateCCI(highs, lows, closes, params.cciPeriod),
    williamsR:   calculateWilliamsR(highs, lows, closes, params.williamsRPeriod),
    momentum:    calculateMomentum(closes, params.momentumPeriod),
    obv:         calculateOBV(closes, volumes),
    volumeRatio: calculateVolumeRatio(volumes, params.volumeRatioPeriod),
    hma:         calculateHMA(closes, params.hmaPeriod),
    dema:        calculateDEMA(closes, params.demaPeriod),
    ichimoku:    calculateIchimoku(highs, lows),
    donchian:    calculateDonchian(highs, lows, params.donchianPeriod),
    keltner:     calculateKeltner(bars, params.keltnerPeriod, params.keltnerAtrPeriod, params.keltnerMultiplier),
    stochRsi:    calculateStochRSI(bars, params.stochRsiRsiPeriod, params.stochRsiPeriod),
    roc:         calculateROC(closes, params.rocPeriod),
    ao:          calculateAO(highs, lows),
    aroon:       calculateAroon(highs, lows, params.aroonPeriod),
    forceIndex:  calculateForceIndex(closes, volumes, params.forceIndexPeriod),
    mfi:         calculateMFI(highs, lows, closes, volumes, params.mfiPeriod),
    cmf:         calculateCMF(highs, lows, closes, volumes, params.cmfPeriod),
    psar:        calculatePSAR(highs, lows, params.psarStep, params.psarMax),
    params,
  };
}

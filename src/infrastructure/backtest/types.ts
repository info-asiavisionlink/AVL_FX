// =================================================================
// Backtest Types
//
// Bar 型は既存の src/infrastructure/analysis/types.ts から再利用。
// バックテスト専用の Indicator 結果型をここで定義する。
// =================================================================

// 既存 Bar 型を再エクスポート（二重定義防止）
export type { Bar } from "@/infrastructure/analysis/types";

// ------------------------------------------------------------------
// Indicator 結果型（配列の各要素がバー1本に対応）
// ------------------------------------------------------------------

/** MACD の1バー分の計算結果 */
export interface MACDResult {
  /** MACD ライン = EMA(fast) - EMA(slow) */
  macd:      number | undefined;
  /** シグナルライン = EMA(signal, macd) */
  signal:    number | undefined;
  /** ヒストグラム = MACD - Signal */
  histogram: number | undefined;
}

/** ADX + DI の1バー分の計算結果 */
export interface ADXResult {
  /** Average Directional Index (0-100) */
  adx:     number | undefined;
  /** +DI：上昇方向性指数 (0-100) */
  diPlus:  number | undefined;
  /** -DI：下降方向性指数 (0-100) */
  diMinus: number | undefined;
}

/** ボリンジャーバンドの1バー分の計算結果 */
export interface BollingerResult {
  /** 上限バンド */
  upper:  number | undefined;
  /** 中心線（SMA） */
  middle: number | undefined;
  /** 下限バンド */
  lower:  number | undefined;
  /** バンド幅 = (upper - lower) / middle × 100 */
  width:  number | undefined;
}

// ------------------------------------------------------------------
// Warm-up 期間定数
//
// Indicator を有効に使うには最低限必要なバー数（index）。
// result[0..warmup-1] は undefined。
// BacktestEngine はこの値を使ってループ開始位置を決定する。
//
// 計算根拠:
//   SMA(n):    n本必要 → index n-1 が最初の有効値
//   EMA(n):    SMA初期化にn本必要 → index n-1
//   ATR(n):    TR[0..n-1]の SMA → index n-1
//   RSI(n):    変化量はindex1から始まり n本の平均 → index n
//   MACD(f,s,sig): EMA(slow) が index slow-1、
//                  Signal EMA(sig)がその後sig-1本 → index slow+sig-2
//   ADX(n):    Smooth(+DM,-DM,TR) は index n から有効、
//              ADX = Smooth(DX) でさらに n 本必要 → index 2n-1
//   BB(n):     SMA(n) と同じ → index n-1
//   STOCH(n):  n本のウィンドウ → index n-1
// ------------------------------------------------------------------

export const WARMUP_BARS = {
  sma:   (period: number): number => period - 1,
  ema:   (period: number): number => period - 1,
  atr:   (period: number): number => period - 1,
  rsi:   (period: number): number => period,
  macd:  (slowPeriod: number, signalPeriod: number): number =>
           slowPeriod - 1 + signalPeriod - 1,
  adx:   (period: number): number => 2 * period - 1,
  bb:    (period: number): number => period - 1,
  stoch: (period: number): number => period - 1,
} as const;

// ------------------------------------------------------------------
// 標準パラメーターでの Warm-up 期間早見表
//
//   EMA21:      20
//   EMA200:    199
//   ATR14:      13
//   RSI14:      14
//   MACD12,26,9: 33
//   ADX14:      27
//   BB20:       19
//   STOCH14:    13
//
// バックテストで標準セットを使う場合の最大 warm-up = 33 (MACD)
// ADX を使う場合は 27 なので MACD の 33 が支配的
// ------------------------------------------------------------------

/** 標準パラメーターでの最大 warm-up バー数 */
export const MAX_WARMUP_STANDARD = 33; // MACD(12,26,9) が支配的

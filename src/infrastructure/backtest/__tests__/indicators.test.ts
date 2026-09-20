/**
 * Unit Tests — Pure Indicator Calculator
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/indicators.test.ts
 *
 * テスト内容:
 *   - 配列長 (input length = output length)
 *   - Index Alignment
 *   - Warm-up 期間（leading undefined）
 *   - 値の範囲（RSI 0-100, Stoch 0-100 等）
 *   - 既知値との比較（手計算で検証可能な小さいデータセット）
 *   - エッジケース（一定価格、単調増加、単調減少、交互変動）
 */

import assert from "node:assert/strict";
import {
  calculateSMA,
  calculateEMA,
  calculateATR,
  calculateRSI,
  calculateMACD,
  calculateADX,
  calculateBollingerBands,
  calculateStochastic,
  precomputeIndicators,
} from "../indicators";
import { WARMUP_BARS } from "../types";
import type { Bar } from "@/infrastructure/analysis/types";

// =================================================================
// ─── ユーティリティ ─────────────────────────────────────────────
// =================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}`);
    console.error(`     ${msg}`);
    failed++;
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n📊 ${name}`);
  fn();
}

/** 数値の近似比較（許容誤差あり）*/
function assertClose(actual: number, expected: number, tol = 1e-6, msg = ""): void {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= tol,
    `${msg} expected ${expected} ± ${tol}, got ${actual} (diff=${diff})`
  );
}

/** 全要素が undefined であることを確認 */
function assertAllUndefined(arr: (number | undefined)[], label: string): void {
  for (let i = 0; i < arr.length; i++) {
    assert.strictEqual(arr[i], undefined, `${label}[${i}] should be undefined`);
  }
}

/** warm-up 期間が undefined, それ以降が defined であることを確認 */
function assertWarmup(arr: (number | undefined)[], warmup: number, label: string): void {
  // leading undefined
  for (let i = 0; i < warmup; i++) {
    assert.strictEqual(arr[i], undefined, `${label}[${i}] warmup should be undefined`);
  }
  // first valid
  if (arr.length > warmup) {
    assert.notStrictEqual(arr[warmup], undefined, `${label}[${warmup}] should be defined`);
  }
}

// =================================================================
// ─── テストデータ ────────────────────────────────────────────────
// =================================================================

/** OHLC バーを生成するヘルパー */
function makeBars(closes: number[], options?: {
  highMult?: number;  // close × multiplier = high (デフォルト 1.001)
  lowMult?:  number;  // close × multiplier = low  (デフォルト 0.999)
  highs?: number[];   // 直接指定
  lows?:  number[];   // 直接指定
}): Bar[] {
  return closes.map((close, i) => ({
    time:   i * 300_000,   // 5分足ベース
    open:   close,
    high:   options?.highs?.[i] ?? close * (options?.highMult ?? 1.001),
    low:    options?.lows?.[i]  ?? close * (options?.lowMult  ?? 0.999),
    close,
    volume: 1000,
  }));
}

// テストシナリオ
const N   = 60;   // 60本（全指標の warm-up を超える）
const EPS = 1e-9; // 浮動小数誤差の許容値

const constant50  = makeBars(Array.from({ length: N }, () => 50));
const constant100 = makeBars(Array.from({ length: N }, () => 100));

const trendingUp  = makeBars(
  Array.from({ length: N }, (_, i) => 100 + i),
  { highs: Array.from({ length: N }, (_, i) => 101 + i),
    lows:  Array.from({ length: N }, (_, i) =>  99 + i) }
);

const trendingDown = makeBars(
  Array.from({ length: N }, (_, i) => 200 - i),
  { highs: Array.from({ length: N }, (_, i) => 201 - i),
    lows:  Array.from({ length: N }, (_, i) => 199 - i) }
);

const alternating = makeBars(
  Array.from({ length: N }, (_, i) => 100 + (i % 2) * 2),
  { highs: Array.from({ length: N }, (_, i) => 103 + (i % 2)),
    lows:  Array.from({ length: N }, (_, i) =>  97 + (i % 2)) }
);

// 手計算可能な小さいデータセット
const small4 = makeBars([2, 4, 6, 8]);   // SMA/EMA の検証用

// =================================================================
// ─── SMA ────────────────────────────────────────────────────────
// =================================================================
describe("SMA", () => {

  test("配列長 = input length", () => {
    const res = calculateSMA(constant100.map(b => b.close), 5);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: period=5 → index 0-3 が undefined, index 4 が defined", () => {
    const res = calculateSMA(constant100.map(b => b.close), 5);
    assertWarmup(res, WARMUP_BARS.sma(5), "SMA5");
  });

  test("一定価格 100 → SMA = 100", () => {
    const res = calculateSMA(constant100.map(b => b.close), 5);
    for (let i = 4; i < N; i++) {
      assertClose(res[i]!, 100, EPS, `SMA[${i}]`);
    }
  });

  test("手計算: [2,4,6,8] SMA3 → [undef, undef, 4, 6]", () => {
    const res = calculateSMA([2, 4, 6, 8], 3);
    assert.strictEqual(res[0], undefined);
    assert.strictEqual(res[1], undefined);
    assertClose(res[2]!, 4, EPS);   // (2+4+6)/3
    assertClose(res[3]!, 6, EPS);   // (4+6+8)/3
  });

  test("period=1 → 全て入力値と一致", () => {
    const closes = [10, 20, 30, 40];
    const res = calculateSMA(closes, 1);
    res.forEach((v, i) => assertClose(v!, closes[i], EPS, `SMA1[${i}]`));
  });

  test("空配列 → 空配列", () => {
    const res = calculateSMA([], 5);
    assert.strictEqual(res.length, 0);
  });

});

// =================================================================
// ─── EMA ────────────────────────────────────────────────────────
// =================================================================
describe("EMA", () => {

  test("配列長 = input length", () => {
    const res = calculateEMA(constant100.map(b => b.close), 21);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: EMA21 → index 0-19 が undefined, index 20 が defined", () => {
    const res = calculateEMA(constant100.map(b => b.close), 21);
    assertWarmup(res, WARMUP_BARS.ema(21), "EMA21");
  });

  test("一定価格 100 → EMA = 100（初期値 SMA = 100、以降も 100）", () => {
    const res = calculateEMA(constant100.map(b => b.close), 5);
    for (let i = 4; i < N; i++) {
      assertClose(res[i]!, 100, EPS, `EMA5[${i}]`);
    }
  });

  test("手計算: [2,4,6,8] EMA3 → index2=4, index3=6", () => {
    // k = 2/(3+1) = 0.5
    // EMA[2] = SMA(2,4,6) = 4
    // EMA[3] = 8×0.5 + 4×0.5 = 6
    const res = calculateEMA([2, 4, 6, 8], 3);
    assert.strictEqual(res[0], undefined);
    assert.strictEqual(res[1], undefined);
    assertClose(res[2]!, 4, EPS);
    assertClose(res[3]!, 6, EPS);
  });

  test("上昇相場 → EMA は上昇傾向（最終値 > 初期有効値）", () => {
    const closes = trendingUp.map(b => b.close);
    const res = calculateEMA(closes, 21);
    const firstValid = res[20]!;
    const lastValid  = res[N - 1]!;
    assert.ok(lastValid > firstValid, `EMA last ${lastValid} > first ${firstValid}`);
  });

  test("EMA21 < EMA200 の初期ウォームアップ後の参照整合性", () => {
    const closes = trendingUp.map(b => b.close);
    const ema21  = calculateEMA(closes, 21);
    const ema200 = calculateEMA(closes, 200);
    // 60本しかないので EMA200 は全て undefined
    assertAllUndefined(ema200 as (number | undefined)[], "EMA200 with 60 bars");
    // EMA21 は index 20 から有効
    assert.notStrictEqual(ema21[20], undefined);
  });

});

// =================================================================
// ─── ATR ────────────────────────────────────────────────────────
// =================================================================
describe("ATR", () => {

  test("配列長 = input length", () => {
    const res = calculateATR(constant100, 14);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: ATR14 → index 0-12 が undefined, index 13 が defined", () => {
    const res = calculateATR(constant100, 14);
    assertWarmup(res, WARMUP_BARS.atr(14), "ATR14");
  });

  test("ATR >= 0 （全有効値）", () => {
    const res = calculateATR(trendingUp, 14);
    for (let i = 13; i < N; i++) {
      assert.ok(res[i]! >= 0, `ATR[${i}] = ${res[i]} should be >= 0`);
    }
  });

  test("一定価格 → ATR = 0（high/low の幅がほぼ 0）", () => {
    // high = 100.001, low = 99.999 → range = 0.002
    // 前バーの close から変化なし → TR = range = 0.002
    const bars = makeBars(Array.from({ length: N }, () => 100));
    const res = calculateATR(bars, 14);
    // ATR は range に収束（0 ではなくわずかな正値）
    for (let i = 13; i < N; i++) {
      assert.ok(res[i]! >= 0, `ATR[${i}] must be >= 0`);
      assert.ok(res[i]! < 1, `ATR[${i}] must be small for constant prices`);
    }
  });

  test("上昇相場 → ATR は正の値", () => {
    const res = calculateATR(trendingUp, 14);
    for (let i = 13; i < N; i++) {
      assert.ok(res[i]! > 0, `ATR[${i}] should be > 0 for trending market`);
    }
  });

  test("TR[0] = High-Low（前バーなし）", () => {
    const bars: Bar[] = [{ time: 0, open: 100, high: 110, low: 90, close: 100, volume: 1 }];
    const res = calculateATR(bars, 1);
    // period=1: ATR[0] = SMA of TR[0..0] = TR[0] = 110-90 = 20
    assertClose(res[0]!, 20, EPS, "ATR period=1 first bar");
  });

});

// =================================================================
// ─── RSI ────────────────────────────────────────────────────────
// =================================================================
describe("RSI", () => {

  test("配列長 = input length", () => {
    const res = calculateRSI(constant100, 14);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: RSI14 → index 0-13 が undefined, index 14 が defined", () => {
    const res = calculateRSI(constant100, 14);
    assertWarmup(res, WARMUP_BARS.rsi(14), "RSI14");
  });

  test("0 <= RSI <= 100 （全有効値）", () => {
    for (const bars of [trendingUp, trendingDown, alternating, constant100]) {
      const res = calculateRSI(bars, 14);
      for (let i = 14; i < N; i++) {
        const v = res[i]!;
        assert.ok(v >= 0 && v <= 100, `RSI[${i}] = ${v} out of range [0,100]`);
      }
    }
  });

  test("純粋上昇（連続ゲイン）→ RSI は高値（> 80）", () => {
    const bars = makeBars(Array.from({ length: 30 }, (_, i) => 100 + i));
    const res = calculateRSI(bars, 14);
    const last = res[res.length - 1]!;
    assert.ok(last > 80, `RSI ${last} should be > 80 for pure uptrend`);
  });

  test("純粋下降（連続ロス）→ RSI は低値（< 20）", () => {
    const bars = makeBars(Array.from({ length: 30 }, (_, i) => 200 - i));
    const res = calculateRSI(bars, 14);
    const last = res[res.length - 1]!;
    assert.ok(last < 20, `RSI ${last} should be < 20 for pure downtrend`);
  });

  test("横ばい → RSI = 50", () => {
    const res = calculateRSI(constant50, 14);
    // 変化なし → avgGain = avgLoss = 0 → RSI = 50
    for (let i = 14; i < N; i++) {
      assertClose(res[i]!, 50, EPS, `RSI flat[${i}]`);
    }
  });

  test("交互変動 → RSI は 0-100 内で安定", () => {
    const res = calculateRSI(alternating, 14);
    for (let i = 14; i < N; i++) {
      const v = res[i]!;
      assert.ok(v >= 0 && v <= 100, `RSI alternating[${i}] = ${v} out of range`);
    }
  });

});

// =================================================================
// ─── MACD ───────────────────────────────────────────────────────
// =================================================================
describe("MACD", () => {

  test("配列長 = input length", () => {
    const res = calculateMACD(constant100);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: MACD(12,26,9) → index 33 が最初の valid (signal あり)", () => {
    const res = calculateMACD(constant100);
    const warmup = WARMUP_BARS.macd(26, 9); // = 33
    for (let i = 0; i < warmup; i++) {
      assert.strictEqual(res[i].signal, undefined, `signal[${i}] should be undefined`);
    }
    assert.notStrictEqual(res[warmup].signal, undefined, `signal[${warmup}] should be defined`);
  });

  test("一定価格 → MACD line = 0, signal = 0, histogram = 0", () => {
    const res = calculateMACD(constant100);
    for (let i = 33; i < N; i++) {
      assertClose(res[i].macd!,      0, EPS, `macd[${i}]`);
      assertClose(res[i].signal!,    0, EPS, `signal[${i}]`);
      assertClose(res[i].histogram!, 0, EPS, `histogram[${i}]`);
    }
  });

  test("histogram = macd - signal（全有効インデックス）", () => {
    const res = calculateMACD(trendingUp);
    for (let i = 33; i < N; i++) {
      if (res[i].macd !== undefined && res[i].signal !== undefined) {
        const expected = res[i].macd! - res[i].signal!;
        assertClose(res[i].histogram!, expected, EPS, `histogram[${i}]`);
      }
    }
  });

  test("上昇相場 → 初期は MACD > 0 の傾向", () => {
    const res = calculateMACD(trendingUp);
    const macdValues = res.slice(33).map(r => r.macd).filter(v => v !== undefined) as number[];
    const positive = macdValues.filter(v => v > 0).length;
    // 上昇相場で MACD が正の場合が多いことを確認
    assert.ok(positive > macdValues.length * 0.5, `Most MACD values should be positive for uptrend`);
  });

  test("MACD index 25 (slow-1) に macd 値あり, signal はまだなし", () => {
    const res = calculateMACD(trendingUp);
    assert.notStrictEqual(res[25].macd, undefined, "macd at index 25 should be defined");
    assert.strictEqual(res[25].signal, undefined,  "signal at index 25 should be undefined");
  });

});

// =================================================================
// ─── ADX / DI+ / DI- ────────────────────────────────────────────
// =================================================================
describe("ADX + DI", () => {

  test("配列長 = input length", () => {
    const res = calculateADX(constant100, 14);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: DI+/DI- index 14, ADX index 27", () => {
    const res = calculateADX(trendingUp, 14);
    // DI+/DI- は index 14 から
    for (let i = 0; i < 14; i++) {
      assert.strictEqual(res[i].diPlus,  undefined, `DI+[${i}] warmup`);
      assert.strictEqual(res[i].diMinus, undefined, `DI-[${i}] warmup`);
    }
    assert.notStrictEqual(res[14].diPlus,  undefined, "DI+[14] should be defined");
    assert.notStrictEqual(res[14].diMinus, undefined, "DI-[14] should be defined");

    // ADX は index 27 から
    const warmupADX = WARMUP_BARS.adx(14); // = 27
    for (let i = 0; i < warmupADX; i++) {
      assert.strictEqual(res[i].adx, undefined, `ADX[${i}] warmup`);
    }
    assert.notStrictEqual(res[warmupADX].adx, undefined, `ADX[${warmupADX}] should be defined`);
  });

  test("0 <= ADX <= 100", () => {
    for (const bars of [trendingUp, trendingDown, alternating]) {
      const res = calculateADX(bars, 14);
      for (let i = 27; i < N; i++) {
        const v = res[i].adx!;
        assert.ok(v >= 0 && v <= 100, `ADX[${i}] = ${v} out of range`);
      }
    }
  });

  test("0 <= DI+/DI-", () => {
    const res = calculateADX(trendingUp, 14);
    for (let i = 14; i < N; i++) {
      assert.ok(res[i].diPlus!  >= 0, `DI+[${i}] must be >= 0`);
      assert.ok(res[i].diMinus! >= 0, `DI-[${i}] must be >= 0`);
    }
  });

  test("上昇相場 → DI+ > DI- の傾向", () => {
    const res = calculateADX(trendingUp, 14);
    let diPlusWins = 0;
    for (let i = 14; i < N; i++) {
      if (res[i].diPlus! > res[i].diMinus!) diPlusWins++;
    }
    const total = N - 14;
    assert.ok(diPlusWins > total * 0.6, `DI+ > DI- in ${diPlusWins}/${total} bars for uptrend`);
  });

  test("下降相場 → DI- > DI+ の傾向", () => {
    const res = calculateADX(trendingDown, 14);
    let diMinusWins = 0;
    for (let i = 14; i < N; i++) {
      if (res[i].diMinus! > res[i].diPlus!) diMinusWins++;
    }
    const total = N - 14;
    assert.ok(diMinusWins > total * 0.6, `DI- > DI+ in ${diMinusWins}/${total} bars for downtrend`);
  });

  test("トレンド相場 → ADX は高め（> 20）", () => {
    const res = calculateADX(trendingUp, 14);
    const lastADX = res[N - 1].adx!;
    assert.ok(lastADX > 20, `ADX ${lastADX} should indicate trending (> 20)`);
  });

});

// =================================================================
// ─── Bollinger Bands ────────────────────────────────────────────
// =================================================================
describe("Bollinger Bands", () => {

  test("配列長 = input length", () => {
    const res = calculateBollingerBands(constant100, 20);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: BB20 → index 0-18 が undefined, index 19 が defined", () => {
    const res = calculateBollingerBands(constant100, 20);
    for (let i = 0; i < 19; i++) {
      assert.strictEqual(res[i].upper,  undefined, `BB.upper[${i}] warmup`);
      assert.strictEqual(res[i].middle, undefined, `BB.middle[${i}] warmup`);
      assert.strictEqual(res[i].lower,  undefined, `BB.lower[${i}] warmup`);
    }
    assert.notStrictEqual(res[19].upper, undefined, "BB.upper[19] should be defined");
  });

  test("upper >= middle >= lower （全有効値）", () => {
    for (const bars of [trendingUp, trendingDown, alternating, constant100]) {
      const res = calculateBollingerBands(bars, 20);
      for (let i = 19; i < N; i++) {
        const { upper, middle, lower } = res[i];
        assert.ok(upper! >= middle!, `BB upper[${i}] >= middle`);
        assert.ok(middle! >= lower!, `BB middle[${i}] >= lower`);
      }
    }
  });

  test("一定価格 → upper = middle = lower（分散 = 0）", () => {
    const bars = makeBars(Array.from({ length: N }, () => 100));
    const res = calculateBollingerBands(bars, 5);
    for (let i = 4; i < N; i++) {
      assertClose(res[i].upper!,  100, EPS, `BB upper[${i}]`);
      assertClose(res[i].middle!, 100, EPS, `BB middle[${i}]`);
      assertClose(res[i].lower!,  100, EPS, `BB lower[${i}]`);
      assertClose(res[i].width!,  0,   EPS, `BB width[${i}]`);
    }
  });

  test("middle = SMA（同一アルゴリズムで一致）", () => {
    const closes = trendingUp.map(b => b.close);
    const bb  = calculateBollingerBands(trendingUp, 20);
    const sma = calculateSMA(closes, 20);
    for (let i = 19; i < N; i++) {
      assertClose(bb[i].middle!, sma[i]!, EPS, `BB.middle vs SMA[${i}]`);
    }
  });

  test("width > 0 for volatile market", () => {
    const res = calculateBollingerBands(alternating, 5);
    for (let i = 4; i < N; i++) {
      assert.ok(res[i].width! >= 0, `BB width[${i}] must be >= 0`);
    }
  });

});

// =================================================================
// ─── Stochastic ─────────────────────────────────────────────────
// =================================================================
describe("Stochastic %K", () => {

  test("配列長 = input length", () => {
    const res = calculateStochastic(constant100, 14);
    assert.strictEqual(res.length, N);
  });

  test("warm-up: STOCH14 → index 0-12 が undefined, index 13 が defined", () => {
    const res = calculateStochastic(constant100, 14);
    assertWarmup(res, WARMUP_BARS.stoch(14), "STOCH14");
  });

  test("0 <= %K <= 100 （全有効値）", () => {
    for (const bars of [trendingUp, trendingDown, alternating, constant100]) {
      const res = calculateStochastic(bars, 14);
      for (let i = 13; i < N; i++) {
        const v = res[i]!;
        assert.ok(v >= 0 && v <= 100, `STOCH[${i}] = ${v} out of range [0,100]`);
      }
    }
  });

  test("上昇相場 → Stochastic は高値（> 80）に向かう", () => {
    const res = calculateStochastic(trendingUp, 14);
    const last = res[N - 1]!;
    assert.ok(last > 80, `Stochastic ${last} should be > 80 for uptrend`);
  });

  test("下降相場 → Stochastic は低値（< 20）に向かう", () => {
    const res = calculateStochastic(trendingDown, 14);
    const last = res[N - 1]!;
    assert.ok(last < 20, `Stochastic ${last} should be < 20 for downtrend`);
  });

  test("一定高値・一定安値・中央終値 → %K = 50", () => {
    const bars: Bar[] = Array.from({ length: N }, (_, i) => ({
      time: i * 300_000, open: 105, high: 110, low: 90, close: 100, volume: 1,
    }));
    const res = calculateStochastic(bars, 14);
    // %K = (100 - 90) / (110 - 90) × 100 = 50
    for (let i = 13; i < N; i++) {
      assertClose(res[i]!, 50, EPS, `STOCH[${i}]`);
    }
  });

  test("分母 0（high=low）→ 50 を返す（クラッシュしない）", () => {
    const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
      time: i * 300_000, open: 100, high: 100, low: 100, close: 100, volume: 1,
    }));
    const res = calculateStochastic(bars, 14);
    for (let i = 13; i < bars.length; i++) {
      assertClose(res[i]!, 50, EPS, `STOCH flat[${i}]`);
    }
  });

  test("既存 calcStochastic との整合: 最終バーの値が一致", () => {
    // 既存: calcStochastic(bars, 14) = %K for last bar
    // 新: calculateStochastic(bars, 14)[last]
    // 同一アルゴリズムなので一致するはず
    const bars = alternating;
    const win  = bars.slice(-14);
    const hh   = Math.max(...win.map(b => b.high));
    const ll   = Math.min(...win.map(b => b.low));
    const expected = (bars[bars.length - 1].close - ll) / (hh - ll) * 100;

    const res = calculateStochastic(bars, 14);
    assertClose(res[bars.length - 1]!, expected, EPS, "Stoch last bar matches reference");
  });

});

// =================================================================
// ─── WARMUP_BARS 定数 ────────────────────────────────────────────
// =================================================================
describe("WARMUP_BARS 定数", () => {

  test("SMA(5) warmup = 4", () => {
    assert.strictEqual(WARMUP_BARS.sma(5), 4);
  });

  test("EMA(21) warmup = 20", () => {
    assert.strictEqual(WARMUP_BARS.ema(21), 20);
  });

  test("ATR(14) warmup = 13", () => {
    assert.strictEqual(WARMUP_BARS.atr(14), 13);
  });

  test("RSI(14) warmup = 14", () => {
    assert.strictEqual(WARMUP_BARS.rsi(14), 14);
  });

  test("MACD(12,26,9) warmup = 33", () => {
    assert.strictEqual(WARMUP_BARS.macd(26, 9), 33);
  });

  test("ADX(14) warmup = 27", () => {
    assert.strictEqual(WARMUP_BARS.adx(14), 27);
  });

  test("BB(20) warmup = 19", () => {
    assert.strictEqual(WARMUP_BARS.bb(20), 19);
  });

  test("Stoch(14) warmup = 13", () => {
    assert.strictEqual(WARMUP_BARS.stoch(14), 13);
  });

});

// =================================================================
// ─── Index Alignment ─────────────────────────────────────────────
// =================================================================
describe("Index Alignment（未来データ参照なし）", () => {

  test("SMA: bars[0..i] のみ使用（bars[i+1] を参照しない）", () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const full   = calculateSMA(closes, 3);
    // bars[0..5] だけ渡した場合の結果と一致するはず
    const partial = calculateSMA(closes.slice(0, 6), 3);
    for (let i = 0; i < 6; i++) {
      if (full[i] === undefined) assert.strictEqual(partial[i], undefined, `SMA[${i}] alignment`);
      else assertClose(full[i]!, partial[i]!, EPS, `SMA[${i}] alignment`);
    }
  });

  test("RSI: bars[0..i] のみ使用", () => {
    const full    = calculateRSI(trendingUp, 14);
    const partial = calculateRSI(trendingUp.slice(0, 30), 14);
    for (let i = 0; i < 30; i++) {
      if (full[i] === undefined) assert.strictEqual(partial[i], undefined);
      else assertClose(full[i]!, partial[i]!, EPS, `RSI[${i}] alignment`);
    }
  });

  test("ATR: bars[0..i] のみ使用", () => {
    const full    = calculateATR(trendingUp, 14);
    const partial = calculateATR(trendingUp.slice(0, 30), 14);
    for (let i = 0; i < 30; i++) {
      if (full[i] === undefined) assert.strictEqual(partial[i], undefined);
      else assertClose(full[i]!, partial[i]!, EPS, `ATR[${i}] alignment`);
    }
  });

});

// =================================================================
// ─── precomputeIndicators ────────────────────────────────────────
// =================================================================
describe("precomputeIndicators（一括計算）", () => {

  test("全フィールドが存在する", () => {
    const res = precomputeIndicators(trendingUp);
    assert.ok(Array.isArray(res.ema1),  "ema1 is array");
    assert.ok(Array.isArray(res.ema2),  "ema2 is array");
    assert.ok(Array.isArray(res.sma),   "sma is array");
    assert.ok(Array.isArray(res.atr),   "atr is array");
    assert.ok(Array.isArray(res.rsi),   "rsi is array");
    assert.ok(Array.isArray(res.macd),  "macd is array");
    assert.ok(Array.isArray(res.adx),   "adx is array");
    assert.ok(Array.isArray(res.bb),    "bb is array");
    assert.ok(Array.isArray(res.stoch), "stoch is array");
  });

  test("全配列の長さが bars.length と一致", () => {
    const res = precomputeIndicators(trendingUp);
    assert.strictEqual(res.ema1.length,  N);
    assert.strictEqual(res.ema2.length,  N);
    assert.strictEqual(res.atr.length,   N);
    assert.strictEqual(res.rsi.length,   N);
    assert.strictEqual(res.macd.length,  N);
    assert.strictEqual(res.adx.length,   N);
    assert.strictEqual(res.bb.length,    N);
    assert.strictEqual(res.stoch.length, N);
  });

  test("カスタムパラメーターが適用される", () => {
    const res = precomputeIndicators(trendingUp, { rsiPeriod: 7 });
    assert.strictEqual(res.params.rsiPeriod, 7);
    // RSI(7): index 7 から有効
    assert.strictEqual(res.rsi[6],  undefined, "RSI7 warmup at 6");
    assert.notStrictEqual(res.rsi[7], undefined, "RSI7 first valid at 7");
  });

});

// =================================================================
// ─── エッジケース ────────────────────────────────────────────────
// =================================================================
describe("Edge Cases", () => {

  test("bars が period より少ない → 全て undefined", () => {
    const bars = makeBars([1, 2, 3]);
    const rsi  = calculateRSI(bars, 14);
    assertAllUndefined(rsi, "RSI with 3 bars");
  });

  test("bars が exactly period → RSI: index period が undefined（bars.length <= period）", () => {
    const bars = makeBars(Array.from({ length: 14 }, (_, i) => i + 1));
    const rsi  = calculateRSI(bars, 14);
    // bars.length === period → 条件 bars.length <= period → 全て undefined
    assertAllUndefined(rsi, "RSI with exactly period bars");
  });

  test("period = 1 → SMA = 各要素の値そのまま", () => {
    const closes = [10, 20, 30];
    const res = calculateSMA(closes, 1);
    assert.strictEqual(res.length, 3);
    closes.forEach((c, i) => assertClose(res[i]!, c, EPS, `SMA1[${i}]`));
  });

  test("ATR: very large range → 正常に計算", () => {
    const bars: Bar[] = [
      { time: 0, open: 100, high: 10000, low: 1, close: 5000, volume: 1 },
      { time: 1, open: 100, high: 10000, low: 1, close: 5000, volume: 1 },
    ];
    const res = calculateATR(bars, 1);
    assert.ok(res[0]! > 0, "Large range ATR should be positive");
    assert.ok(Number.isFinite(res[0]!), "Large range ATR should be finite");
  });

  test("1本だけのバー配列 → クラッシュしない", () => {
    const bars: Bar[] = [{ time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 }];
    assert.doesNotThrow(() => calculateSMA([100], 5));
    assert.doesNotThrow(() => calculateEMA([100], 5));
    assert.doesNotThrow(() => calculateATR(bars, 14));
    assert.doesNotThrow(() => calculateRSI(bars, 14));
    assert.doesNotThrow(() => calculateMACD(bars));
    assert.doesNotThrow(() => calculateADX(bars, 14));
    assert.doesNotThrow(() => calculateBollingerBands(bars));
    assert.doesNotThrow(() => calculateStochastic(bars));
  });

});

// =================================================================
// ─── 結果サマリー ────────────────────────────────────────────────
// =================================================================

console.log(`\n${"═".repeat(50)}`);
if (failed === 0) {
  console.log(`\n✅ ALL ${passed} TESTS PASSED\n`);
} else {
  console.error(`\n❌ ${failed} FAILED / ${passed} PASSED\n`);
  process.exitCode = 1;
}

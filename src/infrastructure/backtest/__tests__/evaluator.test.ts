/**
 * Unit Tests — Strategy Evaluator (Phase 2-B)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/evaluator.test.ts
 *
 * テスト内容:
 *   Operators: RSI/EMA/SMA/MACD/ADX/BB/Stoch 全 operator
 *   Logic:     AND / OR
 *   Filters:   Trend / Session / Spread / min_adx
 *   Edge cases: Warmup不足 / 空bars / 不十分データ
 *   Look-ahead Bias: H1 確定バー判定
 *   Future Data Injection: 未来バーの値変更が結果に影響しないこと
 */

import assert from "node:assert/strict";
import type { Bar }                   from "@/infrastructure/analysis/types";
import type { MACDResult, ADXResult, BollingerResult } from "../types";
import type { PrecomputedIndicators } from "../indicators";
import type { StrategySpec }          from "@/lib/strategySchema";
import { evaluateStrategy, type EvaluationContext } from "../evaluator";
import { TF_MS } from "../timeframe";

// =================================================================
// ─── Test runner ────────────────────────────────────────────────
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

// =================================================================
// ─── Helpers ────────────────────────────────────────────────────
// =================================================================

const DEFAULT_PARAMS = {
  ema1Period: 21, ema2Period: 200, smaPeriod: 50, atrPeriod: 14,
  rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
  adxPeriod: 14, bbPeriod: 20, bbDeviation: 2.0, stochPeriod: 14,
};

function makeBar(time: number, close: number, open?: number, high?: number, low?: number): Bar {
  const o = open  ?? close;
  const h = high  ?? close * 1.001;
  const l = low   ?? close * 0.999;
  return { time, open: o, high: h, low: l, close, volume: 100 };
}

/** n 本の bars を生成。time は startTime から tfMs 間隔 */
function makeBars(closes: number[], startTime: number, tfMs: number): Bar[] {
  return closes.map((c, i) => makeBar(startTime + i * tfMs, c));
}

/** PrecomputedIndicators のモック作成 */
function makeInds(n: number, opts: {
  rsi?:   (number | undefined)[];
  ema1?:  (number | undefined)[];
  ema2?:  (number | undefined)[];
  sma?:   (number | undefined)[];
  macd?:  MACDResult[];
  adx?:   ADXResult[];
  bb?:    BollingerResult[];
  stoch?: (number | undefined)[];
  params?: Partial<typeof DEFAULT_PARAMS>;
} = {}): PrecomputedIndicators {
  const undef = () => Array<number | undefined>(n).fill(undefined);
  const noMacd = (): MACDResult[] =>
    Array.from({ length: n }, () => ({ macd: undefined, signal: undefined, histogram: undefined }));
  const noAdx = (): ADXResult[] =>
    Array.from({ length: n }, () => ({ adx: undefined, diPlus: undefined, diMinus: undefined }));
  const noBB = (): BollingerResult[] =>
    Array.from({ length: n }, () => ({ upper: undefined, middle: undefined, lower: undefined, width: undefined }));

  return {
    ema1:   opts.ema1  ?? undef(),
    ema2:   opts.ema2  ?? undef(),
    sma:    opts.sma   ?? undef(),
    atr:    undef(),
    rsi:    opts.rsi   ?? undef(),
    macd:   opts.macd  ?? noMacd(),
    adx:    opts.adx   ?? noAdx(),
    bb:     opts.bb    ?? noBB(),
    stoch:  opts.stoch ?? undef(),
    params: { ...DEFAULT_PARAMS, ...opts.params },
  };
}

/** 最小限の valid StrategySpec を生成 */
function makeSpec(overrides: {
  timeframes?: string[];
  logic?: "AND" | "OR";
  conditions?: StrategySpec["entry_conditions"]["conditions"];
  filters?: StrategySpec["filters"];
}): StrategySpec {
  return {
    name:           "Test Strategy",
    strategy_type:  "DAY_TRADE",
    symbols:        ["EURUSD"],
    timeframes:     overrides.timeframes ?? ["M5"],
    entry_conditions: {
      logic:      overrides.logic ?? "AND",
      conditions: overrides.conditions ?? [],
    },
    risk: { risk_per_trade: 1.0 },
    filters: overrides.filters,
  } as StrategySpec;
}

/** 評価コンテキストのショートカット生成 */
function makeCtx(
  spec:      StrategySpec,
  evalTime:  number,
  tf:        string,
  bars:      Bar[],
  inds:      PrecomputedIndicators,
  opts?: {
    spreadPips?:  number;
    extraBars?:   Record<string, Bar[]>;
    extraInds?:   Record<string, PrecomputedIndicators>;
  },
): EvaluationContext {
  return {
    spec,
    evaluationTime:        evalTime,
    barsByTimeframe:       { [tf]: bars, ...(opts?.extraBars ?? {}) },
    indicatorsByTimeframe: { [tf]: inds, ...(opts?.extraInds ?? {}) },
    spreadPips:            opts?.spreadPips,
  };
}

// =================================================================
// ─── 共通テスト設定 ──────────────────────────────────────────────
// =================================================================

// M5 バー 10 本、最後のバー (index 9) が evalTime で確定済み
const M5_MS    = TF_MS["M5"];      // 300_000
const T0       = 1_000_000_000;    // 任意の基準時刻 (ms)
const EVAL_T   = T0 + 10 * M5_MS; // bar[9].time + M5_MS = EVAL_T (ちょうど確定)

// closes[9] = 1.10 (評価バー), closes[8] = 1.09 (1本前)
const CLOSES_10 = [1.05, 1.06, 1.07, 1.08, 1.06, 1.07, 1.08, 1.09, 1.09, 1.10];
const BARS_M5   = makeBars(CLOSES_10, T0, M5_MS);

// =================================================================
// ─── RSI Tests ───────────────────────────────────────────────────
// =================================================================

describe("RSI Operators", () => {

  test("01. RSI BELOW 30 → BUY", () => {
    const rsi  = [...Array(9).fill(35), 28]; // idx=9: 28
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({ conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }
    ]});
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("02. RSI ABOVE 70 → SELL", () => {
    const rsi  = [...Array(9).fill(65), 72];
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({ conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "ABOVE", threshold: 70 }
    ]});
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SELL");
  });

  test("03. RSI CROSS_UP 30 (prev=28, curr=31) → BUY", () => {
    const rsi  = [...Array(8).fill(35), 28, 31]; // prev=28, curr=31
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({ conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "CROSS_UP", threshold: 30 }
    ]});
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("04. RSI CROSS_DOWN 70 (prev=72, curr=68) → SELL", () => {
    const rsi  = [...Array(8).fill(65), 72, 68]; // prev=72, curr=68
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({ conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "CROSS_DOWN", threshold: 70 }
    ]});
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SELL");
  });

  test("05. RSI REVERSAL from below 30 (prev=28, curr=30) → BUY", () => {
    // "RSI reverses upward from below or at 30"
    // REVERSAL: prev <= threshold AND curr > prev
    const rsi  = [...Array(8).fill(35), 28, 30]; // prev=28 <= 30, curr=30 > 28
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({ conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "REVERSAL", threshold: 30 }
    ]});
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("05b. RSI REVERSAL — curr not rising (prev=28, curr=28) → SKIP", () => {
    const rsi  = [...Array(8).fill(35), 28, 28]; // curr not > prev
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({ conditions: [
      { indicator: "RSI", timeframe: "M5", period: 14, operator: "REVERSAL", threshold: 30 }
    ]});
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SKIP");
  });

  test("05c. RSI REVERSAL from below 70 (SELL direction, prev=72, curr=70) → SELL", () => {
    const rsi  = [...Array(8).fill(65), 72, 70]; // prev=72 >= 70, curr=70 < 72
    const inds = makeInds(10, { rsi });
    // direction=SELL: REVERSAL uses threshold default 70
    const spec = makeSpec({
      conditions: [
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "REVERSAL", threshold: 70 }
      ],
      filters: { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BEARISH" } },
    });
    // EMA below close → trend filter passes for BEARISH (close < EMA)
    const ema1 = [...Array(10).fill(1.20)]; // close=1.10 < ema=1.20 → BEARISH trend passes
    const inds2 = makeInds(10, { rsi, ema1 });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds2));
    assert.equal(result, "SELL");
  });

});

// =================================================================
// ─── EMA Tests ───────────────────────────────────────────────────
// =================================================================

describe("EMA Operators", () => {

  test("06. EMA PRICE_ABOVE (close=1.10, ema21=1.08) → BUY", () => {
    const ema1 = [...Array(10).fill(1.08)]; // close=1.10 > ema=1.08
    const inds = makeInds(10, { ema1 });
    const spec = makeSpec({
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("07. EMA PRICE_BELOW (close=1.10, ema21=1.15) → SELL", () => {
    const ema1 = [...Array(10).fill(1.15)]; // close=1.10 < ema=1.15
    const inds = makeInds(10, { ema1 });
    const spec = makeSpec({
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW" }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SELL");
  });

  test("08. EMA BULLISH_CROSS (EMA21 crosses above EMA200) → BUY", () => {
    // idx=8: ema1=0.99 < ema2=1.00 → idx=9: ema1=1.01 >= ema2=1.00
    const ema1 = [...Array(8).fill(0.99), 0.99, 1.01];
    const ema2 = [...Array(10).fill(1.00)];
    const inds = makeInds(10, { ema1, ema2 });
    const spec = makeSpec({
      conditions: [{ indicator: "EMA", timeframe: "M5", operator: "BULLISH_CROSS" }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("09. EMA BEARISH_CROSS (EMA21 crosses below EMA200) → SELL", () => {
    // idx=8: ema1=1.01 > ema2=1.00 → idx=9: ema1=0.99 <= ema2=1.00
    const ema1 = [...Array(8).fill(1.01), 1.01, 0.99];
    const ema2 = [...Array(10).fill(1.00)];
    const inds = makeInds(10, { ema1, ema2 });
    const spec = makeSpec({
      conditions: [{ indicator: "EMA", timeframe: "M5", operator: "BEARISH_CROSS" }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SELL");
  });

});

// =================================================================
// ─── MACD Tests ─────────────────────────────────────────────────
// =================================================================

describe("MACD Operators", () => {

  function makeMACDInds(n: number, macdVal: number, signalVal: number, histVal: number): PrecomputedIndicators {
    const macd: MACDResult[] = Array.from({ length: n }, (_, i) =>
      i === n - 1
        ? { macd: macdVal, signal: signalVal, histogram: histVal }
        : { macd: undefined, signal: undefined, histogram: undefined }
    );
    return makeInds(n, { macd });
  }

  test("10. MACD ABOVE_SIGNAL → BUY", () => {
    const inds = makeMACDInds(10, 0.002, 0.001, 0.001);
    const spec = makeSpec({
      conditions: [{ indicator: "MACD", timeframe: "M5", operator: "ABOVE_SIGNAL" }],
      filters:    { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });
    const ema1 = Array(10).fill(1.08); // close=1.10 > ema=1.08 → BULLISH trend
    const inds2 = { ...inds, ema1 };
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds2));
    assert.equal(result, "BUY");
  });

  test("11. MACD BELOW_SIGNAL → SELL", () => {
    const inds = makeMACDInds(10, 0.001, 0.002, -0.001);
    const spec = makeSpec({
      conditions: [{ indicator: "MACD", timeframe: "M5", operator: "BELOW_SIGNAL" }],
      filters:    { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BEARISH" } },
    });
    const ema1 = Array(10).fill(1.15); // close=1.10 < ema=1.15 → BEARISH trend
    const inds2 = { ...inds, ema1 };
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds2));
    assert.equal(result, "SELL");
  });

  test("12. MACD HISTOGRAM_POSITIVE → BUY", () => {
    const inds = makeMACDInds(10, 0.002, 0.001, 0.001);
    const spec = makeSpec({
      conditions: [{ indicator: "MACD", timeframe: "M5", operator: "HISTOGRAM_POSITIVE" }],
      filters:    { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });
    const ema1 = Array(10).fill(1.08);
    const inds2 = { ...inds, ema1 };
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds2));
    assert.equal(result, "BUY");
  });

  test("13. MACD HISTOGRAM_NEGATIVE → SELL", () => {
    const inds = makeMACDInds(10, 0.001, 0.002, -0.001);
    const spec = makeSpec({
      conditions: [{ indicator: "MACD", timeframe: "M5", operator: "HISTOGRAM_NEGATIVE" }],
      filters:    { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BEARISH" } },
    });
    const ema1 = Array(10).fill(1.15);
    const inds2 = { ...inds, ema1 };
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds2));
    assert.equal(result, "SELL");
  });

});

// =================================================================
// ─── ADX Tests ──────────────────────────────────────────────────
// =================================================================

describe("ADX Operators", () => {

  function makeADXInds(n: number, adxVal: number): PrecomputedIndicators {
    const adx: ADXResult[] = Array.from({ length: n }, (_, i) =>
      i === n - 1
        ? { adx: adxVal, diPlus: 20, diMinus: 10 }
        : { adx: undefined, diPlus: undefined, diMinus: undefined }
    );
    const ema1 = Array(n).fill(1.08);
    return makeInds(n, { adx, ema1 });
  }

  test("14. ADX ABOVE 25 (adx=30) → BUY with BULLISH trend filter", () => {
    const inds = makeADXInds(10, 30);
    const spec = makeSpec({
      conditions: [{ indicator: "ADX", timeframe: "M5", period: 14, operator: "ABOVE", threshold: 25 }],
      filters:    { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("15. ADX BELOW 25 (adx=20) → BUY with BULLISH trend filter", () => {
    const inds = makeADXInds(10, 20);
    const spec = makeSpec({
      conditions: [{ indicator: "ADX", timeframe: "M5", period: 14, operator: "BELOW", threshold: 25 }],
      filters:    { trend_filter: { timeframe: "M5", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

});

// =================================================================
// ─── Bollinger Bands Tests ────────────────────────────────────────
// =================================================================

describe("Bollinger Bands Operators", () => {

  function makeBBInds(n: number, upper: number, lower: number): PrecomputedIndicators {
    const bb: BollingerResult[] = Array.from({ length: n }, (_, i) =>
      i === n - 1
        ? { upper, middle: (upper + lower) / 2, lower, width: upper - lower }
        : { upper: undefined, middle: undefined, lower: undefined, width: undefined }
    );
    return makeInds(n, { bb });
  }

  test("16. BB PRICE_ABOVE upper (close=1.10, upper=1.09) → SELL (overbought)", () => {
    const inds = makeBBInds(10, 1.09, 1.05); // close=1.10 > upper=1.09
    const spec = makeSpec({
      conditions: [{ indicator: "BOLLINGER_BANDS", timeframe: "M5", operator: "PRICE_ABOVE" }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SELL");
  });

  test("17. BB PRICE_BELOW lower (close=1.10, lower=1.12) → BUY (oversold)", () => {
    const inds = makeBBInds(10, 1.18, 1.12); // close=1.10 < lower=1.12
    const spec = makeSpec({
      conditions: [{ indicator: "BOLLINGER_BANDS", timeframe: "M5", operator: "PRICE_BELOW" }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

});

// =================================================================
// ─── Stochastic Tests ────────────────────────────────────────────
// =================================================================

describe("Stochastic Operators", () => {

  test("18. STOCHASTIC CROSS_UP 20 (prev=18, curr=21) → BUY", () => {
    const stoch = [...Array(8).fill(30), 18, 21]; // prev=18 < 20, curr=21 >= 20
    const inds  = makeInds(10, { stoch });
    const spec  = makeSpec({
      conditions: [{ indicator: "STOCHASTIC", timeframe: "M5", period: 14, operator: "CROSS_UP", threshold: 20 }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("19. STOCHASTIC CROSS_DOWN 80 (prev=82, curr=78) → SELL", () => {
    const stoch = [...Array(8).fill(70), 82, 78]; // prev=82 > 80, curr=78 <= 80
    const inds  = makeInds(10, { stoch });
    const spec  = makeSpec({
      conditions: [{ indicator: "STOCHASTIC", timeframe: "M5", period: 14, operator: "CROSS_DOWN", threshold: 80 }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SELL");
  });

});

// =================================================================
// ─── Logic Tests ─────────────────────────────────────────────────
// =================================================================

describe("AND / OR Logic", () => {

  test("20. AND: both conditions true → BUY", () => {
    const rsi  = [...Array(9).fill(35), 28]; // RSI BELOW 30
    const ema1 = [...Array(10).fill(1.08)];  // PRICE_ABOVE 1.08 (close=1.10)
    const inds = makeInds(10, { rsi, ema1 });
    const spec = makeSpec({
      logic: "AND",
      conditions: [
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      ],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("20b. AND: one condition false → SKIP", () => {
    const rsi  = [...Array(9).fill(35), 45]; // RSI=45, NOT below 30
    const ema1 = [...Array(10).fill(1.08)];  // PRICE_ABOVE OK
    const inds = makeInds(10, { rsi, ema1 });
    const spec = makeSpec({
      logic: "AND",
      conditions: [
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      ],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SKIP");
  });

  test("21. OR: one of two conditions true → BUY", () => {
    const rsi  = [...Array(9).fill(35), 28]; // RSI BELOW 30 → true
    const ema1 = [...Array(10).fill(1.15)];  // PRICE_ABOVE (close=1.10 < 1.15) → false
    const inds = makeInds(10, { rsi, ema1 });
    const spec = makeSpec({
      logic: "OR",
      conditions: [
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      ],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "BUY");
  });

  test("21b. OR: both conditions false → SKIP", () => {
    const rsi  = [...Array(9).fill(35), 45]; // RSI NOT below 30
    const ema1 = [...Array(10).fill(1.15)];  // PRICE_ABOVE (close=1.10 < 1.15) → false
    const inds = makeInds(10, { rsi, ema1 });
    const spec = makeSpec({
      logic: "OR",
      conditions: [
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" },
      ],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SKIP");
  });

});

// =================================================================
// ─── Trend Filter Tests ──────────────────────────────────────────
// =================================================================

describe("Trend Filters", () => {

  test("22. H1 trend filter BULLISH (close > EMA21 on H1) → BUY", () => {
    const H1_MS = TF_MS["H1"]; // 3_600_000
    // H1 バー 3 本: evalTime で bar[2] が確定済み
    //   bar[2].time + H1_MS <= EVAL_T
    //   → bar[2].time = EVAL_T - H1_MS
    const h1Start   = EVAL_T - 3 * H1_MS;
    const h1Bars    = makeBars([1.07, 1.09, 1.10], h1Start, H1_MS);
    const h1Ema1    = [1.06, 1.08, 1.09]; // close=1.10 > ema=1.09 at idx=2 → BULLISH
    const h1Inds    = makeInds(3, { ema1: h1Ema1 });

    // M5 条件: RSI BELOW 30
    const rsi  = [...Array(9).fill(35), 28];
    const m5Inds = makeInds(10, { rsi });

    const spec = makeSpec({
      timeframes: ["M5"],
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });

    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bars },
      indicatorsByTimeframe: { M5: m5Inds,  H1: h1Inds },
    });
    assert.equal(result, "BUY");
  });

  test("23. H4 trend filter BEARISH (close < EMA21 on H4) → SELL", () => {
    const H4_MS  = TF_MS["H4"]; // 14_400_000
    const h4Start = EVAL_T - 3 * H4_MS;
    const h4Bars  = makeBars([1.12, 1.11, 1.10], h4Start, H4_MS);
    const h4Ema1  = [1.13, 1.12, 1.12]; // close=1.10 < ema=1.12 at idx=2 → BEARISH
    const h4Inds  = makeInds(3, { ema1: h4Ema1 });

    const rsi   = [...Array(9).fill(65), 72]; // RSI ABOVE 70 → SELL bias
    const m5Inds = makeInds(10, { rsi });

    const spec = makeSpec({
      timeframes: ["M5"],
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "ABOVE", threshold: 70 }],
      filters:    { trend_filter: { timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" } },
    });

    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H4: h4Bars },
      indicatorsByTimeframe: { M5: m5Inds,  H4: h4Inds },
    });
    assert.equal(result, "SELL");
  });

  test("22b. H1 trend filter BULLISH fails (close < EMA21) → SKIP", () => {
    const H1_MS  = TF_MS["H1"];
    const h1Start = EVAL_T - 3 * H1_MS;
    const h1Bars  = makeBars([1.07, 1.09, 1.10], h1Start, H1_MS);
    const h1Ema1  = [1.15, 1.15, 1.15]; // close=1.10 < ema=1.15 → BULLISH filter fails
    const h1Inds  = makeInds(3, { ema1: h1Ema1 });

    const rsi    = [...Array(9).fill(35), 28];
    const m5Inds = makeInds(10, { rsi });

    const spec = makeSpec({
      timeframes: ["M5"],
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });

    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bars },
      indicatorsByTimeframe: { M5: m5Inds,  H1: h1Inds },
    });
    assert.equal(result, "SKIP");
  });

});

// =================================================================
// ─── Filter Tests ────────────────────────────────────────────────
// =================================================================

describe("Session / Spread Filters", () => {

  test("24. Session filter: LONDON only, evalTime=03:00 UTC → SKIP", () => {
    // 03:00 UTC = outside LONDON (07-16 UTC)
    const utc3am = new Date("2024-01-15T03:00:00Z").getTime();
    const bars   = makeBars(CLOSES_10, utc3am - 10 * M5_MS, M5_MS);
    const evalT  = utc3am;
    const rsi    = [...Array(9).fill(35), 28];
    const inds   = makeInds(10, { rsi });
    const spec   = makeSpec({
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { sessions: ["LONDON"] },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        evalT,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP");
  });

  test("24b. Session filter: LONDON, evalTime=10:00 UTC → BUY (in session)", () => {
    // 10:00 UTC = LONDON active (07-16 UTC)
    const utc10am = new Date("2024-01-15T10:00:00Z").getTime();
    const bars    = makeBars(CLOSES_10, utc10am - 10 * M5_MS, M5_MS);
    const evalT   = utc10am;
    const rsi     = [...Array(9).fill(35), 28];
    const inds    = makeInds(10, { rsi });
    const spec    = makeSpec({
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { sessions: ["LONDON"] },
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        evalT,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "BUY");
  });

  test("25. Spread filter: max=2.0, spread=3.0 → SKIP", () => {
    const rsi  = [...Array(9).fill(35), 28];
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { max_spread_pips: 2.0 },
    });
    const result = evaluateStrategy(
      makeCtx(spec, EVAL_T, "M5", BARS_M5, inds, { spreadPips: 3.0 })
    );
    assert.equal(result, "SKIP");
  });

  test("25b. Spread filter: max=2.0, spread=1.5 → BUY (within limit)", () => {
    const rsi  = [...Array(9).fill(35), 28];
    const inds = makeInds(10, { rsi });
    const spec = makeSpec({
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { max_spread_pips: 2.0 },
    });
    const result = evaluateStrategy(
      makeCtx(spec, EVAL_T, "M5", BARS_M5, inds, { spreadPips: 1.5 })
    );
    assert.equal(result, "BUY");
  });

});

// =================================================================
// ─── Edge Cases ──────────────────────────────────────────────────
// =================================================================

describe("Edge Cases", () => {

  test("26. Warmup不足: bars=5本 RSI(14) → idx=4が確定, rsi[4]=undefined → SKIP", () => {
    // 5 本しかなく、RSI(14) の warm-up は 14 本必要 → idx=4 の rsi=undefined
    const bars5 = makeBars([1.10, 1.11, 1.09, 1.10, 1.08], T0, M5_MS);
    const evalT5 = T0 + 5 * M5_MS;
    const rsi    = new Array(5).fill(undefined); // warm-up 不足
    const inds   = makeInds(5, { rsi });
    const spec   = makeSpec({
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        evalT5,
      barsByTimeframe:       { M5: bars5 },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP");
  });

  test("27. Indicator unavailable (EMA値がundefined) → SKIP", () => {
    const ema1 = new Array(10).fill(undefined); // EMA 値なし
    const inds = makeInds(10, { ema1 });
    const spec = makeSpec({
      conditions: [{ indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE" }],
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SKIP");
  });

  test("28. Empty bars → SKIP", () => {
    const bars = [] as Bar[];
    const inds = makeInds(0);
    const spec = makeSpec({
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }],
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        EVAL_T,
      barsByTimeframe:       { M5: bars },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP");
  });

  test("29. Insufficient historical data: 1本のみ, CROSS_UP (idx<1) → SKIP", () => {
    const bars1 = [makeBar(T0, 1.10)];
    const evalT1 = T0 + M5_MS;
    const rsi    = [28]; // idx=0 が確定
    const inds   = makeInds(1, { rsi });
    const spec   = makeSpec({
      conditions: [{ indicator: "RSI", timeframe: "M5", period: 14, operator: "CROSS_UP", threshold: 30 }],
    });
    const result = evaluateStrategy({
      spec,
      evaluationTime:        evalT1,
      barsByTimeframe:       { M5: bars1 },
      indicatorsByTimeframe: { M5: inds },
    });
    assert.equal(result, "SKIP"); // idx=0 → idx<1 → CROSS_UP returns false
  });

  test("30. BUY/SELL conflict (equal buy+sell bias, no trend_filter) → SKIP", () => {
    // RSI BELOW 30 (buy bias) + EMA PRICE_BELOW (sell bias) = tied → AMBIGUOUS
    const rsi  = [...Array(9).fill(35), 28]; // RSI=28 < 30 → true
    const ema1 = Array(10).fill(1.15);        // close=1.10 < ema=1.15 → true
    const inds = makeInds(10, { rsi, ema1 });
    const spec = makeSpec({
      logic: "AND",
      conditions: [
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW" },
      ],
      // no trend_filter → direction must be inferred
    });
    const result = evaluateStrategy(makeCtx(spec, EVAL_T, "M5", BARS_M5, inds));
    assert.equal(result, "SKIP"); // AMBIGUOUS direction → SKIP
  });

});

// =================================================================
// ─── Look-ahead Bias Tests ───────────────────────────────────────
// =================================================================

describe("Look-ahead Bias Prevention", () => {

  // Setup:
  //   H1 bars: 09:00, 10:00, 11:00 (UTC)
  //   evaluationTime: 10:35 UTC
  //
  // H1 10:00 bar closes at 11:00 → NOT confirmed at 10:35
  // H1 09:00 bar closes at 10:00 → confirmed at 10:35

  const H1_MS = TF_MS["H1"]; // 3_600_000
  const T_09  = new Date("2024-01-15T09:00:00Z").getTime();
  const T_10  = T_09 + H1_MS;
  const T_11  = T_10 + H1_MS;
  const T_35  = T_10 + 35 * 60 * 1000; // 10:35 UTC

  // H1 bars
  //   bar[0]: time=T_09, close=1.10 → confirmed at T_10 (10:00)
  //   bar[1]: time=T_10, close=1.15 → confirmed at T_11 (11:00) — NOT confirmed at 10:35
  //   bar[2]: time=T_11, close=1.20 → confirmed at T_12 — NOT confirmed
  const h1Bars = [
    makeBar(T_09, 1.10),
    makeBar(T_10, 1.15),
    makeBar(T_11, 1.20),
  ];

  // RSI: idx=0 → 28 (oversold → BUY signal)
  //       idx=1 → 60 (normal → no signal)
  //       idx=2 → 80 (future bar)
  const h1Rsi  = [28, 60, 80];
  // EMA21: idx=0 → 1.08 (close=1.10 > ema=1.08 → BULLISH)
  //         idx=1 → 1.14 (close=1.15 > 1.14 → also BULLISH, but shouldn't be used)
  const h1Ema1 = [1.08, 1.14, 1.19];
  const h1Inds = makeInds(3, { rsi: h1Rsi, ema1: h1Ema1 });

  test("Look-ahead: M5 10:35 uses H1 09:00 bar (not 10:00) → correct BUY", () => {
    const spec = makeSpec({
      timeframes: ["M5"],
      conditions: [{ indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });

    // M5 バーはダミー（M5条件なし）
    const m5Inds = makeInds(10);

    const result = evaluateStrategy({
      spec,
      evaluationTime:        T_35,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bars },
      indicatorsByTimeframe: { M5: m5Inds,  H1: h1Inds },
    });

    // H1 09:00 bar (idx=0): rsi=28 < 30 → true, ema=1.08 < close=1.10 → BULLISH passes
    assert.equal(result, "BUY", "H1 09:00 bar が使われるべき");
  });

  test("Look-ahead: evalTime=11:00 → H1 10:00 bar が利用可能になる", () => {
    const T_11_00 = T_11; // 11:00 UTC → H1 10:00 が確定 (T_10 + H1_MS = T_11 <= T_11)

    // rsi[1] = 60 → NOT below 30 → condition fails
    const spec = makeSpec({
      timeframes: ["M5"],
      conditions: [{ indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });

    const m5Inds = makeInds(10);
    const result = evaluateStrategy({
      spec,
      evaluationTime:        T_11_00,
      barsByTimeframe:       { M5: BARS_M5, H1: h1Bars },
      indicatorsByTimeframe: { M5: m5Inds,  H1: h1Inds },
    });

    // H1 10:00 bar (idx=1): rsi=60 NOT below 30 → SKIP
    assert.equal(result, "SKIP", "evalTime=11:00 では H1 10:00 が使われ RSI=60 で SKIP");
  });

});

// =================================================================
// ─── Future Data Injection Test ─────────────────────────────────
// =================================================================

describe("Future Data Injection", () => {

  const H1_MS = TF_MS["H1"];
  const T_09  = new Date("2024-01-15T09:00:00Z").getTime();
  const T_10  = T_09 + H1_MS;
  const T_11  = T_10 + H1_MS;
  const T_35  = T_10 + 35 * 60 * 1000; // 10:35 UTC

  test("未来バー(H1 10:00, 11:00)の値を100倍にしても 10:35 の評価結果が変わらない", () => {
    const spec = makeSpec({
      timeframes: ["M5"],
      conditions: [{ indicator: "RSI", timeframe: "H1", period: 14, operator: "BELOW", threshold: 30 }],
      filters:    { trend_filter: { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" } },
    });

    const m5Inds = makeInds(10);

    // 通常バー
    const normalBars = [makeBar(T_09, 1.10), makeBar(T_10, 1.15), makeBar(T_11, 1.20)];
    const normalRsi  = [28, 60, 80];
    const normalEma1 = [1.08, 1.14, 1.19];
    const normalInds = makeInds(3, { rsi: normalRsi, ema1: normalEma1 });

    const normalResult = evaluateStrategy({
      spec,
      evaluationTime:        T_35,
      barsByTimeframe:       { M5: BARS_M5, H1: normalBars },
      indicatorsByTimeframe: { M5: m5Inds,  H1: normalInds },
    });

    // 未来バーの値を100倍に変更 (idx=1,2 は未来 → 使用されるべきでない)
    const injectedBars = [
      makeBar(T_09, 1.10),
      makeBar(T_10, 115.0),  // close を 100 倍
      makeBar(T_11, 120.0),
    ];
    const injectedRsi  = [28, 6000, 8000]; // 未来 RSI を 100 倍
    const injectedEma1 = [1.08, 1140.0, 1190.0]; // 未来 EMA を 100 倍
    const injectedInds = makeInds(3, { rsi: injectedRsi, ema1: injectedEma1 });

    const injectedResult = evaluateStrategy({
      spec,
      evaluationTime:        T_35,
      barsByTimeframe:       { M5: BARS_M5, H1: injectedBars },
      indicatorsByTimeframe: { M5: m5Inds,  H1: injectedInds },
    });

    assert.equal(injectedResult, normalResult,
      `未来データ変更前: ${normalResult}, 変更後: ${injectedResult} — 一致すべき`);
    assert.equal(injectedResult, "BUY", "確定済み H1 09:00 を使用して BUY");
  });

});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) {
  console.log("🎉 All tests PASSED");
} else {
  console.log("💥 Some tests FAILED");
  process.exit(1);
}

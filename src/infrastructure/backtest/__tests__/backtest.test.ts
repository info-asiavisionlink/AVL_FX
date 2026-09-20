/**
 * Unit Tests — BacktestEngine (Phase 2-C)
 *
 * 実行方法:
 *   npx tsx src/infrastructure/backtest/__tests__/backtest.test.ts
 *
 * 設計: StrategyEvaluator を _evaluatorOverride でモックし、
 *       BacktestEngine の動作を独立してテストする。
 */

import assert from "node:assert/strict";
import type { Bar }          from "@/infrastructure/analysis/types";
import type { StrategySpec } from "@/lib/strategySchema";
import type { SignalResult } from "../evaluator";
import { runBacktest, BacktestError, type BacktestInput } from "../BacktestEngine";
import { getSymbolConfig, priceToPips }                  from "../spreadConfig";
import { checkExitOnBar }                                from "../PositionManager";

// =================================================================
// ─── Test runner ────────────────────────────────────────────────
// =================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}\n     ${msg}`);
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

function makeBar(time: number, open: number, high: number, low: number, close: number): Bar {
  return { time, open, high, low, close, volume: 100 };
}

/** 単純な bars 列を生成 (すべて同一 OHLC) */
function flatBars(n: number, startTime: number, tfMs: number, price: number): Bar[] {
  return Array.from({ length: n }, (_, i) =>
    makeBar(startTime + i * tfMs, price, price * 1.001, price * 0.999, price)
  );
}

const M5_MS  = 300_000;
const T0     = 1_000_000_000;  // 基準時刻 (ms)

/** 最小限の StrategySpec モック */
function makeSpec(overrides?: Partial<StrategySpec>): StrategySpec {
  return {
    name:           "Test",
    strategy_type:  "DAY_TRADE",
    symbols:        ["EURUSD"],
    timeframes:     ["M5"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "RSI", timeframe: "M5", period: 14, operator: "BELOW", threshold: 30 }
      ],
    },
    risk: { risk_per_trade: 1.0 },
    exit_conditions: {
      stop_loss:   { method: "FIXED_PIPS", pips: 20 },
      take_profit: { method: "FIXED_PIPS", pips: 40 },
    },
    ...overrides,
  } as StrategySpec;
}

/** BUY を 1 回だけ返す evaluator mock */
function oneBuyAt(signalBarInLoop: number): (ctx: unknown) => SignalResult {
  let calls = 0;
  return () => {
    calls++;
    return calls === signalBarInLoop + 1 ? "BUY" : "SKIP";
  };
}

/** SELL を 1 回だけ返す */
function oneSellAt(signalBarInLoop: number): (ctx: unknown) => SignalResult {
  let calls = 0;
  return () => {
    calls++;
    return calls === signalBarInLoop + 1 ? "SELL" : "SKIP";
  };
}

/** 常に SKIP を返す evaluator */
const alwaysSkip = () => "SKIP" as SignalResult;

/** runBacktest の簡易ラッパー */
function run(
  signal: (ctx: unknown) => SignalResult,
  bars: Bar[],
  opts?: Partial<BacktestInput>
) {
  const input: BacktestInput = {
    spec:            makeSpec(opts?.spec as Partial<StrategySpec>),
    symbol:          opts?.symbol ?? "EURUSD",
    mainTimeframe:   "M5",
    barsByTimeframe: opts?.barsByTimeframe ?? { M5: bars },
    initialBalance:  opts?.initialBalance ?? 10_000,
    fixedLot:        opts?.fixedLot ?? 0.01,
    _evaluatorOverride: signal as BacktestInput["_evaluatorOverride"],
  };
  return runBacktest(input);
}

// =================================================================
// ─── Bar index constants ─────────────────────────────────────────
// warmup = max(RSI14=14, ATR14=13) = 14
// loop starts at i=SIGNAL_BAR=14 → entry at i=ENTRY_BAR=15
// =================================================================

const WARMUP     = 14;
const SIGNAL_BAR = WARMUP;      // i=14: evaluator first called
const ENTRY_BAR  = WARMUP + 1;  // i=15: entry at this bar's open
const GAP_BAR    = WARMUP + 2;  // i=16: first bar after entry

// =================================================================
// ─── 1. Entry tests ─────────────────────────────────────────────
// =================================================================

describe("Entry", () => {

  test("01. BUY Entry: signal at bar[SIGNAL_BAR], entry at bar[ENTRY_BAR].open", () => {
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    const result = run(oneBuyAt(0), bars);
    assert.equal(result.totalTrades, 1);
    const t = result.trades[0];
    assert.equal(t.direction, "BUY");
    const cfg = getSymbolConfig("EURUSD");
    const cost = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    assert.ok(Math.abs(t.entryPrice - (1.1000 + cost)) < 0.00001, `entry=${t.entryPrice}`);
    assert.equal(t.entryBarIdx, ENTRY_BAR);
  });

  test("02. SELL Entry: signal → entry at next bar open − spread", () => {
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    const result = run(oneSellAt(0), bars);
    assert.equal(result.totalTrades, 1);
    const t = result.trades[0];
    assert.equal(t.direction, "SELL");
    const cfg = getSymbolConfig("EURUSD");
    const cost = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    assert.ok(Math.abs(t.entryPrice - (1.1000 - cost)) < 0.00001, `entry=${t.entryPrice}`);
  });

  test("03. 次bar が存在しない場合 Entry しない", () => {
    // warmup=14, n=15 → loop runs bars[14] only → signal at bar[14] but bar[15] doesn't exist
    const bars = flatBars(15, T0, M5_MS, 1.1000);
    const result = run(() => "BUY", bars);
    // signal fires at bar[14] but no bar[15] → no entry
    assert.equal(result.totalTrades, 0);
  });

  test("24. BUY / SELL Direction confirmed", () => {
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    const buyResult  = run(oneBuyAt(0),  bars);
    const sellResult = run(oneSellAt(0), bars);
    assert.equal(buyResult.trades[0]?.direction,  "BUY");
    assert.equal(sellResult.trades[0]?.direction, "SELL");
  });

});

// =================================================================
// ─── 2. SL/TP tests ─────────────────────────────────────────────
// =================================================================

describe("SL / TP", () => {

  // BUY FIXED_PIPS 20/40:
  //   signal at SIGNAL_BAR=14, entry at ENTRY_BAR=15
  //   entry = bars[15].open=1.1000 + cost
  //   SL = entry - 20 * pipSize, TP = entry + 40 * pipSize

  const cfg  = getSymbolConfig("EURUSD");
  const cost = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
  const BASE = 1.1000;

  test("04. BUY SL hit", () => {
    const bars = flatBars(50, T0, M5_MS, BASE);
    const entry = BASE + cost;
    const sl    = entry - 20 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, BASE, BASE + 0.0010, sl - 0.0005, BASE + 0.0005);

    const result = run(oneBuyAt(0), bars);
    const t = result.trades[0];
    assert.equal(t?.exitReason, "SL", `exitReason=${t?.exitReason}`);
    assert.equal(t?.result, "LOSS");
    assert.ok(t.pips < 0, `pips=${t.pips}`);
  });

  test("05. BUY TP hit", () => {
    const bars = flatBars(50, T0, M5_MS, BASE);
    const entry = BASE + cost;
    const tp    = entry + 40 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, BASE, tp + 0.0005, BASE - 0.0005, BASE + 0.0020);

    const result = run(oneBuyAt(0), bars);
    const t = result.trades[0];
    assert.equal(t?.exitReason, "TP", `exitReason=${t?.exitReason}`);
    assert.equal(t?.result, "WIN");
    assert.ok(t.pips > 0, `pips=${t.pips}`);
  });

  test("06. SELL SL hit (price moves up)", () => {
    const bars  = flatBars(50, T0, M5_MS, BASE);
    const entry = BASE - cost;
    const sl    = entry + 20 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, BASE, sl + 0.0005, BASE - 0.0010, BASE + 0.0005);

    const result = run(oneSellAt(0), bars);
    const t = result.trades[0];
    assert.equal(t?.exitReason, "SL");
    assert.equal(t?.result, "LOSS");
  });

  test("07. SELL TP hit (price moves down)", () => {
    const bars  = flatBars(50, T0, M5_MS, BASE);
    const entry = BASE - cost;
    const tp    = entry - 40 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, BASE, BASE + 0.0005, tp - 0.0005, BASE - 0.0010);

    const result = run(oneSellAt(0), bars);
    const t = result.trades[0];
    assert.equal(t?.exitReason, "TP");
    assert.equal(t?.result, "WIN");
    assert.ok(t.pips > 0);
  });

  test("08. 同一 bar に SL + TP 両方到達 → SL 優先", () => {
    const bars  = flatBars(50, T0, M5_MS, BASE);
    const entry = BASE + cost;
    const sl    = entry - 20 * cfg.pipSize;
    const tp    = entry + 40 * cfg.pipSize;
    // high > TP AND low < SL on the same bar
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, BASE, tp + 0.0001, sl - 0.0001, BASE);

    const result = run(oneBuyAt(0), bars);
    const t = result.trades[0];
    assert.equal(t?.exitReason, "SL", "SL should be prioritized over TP");
    assert.equal(t?.result, "LOSS");
  });

  test("09. END_OF_DATA: 最終 bar まで SL/TP に到達しない", () => {
    // 50 flat bars, BUY at bar[14], SL/TP never hit → END_OF_DATA
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    const result = run(oneBuyAt(0), bars);
    // The flat bars won't hit SL (-20pips) or TP (+40pips)
    assert.equal(result.trades[0]?.exitReason, "END_OF_DATA");
    assert.equal(result.trades[0]?.result, "END_OF_DATA");
  });

});

// =================================================================
// ─── 3. Gap tests ───────────────────────────────────────────────
// =================================================================

describe("Gap", () => {

  // entry at ENTRY_BAR=15, gap on GAP_BAR=16
  const cfg  = getSymbolConfig("EURUSD");
  const cost = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
  const BASE = 1.1000;

  test("16. Gap SL: GAP_BAR opens below BUY SL → exit at bar.open", () => {
    const bars    = flatBars(50, T0, M5_MS, BASE);
    const entry   = BASE + cost;
    const sl      = entry - 20 * cfg.pipSize;
    const gapOpen = sl - 0.0010;  // opens below SL
    bars[GAP_BAR] = makeBar(bars[GAP_BAR].time, gapOpen, gapOpen + 0.0005, gapOpen - 0.0002, gapOpen);

    const result = run(oneBuyAt(0), bars);
    const t = result.trades[0];
    assert.equal(t?.exitReason, "SL");
    assert.ok(t.exitPrice < sl, `exitPrice=${t.exitPrice} should be < sl=${sl}`);
    assert.ok(Math.abs(t.exitPrice - gapOpen) < 0.00001, `exitPrice=${t.exitPrice}`);
  });

  test("17. Gap TP: GAP_BAR opens above BUY TP → exit at bar.open (favorable)", () => {
    const bars    = flatBars(50, T0, M5_MS, BASE);
    const entry   = BASE + cost;
    const tp      = entry + 40 * cfg.pipSize;
    const gapOpen = tp + 0.0010;  // opens above TP
    bars[GAP_BAR] = makeBar(bars[GAP_BAR].time, gapOpen, gapOpen + 0.0002, gapOpen - 0.0001, gapOpen);

    const result = run(oneBuyAt(0), bars);
    const t = result.trades[0];
    assert.equal(t?.exitReason, "TP");
    assert.ok(t.exitPrice > tp, `exitPrice=${t.exitPrice} should be > tp=${tp}`);
    assert.ok(Math.abs(t.exitPrice - gapOpen) < 0.00001);
  });

});

// =================================================================
// ─── 4. Position management ─────────────────────────────────────
// =================================================================

describe("Position Management", () => {

  test("10. Position 保有中は新規 Signal を無視する", () => {
    // Signal at every bar but position is held → only 1 trade until END_OF_DATA
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    const result = run(() => "BUY", bars);
    // Only 1 trade (position opened at warmup+1, held to END_OF_DATA)
    assert.equal(result.totalTrades, 1, `trades=${result.totalTrades}`);
  });

  test("18. 複数 Position 禁止 (maxPositionsPerSymbol=1)", () => {
    const bars = flatBars(100, T0, M5_MS, 1.1000);
    // Always signals BUY but can never open a second position
    const result = run(() => "BUY", bars);
    assert.equal(result.totalTrades, 1);
  });

  // Position is closed (TP hit) → new signal can be accepted
  test("10b. Position クローズ後は次のシグナルを受け付ける", () => {
    // signal at SIGNAL_BAR=14 (calls=1) → entry at ENTRY_BAR=15
    // TP hit at ENTRY_BAR=15 → position closed
    // step 3 at i=15 evaluator called (calls=2) → BUY → entry at 16
    // → 2nd trade held until END_OF_DATA
    const bars = flatBars(60, T0, M5_MS, 1.1000);
    const cfg  = getSymbolConfig("EURUSD");
    const cost = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    const entry1 = 1.1000 + cost;
    const tp1    = entry1 + 40 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, 1.1000, tp1 + 0.0001, 1.0998, 1.1040);

    let calls = 0;
    const mockEvaluator = (): SignalResult => {
      calls++;
      if (calls === 1) return "BUY"; // at i=14 → entry at i=15
      if (calls === 2) return "BUY"; // at i=15 (after TP close) → entry at i=16
      return "SKIP";
    };

    const result = run(mockEvaluator, bars);
    assert.ok(result.totalTrades >= 2, `totalTrades=${result.totalTrades}`);
    assert.equal(result.trades[0]?.exitReason, "TP");
    assert.equal(result.trades[1]?.direction, "BUY");
  });

});

// =================================================================
// ─── 5. Spread / Slippage tests ─────────────────────────────────
// =================================================================

describe("Spread / Slippage", () => {

  test("11. Spread: BUY entry = open + (spread + slippage) × pipSize", () => {
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    const result = run(oneBuyAt(0), bars);
    const t = result.trades[0];
    const cfg = getSymbolConfig("EURUSD");
    const expected = 1.1000 + (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    assert.ok(Math.abs(t.entryPrice - expected) < 0.000001);
    assert.equal(t.spreadPips, cfg.spreadPips);
  });

  test("12. Slippage: SELL entry = open − (spread + slippage) × pipSize", () => {
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    const result = run(oneSellAt(0), bars);
    const t = result.trades[0];
    const cfg = getSymbolConfig("EURUSD");
    const expected = 1.1000 - (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    assert.ok(Math.abs(t.entryPrice - expected) < 0.000001);
    assert.equal(t.slippagePips, cfg.slippagePips);
  });

});

// =================================================================
// ─── 6. Pip calculation tests ────────────────────────────────────
// =================================================================

describe("Pip Calculation", () => {

  test("13. EURUSD pip calculation (pipSize=0.0001)", () => {
    const cfg = getSymbolConfig("EURUSD");
    assert.equal(cfg.pipSize, 0.0001);
    const pips = priceToPips(0.0010, cfg);
    assert.ok(Math.abs(pips - 10) < 0.001, `pips=${pips}`);
  });

  test("14. USDJPY pip calculation (pipSize=0.01)", () => {
    const cfg = getSymbolConfig("USDJPY");
    assert.equal(cfg.pipSize, 0.01);
    const pips = priceToPips(0.10, cfg);
    assert.ok(Math.abs(pips - 10) < 0.001, `pips=${pips}`);
  });

  test("15. XAUUSD pip calculation (pipSize=0.10)", () => {
    const cfg = getSymbolConfig("XAUUSD");
    assert.equal(cfg.pipSize, 0.10);
    const pips = priceToPips(1.0, cfg);
    assert.ok(Math.abs(pips - 10) < 0.001, `pips=${pips}`);
  });

  test("Pips BUY WIN (TP hit): pips ≈ 40", () => {
    const bars  = flatBars(50, T0, M5_MS, 1.1000);
    const cfg   = getSymbolConfig("EURUSD");
    const cost  = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    const entry = 1.1000 + cost;
    const tp    = entry + 40 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, 1.1000, tp + 0.0001, 1.0998, 1.1040);

    const result = run(oneBuyAt(0), bars);
    const t = result.trades[0];
    assert.equal(t.exitReason, "TP");
    assert.ok(Math.abs(t.pips - 40) < 0.5, `pips=${t.pips}`);
  });

});

// =================================================================
// ─── 7. Account tests ───────────────────────────────────────────
// =================================================================

describe("Account / Balance / Drawdown", () => {

  test("19. Balance 更新: WIN → balance増加", () => {
    const bars  = flatBars(50, T0, M5_MS, 1.1000);
    const cfg   = getSymbolConfig("EURUSD");
    const cost  = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    const entry = 1.1000 + cost;
    const tp    = entry + 40 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, 1.1000, tp + 0.0001, 1.0998, 1.1040);

    const result = run(oneBuyAt(0), bars, { initialBalance: 10_000, fixedLot: 0.01 });
    assert.ok(result.finalBalance > result.initialBalance, `balance=${result.finalBalance}`);
    assert.equal(result.wins, 1);
    assert.equal(result.losses, 0);
  });

  test("19b. Balance 更新: LOSS → balance減少", () => {
    const bars  = flatBars(50, T0, M5_MS, 1.1000);
    const cfg   = getSymbolConfig("EURUSD");
    const cost  = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    const entry = 1.1000 + cost;
    const sl    = entry - 20 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, 1.1000, 1.1010, sl - 0.0005, 1.0990);

    const result = run(oneBuyAt(0), bars, { initialBalance: 10_000, fixedLot: 0.01 });
    assert.ok(result.finalBalance < result.initialBalance, `balance=${result.finalBalance}`);
    assert.equal(result.losses, 1);
  });

  test("20. Drawdown 更新", () => {
    const bars  = flatBars(60, T0, M5_MS, 1.1000);
    const cfg   = getSymbolConfig("EURUSD");
    const cost  = (cfg.spreadPips + cfg.slippagePips) * cfg.pipSize;
    const entry = 1.1000 + cost;
    const sl    = entry - 20 * cfg.pipSize;
    bars[ENTRY_BAR] = makeBar(bars[ENTRY_BAR].time, 1.1000, 1.1010, sl - 0.0005, 1.0990);

    const result = run(oneBuyAt(0), bars, { initialBalance: 10_000, fixedLot: 0.01 });
    assert.ok(result.maxDrawdown > 0, `maxDrawdown=${result.maxDrawdown}`);
    assert.ok(result.maxDrawdownPct > 0, `maxDrawdownPct=${result.maxDrawdownPct}`);
  });

});

// =================================================================
// ─── 8. Edge cases ──────────────────────────────────────────────
// =================================================================

describe("Edge Cases", () => {

  test("22. Warmup 期間: warmup bars をスキップして評価開始", () => {
    // バーが warmup 以下なら BacktestError
    const bars = flatBars(13, T0, M5_MS, 1.1000); // RSI14 warmup = 14, need > 14
    assert.throws(
      () => run(() => "BUY", bars),
      (err: unknown) => err instanceof BacktestError
    );
  });

  test("Empty bars → BacktestError", () => {
    assert.throws(
      () => run(() => "BUY", []),
      (err: unknown) => err instanceof BacktestError
    );
  });

  test("Unknown timeframe → BacktestError", () => {
    const bars = flatBars(50, T0, M5_MS, 1.1000);
    assert.throws(
      () => runBacktest({
        spec:            makeSpec(),
        symbol:          "EURUSD",
        mainTimeframe:   "XX99",   // unknown
        barsByTimeframe: { XX99: bars },
        _evaluatorOverride: () => "SKIP",
      }),
      (err: unknown) => err instanceof BacktestError
    );
  });

  test("23. 次 bar が存在しない場合 Entry しない (最終 bar でシグナル)", () => {
    const bars = flatBars(15, T0, M5_MS, 1.1000);
    // warmup=13, loop runs bar[13] and bar[14]
    // Signal at bar[14] (last bar) → no bar[15] → no entry
    let calls = 0;
    const lateSignal = () => {
      calls++;
      return calls === 2 ? "BUY" as SignalResult : "SKIP" as SignalResult;
    };
    const result = run(lateSignal, bars);
    assert.equal(result.totalTrades, 0);
  });

});

// =================================================================
// ─── 9. checkExitOnBar unit tests ───────────────────────────────
// =================================================================

describe("checkExitOnBar (PositionManager)", () => {

  const basePos = (dir: "BUY" | "SELL") => ({
    tradeId: 1, direction: dir, symbol: "EURUSD", timeframe: "M5",
    entryTime: T0, entryPrice: 1.1000, lot: 0.01,
    spreadPips: 1.5, slippagePips: 0.3, entryBarIdx: 0,
    sl: dir === "BUY" ? 1.0980 : 1.1020,
    tp: dir === "BUY" ? 1.1040 : 1.0960,
  });

  test("BUY: normal bar, neither SL nor TP → no hit", () => {
    const pos = basePos("BUY");
    const bar = makeBar(T0, 1.1000, 1.1010, 1.0990, 1.1005);
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, false);
  });

  test("BUY: low hits SL → SL hit at SL price", () => {
    const pos = basePos("BUY");
    const bar = makeBar(T0, 1.1000, 1.1010, 1.0975, 1.1005); // low=1.0975 < sl=1.0980
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.reason, "SL"); assert.equal(r.price, pos.sl); }
  });

  test("BUY: high hits TP → TP hit at TP price", () => {
    const pos = basePos("BUY");
    const bar = makeBar(T0, 1.1000, 1.1045, 1.0990, 1.1040); // high=1.1045 > tp=1.1040
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.reason, "TP"); assert.equal(r.price, pos.tp); }
  });

  test("SELL: high hits SL → SL hit", () => {
    const pos = basePos("SELL");
    const bar = makeBar(T0, 1.1000, 1.1025, 1.0990, 1.0995); // high=1.1025 > sl=1.1020
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, true);
    if (r.hit) assert.equal(r.reason, "SL");
  });

  test("SELL: low hits TP → TP hit", () => {
    const pos = basePos("SELL");
    const bar = makeBar(T0, 1.1000, 1.1010, 1.0955, 1.0990); // low=1.0955 < tp=1.0960
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, true);
    if (r.hit) assert.equal(r.reason, "TP");
  });

  test("BUY: gap down below SL → exit at open", () => {
    const pos = basePos("BUY");
    const bar = makeBar(T0, 1.0970, 1.0980, 1.0965, 1.0975); // open=1.0970 <= sl=1.0980
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.reason, "SL"); assert.equal(r.price, bar.open); }
  });

  test("BUY: gap up above TP → exit at open", () => {
    const pos = basePos("BUY");
    const bar = makeBar(T0, 1.1045, 1.1050, 1.1040, 1.1048); // open=1.1045 >= tp=1.1040
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.reason, "TP"); assert.equal(r.price, bar.open); }
  });

  test("BUY same bar SL+TP both → SL wins", () => {
    const pos = basePos("BUY");
    // low < SL and high > TP
    const bar = makeBar(T0, 1.1000, 1.1050, 1.0975, 1.1020);
    const r = checkExitOnBar(pos, bar);
    assert.equal(r.hit, true);
    if (r.hit) assert.equal(r.reason, "SL");
  });

});

// =================================================================
// ─── 10. Look-ahead test ────────────────────────────────────────
// =================================================================

describe("Look-ahead Prevention", () => {

  test("21. SL/TP 計算に未来 Swing Low を使用しない", () => {
    // signal at SIGNAL_BAR=14, SL uses bars[0..14].low
    // Future bars (i >= ENTRY_BAR=15) have extreme low → must NOT affect SL
    const spec = makeSpec({
      exit_conditions: {
        stop_loss:   { method: "SWING_LOW", period: 20 },
        take_profit: { method: "FIXED_PIPS", pips: 40 },
      },
    } as Partial<StrategySpec>);

    // Normal bars (all at 1.1000, min low ≈ 1.0989)
    const normalBars = flatBars(50, T0, M5_MS, 1.1000);

    // Injected bars: future bars (i >= ENTRY_BAR=15) have extreme low
    const injectedBars = flatBars(50, T0, M5_MS, 1.1000);
    for (let i = ENTRY_BAR; i < 50; i++) {
      injectedBars[i] = makeBar(injectedBars[i].time, 1.1000, 1.1010, 0.5000, 1.1000);
    }

    const r1 = runBacktest({
      spec, symbol: "EURUSD", mainTimeframe: "M5",
      barsByTimeframe: { M5: normalBars },
      _evaluatorOverride: oneBuyAt(0),
    });
    const r2 = runBacktest({
      spec, symbol: "EURUSD", mainTimeframe: "M5",
      barsByTimeframe: { M5: injectedBars },
      _evaluatorOverride: oneBuyAt(0),
    });

    // Both use bars[0..SIGNAL_BAR=14] for SWING_LOW (same data) → same SL
    assert.ok(r1.trades.length > 0 && r2.trades.length > 0);
    assert.ok(
      Math.abs(r1.trades[0].sl - r2.trades[0].sl) < 0.0001,
      `SL differs: normal=${r1.trades[0].sl}, injected=${r2.trades[0].sl}`
    );
  });

});

// =================================================================
// ─── Summary ─────────────────────────────────────────────────────
// =================================================================

const total = passed + failed;
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed === 0) { console.log("🎉 All tests PASSED"); }
else { console.log("💥 Some tests FAILED"); process.exit(1); }

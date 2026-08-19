// =================================================================
// BacktestEngine.ts — Backtest Core Engine (Phase 2-C)
//
// Strategy Spec + Historical Bars → BacktestResult
//
// 処理順序 (各 bar):
//   1. 前 bar のシグナルによる pending entry 実行 (次 bar Open)
//   2. 保有ポジションの SL/TP 判定
//   3. ポジションなし → StrategyEvaluator 呼び出し
//   4. Signal あり → pending entry 登録 (次 bar で実行)
//
// 設計原則:
//   - Supabase / MT5 / OpenAI 非依存
//   - Look-ahead Bias 完全防止 (Phase 2-B から継承)
//   - maxPositionsPerSymbol = 1
// =================================================================

import type { Bar }                   from "@/infrastructure/analysis/types";
import type { StrategySpec }          from "@/lib/strategySchema";
import type { PrecomputedIndicators, PrecomputeParams } from "./indicators";
import { precomputeIndicators }       from "./indicators";
import { TF_MS }                      from "./timeframe";
import { evaluateStrategy, type EvaluationContext, type SignalResult } from "./evaluator";
import { getSymbolConfig, pipToPrice, priceToPips, type SymbolConfig } from "./spreadConfig";
import { AccountSimulator }           from "./AccountSimulator";
import {
  checkExitOnBar,
  buildClosedTrade,
  type OpenPosition,
  type BacktestTrade,
} from "./PositionManager";
import { WARMUP_BARS }                from "./types";

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export type { BacktestTrade } from "./PositionManager";

export interface BacktestInput {
  spec:              StrategySpec;
  symbol:            string;
  mainTimeframe:     string;
  barsByTimeframe:   Record<string, Bar[]>;
  initialBalance?:   number;
  /** 固定ロットサイズ。デフォルト 0.01 */
  fixedLot?:         number;
  /** テスト用 Evaluator オーバーライド */
  _evaluatorOverride?: (ctx: EvaluationContext) => SignalResult;
}

export interface BacktestResult {
  trades:          BacktestTrade[];
  totalTrades:     number;
  wins:            number;
  losses:          number;
  winRate:         number;    // 0-100 (%)
  totalPips:       number;
  totalProfit:     number;
  initialBalance:  number;
  finalBalance:    number;
  peakBalance:     number;
  maxDrawdown:     number;
  maxDrawdownPct:  number;
  symbol:          string;
  mainTimeframe:   string;
  startTime:       number;   // warmup 後の最初の bar 開始時刻 (ms)
  endTime:         number;   // 最後の bar 開始時刻 (ms)
  barsProcessed:   number;   // warmup を除いた評価 bar 数
}

export class BacktestError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BacktestError";
  }
}

// ------------------------------------------------------------------
// Warmup 計算
// ------------------------------------------------------------------

function computeWarmup(spec: StrategySpec): number {
  const indicators = new Set<string>();
  let maxEmaPeriod = 21;

  const collect = (ind: string, period?: number) => {
    indicators.add(ind);
    if (ind === "EMA" && period) maxEmaPeriod = Math.max(maxEmaPeriod, period);
  };

  for (const c of spec.entry_conditions.conditions) {
    collect(c.indicator, c.period);
  }
  if (spec.filters?.trend_filter) {
    collect(spec.filters.trend_filter.indicator, spec.filters.trend_filter.period);
  }

  let warmup = WARMUP_BARS.atr(14); // ATR for SL/TP

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

  return warmup;
}

// ------------------------------------------------------------------
// Entry price (Spread + Slippage)
// ------------------------------------------------------------------

function calcEntryPrice(
  barOpen:   number,
  direction: "BUY" | "SELL",
  cfg:       SymbolConfig,
): number {
  const cost = pipToPrice(cfg.spreadPips + cfg.slippagePips, cfg);
  return direction === "BUY" ? barOpen + cost : barOpen - cost;
}

// ------------------------------------------------------------------
// SL/TP 計算 (exit_conditions から)
// ------------------------------------------------------------------

type SLSpec = NonNullable<NonNullable<StrategySpec["exit_conditions"]>["stop_loss"]>;
type TPSpec = NonNullable<NonNullable<StrategySpec["exit_conditions"]>["take_profit"]>;

function calcSL(
  direction: "BUY" | "SELL",
  entry:     number,
  slSpec:    SLSpec | undefined,
  atr:       number,
  bars:      Bar[],
  barIdx:    number,
  pipSize:   number,
): number {
  const mult = slSpec?.multiplier ?? 1.5;
  const sign = direction === "BUY" ? -1 : 1; // BUY: below entry, SELL: above

  switch (slSpec?.method) {
    case "ATR":
      return entry + sign * atr * mult;

    case "FIXED_PIPS":
      return entry + sign * (slSpec.pips ?? 20) * pipSize;

    case "PERCENTAGE": {
      const pct = (slSpec.pct ?? 0.5) / 100;
      return entry * (1 + sign * pct);
    }

    case "SWING_LOW": {
      // BUY SL: 直近安値の下
      const lookback = slSpec.period ?? 20;
      const from = Math.max(0, barIdx - lookback + 1);
      let swingLow = Infinity;
      for (let i = from; i <= barIdx; i++) swingLow = Math.min(swingLow, bars[i].low);
      return isFinite(swingLow) ? swingLow - atr * 0.3 : entry - atr * mult;
    }

    case "SWING_HIGH": {
      // SELL SL: 直近高値の上
      const lookback = slSpec.period ?? 20;
      const from = Math.max(0, barIdx - lookback + 1);
      let swingHigh = -Infinity;
      for (let i = from; i <= barIdx; i++) swingHigh = Math.max(swingHigh, bars[i].high);
      return isFinite(swingHigh) ? swingHigh + atr * 0.3 : entry + atr * mult;
    }

    default:
      // 未設定: ATR × 1.5
      return entry + sign * atr * 1.5;
  }
}

function calcTP(
  direction: "BUY" | "SELL",
  entry:     number,
  tpSpec:    TPSpec | undefined,
  atr:       number,
  bars:      Bar[],
  barIdx:    number,
  pipSize:   number,
  sl:        number,
): number {
  const slDist  = Math.abs(entry - sl);
  const sign    = direction === "BUY" ? 1 : -1; // BUY: above entry

  switch (tpSpec?.method) {
    case "ATR": {
      const mult = tpSpec.multiplier ?? 2.0;
      return entry + sign * atr * mult;
    }

    case "FIXED_PIPS":
      return entry + sign * (tpSpec.pips ?? 40) * pipSize;

    case "RR_RATIO": {
      const rr = tpSpec.rr_ratio ?? 1.5;
      return entry + sign * slDist * rr;
    }

    case "PERCENTAGE": {
      const pct = (tpSpec.pct ?? 1.0) / 100;
      return entry * (1 + sign * pct);
    }

    case "SWING_HIGH": {
      // BUY TP: 直近高値
      const lookback = tpSpec.period ?? 20;
      const from = Math.max(0, barIdx - lookback + 1);
      let swingHigh = -Infinity;
      for (let i = from; i <= barIdx; i++) swingHigh = Math.max(swingHigh, bars[i].high);
      return isFinite(swingHigh) && swingHigh > entry + slDist
        ? swingHigh - atr * 0.1
        : entry + slDist * 1.5;
    }

    case "SWING_LOW": {
      // SELL TP: 直近安値
      const lookback = tpSpec.period ?? 20;
      const from = Math.max(0, barIdx - lookback + 1);
      let swingLow = Infinity;
      for (let i = from; i <= barIdx; i++) swingLow = Math.min(swingLow, bars[i].low);
      return isFinite(swingLow) && swingLow < entry - slDist
        ? swingLow + atr * 0.1
        : entry - slDist * 1.5;
    }

    default:
      // 未設定: SL距離 × 1.5
      return entry + sign * slDist * 1.5;
  }
}

function calcSLTP(params: {
  direction:      "BUY" | "SELL";
  entryPrice:     number;
  exitConditions: StrategySpec["exit_conditions"];
  bars:           Bar[];
  inds:           PrecomputedIndicators;
  barIdx:         number;   // signal bar index (SL/TP 計算の基準)
  cfg:            SymbolConfig;
}): { sl: number; tp: number } {
  const { direction, entryPrice, exitConditions, bars, inds, barIdx, cfg } = params;
  const atr = inds.atr[barIdx] ?? pipToPrice(15, cfg); // ATR fallback: 15 pips

  const sl = calcSL(direction, entryPrice, exitConditions?.stop_loss, atr, bars, barIdx, cfg.pipSize);
  const tp = calcTP(direction, entryPrice, exitConditions?.take_profit, atr, bars, barIdx, cfg.pipSize, sl);

  return { sl, tp };
}

// ------------------------------------------------------------------
// Main engine
// ------------------------------------------------------------------

export function runBacktest(input: BacktestInput): BacktestResult {
  const {
    spec,
    symbol,
    mainTimeframe,
    barsByTimeframe,
    initialBalance  = 10_000,
    fixedLot        = 0.01,
    _evaluatorOverride,
  } = input;

  // ── Validate ──────────────────────────────────────────────
  const mainBars = barsByTimeframe[mainTimeframe];
  if (!mainBars || mainBars.length === 0) {
    throw new BacktestError(`No bars for main timeframe "${mainTimeframe}"`);
  }
  if (!TF_MS[mainTimeframe]) {
    throw new BacktestError(`Unknown timeframe: ${mainTimeframe}`);
  }

  // ── Precompute indicators ──────────────────────────────────
  const indicatorsByTf: Record<string, PrecomputedIndicators> = {};
  for (const [tf, bars] of Object.entries(barsByTimeframe)) {
    if (bars.length > 0) {
      indicatorsByTf[tf] = precomputeIndicators(bars);
    }
  }

  // ── Warmup ────────────────────────────────────────────────
  const warmup = computeWarmup(spec);
  if (mainBars.length <= warmup) {
    throw new BacktestError(
      `Insufficient bars: ${mainBars.length} bars (need > ${warmup} for warmup)`
    );
  }

  // ── Init ──────────────────────────────────────────────────
  const cfg     = getSymbolConfig(symbol);
  const account = new AccountSimulator(initialBalance);
  const trades:  BacktestTrade[] = [];
  let   tradeId = 0;

  let openPos:            OpenPosition | null = null;
  let pendingDirection:   "BUY" | "SELL" | null = null;
  let pendingSignalBarIdx = -1;

  const tfMs     = TF_MS[mainTimeframe]!;
  const mainInds = indicatorsByTf[mainTimeframe];
  const evaluator = _evaluatorOverride ?? evaluateStrategy;

  // ── Main loop ─────────────────────────────────────────────
  for (let i = warmup; i < mainBars.length; i++) {
    const bar = mainBars[i];

    // Step 1: Execute pending entry at this bar's open
    if (pendingDirection != null && openPos == null) {
      const dir    = pendingDirection;
      const sigIdx = pendingSignalBarIdx;
      pendingDirection   = null;
      pendingSignalBarIdx = -1;

      const entryPrice = calcEntryPrice(bar.open, dir, cfg);
      const { sl, tp } = calcSLTP({
        direction:      dir,
        entryPrice,
        exitConditions: spec.exit_conditions,
        bars:           mainBars,
        inds:           mainInds,
        barIdx:         sigIdx,  // signal bar の ATR を使用
        cfg,
      });

      openPos = {
        tradeId:      ++tradeId,
        direction:    dir,
        symbol,
        timeframe:    mainTimeframe,
        entryTime:    bar.time,
        entryPrice,
        sl,
        tp,
        lot:          fixedLot,
        spreadPips:   cfg.spreadPips,
        slippagePips: cfg.slippagePips,
        entryBarIdx:  i,
      };
    }

    // Step 2: Check SL/TP on open position using current bar
    if (openPos != null) {
      const exitCheck = checkExitOnBar(openPos, bar);
      if (exitCheck.hit) {
        const closed = buildClosedTrade(
          openPos, bar, i,
          exitCheck.reason, exitCheck.price,
          cfg.pipSize, cfg.pipValuePerLot
        );
        trades.push(closed);
        account.recordTrade({ pips: closed.pips, profit: closed.profit, result: closed.result });
        openPos = null;
      }
    }

    // Step 3: No position → evaluate strategy
    if (openPos == null && pendingDirection == null) {
      const evalTime = bar.time + tfMs;
      const ctx: EvaluationContext = {
        spec,
        evaluationTime:        evalTime,
        barsByTimeframe,
        indicatorsByTimeframe: indicatorsByTf,
        spreadPips:            cfg.spreadPips,
      };
      const signal = evaluator(ctx);

      // Signal あり かつ 次 bar が存在する場合のみ entry 予約
      if (signal !== "SKIP" && i + 1 < mainBars.length) {
        pendingDirection   = signal;
        pendingSignalBarIdx = i;
      }
    }
  }

  // ── END_OF_DATA: 残ポジションを最終 bar Close でクローズ ─
  if (openPos != null) {
    const lastBar = mainBars[mainBars.length - 1];
    const lastIdx = mainBars.length - 1;
    const closed  = buildClosedTrade(
      openPos, lastBar, lastIdx,
      "END_OF_DATA", lastBar.close,
      cfg.pipSize, cfg.pipValuePerLot
    );
    trades.push(closed);
    account.recordTrade({ pips: closed.pips, profit: closed.profit, result: closed.result });
    openPos = null;
  }

  // ── Result ────────────────────────────────────────────────
  const state   = account.getState();
  const wins    = trades.filter(t => t.result === "WIN").length;
  const losses  = trades.filter(t => t.result === "LOSS").length;
  const barsProcessed = mainBars.length - warmup;

  return {
    trades,
    totalTrades:    trades.length,
    wins,
    losses,
    winRate:        trades.length > 0 ? Math.round(wins / trades.length * 10000) / 100 : 0,
    totalPips:      Math.round(state.totalPips * 10) / 10,
    totalProfit:    Math.round(state.realizedProfit * 100) / 100,
    initialBalance,
    finalBalance:   Math.round(state.balance * 100) / 100,
    peakBalance:    Math.round(state.peakBalance * 100) / 100,
    maxDrawdown:    Math.round(state.maxDrawdown * 100) / 100,
    maxDrawdownPct: Math.round(state.maxDrawdownPct * 100) / 100,
    symbol,
    mainTimeframe,
    startTime:      mainBars[warmup].time,
    endTime:        mainBars[mainBars.length - 1].time,
    barsProcessed,
  };
}

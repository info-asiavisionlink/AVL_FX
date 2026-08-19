// =================================================================
// PositionManager.ts — 仮想ポジション管理 (Phase 2-C)
//
// Open / Close ロジックと SL/TP 判定。
// Look-ahead Bias なし: bar の OHLC のみ使用。
// =================================================================

import type { Bar } from "@/infrastructure/analysis/types";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface OpenPosition {
  tradeId:      number;
  direction:    "BUY" | "SELL";
  symbol:       string;
  timeframe:    string;
  entryTime:    number;
  entryPrice:   number;
  sl:           number;
  tp:           number;
  lot:          number;
  spreadPips:   number;
  slippagePips: number;
  entryBarIdx:  number;
}

export interface BacktestTrade extends OpenPosition {
  exitTime:    number;
  exitPrice:   number;
  exitBarIdx:  number;
  exitReason:  "TP" | "SL" | "END_OF_DATA";
  pips:        number;
  profit:      number;
  durationMin: number;
  result:      "WIN" | "LOSS" | "BREAKEVEN" | "END_OF_DATA";
}

export type ExitCheck =
  | { hit: false }
  | { hit: true; reason: "TP" | "SL"; price: number };

// ------------------------------------------------------------------
// SL/TP 判定
//
// 判定優先順位:
//   1. Gap: bar.open が既に SL/TP を越えている → bar.open で Exit
//   2. 同一 bar に SL + TP 両方到達 → SL 優先（保守的バックテスト）
//   3. 通常: low/high が SL/TP 到達 → SL/TP 価格で Exit
// ------------------------------------------------------------------

export function checkExitOnBar(pos: OpenPosition, bar: Bar): ExitCheck {
  const { direction, sl, tp } = pos;

  if (direction === "BUY") {
    // Gap down (open below SL)
    if (bar.open <= sl) return { hit: true, reason: "SL", price: bar.open };
    // Gap up past TP
    if (bar.open >= tp) return { hit: true, reason: "TP", price: bar.open };
    // SL 優先: low が SL に達したか先に確認
    if (bar.low  <= sl) return { hit: true, reason: "SL", price: sl };
    if (bar.high >= tp) return { hit: true, reason: "TP", price: tp };
  } else {
    // SELL: Gap up (open above SL for SELL)
    if (bar.open >= sl) return { hit: true, reason: "SL", price: bar.open };
    // Gap down past TP (for SELL)
    if (bar.open <= tp) return { hit: true, reason: "TP", price: bar.open };
    // SL 優先
    if (bar.high >= sl) return { hit: true, reason: "SL", price: sl };
    if (bar.low  <= tp) return { hit: true, reason: "TP", price: tp };
  }

  return { hit: false };
}

// ------------------------------------------------------------------
// Trade 結果を生成
// ------------------------------------------------------------------

export function buildClosedTrade(
  pos:            OpenPosition,
  exitBar:        Bar,
  exitBarIdx:     number,
  reason:         "TP" | "SL" | "END_OF_DATA",
  exitPrice:      number,
  pipSize:        number,
  pipValuePerLot: number,
): BacktestTrade {
  // BUY: 上昇が利益。SELL: 下落が利益。
  const priceDiff = pos.direction === "BUY"
    ? exitPrice - pos.entryPrice
    : pos.entryPrice - exitPrice;

  const pips   = Math.round((priceDiff / pipSize) * 10) / 10;
  const profit = Math.round(pips * pipValuePerLot * pos.lot * 100) / 100;

  const result: BacktestTrade["result"] =
    reason === "END_OF_DATA" ? "END_OF_DATA" :
    pips  >  0               ? "WIN"         :
    pips  <  0               ? "LOSS"        : "BREAKEVEN";

  return {
    ...pos,
    exitTime:    exitBar.time,
    exitPrice,
    exitBarIdx,
    exitReason:  reason,
    pips,
    profit,
    durationMin: Math.round((exitBar.time - pos.entryTime) / 60_000 * 10) / 10,
    result,
  };
}

// =================================================================
// PositionManager.ts — 仮想ポジション管理 (Phase 2-C)
//
// Open / Close ロジックと SL/TP 判定。
// Look-ahead Bias なし: bar の OHLC のみ使用。
//
// 追加機能:
//   - TrailingStop: 価格が有利方向に動くにつれてSLが追随
//   - MultiTP: 複数TP / 部分決済 (take_profits[])
// =================================================================

import type { Bar } from "@/infrastructure/analysis/types";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface TPLevel {
  price:   number;
  portion: number;  // 0.0-1.0 (e.g. 0.5 = 50%)
  hit:     boolean;
}

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

  // ── TrailingStop ───────────────────────────────────────────────
  /** 現在のトレーリングSL価格 (0 = 未発動) */
  trailSL?:       number;
  /** 有利方向で到達した最高値(BUY) / 最安値(SELL) */
  highestFav?:    number;
  /** トレーリング距離 (価格単位)。0 = トレーリングなし */
  trailDistance?: number;

  // ── MultiTP ────────────────────────────────────────────────────
  /** 残ポジション割合 (0.0-1.0) */
  remainingLot?: number;
  /** 各TPレベル */
  tpLevels?:     TPLevel[];
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
  /** 部分決済の場合に元のlotに対する割合 */
  partialPortion?: number;
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
// TrailingStop 更新
//
// 各バーで呼び出す。pos.trailDistance > 0 の場合のみ有効。
// trailSL を上方向(BUY) / 下方向(SELL) にのみ移動する。
//
// @param pos      現在のオープンポジション（更新あり）
// @param bar      現在のバー
// @param pipSize  1 pip のサイズ
// @param activationPips  発動までの最低利益 pips（0 = 即発動）
// @returns        トレーリングSTOP ヒットしたら exit 情報、なければ null
// ------------------------------------------------------------------

export function updateTrailingStop(
  pos:             OpenPosition,
  bar:             Bar,
  pipSize:         number,
  activationPips:  number,
): { hit: true; price: number } | null {
  const trailDistance = pos.trailDistance ?? 0;
  if (trailDistance <= 0) return null;

  if (pos.direction === "BUY") {
    // 現在の利益 (pips)
    const currentProfit = (bar.high - pos.entryPrice) / pipSize;

    if (currentProfit >= activationPips) {
      // 最高到達点を更新
      const prevHighest = pos.highestFav ?? pos.entryPrice;
      if (bar.high > prevHighest) {
        pos.highestFav = bar.high;
      }
      const highest = pos.highestFav ?? pos.entryPrice;
      // 新しいトレーリングSL = 最高到達点 - trailDistance
      const newTrailSL = highest - trailDistance;
      // SLは上方向にしか動かさない
      const prevTrailSL = pos.trailSL ?? 0;
      if (prevTrailSL === 0) {
        pos.trailSL = newTrailSL;
      } else {
        pos.trailSL = Math.max(prevTrailSL, newTrailSL);
      }
      // トレーリングSLが通常SLより高い場合はトレーリングSLを使用
      const effectiveSL = Math.max(pos.sl, pos.trailSL!);
      // バーの安値がeffective SLを割ったらEXIT
      if (bar.low <= effectiveSL) {
        return { hit: true, price: Math.max(bar.open, effectiveSL) };
      }
    }
  } else {
    // SELL
    const currentProfit = (pos.entryPrice - bar.low) / pipSize;

    if (currentProfit >= activationPips) {
      // 最低到達点を更新 (SELLでは最安値が有利)
      const prevHighestFav = pos.highestFav ?? pos.entryPrice;
      if (prevHighestFav === pos.entryPrice || bar.low < prevHighestFav) {
        pos.highestFav = bar.low;
      }
      const lowest = pos.highestFav ?? pos.entryPrice;
      // 新しいトレーリングSL = 最低到達点 + trailDistance
      const newTrailSL = lowest + trailDistance;
      // SLは下方向にしか動かさない
      const prevTrailSL = pos.trailSL ?? 0;
      if (prevTrailSL === 0) {
        pos.trailSL = newTrailSL;
      } else {
        pos.trailSL = Math.min(prevTrailSL, newTrailSL);
      }
      // トレーリングSLが通常SLより低い場合はトレーリングSLを使用
      const effectiveSL = Math.min(pos.sl, pos.trailSL!);
      // バーの高値がeffective SLを超えたらEXIT
      if (bar.high >= effectiveSL) {
        return { hit: true, price: Math.min(bar.open, effectiveSL) };
      }
    }
  }

  return null;
}

// ------------------------------------------------------------------
// MultiTP 部分決済チェック
//
// 各バーでhitしていないTPレベルをチェックし、
// ヒットしたレベルに対して部分決済トレードを生成する。
//
// @returns  部分決済トレードの配列（空の場合はヒットなし）
// ------------------------------------------------------------------

export function checkPartialExits(
  pos:           OpenPosition,
  bar:           Bar,
  barIdx:        number,
  pipSize:       number,
  pipValuePerLot: number,
): BacktestTrade[] {
  if (!pos.tpLevels || pos.tpLevels.length === 0) return [];

  const partials: BacktestTrade[] = [];

  for (const level of pos.tpLevels) {
    if (level.hit) continue;

    let tpHit = false;
    let exitPrice = level.price;

    if (pos.direction === "BUY") {
      if (bar.open >= level.price) {
        tpHit = true;
        exitPrice = bar.open; // ギャップアップ
      } else if (bar.high >= level.price) {
        tpHit = true;
        exitPrice = level.price;
      }
    } else {
      if (bar.open <= level.price) {
        tpHit = true;
        exitPrice = bar.open; // ギャップダウン
      } else if (bar.low <= level.price) {
        tpHit = true;
        exitPrice = level.price;
      }
    }

    if (tpHit) {
      level.hit = true;
      const currentRemaining = pos.remainingLot ?? 1.0;
      const closedPortion = Math.min(level.portion, currentRemaining);
      pos.remainingLot = Math.max(0, currentRemaining - closedPortion);

      // 部分決済分のトレードを生成
      const partialLot = pos.lot * closedPortion;
      const partial = buildClosedTrade(
        { ...pos, lot: partialLot },
        bar,
        barIdx,
        "TP",
        exitPrice,
        pipSize,
        pipValuePerLot,
      );
      partial.partialPortion = closedPortion;
      partials.push(partial);

      // TP1ヒット後、残ポジションがある場合はSLをブレイクイーブンへ移動
      const remainingLot = pos.remainingLot ?? 1.0;
      if (remainingLot > 0 && (pos.tpLevels ?? []).indexOf(level) === 0) {
        if (pos.direction === "BUY" && pos.sl < pos.entryPrice) {
          pos.sl = pos.entryPrice;
        } else if (pos.direction === "SELL" && pos.sl > pos.entryPrice) {
          pos.sl = pos.entryPrice;
        }
      }
    }
  }

  return partials;
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

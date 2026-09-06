// =================================================================
// PositionSizer — 動的ロットサイジング
//
// 固定ロットを使わない。口座エクイティ × リスク% から計算する。
// =================================================================

export interface SymbolSpec {
  contractSize: number;   // lot あたりの契約単位 (例: 100000)
  tickValue:    number;   // 1 tick あたりの価値 (口座通貨)
  tickSize:     number;   // 最小価格変動 (例: 0.00001)
  minLot:       number;   // 最小ロット
  maxLot:       number;   // 最大ロット
  lotStep:      number;   // ロットステップ
  digits:       number;
}

export interface SizingResult {
  lot:         number;
  riskAmount:  number;   // 損失額 (口座通貨)
  riskPct:     number;   // エクイティ %
  slDistPips:  number;
  tpDistPips:  number;
  rr:          number;
}

const POINT_MAP: Record<number, number> = {
  5: 0.00001, 3: 0.001, 2: 0.01, 1: 0.1, 0: 1,
};

function point(digits: number): number {
  return POINT_MAP[digits] ?? 0.00001;
}

/**
 * lot = (equity * riskPct / 100) / (slDistPips * tickValue / tickSize * point)
 *
 * MT5 の lot ステップに丸め、min/max でクリップする。
 */
export function calcLot(params: {
  equity:    number;
  riskPct:   number;   // 例: 0.25 → 0.25%
  entry:     number;
  stopLoss:  number;
  takeProfit:number;
  spec:      SymbolSpec;
}): SizingResult {
  const { equity, riskPct, entry, stopLoss, takeProfit, spec } = params;
  const pt = point(spec.digits);

  const slDistPrice  = Math.abs(entry - stopLoss);
  const tpDistPrice  = Math.abs(takeProfit - entry);
  const slDistPips   = slDistPrice / pt / 10;   // 5-digit broker → pips
  const tpDistPips   = tpDistPrice / pt / 10;
  const rr           = tpDistPips > 0 ? tpDistPips / Math.max(slDistPips, 0.001) : 0;

  const riskAmount   = equity * riskPct / 100;

  // pip value per lot
  const pipValue = (spec.tickValue / spec.tickSize) * pt * 10;
  const rawLot   = slDistPips > 0 ? riskAmount / (slDistPips * pipValue) : spec.minLot;

  // Round to lot step
  const steps = Math.round(rawLot / spec.lotStep);
  const lot   = Math.min(
    spec.maxLot,
    Math.max(spec.minLot, parseFloat((steps * spec.lotStep).toFixed(2)))
  );

  return { lot, riskAmount: lot * slDistPips * pipValue, riskPct, slDistPips, tpDistPips, rr };
}

/**
 * Gateway から受け取ったシンボル情報からスペックを構築。
 * なければデフォルト（EURUSD 5-digit 標準）を使用。
 */
export function makeSymbolSpec(raw?: {
  contractSize?: number;
  tickValue?:    number;
  tickSize?:     number;
  digits?:       number;
}): SymbolSpec {
  const digits = raw?.digits ?? 5;
  return {
    contractSize: raw?.contractSize ?? 100_000,
    tickValue:    raw?.tickValue    ?? 1.0,
    tickSize:     raw?.tickSize     ?? point(digits),
    minLot:       0.01,
    maxLot:       100,
    lotStep:      0.01,
    digits,
  };
}

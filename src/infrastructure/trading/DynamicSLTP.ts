// =================================================================
// DynamicSLTP — ATR + 市場構造ベースの動的 SL/TP 計算
//
// 固定 RR 禁止。SL は構造 / ATR から。TP は次の S/R から。
// =================================================================

import type { SRLevel } from "@/domain/trading/MarketSnapshot";

interface SLTPInput {
  direction:   "BUY" | "SELL";
  entry:       number;
  atr:         number;           // H1 ATR
  atrH4:       number;           // H4 ATR
  srLevels:    SRLevel[];
  lastSwingHH: number | null;    // ダウ理論スイング
  lastSwingHL: number | null;
  lastSwingLH: number | null;
  lastSwingLL: number | null;
  spread:      number;           // pips
  digits:      number;
}

interface SLTPResult {
  entry:      number;
  sl:         number;
  tp:         number;
  slPips:     number;
  tpPips:     number;
  rr:         number;
  slSource:   string;
  tpSource:   string;
}

function pip(digits: number): number {
  return digits >= 4 ? 0.0001 : 0.01;
}

export function calcDynamicSLTP(input: SLTPInput): SLTPResult {
  const { direction, entry, atr, atrH4, srLevels, spread, digits,
          lastSwingHH, lastSwingHL, lastSwingLH, lastSwingLL } = input;
  const pt       = pip(digits);
  const spreadPt = spread * pt / 10;    // spread を price に変換（5-digit broker）

  // ── SL 計算 ──────────────────────────────────────────────────
  // 優先度: ① 直近スイングの少し外 → ② ATR × 1.5 → ③ ATR × 2.0
  let sl:       number;
  let slSource: string;

  if (direction === "BUY") {
    // BUY: SL は エントリーより下
    const swingRef = lastSwingHL ?? lastSwingLL;   // 直近 HL か LL の下

    if (swingRef && swingRef < entry) {
      sl       = swingRef - atr * 0.3;              // スイング下 + ATR バッファ
      slSource = `HL swing (${swingRef.toFixed(digits)}) - ATR×0.3`;
    } else {
      sl       = entry - atr * 1.5;
      slSource = "ATR×1.5";
    }

    // S/R サポートレベルが近ければ優先
    const nearSupport = srLevels
      .filter(l => l.type === "support" && l.price < entry && l.price > entry - atrH4 * 2)
      .sort((a, b) => b.price - a.price)[0];
    if (nearSupport) {
      const candSL = nearSupport.price - atr * 0.2;
      if (candSL < sl) { sl = candSL; slSource = `S/R support ${nearSupport.price.toFixed(digits)}`; }
    }

  } else {
    // SELL: SL は エントリーより上
    const swingRef = lastSwingLH ?? lastSwingHH;

    if (swingRef && swingRef > entry) {
      sl       = swingRef + atr * 0.3;
      slSource = `LH swing (${swingRef.toFixed(digits)}) + ATR×0.3`;
    } else {
      sl       = entry + atr * 1.5;
      slSource = "ATR×1.5";
    }

    const nearResistance = srLevels
      .filter(l => l.type === "resistance" && l.price > entry && l.price < entry + atrH4 * 2)
      .sort((a, b) => a.price - b.price)[0];
    if (nearResistance) {
      const candSL = nearResistance.price + atr * 0.2;
      if (candSL > sl) { sl = candSL; slSource = `S/R resistance ${nearResistance.price.toFixed(digits)}`; }
    }
  }

  // SL が entry に近すぎる場合は ATR × 1.0 を保証
  const minSlDist = atr * 1.0;
  if (direction === "BUY"  && entry - sl < minSlDist) { sl = entry - minSlDist; slSource += " (ATR floor)"; }
  if (direction === "SELL" && sl - entry < minSlDist) { sl = entry + minSlDist; slSource += " (ATR floor)"; }

  // ── TP 計算 ──────────────────────────────────────────────────
  // 優先度: ① 次の S/R → ② スイング構造 → ③ SL 距離 × 1.5
  let tp:       number;
  let tpSource: string;
  const slDist  = Math.abs(entry - sl);

  if (direction === "BUY") {
    const nextRes = srLevels
      .filter(l => l.type === "resistance" && l.price > entry + slDist * 0.5)
      .sort((a, b) => a.price - b.price)[0];

    if (nextRes && nextRes.price > entry + slDist) {
      tp       = nextRes.price - atr * 0.1;
      tpSource = `S/R resistance ${nextRes.price.toFixed(digits)}`;
    } else if (lastSwingHH && lastSwingHH > entry + slDist) {
      tp       = lastSwingHH - atr * 0.1;
      tpSource = `HH swing ${lastSwingHH.toFixed(digits)}`;
    } else {
      tp       = entry + slDist * 1.5;
      tpSource = "SL×1.5";
    }
  } else {
    const nextSup = srLevels
      .filter(l => l.type === "support" && l.price < entry - slDist * 0.5)
      .sort((a, b) => b.price - a.price)[0];

    if (nextSup && nextSup.price < entry - slDist) {
      tp       = nextSup.price + atr * 0.1;
      tpSource = `S/R support ${nextSup.price.toFixed(digits)}`;
    } else if (lastSwingLL && lastSwingLL < entry - slDist) {
      tp       = lastSwingLL + atr * 0.1;
      tpSource = `LL swing ${lastSwingLL.toFixed(digits)}`;
    } else {
      tp       = entry - slDist * 1.5;
      tpSource = "SL×1.5";
    }
  }

  // Spread 調整（BUY entry に spread 加算）
  void spreadPt; // currently not modifying entry here; EA handles spread

  const slPips = Math.abs(entry - sl) / pt * 10;
  const tpPips = Math.abs(tp - entry) / pt * 10;
  const rr     = slPips > 0 ? tpPips / slPips : 0;

  return {
    entry, sl, tp,
    slPips: Math.round(slPips * 10) / 10,
    tpPips: Math.round(tpPips * 10) / 10,
    rr:     Math.round(rr * 100) / 100,
    slSource, tpSource,
  };
}

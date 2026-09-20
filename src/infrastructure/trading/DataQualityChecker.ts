// =================================================================
// DataQualityChecker — データ品質スコアリング
//
// 各シンボルのデータ完全性を0-100でスコアリングする。
// スコアが閾値未満のシンボルは AI 分析対象から除外される。
//
// スコア基準:
//   100 = 完全・新鮮なデータ（H4/H1/M15/M5/M1 + 指標 + Tick）
//   80  = 軽微な欠損（M1 なし、または指標が古い）
//   60  = 部分データ（指標なし、価格のみ）
//   <60 = 不十分（AI 分析禁止）
// =================================================================

import type { MarketSnapshot, TFIndicatorSnapshot } from "@/domain/trading/MarketSnapshot";

export type DataQualityGrade = "COMPLETE" | "PARTIAL" | "PRICE_ONLY" | "UNAVAILABLE";

export interface DataQualityResult {
  score:            number;           // 0-100
  grade:            DataQualityGrade;
  tradeable:        boolean;          // score >= 70
  issues:           string[];         // 問題点リスト
  barCounts:        Record<string, number>;
  indicatorAgesSec: Record<string, number>;
  hasTick:          boolean;
  hasH4:            boolean;
  hasH1:            boolean;
  hasM15:           boolean;
  hasM5:            boolean;
  hasM1:            boolean;
  hasBBValid:       boolean;
  hasADXValid:      boolean;
  hasMACDValid:     boolean;
}

const MIN_BARS: Record<string, number> = {
  H4: 50,    // Dow Theory + S/R に必要
  H1: 30,    // マルチTF に必要
  M15: 20,   // スキャルピングコンテキスト
  M5:  20,
  M1:  10,
};

const MAX_INDICATOR_AGE_SEC = 120;  // 2分以上古い指標は警告

export function checkDataQuality(snap: MarketSnapshot): DataQualityResult {
  const issues: string[] = [];
  let score = 100;

  // ── Tick / Price ──────────────────────────────────────────────
  const hasTick = snap.bid > 0;
  if (!hasTick) {
    return {
      score: 0, grade: "UNAVAILABLE", tradeable: false,
      issues: ["No price data"],
      barCounts: {}, indicatorAgesSec: {},
      hasTick: false, hasH4: false, hasH1: false, hasM15: false, hasM5: false, hasM1: false,
      hasBBValid: false, hasADXValid: false, hasMACDValid: false,
    };
  }

  // ── Indicators ────────────────────────────────────────────────
  const ind = snap.indicators;
  const hasH4  = !!ind.H4;
  const hasH1  = !!ind.H1;
  const hasM15 = !!ind.M15;
  const hasM5  = !!ind.M5;
  const hasM1  = !!ind.M1;

  // 指標なし
  if (!hasH4) { score -= 30; issues.push("No H4 indicators (EA not attached)"); }
  if (!hasH1) { score -= 15; issues.push("No H1 indicators"); }
  if (!hasM15){ score -= 10; issues.push("No M15 indicators"); }
  if (!hasM5) { score -= 5;  issues.push("No M5 indicators"); }

  // 指標鮮度チェック
  const indicatorAgesSec: Record<string, number> = {};
  for (const [tf, v] of Object.entries(ind) as [string, TFIndicatorSnapshot][]) {
    const age = v.freshness.ageMs / 1000;
    indicatorAgesSec[tf] = Math.round(age);
    if (age > MAX_INDICATOR_AGE_SEC) {
      score -= 5;
      issues.push(`${tf} indicators stale (${Math.round(age)}s)`);
    }
    if (v.freshness.stale) {
      score -= 3;
    }
  }

  // ── BB 有効性 ─────────────────────────────────────────────────
  const hasBBValid = hasH4 && (ind.H4!.bbLower > 0);
  if (hasH4 && !hasBBValid) {
    score -= 8;
    issues.push("BB_lower=0 on H4 (EA multi-buffer bug — recompile EA with fix)");
  }

  // ── ADX DI+/DI- 有効性 ────────────────────────────────────────
  const hasADXValid = hasH4 && (ind.H4!.diPlus > 0 || ind.H4!.diMinus > 0);
  if (hasH4 && !hasADXValid) {
    score -= 5;
    issues.push("DI+/DI-=0 on H4 (EA multi-buffer bug)");
  }

  // ── MACD シグナル有効性 ───────────────────────────────────────
  const hasMACDValid = hasH4 && (ind.H4!.macdSignal !== 0 || ind.H4!.macd === 0);
  if (hasH4 && !hasMACDValid) {
    score -= 5;
    issues.push("MACD_signal=0 on H4 (EA multi-buffer bug)");
  }

  // ── S/R 有効性 ─────────────────────────────────────────────────
  if (snap.srLevels.length === 0 && hasH4) {
    score -= 5;
    issues.push("No S/R levels (insufficient H4 bar history)");
  }

  // ── Spread チェック ───────────────────────────────────────────
  if (snap.spread > 10) {
    score -= 10;
    issues.push(`Very high spread ${snap.spread.toFixed(1)}p`);
  } else if (snap.spread > 5) {
    score -= 5;
    issues.push(`High spread ${snap.spread.toFixed(1)}p`);
  }

  // ── 最終スコア計算 ────────────────────────────────────────────
  const finalScore = Math.max(0, Math.min(100, score));

  const grade: DataQualityGrade =
    finalScore >= 75 ? "COMPLETE" :
    finalScore >= 50 ? "PARTIAL" :
    hasTick         ? "PRICE_ONLY" : "UNAVAILABLE";

  const tradeable = finalScore >= 70 && hasH4 && hasTick;

  return {
    score:            finalScore,
    grade,
    tradeable,
    issues,
    barCounts:        {},  // populated by caller if available
    indicatorAgesSec,
    hasTick,
    hasH4, hasH1, hasM15, hasM5, hasM1,
    hasBBValid,
    hasADXValid,
    hasMACDValid,
  };
}

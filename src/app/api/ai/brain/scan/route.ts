// =================================================================
// POST /api/ai/brain/scan
// AVL AI Opportunity Scanner
//
// MT5 Market Watch の全シンボルをスキャンし、
// トレードチャンスをランキングして返す。
//
// 注意:
//   - 実際の注文は一切行わない (ENABLE_LIVE_TRADING=false 厳守)
//   - インジケーターデータがないシンボルは INSUFFICIENT としてスキップ
//   - スキャン結果はランキング形式で返す
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { buildMarketSnapshot }       from "@/infrastructure/trading/MarketSnapshotBuilder";
import type { MarketSnapshot }        from "@/domain/trading/MarketSnapshot";

export const runtime = "nodejs";

// スキャン可能シンボル — 実際のMT5 Market Watchに存在するシンボルのみ
// 追加するにはEAをそのチャートにアタッチしてインジケーターを送信する必要がある
const SCAN_CANDIDATES = [
  "EURUSD","USDJPY","GBPUSD","AUDUSD","USDCAD","USDCHF",
  "EURJPY","GBPJPY","AUDJPY","NZDUSD","CADJPY","CHFJPY",
  "GOLD","SILVER","OILCash","XAUUSD",
  "US30Cash","US100Cash","US500Cash","JP225Cash",
];

export interface ScanOpportunity {
  rank:            number;
  symbol:          string;
  direction:       "BUY" | "SELL" | "WAIT";
  confidence:      number;
  setup_quality:   "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";
  entry:           number | null;
  sl:              number | null;
  tp:              number | null;
  rr:              number | null;
  spread:          number;
  market_structure:string;
  multi_tf_align:  string;
  dow_trend:       string;
  reason:          string;
  data_source:     string;
  indicator_age_sec: number;
  skipped:         boolean;
  skip_reason?:    string;
}

export interface ScanResult {
  timestamp:     number;
  scanned:       number;
  opportunities: ScanOpportunity[];
  skipped:       ScanOpportunity[];
  best:          ScanOpportunity | null;
  summary:       string;
  note:          string;
}

function scoreOpportunity(snap: MarketSnapshot): {
  score: number;
  quality: ScanOpportunity["setup_quality"];
  direction: "BUY" | "SELL" | "WAIT";
} {
  if (snap.overallSource === "UNAVAILABLE" || snap.bid === 0) {
    return { score: 0, quality: "INSUFFICIENT", direction: "WAIT" };
  }

  const hasIndicators = Object.keys(snap.indicators).length > 0;
  if (!hasIndicators) {
    return { score: 10, quality: "INSUFFICIENT", direction: "WAIT" };
  }

  let score = 0;

  // 1. Dow Theory alignment (30pts)
  const dow = snap.dowTheory;
  if (dow.trend === "UPTREND")   score += 30;
  else if (dow.trend === "DOWNTREND") score -= 30;

  // 2. Multi-TF alignment (25pts)
  const mt = snap.multiTF;
  const alignRatio = mt.totalCount > 0 ? mt.alignedCount / mt.totalCount : 0;
  if (mt.direction === "BUY")  score += Math.round(25 * alignRatio);
  else if (mt.direction === "SELL") score -= Math.round(25 * alignRatio);

  // 3. Spread penalty
  if (snap.spread > 5) score -= 20;
  else if (snap.spread > 3) score -= 10;

  // 4. News risk penalty
  if (snap.newsRisk === "HIGH")   score -= 25;
  else if (snap.newsRisk === "MEDIUM") score -= 10;

  // 5. Indicator freshness penalty
  if (snap.indicatorFreshnessSec > 120) score -= 10;

  // 6. Candle patterns bonus
  const bullish = snap.candlePatterns.filter(p => p.direction === "bullish").length;
  const bearish  = snap.candlePatterns.filter(p => p.direction === "bearish").length;
  if (score > 0 && bullish > 0) score += 5 * bullish;
  if (score < 0 && bearish > 0) score -= 5 * bearish;

  // 7. SR proximity bonus
  const h4 = snap.indicators.H4;
  if (h4) {
    const atr = h4.atr;
    const distToSup = Math.abs(snap.bid - snap.nearestSupport);
    const distToRes = Math.abs(snap.nearestResistance - snap.bid);
    if (distToSup < atr * 0.5) score += 10;   // near support → BUY bonus
    if (distToRes < atr * 0.5) score -= 10;   // near resistance → SELL bonus
  }

  const finalScore = Math.max(-100, Math.min(100, score));
  const absscore   = Math.abs(finalScore);
  const direction: "BUY" | "SELL" | "WAIT" =
    finalScore > 20 ? "BUY" : finalScore < -20 ? "SELL" : "WAIT";

  const quality: ScanOpportunity["setup_quality"] =
    absscore >= 60 ? "STRONG" :
    absscore >= 35 ? "MODERATE" :
    absscore >= 15 ? "WEAK" : "INSUFFICIENT";

  return { score: absscore, quality, direction };
}

export async function POST(req: NextRequest) {
  try {
    const { symbols, maxResults = 10 } =
      await req.json().catch(() => ({})) as { symbols?: string[]; maxResults?: number };

    const targetSymbols = symbols ?? SCAN_CANDIDATES;
    const scanTs = Date.now();

    // Parallel snapshot fetch (limit concurrency to avoid timeout)
    const BATCH = 5;
    const allSnaps: { symbol: string; snap: MarketSnapshot | null }[] = [];

    for (let i = 0; i < targetSymbols.length; i += BATCH) {
      const batch = targetSymbols.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async sym => {
          const snap = await buildMarketSnapshot(sym);
          return { symbol: sym, snap };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") allSnaps.push(r.value);
        else allSnaps.push({ symbol: batch[results.indexOf(r as PromiseSettledResult<{symbol:string;snap:MarketSnapshot}>)], snap: null });
      }
    }

    const opportunities: ScanOpportunity[] = [];
    const skipped:       ScanOpportunity[] = [];

    for (const { symbol, snap } of allSnaps) {
      if (!snap) {
        skipped.push({
          rank: 0, symbol, direction: "WAIT", confidence: 0,
          setup_quality: "INSUFFICIENT", entry: null, sl: null, tp: null, rr: null,
          spread: 0, market_structure: "", multi_tf_align: "", dow_trend: "",
          reason: "Snapshot fetch failed", data_source: "UNAVAILABLE",
          indicator_age_sec: 0, skipped: true, skip_reason: "fetch failed",
        });
        continue;
      }

      const { score, quality, direction } = scoreOpportunity(snap);

      const h4 = snap.indicators.H4;
      const entry = snap.bid || null;
      let sl: number | null = null;
      let tp: number | null = null;
      let rr: number | null = null;

      // Simple SL/TP estimate from ATR when indicators available
      if (h4 && entry) {
        const atr = h4.atr;
        if (direction === "BUY") {
          sl = Math.round((entry - atr * 1.5) * 100000) / 100000;
          tp = Math.round((entry + atr * 2.5) * 100000) / 100000;
          rr = 2.5 / 1.5;
        } else if (direction === "SELL") {
          sl = Math.round((entry + atr * 1.5) * 100000) / 100000;
          tp = Math.round((entry - atr * 2.5) * 100000) / 100000;
          rr = 2.5 / 1.5;
        }
      }

      const opp: ScanOpportunity = {
        rank: 0, symbol, direction,
        confidence: quality === "INSUFFICIENT" ? 0 : score,
        setup_quality: quality,
        entry, sl, tp, rr: rr ? Math.round(rr * 100) / 100 : null,
        spread: snap.spread,
        market_structure: snap.dowTheory.summary,
        multi_tf_align:   `${snap.multiTF.direction} (${snap.multiTF.alignedCount}/${snap.multiTF.totalCount})`,
        dow_trend:         snap.dowTheory.trend,
        reason: quality === "INSUFFICIENT"
          ? "No indicator data — EA not attached to this chart"
          : `${snap.dowTheory.trend} | ${snap.multiTF.direction} ${snap.multiTF.alignedCount}/${snap.multiTF.totalCount} TF | spread=${snap.spread.toFixed(1)}p`,
        data_source:       snap.overallSource,
        indicator_age_sec: snap.indicatorFreshnessSec,
        skipped: quality === "INSUFFICIENT",
      };

      if (quality === "INSUFFICIENT") {
        opp.skip_reason = "No indicator data";
        skipped.push(opp);
      } else {
        opportunities.push(opp);
      }
    }

    // Sort by confidence desc, then by quality
    const qualityOrder = { STRONG: 3, MODERATE: 2, WEAK: 1, INSUFFICIENT: 0 };
    opportunities.sort((a, b) => {
      if (a.direction === "WAIT" && b.direction !== "WAIT") return 1;
      if (b.direction === "WAIT" && a.direction !== "WAIT") return -1;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return qualityOrder[b.setup_quality] - qualityOrder[a.setup_quality];
    });

    // Assign ranks
    opportunities.forEach((o, i) => { o.rank = i + 1; });

    const actionable = opportunities.filter(o => o.direction !== "WAIT" && o.setup_quality !== "INSUFFICIENT");
    const best = actionable[0] ?? null;

    const topLines = actionable.slice(0, 3)
      .map(o => `${o.rank}. ${o.symbol} ${o.direction} (${o.confidence}%)`)
      .join("  |  ");

    const summary = actionable.length === 0
      ? "No actionable setups found. Market conditions warrant WAIT."
      : `Top opportunities: ${topLines}`;

    return NextResponse.json({
      timestamp:     scanTs,
      scanned:       targetSymbols.length,
      opportunities: opportunities.slice(0, maxResults),
      skipped,
      best,
      summary,
      note: "ENABLE_LIVE_TRADING=false. No orders executed. Scanner is read-only.",
    } satisfies ScanResult, { headers: { "Cache-Control": "no-store" } });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[brain/scan]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

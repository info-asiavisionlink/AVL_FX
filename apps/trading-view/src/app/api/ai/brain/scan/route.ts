// =================================================================
// POST /api/ai/brain/scan — AVL AI Opportunity Scanner v2
//
// MT5 Market Watch の実在シンボルを対象にスキャンし、
// データ品質スコアでフィルタリングしてトレードチャンスをランキングする。
//
// - データ品質スコア < 60 のシンボルは INSUFFICIENT としてスキップ
// - ENABLE_LIVE_TRADING=false 固定 — 注文は一切行わない
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { buildMarketSnapshot }       from "@/infrastructure/trading/MarketSnapshotBuilder";
import type { MarketSnapshot }        from "@/domain/trading/MarketSnapshot";

export const runtime = "nodejs";

// スキャン候補 — 実際のMT5 Market Watchに存在するシンボルを指定
// EAがアタッチされていないシンボルは PRICE_ONLY / INSUFFICIENT 扱い
const DEFAULT_CANDIDATES = [
  "EURUSD","USDJPY","GBPUSD","GOLD","AUDUSD","USDCAD","USDCHF",
  "EURJPY","GBPJPY","AUDJPY","NZDUSD","CADJPY","SILVER",
  "US30Cash","US100Cash","JP225Cash",
];

export interface ScanOpportunity {
  rank:            number;
  symbol:          string;
  direction:       "BUY" | "SELL" | "WAIT";
  confidence:      number;
  dataQuality:     number;
  dataGrade:       string;
  setup_quality:   "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";
  entry:           number | null;
  sl:              number | null;
  tp:              number | null;
  rr:              number | null;
  sl_pips:         number | null;
  tp_pips:         number | null;
  spread:          number;
  market_structure:string;
  multi_tf_align:  string;
  dow_trend:       string;
  oscillator:      string;
  volatility:      string;
  fundamental_risk:string;
  news_risk:       string;
  correlation:     string;
  reason:          string;
  priority:        "HIGH" | "MEDIUM" | "LOW" | "SKIP";
  data_source:     string;
  indicator_age_sec: number;
  bb_valid:        boolean;
  skipped:         boolean;
  skip_reason?:    string;
  issues:          string[];
}

export interface ScanResult {
  timestamp:      number;
  scanned:        number;
  opportunities:  ScanOpportunity[];
  skipped:        ScanOpportunity[];
  best:           ScanOpportunity | null;
  ranking_table:  { rank: number; symbol: string; direction: string; confidence: number; data_quality: number; status: string }[];
  summary:        string;
  note:           string;
}

function pip(digits: number): number {
  return digits >= 4 ? 0.0001 : 0.01;
}

function scoreOpportunity(snap: MarketSnapshot): {
  score:     number;
  direction: "BUY" | "SELL" | "WAIT";
  quality:   ScanOpportunity["setup_quality"];
  osc:       string;
  vol:       string;
  corrStr:   string;
} {
  if (!snap.bid || snap.dataQualityScore < 60) {
    return { score: 0, direction: "WAIT", quality: "INSUFFICIENT", osc: "N/A", vol: "N/A", corrStr: "N/A" };
  }

  let score = 0;

  // 1. Dow Theory (30pts) — most important
  const dow = snap.dowTheory;
  if (dow.trend === "UPTREND")      score += 30;
  else if (dow.trend === "DOWNTREND") score -= 30;

  // 2. Multi-TF alignment (25pts)
  const mt = snap.multiTF;
  const alignRatio = mt.totalCount > 0 ? mt.alignedCount / mt.totalCount : 0;
  if (mt.direction === "BUY")  score += Math.round(25 * alignRatio);
  else if (mt.direction === "SELL") score -= Math.round(25 * alignRatio);

  // 3. H4 oscillator state (15pts)
  const h4 = snap.indicators.H4;
  let oscStr = "N/A";
  if (h4) {
    const oscScore =
      (h4.rsi > 50 ? 5 : h4.rsi < 50 ? -5 : 0) +
      (h4.macdHist > 0 ? 5 : h4.macdHist < 0 ? -5 : 0) +
      (h4.diPlus > h4.diMinus ? 5 : h4.diPlus < h4.diMinus ? -5 : 0);
    score += oscScore;
    oscStr = `RSI=${h4.rsi.toFixed(0)} MACD_hist=${h4.macdHist > 0 ? "+" : "-"} ADX=${h4.adx.toFixed(0)}`;
  }

  // 4. Spread penalty (-5 to -20)
  if (snap.spread > 10)      score -= 20;
  else if (snap.spread > 5)  score -= 10;
  else if (snap.spread > 3)  score -= 5;

  // 5. News risk penalty
  if (snap.newsRisk === "HIGH")   score -= 25;
  else if (snap.newsRisk === "MEDIUM") score -= 10;

  // 6. Candle patterns bonus
  const bullish = snap.candlePatterns.filter(p => p.direction === "bullish").length;
  const bearish  = snap.candlePatterns.filter(p => p.direction === "bearish").length;
  if (score > 0 && bullish > 0) score += Math.min(bullish * 5, 10);
  if (score < 0 && bearish > 0) score -= Math.min(bearish * 5, 10);

  // 7. S/R proximity (+5)
  if (h4 && snap.bid > 0) {
    const atr = h4.atr;
    if (atr > 0) {
      const distToSup = Math.abs(snap.bid - snap.nearestSupport);
      const distToRes = Math.abs(snap.nearestResistance - snap.bid);
      if (distToSup < atr * 0.5 && score > 0) score += 5;
      if (distToRes < atr * 0.5 && score < 0) score -= 5;
    }
  }

  // 8. Correlation confirmation (+8)
  const confirming    = snap.correlatedMarkets.filter(c => c.confirms && c.bid > 0).length;
  const contradicting = snap.correlatedMarkets.filter(c => !c.confirms && c.bid > 0).length;
  if (confirming > contradicting) score += 8;
  else if (contradicting > confirming) score -= 5;
  const corrStr = snap.correlatedMarkets.filter(c=>c.bid>0).length > 0
    ? `${confirming}/${snap.correlatedMarkets.filter(c=>c.bid>0).length} confirming`
    : "INSUFFICIENT_DATA";

  // 9. Data quality bonus (up to +10 for complete data)
  score += Math.round((snap.dataQualityScore - 60) / 4);

  // Volatility
  let volStr = "N/A";
  if (h4) {
    volStr = h4.adx > 30 ? "HIGH" : h4.adx > 20 ? "MODERATE" : "LOW";
  }

  const finalScore = Math.max(-100, Math.min(100, score));
  const absScore   = Math.abs(finalScore);

  const direction: "BUY" | "SELL" | "WAIT" =
    finalScore > 20 ? "BUY" : finalScore < -20 ? "SELL" : "WAIT";

  const quality: ScanOpportunity["setup_quality"] =
    absScore >= 60 && direction !== "WAIT" ? "STRONG" :
    absScore >= 35 && direction !== "WAIT" ? "MODERATE" :
    absScore >= 15 && direction !== "WAIT" ? "WEAK" : "INSUFFICIENT";

  return { score: absScore, direction, quality, osc: oscStr, vol: volStr, corrStr };
}

export async function POST(req: NextRequest) {
  try {
    const { symbols, maxResults = 20, minDataQuality = 60 } =
      await req.json().catch(() => ({})) as {
        symbols?: string[];
        maxResults?: number;
        minDataQuality?: number;
      };

    const targets = symbols ?? DEFAULT_CANDIDATES;
    const scanTs  = Date.now();

    // Parallel fetch in batches of 5 to avoid timeout
    const BATCH = 5;
    const snaps: { symbol: string; snap: MarketSnapshot | null; error?: string }[] = [];

    for (let i = 0; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async sym => ({ symbol: sym, snap: await buildMarketSnapshot(sym) }))
      );
      for (const r of results) {
        if (r.status === "fulfilled") snaps.push(r.value);
        else snaps.push({ symbol: "UNKNOWN", snap: null, error: r.reason as string });
      }
    }

    const opportunities: ScanOpportunity[] = [];
    const skipped:       ScanOpportunity[] = [];

    for (const { symbol, snap, error } of snaps) {
      if (!snap) {
        skipped.push({
          rank: 0, symbol, direction: "WAIT", confidence: 0,
          dataQuality: 0, dataGrade: "UNAVAILABLE",
          setup_quality: "INSUFFICIENT",
          entry: null, sl: null, tp: null, rr: null, sl_pips: null, tp_pips: null,
          spread: 0, market_structure: "", multi_tf_align: "", dow_trend: "",
          oscillator: "N/A", volatility: "N/A", fundamental_risk: "UNKNOWN",
          news_risk: "UNKNOWN", correlation: "N/A",
          reason: error ? `Error: ${error}` : "Snapshot failed",
          priority: "SKIP", data_source: "UNAVAILABLE",
          indicator_age_sec: 0, bb_valid: false, skipped: true,
          skip_reason: "fetch failed", issues: [],
        });
        continue;
      }

      const dq = snap.dataQualityScore;

      if (dq < minDataQuality || !snap.bid) {
        const opp: ScanOpportunity = {
          rank: 0, symbol: snap.symbol, direction: "WAIT", confidence: 0,
          dataQuality: dq, dataGrade: snap.dataQualityGrade,
          setup_quality: "INSUFFICIENT",
          entry: snap.bid || null, sl: null, tp: null, rr: null, sl_pips: null, tp_pips: null,
          spread: snap.spread,
          market_structure: snap.dowTheory.summary,
          multi_tf_align:   `${snap.multiTF.direction} (${snap.multiTF.alignedCount}/${snap.multiTF.totalCount})`,
          dow_trend:         snap.dowTheory.trend,
          oscillator:        "N/A",
          volatility:        "N/A",
          fundamental_risk:  snap.economicEvents.length > 0 ? "EVENTS_PENDING" : "CLEAR",
          news_risk:         snap.newsRisk,
          correlation:       "N/A",
          reason:            snap.dataQualityIssues[0] ?? "Insufficient data",
          priority:          "SKIP",
          data_source:       snap.overallSource,
          indicator_age_sec: snap.indicatorFreshnessSec,
          bb_valid:          false,
          skipped:           true,
          skip_reason:       `Data quality ${dq}/100 < threshold ${minDataQuality}`,
          issues:            snap.dataQualityIssues,
        };
        skipped.push(opp);
        continue;
      }

      const { score, direction, quality, osc, vol, corrStr } = scoreOpportunity(snap);

      // SL/TP estimate from H4 ATR
      const h4   = snap.indicators.H4;
      const pt   = pip(snap.digits);
      let entry:  number | null = snap.bid || null;
      let sl:     number | null = null;
      let tp:     number | null = null;
      let rr:     number | null = null;
      let slPips: number | null = null;
      let tpPips: number | null = null;

      if (h4 && entry && direction !== "WAIT") {
        const atr = h4.atr;
        if (direction === "BUY") {
          sl = Math.round((entry - atr * 1.5) * 1e5) / 1e5;
          tp = Math.round((entry + atr * 2.5) * 1e5) / 1e5;
        } else {
          sl = Math.round((entry + atr * 1.5) * 1e5) / 1e5;
          tp = Math.round((entry - atr * 2.5) * 1e5) / 1e5;
        }
        slPips = Math.round(atr * 1.5 / pt * 10);
        tpPips = Math.round(atr * 2.5 / pt * 10);
        rr = slPips > 0 ? Math.round(tpPips / slPips * 100) / 100 : null;
      }

      const priority: ScanOpportunity["priority"] =
        quality === "STRONG"   ? "HIGH" :
        quality === "MODERATE" ? "MEDIUM" :
        quality === "WEAK"     ? "LOW" : "SKIP";

      const opp: ScanOpportunity = {
        rank: 0, symbol: snap.symbol, direction,
        confidence: score,
        dataQuality: dq, dataGrade: snap.dataQualityGrade,
        setup_quality: quality,
        entry, sl, tp, rr,
        sl_pips: slPips, tp_pips: tpPips,
        spread: snap.spread,
        market_structure: snap.dowTheory.summary,
        multi_tf_align:   `${snap.multiTF.direction} (${snap.multiTF.alignedCount}/${snap.multiTF.totalCount})`,
        dow_trend:         snap.dowTheory.trend,
        oscillator:        osc,
        volatility:        vol,
        fundamental_risk:  snap.economicEvents.length > 0 ? "EVENTS_PENDING" : "CLEAR",
        news_risk:         snap.newsRisk,
        correlation:       corrStr,
        reason:            `${snap.dowTheory.trend} | MultiTF=${snap.multiTF.direction}(${snap.multiTF.alignedCount}/${snap.multiTF.totalCount}) | spread=${snap.spread.toFixed(1)}p`,
        priority,
        data_source:       snap.overallSource,
        indicator_age_sec: snap.indicatorFreshnessSec,
        bb_valid:          !!(snap.indicators.H4?.bbLower && snap.indicators.H4.bbLower > 0),
        skipped:           false,
        issues:            snap.dataQualityIssues,
      };
      opportunities.push(opp);
    }

    // Sort: actionable first (BUY/SELL), then by confidence desc, then by data quality
    const qualityOrder = { STRONG: 4, MODERATE: 3, WEAK: 2, INSUFFICIENT: 1 };
    opportunities.sort((a, b) => {
      if (a.direction === "WAIT" && b.direction !== "WAIT") return 1;
      if (b.direction === "WAIT" && a.direction !== "WAIT") return -1;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (qualityOrder[b.setup_quality] !== qualityOrder[a.setup_quality])
        return qualityOrder[b.setup_quality] - qualityOrder[a.setup_quality];
      return b.dataQuality - a.dataQuality;
    });

    opportunities.forEach((o, i) => { o.rank = i + 1; });

    const actionable = opportunities.filter(o => o.direction !== "WAIT" && o.setup_quality !== "INSUFFICIENT");
    const best       = actionable[0] ?? null;

    // Ranking table (all scanned symbols)
    const allOpps = [...opportunities, ...skipped];
    const rankingTable = allOpps
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .map((o, i) => ({
        rank:         i + 1,
        symbol:       o.symbol,
        direction:    o.direction,
        confidence:   o.confidence,
        data_quality: o.dataQuality,
        status:       o.skipped
          ? `NO DATA (${o.dataQuality}/100)`
          : o.direction === "WAIT"
          ? `WAIT (${o.dataQuality}/100)`
          : `${o.direction} (${o.dataQuality}/100)`,
      }));

    const topLines = actionable.slice(0, 3)
      .map(o => `${o.rank}. ${o.symbol} ${o.direction} conf=${o.confidence} DQ=${o.dataQuality}`)
      .join("  |  ");

    const summary = actionable.length === 0
      ? `No actionable setups. ${skipped.length} symbols skipped (insufficient data).`
      : `Top: ${topLines}`;

    return NextResponse.json({
      timestamp:     scanTs,
      scanned:       targets.length,
      opportunities: opportunities.slice(0, maxResults),
      skipped,
      best,
      ranking_table: rankingTable.slice(0, maxResults),
      summary,
      note: "ENABLE_LIVE_TRADING=false — read-only scanner. No orders executed.",
    } satisfies ScanResult, { headers: { "Cache-Control": "no-store" } });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[brain/scan]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

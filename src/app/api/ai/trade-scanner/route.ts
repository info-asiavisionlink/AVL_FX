import { NextRequest, NextResponse } from "next/server";
import type { FullAnalysisResult } from "@/infrastructure/analysis/types";

export const runtime = "nodejs";

const DEFAULT_PAIRS = [
  "EURUSD","USDJPY","GBPUSD","AUDUSD","USDCAD","USDCHF",
  "EURJPY","GBPJPY","GOLD","XAUUSD",
];

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

async function analyzePair(symbol: string): Promise<FullAnalysisResult | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/ai/analysis/full`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ symbol }),
      signal:  AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<FullAnalysisResult>;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  const { pairs, minConfidence = 68 } =
    await req.json().catch(() => ({})) as { pairs?: string[]; minConfidence?: number };

  const targetPairs = pairs ?? DEFAULT_PAIRS;

  // Run all analyses in parallel (results are cached for 5 min in analysis route)
  const results = await Promise.all(targetPairs.map(p => analyzePair(p)));

  const opportunities = results
    .filter((r): r is FullAnalysisResult =>
      r !== null && r.overall.tradeable && r.overall.confidence >= minConfidence
    )
    .sort((a, b) => b.overall.confidence - a.overall.confidence)
    .slice(0, 5)
    .map(r => ({
      symbol:       r.symbol,
      direction:    r.overall.direction,
      confidence:   r.overall.confidence,
      entry:        r.tradeSetup?.entry,
      sl:           r.tradeSetup?.sl,
      tp1:          r.tradeSetup?.tp1,
      tp2:          r.tradeSetup?.tp2,
      rrRatio1:     r.tradeSetup?.rrRatio1,
      rrRatio2:     r.tradeSetup?.rrRatio2,
      dowTrend:     r.dowTheory.trend,
      dowScore:     r.dowTheory.score,
      multiTF:      r.multiTF.direction,
      srScore:      r.supportResistance.score,
      patterns:     r.candlestickPatterns.patterns.map(p => p.name),
      chartPatterns: r.chartPatterns.patterns.map(p => p.name),
      session:      r.marketEnvironment.details?.session ?? [],
      synthesis:    r.aiSynthesis,
    }));

  // No tradeable setups
  if (opportunities.length === 0) {
    return NextResponse.json({
      opportunities: [],
      summary: "現在トレード条件を満たすセットアップなし。信頼度70%以上のシグナルが出るまで待機推奨。",
      scannedPairs: targetPairs.length,
      timestamp: Date.now(),
    });
  }

  const best = opportunities[0];
  const summary = `最高シグナル: ${best.symbol} ${best.direction} (信頼度${best.confidence}%) ` +
    `エントリー${best.entry?.toFixed(best.entry > 100 ? 2 : 5)} ` +
    `SL${best.sl?.toFixed(best.sl > 100 ? 2 : 5)} ` +
    `TP1:${best.tp1?.toFixed(best.tp1 > 100 ? 2 : 5)} RR:${best.rrRatio1}`;

  return NextResponse.json({
    opportunities,
    summary,
    scannedPairs: targetPairs.length,
    timestamp: Date.now(),
  });
}

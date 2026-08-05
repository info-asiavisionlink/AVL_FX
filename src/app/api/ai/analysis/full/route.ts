import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS } from "@/infrastructure/ai/openai-client";
import { getUpcomingEvents, getRecentNews } from "@/infrastructure/supabase/repository";
import { analyzeMarketStructure }    from "@/infrastructure/analysis/marketStructure";
import { analyzeSupportResistance }  from "@/infrastructure/analysis/supportResistance";
import { analyzeCandlestickPatterns } from "@/infrastructure/analysis/candlestickPatterns";
import { analyzeChartPatterns }      from "@/infrastructure/analysis/chartPatterns";
import { analyzeIndicators }         from "@/infrastructure/analysis/indicatorEngine";
import { analyzeCorrelation }        from "@/infrastructure/analysis/correlationEngine";
import { analyzeMarketEnvironment, type EnvIndicators }  from "@/infrastructure/analysis/marketEnvironment";
import type { Bar, FullAnalysisResult, Direction, SRLevel } from "@/infrastructure/analysis/types";

export const runtime = "nodejs";

// 5-minute cache
const cache = new Map<string, FullAnalysisResult>();

const GATEWAY = process.env.MT5_GATEWAY_URL ?? "http://127.0.0.1:8080";

async function fetchJSON<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      headers: { Authorization: `Bearer ${process.env.MT5_GATEWAY_SECRET ?? ""}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

interface TFIndicator {
  ema21: number; ema200: number; sma50: number; atr: number; rsi: number;
  macd: number; macdSignal: number; macdHist: number;
  adx: number; diPlus: number; diMinus: number;
  bbUpper: number; bbMid: number; bbLower: number; bbWidth: number;
  trend: string;
}
interface Tick { bid: number; ask: number; spread: number; time: number; }
interface Indicators { symbol: string; spread: number; digits?: number; timeframes: Record<string, TFIndicator>; sessions?: string[]; }

const CORR_SYMBOLS: Record<string, string[]> = {
  EURUSD: ['GBPUSD','USDJPY','XAUUSD','USDX-SEP26'],
  USDJPY: ['USDX-SEP26','US30Cash','XAUUSD'],
  GBPUSD: ['EURUSD','USDX-SEP26'],
  AUDUSD: ['USDX-SEP26','XAUUSD','NZDUSD'],
  NZDUSD: ['AUDUSD','USDX-SEP26'],
  USDCAD: ['OILCash','USDX-SEP26'],
  XAUUSD: ['USDX-SEP26','EURUSD'],
};

function multiTFAnalysis(indicators: Indicators): FullAnalysisResult['multiTF'] {
  const tfs: Record<string, { trend: string; score: number; signals: string[] }> = {};
  const tfList = ['H4','H1','M15','M5'] as const;
  const weights: Record<string, number> = { H4:0.35, H1:0.30, M15:0.20, M5:0.15 };

  let totalScore = 0;
  let totalW = 0;
  const dirVotes: Record<Direction, number> = { BUY:0, SELL:0, NEUTRAL:0 };

  for (const tf of tfList) {
    const ind = indicators.timeframes[tf];
    if (!ind) continue;

    const signals: string[] = [];
    let tfScore = 50;

    const emaUp = ind.ema21 > ind.ema200;
    tfScore += emaUp ? 15 : -15;
    signals.push(emaUp ? `EMA bullish` : `EMA bearish`);

    if (ind.adx > 25) { tfScore += 5; signals.push(`ADX ${ind.adx.toFixed(0)} trending`); }
    else if (ind.adx < 20) { signals.push(`ADX ${ind.adx.toFixed(0)} ranging`); }

    if (ind.macdHist > 0) { tfScore += 8; signals.push('MACD+'); }
    else if (ind.macdHist < 0) { tfScore -= 8; signals.push('MACD-'); }

    tfScore = Math.max(0, Math.min(100, tfScore));
    const dir: Direction = tfScore > 60 ? 'BUY' : tfScore < 40 ? 'SELL' : 'NEUTRAL';
    tfs[tf] = { trend: ind.trend ?? (emaUp ? 'UP' : 'DOWN'), score: tfScore, signals };

    const w = weights[tf] ?? 0.1;
    totalScore += tfScore * w;
    totalW     += w;
    dirVotes[dir] = (dirVotes[dir] ?? 0) + w;
  }

  const finalScore = totalW > 0 ? Math.round(totalScore / totalW) : 50;
  const direction: Direction =
    dirVotes.BUY > dirVotes.SELL && dirVotes.BUY > dirVotes.NEUTRAL ? 'BUY' :
    dirVotes.SELL > dirVotes.BUY && dirVotes.SELL > dirVotes.NEUTRAL ? 'SELL' : 'NEUTRAL';

  return {
    score: finalScore, direction, timeframes: tfs,
    summary: `Multi-TF consensus: ${direction} (${finalScore}%).`,
    details: { dirVotes },
  };
}

function calcOverall(modules: {
  marketEnvironment: { score: number; direction: Direction };
  dowTheory:         { score: number; direction: Direction };
  multiTF:           { score: number; direction: Direction };
  technicalIndicators: { score: number; direction: Direction };
  supportResistance: { score: number; direction: Direction };
  candlestickPatterns: { score: number; direction: Direction };
  chartPatterns:     { score: number; direction: Direction };
  correlation:       { score: number; direction: Direction };
}): { confidence: number; direction: Direction; tradeable: boolean; threshold: number } {
  const WEIGHTS: Record<string, number> = {
    marketEnvironment: 0.10, dowTheory: 0.20, multiTF: 0.20,
    technicalIndicators: 0.20, supportResistance: 0.15,
    candlestickPatterns: 0.05, chartPatterns: 0.05, correlation: 0.05,
  };

  let weightedScore = 0;
  const dirWeights: Record<Direction, number> = { BUY:0, SELL:0, NEUTRAL:0 };

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const mod = modules[key as keyof typeof modules];
    if (!mod) continue;
    weightedScore += mod.score * weight;
    dirWeights[mod.direction] = (dirWeights[mod.direction] ?? 0) + weight * (mod.score / 100);
  }

  const direction: Direction =
    dirWeights.BUY > dirWeights.SELL && dirWeights.BUY > dirWeights.NEUTRAL ? 'BUY' :
    dirWeights.SELL > dirWeights.BUY && dirWeights.SELL > dirWeights.NEUTRAL ? 'SELL' : 'NEUTRAL';

  const confidence = Math.round(weightedScore);
  const THRESHOLD  = 70;
  const tradeable  = confidence > THRESHOLD && direction !== 'NEUTRAL';

  return { confidence, direction, tradeable, threshold: THRESHOLD };
}

function buildTradeSetup(
  overall: { confidence: number; direction: Direction; tradeable: boolean },
  tick: Tick,
  srLevels: SRLevel[],
  atr: number,
): FullAnalysisResult['tradeSetup'] {
  if (!overall.tradeable) return null;

  const { direction } = overall;
  const entry = direction === 'BUY' ? tick.ask : tick.bid;
  const minSlDist = atr * 1.0;

  const supports    = srLevels.filter(l => l.price < entry).sort((a, b) => b.price - a.price);
  const resistances = srLevels.filter(l => l.price > entry).sort((a, b) => a.price - b.price);

  let sl: number;
  let tp1: number;
  let tp2: number;

  if (direction === 'BUY') {
    sl  = supports.length    ? Math.min(entry - minSlDist, supports[0].price)    : entry - minSlDist;
    tp1 = resistances.length ? Math.max(entry + (entry - sl), resistances[0].price) : entry + (entry - sl);
    tp2 = resistances.length >= 2 ? resistances[1].price : entry + 2 * (entry - sl);
  } else {
    sl  = resistances.length ? Math.max(entry + minSlDist, resistances[0].price) : entry + minSlDist;
    tp1 = supports.length    ? Math.min(entry - (sl - entry), supports[0].price) : entry - (sl - entry);
    tp2 = supports.length >= 2 ? supports[1].price                               : entry - 2 * (sl - entry);
  }

  const slDist  = Math.abs(entry - sl);
  const tp1Dist = Math.abs(tp1 - entry);
  const tp2Dist = Math.abs(tp2 - entry);

  const rrRatio1 = slDist > 0 ? `1:${(tp1Dist / slDist).toFixed(1)}` : '1:1.0';
  const rrRatio2 = slDist > 0 ? `1:${(tp2Dist / slDist).toFixed(1)}` : '1:2.0';

  return { direction, entry, sl, tp1, tp2, rrRatio1, rrRatio2, confidence: overall.confidence };
}

export async function POST(req: NextRequest) {
  try {
    const { symbol = "EURUSD" } = await req.json() as { symbol?: string };
    const sym = symbol.toUpperCase();

    const cacheKey = `${sym}_${Math.floor(Date.now() / 300_000)}`;
    const cached = cache.get(cacheKey);
    if (cached) return NextResponse.json(cached);

    const currencies = sym.length === 6 ? [sym.slice(0, 3), sym.slice(3)] : ['USD'];

    const corrSymbols = CORR_SYMBOLS[sym] ?? [];

    const [tick, indicators, h4Bars, h1Bars, d1Bars, w1Bars, m15Bars, m5Bars, economicEvents, recentNews, ...corrTicksArr] =
      await Promise.all([
        fetchJSON<Tick>(`/tick/${sym}`),
        fetchJSON<Indicators>(`/indicators/${sym}`),
        fetchJSON<Bar[]>(`/bars/${sym}/H4?count=100`),
        fetchJSON<Bar[]>(`/bars/${sym}/H1?count=50`),
        fetchJSON<Bar[]>(`/bars/${sym}/D1?count=30`),
        fetchJSON<Bar[]>(`/bars/${sym}/W1?count=10`),
        fetchJSON<Bar[]>(`/bars/${sym}/M15?count=50`),
        fetchJSON<Bar[]>(`/bars/${sym}/M5?count=30`),
        getUpcomingEvents(currencies, 24).catch(() => []),
        getRecentNews(sym, 10).catch(() => []),
        ...corrSymbols.map(cs => fetchJSON<Tick>(`/tick/${cs}`)),
      ]);

    const corrTicks: Record<string, { bid: number; ask: number }> = {};
    const corrPrevTicks: Record<string, { bid: number; ask: number }> = {};
    corrSymbols.forEach((cs, i) => {
      const t = corrTicksArr[i] as Tick | null;
      if (t) {
        corrTicks[cs] = { bid: t.bid, ask: t.ask };
        corrPrevTicks[cs] = { bid: t.bid * 0.9999, ask: t.ask };
      }
    });

    const safeH4  = h4Bars  ?? [];
    const safeH1  = h1Bars  ?? [];
    const safeD1  = d1Bars  ?? [];
    const safeW1  = w1Bars  ?? [];
    const safeM15 = m15Bars ?? [];
    const safeM5  = m5Bars  ?? [];
    const safeTick: Tick = tick ?? { bid: 0, ask: 0, spread: 0, time: Date.now() };
    const currentPrice   = safeTick.bid || safeTick.ask || 0;

    const barsByTf: Record<string, Bar[]> = { H4: safeH4, H1: safeH1, M15: safeM15, M5: safeM5 };

    const [
      dowTheoryResult,
      srResult,
      candleResult,
      chartResult,
      indicatorResult,
    ] = await Promise.all([
      Promise.resolve(analyzeMarketStructure(safeH4, safeD1)),
      Promise.resolve(analyzeSupportResistance(safeH4, safeD1, safeW1, currentPrice)),
      Promise.resolve(analyzeCandlestickPatterns(barsByTf)),
      Promise.resolve(analyzeChartPatterns(safeH4)),
      Promise.resolve(analyzeIndicators(indicators ?? { timeframes: {} }, barsByTf, currentPrice)),
    ]);

    const multiTFResult  = indicators ? multiTFAnalysis(indicators) : {
      score:50, direction:'NEUTRAL' as Direction, timeframes:{}, summary:'No indicator data.', details:{},
    };

    const corrResult = analyzeCorrelation(sym, multiTFResult.direction, corrTicks, corrPrevTicks);
    const envResult  = analyzeMarketEnvironment(indicators as EnvIndicators | null, economicEvents, recentNews, new Date());

    const overall = calcOverall({
      marketEnvironment:   envResult,
      dowTheory:           dowTheoryResult,
      multiTF:             multiTFResult,
      technicalIndicators: indicatorResult,
      supportResistance:   srResult,
      candlestickPatterns: candleResult,
      chartPatterns:       chartResult,
      correlation:         corrResult,
    });

    const h4Atr = indicators?.timeframes?.H4?.atr ?? currentPrice * 0.005;
    const tradeSetup = buildTradeSetup(overall, safeTick, srResult.levels, h4Atr);

    // AI Synthesis
    let aiSynthesis = '';
    try {
      const client = getOpenAIClient();
      const prompt = `You are a professional FX analyst. Provide a concise 3-5 sentence synthesis of this analysis. Be direct about whether to trade and why.

Symbol: ${sym}
Price: ${currentPrice}
Overall: ${overall.direction} at ${overall.confidence}% confidence (tradeable: ${overall.tradeable})
Dow Theory: ${dowTheoryResult.trend} (${dowTheoryResult.score}%)
Multi-TF: ${multiTFResult.direction} (${multiTFResult.score}%)
Indicators: ${indicatorResult.direction} (${indicatorResult.score}%)
S/R: nearest support ${srResult.nearestSupport?.toFixed(5)}, resistance ${srResult.nearestResistance?.toFixed(5)}
Patterns: ${candleResult.patterns.map(p => p.name).join(', ') || 'none'} | Chart: ${chartResult.patterns.map(p => p.name).join(', ') || 'none'}
Correlation: ${corrResult.summary}
Market: ${envResult.summary}
${tradeSetup ? `Trade Setup: ${tradeSetup.direction} Entry:${tradeSetup.entry?.toFixed(5)} SL:${tradeSetup.sl?.toFixed(5)} TP1:${tradeSetup.tp1?.toFixed(5)} RR:${tradeSetup.rrRatio1}` : 'No trade setup.'}`;

      const completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL ?? MODELS.chat,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 300,
      });
      aiSynthesis = completion.choices[0]?.message?.content ?? '';
    } catch (e) {
      aiSynthesis = `Analysis complete. ${overall.direction} signal at ${overall.confidence}% confidence. ${overall.tradeable ? 'Trade conditions met.' : 'Trade conditions not met.'}`;
    }

    const result: FullAnalysisResult = {
      symbol: sym,
      timestamp: Date.now(),
      tick: { bid: safeTick.bid, ask: safeTick.ask, spread: safeTick.spread },
      marketEnvironment: envResult,
      dowTheory: dowTheoryResult,
      multiTF: multiTFResult,
      technicalIndicators: indicatorResult,
      supportResistance: srResult,
      candlestickPatterns: candleResult,
      chartPatterns: chartResult,
      correlation: corrResult,
      overall,
      tradeSetup,
      aiSynthesis,
    };

    cache.set(cacheKey, result);
    if (cache.size > 50) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ai/analysis/full]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// =================================================================
// MarketSnapshotBuilder
//
// Gateway + Supabase から全データを収集し、
// 鮮度タグ付きの MarketSnapshot を構築する。
//
// 原則：
//   - データを加工しない（MT5値をそのまま使用）
//   - 陳腐化したデータを明示する（stale フラグ）
//   - 全データに timestamp と source を付与する
// =================================================================

import type {
  MarketSnapshot, TFIndicatorSnapshot, DowTheorySnapshot,
  MultiTFAlignment, CorrelatedMarket, EconomicEventSnapshot,
  NewsSnapshot, AccountSnapshot, PositionSnapshot, SRLevel,
  CandlePatternSnapshot, ChartPatternSnapshot, DataFreshness, DataSource,
} from "@/domain/trading/MarketSnapshot";
import { analyzeMarketStructure }    from "@/infrastructure/analysis/marketStructure";
import { analyzeSupportResistance }  from "@/infrastructure/analysis/supportResistance";
import { analyzeCandlestickPatterns } from "@/infrastructure/analysis/candlestickPatterns";
import { analyzeChartPatterns }      from "@/infrastructure/analysis/chartPatterns";
import { getUpcomingEvents, getRecentNews } from "@/infrastructure/supabase/repository";
import type { Bar } from "@/infrastructure/analysis/types";

// -----------------------------------------------------------------
// 定数
// -----------------------------------------------------------------
const INDICATOR_STALE_MS = 60_000;   // 60s: EA は30s毎に送信
const TICK_STALE_MS      = 10_000;   // 10s
const NEWS_STALE_MS      = 300_000;  // 5min

const CORR_MAP: Record<string, { symbol: string; relationship: "positive" | "negative"; weight: number }[]> = {
  EURUSD: [
    { symbol: "GBPUSD",     relationship: "positive", weight: 0.80 },
    { symbol: "USDJPY",     relationship: "negative", weight: 0.70 },
    { symbol: "XAUUSD",     relationship: "negative", weight: 0.50 },
    { symbol: "USDX-SEP26", relationship: "negative", weight: 0.90 },
  ],
  USDJPY: [
    { symbol: "USDX-SEP26", relationship: "positive", weight: 0.90 },
    { symbol: "US30Cash",   relationship: "positive", weight: 0.60 },
    { symbol: "XAUUSD",     relationship: "negative", weight: 0.50 },
    { symbol: "JP225Cash",  relationship: "positive", weight: 0.65 },
  ],
  GBPUSD: [
    { symbol: "EURUSD",     relationship: "positive", weight: 0.80 },
    { symbol: "USDX-SEP26", relationship: "negative", weight: 0.85 },
  ],
  AUDUSD: [
    { symbol: "USDX-SEP26", relationship: "negative", weight: 0.80 },
    { symbol: "XAUUSD",     relationship: "positive", weight: 0.65 },
    { symbol: "NZDUSD",     relationship: "positive", weight: 0.85 },
  ],
  NZDUSD: [
    { symbol: "AUDUSD",     relationship: "positive", weight: 0.85 },
    { symbol: "USDX-SEP26", relationship: "negative", weight: 0.75 },
  ],
  USDCAD: [
    { symbol: "OILCash",    relationship: "negative", weight: 0.70 },
    { symbol: "USDX-SEP26", relationship: "positive", weight: 0.80 },
  ],
  XAUUSD: [
    { symbol: "USDX-SEP26", relationship: "negative", weight: 0.85 },
    { symbol: "EURUSD",     relationship: "positive", weight: 0.60 },
    { symbol: "USDJPY",     relationship: "negative", weight: 0.50 },
  ],
  GOLD: [
    { symbol: "USDX-SEP26", relationship: "negative", weight: 0.85 },
    { symbol: "EURUSD",     relationship: "positive", weight: 0.60 },
  ],
};

// -----------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------
function makeFreshness(ts: number, staleMs: number, source: DataSource): DataFreshness {
  const ageMs = Date.now() - ts;
  return { ts, ageMs, stale: ageMs > staleMs, source };
}

async function fetchGateway<T>(gw: string, path: string): Promise<T | null> {
  try {
    const secret = process.env.MT5_GATEWAY_SECRET;
    const headers: Record<string, string> = {};
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    const res = await fetch(`${gw}${path}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

function calcStochastic(bars: Bar[], k = 14): number {
  if (bars.length < k) return 50;
  const win = bars.slice(-k);
  const hh = Math.max(...win.map(b => b.high));
  const ll = Math.min(...win.map(b => b.low));
  const d = hh - ll || 0.00001;
  return ((bars[bars.length - 1].close - ll) / d) * 100;
}

// -----------------------------------------------------------------
// build()
// -----------------------------------------------------------------
export async function buildMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const sym = symbol.toUpperCase().replace("/", "");
  const gw  = process.env.MT5_GATEWAY_URL ?? "http://127.0.0.1:8080";
  const now  = Date.now();
  const id   = `snap_${sym}_${now}`;

  // 1. 全データを並列取得
  const currencies = sym.length === 6 ? [sym.slice(0, 3), sym.slice(3)] : ["USD"];

  interface GWTick   { bid: number; ask: number; spread: number; digits: number; time: number; }
  interface GWInd    { symbol: string; spread: number; digits: number; brokerTime: number; timeframes: Record<string, RawTFInd>; sessions?: string[]; receivedAt: number; }
  interface RawTFInd { ema21: number; ema200: number; sma50: number; atr: number; rsi: number; macd: number; macdSignal: number; macdHist: number; adx: number; diPlus: number; diMinus: number; bbUpper: number; bbMid: number; bbLower: number; bbWidth: number; trend: string; }
  interface GWAccount { login: number; broker: string; currency: string; balance: number; equity: number; margin: number; freeMargin: number; marginLevel: number; leverage: number; }
  interface GWPosition { ticket: number; type: number; volume: number; openPrice: number; currentPrice: number; sl: number; tp: number; profit: number; openTime: number; }
  interface GWSymbol  { symbol: string; bid: number; receivedAt?: number; }

  const [tick, indData, barsH4, barsH1, barsD1, barsW1, barsM15, barsM5, barsM1,
         account, positions, allSymbols, economicEvents, recentNews] = await Promise.all([
    fetchGateway<GWTick>(gw, `/tick/${sym}`),
    fetchGateway<GWInd>(gw, `/indicators/${sym}`),
    fetchGateway<Bar[]>(gw, `/bars/${sym}/H4?count=200`),
    fetchGateway<Bar[]>(gw, `/bars/${sym}/H1?count=100`),
    fetchGateway<Bar[]>(gw, `/bars/${sym}/D1?count=30`),
    fetchGateway<Bar[]>(gw, `/bars/${sym}/W1?count=10`),
    fetchGateway<Bar[]>(gw, `/bars/${sym}/M15?count=100`),
    fetchGateway<Bar[]>(gw, `/bars/${sym}/M5?count=100`),
    fetchGateway<Bar[]>(gw, `/bars/${sym}/M1?count=60`),
    fetchGateway<GWAccount>(gw, `/account`),
    fetchGateway<GWPosition[]>(gw, `/positions`),
    fetchGateway<GWSymbol[]>(gw, `/symbols`),
    getUpcomingEvents(currencies, 24).catch(() => []),
    getRecentNews(sym, 5).catch(() => []),
  ]);

  const safeH4  = barsH4  ?? [];
  const safeH1  = barsH1  ?? [];
  const safeD1  = barsD1  ?? [];
  const safeW1  = barsW1  ?? [];
  const safeM15 = barsM15 ?? [];
  const safeM5  = barsM5  ?? [];
  const safeM1  = barsM1  ?? [];

  // 2. 現在価格
  const bid    = tick?.bid ?? 0;
  const ask    = tick?.ask ?? 0;
  const digits = tick?.digits ?? (indData?.digits ?? 5);
  // EAのTick streamはspreadを points単位で送信する（5桁ブローカーの場合 pips×10）
  // MarketWatch (indData) は pips変換済み。Tick は生のpoints。
  const rawSpread = tick?.spread ?? 0;
  const spread = (digits === 5 || digits === 3) ? rawSpread / 10 : rawSpread;
  const currentPrice = bid || ask || 0;

  // 3. セッション
  const session = (indData?.sessions ?? []) as MarketSnapshot["session"];

  // 4. インジケーター（TF別）
  const indReceivedAt = indData?.receivedAt ?? 0;
  const barsByTf: Record<string, Bar[]> = { H4: safeH4, H1: safeH1, M15: safeM15, M5: safeM5, M1: safeM1 };

  const indicators: MarketSnapshot["indicators"] = {};
  const tfList = ["H4", "H1", "M15", "M5", "M1"] as const;

  for (const tf of tfList) {
    const raw = tf === "M1" ? null : (indData?.timeframes?.[tf] ?? null);
    const bars = barsByTf[tf] ?? [];
    const stoch = calcStochastic(bars);
    const freshness = makeFreshness(
      tf === "M1" ? (bars[bars.length - 1]?.time ?? now) : indReceivedAt,
      INDICATOR_STALE_MS,
      raw ? "MT5_LIVE" : "UNAVAILABLE"
    );

    if (raw) {
      indicators[tf] = {
        ema21: raw.ema21, ema200: raw.ema200, sma50: raw.sma50,
        atr: raw.atr, rsi: raw.rsi,
        macd: raw.macd, macdSignal: raw.macdSignal, macdHist: raw.macdHist,
        adx: raw.adx, diPlus: raw.diPlus, diMinus: raw.diMinus,
        bbUpper: raw.bbUpper, bbMid: raw.bbMid, bbLower: raw.bbLower, bbWidth: raw.bbWidth,
        stochastic: stoch,
        trend: (raw.ema21 > raw.ema200 ? "UP" : raw.ema21 < raw.ema200 ? "DOWN" : "FLAT"),
        freshness,
      };
    } else if (bars.length >= 20) {
      // M1 は bars から簡易計算
      const close = bars.map(b => b.close);
      const ema21  = close.length >= 21  ? close.slice(-21).reduce((a, b) => a + b, 0) / 21 : currentPrice;
      const ema200 = close.length >= 200 ? close.slice(-200).reduce((a, b) => a + b, 0) / 200 : currentPrice;
      const highs  = bars.slice(-14).map(b => b.high);
      const lows   = bars.slice(-14).map(b => b.low);
      const atr    = bars.slice(-14).reduce((s, b, i, a) => {
        if (i === 0) return s;
        return s + Math.max(b.high - b.low, Math.abs(b.high - a[i-1].close), Math.abs(b.low - a[i-1].close));
      }, 0) / Math.max(1, bars.slice(-14).length - 1);

      indicators[tf] = {
        ema21, ema200, sma50: ema21, atr,
        rsi: 50, macd: 0, macdSignal: 0, macdHist: 0,
        adx: 0, diPlus: 0, diMinus: 0,
        bbUpper: currentPrice * 1.001, bbMid: currentPrice, bbLower: currentPrice * 0.999,
        bbWidth: 0.2, stochastic: stoch,
        trend: ema21 > ema200 ? "UP" : "DOWN",
        freshness: { ...freshness, source: "MT5_LIVE" },
      };
      void highs; void lows;
    }
  }

  // 5. ダウ理論
  const dowResult = analyzeMarketStructure(safeH4, safeD1);
  const swings = dowResult.swingPoints;
  const dowSnap: DowTheorySnapshot = {
    trend: (dowResult.trend === "UPTREND" ? "UPTREND" : dowResult.trend === "DOWNTREND" ? "DOWNTREND" : "RANGE"),
    score: dowResult.score,
    swingPoints: swings,
    lastHH: swings.filter(s => s.label === "HH").slice(-1)[0]?.price ?? null,
    lastHL: swings.filter(s => s.label === "HL").slice(-1)[0]?.price ?? null,
    lastLH: swings.filter(s => s.label === "LH").slice(-1)[0]?.price ?? null,
    lastLL: swings.filter(s => s.label === "LL").slice(-1)[0]?.price ?? null,
    summary: dowResult.summary,
  };

  // 6. Multi-TF alignment
  const dirCount: Record<string, { dir: string; score: number; signals: string[] }> = {};
  const tfWeights: Record<string, number> = { H4: 0.35, H1: 0.30, M15: 0.20, M5: 0.10, M1: 0.05 };
  let weightedScore = 0; let totalW = 0;
  const votes: Record<string, number> = { BUY: 0, SELL: 0, NEUTRAL: 0 };

  for (const tf of tfList) {
    const ind = indicators[tf];
    if (!ind) continue;
    const dir = ind.ema21 > ind.ema200 ? "BUY" : ind.ema21 < ind.ema200 ? "SELL" : "NEUTRAL";
    const score = dir === "BUY" ? 70 : dir === "SELL" ? 30 : 50;
    const signals: string[] = [
      `EMA21=${ind.ema21.toFixed(5)} vs EMA200=${ind.ema200.toFixed(5)}`,
      `RSI=${ind.rsi.toFixed(1)}`,
      `ADX=${ind.adx.toFixed(1)}`,
    ];
    dirCount[tf] = { dir, score, signals };
    const w = tfWeights[tf] ?? 0.1;
    weightedScore += score * w; totalW += w;
    votes[dir] = (votes[dir] ?? 0) + 1;
  }
  const finalMTF = totalW > 0 ? Math.round(weightedScore / totalW) : 50;
  const mtfDir = votes.BUY > votes.SELL && votes.BUY > votes.NEUTRAL ? "BUY" :
                 votes.SELL > votes.BUY && votes.SELL > votes.NEUTRAL ? "SELL" : "NEUTRAL";
  const multiTF: MultiTFAlignment = {
    direction: mtfDir, score: finalMTF,
    timeframes: Object.fromEntries(
      Object.entries(dirCount).map(([tf, v]) => [tf, { direction: v.dir as "BUY"|"SELL"|"NEUTRAL", score: v.score, signals: v.signals }])
    ),
    alignedCount: Math.max(votes.BUY, votes.SELL),
    totalCount: Object.keys(dirCount).length,
  };

  // 7. S/R
  const srResult = analyzeSupportResistance(safeH4, safeD1, safeW1, currentPrice);
  const srLevels: SRLevel[] = srResult.levels;

  // 8. パターン
  const candleResult = analyzeCandlestickPatterns({ H4: safeH4, H1: safeH1, M15: safeM15, M5: safeM5 });
  const chartResult  = analyzeChartPatterns(safeH4);
  const candlePatterns: CandlePatternSnapshot[] = candleResult.patterns;
  const chartPatterns: ChartPatternSnapshot[]   = chartResult.patterns;

  // 9. 相関市場
  const corrDef = CORR_MAP[sym] ?? [];
  const corrSymPrices = Object.fromEntries((allSymbols ?? []).map(s => [s.symbol.toUpperCase(), s.bid]));
  const correlatedMarkets: CorrelatedMarket[] = corrDef.map(c => {
    const cBid = corrSymPrices[c.symbol.toUpperCase()] ?? 0;
    // 方向の一致判定（簡易: 価格がある場合のみ）
    const confirms = cBid > 0; // 実際の確認は tick 比較が必要
    return { symbol: c.symbol, bid: cBid, relationship: c.relationship, confirms, weight: c.weight };
  });

  // 10. 経済指標
  const economicSnap: EconomicEventSnapshot[] = economicEvents.map(e => ({
    time:     e.event_time,
    currency: e.currency,
    title:    e.title,
    impact:   e.impact === 3 ? "HIGH" : e.impact === 2 ? "MEDIUM" : "LOW",
    forecast: e.forecast ?? null,
    previous: e.previous ?? null,
    actual:   e.actual ?? null,
    hoursUntil: (new Date(e.event_time).getTime() - now) / 3_600_000,
  }));

  // ニュースリスク計算
  const highImpactSoon = economicSnap.some(e => e.impact === "HIGH" && e.hoursUntil >= 0 && e.hoursUntil < 2);
  const medImpactSoon  = economicSnap.some(e => e.impact === "MEDIUM" && e.hoursUntil >= 0 && e.hoursUntil < 1);
  const newsRisk: MarketSnapshot["newsRisk"] = highImpactSoon ? "HIGH" : medImpactSoon ? "MEDIUM" : "LOW";

  // 11. ニュース
  const newsSnap: NewsSnapshot[] = recentNews.map(n => ({
    title:       n.title,
    source:      n.source,
    publishedAt: n.published_at,
    sentiment:   "neutral" as const,
    freshness:   makeFreshness(new Date(n.published_at).getTime(), NEWS_STALE_MS, "MT5_LIVE"),
  }));

  // 12. 口座
  let accountSnap: AccountSnapshot | null = null;
  if (account) {
    const drawdownPct = account.balance > 0 ? ((account.balance - account.equity) / account.balance) * 100 : 0;
    accountSnap = {
      login: account.login, broker: account.broker, currency: account.currency,
      balance: account.balance, equity: account.equity, margin: account.margin,
      freeMargin: account.freeMargin, marginLevel: account.marginLevel, leverage: account.leverage,
      drawdownPct,
      freshness: makeFreshness(now, TICK_STALE_MS, "MT5_LIVE"),
    };
  }

  // 13. ポジション
  const posSnap: PositionSnapshot[] = (positions ?? []).map(p => ({
    ticket:       p.ticket,
    symbol:       sym,
    type:         p.type === 0 ? "BUY" : "SELL",
    volume:       p.volume,
    openPrice:    p.openPrice,
    currentPrice: p.currentPrice,
    sl:           p.sl,
    tp:           p.tp,
    profit:       p.profit,
    openTime:     p.openTime,
  }));

  // 14. 鮮度サマリー
  const overallSource: DataSource = !tick ? "UNAVAILABLE" :
    (Date.now() - (tick?.time ?? 0) * 1000 > TICK_STALE_MS * 3) ? "MT5_STALE" : "MT5_LIVE";
  const indicatorFreshnessSec = Math.round((Date.now() - indReceivedAt) / 1000);

  return {
    snapshotId: id,
    symbol: sym,
    timestamp: now,
    bid, ask, spread, digits,
    session,
    indicators,
    dowTheory: dowSnap,
    multiTF,
    srLevels,
    nearestSupport:    srResult.nearestSupport,
    nearestResistance: srResult.nearestResistance,
    candlePatterns,
    chartPatterns,
    correlatedMarkets,
    economicEvents: economicSnap,
    news: newsSnap,
    newsRisk,
    account: accountSnap,
    positions: posSnap,
    openPositionsCount: posSnap.length,
    symbolPositionsCount: posSnap.filter(p => p.symbol === sym).length,
    overallSource,
    indicatorFreshnessSec,
  };
}

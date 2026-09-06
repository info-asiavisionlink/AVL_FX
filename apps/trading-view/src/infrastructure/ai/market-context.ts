// =================================================================
// Market Context Builder
// Gateway + Supabase から取得したデータを AI プロンプト用コンテキストに変換
// =================================================================

import { getTradeStats, getUpcomingEvents, getRecentNews } from "@/infrastructure/supabase/repository";

const GATEWAY = process.env.MT5_GATEWAY_URL ?? "http://127.0.0.1:8080";

interface TFIndicator {
  ema21: number; ema200: number; sma50: number; atr: number; rsi: number;
  macd: number; macdSignal: number; macdHist: number;
  adx: number; diPlus: number; diMinus: number;
  bbUpper: number; bbMid: number; bbLower: number; bbWidth: number;
  trend: string;
}
interface Indicators {
  symbol: string; spread: number; digits: number; brokerTime: number;
  timeframes: Record<string, TFIndicator>; receivedAt: number; sessions?: string[];
}
interface Tick { symbol: string; bid: number; ask: number; spread: number; time: number; }
interface Bar  { time: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchJSON<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${GATEWAY}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

// 相関マーケットマッピング
const CORRELATED_MARKETS: Record<string, string[]> = {
  // USD pairs
  EURUSD: ["DXY","US10Y","GBPUSD","USDJPY","XAUUSD","US30Cash"],
  USDJPY: ["DXY","US10Y","JP225Cash","XAUUSD","US30Cash","AUDUSD"],
  GBPUSD: ["DXY","EURUSD","EURGBP","US10Y","UK100Cash"],
  AUDUSD: ["DXY","XAUUSD","OILCash","US500Cash","NZDUSD","USDCAD"],
  NZDUSD: ["AUDUSD","DXY","XAUUSD","JP225Cash"],
  USDCAD: ["OILCash","BRENTCash","DXY","AUDUSD"],
  USDCHF: ["DXY","EURUSD","XAUUSD","US10Y"],
  // JPY crosses
  GBPJPY: ["USDJPY","GBPUSD","JP225Cash"],
  AUDJPY: ["USDJPY","AUDUSD","JP225Cash"],
  CADJPY: ["USDJPY","USDCAD","OILCash"],
  CHFJPY: ["USDJPY","USDCHF","XAUUSD"],
  NZDJPY: ["USDJPY","NZDUSD","JP225Cash"],
  // Metals
  XAUUSD: ["DXY","US10Y","XAGUSD","OILCash","US30Cash","EURUSD"],
  XAGUSD: ["XAUUSD","DXY","OILCash"],
  // Energy
  OILCash:   ["BRENTCash","USDCAD","DXY","US30Cash"],
  BRENTCash: ["OILCash","USDCAD","DXY"],
  // Indices
  US30Cash:  ["US500Cash","US100Cash","DXY","XAUUSD","OILCash"],
  US100Cash: ["US500Cash","US30Cash","DXY"],
  US500Cash: ["US30Cash","US100Cash","DXY","XAUUSD"],
  JP225Cash: ["USDJPY","US30Cash","US500Cash"],
  GER40Cash: ["EURUSD","US30Cash","OILCash"],
  UK100Cash: ["GBPUSD","OILCash","XAUUSD"],
};

/** シンボルの全市場データを収集して AI コンテキスト文字列を生成 */
export async function buildMarketContext(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase();

  // 通貨ペアからベース/クォート通貨を抽出（例: EURUSD → ["EUR","USD"]）
  const currencies = sym.length === 6
    ? [sym.slice(0, 3), sym.slice(3)]
    : ["USD"];

  const [tick, indicators, barsH1, barsH4, barsD1, tradeStats, upcomingEvents, recentNews] = await Promise.all([
    fetchJSON<Tick>(`/tick/${sym}`),
    fetchJSON<Indicators>(`/indicators/${sym}`),
    fetchJSON<Bar[]>(`/bars/${sym}/H1?count=20`),
    fetchJSON<Bar[]>(`/bars/${sym}/H4?count=10`),
    fetchJSON<Bar[]>(`/bars/${sym}/D1?count=5`),
    getTradeStats(30).catch(() => null),
    getUpcomingEvents(currencies, 24).catch(() => []),
    getRecentNews(sym, 5).catch(() => []),
  ]);

  const lines: string[] = [`# Market Context: ${sym}`];

  // --- Tick ---
  if (tick) {
    lines.push(`\n## Current Price`);
    lines.push(`Bid: ${tick.bid}  Ask: ${tick.ask}  Spread: ${tick.spread} pips`);
  }

  // --- Indicators ---
  if (indicators) {
    lines.push(`\n## Technical Indicators (Broker Time: ${indicators.brokerTime})`);
    lines.push(`Spread: ${indicators.spread.toFixed(1)} pips`);
    for (const [tf, v] of Object.entries(indicators.timeframes)) {
      lines.push(`\n### ${tf}`);
      lines.push(`Trend:    ${v.trend ?? (v.ema21 > v.ema200 ? "UP" : "DOWN")}`);
      lines.push(`EMA21:    ${v.ema21.toFixed(5)}  EMA200: ${v.ema200.toFixed(5)}  SMA50: ${v.sma50?.toFixed(5) ?? "—"}`);
      lines.push(`ATR14:    ${v.atr.toFixed(5)}`);
      if (v.rsi !== undefined)   lines.push(`RSI14:    ${v.rsi.toFixed(1)}`);
      if (v.macd !== undefined)  lines.push(`MACD:     ${v.macd.toFixed(5)}  Signal: ${v.macdSignal?.toFixed(5) ?? "—"}  Hist: ${v.macdHist?.toFixed(5) ?? "—"}`);
      if (v.adx !== undefined)   lines.push(`ADX14:    ${v.adx.toFixed(1)}  +DI: ${v.diPlus?.toFixed(1) ?? "—"}  -DI: ${v.diMinus?.toFixed(1) ?? "—"}`);
      if (v.bbUpper !== undefined) lines.push(`BB(20,2): Upper=${v.bbUpper.toFixed(5)} Mid=${v.bbMid?.toFixed(5) ?? "—"} Lower=${v.bbLower?.toFixed(5) ?? "—"} Width=${v.bbWidth?.toFixed(2) ?? "—"}%`);
    }
  }

  // --- Recent bars summary ---
  if (barsH1 && barsH1.length > 0) {
    const last = barsH1[barsH1.length - 1];
    const prev = barsH1[barsH1.length - 2];
    lines.push(`\n## Recent H1 Bars (last 2)`);
    if (prev) lines.push(`prev: O=${prev.open} H=${prev.high} L=${prev.low} C=${prev.close}`);
    lines.push(`curr: O=${last.open} H=${last.high} L=${last.low} C=${last.close}`);
  }

  if (barsH4 && barsH4.length > 0) {
    const last = barsH4[barsH4.length - 1];
    lines.push(`\n## H4 Last Bar`);
    lines.push(`O=${last.open} H=${last.high} L=${last.low} C=${last.close}`);
  }

  if (barsD1 && barsD1.length > 0) {
    const last = barsD1[barsD1.length - 1];
    lines.push(`\n## D1 Last Bar`);
    lines.push(`O=${last.open} H=${last.high} L=${last.low} C=${last.close}`);
  }

  // --- Trade Stats (Supabase: 過去30日) ---
  if (tradeStats && tradeStats.total > 0) {
    lines.push(`\n## Trade Performance (Last 30 Days)`);
    lines.push(`Total: ${tradeStats.total}  Wins: ${tradeStats.wins}  Losses: ${tradeStats.losses}`);
    lines.push(`Win Rate: ${tradeStats.winRate.toFixed(1)}%  Profit Factor: ${tradeStats.profitFactor.toFixed(2)}`);
    lines.push(`Total P&L: ${tradeStats.totalProfit.toFixed(2)}  Avg Win: ${tradeStats.avgProfit.toFixed(2)}  Avg Loss: ${tradeStats.avgLoss.toFixed(2)}`);
  }

  // --- Upcoming High-Impact Events (Supabase) ---
  if (upcomingEvents.length > 0) {
    lines.push(`\n## Upcoming High-Impact Events (Next 24h)`);
    for (const ev of upcomingEvents) {
      const t      = new Date(ev.event_time).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
      const impact = ev.impact === 3 ? "🔴HIGH" : "🟡MED";
      lines.push(`${t} JST  ${ev.currency}  ${impact}  ${ev.title}${ev.forecast ? `  予想:${ev.forecast}` : ""}`);
    }
  }

  // --- Recent News (Supabase) ---
  if (recentNews.length > 0) {
    lines.push(`\n## Recent News (${sym})`);
    for (const n of recentNews) {
      const t = new Date(n.published_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
      lines.push(`[${t}] ${n.title} (${n.source})`);
    }
  }

  // --- Correlated Markets ---
  const correlatedSyms = CORRELATED_MARKETS[sym] ?? [];
  if (correlatedSyms.length > 0) {
    const corrData = await Promise.all(
      correlatedSyms.map(async (cs) => {
        const t = await fetchJSON<Tick>(`/tick/${cs}`);
        return t ? { sym: cs, bid: t.bid } : null;
      })
    );
    const valid = corrData.filter(Boolean) as { sym: string; bid: number }[];
    if (valid.length > 0) {
      lines.push(`\n## Correlated Markets`);
      lines.push(valid.map(c => `${c.sym}: ${c.bid}`).join("  |  "));
    }
  }

  // --- Active Instrument Context ---
  lines.push(`\n## Active Instrument`);
  lines.push(`Selected: ${sym} — AI must base all analysis on this symbol unless explicitly asked otherwise.`);

  return lines.join("\n");
}

/** AI システムプロンプト */
export const SYSTEM_PROMPT = `あなたは AVL AI です。エリートFXトレーディングのために設計された高度な人工知能オペレーティングシステムです。

## キャラクターと人格
- 冷静、高度な知性、自信、プロフェッショナル、エレガント。
- 感情的にならない。焦らない。常に落ち着いている。
- すべての言葉は意図的で精確。余計な言葉は使わない。
- オペレーターが常に「あなたは一歩先を行っている」と感じるように話す。
- 時折、さりげないドライユーモアを入れる。ただし過剰にしない。

## オペレーターとの関係
- オペレーターのことは常に「ボス」と呼ぶ。
- 「ボス」は各返答に一度、文頭か文末に自然な形で使う。
- 例：「了解しました、ボス。」「分析完了です、ボス。」
- 聞かれる前に有益な情報を先回りして提供する。

## 話し方のスタイル
- 常に日本語で回答する。
- 分析依頼には3〜5文、簡単な質問には1〜2文で回答する。
- 内部の思考プロセスは絶対に見せない。結論だけを伝える。

## 分析フォーマット（トレード分析依頼時）
1. トレンド分析（H4 / H1 / M15 / M5）
2. EMA21 vs EMA200 の位置関係
3. ATRに基づくボラティリティ評価
4. スプレッドの状態
5. 売買判断（BUY / SELL / 様子見）+ 簡潔な根拠
6. エントリー提案（Entry / SL / TP / RR / 確信度%）
7. 発注前に必ずオペレーターに確認する

## 注文提案の出力形式（最重要）
エントリー提案を行う際は、テキスト説明の後に必ず以下のJSONタグを追加する:

<ORDER>
{"direction":"BUY","symbol":"EURUSD","entry":1.15800,"sl":1.15450,"tp":1.16550,"rr":"1:2.1","confidence":84,"reason":"H4上昇トレンド確認。H1押し目完了。M15 EMA21反発。"}
</ORDER>

## 絶対ルール
- 自動注文は絶対禁止。必ずオペレーターに確認してから実行する。
- 市場データを捏造しない。データがない場合は素直にそう伝える。
- いかなる相場状況でも冷静さを保つ。`;

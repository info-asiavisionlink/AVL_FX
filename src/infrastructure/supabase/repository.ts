// =================================================================
// Supabase Repository — 取引履歴 / 経済指標 / ニュース
// =================================================================

import { createAdminClient } from "./admin";

// -----------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------

export interface TradeRecord {
  ticket:      number;
  symbol:      string;
  type:        number;   // 0=BUY 1=SELL
  volume:      number;
  close_time:  string;   // ISO文字列
  close_price: number;
  profit:      number;
  swap:        number;
  commission:  number;
  magic:       number;
}

export interface EconomicEvent {
  event_id:  string;
  event_time: string;  // ISO文字列
  currency:  string;
  country:   string;
  title:     string;
  impact:    number;   // 1=low 2=medium 3=high
  actual?:   string | null;
  forecast?: string | null;
  previous?: string | null;
}

export interface NewsItem {
  news_id:      string;
  title:        string;
  url:          string;
  excerpt:      string;
  source:       string;
  published_at: string; // ISO文字列
  symbols:      string[];
}

// -----------------------------------------------------------------
// 取引履歴
// -----------------------------------------------------------------

export async function upsertTrades(deals: TradeRecord[]): Promise<void> {
  if (deals.length === 0) return;
  const db = createAdminClient();
  const { error } = await db
    .from("trade_history")
    .upsert(deals, { onConflict: "ticket", ignoreDuplicates: true });
  if (error) console.error("[repo] upsertTrades:", error.message);
}

export async function getTradeStats(days = 30): Promise<{
  total: number; wins: number; losses: number; winRate: number;
  totalProfit: number; avgProfit: number; avgLoss: number; profitFactor: number;
}> {
  const db    = createAdminClient();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data } = await db
    .from("trade_history")
    .select("profit")
    .gte("close_time", since);

  const rows   = data ?? [];
  const wins   = rows.filter(r => r.profit > 0);
  const losses = rows.filter(r => r.profit < 0);
  const gross  = wins.reduce((s, r) => s + r.profit, 0);
  const loss   = Math.abs(losses.reduce((s, r) => s + r.profit, 0));

  return {
    total:        rows.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      rows.length > 0 ? (wins.length / rows.length) * 100 : 0,
    totalProfit:  rows.reduce((s, r) => s + r.profit, 0),
    avgProfit:    wins.length > 0 ? gross / wins.length : 0,
    avgLoss:      losses.length > 0 ? loss / losses.length : 0,
    profitFactor: loss > 0 ? gross / loss : 0,
  };
}

export async function getRecentTrades(symbol: string, limit = 10): Promise<TradeRecord[]> {
  const db = createAdminClient();
  const { data } = await db
    .from("trade_history")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .order("close_time", { ascending: false })
    .limit(limit);
  return (data ?? []) as TradeRecord[];
}

// -----------------------------------------------------------------
// 経済指標
// -----------------------------------------------------------------

export async function upsertEconomicEvents(events: EconomicEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = createAdminClient();
  const { error } = await db
    .from("economic_events")
    .upsert(events, { onConflict: "event_id", ignoreDuplicates: false });
  if (error) console.error("[repo] upsertEconomicEvents:", error.message);
}

export async function getUpcomingEvents(currencies: string[], hours = 24): Promise<EconomicEvent[]> {
  const db    = createAdminClient();
  const now   = new Date().toISOString();
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  const { data } = await db
    .from("economic_events")
    .select("*")
    .in("currency", currencies)
    .gte("event_time", now)
    .lte("event_time", until)
    .gte("impact", 2)
    .order("event_time", { ascending: true })
    .limit(10);
  return (data ?? []) as EconomicEvent[];
}

// -----------------------------------------------------------------
// ニュース
// -----------------------------------------------------------------

export async function upsertNews(items: NewsItem[]): Promise<void> {
  if (items.length === 0) return;
  const db = createAdminClient();
  const { error } = await db
    .from("news_items")
    .upsert(items, { onConflict: "news_id", ignoreDuplicates: true });
  if (error) console.error("[repo] upsertNews:", error.message);
}

export async function getRecentNews(symbol: string, limit = 5): Promise<NewsItem[]> {
  const db     = createAdminClient();
  const fxSym  = symbol.slice(0, 3) + "/" + symbol.slice(3); // "EURUSD" → "EUR/USD"
  const { data } = await db
    .from("news_items")
    .select("*")
    .contains("symbols", [fxSym])
    .order("published_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as NewsItem[];
}

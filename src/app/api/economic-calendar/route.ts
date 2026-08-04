// =================================================================
// GET /api/economic-calendar?key=xxx&from=YYYY-MM-DD&to=YYYY-MM-DD
// Twelve Data economic_calendar プロキシ
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { upsertEconomicEvents } from "@/infrastructure/supabase/repository";

export const runtime = "nodejs";

interface TDCalendarItem {
  datetime:  string;  // "2024-01-15 08:30:00"
  country:   string;
  currency?: string;
  impact:    string;  // "high" | "medium" | "low"
  title:     string;
  actual?:   string;
  forecast?: string;
  prev?:     string;
}

interface TDCalendarResponse {
  result?: {
    list?: TDCalendarItem[];
  };
}

const IMPACT_MAP: Record<string, number> = {
  high: 3, medium: 2, low: 1,
};

function todayRange() {
  const now  = new Date();
  const from = now.toISOString().slice(0, 10);
  const to   = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10);
  return { from, to };
}

export async function GET(req: NextRequest) {
  const sp   = req.nextUrl.searchParams;
  const key  = sp.get("key") ?? process.env.TWELVE_DATA_API_KEY ?? "";
  const { from, to } = todayRange();

  if (!key) {
    return NextResponse.json(demoEvents());
  }

  try {
    const url = `https://api.twelvedata.com/economic_calendar?from=${from}&to=${to}&apikey=${key}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Twelve Data ${res.status}`);

    const raw = await res.json() as TDCalendarResponse;
    const list = raw.result?.list ?? [];

    const events = list.map((item, i) => ({
      id:       `td_${i}_${item.datetime}`,
      time:     Math.floor(new Date(item.datetime.replace(" ", "T") + "Z").getTime() / 1000),
      currency: item.currency ?? guessCurrency(item.country),
      country:  item.country,
      title:    item.title,
      impact:   IMPACT_MAP[item.impact?.toLowerCase()] ?? 1,
      actual:   item.actual,
      forecast: item.forecast,
      previous: item.prev,
    }));

    // Supabase に保存（非同期・エラーは無視）
    void upsertEconomicEvents(events.map(e => ({
      event_id:   e.id,
      event_time: new Date(e.time * 1000).toISOString(),
      currency:   e.currency,
      country:    e.country,
      title:      e.title,
      impact:     e.impact,
      actual:     e.actual ?? null,
      forecast:   e.forecast ?? null,
      previous:   e.previous ?? null,
    })));

    return NextResponse.json(events, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (err) {
    console.error("[economic-calendar]", err);
    return NextResponse.json(demoEvents());
  }
}

function guessCurrency(country: string): string {
  const map: Record<string, string> = {
    "United States": "USD", "Euro Zone": "EUR", "Japan": "JPY",
    "United Kingdom": "GBP", "Australia": "AUD", "Canada": "CAD",
    "Switzerland": "CHF", "New Zealand": "NZD", "China": "CNH",
  };
  return map[country] ?? "USD";
}

function demoEvents() {
  const base = Math.floor(Date.now() / 1000);
  return [
    { id:"d1", time: base + 3600,  currency:"USD", country:"United States", title:"CPI m/m",          impact:3, forecast:"0.3%", previous:"0.2%" },
    { id:"d2", time: base + 7200,  currency:"USD", country:"United States", title:"Initial Jobless",   impact:2, forecast:"215K",  previous:"212K" },
    { id:"d3", time: base + 14400, currency:"EUR", country:"Euro Zone",      title:"ECB Minutes",       impact:2, forecast:"—",    previous:"—"    },
    { id:"d4", time: base + 18000, currency:"JPY", country:"Japan",          title:"BoJ Rate Decision", impact:3, forecast:"0.5%", previous:"0.5%" },
    { id:"d5", time: base + 25200, currency:"GBP", country:"United Kingdom", title:"Retail Sales m/m",  impact:2, forecast:"0.1%", previous:"-0.3%"},
  ];
}

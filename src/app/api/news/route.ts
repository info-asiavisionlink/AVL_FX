// =================================================================
// GET /api/news?symbol=EURUSD&key=xxx
// Twelve Data /news プロキシ
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { upsertNews } from "@/infrastructure/supabase/repository";

export const runtime = "nodejs";

interface TDNewsItem {
  id?:        string;
  title:      string;
  url?:       string;
  text?:      string;
  source?:    string;
  datetime?:  string;
  symbols?:   string[];
}

interface TDNewsResponse {
  data?: TDNewsItem[];
}

const FX_SYMBOLS = ["EUR/USD", "USD/JPY", "GBP/USD", "AUD/USD", "XAU/USD"];

export async function GET(req: NextRequest) {
  const sp     = req.nextUrl.searchParams;
  const key    = sp.get("key") ?? process.env.TWELVE_DATA_API_KEY ?? "";
  const symbol = sp.get("symbol") ?? "EUR/USD";
  const limit  = sp.get("limit")  ?? "20";

  if (!key) {
    return NextResponse.json(demoNews());
  }

  try {
    const url = `https://api.twelvedata.com/news?symbol=${encodeURIComponent(symbol)}&apikey=${key}&outputsize=${limit}&source=seekingalpha,reuters,bloomberg,forexlive`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Twelve Data ${res.status}`);

    const raw   = await res.json() as TDNewsResponse;
    const items = (raw.data ?? []).map((item, i) => ({
      id:       item.id ?? `news_${i}`,
      title:    item.title,
      url:      item.url ?? "",
      excerpt:  item.text ? item.text.slice(0, 180) : "",
      source:   item.source ?? "—",
      datetime: item.datetime
        ? Math.floor(new Date(item.datetime).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      symbols:  item.symbols ?? [],
    }));

    // Supabase に保存（非同期・エラーは無視）
    void upsertNews(items.map(item => ({
      news_id:      item.id,
      title:        item.title,
      url:          item.url,
      excerpt:      item.excerpt,
      source:       item.source,
      published_at: new Date(item.datetime * 1000).toISOString(),
      symbols:      item.symbols,
    })));

    return NextResponse.json(items, {
      headers: { "Cache-Control": "public, max-age=120" },
    });
  } catch (err) {
    console.error("[news]", err);
    return NextResponse.json(demoNews());
  }
}

function demoNews() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { id:"n1", title:"EUR/USD holds steady ahead of ECB minutes",          url:"#", excerpt:"The euro held near 1.0850 against the dollar as traders awaited the release of the ECB meeting minutes.", source:"Reuters",    datetime: now - 1800,  symbols:["EUR/USD"] },
    { id:"n2", title:"USD/JPY retreats as BoJ signals potential hike",     url:"#", excerpt:"The Japanese yen strengthened after Bank of Japan officials signaled the possibility of another rate increase.", source:"Bloomberg", datetime: now - 3600,  symbols:["USD/JPY"] },
    { id:"n3", title:"Gold surges on risk-off sentiment",                  url:"#", excerpt:"XAU/USD climbed above $2,350 as investors sought safe-haven assets amid rising geopolitical tensions.", source:"ForexLive", datetime: now - 5400,  symbols:["XAU/USD"] },
    { id:"n4", title:"GBP/USD sees mild gains on UK retail data",          url:"#", excerpt:"Sterling edged higher following better-than-expected UK retail sales data, supporting the case for delayed BoE cuts.", source:"Reuters",    datetime: now - 7200,  symbols:["GBP/USD"] },
    { id:"n5", title:"Fed officials stress data dependency for rate cuts", url:"#", excerpt:"Multiple Federal Reserve officials reiterated that future rate cuts will depend on incoming economic data.", source:"Bloomberg", datetime: now - 10800, symbols:["USD"] },
    { id:"n6", title:"AUD/USD pressured by mixed Chinese data",            url:"#", excerpt:"The Australian dollar slipped as disappointing Chinese industrial output data weighed on risk sentiment.", source:"ForexLive", datetime: now - 14400, symbols:["AUD/USD"] },
  ];
}

// GET /api/news
// ソース: FXStreet RSS — APIキー不要・完全無料
// キャッシュ: インメモリ15分
// クエリ: ?currency=USD|EUR|JPY|GBP|AUD|CAD|XAU|ALL

import { NextRequest, NextResponse } from "next/server";
import { parseStringPromise }        from "xml2js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── 型 ──────────────────────────────────────────────────────────────

export interface NewsItem {
  id:       string;
  title:    string;
  url:      string;
  excerpt:  string;
  source:   string;
  datetime: number;   // Unix秒
  tags:     string[]; // 関連通貨キーワード
}

// ── インメモリキャッシュ ─────────────────────────────────────────────

let _cache: { items: NewsItem[]; ts: number } | null = null;
const CACHE_TTL = 15 * 60 * 1000; // 15分

// ── 通貨キーワードマップ ─────────────────────────────────────────────

const CCY_KEYWORDS: Record<string, string[]> = {
  USD: ["usd", "dollar", "fed ", "federal reserve", "fomc", "us economy"],
  EUR: ["eur", "euro", "ecb", "european central bank", "eurozone"],
  JPY: ["jpy", "yen", "boj", "bank of japan", "日本"],
  GBP: ["gbp", "sterling", "pound", "boe", "bank of england"],
  AUD: ["aud", "aussie", "rba", "reserve bank of australia"],
  CAD: ["cad", "loonie", "bank of canada"],
  CHF: ["chf", "swiss franc", "snb"],
  NZD: ["nzd", "kiwi", "rbnz"],
  XAU: ["gold", "xau", "silver", "xag"],
};

function detectTags(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.entries(CCY_KEYWORDS)
    .filter(([, kws]) => kws.some(kw => lower.includes(kw)))
    .map(([ccy]) => ccy);
}

// ── RSS取得・パース ──────────────────────────────────────────────────

async function fetchFXStreet(): Promise<NewsItem[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.items;

  const res = await fetch("https://www.fxstreet.com/rss/news", {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AVL-FX/1.0)",
      "Accept": "application/rss+xml, application/xml, text/xml",
    },
  });

  if (!res.ok) throw new Error(`FXStreet RSS HTTP ${res.status}`);

  const xml  = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = await parseStringPromise(xml, { explicitArray: false }) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawItems: any[] = Array.isArray(feed?.rss?.channel?.item)
    ? feed.rss.channel.item
    : [feed?.rss?.channel?.item].filter(Boolean);

  const items: NewsItem[] = rawItems.map((item, i) => {
    const title   = String(item.title   ?? "").trim();
    const url     = String(item.link    ?? "").trim();
    const excerpt = String(item.description ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 200);
    const guid    = String(item.guid?._  ?? item.guid ?? `fxs_${i}`);
    const pubDate = item.pubDate ? new Date(item.pubDate).getTime() / 1000 : Date.now() / 1000;
    const tags    = detectTags(title + " " + excerpt);

    return { id: guid, title, url, excerpt, source: "FXStreet", datetime: Math.floor(pubDate), tags };
  });

  _cache = { items, ts: Date.now() };
  return items;
}

// ── ハンドラー ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const currency = req.nextUrl.searchParams.get("currency") ?? "ALL";

  try {
    const all     = await fetchFXStreet();
    const filtered = currency === "ALL"
      ? all
      : all.filter(item => item.tags.includes(currency));

    return NextResponse.json(
      { items: filtered, source: "fxstreet", fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=900" } }
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[news]", error);
    return NextResponse.json({ items: [], source: "none", error }, { status: 200 });
  }
}

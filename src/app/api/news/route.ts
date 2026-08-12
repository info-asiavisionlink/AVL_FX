// GET /api/news
// ソース: Yahoo Finance FX RSS — APIキー不要・完全無料
//   Vercel含むサーバーサイドで動作確認済み（FXStreetはVPS/Vercelをブロックするため不使用）
// キャッシュ: インメモリ15分
// クエリ: ?currency=USD|EUR|JPY|GBP|AUD|CAD|XAU|ALL

import { NextRequest, NextResponse } from "next/server";

export const runtime    = "nodejs";
export const revalidate = 900; // 15分キャッシュ（Vercel Data Cache + CDN）

// ── 型 ──────────────────────────────────────────────────────────────

export interface NewsItem {
  id:       string;
  title:    string;
  url:      string;
  excerpt:  string;
  source:   string;
  datetime: number;   // Unix秒
  tags:     string[]; // 関連通貨
}

// ── Yahoo Finance FX RSS エンドポイント ──────────────────────────────
// EURUSD=X, USDJPY=X, GBPUSD=X, AUDUSD=X, XAUUSD=X をまとめて取得

const YF_FX_URL =
  "https://feeds.finance.yahoo.com/rss/2.0/headline" +
  "?s=EURUSD%3DX%2CUSDJPY%3DX%2CGBPUSD%3DX%2CAUDUSD%3DX%2CXAUUSD%3DX%2CCADUSD%3DX" +
  "&region=US&lang=en-US";

// ── インメモリキャッシュ ─────────────────────────────────────────────

let _cache: { items: NewsItem[]; ts: number } | null = null;
const CACHE_TTL = 15 * 60 * 1000;

// ── 通貨キーワードマップ ─────────────────────────────────────────────

const CCY_KEYWORDS: Record<string, string[]> = {
  USD: ["usd", "dollar", "fed ", "federal reserve", "fomc", "dxy", "greenback"],
  EUR: ["eur", "euro", "ecb", "eurozone", "european central bank"],
  JPY: ["jpy", "yen", "boj", "bank of japan", "nikkei"],
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

// ── XML パーサー（xml2js なしで軽量実装） ────────────────────────────

function extractItems(xml: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;

  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string) => {
      const r = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i");
      const found = r.exec(block);
      return (found?.[1] ?? found?.[2] ?? "").trim();
    };
    items.push({
      title:       get("title"),
      link:        get("link"),
      guid:        get("guid"),
      pubDate:     get("pubDate"),
      description: get("description"),
    });
  }
  return items;
}

// ── RSS 取得 ──────────────────────────────────────────────────────────

async function fetchNews(): Promise<NewsItem[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.items;

  const res = await fetch(YF_FX_URL, {
    next: { revalidate: 900 }, // Next.js Data Cache — Vercel serverless で有効
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) throw new Error(`Yahoo Finance RSS HTTP ${res.status}`);

  const xml   = await res.text();
  const raws  = extractItems(xml);

  const items: NewsItem[] = raws.map((r, i) => {
    const title   = r.title;
    const url     = r.link || r.guid;
    const excerpt = r.description.replace(/<[^>]+>/g, "").slice(0, 200);
    const id      = r.guid || `yf_${i}`;
    const pubMs   = r.pubDate ? new Date(r.pubDate).getTime() : Date.now();
    const tags    = detectTags(title + " " + excerpt);

    return {
      id,
      title,
      url,
      excerpt,
      source:   "Yahoo Finance",
      datetime: Math.floor(pubMs / 1000),
      tags,
    };
  });

  _cache = { items, ts: Date.now() };
  return items;
}

// ── ハンドラー ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const currency = req.nextUrl.searchParams.get("currency") ?? "ALL";

  try {
    const all      = await fetchNews();
    const filtered = currency === "ALL"
      ? all
      : all.filter(item => item.tags.includes(currency));

    return NextResponse.json(
      { items: filtered, source: "yahoo_finance", fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=900" } }
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[news]", error);
    return NextResponse.json(
      { items: [], source: "none", error },
      { status: 200 }
    );
  }
}

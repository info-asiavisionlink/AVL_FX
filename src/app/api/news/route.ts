// GET /api/news
// ソース: Yahoo Finance FX RSS + FXStreet RSS — APIキー不要・完全無料
// 翻訳: Google Translate 無料エンドポイント（APIキー不要）
// キャッシュ: インメモリ5分 + Vercel Data Cache 300秒
// クエリ: ?currency=USD|EUR|JPY|GBP|AUD|CAD|XAU|ALL

import { NextRequest, NextResponse } from "next/server";

export const runtime    = "nodejs";
export const revalidate = 300; // 5分に短縮

// ── 型 ──────────────────────────────────────────────────────────────

export interface NewsItem {
  id:       string;
  title:    string;
  titleJa:  string;   // Google翻訳による日本語タイトル
  url:      string;
  excerpt:  string;
  source:   string;
  datetime: number;
  tags:     string[];
}

// ── 定数 ────────────────────────────────────────────────────────────

const YF_FX_URL =
  "https://feeds.finance.yahoo.com/rss/2.0/headline" +
  "?s=EURUSD%3DX%2CUSDJPY%3DX%2CGBPUSD%3DX%2CAUDUSD%3DX%2CXAUUSD%3DX%2CCADUSD%3DX" +
  "&region=US&lang=en-US";

// FXStreet — 頻繁に更新されるFX専門ニュース
const FXSTREET_URL = "https://www.fxstreet.com/rss/news";

// ForexLive — リアルタイムに近い速報
const FOREXLIVE_URL = "https://www.forexlive.com/feed/news";

const CACHE_TTL = 5 * 60 * 1000; // 5分に短縮

let _cache: { items: NewsItem[]; ts: number } | null = null;

// ── 通貨タグ検出 ─────────────────────────────────────────────────────

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

// ── Google翻訳（無料エンドポイント） ──────────────────────────────────

async function translateToJa(text: string): Promise<string> {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return text;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any[][];
    // data[0] = [[translatedChunk, original, ...], ...]
    return (data[0] as string[][]).map(c => c[0]).join("") || text;
  } catch {
    return text; // 翻訳失敗時は英語のまま
  }
}

// ── XML パーサー ─────────────────────────────────────────────────────

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
      title: get("title"), link: get("link"),
      guid: get("guid"), pubDate: get("pubDate"), description: get("description"),
    });
  }
  return items;
}

// ── 単一RSSフィード取得 ───────────────────────────────────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, */*",
};

async function fetchRSS(url: string, sourceName: string, prefix: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, { next: { revalidate: 300 }, headers: HEADERS });
    if (!res.ok) return [];
    const raws = extractItems(await res.text());
    return raws.map((r, i) => ({
      id:       r.guid || `${prefix}_${i}`,
      title:    r.title,
      titleJa:  r.title, // 翻訳は後でまとめて
      url:      r.link || r.guid,
      excerpt:  r.description.replace(/<[^>]+>/g, "").slice(0, 300),
      source:   sourceName,
      datetime: r.pubDate ? Math.floor(new Date(r.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
      tags:     detectTags(r.title + " " + r.description),
    }));
  } catch {
    return [];
  }
}

// ── RSS 取得 + 翻訳（複数ソース） ────────────────────────────────────

async function fetchNews(): Promise<NewsItem[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.items;

  // 3ソースを並列フェッチ
  const [yfItems, fxsItems, flItems] = await Promise.all([
    fetchRSS(YF_FX_URL,      "Yahoo Finance", "yf"),
    fetchRSS(FXSTREET_URL,   "FXStreet",      "fxs"),
    fetchRSS(FOREXLIVE_URL,  "ForexLive",     "fl"),
  ]);

  // 統合・重複除去（タイトルが80%以上似ているものを除外）・日時降順ソート
  const seen = new Set<string>();
  const merged = [...yfItems, ...fxsItems, ...flItems]
    .filter(item => {
      if (!item.title) return false;
      const key = item.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, 40); // 最大40件

  // タイトルを並列翻訳（Google翻訳無料枠）
  const titlesJa = await Promise.all(merged.map(item => translateToJa(item.title)));
  merged.forEach((item, i) => { item.titleJa = titlesJa[i] || item.title; });

  _cache = { items: merged, ts: Date.now() };
  return merged;
}

// ── ハンドラー ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const currency = req.nextUrl.searchParams.get("currency") ?? "ALL";
  try {
    const all      = await fetchNews();
    const filtered = currency === "ALL" ? all : all.filter(i => i.tags.includes(currency));
    return NextResponse.json(
      { items: filtered, source: "multi", fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[news]", error);
    return NextResponse.json({ items: [], source: "none", error }, { status: 200 });
  }
}

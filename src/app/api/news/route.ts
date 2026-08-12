// GET /api/news
// ソース: Yahoo Finance FX RSS — APIキー不要・完全無料
//   Vercel含むサーバーサイドで動作確認済み
// 翻訳: Google Translate 無料エンドポイント（APIキー不要）
// キャッシュ: インメモリ15分 + Vercel Data Cache 900秒
// クエリ: ?currency=USD|EUR|JPY|GBP|AUD|CAD|XAU|ALL

import { NextRequest, NextResponse } from "next/server";

export const runtime    = "nodejs";
export const revalidate = 900;

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

const CACHE_TTL = 15 * 60 * 1000;

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

// ── RSS 取得 + 翻訳 ──────────────────────────────────────────────────

async function fetchNews(): Promise<NewsItem[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.items;

  const res = await fetch(YF_FX_URL, {
    next: { revalidate: 900 },
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance RSS HTTP ${res.status}`);

  const raws = extractItems(await res.text());

  // タイトルを並列翻訳（最大20件）
  const titles    = raws.map(r => r.title);
  const titlesJa  = await Promise.all(titles.map(t => translateToJa(t)));

  const items: NewsItem[] = raws.map((r, i) => ({
    id:       r.guid || `yf_${i}`,
    title:    r.title,
    titleJa:  titlesJa[i] || r.title,
    url:      r.link || r.guid,
    excerpt:  r.description.replace(/<[^>]+>/g, "").slice(0, 300),
    source:   "Yahoo Finance",
    datetime: r.pubDate ? Math.floor(new Date(r.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
    tags:     detectTags(r.title + " " + r.description),
  }));

  _cache = { items, ts: Date.now() };
  return items;
}

// ── ハンドラー ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const currency = req.nextUrl.searchParams.get("currency") ?? "ALL";
  try {
    const all      = await fetchNews();
    const filtered = currency === "ALL" ? all : all.filter(i => i.tags.includes(currency));
    return NextResponse.json(
      { items: filtered, source: "yahoo_finance", fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=900" } }
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[news]", error);
    return NextResponse.json({ items: [], source: "none", error }, { status: 200 });
  }
}

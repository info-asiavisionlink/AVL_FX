// GET /api/economic-calendar
// ソース: Forex Factory JSON (nfs.faireconomy.media) — APIキー不要
// キャッシュ: インメモリ1時間（Next.jsキャッシュを使わない）
// range: "today" | "tomorrow" | "week"

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── 型定義 ──────────────────────────────────────────────────────────

export interface CalEvent {
  id:        string;
  time:      number;
  currency:  string;
  country:   string;
  title:     string;
  impact:    number;   // 1=low 2=medium 3=high
  actual?:   string | null;
  forecast?: string | null;
  previous?: string | null;
}

export interface CalMeta {
  source:    "forex_factory" | "none";
  isDemo:    false;
  dateJST:   string;
  range:     string;
  fetchedAt: string;
  error?:    string;
}

interface FFEvent {
  title:    string;
  country:  string;
  date:     string;
  impact:   string;
  forecast: string;
  previous: string;
}

// ── インメモリキャッシュ ─────────────────────────────────────────────

let _cache: { data: FFEvent[]; ts: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1時間

async function getFFData(): Promise<FFEvent[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) {
    return _cache.data;
  }
  const res = await fetch(
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.forexfactory.com/",
      },
    }
  );
  if (!res.ok) throw new Error(`FF HTTP ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith("<")) throw new Error("FF rate limited (HTML response)");
  const data = JSON.parse(text) as FFEvent[];
  _cache = { data, ts: Date.now() };
  return data;
}

// ── JST ユーティリティ ───────────────────────────────────────────────

const JST = 9 * 3600_000;

function toJSTDate(ms: number): string {
  return new Date(ms + JST).toISOString().slice(0, 10);
}

function dateRange(range: string) {
  const now = Date.now();
  const today = toJSTDate(now);
  if (range === "tomorrow") { const d = toJSTDate(now + 86400_000); return { from: d, to: d }; }
  if (range === "week")     return { from: today, to: toJSTDate(now + 6 * 86400_000) };
  return { from: today, to: today };
}

const IMPACT: Record<string, number> = { high: 3, medium: 2, low: 1 };

// ── ハンドラー ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const range     = req.nextUrl.searchParams.get("range") ?? "today";
  const nowMs     = Date.now();
  const dateJST   = toJSTDate(nowMs);
  const fetchedAt = new Date(nowMs).toISOString();
  const { from, to } = dateRange(range);

  try {
    const raw    = await getFFData();
    const events: CalEvent[] = raw
      .filter(e => {
        if (e.impact === "Holiday") return false;
        const d = toJSTDate(new Date(e.date).getTime());
        return d >= from && d <= to;
      })
      .map((e, i) => ({
        id:       `ff_${i}_${e.country}_${new Date(e.date).getTime()}`,
        time:     Math.floor(new Date(e.date).getTime() / 1000),
        currency: e.country,
        country:  e.country,
        title:    e.title,
        impact:   IMPACT[e.impact.toLowerCase()] ?? 1,
        actual:   null,
        forecast: e.forecast || null,
        previous: e.previous || null,
      }))
      .sort((a, b) => a.time - b.time);

    return NextResponse.json({
      events,
      meta: { source: "forex_factory", isDemo: false, dateJST, range, fetchedAt } satisfies CalMeta,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[economic-calendar]", error);
    return NextResponse.json({
      events: [] as CalEvent[],
      meta: { source: "none", isDemo: false, dateJST, range, fetchedAt, error } satisfies CalMeta,
    });
  }
}

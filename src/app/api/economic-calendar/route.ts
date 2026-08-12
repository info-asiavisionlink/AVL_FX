// =================================================================
// GET /api/economic-calendar
// =================================================================
//
// パラメータ:
//   key   - Twelve Data APIキー（省略時はenv変数を使用）
//   range - "today" | "tomorrow" | "week" (デフォルト: "today")
//
// タイムゾーン: Asia/Tokyo (JST)
//   今日 = JST 00:00 〜 23:59 の範囲
//
// レスポンス:
//   { events: CalEvent[], meta: CalMeta }
//
// DEMO DATA 禁止:
//   APIキー未設定 or API失敗の場合は空配列を返す。
//   架空の経済指標は返さない。
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { upsertEconomicEvents }      from "@/infrastructure/supabase/repository";

export const runtime = "nodejs";

// ── 型定義 ─────────────────────────────────────────────────────────

export interface CalEvent {
  id:        string;
  time:      number;   // Unix秒 (UTC)
  currency:  string;
  country:   string;
  title:     string;
  impact:    number;   // 1=low 2=medium 3=high
  actual?:   string | null;
  forecast?: string | null;
  previous?: string | null;
}

export interface CalMeta {
  source:    "twelve_data" | "none";
  isDemo:    false;
  dateJST:   string;   // YYYY-MM-DD (JST)
  range:     string;
  fetchedAt: string;   // ISO8601 (UTC)
  error?:    string;
}

interface TDCalendarItem {
  datetime:  string;
  country:   string;
  currency?: string;
  impact:    string;
  title:     string;
  actual?:   string;
  forecast?: string;
  prev?:     string;
}

interface TDCalendarResponse {
  status?: string;
  code?:   number;
  result?: { list?: TDCalendarItem[] };
}

// ── JST 日付計算 ──────────────────────────────────────────────────
// JST = UTC+9

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJSTDate(utcMs: number): string {
  return new Date(utcMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST の today/tomorrow/week の UTC 範囲を返す */
function jstRange(range: string): { from: string; to: string } {
  const nowMs      = Date.now();
  const todayJST   = toJSTDate(nowMs);

  if (range === "tomorrow") {
    const tomorrowJST = toJSTDate(nowMs + 86400_000);
    return { from: tomorrowJST, to: tomorrowJST };
  }
  if (range === "week") {
    const weekEndJST = toJSTDate(nowMs + 6 * 86400_000);
    return { from: todayJST, to: weekEndJST };
  }
  // デフォルト: today
  return { from: todayJST, to: todayJST };
}

const IMPACT_MAP: Record<string, number> = {
  high: 3, medium: 2, low: 1,
};

function guessCurrency(country: string): string {
  const MAP: Record<string, string> = {
    "United States": "USD", "Euro Zone": "EUR",   "Japan": "JPY",
    "United Kingdom": "GBP", "Australia": "AUD",  "Canada": "CAD",
    "Switzerland": "CHF",   "New Zealand": "NZD", "China": "CNH",
    "Germany": "EUR",       "France": "EUR",      "Italy": "EUR",
    "Spain": "EUR",         "South Korea": "KRW", "India": "INR",
  };
  return MAP[country] ?? "USD";
}

// ── メインハンドラー ──────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const sp    = req.nextUrl.searchParams;
  const key   = sp.get("key") ?? process.env.TWELVE_DATA_API_KEY ?? "";
  const range = sp.get("range") ?? "today";

  const nowMs     = Date.now();
  const dateJST   = toJSTDate(nowMs);
  const fetchedAt = new Date(nowMs).toISOString();
  const { from, to } = jstRange(range);

  // APIキーがない場合 → demo禁止、空返却
  if (!key) {
    return NextResponse.json({
      events: [] as CalEvent[],
      meta: {
        source: "none",
        isDemo: false,
        dateJST,
        range,
        fetchedAt,
        error: "TWELVE_DATA_API_KEY not configured",
      } satisfies CalMeta,
    });
  }

  try {
    const url = `https://api.twelvedata.com/economic_calendar?from=${from}&to=${to}&apikey=${key}`;
    const res  = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 300 }, // 5分キャッシュ
    });

    if (!res.ok) {
      throw new Error(`Twelve Data HTTP ${res.status}`);
    }

    const raw  = await res.json() as TDCalendarResponse;

    // エラーレスポンス確認
    if (raw.status && raw.status !== "ok") {
      throw new Error(`Twelve Data error: code=${raw.code} status=${raw.status}`);
    }

    const list = raw.result?.list ?? [];

    const events: CalEvent[] = list.map((item, i) => {
      // Twelve Data の datetime は "YYYY-MM-DD HH:mm:ss" 形式 (UTC)
      const utcStr = item.datetime.replace(" ", "T") + "Z";
      const time   = Math.floor(new Date(utcStr).getTime() / 1000);
      return {
        id:       `td_${i}_${item.datetime}`,
        time,
        currency: item.currency ?? guessCurrency(item.country),
        country:  item.country,
        title:    item.title,
        impact:   IMPACT_MAP[item.impact?.toLowerCase()] ?? 1,
        actual:   item.actual   || null,
        forecast: item.forecast || null,
        previous: item.prev     || null,
      };
    });

    // Supabase に非同期保存（バックグラウンド）
    void upsertEconomicEvents(events.map(e => ({
      event_id:   e.id,
      event_time: new Date(e.time * 1000).toISOString(),
      currency:   e.currency,
      country:    e.country,
      title:      e.title,
      impact:     e.impact,
      actual:     e.actual   ?? null,
      forecast:   e.forecast ?? null,
      previous:   e.previous ?? null,
    })));

    return NextResponse.json(
      {
        events,
        meta: {
          source: "twelve_data",
          isDemo: false,
          dateJST,
          range,
          fetchedAt,
        } satisfies CalMeta,
      },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[economic-calendar]", error);

    // 失敗時はデモデータを返さず、エラー状態を明示する
    return NextResponse.json({
      events: [] as CalEvent[],
      meta: {
        source: "none",
        isDemo: false,
        dateJST,
        range,
        fetchedAt,
        error,
      } satisfies CalMeta,
    });
  }
}

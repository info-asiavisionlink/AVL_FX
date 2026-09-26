// =================================================================
// POST /api/cron/sync-economic-calendar
// Vercel Cron: 0 */6 * * * (6時間ごと)
//
// Forex Factory からその週の経済指標を取得して
// economic_events テーブルに upsert する。
//
// これにより /api/watcher/m5-close の NEWS_EVENT トリガーが
// 実データで機能するようになる。
//
// GOLD に関連する主な通貨: USD / XAU
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";

export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const maxDuration = 30;

const CRON_SECRET = process.env.CRON_SECRET ?? "";

interface FFEvent {
  title:    string;
  country:  string;
  date:     string;   // "MM/DD/YYYY"
  time:     string;   // "00:00am" or "All Day" etc.
  impact:   string;   // "High" | "Medium" | "Low" | "Holiday" | "Non-Economic"
  forecast: string;
  previous: string;
}

// Forex Factory の country → ISO currency コード
const COUNTRY_CURRENCY: Record<string, string> = {
  USD: "USD", EUR: "EUR", GBP: "GBP", JPY: "JPY",
  AUD: "AUD", CAD: "CAD", CHF: "CHF", NZD: "NZD",
  CNY: "CNY", CNH: "CNH",
  XAU: "XAU",  // GOLD直接（まれ）
};

// impact 文字列 → 数値
const IMPACT_MAP: Record<string, number> = {
  "High":    3,
  "Medium":  2,
  "Low":     1,
  "Holiday": 1,
};

/**
 * Forex Factory の date フィールドを UTC ISO に変換。
 * FF API は "2026-09-21T06:30:00-04:00" のような ISO 8601 形式を返す。
 */
function parseFFDateTime(date: string, _time: string): string | null {
  try {
    if (!date) return null;
    // ISO 8601 形式（タイムゾーン付き）をそのまま Date に変換
    const dt = new Date(date);
    if (isNaN(dt.getTime())) return null;
    return dt.toISOString();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (CRON_SECRET && req.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();

  // Forex Factory からデータ取得
  let events: FFEvent[] = [];
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept":     "application/json, text/plain, */*",
        "Referer":    "https://www.forexfactory.com/",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `Forex Factory HTTP ${res.status}` }, { status: 502 });
    }

    const text = await res.text();
    if (text.trim().startsWith("<")) {
      return NextResponse.json({ error: "Forex Factory rate limited (HTML response)" }, { status: 429 });
    }

    events = JSON.parse(text) as FFEvent[];
  } catch (e) {
    return NextResponse.json({ error: `FF fetch failed: ${String(e).slice(0, 100)}` }, { status: 502 });
  }

  // GOLD (USD / XAU) に関連する高・中インパクトイベントをフィルタリング
  const targetCurrencies = new Set(["USD", "XAU"]);
  const minImpact = 2; // Medium 以上

  const rows = events
    .filter(e => {
      const currency = COUNTRY_CURRENCY[e.country] ?? e.country;
      const impact   = IMPACT_MAP[e.impact] ?? 0;
      return targetCurrencies.has(currency) && impact >= minImpact;
    })
    .map(e => {
      const currency  = COUNTRY_CURRENCY[e.country] ?? e.country;
      const impact    = IMPACT_MAP[e.impact] ?? 1;
      // _time は使わない（date フィールドに時刻込み）
      const eventTime = parseFFDateTime(e.date, "");
      if (!eventTime) return null;

      // event_id: date + currency + title のハッシュ（同一イベントのupsert用）
      const event_id = `ff_${e.date.slice(0, 10)}_${currency}_${e.title}`.replace(/\s+/g, "_").slice(0, 100);

      return {
        event_id,
        event_time: eventTime,
        currency,
        country:   e.country,
        title:     e.title,
        impact,
        forecast:  e.forecast || null,
        previous:  e.previous || null,
        actual:    null,  // FF のリアルタイム actual は別途更新
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, upserted: 0, message: "対象イベントなし" });
  }

  // Supabase に upsert
  const { error } = await db
    .from("economic_events")
    .upsert(rows, { onConflict: "event_id", ignoreDuplicates: false });

  if (error) {
    return NextResponse.json({ error: "upsert failed: " + error.message }, { status: 500 });
  }

  // 古いイベント（2週間以上前）を削除（テーブル肥大化防止）
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  await db.from("economic_events").delete().lt("event_time", twoWeeksAgo);

  return NextResponse.json({
    ok:        true,
    upserted:  rows.length,
    source:    "forex_factory",
    fetched_at: new Date().toISOString(),
    sample:    rows.slice(0, 3).map(r => r ? { title: r.title, event_time: r.event_time, impact: r.impact } : null),
  });
}

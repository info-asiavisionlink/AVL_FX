// =================================================================
// GET /api/market/external?symbols=DXY,US30,VIX,XAUUSD
// Twelve Data API のプロキシ（API キーをサーバー側で保持）
// =================================================================

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Twelve Data から返ってくる Quote 型（必要な項目のみ）
interface TDQuote {
  symbol:         string;
  name?:          string;
  exchange?:      string;
  close?:         string;
  change?:        string;
  percent_change?: string;
  is_market_open?: boolean;
  fifty_two_week?: { high: string; low: string };
}

export async function GET(req: NextRequest) {
  const apiKey = req.nextUrl.searchParams.get("key") || process.env.TWELVE_DATA_API_KEY || "";
  const symbols = req.nextUrl.searchParams.get("symbols") || "DXY,US30/USD,XAU/USD,VIX";

  if (!apiKey) {
    // キーなしでもデモデータを返す（UI の表示確認用）
    return NextResponse.json(demoData(symbols.split(",")));
  }

  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${apiKey}&dp=4`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Twelve Data ${res.status}`);

    const raw = await res.json() as Record<string, TDQuote> | TDQuote;

    // 単一シンボルの場合も配列に正規化
    const map: Record<string, TDQuote> = "symbol" in raw ? { [(raw as TDQuote).symbol]: raw as TDQuote } : raw as Record<string, TDQuote>;

    // symbol がない（エラーレスポンス等）エントリを除外
    const result = Object.values(map)
      .filter((q): q is TDQuote => typeof q?.symbol === "string")
      .map((q) => ({
        symbol:    q.symbol,
        name:      q.name ?? q.symbol,
        price:     parseFloat(q.close ?? "0"),
        change:    parseFloat(q.change ?? "0"),
        changePct: parseFloat(q.percent_change ?? "0"),
        isOpen:    q.is_market_open ?? false,
        high52:    parseFloat(q.fifty_two_week?.high ?? "0"),
        low52:     parseFloat(q.fifty_two_week?.low ?? "0"),
      }));

    return NextResponse.json({ data: result, source: "twelvedata", ts: Date.now() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[market/external]", msg);
    // エラーでもデモデータを返す
    return NextResponse.json({ data: demoData(symbols.split(",")), source: "demo", error: msg, ts: Date.now() });
  }
}

// APIキーなし / エラー時のデモデータ
function demoData(syms: string[]) {
  const DEMO: Record<string, { price: number; change: number; changePct: number }> = {
    "DXY":     { price: 103.45, change: 0.32,  changePct: 0.31  },
    "US30/USD":{ price: 39850, change: -125,  changePct: -0.31 },
    "XAU/USD": { price: 2340,  change: 8.5,   changePct: 0.36  },
    "VIX":     { price: 14.2,  change: -0.8,  changePct: -5.3  },
    "JP225/USD":{ price: 38500, change: 220,   changePct: 0.57  },
    "US100/USD":{ price: 17850, change: -85,   changePct: -0.47 },
  };
  return {
    data: syms.map(s => ({
      symbol:    s,
      name:      s,
      price:     DEMO[s]?.price    ?? 0,
      change:    DEMO[s]?.change   ?? 0,
      changePct: DEMO[s]?.changePct ?? 0,
      isOpen:    false,
    })),
    source: "demo",
    ts: Date.now(),
  };
}

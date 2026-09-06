import { NextRequest, NextResponse } from "next/server";

// TradingView Charting Library の UDF Datafeed プロキシ
// Phase1: MT5データをTradingViewのUDF形式で返す
// 参考: https://github.com/tradingview/charting-library-examples

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get("action");

  switch (action) {
    case "config":
      return NextResponse.json({
        supported_resolutions: ["1", "5", "15", "30", "60", "240", "D", "W", "M"],
        supports_group_request: false,
        supports_marks: false,
        supports_search: true,
        supports_timescale_marks: false,
      });

    case "symbol_info":
      return NextResponse.json({
        symbol: searchParams.get("symbol") ?? "EURUSD",
        full_name: searchParams.get("symbol") ?? "EURUSD",
        description: searchParams.get("symbol") ?? "EURUSD",
        exchange: "FOREX",
        type: "forex",
        timezone: "Etc/UTC",
        pricescale: 100000,
        has_intraday: true,
        has_no_volume: false,
        session: "24x7",
        minmov: 1,
      });

    case "history":
      // MT5 Gateway からバーデータをフェッチして UDF 形式に変換
      return await fetchHistory(searchParams);

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}

async function fetchHistory(params: URLSearchParams) {
  const symbol = params.get("symbol") ?? "EURUSD";
  const resolution = params.get("resolution") ?? "60";
  const from = params.get("from") ?? "0";
  const to = params.get("to") ?? String(Math.floor(Date.now() / 1000));

  const timeframe = resolutionToTimeframe(resolution);

  try {
    const query = new URLSearchParams({ symbol, timeframe, from, to });
    const res = await fetch(`${process.env.APP_URL ?? "http://localhost:3000"}/api/mt5/bars?${query}`);
    const bars = await res.json();

    if (!bars || bars.length === 0) {
      return NextResponse.json({ s: "no_data" });
    }

    return NextResponse.json({
      s: "ok",
      t: bars.map((b: { time: number }) => b.time),
      o: bars.map((b: { open: number }) => b.open),
      h: bars.map((b: { high: number }) => b.high),
      l: bars.map((b: { low: number }) => b.low),
      c: bars.map((b: { close: number }) => b.close),
      v: bars.map((b: { volume: number }) => b.volume),
    });
  } catch {
    return NextResponse.json({ s: "no_data" });
  }
}

function resolutionToTimeframe(resolution: string): string {
  const map: Record<string, string> = {
    "1": "M1", "5": "M5", "15": "M15", "30": "M30",
    "60": "H1", "240": "H4", "D": "D1", "W": "W1", "M": "MN",
  };
  return map[resolution] ?? "H1";
}

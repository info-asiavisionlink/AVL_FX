import { NextRequest, NextResponse } from "next/server";
import type { OHLCBar } from "@/types";

// MT5 Gateway からバーデータを取得するプロキシ
// TradingView Datafeed API からも呼び出される
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const symbol = searchParams.get("symbol");
  const timeframe = searchParams.get("timeframe");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!symbol || !timeframe || !from || !to) {
    return NextResponse.json({ error: "Missing required params" }, { status: 400 });
  }

  const gatewayUrl = process.env.MT5_GATEWAY_URL;
  if (!gatewayUrl) {
    return NextResponse.json([] as OHLCBar[]);
  }

  try {
    const params = new URLSearchParams({ symbol, timeframe, from, to });
    const res = await fetch(`${gatewayUrl}/bars?${params}`, {
      headers: {
        Authorization: `Bearer ${process.env.MT5_GATEWAY_SECRET}`,
      },
    });

    if (!res.ok) throw new Error(`MT5 Gateway error: ${res.status}`);

    const data = await res.json();
    return NextResponse.json(data as OHLCBar[]);
  } catch (error) {
    console.error("[mt5/bars]", error);
    return NextResponse.json([] as OHLCBar[], { status: 200 });
  }
}

// =================================================================
// GET /api/mt5/history?symbol=EURUSD
// Gateway から取引履歴を取得して Supabase に保存するプロキシ
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { upsertTrades, getRecentTrades } from "@/infrastructure/supabase/repository";

export const runtime = "nodejs";

interface GatewayDeal {
  ticket:      number;
  symbol:      string;
  type:        number;
  volume:      number;
  closeTime:   number;
  closePrice:  number;
  profit:      number;
  swap:        number;
  commission:  number;
  magic:       number;
}

export async function GET(req: NextRequest) {
  const symbol  = req.nextUrl.searchParams.get("symbol") ?? "EURUSD";
  const gwUrl   = process.env.MT5_GATEWAY_URL ?? "http://127.0.0.1:8080";
  const secret  = process.env.MT5_GATEWAY_SECRET ?? "";

  try {
    const res = await fetch(`${gwUrl}/history/${symbol.toUpperCase()}`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal:  AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`Gateway ${res.status}`);

    const deals = await res.json() as GatewayDeal[];

    // Supabase にアップサート（非同期）
    if (deals.length > 0) {
      void upsertTrades(deals.map(d => ({
        ticket:      d.ticket,
        symbol:      d.symbol,
        type:        d.type,
        volume:      d.volume,
        close_time:  new Date(d.closeTime * 1000).toISOString(),
        close_price: d.closePrice,
        profit:      d.profit,
        swap:        d.swap,
        commission:  d.commission,
        magic:       d.magic,
      })));
    }

    return NextResponse.json(deals);
  } catch {
    // Gateway が落ちていても Supabase から返す
    const cached = await getRecentTrades(symbol, 100);
    if (cached.length > 0) {
      const fallback = cached.map(r => ({
        ticket:       r.ticket,
        symbol:       r.symbol,
        type:         r.type,
        volume:       r.volume,
        closeTime:    Math.floor(new Date(r.close_time).getTime() / 1000),
        closePrice:   r.close_price,
        profit:       r.profit,
        swap:         r.swap,
        commission:   r.commission,
        magic:        r.magic,
      }));
      return NextResponse.json(fallback);
    }
    return NextResponse.json([]);
  }
}

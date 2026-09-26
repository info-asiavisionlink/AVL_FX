import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/infrastructure/supabase/server";

export const runtime = "nodejs";

/** Customer-scoped history; never falls back to global Gateway state. */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "EURUSD").toUpperCase();
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: connection, error: connectionError } = await supabase
    .from("mt5_connections")
    .select("id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (connectionError) return NextResponse.json({ error: "Connection lookup failed" }, { status: 503 });
  if (!connection) return NextResponse.json({ error: "No MT5 connection" }, { status: 404 });

  const { data: deals, error: dealsError } = await supabase
    .from("live_deals")
    .select("deal_ticket,symbol,deal_type,volume,deal_time,price,profit,swap,commission,magic_number")
    .eq("user_id", user.id)
    .eq("connection_id", connection.id)
    .eq("symbol", symbol)
    .order("deal_time", { ascending: false })
    .limit(100);
  if (dealsError) return NextResponse.json({ error: "History unavailable" }, { status: 503 });

  return NextResponse.json((deals ?? []).map((deal) => ({
    ticket: deal.deal_ticket,
    symbol: deal.symbol,
    type: String(deal.deal_type).toUpperCase() === "SELL" ? 1 : 0,
    volume: deal.volume,
    closeTime: Math.floor(new Date(deal.deal_time).getTime() / 1000),
    closePrice: deal.price,
    profit: deal.profit ?? 0,
    swap: deal.swap ?? 0,
    commission: deal.commission ?? 0,
    magic: deal.magic_number ?? 0,
  })));
}

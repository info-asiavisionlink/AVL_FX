// =================================================================
// GET /api/live/connection/bars?symbol=XAUUSD&tf=H1&count=500[&connection_id=UUID]
// User MT5 の過去バーを取得（認証済み接続のGateway stateのみ）
// =================================================================
import { createServerClient } from "@supabase/ssr";
import { cookies }            from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const GATEWAY_URL    = process.env.MT5_GATEWAY_URL ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  const tf     = req.nextUrl.searchParams.get("tf")?.toUpperCase();
  const count  = Number(req.nextUrl.searchParams.get("count") ?? "500");
  const requestedConnectionId = req.nextUrl.searchParams.get("connection_id") ?? req.nextUrl.searchParams.get("connectionId");

  if (!symbol || !tf) {
    return NextResponse.json({ error: "symbol / tf required" }, { status: 400 });
  }

  // ユーザーの接続情報を確認
  let connectionQuery = supabase
    .from("mt5_connections")
    .select("id, last_heartbeat_at")
    .eq("user_id", user.id);
  if (requestedConnectionId) connectionQuery = connectionQuery.eq("id", requestedConnectionId);
  const { data: conn, error: connectionError } = await connectionQuery
    .order("created_at", { ascending: false }).limit(1).single();

  if (connectionError) return NextResponse.json({ error: "Connection ownership unavailable" }, { status: 503 });
  if (!conn) {
    return NextResponse.json({ error: "MT5未接続" }, { status: 404 });
  }

  const ageMs = Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime();
  const isOnline = ageMs < 120_000;

  // Gateway is the only customer-specific source. Do not fall back to the
  // symbol-only bar_data mirror, which cannot represent connection identity.
  if (isOnline && GATEWAY_URL && GATEWAY_SECRET) {
    try {
      const r = await fetch(
        `${GATEWAY_URL}/connections/${encodeURIComponent(conn.id)}/bars/${encodeURIComponent(symbol)}/${encodeURIComponent(tf)}?count=${count}`,
        {
          headers: {
            Authorization: `Bearer ${GATEWAY_SECRET}`,
            "x-internal-service-auth": GATEWAY_SECRET,
            "x-connection-id": conn.id,
          },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (r.ok) {
        const bars = await r.json() as unknown[];
        if (Array.isArray(bars) && bars.length > 0) {
          return NextResponse.json(bars);
        }
      }
      if (r.status === 404) return NextResponse.json({ error: "データなし" }, { status: 404 });
      return NextResponse.json({ error: "Gateway market data unavailable" }, { status: 503 });
    } catch {
      return NextResponse.json({ error: "Gateway接続エラー" }, { status: 503 });
    }
  }
  return NextResponse.json({ error: "Gateway market data unavailable" }, { status: 503 });
}

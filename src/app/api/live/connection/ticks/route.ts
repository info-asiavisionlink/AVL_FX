// =================================================================
// GET /api/live/connection/ticks?symbol=EURUSD[&connection_id=UUID]
// Authenticated UserのMT5からのリアルタイムTick
// =================================================================
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
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

  const symbol = req.nextUrl.searchParams.get("symbol");
  const requestedConnectionId = req.nextUrl.searchParams.get("connection_id") ?? req.nextUrl.searchParams.get("connectionId");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  let connectionQuery = supabase
    .from("mt5_connections")
    .select("id, last_heartbeat_at")
    .eq("user_id", user.id);
  if (requestedConnectionId) connectionQuery = connectionQuery.eq("id", requestedConnectionId);
  const { data: conn, error: connectionError } = await connectionQuery
    .order("created_at", { ascending: false }).limit(1).single();

  if (connectionError) return NextResponse.json({ error: "Connection ownership unavailable" }, { status: 503 });
  if (!conn) return NextResponse.json({ error: "MT5未接続" }, { status: 404 });

  const ageMs = Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime();
  if (ageMs > 90_000) return NextResponse.json({ error: "MT5がオフライン", offline: true }, { status: 503 });

  if (!GATEWAY_URL || !GATEWAY_SECRET) return NextResponse.json({ error: "Gateway未設定" }, { status: 503 });

  try {
    const r = await fetch(`${GATEWAY_URL}/connections/${encodeURIComponent(conn.id)}/tick/${encodeURIComponent(symbol.toUpperCase())}`, {
      headers: {
        Authorization: `Bearer ${GATEWAY_SECRET}`,
        "x-internal-service-auth": GATEWAY_SECRET,
        "x-connection-id": conn.id,
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return NextResponse.json({ error: "データなし" }, { status: r.status });
    const tick = await r.json() as Record<string, unknown>;
    return NextResponse.json({ tick, connectionId: conn.id });
  } catch {
    return NextResponse.json({ error: "Gateway接続エラー" }, { status: 503 });
  }
}

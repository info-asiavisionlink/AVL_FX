// =================================================================
// GET /api/live/connection/bars?symbol=EURUSD&tf=H1&count=500
// Authenticated UserのMT5からのBarsをGatewayから取得
// User所有のconnection_idをServer-sideで確認してからGatewayへProxy
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
  const tf     = req.nextUrl.searchParams.get("tf");
  const count  = req.nextUrl.searchParams.get("count") ?? "500";

  if (!symbol || !tf) {
    return NextResponse.json({ error: "symbol / tf required" }, { status: 400 });
  }

  // Server-side ownership確認: このUserのアクティブ接続を取得
  const { data: conn } = await supabase
    .from("mt5_connections")
    .select("id, last_heartbeat_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!conn) {
    return NextResponse.json({ error: "MT5未接続" }, { status: 404 });
  }

  const ageMs = Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime();
  if (ageMs > 120_000) {
    return NextResponse.json({ error: "MT5がオフライン", offline: true, bars: [] }, { status: 503 });
  }

  if (!GATEWAY_URL || !GATEWAY_SECRET) {
    return NextResponse.json({ error: "Gateway未設定", bars: [] }, { status: 503 });
  }

  try {
    const r = await fetch(
      `${GATEWAY_URL}/connections/${conn.id}/bars/${encodeURIComponent(symbol.toUpperCase())}/${tf.toUpperCase()}?count=${count}`,
      {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!r.ok) {
      // Gateway上に対象connectionのBarがまだない（EA起動直後等）
      return NextResponse.json([], { status: 200 });
    }

    const bars = await r.json() as unknown[];
    return NextResponse.json(bars);
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}

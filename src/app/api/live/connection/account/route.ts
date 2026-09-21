// =================================================================
// GET /api/live/connection/account
// mt5_connections テーブルから口座情報を直接取得
// Heartbeat が更新する balance/equity/margin/free_margin/leverage を返す
// =================================================================
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
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

  const { data: conn, error } = await supabase
    .from("mt5_connections")
    .select("id, broker, server_name, mt5_login, account_currency, account_type, account_mode, leverage, status, last_heartbeat_at, balance, equity, margin, free_margin, margin_level, trading_enabled, emergency_stop")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !conn) {
    return NextResponse.json({ error: "MT5未接続" }, { status: 404 });
  }

  const ageMs = Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime();
  if (ageMs > 90_000) {
    return NextResponse.json({ error: "MT5がオフラインです", offline: true }, { status: 503 });
  }

  // Heartbeat で更新された口座情報を返す
  const account = {
    balance:     conn.balance     ?? 0,
    equity:      conn.equity      ?? 0,
    margin:      conn.margin      ?? 0,
    freeMargin:  conn.free_margin ?? 0,
    marginLevel: conn.margin_level ?? 0,
    leverage:    conn.leverage    ?? 0,
    currency:    conn.account_currency ?? "USD",
    broker:      conn.broker      ?? "",
  };

  return NextResponse.json({ account, connectionId: conn.id });
}

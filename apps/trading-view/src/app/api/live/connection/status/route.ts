// =================================================================
// GET /api/live/connection/status
// Authenticated UserのアクティブなMT5接続状態を返す
// Supabase mt5_connections + Gateway /connections/:id/status を合成
// =================================================================
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const GATEWAY_URL    = process.env.MT5_GATEWAY_URL ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

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

  // Supabaseから最新の接続を取得
  const { data: conn } = await supabase
    .from("mt5_connections")
    .select("id, broker, server_name, mt5_login, status, last_heartbeat_at, trading_enabled, emergency_stop, account_type, account_mode")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!conn) {
    return NextResponse.json({ connected: false, connection: null });
  }

  // heartbeat時刻からオンライン判定
  const lastHbAt = conn.last_heartbeat_at ? new Date(conn.last_heartbeat_at).getTime() : 0;
  const ageMs    = Date.now() - lastHbAt;
  const isOnline = lastHbAt > 0 && ageMs < 90_000; // 90秒以内

  // Gatewayのconnection stateも取得（オプション）
  let gatewayStatus: Record<string, unknown> | null = null;
  if (isOnline && GATEWAY_URL && GATEWAY_SECRET) {
    try {
      const r = await fetch(`${GATEWAY_URL}/connections/${conn.id}/status`, {
        headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) gatewayStatus = await r.json() as Record<string, unknown>;
    } catch { /* gateway may be unreachable, use Supabase data */ }
  }

  return NextResponse.json({
    connected:      true,
    online:         isOnline,
    connectionId:   conn.id,
    broker:         conn.broker,
    serverName:     conn.server_name,
    mt5Login:       conn.mt5_login,
    accountType:    conn.account_type,
    accountMode:    conn.account_mode,
    tradingEnabled: conn.trading_enabled,
    emergencyStop:  conn.emergency_stop,
    lastHeartbeatAt: conn.last_heartbeat_at,
    ageSeconds:     Math.floor(ageMs / 1000),
    gatewayStatus,
  });
}

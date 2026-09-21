// =================================================================
// GET /api/live/connection/account
// Authenticated UserのMT5口座情報をGatewayから取得
// User A が User B の口座情報を取得できないよう Server-side で所有権確認
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

  // ユーザーのアクティブ接続を取得
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
  if (ageMs > 90_000) {
    return NextResponse.json({ error: "MT5がオフラインです", offline: true }, { status: 503 });
  }

  if (!GATEWAY_URL || !GATEWAY_SECRET) {
    return NextResponse.json({ error: "Gateway未設定" }, { status: 503 });
  }

  try {
    const r = await fetch(`${GATEWAY_URL}/account`, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!r.ok) {
      return NextResponse.json({ error: "Gatewayからデータ取得失敗" }, { status: r.status });
    }

    const account = await r.json() as Record<string, unknown>;
    return NextResponse.json({ account, connectionId: conn.id });
  } catch {
    return NextResponse.json({ error: "Gateway接続エラー" }, { status: 503 });
  }
}

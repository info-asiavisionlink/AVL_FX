// =================================================================
// GET  /api/user/mt5-setup  — ユーザーの接続情報を取得
// POST /api/user/mt5-setup  — Token 再発行
// =================================================================
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// 認証確認用（publishable key）
async function getAuthSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  );
}

// DB操作用（service role — RLS をバイパス）
function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// GET — 現在の接続情報を取得
export async function GET() {
  const supabase = await getAuthSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = getAdminSupabase();
  const { data } = await admin
    .from("mt5_connections")
    .select("id, status, last_heartbeat_at, broker, server_name, mt5_login, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return NextResponse.json({
    connection: data ?? null,
    gatewayUrl: process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "",
  });
}

// POST — Token 再発行
export async function POST(req: Request) {
  // 認証確認
  const supabase = await getAuthSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const broker     = body.broker     || "XM";
  const serverName = body.serverName || "XMTrading-MT5";
  const mt5Login   = body.mt5Login   || 0;

  // トークン生成（Web Crypto API）
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const connectionToken = Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("");

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(connectionToken));
  const tokenHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  const admin = getAdminSupabase();

  // 既存確認
  const { data: existing } = await admin
    .from("mt5_connections")
    .select("id")
    .eq("user_id", user.id)
    .single();

  let data, error;

  if (existing) {
    // トークンのみ UPDATE（FK制約があるため DELETE 不可）
    ({ data, error } = await admin
      .from("mt5_connections")
      .update({
        connection_token_hash: tokenHash,
        broker,
        server_name:   serverName,
        mt5_login:     mt5Login,
        status:        "PENDING",
      })
      .eq("user_id", user.id)
      .select("id, broker, server_name, mt5_login, status, created_at")
      .single());
  } else {
    // 新規 INSERT
    ({ data, error } = await admin
      .from("mt5_connections")
      .insert({
        user_id:               user.id,
        connection_token_hash: tokenHash,
        broker,
        server_name:           serverName,
        mt5_login:             mt5Login,
        account_currency:      "USD",
        account_type:          "REAL",
        account_mode:          "HEDGING",
        leverage:              100,
      })
      .select("id, broker, server_name, mt5_login, status, created_at")
      .single());
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    connection: data,
    connectionToken,
    gatewayUrl: process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "",
    message: "接続情報を発行しました。EAに入力してください。",
  }, { status: 201 });
}

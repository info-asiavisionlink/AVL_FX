// =================================================================
// GET  /api/user/mt5-setup  — ユーザーの接続情報を取得（なければ自動作成）
// POST /api/user/mt5-setup  — 既存接続を削除して再発行
// =================================================================
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";

async function getSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  );
}

// GET — 現在の接続情報を取得
export async function GET() {
  const supabase = await getSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
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

// POST — 新しいConnection Token を発行（既存があれば削除して再作成）
export async function POST(req: Request) {
  const supabase = await getSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const broker     = body.broker     || "XM";
  const serverName = body.serverName || "XMTrading-MT5";
  const mt5Login   = body.mt5Login   || 0;

  // 既存の接続を削除
  await supabase.from("mt5_connections").delete().eq("user_id", user.id);

  // 新しいConnection Token を生成
  const connectionToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(connectionToken).digest("hex");

  const { data, error } = await supabase
    .from("mt5_connections")
    .insert({
      user_id:               user.id,
      connection_token_hash: tokenHash,
      broker,
      server_name:           serverName,
      mt5_login:             mt5Login,
      account_currency:      "USD",
      account_type:          "real",
      account_mode:          "live",
      leverage:              100,
    })
    .select("id, broker, server_name, mt5_login, status, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    connection: data,
    connectionToken,   // ← EAに入力する値。一度しか返さない
    gatewayUrl: process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "",
    message: "接続情報を発行しました。EAに入力してください。",
  }, { status: 201 });
}

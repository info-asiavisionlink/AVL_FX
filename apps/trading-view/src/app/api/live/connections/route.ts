import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { CreateMT5ConnectionSchema } from "@/domain/live-trading/schemas";
import { createHash, randomBytes } from "crypto";

// GET /api/live/connections — 自分のMT5接続一覧
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

  const { data, error } = await supabase
    .from("mt5_connections")
    .select("id, broker, server_name, mt5_login, account_currency, account_type, account_mode, leverage, status, emergency_stop, trading_enabled, last_heartbeat_at, connected_at, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // connection_token_hash は返さない（セキュリティ）
  return NextResponse.json({ connections: data });
}

// POST /api/live/connections — MT5接続の登録
// Note: 実際のMT5 Passwordは受け取らない。Connection Tokenのみ発行。
export async function POST(req: Request) {
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

  const body = await req.json();
  const parsed = CreateMT5ConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Connection Tokenを生成してhashを保存（平文は返すが保存しない）
  const connectionToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(connectionToken).digest("hex");

  const { data, error } = await supabase
    .from("mt5_connections")
    .insert({
      user_id:               user.id,
      connection_token_hash: tokenHash,
      broker:                parsed.data.broker,
      server_name:           parsed.data.serverName,
      mt5_login:             parsed.data.mt5Login,
      account_currency:      parsed.data.accountCurrency,
      account_type:          parsed.data.accountType,
      account_mode:          parsed.data.accountMode,
      leverage:              parsed.data.leverage,
    })
    .select("id, broker, server_name, mt5_login, account_currency, account_type, status, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "この口座は既に登録されています" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Connection Tokenは一度だけ返す（以後はhashのみ保持）
  return NextResponse.json({
    connection: data,
    connectionToken,  // Bridge EAに入力する値。この後は再取得不可。
    message:    "接続を登録しました。Bridge EAにConnection Tokenを入力してください。",
  }, { status: 201 });
}

// POST /api/mt5/connections/token
//
// ログイン中ユーザーの mt5_connections に新しい Connection Token を発行する。
// - 平文トークンはこの1回のレスポンスにのみ含まれる（DB には SHA-256 ハッシュのみ保存）
// - 既存のトークンは無効化される（hash が上書きされる）
// - mt5_connections 行がない場合は新規作成する

import { NextResponse }       from "next/server";
import { createClient }       from "@/infrastructure/supabase/server";
import { createAdminClient }  from "@/infrastructure/supabase/admin";
import { createHash, randomBytes } from "crypto";

export const runtime = "nodejs";

export async function POST() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const db = createAdminClient();

  // 既存の接続行を取得
  const { data: existing } = await db
    .from("mt5_connections")
    .select("id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 新しい平文トークン（64バイト = 128文字 hex）を生成
  const plainToken = randomBytes(64).toString("hex");
  const tokenHash  = createHash("sha256").update(plainToken).digest("hex");

  if (existing) {
    // 既存行のトークンを更新
    const { error } = await db
      .from("mt5_connections")
      .update({ connection_token_hash: tokenHash })
      .eq("id", existing.id)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: `更新失敗: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok:           true,
      connection_id: existing.id,
      token:        plainToken,
      note:         "このトークンは一度しか表示されません。EAの InpConnectionToken に貼り付けてください。",
    });
  }

  // 接続行がない場合は新規作成
  const { data: created, error: createErr } = await db
    .from("mt5_connections")
    .insert({
      user_id:              user.id,
      connection_token_hash: tokenHash,
      broker:               "Unknown",
      server_name:          "Unknown",
      mt5_login:            0,
      account_currency:     "USD",
      account_type:         "DEMO",
    })
    .select("id")
    .single();

  if (createErr || !created) {
    return NextResponse.json({ error: `作成失敗: ${createErr?.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok:            true,
    connection_id: created.id,
    token:         plainToken,
    note:          "このトークンは一度しか表示されません。EAの InpConnectionToken に貼り付けてください。",
  });
}

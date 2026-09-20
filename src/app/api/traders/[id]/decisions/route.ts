// GET /api/traders/[id]/decisions — 保留中の判断一覧

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { createClient }               from "@/infrastructure/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const db = createAdminClient();

  // 期限切れを先に更新
  await db.from("trade_decisions")
    .update({ status: "EXPIRED" })
    .eq("ai_trader_id", id)
    .eq("user_id", user.id)
    .eq("status", "PENDING")
    .lt("expires_at", new Date().toISOString());

  const { data, error } = await db
    .from("trade_decisions")
    .select("*")
    .eq("ai_trader_id", id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ decisions: data ?? [] });
}

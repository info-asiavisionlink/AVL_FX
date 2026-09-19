// =================================================================
// GET    /api/traders/[id]  → 詳細取得（Knowledge付き）
// DELETE /api/traders/[id]  → ARCHIVE
// =================================================================

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

  // Trader + all versions
  const { data: trader, error } = await db
    .from("ai_traders")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !trader) return NextResponse.json({ error: "見つかりません" }, { status: 404 });

  // Current version + knowledge
  const { data: version } = await db
    .from("ai_trader_versions")
    .select("*")
    .eq("ai_trader_id", id)
    .eq("version", trader.current_version)
    .single();

  const { data: knowledge } = version
    ? await db
        .from("ai_trader_knowledge")
        .select("*")
        .eq("ai_trader_version_id", version.id)
    : { data: [] };

  return NextResponse.json({
    trader: {
      ...trader,
      current_profile: version ?? null,
      knowledge_list:  knowledge ?? [],
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const db = createAdminClient();
  const { error } = await db
    .from("ai_traders")
    .update({ status: "ARCHIVED", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

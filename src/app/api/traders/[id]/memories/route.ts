// =================================================================
// GET  /api/traders/[id]/memories  → 経験メモリー一覧
// PATCH /api/traders/[id]/memories/[memory_id] → status 変更（将来）
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { createClient }               from "@/infrastructure/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const db = createAdminClient();

  const { data: memories, error } = await db
    .from("experience_memories")
    .select("*")
    .eq("ai_trader_id", id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ memories: memories ?? [] });
}

// PATCH: status を手動変更（HYPOTHESIS → VALIDATED or REJECTED）
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const body = await req.json().catch(() => null) as {
    memory_id:       string;
    status:          "HYPOTHESIS" | "REVIEWED" | "RESEARCH_PENDING" | "VALIDATED" | "REJECTED";
    validation_note?: string; // VALIDATEDへの昇格理由（任意）
  } | null;

  if (!body?.memory_id || !body?.status) {
    return NextResponse.json({ error: "memory_id と status が必要です" }, { status: 400 });
  }

  const VALID_STATUSES = ["HYPOTHESIS", "REVIEWED", "RESEARCH_PENDING", "VALIDATED", "REJECTED"];
  if (!VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "不正な status です" }, { status: 400 });
  }

  const db = createAdminClient();

  // VALIDATED への直接昇格は REVIEWED 経由が必要
  if (body.status === "VALIDATED") {
    const { data: current } = await db
      .from("experience_memories")
      .select("status")
      .eq("id", body.memory_id)
      .eq("ai_trader_id", id)
      .eq("user_id", user.id)
      .single();

    if (current?.status === "HYPOTHESIS") {
      return NextResponse.json({
        error: "HYPOTHESIS から直接 VALIDATED には昇格できません。先に REVIEWED に変更してください。",
        hint:  "HYPOTHESIS → REVIEWED（自己レビュー完了）→ RESEARCH_PENDING（検証待ち）→ VALIDATED",
      }, { status: 409 });
    }
  }

  const updates: Record<string, string | null> = {
    status:          body.status,
    updated_at:      new Date().toISOString(),
    validation_note: body.validation_note ?? null,
  };

  if (body.status === "VALIDATED")  updates.validated_at = new Date().toISOString();
  if (body.status === "REVIEWED")   updates.reviewed_at  = new Date().toISOString();

  const { data, error } = await db
    .from("experience_memories")
    .update(updates)
    .eq("id", body.memory_id)
    .eq("ai_trader_id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, memory: data });
}

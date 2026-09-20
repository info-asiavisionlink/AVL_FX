// PATCH /api/traders/[id]/status — status 変更

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { createClient }               from "@/infrastructure/supabase/server";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const body = await req.json() as { status?: string };
  const newStatus = body.status;
  if (!newStatus || !["DRAFT", "ACTIVE", "ARCHIVED"].includes(newStatus)) {
    return NextResponse.json({ error: "status は DRAFT / ACTIVE / ARCHIVED のいずれか" }, { status: 400 });
  }

  const db = createAdminClient();
  const { error } = await db
    .from("ai_traders")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, status: newStatus });
}

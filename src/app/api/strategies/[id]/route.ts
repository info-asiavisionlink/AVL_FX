// =================================================================
// GET    /api/strategies/[id]  → 個別取得
// PUT    /api/strategies/[id]  → 更新
// DELETE /api/strategies/[id]  → 削除
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { type StrategyRecord }        from "@/lib/strategySchema";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ------------------------------------------------------------------
// GET — 個別取得
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("strategy_registry")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "見つかりません" }, { status: 404 });
    }

    return NextResponse.json({ strategy: data as StrategyRecord });
  } catch (err) {
    console.error("[GET /api/strategies/[id]]", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// PUT — 更新（name / enabled / status のみ Phase 1 で許可）
// ------------------------------------------------------------------

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const body = await req.json() as Partial<Pick<StrategyRecord,
      "name" | "enabled" | "status" | "description"
    >>;

    // 許可フィールドのみ抽出
    const allowed: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name        !== undefined) allowed.name        = body.name;
    if (body.enabled     !== undefined) allowed.enabled     = body.enabled;
    if (body.status      !== undefined) allowed.status      = body.status;
    if (body.description !== undefined) allowed.description = body.description;

    const db = createAdminClient();
    const { data, error } = await db
      .from("strategy_registry")
      .update(allowed)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ strategy: data as StrategyRecord });
  } catch (err) {
    console.error("[PUT /api/strategies/[id]]", err);
    return NextResponse.json({ error: "更新に失敗しました" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// DELETE — 削除（DRAFT のみ）
// ------------------------------------------------------------------

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const db = createAdminClient();

    // DRAFT 以外は削除禁止
    const { data: existing } = await db
      .from("strategy_registry")
      .select("status")
      .eq("id", id)
      .single();

    if (existing && existing.status !== "DRAFT") {
      return NextResponse.json(
        { error: "DRAFT 状態のみ削除できます" },
        { status: 403 }
      );
    }

    const { error } = await db
      .from("strategy_registry")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/strategies/[id]]", err);
    return NextResponse.json({ error: "削除に失敗しました" }, { status: 500 });
  }
}

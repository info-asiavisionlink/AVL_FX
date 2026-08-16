// =================================================================
// GET  /api/strategies   → Strategy 一覧
// POST /api/strategies   → Strategy 新規保存
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import { StrategySpecSchema, type StrategyRecord } from "@/lib/strategySchema";

export const runtime = "nodejs";

// ------------------------------------------------------------------
// GET — 一覧取得
// ------------------------------------------------------------------

export async function GET() {
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("strategy_registry")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ strategies: (data ?? []) as StrategyRecord[] });
  } catch (err) {
    console.error("[GET /api/strategies]", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// POST — 新規保存
// ------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      spec?:       unknown;
      raw_prompt?: string;
    };

    if (!body.spec) {
      return NextResponse.json({ error: "spec が必要です" }, { status: 400 });
    }

    // Zod 再バリデーション（フロントから直接 POST された場合も安全に）
    const validation = StrategySpecSchema.safeParse(body.spec);
    if (!validation.success) {
      return NextResponse.json(
        { error: "Strategy Spec が無効です", details: validation.error.issues },
        { status: 422 }
      );
    }

    const spec = validation.data;
    const db   = createAdminClient();

    // Magic Number 生成（20001 から連番）
    const { data: maxRow } = await db
      .from("strategy_registry")
      .select("magic_number")
      .not("magic_number", "is", null)
      .order("magic_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    const magicNumber = (maxRow?.magic_number ?? 20000) + 1;

    // DB 保存
    const { data: saved, error } = await db
      .from("strategy_registry")
      .insert({
        name:             spec.name,
        strategy_type:    spec.strategy_type,
        description:      spec.description ?? null,
        symbols:          spec.symbols,
        timeframes:       spec.timeframes,
        entry_conditions: spec.entry_conditions,
        exit_conditions:  spec.exit_conditions ?? null,
        filters:          spec.filters ?? null,
        risk:             spec.risk,
        magic_number:     magicNumber,
        enabled:          false,
        status:           "DRAFT",
        backtest_status:  "NOT_TESTED",
        raw_prompt:       body.raw_prompt ?? null,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ strategy: saved as StrategyRecord }, { status: 201 });

  } catch (err) {
    console.error("[POST /api/strategies]", err);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}

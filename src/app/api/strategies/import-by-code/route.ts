// POST /api/strategies/import-by-code
// 識別番号（16桁）からEAをインポートして自分のライブラリに追加

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/infrastructure/supabase/admin";
import { createClient }              from "@/infrastructure/supabase/server";
import { StrategySpecSchema, type StrategyRecord } from "@/lib/strategySchema";

export const runtime = "nodejs";

const CONSOLE_URL        = process.env.CONSOLE_URL        ?? "https://avl-fx-console.vercel.app";
const EA_REGISTRY_SECRET = process.env.EA_REGISTRY_SECRET ?? "";

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json() as { code?: string };
    if (!code || !/^\d{16}$/.test(code)) {
      return NextResponse.json({ error: "16桁の数字を入力してください" }, { status: 400 });
    }

    // Console から EA 仕様を取得
    const consRes = await fetch(`${CONSOLE_URL}/api/ea-registry/${code}`, {
      headers: { "x-ea-registry-secret": EA_REGISTRY_SECRET },
      signal:  AbortSignal.timeout(10_000),
    });

    if (!consRes.ok) {
      if (consRes.status === 404) return NextResponse.json({ error: "識別番号が見つかりません" }, { status: 404 });
      return NextResponse.json({ error: "EA取得に失敗しました" }, { status: 502 });
    }

    const ea = await consRes.json() as {
      share_code:      string;
      name:            string;
      strategy_type:   string;
      spec:            unknown;
      backtest_result?: unknown;
      raw_prompt?:     string | null;
    };

    // spec バリデーション
    const validation = StrategySpecSchema.safeParse(ea.spec);
    if (!validation.success) {
      return NextResponse.json({ error: "EA仕様が無効です" }, { status: 422 });
    }

    const spec = validation.data;
    const db   = createAdminClient();

    // ログインユーザーを取得
    let userId: string | null = null;
    try {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id ?? null;
    } catch { /* 未認証でも続行 */ }

    // 既に同じ識別番号を持つEAが自分のライブラリにあるか確認
    if (userId) {
      const { data: existing } = await db
        .from("strategy_registry")
        .select("id, name")
        .eq("share_code", code)
        .eq("user_id", userId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({ error: "この識別番号のEAはすでに追加済みです" }, { status: 409 });
      }
    }

    // Magic Number 連番
    const { data: maxRow } = await db
      .from("strategy_registry")
      .select("magic_number")
      .not("magic_number", "is", null)
      .order("magic_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    const magicNumber = (maxRow?.magic_number ?? 20000) + 1;

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
        raw_prompt:       ea.raw_prompt ?? null,
        user_id:          userId,
        share_code:       code,
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ strategy: saved as StrategyRecord }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/strategies/import-by-code]", err);
    return NextResponse.json({ error: "インポートに失敗しました" }, { status: 500 });
  }
}

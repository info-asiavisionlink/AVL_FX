// =================================================================
// GET  /api/strategies   → Strategy 一覧
// POST /api/strategies   → Strategy 新規保存
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import { createClient }                from "@/infrastructure/supabase/server";
import { StrategySpecSchema, type StrategyRecord } from "@/lib/strategySchema";
import {
  promotePreviewBacktest,
  type TradeForPromotion,
} from "@/infrastructure/backtest/BacktestService";
import type { BacktestReport } from "@/infrastructure/backtest/BacktestReporter";

export const runtime = "nodejs";

const CONSOLE_URL        = process.env.CONSOLE_URL        ?? "https://avl-fx-console.vercel.app";
const EA_REGISTRY_SECRET = process.env.EA_REGISTRY_SECRET ?? "";

function generateShareCode(): string {
  const first = String(Math.floor(Math.random() * 9) + 1);
  const rest  = Math.floor(Math.random() * 1e15).toString().padStart(15, "0");
  return first + rest;
}

async function registerToConsole(payload: {
  share_code:     string;
  tv_strategy_id: string;
  tv_user_id:     string | null;
  name:           string;
  strategy_type:  string;
  spec:           unknown;
  backtest_result?: unknown;
  raw_prompt?:    string | null;
}): Promise<void> {
  try {
    await fetch(`${CONSOLE_URL}/api/ea-registry`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-ea-registry-secret": EA_REGISTRY_SECRET },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10_000),
    });
  } catch {
    // Console 登録失敗でも TV 保存は成功とする
  }
}

// ------------------------------------------------------------------
// GET — 一覧取得
// ------------------------------------------------------------------

export async function GET() {
  try {
    const db = createAdminClient();

    // ユーザーIDを取得してフィルタリング
    let userId: string | null = null;
    try {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id ?? null;
    } catch { /* 未認証 */ }

    // ユーザーID指定あり: 自分のもの + 共有(null)を返す
    // 未認証: 共有データのみ返す
    const query = db.from("strategy_registry").select("*").order("created_at", { ascending: false });
    const { data, error } = userId
      ? await query.or(`user_id.is.null,user_id.eq.${userId}`)
      : await query.is("user_id", null);

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
      spec?:                unknown;
      raw_prompt?:          string;
      previewBacktestData?: {
        report:   BacktestReport;
        trades:   TradeForPromotion[];
        barCount: number;
      };
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

    // ユーザーIDを取得（ログイン済みの場合のみ紐付ける）
    let userId: string | null = null;
    try {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id ?? null;
    } catch { /* 未認証でも続行 */ }

    // Magic Number 生成（20001 から連番）
    const { data: maxRow } = await db
      .from("strategy_registry")
      .select("magic_number")
      .not("magic_number", "is", null)
      .order("magic_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    const magicNumber = (maxRow?.magic_number ?? 20000) + 1;

    // 16桁識別番号生成（衝突チェック付き）
    let shareCode = generateShareCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: exists } = await db.from("strategy_registry").select("id").eq("share_code", shareCode).maybeSingle();
      if (!exists) break;
      shareCode = generateShareCode();
    }

    // Backtest 昇格ありの場合: backtest_status を verdict から設定
    const backtestStatusFromPreview = body.previewBacktestData
      ? (body.previewBacktestData.report.verdict === "FAILED" ? "FAILED" : "PASSED")
      : "NOT_TESTED";

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
        backtest_status:  backtestStatusFromPreview,
        raw_prompt:       body.raw_prompt ?? null,
        user_id:          userId,
        share_code:       shareCode,
      })
      .select()
      .single();

    if (error) throw error;

    const strategyRecord = saved as StrategyRecord;
    const strategyId = strategyRecord.id;

    // Preview Backtest 結果を正式 DB 記録へ昇格（同じBacktestを再実行しない）
    if (body.previewBacktestData) {
      await promotePreviewBacktest({
        strategyId,
        report:   body.previewBacktestData.report,
        trades:   body.previewBacktestData.trades,
        barCount: body.previewBacktestData.barCount,
      });
    }

    // Console Supabase に EA を登録（非同期・失敗しても継続）
    void registerToConsole({
      share_code:     shareCode,
      tv_strategy_id: strategyId,
      tv_user_id:     userId,
      name:           spec.name,
      strategy_type:  spec.strategy_type,
      spec:           spec,
      backtest_result: body.previewBacktestData?.report ?? null,
      raw_prompt:     body.raw_prompt ?? null,
    });

    return NextResponse.json({ strategy: strategyRecord }, { status: 201 });

  } catch (err) {
    console.error("[POST /api/strategies]", err);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}

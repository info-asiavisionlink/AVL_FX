// =================================================================
// POST /api/ai/strategy/preview-backtest
//
// バックテストを Console API に委譲する。
// データは Console Supabase の bar_data（DataManager EA が蓄積）を使用。
// エンジンも Console 側で実行し、結果だけを受け取る。
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { StrategySpecSchema }        from "@/lib/strategySchema";

export const runtime    = "nodejs";
export const maxDuration = 90;

const CONSOLE_URL    = process.env.CONSOLE_URL    ?? process.env.NEXT_PUBLIC_CONSOLE_URL ?? "";
const BACKTEST_SECRET = process.env.CONSOLE_GATEWAY_SECRET ?? process.env.MT5_GATEWAY_SECRET ?? "";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { spec?: unknown };

    if (!body.spec) {
      return NextResponse.json({ success: false, error: "spec が必要です" }, { status: 400 });
    }

    // ── Zod バリデーション ────────────────────────────────────────
    const validation = StrategySpecSchema.safeParse(body.spec);
    if (!validation.success) {
      const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      return NextResponse.json({ success: false, error: "Strategy Spec が無効です", details: issues }, { status: 422 });
    }
    const spec = validation.data;

    // ── UNSUPPORTED 条件チェック ──────────────────────────────────
    const unsupported = spec.entry_conditions.conditions
      .filter(c => c.condition?.startsWith("UNSUPPORTED:"))
      .map(c => c.condition!.replace("UNSUPPORTED:", "").trim());

    if (unsupported.length > 0) {
      return NextResponse.json({
        success: false,
        error:   "バックテスト未対応の条件が含まれています",
        unsupported,
      }, { status: 422 });
    }

    if (!CONSOLE_URL) {
      return NextResponse.json({ success: false, error: "CONSOLE_URL 未設定" }, { status: 503 });
    }
    if (!BACKTEST_SECRET) {
      return NextResponse.json({ success: false, error: "CONSOLE_GATEWAY_SECRET 未設定" }, { status: 503 });
    }

    // ── Console バックテスト API を呼び出す ───────────────────────
    const consoleRes = await fetch(`${CONSOLE_URL}/api/research/backtest`, {
      method:  "POST",
      headers: {
        "Content-Type":     "application/json",
        "x-backtest-secret": BACKTEST_SECRET,
      },
      body:    JSON.stringify({ strategy_spec: spec }),
      signal:  AbortSignal.timeout(80_000),
    });

    const data = await consoleRes.json() as Record<string, unknown>;

    if (!consoleRes.ok || !data.success) {
      console.error("[preview-backtest] Console API error:", consoleRes.status, data);
      return NextResponse.json({
        success: false,
        error:   (data.error as string) ?? `Console API error: ${consoleRes.status}`,
      }, { status: consoleRes.ok ? 500 : consoleRes.status });
    }

    return NextResponse.json(data);

  } catch (e) {
    if ((e as Error)?.name === "TimeoutError") {
      return NextResponse.json({ success: false, error: "バックテストがタイムアウトしました" }, { status: 504 });
    }
    console.error("[preview-backtest]", e);
    return NextResponse.json({ success: false, error: "サーバーエラーが発生しました" }, { status: 500 });
  }
}

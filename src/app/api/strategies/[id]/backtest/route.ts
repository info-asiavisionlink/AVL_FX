// =================================================================
// GET /api/strategies/[id]/backtest
//
// Strategy の最新 Backtest 結果を返す。
// まだ実行されていない場合は NOT_TESTED を返す。
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getLatestBacktest }          from "@/infrastructure/backtest/BacktestService";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const data = await getLatestBacktest(id);
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "内部エラー";
    console.error("[GET /api/strategies/[id]/backtest]", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

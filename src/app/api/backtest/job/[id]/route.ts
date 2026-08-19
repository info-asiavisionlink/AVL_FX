// =================================================================
// GET /api/backtest/job/[id]
//
// Backtest Job の状態・結果・最新 50 件 Trade を返す。
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getJob }                    from "@/infrastructure/backtest/BacktestService";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const data = await getJob(id);
    if (!data.job) {
      return NextResponse.json({ error: "Job が見つかりません" }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "内部エラー";
    console.error("[GET /api/backtest/job/[id]]", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

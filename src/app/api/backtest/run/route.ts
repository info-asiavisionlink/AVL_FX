// =================================================================
// POST /api/backtest/run
//
// Strategy Backtest を実行して結果を返す。
// Phase 2-D: Vercel API Route で同期実行（最大 300s タイムアウト）。
// 将来: Railway Worker に移行可能な設計。
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { runBacktestJob, type PeriodLabel } from "@/infrastructure/backtest/BacktestService";

export const runtime = "nodejs";

const VALID_PERIODS: PeriodLabel[] = ["AVAILABLE", "1M", "3M", "6M", "1Y"];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      strategyId?:     string;
      period?:         unknown;
      initialBalance?: unknown;
    };

    // Validate
    if (!body.strategyId || typeof body.strategyId !== "string") {
      return NextResponse.json({ error: "strategyId が必要です" }, { status: 400 });
    }

    const period = (body.period ?? "AVAILABLE") as PeriodLabel;
    if (!VALID_PERIODS.includes(period)) {
      return NextResponse.json(
        { error: `period は ${VALID_PERIODS.join(", ")} のいずれかです` },
        { status: 400 }
      );
    }

    const initialBalance =
      typeof body.initialBalance === "number" && body.initialBalance > 0
        ? body.initialBalance
        : 10_000;

    // Execute
    const result = await runBacktestJob({
      strategyId: body.strategyId,
      period,
      initialBalance,
    });

    if (result.status === "FAILED") {
      return NextResponse.json(
        { jobId: result.jobId, status: "FAILED", error: result.error },
        { status: result.error === "Strategy not found" ? 404 : 500 }
      );
    }

    return NextResponse.json({
      jobId:  result.jobId,
      status: "COMPLETED",
      result: result.report,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "内部エラー";
    console.error("[POST /api/backtest/run]", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

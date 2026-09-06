// =================================================================
// GET /api/strategies/[id]/walk-forward/[jobId]
//
// Walk Forward Job 詳細 + 全Window結果
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; jobId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId, jobId } = await params;
  const db = createAdminClient();

  try {
    const { data: job, error: jobErr } = await db
      .from("walk_forward_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("strategy_id", strategyId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: "Walk Forward job not found" }, { status: 404 });
    }

    return NextResponse.json({ job });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/walk-forward/[jobId]]", err);
    return NextResponse.json({ error: "Failed to fetch walk forward job" }, { status: 500 });
  }
}

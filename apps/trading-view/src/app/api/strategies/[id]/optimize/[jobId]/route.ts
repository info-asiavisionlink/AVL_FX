// =================================================================
// GET /api/strategies/[id]/optimize/[jobId]
//
// 指定 OptimizationJob の詳細 + 全候補 (Rank順, 上位50件)
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";

export const runtime = "nodejs";

const CANDIDATES_RETURN_TOP = 50;

type Params = { params: Promise<{ id: string; jobId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId, jobId } = await params;
  const db = createAdminClient();

  try {
    // Job 取得 (strategy_id も確認)
    const { data: job, error: jobErr } = await db
      .from("optimization_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("strategy_id", strategyId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: "Optimization job not found" }, { status: 404 });
    }

    // Candidates 取得 (Rank順, Top 50)
    const { data: candidates } = await db
      .from("optimization_candidates")
      .select("*")
      .eq("job_id", jobId)
      .order("rank", { ascending: true, nullsFirst: false })
      .limit(CANDIDATES_RETURN_TOP);

    // 全候補数 (rank 有無に関わらず)
    const { count: allCount } = await db
      .from("optimization_candidates")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId);

    return NextResponse.json({
      job,
      candidates: candidates ?? [],
      allCount:   allCount  ?? 0,
    });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/optimize/[jobId]]", err);
    return NextResponse.json({ error: "Failed to fetch optimization job" }, { status: 500 });
  }
}

// =================================================================
// GET /api/strategies/[id]/versions/[version]
//
// Version 詳細 + 前 Version との Backtest 比較
//
// レスポンス:
//   version: full StrategyVersionRecord with spec_snapshot
//   comparison: compareVersions(v(N-1), v(N)) | null
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import {
  extractBacktestSummary,
} from "@/infrastructure/backtest/VersionSchema";
import { compareVersions }             from "@/infrastructure/backtest/VersionComparator";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; version: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId, version: versionStr } = await params;
  const versionNum = parseInt(versionStr, 10);
  const db = createAdminClient();

  if (isNaN(versionNum) || versionNum < 1) {
    return NextResponse.json({ error: "Invalid version number" }, { status: 400 });
  }

  try {
    // Target version 取得
    const { data: version, error: vErr } = await db
      .from("strategy_versions")
      .select("*")
      .eq("strategy_id", strategyId)
      .eq("version", versionNum)
      .single();

    if (vErr || !version) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }

    // Improvement 取得 (improvement_id があれば)
    let improvement: Record<string, unknown> | null = null;
    if ((version as Record<string, unknown>).improvement_id) {
      const { data: impr } = await db
        .from("strategy_improvements")
        .select("id,changes,expected_effects,risks,confidence,requires_more_data")
        .eq("id", (version as Record<string, unknown>).improvement_id as string)
        .maybeSingle();
      improvement = impr as Record<string, unknown> | null;
    }

    // 現バージョンの Backtest 結果
    let currBacktest = null;
    const bestJobId = (version as Record<string, unknown>).best_job_id as string | null;
    if (bestJobId) {
      const { data: br } = await db
        .from("backtest_results")
        .select("*")
        .eq("job_id", bestJobId)
        .maybeSingle();
      currBacktest = extractBacktestSummary(br as Record<string, unknown> | null);
    }

    // 前バージョンの Backtest 結果 (比較用)
    let comparison = null;
    const parentVersion = (version as Record<string, unknown>).parent_version as number | null;

    if (parentVersion && currBacktest) {
      const { data: prevVersionRow } = await db
        .from("strategy_versions")
        .select("best_job_id")
        .eq("strategy_id", strategyId)
        .eq("version", parentVersion)
        .maybeSingle();

      if (prevVersionRow?.best_job_id) {
        const { data: prevBr } = await db
          .from("backtest_results")
          .select("*")
          .eq("job_id", prevVersionRow.best_job_id as string)
          .maybeSingle();

        const prevBacktest = extractBacktestSummary(prevBr as Record<string, unknown> | null);
        if (prevBacktest) {
          comparison = compareVersions(prevBacktest, currBacktest);
        }
      }
    }

    return NextResponse.json({
      version:    { ...version, backtest: currBacktest, improvement },
      comparison,
    });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/versions/[version]]", err);
    return NextResponse.json({ error: "Failed to fetch version" }, { status: 500 });
  }
}

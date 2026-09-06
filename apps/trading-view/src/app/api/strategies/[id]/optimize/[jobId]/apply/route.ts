// =================================================================
// POST /api/strategies/[id]/optimize/[jobId]/apply
//
// Optimization Candidate → New Strategy Version
//
// Phase 4-A: Deterministic Parameter Optimization
//
// 重要: APPLY は絶対に自動化しない。
//   ユーザーが "APPLY RANK X" を押した場合のみ実行。
//
// 処理フロー (Phase 3-C の Version 作成と同一パターンを踏む):
//   1. Job + Candidate 取得・検証
//   2. Base StrategySpec 取得
//   3. param_set を Spec に適用 → proposed_spec
//   4. StrategySpecSchema 再検証
//   5. 次 Version 番号採番
//   6. strategy_versions INSERT
//   7. strategy_registry 更新
//   8. BacktestService でフル Backtest 実行 (DB 保存あり)
//   9. best_job_id 更新
//  10. candidate.adopted = true
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }          from "@/lib/strategySchema";
import { getNextVersion }              from "@/infrastructure/backtest/VersionSchema";
import { runBacktestJob }              from "@/infrastructure/backtest/BacktestService";
import { applyParameterSetToSpec }     from "@/infrastructure/backtest/OptimizationEngine";
import type { ParameterSet }           from "@/infrastructure/backtest/OptimizationEngine";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; jobId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId, jobId } = await params;
  const db = createAdminClient();

  let body: { candidateRank?: number };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { candidateRank } = body;
  if (!candidateRank || !Number.isInteger(candidateRank) || candidateRank < 1) {
    return NextResponse.json({ error: "candidateRank (integer >= 1) is required" }, { status: 400 });
  }

  try {
    // 1. Job 取得 (strategy_id 確認)
    const { data: job, error: jobErr } = await db
      .from("optimization_jobs")
      .select("id, strategy_id, status")
      .eq("id", jobId)
      .eq("strategy_id", strategyId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: "Optimization job not found" }, { status: 404 });
    }
    if ((job.status as string) !== "COMPLETED") {
      return NextResponse.json(
        { error: `Job status is "${job.status}" — must be COMPLETED to apply` },
        { status: 422 },
      );
    }

    // 2. Candidate 取得
    const { data: candidate, error: candErr } = await db
      .from("optimization_candidates")
      .select("id, param_set, rank, adopted, sample_status, oos_total_trades")
      .eq("job_id", jobId)
      .eq("rank", candidateRank)
      .single();

    if (candErr || !candidate) {
      return NextResponse.json({ error: `Candidate with rank ${candidateRank} not found` }, { status: 404 });
    }

    if (candidate.adopted as boolean) {
      return NextResponse.json(
        { error: "This candidate has already been adopted" },
        { status: 422 },
      );
    }

    // 3. Base StrategySpec 取得 (現在の strategy_registry から)
    const { data: stratRow, error: stratErr } = await db
      .from("strategy_registry")
      .select("*")
      .eq("id", strategyId)
      .single();

    if (stratErr || !stratRow) {
      return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
    }

    const rawSpec = {
      name:             stratRow.name,
      strategy_type:    stratRow.strategy_type,
      description:      stratRow.description,
      symbols:          stratRow.symbols,
      timeframes:       stratRow.timeframes,
      entry_conditions: stratRow.entry_conditions,
      exit_conditions:  stratRow.exit_conditions,
      filters:          stratRow.filters,
      risk:             stratRow.risk,
    };

    const baseSpecResult = StrategySpecSchema.safeParse(rawSpec);
    if (!baseSpecResult.success) {
      return NextResponse.json(
        { error: `Current strategy spec is invalid: ${baseSpecResult.error.message}` },
        { status: 422 },
      );
    }
    const baseSpec = baseSpecResult.data;

    // 4. param_set を Spec に適用 → proposed_spec
    let proposedSpec;
    try {
      proposedSpec = applyParameterSetToSpec(baseSpec, candidate.param_set as ParameterSet);
    } catch (applyErr: unknown) {
      const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
      return NextResponse.json({ error: `Failed to apply parameters: ${msg}` }, { status: 422 });
    }

    // 5. 次 Version 番号採番
    const { data: existingVersions } = await db
      .from("strategy_versions")
      .select("version")
      .eq("strategy_id", strategyId);

    const nextVersionNum = getNextVersion(
      (existingVersions ?? []) as Array<{ version: number }>
    );

    // change_summary: 変更したパラメータ一覧
    const paramSummary = Object.entries(candidate.param_set as ParameterSet)
      .map(([field, val]) => {
        const shortField = field
          .replace(/^entry_conditions\.conditions\[(\d+)\]\./, "cond[$1].")
          .replace(/^exit_conditions\./, "exit.")
          .replace(/^filters\./, "filter.");
        return `${shortField}=${val}`;
      })
      .join(", ");
    const changeSummary = `Optimization rank ${candidateRank}: ${paramSummary}`;

    // 6. strategy_versions INSERT
    const { data: newVersion, error: vInsertErr } = await db
      .from("strategy_versions")
      .insert({
        strategy_id:    strategyId,
        version:        nextVersionNum,
        spec_snapshot:  proposedSpec as unknown as Record<string, unknown>,
        created_by:     "user",    // Optimization はユーザー承認後の操作
        parent_version: nextVersionNum - 1 > 0 ? nextVersionNum - 1 : null,
        improvement_id: null,
        change_summary: changeSummary,
      })
      .select("id, version")
      .single();

    if (vInsertErr || !newVersion) {
      return NextResponse.json(
        { error: `Version creation failed: ${vInsertErr?.message}` },
        { status: 500 },
      );
    }

    // 7. strategy_registry を proposed_spec で更新
    const { error: regErr } = await db
      .from("strategy_registry")
      .update({
        name:             proposedSpec.name,
        strategy_type:    proposedSpec.strategy_type,
        description:      proposedSpec.description ?? null,
        symbols:          proposedSpec.symbols,
        timeframes:       proposedSpec.timeframes,
        entry_conditions: proposedSpec.entry_conditions,
        exit_conditions:  proposedSpec.exit_conditions ?? null,
        filters:          proposedSpec.filters ?? null,
        risk:             proposedSpec.risk,
        backtest_status:  "NOT_TESTED",
        updated_at:       new Date().toISOString(),
      })
      .eq("id", strategyId);

    if (regErr) {
      // ロールバック: 作成した Version を削除
      await db.from("strategy_versions").delete().eq("id", newVersion.id);
      return NextResponse.json(
        { error: `Registry update failed: ${regErr.message}` },
        { status: 500 },
      );
    }

    // 8. Backtest 実行 (フル Backtest, DB 保存あり)
    let backtestJobId: string | null = null;
    let backtestReport = null;

    try {
      const backtestResult = await runBacktestJob({
        strategyId,
        period:         "AVAILABLE",
        initialBalance: 10_000,
      });

      backtestJobId = backtestResult.jobId || null;
      backtestReport = backtestResult.report ?? null;

      // 9. best_job_id 更新
      if (backtestJobId) {
        await db
          .from("strategy_versions")
          .update({ best_job_id: backtestJobId })
          .eq("id", newVersion.id);
      }
    } catch (btErr) {
      // Backtest 失敗でも Version は保持
      console.warn("[optimize/apply] Backtest failed but version is preserved:", btErr);
    }

    // 10. candidate.adopted = true
    await db
      .from("optimization_candidates")
      .update({ adopted: true })
      .eq("id", candidate.id as string);

    return NextResponse.json({
      versionId:      newVersion.id,
      versionNumber:  newVersion.version,
      changeSummary,
      backtestJobId,
      backtestReport,
    });

  } catch (err) {
    console.error("[POST /api/strategies/[id]/optimize/[jobId]/apply]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

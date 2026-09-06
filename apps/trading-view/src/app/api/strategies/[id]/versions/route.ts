// =================================================================
// GET  /api/strategies/[id]/versions   → Version 一覧 + Backtest サマリー
// POST /api/strategies/[id]/versions   → Improvement APPLY → 新 Version 作成
//
// Phase 3-C: Version Management
//
// POST (action: "apply") フロー:
//   1. Strategy + Improvement 取得・検証
//   2. status 遷移バリデーション (PROPOSED → APPLIED)
//   3. proposed_spec の StrategySpecSchema 再検証
//   4. 次 Version 番号採番
//   5. strategy_versions INSERT
//   6. strategy_registry 更新 (proposed_spec で全フィールド更新)
//   7. strategy_improvements.status = APPLIED
//   8. Backtest 自動実行 (BacktestService.runBacktestJob)
//   9. best_job_id 更新
//  10. レスポンス返却
//
// 整合性確保:
//   Version 作成 → Registry 更新 が不分可分。
//   Registry 更新失敗時は Version を削除してロールバック。
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }          from "@/lib/strategySchema";
import {
  extractBacktestSummary,
  getNextVersion,
  isValidTransition,
  generateChangeSummary,
  type StrategyVersionRecord,
} from "@/infrastructure/backtest/VersionSchema";
import { runBacktestJob }              from "@/infrastructure/backtest/BacktestService";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ------------------------------------------------------------------
// GET — Version 一覧 + Backtest サマリー
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    // Versions 取得
    const { data: versions, error: vErr } = await db
      .from("strategy_versions")
      .select("id,version,created_by,parent_version,improvement_id,best_job_id,change_summary,created_at")
      .eq("strategy_id", strategyId)
      .order("version", { ascending: false });

    if (vErr) throw vErr;
    if (!versions || versions.length === 0) {
      return NextResponse.json({ versions: [] });
    }

    // Backtest サマリーを best_job_id から取得
    const jobIds = (versions as Array<Record<string, unknown>>)
      .map(v => v.best_job_id as string | null)
      .filter((id): id is string => !!id);

    const backtestByJobId: Record<string, ReturnType<typeof extractBacktestSummary>> = {};

    if (jobIds.length > 0) {
      const { data: results } = await db
        .from("backtest_results")
        .select("*")
        .in("job_id", jobIds);

      for (const r of (results ?? []) as Array<Record<string, unknown>>) {
        const jobId = r.job_id as string;
        backtestByJobId[jobId] = extractBacktestSummary(r);
      }
    }

    // Strategy の現在 Version (最大バージョン番号) を特定
    const maxVersion = Math.max(...(versions as Array<{version: number}>).map(v => v.version));

    const result: Array<StrategyVersionRecord & { isActive: boolean }> = (
      versions as Array<Record<string, unknown>>
    ).map(v => ({
      id:             v.id as string,
      strategy_id:    strategyId,
      version:        v.version as number,
      spec_snapshot:  {},   // lightweight list — detail は [version]/route で
      created_by:     v.created_by as "user" | "ai_improvement",
      parent_version: v.parent_version as number | null,
      improvement_id: v.improvement_id as string | null,
      best_job_id:    v.best_job_id as string | null,
      change_summary: v.change_summary as string | null,
      created_at:     v.created_at as string,
      isActive:       (v.version as number) === maxVersion,
      backtest:       v.best_job_id ? (backtestByJobId[v.best_job_id as string] ?? null) : null,
    }));

    return NextResponse.json({ versions: result });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/versions]", err);
    return NextResponse.json({ error: "Failed to fetch versions" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// POST — Improvement APPLY → 新 Version 作成
// ------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const body = await req.json() as { improvementId?: string; action?: string };

    if (body.action !== "apply") {
      return NextResponse.json(
        { error: 'action must be "apply"' },
        { status: 400 },
      );
    }
    if (!body.improvementId) {
      return NextResponse.json({ error: "improvementId is required" }, { status: 400 });
    }

    // 1. Strategy 取得
    const { data: stratRow, error: stratErr } = await db
      .from("strategy_registry")
      .select("*")
      .eq("id", strategyId)
      .single();

    if (stratErr || !stratRow) {
      return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
    }

    // 2. Improvement 取得
    const { data: imprRow, error: imprErr } = await db
      .from("strategy_improvements")
      .select("id,strategy_id,status,proposed_spec,changes")
      .eq("id", body.improvementId)
      .single();

    if (imprErr || !imprRow) {
      return NextResponse.json({ error: "Improvement not found" }, { status: 404 });
    }

    if ((imprRow.strategy_id as string) !== strategyId) {
      return NextResponse.json(
        { error: "Improvement does not belong to this strategy" },
        { status: 422 },
      );
    }

    // 3. 状態遷移バリデーション
    if (!isValidTransition(imprRow.status as string, "apply")) {
      return NextResponse.json(
        { error: `Cannot apply: improvement status is "${imprRow.status}" (must be PROPOSED)` },
        { status: 422 },
      );
    }

    // 4. proposed_spec 再バリデーション
    const specParse = StrategySpecSchema.safeParse(imprRow.proposed_spec);
    if (!specParse.success) {
      return NextResponse.json(
        { error: "proposed_spec is invalid", detail: specParse.error.message },
        { status: 422 },
      );
    }
    const proposedSpec = specParse.data;

    // 5. 次 Version 番号採番
    const { data: existingVersions } = await db
      .from("strategy_versions")
      .select("version")
      .eq("strategy_id", strategyId);

    const nextVersionNum = getNextVersion(
      (existingVersions ?? []) as Array<{ version: number }>
    );
    const currentVersionNum = nextVersionNum - 1;

    // 6. change_summary 生成
    const changes = (imprRow.changes as Parameters<typeof generateChangeSummary>[0]) ?? [];
    const changeSummary = generateChangeSummary(changes);

    // 7. strategy_versions INSERT
    const { data: newVersion, error: vInsertErr } = await db
      .from("strategy_versions")
      .insert({
        strategy_id:    strategyId,
        version:        nextVersionNum,
        spec_snapshot:  proposedSpec as unknown as Record<string, unknown>,
        created_by:     "ai_improvement",
        parent_version: currentVersionNum,
        improvement_id: body.improvementId,
        change_summary: changeSummary || null,
      })
      .select("id,version")
      .single();

    if (vInsertErr || !newVersion) {
      return NextResponse.json(
        { error: `Version creation failed: ${vInsertErr?.message}` },
        { status: 500 },
      );
    }

    // 8. strategy_registry を proposed_spec で更新
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
        backtest_status:  "NOT_TESTED",   // 新 Version は未テスト
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

    // 9. Improvement status = APPLIED (best effort — 失敗してもVersionは保持)
    await db
      .from("strategy_improvements")
      .update({ status: "APPLIED" })
      .eq("id", body.improvementId);

    // 10. Backtest 自動実行
    let backtestJobId: string | null = null;
    let backtestReport = null;

    try {
      const backtestResult = await runBacktestJob({
        strategyId,
        period:         "AVAILABLE",
        initialBalance: 10000,
      });

      backtestJobId = backtestResult.jobId || null;
      backtestReport = backtestResult.report ?? null;

      // 11. best_job_id 更新
      if (backtestJobId) {
        await db
          .from("strategy_versions")
          .update({ best_job_id: backtestJobId })
          .eq("id", newVersion.id);
      }
    } catch (btErr) {
      // Backtest 失敗でも Version は保持する
      console.warn("[versions/apply] Backtest failed but version is preserved:", btErr);
    }

    return NextResponse.json({
      versionId:      newVersion.id,
      versionNumber:  newVersion.version,
      backtestJobId,
      backtestReport,
    });

  } catch (err) {
    console.error("[POST /api/strategies/[id]/versions]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

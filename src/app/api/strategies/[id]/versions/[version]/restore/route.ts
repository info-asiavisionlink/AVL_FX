// =================================================================
// POST /api/strategies/[id]/versions/[version]/restore
//
// Rollback: 指定 Version の Spec を「新しい Version として」適用する。
//
// 設計原則:
//   - 過去 Version を削除・上書きしない
//   - Rollback 後も Backtest を実行し best_job_id を設定する
//   - change_summary: "Restored from version N"
//   - created_by: "user"
//   - parent_version: restore 元の version 番号
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }          from "@/lib/strategySchema";
import { getNextVersion }              from "@/infrastructure/backtest/VersionSchema";
import { runBacktestJob }              from "@/infrastructure/backtest/BacktestService";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; version: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id: strategyId, version: versionStr } = await params;
  const targetVersionNum = parseInt(versionStr, 10);
  const db = createAdminClient();

  if (isNaN(targetVersionNum) || targetVersionNum < 1) {
    return NextResponse.json({ error: "Invalid version number" }, { status: 400 });
  }

  try {
    // 1. Strategy 確認
    const { data: strat, error: stratErr } = await db
      .from("strategy_registry")
      .select("id")
      .eq("id", strategyId)
      .single();

    if (stratErr || !strat) {
      return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
    }

    // 2. 復元元 Version 取得
    const { data: targetVersion, error: tvErr } = await db
      .from("strategy_versions")
      .select("version,spec_snapshot")
      .eq("strategy_id", strategyId)
      .eq("version", targetVersionNum)
      .single();

    if (tvErr || !targetVersion) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }

    // 3. spec_snapshot を StrategySpecSchema で再検証
    const specParse = StrategySpecSchema.safeParse(targetVersion.spec_snapshot);
    if (!specParse.success) {
      return NextResponse.json(
        { error: "Target version spec is invalid", detail: specParse.error.message },
        { status: 422 },
      );
    }
    const restoredSpec = specParse.data;

    // 4. 次 Version 番号採番
    const { data: existingVersions } = await db
      .from("strategy_versions")
      .select("version")
      .eq("strategy_id", strategyId);

    const nextVersionNum = getNextVersion(
      (existingVersions ?? []) as Array<{ version: number }>
    );

    // 5. 新 Version INSERT (Restore は履歴追加)
    const { data: newVersion, error: vInsertErr } = await db
      .from("strategy_versions")
      .insert({
        strategy_id:    strategyId,
        version:        nextVersionNum,
        spec_snapshot:  restoredSpec as unknown as Record<string, unknown>,
        created_by:     "user",
        parent_version: targetVersionNum,
        improvement_id: null,
        change_summary: `Restored from version ${targetVersionNum}`,
      })
      .select("id,version")
      .single();

    if (vInsertErr || !newVersion) {
      return NextResponse.json(
        { error: `Version creation failed: ${vInsertErr?.message}` },
        { status: 500 },
      );
    }

    // 6. strategy_registry を復元 Spec で更新
    const { error: regErr } = await db
      .from("strategy_registry")
      .update({
        name:             restoredSpec.name,
        strategy_type:    restoredSpec.strategy_type,
        description:      restoredSpec.description ?? null,
        symbols:          restoredSpec.symbols,
        timeframes:       restoredSpec.timeframes,
        entry_conditions: restoredSpec.entry_conditions,
        exit_conditions:  restoredSpec.exit_conditions ?? null,
        filters:          restoredSpec.filters ?? null,
        risk:             restoredSpec.risk,
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

    // 7. Backtest 自動実行
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

      if (backtestJobId) {
        await db
          .from("strategy_versions")
          .update({ best_job_id: backtestJobId })
          .eq("id", newVersion.id);
      }
    } catch (btErr) {
      // Backtest 失敗でも Version は保持
      console.warn("[restore] Backtest failed but version is preserved:", btErr);
    }

    // 8. 元 Version (対象 Version) が変更されていないことを確認ログ
    console.info(
      `[restore] Strategy ${strategyId}: Restored v${targetVersionNum} as v${nextVersionNum}. ` +
      `Past versions are unchanged.`
    );

    return NextResponse.json({
      restoredFromVersion: targetVersionNum,
      newVersionId:        newVersion.id,
      newVersionNumber:    newVersion.version,
      backtestJobId,
      backtestReport,
    });

  } catch (err) {
    console.error("[POST /api/strategies/[id]/versions/[version]/restore]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

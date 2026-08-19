// =================================================================
// GET  /api/strategies/[id]/walk-forward   → 最新 Walk Forward Job
// POST /api/strategies/[id]/walk-forward   → Walk Forward 実行
//
// Phase 4-B: Walk Forward Validation
//
// POST フロー:
//   1. Strategy + Spec 取得・検証
//   2. parameterRanges + walkForward設定バリデーション
//   3. Bar Data 取得 (全TF、1回のみ)
//   4. walk_forward_jobs INSERT (RUNNING)
//   5. runWalkForward() 実行 (同期)
//   6. walk_forward_jobs 更新 (COMPLETED)
//   7. レスポンス返却
//
// 設計:
//   - 同期実行: 200 combos × 18 windows ≈ 45s → 300s以内
//   - Data Leakage防止: TEST barsはOptimizationに渡さない
//   - 自動Version作成なし: User Approvalが必須
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }          from "@/lib/strategySchema";
import type { Bar }                   from "@/infrastructure/analysis/types";
import {
  runWalkForward,
  validateWalkForwardConfig,
  estimateMaxWarmup,
  MONTH_MS,
  WF_MAX_COMBINATIONS,
  WF_MAX_WINDOWS,
} from "@/infrastructure/backtest/WalkForwardEngine";
import type { ParameterRange }        from "@/infrastructure/backtest/WalkForwardSchema";
import { countCombinations }           from "@/infrastructure/backtest/OptimizationEngine";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ------------------------------------------------------------------
// GET — 最新 Walk Forward Job
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const { data: jobs } = await db
      .from("walk_forward_jobs")
      .select("id, status, verdict, consistency_score, window_count, valid_window_count, normal_window_count, positive_window_count, skipped_window_count, parameter_ranges, train_months, test_months, step_months, recommended_params, parameter_stability, created_at, completed_at")
      .eq("strategy_id", strategyId)
      .eq("status", "COMPLETED")
      .order("created_at", { ascending: false })
      .limit(1);

    if (!jobs || jobs.length === 0) {
      return NextResponse.json({ status: "NOT_TESTED" });
    }

    return NextResponse.json({ status: "HAS_RESULT", job: jobs[0] });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/walk-forward]", err);
    return NextResponse.json({ error: "Failed to fetch walk forward job" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// POST — Walk Forward 実行
// ------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  let body: {
    parameterRanges?: ParameterRange[];
    trainMonths?:     number;
    testMonths?:      number;
    stepMonths?:      number;
    inSampleRatio?:   number;
    period?:          string;
    initialBalance?:  number;
    warmupSafetyMargin?: number;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    parameterRanges,
    trainMonths  = 3,
    testMonths   = 1,
    stepMonths   = testMonths,
    inSampleRatio = 0.8,
    period        = "AVAILABLE",
    initialBalance = 10_000,
    warmupSafetyMargin,
  } = body;

  if (!parameterRanges || !Array.isArray(parameterRanges) || parameterRanges.length === 0) {
    return NextResponse.json({ error: "parameterRanges is required" }, { status: 400 });
  }

  // 1. Strategy + Spec 取得
  const { data: strategyRow, error: stratErr } = await db
    .from("strategy_registry")
    .select("*")
    .eq("id", strategyId)
    .single();

  if (stratErr || !strategyRow) {
    return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
  }

  const rawSpec = {
    name:             strategyRow.name,
    strategy_type:    strategyRow.strategy_type,
    description:      strategyRow.description,
    symbols:          strategyRow.symbols,
    timeframes:       strategyRow.timeframes,
    entry_conditions: strategyRow.entry_conditions,
    exit_conditions:  strategyRow.exit_conditions,
    filters:          strategyRow.filters,
    risk:             strategyRow.risk,
  };

  const validation = StrategySpecSchema.safeParse(rawSpec);
  if (!validation.success) {
    return NextResponse.json({ error: `Invalid strategy spec: ${validation.error.message}` }, { status: 422 });
  }
  const spec = validation.data;

  if (spec.symbols.length !== 1) {
    return NextResponse.json({ error: "Multi-symbol strategies are not supported" }, { status: 422 });
  }
  const symbol = spec.symbols[0]!;
  const mainTf = spec.timeframes[0]!;

  // 2. Bar Data 取得 (全期間, 1回のみ)
  const validPeriods = ["AVAILABLE", "1M", "3M", "6M", "1Y"] as const;
  const PERIOD_DAYS: Record<string, number> = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 };
  if (!validPeriods.includes(period as typeof validPeriods[number])) {
    return NextResponse.json({ error: `Invalid period: ${period}` }, { status: 400 });
  }

  const fromDate: Date | null = period === "AVAILABLE"
    ? null
    : (() => { const d = new Date(); d.setDate(d.getDate() - PERIOD_DAYS[period]!); return d; })();

  const tfsSet = new Set<string>(spec.timeframes);
  for (const c of spec.entry_conditions.conditions) tfsSet.add(c.timeframe);
  if (spec.filters?.trend_filter) tfsSet.add(spec.filters.trend_filter.timeframe);

  const allBarsByTf: Record<string, Bar[]> = {};
  try {
    for (const tf of tfsSet) {
      let query = db
        .from("bar_data")
        .select("time_utc, open, high, low, close, volume")
        .eq("symbol", symbol)
        .eq("timeframe", tf)
        .order("time_utc", { ascending: true });
      if (fromDate) query = query.gte("time_utc", fromDate.toISOString());

      const { data, error } = await query;
      if (error) throw new Error(`bar_data fetch failed (${symbol} ${tf}): ${error.message}`);

      type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };
      allBarsByTf[tf] = (data as BarRow[] ?? []).map(r => ({
        time: new Date(r.time_utc).getTime(),
        open: Number(r.open), high: Number(r.high), low: Number(r.low),
        close: Number(r.close), volume: r.volume ?? 0,
      }));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Bar data fetch failed: ${msg}` }, { status: 500 });
  }

  const mainBars = allBarsByTf[mainTf] ?? [];
  if (mainBars.length === 0) {
    return NextResponse.json({ error: `No bar data for ${symbol} ${mainTf}` }, { status: 422 });
  }

  // 3. Config バリデーション
  const warmupEst = estimateMaxWarmup(spec, parameterRanges);
  const configValidation = validateWalkForwardConfig(
    { trainMonths, testMonths, stepMonths },
    parameterRanges, spec, mainBars.length, warmupEst,
  );
  if (!configValidation.valid) {
    return NextResponse.json({ error: configValidation.errors.join("; ") }, { status: 422 });
  }

  // 4. walk_forward_jobs INSERT (RUNNING)
  const { data: jobRow, error: jobErr } = await db
    .from("walk_forward_jobs")
    .insert({
      strategy_id:      strategyId,
      status:           "RUNNING",
      parameter_ranges: parameterRanges,
      train_months:     trainMonths,
      test_months:      testMonths,
      step_months:      stepMonths,
      in_sample_ratio:  inSampleRatio,
      data_from:        mainBars.length > 0 ? new Date(mainBars[0]!.time).toISOString() : null,
      data_to:          mainBars.length > 0 ? new Date(mainBars[mainBars.length - 1]!.time).toISOString() : null,
      started_at:       new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobErr || !jobRow) {
    return NextResponse.json({ error: `Job creation failed: ${jobErr?.message}` }, { status: 500 });
  }
  const jobId = jobRow.id as string;

  try {
    // 5. runWalkForward() (同期)
    const result = runWalkForward({
      spec,
      symbol,
      mainTimeframe:     mainTf,
      allBarsByTf,
      parameterRanges,
      trainMonths,
      testMonths,
      stepMonths,
      inSampleRatio,
      initialBalance,
      fixedLot:          0.01,
      warmupSafetyMargin,
    });

    // 6. walk_forward_jobs 更新 (COMPLETED)
    await db.from("walk_forward_jobs").update({
      status:                 "COMPLETED",
      window_count:           result.totalWindowCount,
      windows:                result.windows as unknown as Record<string, unknown>[],
      consistency_score:      result.consistencyScore,
      parameter_stability:    result.parameterStability,
      recommended_params:     result.recommendedParams,
      recommended_param_freq: result.recommendedParamFreq,
      valid_window_count:     result.validWindowCount,
      normal_window_count:    result.normalWindowCount,
      positive_window_count:  result.positiveWindowCount,
      skipped_window_count:   result.skippedWindowCount,
      verdict:                result.verdict,
      completed_at:           new Date().toISOString(),
    }).eq("id", jobId);

    return NextResponse.json({
      jobId,
      status:              "COMPLETED",
      verdict:             result.verdict,
      consistencyScore:    result.consistencyScore,
      parameterStability:  result.parameterStability,
      recommendedParams:   result.recommendedParams,
      recommendedParamFreq: result.recommendedParamFreq,
      totalWindowCount:    result.totalWindowCount,
      validWindowCount:    result.validWindowCount,
      normalWindowCount:   result.normalWindowCount,
      positiveWindowCount: result.positiveWindowCount,
      skippedWindowCount:  result.skippedWindowCount,
      windows:             result.windows,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/strategies/[id]/walk-forward]", err);

    try {
      await db.from("walk_forward_jobs").update({
        status:        "FAILED",
        error_message: msg,
        completed_at:  new Date().toISOString(),
      }).eq("id", jobId);
    } catch { /* ignore */ }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

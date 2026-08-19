// =================================================================
// GET  /api/strategies/[id]/optimize → 最新 OptimizationJob の状態と Top候補
// POST /api/strategies/[id]/optimize → Optimization 実行
//
// Phase 4-A: Deterministic Parameter Optimization
//
// POST フロー:
//   1. Strategy + Spec 取得・検証
//   2. parameterRanges バリデーション
//   3. Bar Data 取得 (1回だけ)
//   4. optimization_jobs INSERT (RUNNING)
//   5. runOptimization() 実行 (同期)
//   6. optimization_candidates batch INSERT
//   7. optimization_jobs 更新 (COMPLETED)
//   8. レスポンス返却 (top 50 candidates)
//
// 設計:
//   - 同期実行: 300s Vercel タイムアウト内で完結
//   - backtest_jobs / backtest_results は使用しない (candidates に直接保存)
//   - OOS はランキングに使用せず、最終検証値として保存するのみ
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }          from "@/lib/strategySchema";
import type { Bar }                   from "@/infrastructure/analysis/types";
import {
  runOptimization,
  validateParameterRanges,
  type ParameterRange,
  OPTIMIZATION_MAX_COMBINATIONS,
} from "@/infrastructure/backtest/OptimizationEngine";

export const runtime = "nodejs";

const CANDIDATE_BATCH_SIZE  = 100;
const CANDIDATES_RETURN_TOP = 50;

type Params = { params: Promise<{ id: string }> };

// ------------------------------------------------------------------
// GET — 最新 OptimizationJob の状態 + Top 候補
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const { data: jobs } = await db
      .from("optimization_jobs")
      .select("*")
      .eq("strategy_id", strategyId)
      .eq("status", "COMPLETED")
      .order("created_at", { ascending: false })
      .limit(1);

    if (!jobs || jobs.length === 0) {
      return NextResponse.json({ status: "NOT_OPTIMIZED" });
    }

    const job = jobs[0]!;

    const { data: candidates } = await db
      .from("optimization_candidates")
      .select("*")
      .eq("job_id", job.id as string)
      .order("rank", { ascending: true, nullsFirst: false })
      .limit(CANDIDATES_RETURN_TOP);

    return NextResponse.json({
      status:     "HAS_RESULT",
      job:        job,
      candidates: candidates ?? [],
    });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/optimize]", err);
    return NextResponse.json({ error: "Failed to fetch optimization" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// POST — Optimization 実行
// ------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  let body: {
    parameterRanges?: ParameterRange[];
    inSampleRatio?:   number;
    period?:          string;
    initialBalance?:  number;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { parameterRanges, inSampleRatio = 0.8, period = "AVAILABLE", initialBalance = 10_000 } = body;

  if (!parameterRanges || !Array.isArray(parameterRanges) || parameterRanges.length === 0) {
    return NextResponse.json({ error: "parameterRanges is required" }, { status: 400 });
  }

  if (inSampleRatio <= 0 || inSampleRatio >= 1) {
    return NextResponse.json({ error: "inSampleRatio must be between 0 and 1 (exclusive)" }, { status: 400 });
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

  // 2. ParameterRanges バリデーション
  const rangeValidation = validateParameterRanges(parameterRanges, spec);
  if (!rangeValidation.valid) {
    return NextResponse.json({ error: `Invalid parameter ranges: ${rangeValidation.errors.join("; ")}` }, { status: 422 });
  }

  // 3. Symbol 確認
  if (spec.symbols.length !== 1) {
    return NextResponse.json({ error: "Multi-symbol strategies are not supported" }, { status: 422 });
  }
  const symbol  = spec.symbols[0]!;
  const mainTf  = spec.timeframes[0]!;

  // 4. Bar Data 取得 (1回だけ)
  const validPeriods = ["AVAILABLE", "1M", "3M", "6M", "1Y"] as const;
  const PERIOD_DAYS: Record<string, number> = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 };
  const isValidPeriod = validPeriods.includes(period as typeof validPeriods[number]);
  if (!isValidPeriod) {
    return NextResponse.json({ error: `Invalid period: ${period}` }, { status: 400 });
  }

  const fromDate: Date | null = period === "AVAILABLE"
    ? null
    : (() => { const d = new Date(); d.setDate(d.getDate() - PERIOD_DAYS[period]!); return d; })();

  // Collect all required TFs
  const tfsSet = new Set<string>(spec.timeframes);
  for (const c of spec.entry_conditions.conditions) tfsSet.add(c.timeframe);
  if (spec.filters?.trend_filter) tfsSet.add(spec.filters.trend_filter.timeframe);
  const tfs = [...tfsSet];

  const barsByTf: Record<string, Bar[]> = {};
  try {
    for (const tf of tfs) {
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
      barsByTf[tf] = (data as BarRow[] ?? []).map(row => ({
        time:   new Date(row.time_utc).getTime(),
        open:   Number(row.open),
        high:   Number(row.high),
        low:    Number(row.low),
        close:  Number(row.close),
        volume: row.volume ?? 0,
      }));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Bar data fetch failed: ${msg}` }, { status: 500 });
  }

  const mainBars = barsByTf[mainTf] ?? [];
  if (mainBars.length === 0) {
    return NextResponse.json({ error: `No bar data available for ${symbol} ${mainTf}` }, { status: 422 });
  }

  // 5. optimization_jobs INSERT (RUNNING)
  const { data: jobRow, error: jobErr } = await db
    .from("optimization_jobs")
    .insert({
      strategy_id:      strategyId,
      status:           "RUNNING",
      algorithm:        "GRID",
      parameter_ranges: parameterRanges,
      in_sample_ratio:  inSampleRatio,
      started_at:       new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobErr || !jobRow) {
    return NextResponse.json({ error: `Job creation failed: ${jobErr?.message}` }, { status: 500 });
  }
  const jobId = jobRow.id as string;

  try {
    // 6. runOptimization() (同期)
    const result = runOptimization({
      spec,
      symbol,
      mainTimeframe:   mainTf,
      barsByTimeframe: barsByTf,
      parameterRanges,
      inSampleRatio,
      initialBalance,
      fixedLot:        0.01,
    });

    // 7. optimization_candidates batch INSERT
    const candidateRows = result.ranked.map(c => ({
      job_id:            jobId,
      strategy_id:       strategyId,
      grid_index:        c.index,
      rank:              c.rank ?? null,
      param_set:         c.paramSet,
      is_total_trades:   c.inSample.totalTrades,
      is_win_rate:       c.inSample.winRate,
      is_profit_factor:  c.inSample.profitFactor,
      is_total_pips:     c.inSample.totalPips,
      is_max_dd_pct:     c.inSample.maxDrawdownPct,
      oos_total_trades:  c.outSample.totalTrades,
      oos_win_rate:      c.outSample.winRate,
      oos_profit_factor: c.outSample.profitFactor,
      oos_total_pips:    c.outSample.totalPips,
      oos_max_dd_pct:    c.outSample.maxDrawdownPct,
      stability_score:   c.stabilityScore,
      degradation_ratio: c.degradationRatio,
      sample_status:     c.sampleStatus,
      adopted:           false,
    }));

    for (let i = 0; i < candidateRows.length; i += CANDIDATE_BATCH_SIZE) {
      const batch = candidateRows.slice(i, i + CANDIDATE_BATCH_SIZE);
      const { error: batchErr } = await db.from("optimization_candidates").insert(batch);
      if (batchErr) throw new Error(`Candidates insert failed: ${batchErr.message}`);
    }

    // 8. IS / OOS 時系列範囲を計算
    const cutoffDate = new Date(result.cutoffTime);
    const isFromDate = mainBars.length > 0 ? new Date(mainBars[0]!.time) : null;
    const isToDate   = mainBars.length > 0 ? new Date(mainBars[Math.max(0, Math.floor(mainBars.length * inSampleRatio) - 1)]!.time) : null;
    const oosToDate  = mainBars.length > 0 ? new Date(mainBars[mainBars.length - 1]!.time) : null;

    // 9. optimization_jobs 更新 (COMPLETED)
    await db.from("optimization_jobs").update({
      status:             "COMPLETED",
      total_combinations: result.candidates.length,
      in_sample_bars:     result.inSampleBarsCount,
      out_sample_bars:    result.outSampleBarsCount,
      in_sample_from:     isFromDate?.toISOString() ?? null,
      in_sample_to:       isToDate?.toISOString() ?? null,
      out_sample_from:    cutoffDate.toISOString(),
      out_sample_to:      oosToDate?.toISOString() ?? null,
      summary:            result.summary,
      completed_at:       new Date().toISOString(),
    }).eq("id", jobId);

    // 10. レスポンス (Top CANDIDATES_RETURN_TOP)
    const topCandidates = result.ranked.slice(0, CANDIDATES_RETURN_TOP);

    return NextResponse.json({
      jobId,
      status:           "COMPLETED",
      totalCombinations: result.candidates.length,
      inSampleBars:     result.inSampleBarsCount,
      outSampleBars:    result.outSampleBarsCount,
      cutoffTime:       result.cutoffTime,
      summary:          result.summary,
      candidates:       topCandidates,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/strategies/[id]/optimize]", err);

    // Job → FAILED
    try {
      await db.from("optimization_jobs").update({
        status:        "FAILED",
        error_message: msg,
        completed_at:  new Date().toISOString(),
      }).eq("id", jobId);
    } catch { /* ignore */ }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

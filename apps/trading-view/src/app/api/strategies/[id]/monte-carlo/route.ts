// =================================================================
// GET  /api/strategies/[id]/monte-carlo  → 最新 Monte Carlo 結果
// POST /api/strategies/[id]/monte-carlo  → Monte Carlo 実行
//
// Phase 4-C: Monte Carlo Simulation
//
// POST フロー:
//   1. Strategy + Spec 取得・検証
//   2. パラメータ バリデーション (iterations, seed, threshold)
//   3. Strategy Version 取得 (spec traceability)
//   4. (skip)
//   5. Bar Data 取得
//   6. runBacktest() で Trade[] 取得
//   7. Trade 数チェック (最低 MC_MIN_TRADES = 10)
//   8. runMonteCarlo() (Pure function — DB アクセスなし)
//   9. monte_carlo_results INSERT (strategy_version_id を含む)
//  10. レスポンス返却
//
// 設計:
//   - MonteCarloEngine から DB に直接アクセスしない
//   - MC 結果を Optimization / Walk Forward にフィードバックしない
//   - Version 自動作成なし
//   - AI 使用なし
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }          from "@/lib/strategySchema";
import type { Bar }                   from "@/infrastructure/analysis/types";
import { runBacktest }                 from "@/infrastructure/backtest/BacktestEngine";
import {
  runMonteCarlo,
  MC_MIN_TRADES,
  MC_MIN_ITERATIONS,
  MC_MAX_ITERATIONS,
  MC_DEFAULT_ITERATIONS,
  MC_DEFAULT_DRAWDOWN_THRESHOLD,
} from "@/infrastructure/backtest/MonteCarloEngine";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const VALID_PERIODS   = ["AVAILABLE", "1M", "3M", "6M", "1Y"] as const;
type  PeriodLabel     = typeof VALID_PERIODS[number];
const PERIOD_DAYS: Record<string, number> = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 };

// ------------------------------------------------------------------
// Helper: collect timeframes from spec
// ------------------------------------------------------------------

function collectTimeframes(spec: ReturnType<typeof StrategySpecSchema.parse>): string[] {
  const tfs = new Set<string>(spec.timeframes);
  for (const c of spec.entry_conditions.conditions) tfs.add(c.timeframe);
  if (spec.filters?.trend_filter) tfs.add(spec.filters.trend_filter.timeframe);
  return [...tfs];
}

// ------------------------------------------------------------------
// Helper: fetch bars
// ------------------------------------------------------------------

const FETCH_PAGE = 1000;

async function fetchBars(
  symbol:    string,
  timeframe: string,
  fromDate:  Date | null,
  db:        ReturnType<typeof createAdminClient>,
): Promise<Bar[]> {
  type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

  const allRows: BarRow[] = [];
  let offset = 0;
  for (;;) {
    let q = db
      .from("bar_data")
      .select("time_utc, open, high, low, close, volume")
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
      .order("time_utc", { ascending: true })
      .range(offset, offset + FETCH_PAGE - 1);
    if (fromDate) q = q.gte("time_utc", fromDate.toISOString());
    const { data, error } = await q;
    if (error) throw new Error(`bar_data fetch failed (${symbol} ${timeframe}): ${error.message}`);
    const rows = (data as BarRow[]) ?? [];
    allRows.push(...rows);
    if (rows.length < FETCH_PAGE) break;
    offset += FETCH_PAGE;
  }

  return allRows.map(row => ({
    time:   new Date(row.time_utc).getTime(),
    open:   Number(row.open),
    high:   Number(row.high),
    low:    Number(row.low),
    close:  Number(row.close),
    volume: row.volume ?? 0,
  }));
}

// ------------------------------------------------------------------
// GET — 最新 Monte Carlo 結果
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const { data: results } = await db
      .from("monte_carlo_results")
      .select("*")
      .eq("strategy_id", strategyId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (!results || results.length === 0) {
      return NextResponse.json({ status: "NOT_TESTED" });
    }

    return NextResponse.json({ status: "HAS_RESULT", result: results[0] });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/monte-carlo]", err);
    return NextResponse.json({ error: "Failed to fetch Monte Carlo result" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// POST — Monte Carlo 実行
// ------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  let body: {
    period?:               string;
    iterations?:           number;
    seed?:                 number;
    drawdownThresholdPct?: number;
    initialBalance?:       number;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    period              = "AVAILABLE",
    iterations          = MC_DEFAULT_ITERATIONS,
    drawdownThresholdPct = MC_DEFAULT_DRAWDOWN_THRESHOLD,
    initialBalance      = 10_000,
  } = body;

  // seed: 未指定ならランダム生成し DB に保存 (再現性のため)
  const seed = (typeof body.seed === "number")
    ? (Math.floor(body.seed) >>> 0)                // 正規化: unsigned 32-bit
    : Math.floor(Math.random() * 4_294_967_296);   // 0–2^32-1

  // --- バリデーション ---
  if (!VALID_PERIODS.includes(period as PeriodLabel)) {
    return NextResponse.json({ error: `Invalid period: ${period}` }, { status: 400 });
  }
  if (!Number.isInteger(iterations) || iterations < MC_MIN_ITERATIONS || iterations > MC_MAX_ITERATIONS) {
    return NextResponse.json(
      { error: `iterations must be an integer between ${MC_MIN_ITERATIONS} and ${MC_MAX_ITERATIONS} (got ${iterations})` },
      { status: 400 },
    );
  }
  if (!isFinite(drawdownThresholdPct) || drawdownThresholdPct <= 0 || drawdownThresholdPct > 100) {
    return NextResponse.json(
      { error: `drawdownThresholdPct must be between 0 and 100 (got ${drawdownThresholdPct})` },
      { status: 400 },
    );
  }
  if (!isFinite(initialBalance) || initialBalance <= 0) {
    return NextResponse.json({ error: "initialBalance must be a positive number" }, { status: 400 });
  }

  // 1. Strategy 取得
  const { data: strategyRow, error: stratErr } = await db
    .from("strategy_registry")
    .select("*")
    .eq("id", strategyId)
    .single();

  if (stratErr || !strategyRow) {
    return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
  }

  // 2. Spec 検証
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
    return NextResponse.json(
      { error: `Invalid strategy spec: ${validation.error.message}` },
      { status: 422 },
    );
  }
  const spec = validation.data;

  if (spec.symbols.length !== 1) {
    return NextResponse.json({ error: "Multi-symbol strategies are not supported" }, { status: 422 });
  }
  const symbol = spec.symbols[0]!;
  const mainTf = spec.timeframes[0]!;

  // 3. Strategy Version 取得 (MC 実行時点の正確な Spec を追跡するため)
  //    Phase 4-D AI が「どの Version の Spec に対する MC 結果か」を特定するために使用。
  //    strategy_versions が存在しない稀なケースは null とし、エラーにしない。
  const { data: latestVersion } = await db
    .from("strategy_versions")
    .select("id, version")
    .eq("strategy_id", strategyId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const strategyVersionId: string | null = latestVersion?.id ?? null;

  // 5. Bar Data 取得
  const fromDate: Date | null = period === "AVAILABLE"
    ? null
    : (() => { const d = new Date(); d.setDate(d.getDate() - PERIOD_DAYS[period]!); return d; })();

  const barsByTf: Record<string, Bar[]> = {};
  try {
    for (const tf of collectTimeframes(spec)) {
      barsByTf[tf] = await fetchBars(symbol, tf, fromDate, db);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Bar data fetch failed: ${msg}` }, { status: 500 });
  }

  const mainBars = barsByTf[mainTf] ?? [];
  if (mainBars.length === 0) {
    return NextResponse.json({ error: `No bar data for ${symbol} ${mainTf}` }, { status: 422 });
  }

  // 6. runBacktest() で Trade[] 取得
  let engineResult;
  try {
    engineResult = runBacktest({
      spec,
      symbol,
      mainTimeframe:   mainTf,
      barsByTimeframe: barsByTf,
      initialBalance,
      fixedLot:        0.01,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Backtest failed: ${msg}` }, { status: 422 });
  }

  // 7. Trade 数チェック
  const trades = engineResult.trades;
  if (trades.length < MC_MIN_TRADES) {
    return NextResponse.json(
      {
        error: `Insufficient trades for Monte Carlo (got ${trades.length}, minimum ${MC_MIN_TRADES}). ` +
               `Run the strategy over a longer period or adjust parameters to generate more trades.`,
        tradeCount: trades.length,
      },
      { status: 422 },
    );
  }

  // 8. runMonteCarlo() (Pure function — DB アクセスなし)
  const mcResult = runMonteCarlo({
    trades,
    iterations,
    seed,
    initialBalance,
    drawdownThresholdPct,
  });

  // 9. monte_carlo_results INSERT
  const dataFrom = engineResult.startTime > 0 ? new Date(engineResult.startTime).toISOString() : null;
  const dataTo   = engineResult.endTime   > 0 ? new Date(engineResult.endTime).toISOString()   : null;

  const { data: inserted, error: insertErr } = await db
    .from("monte_carlo_results")
    .insert({
      strategy_id:                        strategyId,
      strategy_version_id:                strategyVersionId,
      method:                             "TRADE_ORDER_SHUFFLE",
      iterations:                         mcResult.iterations,
      seed:                               mcResult.seed,
      drawdown_threshold_pct:             mcResult.drawdownThresholdPct,
      trade_count:                        mcResult.tradeCount,
      symbol,
      main_timeframe:                     mainTf,
      period_label:                       period,
      data_from:                          dataFrom,
      data_to:                            dataTo,
      initial_balance:                    mcResult.initialBalance,
      original_final_pips:                mcResult.originalMetrics.finalPips,
      original_final_profit:              mcResult.originalMetrics.finalProfit,
      original_max_dd_pct:                mcResult.originalMetrics.maxDrawdownPct,
      original_profit_factor:             mcResult.originalMetrics.profitFactor,
      original_win_rate:                  mcResult.originalMetrics.winRate,
      original_max_cons_losses:           mcResult.originalMetrics.maxConsecutiveLosses,
      probability_of_loss:                mcResult.probabilityOfLoss,
      probability_of_drawdown_threshold:  mcResult.probabilityOfDrawdownThreshold,
      original_percentile_rank:           mcResult.originalPercentileRank,
      distributions:                      mcResult.distributions as unknown as Record<string, unknown>,
      execution_ms:                       mcResult.executionMs,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("[POST /api/strategies/[id]/monte-carlo] insert error:", insertErr);
    return NextResponse.json({ error: `Failed to save result: ${insertErr?.message}` }, { status: 500 });
  }

  // 10. レスポンス
  return NextResponse.json({
    resultId:                         inserted.id,
    strategyVersionId,
    status:                           "COMPLETED",
    method:                           "TRADE_ORDER_SHUFFLE",
    iterations:                       mcResult.iterations,
    seed:                             mcResult.seed,
    tradeCount:                       mcResult.tradeCount,
    drawdownThresholdPct:             mcResult.drawdownThresholdPct,
    originalMetrics:                  mcResult.originalMetrics,
    distributions:                    mcResult.distributions,
    probabilityOfLoss:                mcResult.probabilityOfLoss,
    probabilityOfDrawdownThreshold:   mcResult.probabilityOfDrawdownThreshold,
    originalPercentileRank:           mcResult.originalPercentileRank,
    executionMs:                      mcResult.executionMs,
    dataFrom,
    dataTo,
  });
}

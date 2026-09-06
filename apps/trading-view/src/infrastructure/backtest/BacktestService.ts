// =================================================================
// BacktestService.ts — Backtest 実行オーケストレーター (Phase 2-D)
//
// Supabase bar_data → BacktestEngine → BacktestReporter → 保存
//
// runBacktestCore:   DB非依存コア（Preview Backtest用）
// runBacktestJob:    正式Strategyの Backtest Job 実行
// promotePreviewBacktest: Preview結果を正式DB記録へ昇格
// =================================================================

import { createAdminClient }  from "@/infrastructure/supabase/admin";
import { StrategySpecSchema } from "@/lib/strategySchema";
import type { StrategySpec }  from "@/lib/strategySchema";
import type { Bar }           from "@/infrastructure/analysis/types";
import { runBacktest }        from "./BacktestEngine";
import { generateReport, type BacktestReport } from "./BacktestReporter";
import { getSessionsAtTime }  from "./timeframe";
import type { BacktestTrade } from "./PositionManager";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const VALID_PERIODS = ["AVAILABLE", "1M", "3M", "6M", "1Y"] as const;
export type PeriodLabel = typeof VALID_PERIODS[number];

const PERIOD_DAYS: Record<string, number> = {
  "1M": 30, "3M": 90, "6M": 180, "1Y": 365,
};

const TRADE_BATCH_SIZE = 500;

// ------------------------------------------------------------------
// Input / Output types
// ------------------------------------------------------------------

export interface RunBacktestParams {
  strategyId:     string;
  period:         PeriodLabel;
  initialBalance?: number;
}

export interface RunBacktestResult {
  jobId:   string;
  status:  "COMPLETED" | "FAILED";
  report?: BacktestReport;
  error?:  string;
}

export interface GetJobResult {
  job:    Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  trades: Record<string, unknown>[];
}

export interface GetLatestResult {
  status:   "NOT_TESTED" | "HAS_RESULT";
  result?:  Record<string, unknown>;
  latestJob?: Record<string, unknown>;
}

// ------------------------------------------------------------------
// TradeForPromotion — Preview Backtest の trade を DB 昇格に使う型
// (client → server の JSON 境界を越えるため plain object)
// ------------------------------------------------------------------

export interface TradeForPromotion {
  symbol:        string;
  timeframe:     string;
  direction:     string;
  entryTime:     number;   // Unix ms
  entryPrice:    number;
  exitTime:      number;
  exitPrice:     number;
  sl:            number;
  tp:            number;
  lot:           number;
  pips:          number;
  result:        string;
  exitReason:    string;
  durationMin:   number;
  spreadPips:    number;
  slippagePips:  number;
  entryBarIdx:   number;
  exitBarIdx:    number;
}

// runBacktestCore の戻り値
export interface RunBacktestCoreResult {
  report:   BacktestReport;
  trades:   BacktestTrade[];
  barCount: number;
  warnings: string[];
}

// ------------------------------------------------------------------
// Helper: collect all timeframes from spec
// ------------------------------------------------------------------

function collectTimeframes(spec: StrategySpec): string[] {
  const tfs = new Set<string>(spec.timeframes);
  for (const c of spec.entry_conditions.conditions) tfs.add(c.timeframe);
  if (spec.filters?.trend_filter) tfs.add(spec.filters.trend_filter.timeframe);
  if (spec.filters?.trend_filters) {
    for (const tf of spec.filters.trend_filters) tfs.add(tf.timeframe);
  }
  return [...tfs];
}

// ------------------------------------------------------------------
// Helper: compute date range from period label
// ------------------------------------------------------------------

function getFromDate(period: PeriodLabel): Date | null {
  if (period === "AVAILABLE") return null;
  const days = PERIOD_DAYS[period];
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

// ------------------------------------------------------------------
// Helper: fetch bar_data from Supabase
// ------------------------------------------------------------------

const FETCH_BARS_PAGE_SIZE = 1000;

async function fetchBars(
  symbol:     string,
  timeframe:  string,
  fromDate:   Date | null,
  db:         ReturnType<typeof createAdminClient>,
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
      .order("time_utc", { ascending: true });

    if (fromDate) q = q.gte("time_utc", fromDate.toISOString());

    const { data, error } = await q.range(offset, offset + FETCH_BARS_PAGE_SIZE - 1);
    if (error) throw new Error(`bar_data fetch failed (${symbol} ${timeframe}): ${error.message}`);

    const rows = (data as BarRow[]) ?? [];
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < FETCH_BARS_PAGE_SIZE) break;
    offset += FETCH_BARS_PAGE_SIZE;
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
// Helper: map BacktestTrade to DB row
// ------------------------------------------------------------------

function tradeToRow(
  t:          BacktestTrade,
  jobId:      string,
  strategyId: string,
) {
  const sessions = getSessionsAtTime(t.entryTime);
  const session  = sessions.length === 0 ? "OFF" : sessions.length === 1 ? sessions[0] : "OVERLAP";
  return {
    job_id:        jobId,
    strategy_id:   strategyId,
    symbol:        t.symbol,
    entry_tf:      t.timeframe,
    direction:     t.direction,
    entry_time:    new Date(t.entryTime).toISOString(),
    entry_price:   t.entryPrice,
    exit_time:     new Date(t.exitTime).toISOString(),
    exit_price:    t.exitPrice,
    sl:            t.sl,
    tp:            t.tp,
    lot:           t.lot,
    pips:          t.pips,
    result:        t.result,
    exit_reason:   t.exitReason,
    duration_min:  t.durationMin,
    session,
    spread_pips:   t.spreadPips,
    slippage_pips: t.slippagePips,
    entry_bar_idx: t.entryBarIdx,
    exit_bar_idx:  t.exitBarIdx,
  };
}

// TradeForPromotion 版（構造は同一、型だけ異なる）
function promotionTradeToRow(
  t:          TradeForPromotion,
  jobId:      string,
  strategyId: string,
) {
  const sessions = getSessionsAtTime(t.entryTime);
  const session  = sessions.length === 0 ? "OFF" : sessions.length === 1 ? sessions[0] : "OVERLAP";
  return {
    job_id:        jobId,
    strategy_id:   strategyId,
    symbol:        t.symbol,
    entry_tf:      t.timeframe,
    direction:     t.direction,
    entry_time:    new Date(t.entryTime).toISOString(),
    entry_price:   t.entryPrice,
    exit_time:     new Date(t.exitTime).toISOString(),
    exit_price:    t.exitPrice,
    sl:            t.sl,
    tp:            t.tp,
    lot:           t.lot,
    pips:          t.pips,
    result:        t.result,
    exit_reason:   t.exitReason,
    duration_min:  t.durationMin,
    session,
    spread_pips:   t.spreadPips,
    slippage_pips: t.slippagePips,
    entry_bar_idx: t.entryBarIdx,
    exit_bar_idx:  t.exitBarIdx,
  };
}

// ------------------------------------------------------------------
// Helper: map BacktestReport to backtest_results row
// ------------------------------------------------------------------

function reportToRow(r: BacktestReport, jobId: string, strategyId: string) {
  return {
    job_id:                jobId,
    strategy_id:           strategyId,
    period_label:          r.periodLabel,
    data_from:             r.dataFrom > 0 ? new Date(r.dataFrom).toISOString() : null,
    data_to:               r.dataTo   > 0 ? new Date(r.dataTo).toISOString()   : null,
    data_source:           "bar_data",
    bar_count_used:        r.barCount,
    data_coverage_days:    r.dataCoverageDays,
    total_trades:          r.totalTrades,
    wins:                  r.wins,
    losses:                r.losses,
    breakevens:            r.breakevens,
    win_rate:              r.winRate,
    total_pips:            r.totalPips,
    avg_pips:              r.avgPips,
    gross_profit:          r.grossProfit,
    gross_loss:            r.grossLoss,
    profit_factor:         r.profitFactor,
    max_drawdown:          r.maxDrawdown,
    max_drawdown_pct:      r.maxDrawdownPct,
    max_drawdown_pips:     r.maxDrawdownPips,
    max_cons_wins:         r.maxConsecutiveWins,
    max_cons_losses:       r.maxConsecutiveLosses,
    avg_duration_min:      r.avgDurationMin,
    session_stats:         r.sessionStats,
    best_session:          r.bestSession,
    worst_session:         r.worstSession,
    sample_size_warning:   r.sampleSizeWarning,
    min_recommended_trades: r.minRecommendedTrades,
    verdict:               r.verdict,
    verdict_reason:        r.verdictReason,
  };
}

// ==================================================================
// runBacktestCore — DB非依存コア実行 (Preview Backtest 用)
// ==================================================================

export async function runBacktestCore(params: {
  spec:             StrategySpec;
  period?:          PeriodLabel;
  initialBalance?:  number;
}): Promise<RunBacktestCoreResult> {
  const { spec, period = "AVAILABLE", initialBalance = 10_000 } = params;

  if (spec.symbols.length !== 1) {
    throw new Error("マルチシンボル Strategy はサポートされていません");
  }
  const symbol = spec.symbols[0];
  const db     = createAdminClient();

  const fromDate   = getFromDate(period);
  const timeframes = collectTimeframes(spec);
  const mainTf     = spec.timeframes[0];

  const barsByTf: Record<string, Bar[]> = {};
  for (const tf of timeframes) {
    barsByTf[tf] = await fetchBars(symbol, tf, fromDate, db);
  }

  const mainBars = barsByTf[mainTf] ?? [];
  if (mainBars.length === 0) {
    throw new Error(`バーデータが見つかりません: ${symbol} ${mainTf}`);
  }

  const engineResult = runBacktest({
    spec,
    symbol,
    mainTimeframe:   mainTf,
    barsByTimeframe: barsByTf,
    initialBalance,
    fixedLot:        0.01,
  });

  const report = generateReport({
    engineResult,
    periodLabel: period,
    barCount:    mainBars.length,
  });

  return {
    report,
    trades:   engineResult.trades,
    barCount: mainBars.length,
    warnings: [],
  };
}

// ==================================================================
// runBacktestJob — 正式 Strategy ID ベースの Backtest 実行
// ==================================================================

export async function runBacktestJob(params: RunBacktestParams): Promise<RunBacktestResult> {
  const { strategyId, period, initialBalance = 10_000 } = params;
  const db = createAdminClient();

  // 1. Strategy 取得
  const { data: strategyRow, error: stratErr } = await db
    .from("strategy_registry")
    .select("*")
    .eq("id", strategyId)
    .single();

  if (stratErr || !strategyRow) {
    return { jobId: "", status: "FAILED", error: "Strategy not found" };
  }

  // 2. Spec バリデーション
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
    return { jobId: "", status: "FAILED", error: `Invalid spec: ${validation.error.message}` };
  }
  const spec = validation.data;

  // 3. Symbol 確認
  if (spec.symbols.length !== 1) {
    return { jobId: "", status: "FAILED", error: "Multi-symbol strategies not supported" };
  }

  // 4. Job 作成
  const { data: jobRow, error: jobErr } = await db
    .from("backtest_jobs")
    .insert({
      strategy_id:  strategyId,
      status:       "PENDING",
      period_label: period,
      created_at:   new Date().toISOString(),
    })
    .select()
    .single();

  if (jobErr || !jobRow) {
    return { jobId: "", status: "FAILED", error: `Job creation failed: ${jobErr?.message}` };
  }
  const jobId = jobRow.id as string;

  try {
    // 5. Status → RUNNING
    await db.from("backtest_jobs").update({
      status:     "RUNNING",
      started_at: new Date().toISOString(),
    }).eq("id", jobId);

    // 6-8. コア実行（DB 非依存）
    const coreResult = await runBacktestCore({ spec, period, initialBalance });

    // 9. Trades batch INSERT
    const tradeRows = coreResult.trades.map(t => tradeToRow(t, jobId, strategyId));
    for (let i = 0; i < tradeRows.length; i += TRADE_BATCH_SIZE) {
      const batch = tradeRows.slice(i, i + TRADE_BATCH_SIZE);
      const { error: tradeErr } = await db.from("backtest_trades").insert(batch);
      if (tradeErr) throw new Error(`Trades insert failed: ${tradeErr.message}`);
    }

    // 10. Results INSERT
    const { error: resultErr } = await db
      .from("backtest_results")
      .insert(reportToRow(coreResult.report, jobId, strategyId));
    if (resultErr) throw new Error(`Results insert failed: ${resultErr.message}`);

    // 11. strategy_registry.backtest_status 更新
    const newStatus = coreResult.report.verdict === "FAILED" ? "FAILED" : "PASSED";
    await db.from("strategy_registry").update({
      backtest_status: newStatus,
      updated_at:      new Date().toISOString(),
    }).eq("id", strategyId);

    // 12. Job → COMPLETED
    await db.from("backtest_jobs").update({
      status:       "COMPLETED",
      completed_at: new Date().toISOString(),
      data_from:    coreResult.report.dataFrom > 0 ? new Date(coreResult.report.dataFrom).toISOString() : null,
      data_to:      coreResult.report.dataTo   > 0 ? new Date(coreResult.report.dataTo).toISOString()   : null,
      bar_count:    coreResult.barCount,
      progress_pct: 100,
    }).eq("id", jobId);

    return { jobId, status: "COMPLETED", report: coreResult.report };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[BacktestService]", err);

    try {
      await db.from("backtest_jobs").update({
        status:        "FAILED",
        completed_at:  new Date().toISOString(),
        error_message: msg,
      }).eq("id", jobId);
    } catch { /* ignore */ }

    return { jobId, status: "FAILED", error: msg };
  }
}

// ==================================================================
// promotePreviewBacktest — Preview Backtest 結果を正式 DB 記録へ昇格
// ==================================================================

export async function promotePreviewBacktest(params: {
  strategyId: string;
  report:     BacktestReport;
  trades:     TradeForPromotion[];
  barCount:   number;
}): Promise<{ jobId: string }> {
  const { strategyId, report, trades, barCount } = params;
  const db  = createAdminClient();
  const now = new Date().toISOString();

  // Job 作成（最初から COMPLETED）
  const { data: jobRow, error: jobErr } = await db
    .from("backtest_jobs")
    .insert({
      strategy_id:  strategyId,
      status:       "COMPLETED",
      period_label: report.periodLabel,
      created_at:   now,
      started_at:   now,
      completed_at: now,
      data_from:    report.dataFrom > 0 ? new Date(report.dataFrom).toISOString() : null,
      data_to:      report.dataTo   > 0 ? new Date(report.dataTo).toISOString()   : null,
      bar_count:    barCount,
      progress_pct: 100,
    })
    .select()
    .single();

  if (jobErr || !jobRow) {
    throw new Error(`Job promotion failed: ${jobErr?.message}`);
  }
  const jobId = jobRow.id as string;

  // Results INSERT
  const { error: resultErr } = await db
    .from("backtest_results")
    .insert(reportToRow(report, jobId, strategyId));
  if (resultErr) throw new Error(`Results insert failed: ${resultErr.message}`);

  // Trades batch INSERT
  const tradeRows = trades.map(t => promotionTradeToRow(t, jobId, strategyId));
  for (let i = 0; i < tradeRows.length; i += TRADE_BATCH_SIZE) {
    const batch = tradeRows.slice(i, i + TRADE_BATCH_SIZE);
    const { error: tradeErr } = await db.from("backtest_trades").insert(batch);
    if (tradeErr) throw new Error(`Trades insert failed: ${tradeErr.message}`);
  }

  return { jobId };
}

// ==================================================================
// getJob — Job + Result + Trades 取得
// ==================================================================

export async function getJob(jobId: string): Promise<GetJobResult> {
  const db = createAdminClient();

  const [{ data: job }, { data: result }, { data: trades }] = await Promise.all([
    db.from("backtest_jobs").select("*").eq("id", jobId).single(),
    db.from("backtest_results").select("*").eq("job_id", jobId).single(),
    db.from("backtest_trades")
      .select("*")
      .eq("job_id", jobId)
      .order("entry_time", { ascending: true })
      .limit(50),
  ]);

  return {
    job:    job    ?? null,
    result: result ?? null,
    trades: (trades ?? []) as Record<string, unknown>[],
  };
}

// ==================================================================
// getLatestBacktest — Strategy の最新 Backtest 結果
// ==================================================================

export async function getLatestBacktest(strategyId: string): Promise<GetLatestResult> {
  const db = createAdminClient();

  const { data: jobs } = await db
    .from("backtest_jobs")
    .select("id, status, completed_at, created_at")
    .eq("strategy_id", strategyId)
    .eq("status", "COMPLETED")
    .order("created_at", { ascending: false })
    .limit(1);

  if (!jobs || jobs.length === 0) {
    return { status: "NOT_TESTED" };
  }

  const latestJob = jobs[0];
  const { data: result } = await db
    .from("backtest_results")
    .select("*")
    .eq("job_id", latestJob.id)
    .single();

  return {
    status:     "HAS_RESULT",
    result:     result ?? undefined,
    latestJob:  latestJob as Record<string, unknown>,
  };
}

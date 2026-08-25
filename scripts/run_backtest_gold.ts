/**
 * GOLD EAのバックテストをローカルエンジンで実行してDBに直接保存
 * トレードデータ (backtest_trades) も保存
 */
export {};

import type { Bar }         from "@/infrastructure/analysis/types";
import { runBacktest }      from "@/infrastructure/backtest/BacktestEngine";
import { generateReport }   from "@/infrastructure/backtest/BacktestReporter";
import { getSessionsAtTime } from "@/infrastructure/backtest/timeframe";
import type { StrategySpec } from "@/lib/strategySchema";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const hdrs   = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const jhdrs  = { ...hdrs, "Content-Type": "application/json", "Prefer": "return=representation" };

type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

async function fetchBarsWithRetry(sym: string, tf: string): Promise<Bar[]> {
  const rows: BarRow[] = [];
  let offset = 0;
  while (true) {
    let batch: BarRow[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume` +
          `&symbol=eq.${sym}&timeframe=eq.${tf}&order=time_utc.asc&limit=1000&offset=${offset}`,
          { headers: hdrs }
        );
        batch = await res.json() as BarRow[];
        break;
      } catch {
        if (attempt === 2) throw new Error(`fetch failed after 3 attempts`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows.map(r => ({ time: new Date(r.time_utc).getTime(), open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume: r.volume??0 }));
}

async function getGoldStrategies(): Promise<{ id: string; name: string; spec: StrategySpec }[]> {
  const res  = await fetch(
    `${SB_URL}/rest/v1/strategy_registry?name=like.GOLD%25&select=id,name,symbols,timeframes,entry_conditions,exit_conditions,filters,risk,strategy_type,description`,
    { headers: hdrs }
  );
  const rows = await res.json() as Record<string, unknown>[];
  return rows.map(r => ({ id: String(r.id), name: String(r.name), spec: r as unknown as StrategySpec }));
}

// 既存のRUNNING/COMPLETEDジョブをクリア
async function cleanOldJobs(strategyId: string): Promise<void> {
  await fetch(`${SB_URL}/rest/v1/backtest_jobs?strategy_id=eq.${strategyId}`, {
    method: "DELETE",
    headers: { ...hdrs, "Prefer": "return=minimal" },
  });
}

async function saveBacktestResult(strategyId: string, spec: StrategySpec, bars: Record<string, Bar[]>): Promise<{ wr: number; pips: number; verdict: string } | null> {
  // 1. 古いジョブをクリア
  await cleanOldJobs(strategyId);

  // 2. ジョブ作成
  const jobRes = await fetch(`${SB_URL}/rest/v1/backtest_jobs`, {
    method: "POST", headers: jhdrs,
    body: JSON.stringify({
      strategy_id: strategyId,
      status: "RUNNING",
      period_label: "AVAILABLE",
      created_at: new Date().toISOString(),
    }),
  });
  if (!jobRes.ok) { console.log("  job create failed:", await jobRes.text()); return null; }
  const jobData = await jobRes.json() as { id: string }[];
  const jobId   = jobData[0].id;

  // 3. バックテスト実行
  const symbol  = spec.symbols[0];
  const mainTf  = spec.timeframes[0];
  const engine  = runBacktest({
    spec, symbol, mainTimeframe: mainTf,
    barsByTimeframe: bars, initialBalance: 10000, fixedLot: 0.01,
  });
  const report  = generateReport({ engineResult: engine, periodLabel: "AVAILABLE", barCount: (bars[mainTf] ?? []).length });

  // 4. バックテスト結果保存
  const resultRow = {
    job_id: jobId, strategy_id: strategyId,
    period_label: "AVAILABLE",
    data_from: engine.trades.length > 0 ? new Date(engine.trades[0].entryTime).toISOString() : null,
    data_to:   engine.trades.length > 0 ? new Date(engine.trades[engine.trades.length-1].exitTime).toISOString() : null,
    data_source: "bar_data",
    bar_count_used: (bars[mainTf] ?? []).length,
    data_coverage_days: report.dataCoverageDays,
    total_trades: report.totalTrades, wins: report.wins, losses: report.losses, breakevens: report.breakevens,
    win_rate: report.winRate, total_pips: report.totalPips, avg_pips: report.avgPips,
    gross_profit: report.grossProfit, gross_loss: report.grossLoss, profit_factor: report.profitFactor,
    max_drawdown: report.maxDrawdown, max_drawdown_pct: report.maxDrawdownPct, max_drawdown_pips: report.maxDrawdownPips,
    max_cons_wins: report.maxConsecutiveWins, max_cons_losses: report.maxConsecutiveLosses,
    avg_duration_min: report.avgDurationMin,
    session_stats: report.sessionStats, best_session: report.bestSession, worst_session: report.worstSession,
    sample_size_warning: report.sampleSizeWarning, min_recommended_trades: report.minRecommendedTrades,
    verdict: report.verdict, verdict_reason: report.verdictReason,
  };

  const rRes = await fetch(`${SB_URL}/rest/v1/backtest_results`, {
    method: "POST", headers: { ...hdrs, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify(resultRow),
  });
  if (!rRes.ok) { console.log("  result save failed:", await rRes.text()); return null; }

  // 5. トレードデータ保存（バッチ500件）
  const BATCH = 500;
  const tradeRows = engine.trades.map(t => {
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
  });

  for (let i = 0; i < tradeRows.length; i += BATCH) {
    const batch = tradeRows.slice(i, i + BATCH);
    const tRes = await fetch(`${SB_URL}/rest/v1/backtest_trades`, {
      method: "POST", headers: { ...hdrs, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify(batch),
    });
    if (!tRes.ok) console.log(`  trades batch ${i} warning: ${tRes.status}`);
  }

  // 6. ジョブ完了更新
  await fetch(`${SB_URL}/rest/v1/backtest_jobs?id=eq.${jobId}`, {
    method: "PATCH",
    headers: { ...hdrs, "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
      bar_count: (bars[mainTf] ?? []).length,
      progress_pct: 100,
    }),
  });

  return { wr: report.winRate, pips: report.totalPips, verdict: report.verdict };
}

async function main() {
  console.log("=== GOLD バックテスト ローカル実行（トレードデータ含む）===\n");

  console.log("  バーデータ取得中...");
  const h1bars = await fetchBarsWithRetry("GOLD", "H1");
  const h4bars = await fetchBarsWithRetry("GOLD", "H4");
  console.log(`  GOLD H1: ${h1bars.length} bars, H4: ${h4bars.length} bars\n`);

  const strategies = await getGoldStrategies();
  console.log(`  対象: ${strategies.length} EA\n`);

  let ok = 0;
  for (const { id, name, spec } of strategies) {
    process.stdout.write(`  ${name.padEnd(42)} ... `);
    const result = await saveBacktestResult(id, spec, { H1: h1bars, H4: h4bars });
    if (result) {
      console.log(`✅ WR=${result.wr.toFixed(1)}% Pips=${result.pips.toFixed(0)} [${result.verdict}]`);
      ok++;
    } else {
      console.log("❌");
    }
  }

  console.log(`\n=== 完了: ${ok}/${strategies.length} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });

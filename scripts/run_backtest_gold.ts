/**
 * GOLD EAのバックテストをローカルエンジンで実行してDBに直接保存
 */
export {};

import type { Bar }         from "@/infrastructure/analysis/types";
import { runBacktest }      from "@/infrastructure/backtest/BacktestEngine";
import { generateReport }   from "@/infrastructure/backtest/BacktestReporter";
import type { StrategySpec} from "@/lib/strategySchema";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const hdrs   = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

type BarRow = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };

async function fetchBars(sym: string, tf: string): Promise<Bar[]> {
  const rows: BarRow[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close,volume` +
      `&symbol=eq.${sym}&timeframe=eq.${tf}&order=time_utc.asc&limit=1000&offset=${offset}`,
      { headers: hdrs }
    );
    const b = await res.json() as BarRow[];
    rows.push(...b);
    if (b.length < 1000) break;
    offset += 1000;
  }
  return rows.map(r => ({ time: new Date(r.time_utc).getTime(), open:+r.open, high:+r.high, low:+r.low, close:+r.close, volume: r.volume??0 }));
}

async function getGoldStrategies(): Promise<{ id: string; name: string; spec: StrategySpec }[]> {
  const res  = await fetch(`${SB_URL}/rest/v1/strategy_registry?name=like.GOLD%25&select=id,name,symbols,timeframes,entry_conditions,exit_conditions,filters,risk,strategy_type`, { headers: hdrs });
  const rows = await res.json() as Record<string, unknown>[];
  return rows.map(r => ({
    id:   String(r.id),
    name: String(r.name),
    spec: r as unknown as StrategySpec,
  }));
}

async function saveBacktestResult(strategyId: string, spec: StrategySpec, bars: Record<string, Bar[]>): Promise<boolean> {
  const h = { ...hdrs, "Content-Type": "application/json", "Prefer": "return=representation" };

  // 1. ジョブ作成
  const jobRes = await fetch(`${SB_URL}/rest/v1/backtest_jobs`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      strategy_id: strategyId,
      status: "RUNNING",
      period_label: "AVAILABLE",
      created_at: new Date().toISOString(),
    }),
  });
  if (!jobRes.ok) { console.log("  job create failed:", await jobRes.text()); return false; }
  const jobData = await jobRes.json() as { id: string }[];
  const jobId   = jobData[0].id;

  // 2. バックテスト実行
  const symbol  = spec.symbols[0];
  const mainTf  = spec.timeframes[0];
  const engine  = runBacktest({ spec, symbol, mainTimeframe: mainTf, barsByTimeframe: bars, initialBalance: 10000, fixedLot: 0.01 });
  const report  = generateReport({ engineResult: engine, periodLabel: "AVAILABLE", barCount: (bars[mainTf] ?? []).length });

  // 3. 結果保存
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
    method: "POST", headers: { ...h, "Prefer": "return=minimal" },
    body: JSON.stringify(resultRow),
  });
  if (!rRes.ok) { console.log("  result save failed:", await rRes.text()); return false; }

  // 4. ジョブ完了更新
  await fetch(`${SB_URL}/rest/v1/backtest_jobs?id=eq.${jobId}`, {
    method: "PATCH", headers: hdrs,
    body: JSON.stringify({ status: "COMPLETED", completed_at: new Date().toISOString(), bar_count: (bars[mainTf]??[]).length }),
  });

  return true;
}

async function main() {
  console.log("=== GOLD バックテスト ローカル実行 ===\n");

  console.log("  バーデータ取得中...");
  const h1bars = await fetchBars("GOLD", "H1");
  const h4bars = await fetchBars("GOLD", "H4");
  console.log(`  GOLD H1: ${h1bars.length} bars, H4: ${h4bars.length} bars\n`);

  const strategies = await getGoldStrategies();
  console.log(`  対象: ${strategies.length} EA\n`);

  let ok = 0;
  for (const { id, name, spec } of strategies) {
    process.stdout.write(`  ${name.padEnd(40)} ... `);
    const bars = { H1: h1bars, H4: h4bars };
    const saved = await saveBacktestResult(id, spec, bars);
    if (saved) {
      console.log("✅");
      ok++;
    } else {
      console.log("❌");
    }
  }

  console.log(`\n=== 完了: ${ok}/${strategies.length} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });

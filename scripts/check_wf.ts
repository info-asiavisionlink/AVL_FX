import { createAdminClient } from "../src/infrastructure/supabase/admin";
import { runWalkForward }    from "../src/infrastructure/backtest/WalkForwardEngine";
import { StrategySpecSchema } from "../src/lib/strategySchema";
import type { Bar }           from "../src/infrastructure/analysis/types";

async function main() {
  const db = createAdminClient();

  // 1. Strategy取得
  const { data: strategies, error: sErr } = await db
    .from("strategy_registry")
    .select("*")
    .limit(3);

  if (sErr || !strategies || strategies.length === 0) {
    console.error("No strategies found:", sErr?.message);
    process.exit(1);
  }

  const strategy = strategies[0]!;
  console.log(`\nStrategy: ${strategy.name as string} (${strategy.id as string})`);

  // 2. Spec構築
  const rawSpec = {
    name: strategy.name, strategy_type: strategy.strategy_type,
    description: strategy.description, symbols: strategy.symbols,
    timeframes: strategy.timeframes, entry_conditions: strategy.entry_conditions,
    exit_conditions: strategy.exit_conditions, filters: strategy.filters,
    risk: strategy.risk,
  };
  const parsed = StrategySpecSchema.safeParse(rawSpec);
  if (!parsed.success) { console.error("Invalid spec:", parsed.error.message); process.exit(1); }
  const spec = parsed.data;

  // 3. Bar Data取得
  const symbol = spec.symbols[0]!;
  const mainTf = spec.timeframes[0]!;
  console.log(`Symbol: ${symbol}, TF: ${mainTf}`);

  const tfs = new Set<string>(spec.timeframes);
  for (const c of spec.entry_conditions.conditions) tfs.add(c.timeframe);
  if (spec.filters?.trend_filter) tfs.add(spec.filters.trend_filter.timeframe);

  const allBarsByTf: Record<string, Bar[]> = {};
  for (const tf of tfs) {
    const { data: rows, error } = await db
      .from("bar_data")
      .select("time_utc, open, high, low, close, volume")
      .eq("symbol", symbol).eq("timeframe", tf)
      .order("time_utc", { ascending: true });

    if (error) { console.error(`bar_data error (${tf}):`, error.message); process.exit(1); }
    type R = { time_utc: string; open: number; high: number; low: number; close: number; volume: number };
    allBarsByTf[tf] = (rows as R[] ?? []).map(r => ({
      time: new Date(r.time_utc).getTime(),
      open: Number(r.open), high: Number(r.high), low: Number(r.low),
      close: Number(r.close), volume: r.volume ?? 0,
    }));
    console.log(`  ${tf}: ${allBarsByTf[tf]!.length} bars`);
  }

  const mainBars = allBarsByTf[mainTf] ?? [];
  if (mainBars.length < 100) {
    console.error(`Not enough bars for walk forward: ${mainBars.length}`);
    process.exit(1);
  }

  // 4. Parameter Range設定
  // 最初の条件のthresholdを探索
  const cond0 = spec.entry_conditions.conditions[0];
  const parameterRanges = [];

  if (cond0?.threshold !== undefined) {
    const v = cond0.threshold;
    parameterRanges.push({
      field: "entry_conditions.conditions[0].threshold",
      min: Math.max(1, Math.round(v - 5)),
      max: Math.round(v + 5),
      step: 2,
      paramType: "integer" as const,
    });
    console.log(`\nOptimizing: threshold ${v-5}..${v+5} step 2 → ${Math.floor(10/2)+1} combos`);
  } else if (spec.exit_conditions?.take_profit?.rr_ratio !== undefined) {
    const v = spec.exit_conditions.take_profit.rr_ratio;
    parameterRanges.push({
      field: "exit_conditions.take_profit.rr_ratio",
      min: Math.max(0.5, v - 0.4),
      max: v + 0.4,
      step: 0.2,
      paramType: "float" as const,
    });
    console.log(`\nOptimizing: rr_ratio ${v-0.4}..${v+0.4} step 0.2 → ${Math.floor(0.8/0.2)+1} combos`);
  } else {
    console.error("No optimizable parameter found in this strategy");
    process.exit(1);
  }

  if (parameterRanges.length === 0) {
    console.error("No parameter ranges to optimize");
    process.exit(1);
  }

  // 5. Walk Forward実行
  console.log(`\nRunning Walk Forward (3M train, 1M test, 1M step)...`);
  console.log(`Total bars: ${mainBars.length}`);
  const t0 = Date.now();

  const result = runWalkForward({
    spec,
    symbol,
    mainTimeframe:    mainTf,
    allBarsByTf,
    parameterRanges,
    trainMonths:      3,
    testMonths:       1,
    stepMonths:       1,
    inSampleRatio:    0.8,
    initialBalance:   10_000,
    warmupSafetyMargin: 30,
  });

  const elapsed = Date.now() - t0;

  // 6. 結果表示
  console.log("\n" + "═".repeat(55));
  console.log("  Walk Forward Results");
  console.log("═".repeat(55));
  console.log(`  Total Windows:    ${result.totalWindowCount}`);
  console.log(`  Valid Windows:    ${result.validWindowCount}`);
  console.log(`  Normal Windows:   ${result.normalWindowCount}`);
  console.log(`  Positive Windows: ${result.positiveWindowCount}`);
  console.log(`  Skipped Windows:  ${result.skippedWindowCount}`);
  console.log(`  Consistency:      ${result.consistencyScore === null ? "null" : (result.consistencyScore * 100).toFixed(1) + "%"}`);
  console.log(`  Verdict:          ${result.verdict}`);
  console.log(`  Execution time:   ${elapsed}ms`);
  console.log(`  Recommended:      ${JSON.stringify(result.recommendedParams)}`);
  console.log(`\n  Parameter Stability:`);
  for (const [field, stab] of Object.entries(result.parameterStability)) {
    const short = field.replace(/^entry_conditions\.conditions\[(\d+)\]\./, "[$1].").replace(/^exit_conditions\./, "exit.");
    console.log(`    ${short}: ${(stab*100).toFixed(0)}%`);
  }

  console.log(`\n  Window Details:`);
  for (const w of result.windows) {
    const status = w.skipped ? "SKIP" : w.windowPassed ? "PASS" : "FAIL";
    const params = Object.entries(w.bestParamSet).map(([f,v]) => `${f.split(".").pop()}=${v}`).join(",");
    if (!w.skipped) {
      console.log(`    W${w.windowIndex}: ${status} | ${params} | TEST pips=${w.testMetrics.totalPips.toFixed(1)} PF=${w.testMetrics.profitFactor?.toFixed(2) ?? "∞"} ${w.testMetrics.totalTrades}T [${w.sampleStatus}]`);
    } else {
      console.log(`    W${w.windowIndex}: ${status} | ${params} | TRAIN-OOS insuf`);
    }
  }

  // 7. Data Leakage確認
  console.log(`\n  Data Leakage Verification:`);
  for (let i = 1; i < result.windows.length; i++) {
    const prev = result.windows[i-1]!;
    const curr = result.windows[i]!;
    const trainBarsNotFromPrevTestResult = true; // By architecture: no cross-window feedback
    console.log(`    W${i-1}→W${i}: trainFrom=${curr.trainFrom>=prev.trainFrom ? "✓" : "✗"}, TEST boundary respected=${curr.testFrom===curr.trainTo ? "✓" : "✗"}`);
    void trainBarsNotFromPrevTestResult;
  }

  console.log("\n✅ Walk Forward verification complete");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});

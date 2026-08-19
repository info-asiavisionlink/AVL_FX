/**
 * Integration Test — BacktestService + Supabase (Phase 2-D)
 *
 * 実行方法（migration適用後）:
 *   npx tsx --env-file=.env.local src/infrastructure/backtest/__tests__/integration.test.ts
 *
 * 前提: 005_backtest.sql が Supabase に適用済みであること。
 *       SUPABASE_SERVICE_ROLE_KEY が .env.local に設定済みであること。
 */

// Node.js 20 用 WebSocket ポリフィル
import { WebSocket } from "ws";
// @ts-expect-error polyfill for Node 20
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

import { config } from "dotenv";
config({ path: ".env.local" });

import { createAdminClient }  from "@/infrastructure/supabase/admin";
import { runBacktestJob }     from "@/infrastructure/backtest/BacktestService";

// =================================================================
// ─── Test runner ────────────────────────────────────────────────
// =================================================================

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}\n     ${msg}`);
    failed++;
  }
}

async function describe(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n📊 ${name}`);
  await fn();
}

// =================================================================
// ─── Prerequisites check ─────────────────────────────────────────
// =================================================================

async function checkPrerequisites(): Promise<boolean> {
  const db = createAdminClient();

  // Check if backtest_jobs table exists
  const { error } = await db
    .from("backtest_jobs")
    .select("id")
    .limit(1);

  if (error) {
    console.error("\n⚠️  backtest_jobs table が存在しません。");
    console.error("   以下を実行してから再試行してください:");
    console.error("   ! supabase login");
    console.error("   ! npx supabase db push --db-url <your-db-url>");
    console.error("   または Supabase Dashboard の SQL Editor で");
    console.error("   supabase/migrations/005_backtest.sql を実行してください。\n");
    return false;
  }

  // Check if bar_data exists
  const { data: symbols } = await db
    .from("bar_data")
    .select("symbol")
    .limit(1);

  if (!symbols || symbols.length === 0) {
    console.error("\n⚠️  bar_data が空です。MT5 Gateway からデータを受信してください。");
    return false;
  }

  return true;
}

// =================================================================
// ─── Tests ───────────────────────────────────────────────────────
// =================================================================

async function main() {
  console.log("🧪 Integration Test — BacktestService + Supabase\n");

  const ready = await checkPrerequisites();
  if (!ready) {
    console.log("❌ Prerequisites not met. Skipping integration tests.");
    process.exit(0); // not a failure — migration just not applied yet
  }

  const db = createAdminClient();

  // Find a strategy to test with
  const { data: strategies } = await db
    .from("strategy_registry")
    .select("id, name, symbols, timeframes")
    .order("created_at", { ascending: false })
    .limit(5);

  if (!strategies || strategies.length === 0) {
    console.log("⚠️  strategy_registry にレコードがありません。AI EA Builder で Strategy を作成してください。");
    process.exit(0);
  }

  // Find a strategy that has bar data available
  let testStrategyId: string | null = null;
  for (const s of strategies) {
    if (!s.symbols || !s.timeframes) continue;
    const symbol = (s.symbols as string[])[0];
    const tf     = (s.timeframes as string[])[0];
    const { data: bars } = await db
      .from("bar_data")
      .select("time_utc")
      .eq("symbol", symbol)
      .eq("timeframe", tf)
      .limit(100);
    if (bars && bars.length >= 100) {
      testStrategyId = s.id as string;
      console.log(`  Strategy: "${s.name}" (${symbol} ${tf})`);
      console.log(`  Bar count: ${bars.length}+`);
      break;
    }
  }

  if (!testStrategyId) {
    console.log("⚠️  bar_data が 100 本以上あるStrategyが見つかりません。");
    process.exit(0);
  }

  // ── Run integration tests ────────────────────────────────

  await describe("BacktestService.runBacktestJob", async () => {

    await test("runBacktest completes successfully", async () => {
      const result = await runBacktestJob({
        strategyId:     testStrategyId!,
        period:         "AVAILABLE",
        initialBalance: 10_000,
      });
      if (result.status === "FAILED") {
        throw new Error(`Backtest failed: ${result.error}`);
      }
      if (!result.report) throw new Error("No report returned");
      console.log(`     Trades: ${result.report.totalTrades}`);
      console.log(`     Pips: ${result.report.totalPips}`);
      console.log(`     Verdict: ${result.report.verdict}`);
    });

    await test("backtest_jobs row was created", async () => {
      const { data } = await db
        .from("backtest_jobs")
        .select("id, status")
        .eq("strategy_id", testStrategyId!)
        .order("created_at", { ascending: false })
        .limit(1);
      if (!data || data.length === 0) throw new Error("No job found");
      if ((data[0] as { status: string }).status !== "COMPLETED") {
        throw new Error(`Job status: ${(data[0] as { status: string }).status}`);
      }
    });

    await test("backtest_results row was created", async () => {
      const { data: jobs } = await db
        .from("backtest_jobs")
        .select("id")
        .eq("strategy_id", testStrategyId!)
        .order("created_at", { ascending: false })
        .limit(1);
      if (!jobs || jobs.length === 0) throw new Error("No job found");
      const jobId = (jobs[0] as { id: string }).id;
      const { data: results } = await db
        .from("backtest_results")
        .select("id, verdict, total_trades, total_pips")
        .eq("job_id", jobId);
      if (!results || results.length === 0) throw new Error("No result found");
      console.log(`     Saved verdict: ${(results[0] as Record<string, unknown>).verdict}`);
    });

    await test("backtest_trades were saved (or 0 trades is OK)", async () => {
      const { data: jobs } = await db
        .from("backtest_jobs")
        .select("id")
        .eq("strategy_id", testStrategyId!)
        .order("created_at", { ascending: false })
        .limit(1);
      if (!jobs || jobs.length === 0) throw new Error("No job");
      const jobId = (jobs[0] as { id: string }).id;
      const { count } = await db
        .from("backtest_trades")
        .select("id", { count: "exact", head: true })
        .eq("job_id", jobId);
      console.log(`     Trade count in DB: ${count ?? 0}`);
      // 0 trades is valid (strategy might not generate signals)
    });

    await test("strategy_registry.backtest_status updated", async () => {
      const { data } = await db
        .from("strategy_registry")
        .select("backtest_status")
        .eq("id", testStrategyId!)
        .single();
      if (!data) throw new Error("Strategy not found");
      const st = (data as { backtest_status: string }).backtest_status;
      if (!["PASSED", "FAILED"].includes(st)) {
        throw new Error(`Unexpected backtest_status: ${st}`);
      }
      console.log(`     backtest_status: ${st}`);
    });

  });

  // ── Summary ────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Integration Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) { console.log("🎉 Integration tests PASSED"); }
  else { console.log("💥 Some integration tests FAILED"); process.exit(1); }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

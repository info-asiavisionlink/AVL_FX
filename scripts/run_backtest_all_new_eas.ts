/**
 * 新規登録EA全42本のバックテストを本番APIで実行してDB保存
 * Usage: npx tsx --env-file=.env.local scripts/run_backtest_all_new_eas.ts
 */
export {};

const SB_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE    = "https://avl-fx.vercel.app";

async function getStrategyIds(): Promise<{ id: string; name: string }[]> {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const res  = await fetch(
    `${SB_URL}/rest/v1/strategy_registry?select=id,name&backtest_status=eq.PASSED&order=magic_number.asc`,
    { headers: hdrs }
  );
  return await res.json() as { id: string; name: string }[];
}

async function runBacktest(id: string): Promise<{ wr: number; pips: number; verdict: string } | null> {
  try {
    const res  = await fetch(`${BASE}/api/backtest/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId: id, period: "AVAILABLE", initialBalance: 10000 }),
    });
    if (!res.ok) return null;
    const d = await res.json() as {
      status: string;
      result?: Record<string, unknown>;
    };
    if (d.status === "COMPLETED" && d.result) {
      const r = d.result;
      const wr   = Number(r.win_rate   ?? r.winRate   ?? 0);
      const pips = Number(r.total_pips ?? r.totalPips ?? 0);
      const verdict = String(r.verdict ?? "UNKNOWN");
      return { wr, pips, verdict };
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== バックテスト一括実行 ===");
  const strategies = await getStrategyIds();
  console.log(`対象: ${strategies.length} EA\n`);

  let ok = 0, ng = 0;
  for (const { id, name } of strategies) {
    process.stdout.write(`  ${name.padEnd(40)} ... `);
    const r = await runBacktest(id);
    if (r) {
      console.log(`✅ WR=${r.wr.toFixed(1)}% Pips=${r.pips.toFixed(0)} [${r.verdict}]`);
      ok++;
    } else {
      console.log("❌ failed");
      ng++;
    }
    // API負荷軽減
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  console.log(`\n=== 完了: ${ok}成功 / ${ng}失敗 ===`);
}

main().catch(e => { console.error(e); process.exit(1); });

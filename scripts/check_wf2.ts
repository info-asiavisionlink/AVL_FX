import { createAdminClient } from "../src/infrastructure/supabase/admin";

async function main() {
  const db = createAdminClient();

  // bar_dataのシンボル・TF別集計
  const { data: bars, error } = await db
    .from("bar_data")
    .select("symbol, timeframe")
    .limit(1000);

  if (error) { console.error("Error:", error.message); process.exit(1); }

  const counts: Record<string, number> = {};
  for (const r of bars ?? []) {
    const key = `${r.symbol}/${r.timeframe}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  console.log("Bar data (first 1000 rows sample):");
  for (const [k, v] of Object.entries(counts).sort()) {
    console.log(`  ${k}: ${v}+`);
  }

  // Strategies
  const { data: strats } = await db.from("strategy_registry").select("id, name, symbols, timeframes").limit(5);
  console.log("\nStrategies:");
  for (const s of strats ?? []) {
    console.log(`  ${s.name as string}: ${JSON.stringify(s.symbols)} ${JSON.stringify(s.timeframes)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

// scripts/check-backtest-tables.ts
// Usage: npx tsx --env-file=.env.local scripts/check-backtest-tables.ts

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  async function checkTable(name: string): Promise<boolean> {
    const res = await fetch(`${url}/rest/v1/${name}?limit=1`, {
      headers: { apikey: key!, Authorization: `Bearer ${key}` },
    });
    if (res.ok || res.status === 200) {
      console.log(`✅ ${name}: exists`);
      return true;
    }
    const body = await res.text();
    console.log(`❌ ${name}: ${res.status} — ${body.substring(0, 80)}`);
    return false;
  }

  const results = await Promise.all([
    checkTable("backtest_jobs"),
    checkTable("backtest_results"),
    checkTable("backtest_trades"),
  ]);

  if (results.every(Boolean)) {
    console.log("\n✅ All backtest tables exist. Ready for integration tests.");
    process.exit(0);
  } else {
    console.log("\n⚠️  Some tables missing. Apply migration:");
    console.log("   Supabase Dashboard > SQL Editor > paste supabase/migrations/005_backtest.sql");
    process.exit(2);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

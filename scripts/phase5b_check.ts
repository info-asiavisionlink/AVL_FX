// scripts/phase5b_check.ts
// Usage: npx tsx --env-file=.env.local scripts/phase5b_check.ts

export {};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // Bar coverage check
  console.log("=== EURUSD Bar Coverage ===");
  const tfs = ["M5", "H1", "H4"];
  for (const tf of tfs) {
    // Count
    const countRes = await fetch(
      `${url}/rest/v1/bar_data?select=*&symbol=eq.EURUSD&timeframe=eq.${tf}`,
      { headers: { ...headers, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0" } }
    );
    const cRange = countRes.headers.get("content-range");
    const total = cRange ? cRange.split("/")[1] : "?";

    // From (oldest)
    const fromRes = await fetch(
      `${url}/rest/v1/bar_data?select=time_utc&symbol=eq.EURUSD&timeframe=eq.${tf}&order=time_utc.asc&limit=1`,
      { headers }
    );
    const fromData = await fromRes.json();

    // To (newest)
    const toRes = await fetch(
      `${url}/rest/v1/bar_data?select=time_utc&symbol=eq.EURUSD&timeframe=eq.${tf}&order=time_utc.desc&limit=1`,
      { headers }
    );
    const toData = await toRes.json();

    console.log(`  EURUSD ${tf}: count=${total}, from=${fromData[0]?.time_utc}, to=${toData[0]?.time_utc}`);
  }

  // Existing strategies
  console.log("\n=== Existing Strategies ===");
  const stratRes = await fetch(
    `${url}/rest/v1/strategy_registry?select=id,name,strategy_type,backtest_status,created_at&order=created_at.desc`,
    { headers }
  );
  const strats = await stratRes.json();
  if (!Array.isArray(strats) || strats.length === 0) {
    console.log("  (none)");
  }
  for (const s of (strats ?? [])) {
    console.log(`  id=${s.id}`);
    console.log(`    name="${s.name}"`);
    console.log(`    type=${s.strategy_type}, bt_status=${s.backtest_status}`);
  }
}
main().catch(console.error);

export {};
async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const strat = await fetch(
    `${url}/rest/v1/strategy_registry?id=eq.3ea248f8-6d4e-4f1a-bd43-a4877b1d6659&select=*`,
    { headers }
  ).then(r => r.json());
  console.log("Strategy:", JSON.stringify(strat[0]?.name), "bt_status:", strat[0]?.backtest_status);

  const results = await fetch(
    `${url}/rest/v1/backtest_results?strategy_id=eq.3ea248f8-6d4e-4f1a-bd43-a4877b1d6659&select=*&order=created_at.desc&limit=1`,
    { headers }
  ).then(r => r.json());
  const r = results[0];
  console.log("Result saved:", r ? "YES" : "NO");
  if (r) {
    console.log("  total_trades:", r.total_trades);
    console.log("  win_rate:", r.win_rate, "%");
    console.log("  total_pips:", r.total_pips);
    console.log("  profit_factor:", r.profit_factor);
    console.log("  max_drawdown_pct:", r.max_drawdown_pct, "%");
    console.log("  verdict:", r.verdict);
  }

  const tradeCount = await fetch(
    `${url}/rest/v1/backtest_trades?strategy_id=eq.3ea248f8-6d4e-4f1a-bd43-a4877b1d6659`,
    { headers: { ...headers, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0" } }
  ).then(r2 => {
    const cr = r2.headers.get("content-range");
    return cr ? cr.split("/")[1] : "?";
  });
  console.log("  trades saved in DB:", tradeCount);
}
main().catch(console.error);

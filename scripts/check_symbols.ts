export {};
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function main() {
  // Supabase REST APIでページング取得
  const seen = new Map<string, number>();
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const res = await fetch(
      `${SB_URL}/rest/v1/bar_data?select=symbol,timeframe&order=symbol.asc,timeframe.asc&limit=${PAGE}&offset=${offset}`,
      { headers: hdrs }
    );
    const rows = await res.json() as { symbol: string; timeframe: string }[];
    for (const r of rows) {
      const k = `${r.symbol}_${r.timeframe}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  console.log("Symbol_TF               Count");
  for (const [k, n] of [...seen.entries()].sort()) {
    console.log(k.padEnd(24), n);
  }
}
main().catch(console.error);

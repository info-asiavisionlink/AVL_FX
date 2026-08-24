/**
 * 各シンボル×時間足の最初の1行だけ取得して存在確認
 */
export {};
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const hdrs   = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const SYMBOLS = [
  "EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD",
  "USDCHF", "NZDUSD", "EURJPY", "GBPJPY", "AUDJPY",
  "CADJPY", "CHFJPY", "NZDJPY", "EURGBP", "EURAUD",
  "GOLD", "XAUUSD", "SILVER", "XAGUSD",
  "US30CASH", "US500CASH", "US100CASH",
  "OILCASH", "BRENTCASH",
];
const TIMEFRAMES = ["M30", "H1", "H4"];

async function check(symbol: string, tf: string): Promise<number> {
  const url = `${SB_URL}/rest/v1/bar_data?symbol=eq.${symbol}&timeframe=eq.${tf}&select=time_utc&limit=1&order=time_utc.asc`;
  const res  = await fetch(url, { headers: hdrs });
  if (!res.ok) return 0;
  const d = await res.json() as unknown[];
  return d.length;
}

async function countBars(symbol: string, tf: string): Promise<number> {
  const url = `${SB_URL}/rest/v1/bar_data?symbol=eq.${symbol}&timeframe=eq.${tf}&select=time_utc&limit=1&order=time_utc.desc`;
  const res  = await fetch(url, { headers: hdrs });
  // Use Prefer: count=exact header
  const res2 = await fetch(
    `${SB_URL}/rest/v1/bar_data?symbol=eq.${symbol}&timeframe=eq.${tf}&select=time_utc`,
    { headers: { ...hdrs, "Prefer": "count=exact", "Range": "0-0" } }
  );
  const range = res2.headers.get("content-range");
  if (range) {
    const total = range.split("/")[1];
    return total === "*" ? -1 : parseInt(total);
  }
  return -1;
}

async function main() {
  console.log("Checking symbol availability...\n");
  const results: { symbol: string; tf: string; count: number }[] = [];

  for (const sym of SYMBOLS) {
    const counts: string[] = [];
    for (const tf of TIMEFRAMES) {
      const n = await countBars(sym, tf);
      if (n > 0) {
        counts.push(`${tf}:${n}`);
        results.push({ symbol: sym, tf, count: n });
      } else if (n === 0 || n === -1) {
        // Try simple check
        const has = await check(sym, tf);
        if (has > 0) {
          counts.push(`${tf}:?`);
          results.push({ symbol: sym, tf, count: 999 });
        }
      }
    }
    if (counts.length > 0) {
      console.log(`  ✓ ${sym.padEnd(12)} ${counts.join("  ")}`);
    } else {
      console.log(`  - ${sym.padEnd(12)} NO DATA`);
    }
  }

  console.log(`\nAvailable: ${results.map(r => r.symbol).filter((v,i,a)=>a.indexOf(v)===i).join(", ")}`);
}
main().catch(console.error);

/**
 * DBにある全シンボル×時間足の組み合わせをカウント
 * Usage: npx tsx --env-file=.env.local scripts/check_db_symbols.ts
 */
export {};
import type { Bar } from "@/infrastructure/analysis/types";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const seen = new Map<string, number>();
  let offset = 0;
  let total  = 0;

  while (true) {
    const url = `${SB_URL}/rest/v1/bar_data?select=symbol,timeframe&limit=1000&offset=${offset}`;
    const res  = await fetch(url, { headers: hdrs });
    const rows = await res.json() as { symbol: string; timeframe: string }[];
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      const k = `${r.symbol}_${r.timeframe}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    total += rows.length;
    process.stdout.write(`\r  ${total} rows scanned...`);
    if (rows.length < 1000) break;
    offset += 1000;
  }

  console.log(`\n\n${"Symbol_Timeframe".padEnd(25)} Count`);
  for (const [k, n] of [...seen.entries()].sort()) {
    console.log(`${k.padEnd(25)} ${n}`);
  }
  console.log(`\nTotal rows: ${total}, Unique combinations: ${seen.size}`);
}

main().catch(console.error);

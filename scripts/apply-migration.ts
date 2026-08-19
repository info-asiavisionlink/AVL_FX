// scripts/apply-migration.ts
// Supabase Management API でマイグレーションを実行する
// Usage: npx tsx --env-file=.env.local scripts/apply-migration.ts

import { readFileSync } from "fs";
import { resolve } from "path";

async function main() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  if (!serviceKey || !supabaseUrl) {
    console.error("Missing env vars");
    process.exit(1);
  }

  // Project ref from URL: https://bsmofroshpmomjwfxigh.supabase.co
  const projectRef = supabaseUrl.replace("https://", "").split(".")[0];
  console.log(`Project ref: ${projectRef}`);

  const sqlPath = resolve("supabase/migrations/005_backtest.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  console.log(`SQL length: ${sql.length} chars`);

  // Try Supabase Management API
  const mgmtUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  console.log(`Trying Management API: ${mgmtUrl}`);

  const mgmtRes = await fetch(mgmtUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });

  const mgmtBody = await mgmtRes.text();
  console.log(`Management API status: ${mgmtRes.status}`);
  console.log(`Response: ${mgmtBody.substring(0, 200)}`);

  if (mgmtRes.ok) {
    console.log("\n✅ Migration applied via Management API!");
    return;
  }

  // Try direct SQL via PostgREST rpc (needs exec_sql function)
  console.log("\nTrying via PostgREST rpc...");
  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
    method: "POST",
    headers: {
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });
  console.log(`RPC status: ${rpcRes.status}`);
  console.log(`RPC response: ${(await rpcRes.text()).substring(0, 200)}`);
}

main().catch(err => { console.error(err); process.exit(1); });

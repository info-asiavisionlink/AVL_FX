// READ-ONLY verification of a Supabase privileged key for the Production
// project, used during service_role rotation. Prints HTTP status / row counts
// only — never the key. No INSERT/UPDATE/DELETE/RPC is issued.
//
// Usage (key read from an env var; put it in the git-ignored .env.rotation
// with an editor, never on the command line):
//   npx tsx --env-file=.env.rotation scripts/rotation/verify-supabase-key.ts CANDIDATE_SUPABASE_SECRET_KEY
//   npx tsx --env-file=.env.local    scripts/rotation/verify-supabase-key.ts SUPABASE_SERVICE_ROLE_KEY --expect-rejected
import { WebSocket as WsType } from "ws";
import { PRODUCTION_SUPABASE_REFS } from "../../src/lib/safety/live-target-guard";
// supabase-js needs a WebSocket constructor on Node 20 even when Realtime is unused.
if (!globalThis.WebSocket) (globalThis as unknown as { WebSocket: unknown }).WebSocket = WsType;

const varName = process.argv[2];
const expectRejected = process.argv.includes("--expect-rejected");
const key = varName ? process.env[varName] : undefined;
const ref = PRODUCTION_SUPABASE_REFS[0];
const base = `https://${ref}.supabase.co`;
if (!varName || !key) {
  console.error("usage: verify-supabase-key.ts <ENV_VAR_NAME> [--expect-rejected]  (variable empty or missing)");
  process.exit(2);
}
const kind = key.startsWith("sb_secret_") ? "sb_secret" : key.startsWith("eyJ") ? "legacy-jwt" : "other";

async function rest(label: string, headers: Record<string, string>) {
  // ai_traders is RLS-protected: only a privileged key sees rows.
  const r = await fetch(`${base}/rest/v1/ai_traders?select=id&limit=1`, { headers, signal: AbortSignal.timeout(20_000) });
  const body = r.ok ? ((await r.json()) as unknown[]) : [];
  console.log(`${label.padEnd(44)} HTTP ${r.status} privilegedRows=${body.length}`);
  return { status: r.status, rows: body.length };
}

(async () => {
  console.log(`key: ${varName} (${kind}, length ${key.length}) → project ${ref}`);
  const both = await rest("PostgREST apikey + Bearer (raw REST pattern)", { apikey: key, Authorization: `Bearer ${key}` });
  const only = await rest("PostgREST apikey only", { apikey: key });
  const auth = await fetch(`${base}/auth/v1/admin/users?per_page=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  console.log(`${"Auth admin listUsers (Console pattern)".padEnd(44)} HTTP ${auth.status}`);

  if (expectRejected) {
    const rejected = both.status === 401 && auth.status === 401 && only.rows === 0;
    console.log(rejected ? "RESULT: OLD KEY REJECTED" : "RESULT: KEY STILL ACCEPTED — do not report revocation");
    process.exit(rejected ? 0 : 1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(base, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await sb.from("ai_traders").select("id").limit(1);
  console.log(`${"supabase-js admin client select".padEnd(44)} ${error ? `ERROR ${error.message}` : `OK privilegedRows=${data?.length ?? 0}`}`);
  const { error: ue } = await sb.auth.admin.listUsers({ perPage: 1 });
  console.log(`${"supabase-js auth.admin.listUsers".padEnd(44)} ${ue ? `ERROR ${ue.message}` : "OK"}`);

  const pass = both.status === 200 && both.rows > 0 && auth.status === 200 && !error && (data?.length ?? 0) > 0 && !ue;
  console.log(pass ? "RESULT: COMPATIBLE for all AVL-FX access patterns" : "RESULT: NOT COMPATIBLE — do not switch consumers");
  process.exit(pass ? 0 : 1);
})();

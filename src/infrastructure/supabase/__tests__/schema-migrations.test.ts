import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd());
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const sql = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()
  .map(f => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");

test("Stage 2 migration set contains all active Trading View tables", () => {
  for (const table of [
    "ai_traders", "ai_trader_versions", "ai_trader_scenarios",
    "ai_analysis_logs", "ai_positions", "trade_decisions", "trade_outcomes",
    "trade_reviews", "experience_memories", "execution_commands",
    "mt5_connections", "live_positions", "live_deals", "trade_history",
    "economic_events", "news_items", "trade_audit_log",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS (?:public\\.)?${table}\\b`), table);
  }
});

test("Scenario and analysis schema supports version and correlation", () => {
  for (const column of ["scenario_version", "ai_trader_version_id", "trigger_type", "entry_side", "market_view"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`), column);
  }
  for (const column of ["user_id", "trader_id", "scenario_id", "position_id", "command_id", "reasoning_summary"]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`), column);
  }
  assert.match(sql, /knowledge_snapshot JSONB NOT NULL DEFAULT '\[\]'/);
});

test("Customer-owned journal tables enable RLS and own-row policies", () => {
  for (const table of ["ai_analysis_logs", "trade_audit_log"]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ON public\\.${table}\\n  FOR (?:ALL|SELECT) TO authenticated`));
  }
});

test("fresh-chain prerequisites precede the historical RLS migration", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  assert.ok(files.indexOf("006_shared_runtime_tables.sql") < files.indexOf("015_user_isolation_rls.sql"));
  const shared = readFileSync(join(MIGRATIONS, "006_shared_runtime_tables.sql"), "utf8");
  for (const table of ["trade_history", "economic_events", "news_items"]) assert.match(shared, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
});

test("Trading View migrations do not define plaintext credential columns", () => {
  assert.doesNotMatch(sql, /tv_password\s+TEXT/i);
  assert.doesNotMatch(sql, /mt5_password\s+TEXT/i);
  assert.match(sql, /connection_token_hash\s+TEXT\s+NOT NULL/);
});

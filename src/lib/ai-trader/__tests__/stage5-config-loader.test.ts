// Stage 5: Customer AI Trader Runtime Config Loader tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  loadCustomerAITraderConfig,
  TraderConfigError,
} from "../customer-trader-config-loader";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TRADER_ID = "trader-abc";
const USER_A    = "user-a";
const USER_B    = "user-b";

function traderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRADER_ID, user_id: USER_A, name: "GOLD Trader",
    market: "GOLD", status: "ACTIVE",
    execution_mode: "MANUAL_APPROVAL", kill_switch: false, current_version: 1,
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1", ai_trader_id: TRADER_ID, version: 1,
    personality: "BALANCED", trading_style: "TREND_FOLLOWING",
    risk_profile: "MEDIUM", entry_patience: "NORMAL",
    news_sensitivity: "MEDIUM", volatility_preference: "NORMAL",
    timeframes: ["H4", "H1"], instructions: "Follow the trend.",
    magic_number: 900001, minimum_rr: 2.0, max_risk_per_trade: 1.0,
    max_positions: 1, max_daily_trades: 5, max_daily_loss_usd: 100,
    max_consecutive_losses: 3, max_total_exposure_lots: 0.2,
    market_data_max_age_seconds: 30, account_data_max_age_seconds: 30,
    tick_data_max_age_seconds: 30, max_spread_points: 0,
    knowledge_package_version: "2026-09-26-v1",
    ...overrides,
  };
}

function tfProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    timeframe_style: "DAY_TRADING",
    macro_context_timeframes: ["H4"],
    trend_context_timeframes: ["H4", "H1"],
    setup_timeframes: ["M15", "M5"],
    entry_timeframes: ["M5"],
    management_timeframes: ["M15"],
    monitor_interval_minutes: 5,
    ...overrides,
  };
}

// Mock Supabase builder.  Records every select() column list and eq() filter
// so the tests can check the queries themselves, not just the results.
const selected: Record<string, string[]> = {};
const filters: Record<string, [string, unknown][]> = {};
function makeDb(
  rows: { trader: Record<string, unknown> | null; version: Record<string, unknown> | null; tfProfile: Record<string, unknown> | null },
  errors: { trader?: string; version?: string; tfProfile?: string } = {},
) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["order", "limit"]) chain[m] = () => chain;
      chain.select = (cols: string) => { selected[table] = cols.split(",").map(c => c.trim()); return chain; };
      filters[table] = [];
      chain.eq = (col: string, val: unknown) => { filters[table].push([col, val]); return chain; };
      chain.maybeSingle = () => {
        const [data, error] =
          table === "ai_traders"               ? [rows.trader,    errors.trader    ? { message: errors.trader } : null]
          : table === "ai_trader_versions"      ? [rows.version,   errors.version   ? { message: errors.version } : null]
          : table === "ai_trader_timeframe_profiles" ? [rows.tfProfile, errors.tfProfile ? { message: errors.tfProfile } : null]
          : [null, null];
        return { data, error };
      };
      return chain;
    },
  } as never;
}

// ── Core loader tests ─────────────────────────────────────────────────────────

test("loads full config for valid trader + version + profile", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);

  assert.equal(cfg.trader.id, TRADER_ID);
  assert.equal(cfg.trader.userId, USER_A);
  assert.equal(cfg.trader.market, "GOLD");
  assert.equal(cfg.trader.executionMode, "MANUAL_APPROVAL");
  assert.equal(cfg.trader.killSwitch, false);

  assert.equal(cfg.version.id, "version-1");
  assert.equal(cfg.version.minimumRR, 2.0);
  assert.equal(cfg.version.maxRiskPerTrade, 1.0);
  assert.equal(cfg.version.knowledgePackageVersion, "2026-09-26-v1");

  assert.equal(cfg.timeframeProfile.timeframe_style, "DAY_TRADING");
  assert.deepEqual(cfg.timeframeProfile.trend_context_timeframes, ["H4", "H1"]);
  assert.deepEqual(cfg.timeframeProfile.entry_timeframes, ["M5"]);
  assert.equal(cfg.timeframeProfile.monitor_interval_minutes, 5);
});

test("throws NO_TIMEFRAME_PROFILE when no profile row exists (no silent default)", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: null });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "NO_TIMEFRAME_PROFILE",
  );
});

// ── Fail-closed tests ─────────────────────────────────────────────────────────

test("throws CONFIG_ERROR when traderId is empty", async () => {
  const db = makeDb({ trader: null, version: null, tfProfile: null });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, "", USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "CONFIG_ERROR",
  );
});

test("throws CONFIG_ERROR when userId is empty", async () => {
  const db = makeDb({ trader: null, version: null, tfProfile: null });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, ""),
    (e: unknown) => e instanceof TraderConfigError && e.code === "CONFIG_ERROR",
  );
});

test("throws NOT_FOUND when trader does not exist", async () => {
  const db = makeDb({ trader: null, version: null, tfProfile: null });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "NOT_FOUND",
  );
});

test("throws NO_ACTIVE_VERSION when version row is missing", async () => {
  const db = makeDb({ trader: traderRow(), version: null, tfProfile: null });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "NO_ACTIVE_VERSION",
  );
});

test("throws SERVER_ERROR on trader DB error", async () => {
  const db = makeDb({ trader: null, version: null, tfProfile: null }, { trader: "connection refused" });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "SERVER_ERROR",
  );
});

test("throws SERVER_ERROR on version DB error", async () => {
  const db = makeDb({ trader: traderRow(), version: null, tfProfile: null }, { version: "timeout" });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "SERVER_ERROR",
  );
});

// ── Customer isolation tests ──────────────────────────────────────────────────

test("throws OWNER_MISMATCH when user_id does not match", async () => {
  const db = makeDb({ trader: traderRow({ user_id: USER_A }), version: versionRow(), tfProfile: tfProfileRow() });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_B),
    (e: unknown) => e instanceof TraderConfigError && e.code === "OWNER_MISMATCH",
  );
});

test("customer B cannot read customer A's trader", async () => {
  const db = makeDb({ trader: traderRow({ user_id: USER_A }), version: null, tfProfile: null });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_B),
    (e: unknown) => e instanceof TraderConfigError && e.code === "OWNER_MISMATCH",
  );
});

// ── Profile validation tests ──────────────────────────────────────────────────

test("throws INVALID_PROFILE when timeframe_style is unknown", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: tfProfileRow({ timeframe_style: "UNKNOWN" }) });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "INVALID_PROFILE",
  );
});

test("throws INVALID_PROFILE when trend_context_timeframes is empty", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: tfProfileRow({ trend_context_timeframes: [] }) });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "INVALID_PROFILE",
  );
});

test("throws INVALID_PROFILE when entry_timeframes is empty", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: tfProfileRow({ entry_timeframes: [] }) });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "INVALID_PROFILE",
  );
});

test("throws INVALID_PROFILE when entry_timeframes contains unsupported value", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: tfProfileRow({ entry_timeframes: ["M5", "INVALID"] }) });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "INVALID_PROFILE",
  );
});

test("throws INVALID_PROFILE for unknown execution_mode", async () => {
  const db = makeDb({ trader: traderRow({ execution_mode: "LIVE_AUTONOMOUS" }), version: versionRow(), tfProfile: tfProfileRow() });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "INVALID_PROFILE",
  );
});

// ── Execution mode safety ─────────────────────────────────────────────────────

test("ANALYSIS_ONLY mode loads correctly", async () => {
  const db = makeDb({ trader: traderRow({ execution_mode: "ANALYSIS_ONLY" }), version: versionRow(), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.trader.executionMode, "ANALYSIS_ONLY");
});

test("MANUAL_APPROVAL mode loads correctly", async () => {
  const db = makeDb({ trader: traderRow({ execution_mode: "MANUAL_APPROVAL" }), version: versionRow(), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.trader.executionMode, "MANUAL_APPROVAL");
});

test("DEMO_AUTONOMOUS mode loads correctly", async () => {
  const db = makeDb({ trader: traderRow({ execution_mode: "DEMO_AUTONOMOUS" }), version: versionRow(), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.trader.executionMode, "DEMO_AUTONOMOUS");
});

// ── Versioning tests ──────────────────────────────────────────────────────────

test("loads version matching current_version", async () => {
  const db = makeDb({ trader: traderRow({ current_version: 3 }), version: versionRow({ version: 3 }), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.version.version, 3);
  assert.equal(cfg.trader.currentVersion, 3);
});

test("knowledge_package_version is null when not set", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow({ knowledge_package_version: null }), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.version.knowledgePackageVersion, null);
});

// ── SCALPING / SWING profile styles ──────────────────────────────────────────

test("SCALPING profile loads with correct style", async () => {
  const db = makeDb({
    trader: traderRow(), version: versionRow(),
    tfProfile: tfProfileRow({
      timeframe_style: "SCALPING",
      trend_context_timeframes: ["M5"],
      entry_timeframes: ["M1"],
      monitor_interval_minutes: 1,
    }),
  });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.timeframeProfile.timeframe_style, "SCALPING");
  assert.deepEqual(cfg.timeframeProfile.entry_timeframes, ["M1"]);
  assert.equal(cfg.timeframeProfile.monitor_interval_minutes, 1);
});

test("SWING profile loads with D1/H4 timeframes", async () => {
  const db = makeDb({
    trader: traderRow(), version: versionRow(),
    tfProfile: tfProfileRow({
      timeframe_style: "SWING",
      macro_context_timeframes: ["MN1", "W1", "D1"],
      trend_context_timeframes: ["D1", "H4"],
      entry_timeframes: ["H1", "M15"],
      monitor_interval_minutes: 60,
    }),
  });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.timeframeProfile.timeframe_style, "SWING");
  assert.deepEqual(cfg.timeframeProfile.entry_timeframes, ["H1", "M15"]);
  assert.equal(cfg.timeframeProfile.monitor_interval_minutes, 60);
});

// ── Strict fail-closed: risk config ──────────────────────────────────────────

const rejectsWith = (code: string, overrides: { trader?: Record<string, unknown>; version?: Record<string, unknown>; tfProfile?: Record<string, unknown> }) =>
  assert.rejects(
    () => loadCustomerAITraderConfig(
      makeDb({ trader: traderRow(overrides.trader), version: versionRow(overrides.version), tfProfile: tfProfileRow(overrides.tfProfile) }),
      TRADER_ID, USER_A,
    ),
    (e: unknown) => e instanceof TraderConfigError && e.code === code,
  );

for (const [field, bad] of [
  ["max_risk_per_trade", null], ["max_risk_per_trade", 0], ["max_risk_per_trade", -1], ["max_risk_per_trade", 50],
  ["minimum_rr", null], ["minimum_rr", 0], ["max_positions", 1.5], ["max_positions", 0],
  ["max_daily_trades", null], ["max_daily_loss_usd", -1], ["max_consecutive_losses", undefined],
  ["max_total_exposure_lots", 0], ["account_data_max_age_seconds", null], ["account_data_max_age_seconds", 0],
  ["tick_data_max_age_seconds", "abc"], ["tick_data_max_age_seconds", Infinity], ["max_spread_points", -5],
  ["max_spread_points", null],
] as const) {
  test(`risk config: ${field}=${String(bad)} → INVALID_PROFILE (no default)`, () =>
    rejectsWith("INVALID_PROFILE", { version: { [field]: bad } }));
}

test("risk config: NUMERIC delivered as string is accepted", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow({ max_daily_loss_usd: "250.5", minimum_rr: "2" }), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.version.maxDailyLossUsd, 250.5);
  assert.equal(cfg.version.minimumRR, 2);
});

test("risk config: stored values pass through unchanged", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow({ tick_data_max_age_seconds: 12, account_data_max_age_seconds: 45, max_spread_points: 80 }), tfProfile: tfProfileRow() });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.version.tickDataMaxAgeSeconds, 12);
  assert.equal(cfg.version.accountDataMaxAgeSeconds, 45);
  assert.equal(cfg.version.maxSpreadPoints, 80);
});

// ── Strict fail-closed: trader row ───────────────────────────────────────────

test("missing execution_mode → INVALID_PROFILE (never defaulted)", () =>
  rejectsWith("INVALID_PROFILE", { trader: { execution_mode: null } }));
test("LIVE execution_mode → INVALID_PROFILE", () =>
  rejectsWith("INVALID_PROFILE", { trader: { execution_mode: "LIVE" } }));
test("unknown status → INVALID_PROFILE", () =>
  rejectsWith("INVALID_PROFILE", { trader: { status: "DELETED" } }));
for (const market of ["", null, "gold", "GOLD; DROP", "A".repeat(30)]) {
  test(`malformed market ${JSON.stringify(market)} → INVALID_PROFILE`, () =>
    rejectsWith("INVALID_PROFILE", { trader: { market } }));
}
for (const cv of [null, 0, -1, 1.5, "x"]) {
  test(`invalid current_version ${JSON.stringify(cv)} → NO_ACTIVE_VERSION`, () =>
    rejectsWith("NO_ACTIVE_VERSION", { trader: { current_version: cv } }));
}

test("kill_switch null/unknown is treated as engaged", async () => {
  for (const ks of [null, undefined, "false", 0]) {
    const db = makeDb({ trader: traderRow({ kill_switch: ks }), version: versionRow(), tfProfile: tfProfileRow() });
    const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
    assert.equal(cfg.trader.killSwitch, true, `kill_switch=${String(ks)}`);
  }
});

test("ARCHIVED trader loads with its status so callers can refuse it", async () => {
  const db = makeDb({ trader: traderRow({ status: "ARCHIVED" }), version: versionRow(), tfProfile: tfProfileRow() });
  assert.equal((await loadCustomerAITraderConfig(db, TRADER_ID, USER_A)).trader.status, "ARCHIVED");
});

// ── Strict fail-closed: timeframe profile ────────────────────────────────────

for (const [label, tf] of [
  ["non-array setup", { setup_timeframes: "M5" }],
  ["non-string entry element", { entry_timeframes: [5] }],
  ["duplicate trend", { trend_context_timeframes: ["H1", "H1"] }],
  ["missing style", { timeframe_style: null }],
  ["missing interval", { monitor_interval_minutes: null }],
  ["interval 61", { monitor_interval_minutes: 61 }],
  ["lowercase tf", { entry_timeframes: ["m5"] }],
] as const) {
  test(`timeframe profile ${label} → INVALID_PROFILE`, () =>
    rejectsWith("INVALID_PROFILE", { tfProfile: tf as Record<string, unknown> }));
}

test("SERVER_ERROR on timeframe profile DB error (e.g. migration 038 not applied)", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: null }, { tfProfile: "relation does not exist" });
  await assert.rejects(
    () => loadCustomerAITraderConfig(db, TRADER_ID, USER_A),
    (e: unknown) => e instanceof TraderConfigError && e.code === "SERVER_ERROR",
  );
});

// ── Query shape: ownership + active version + profile binding ────────────────

test("queries are bound to the requested trader, its current_version and that version's id", async () => {
  const db = makeDb({ trader: traderRow({ current_version: 4 }), version: versionRow({ id: "version-4", version: 4 }), tfProfile: tfProfileRow() });
  await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.deepEqual(filters.ai_traders, [["id", TRADER_ID]]);
  assert.deepEqual(filters.ai_trader_versions, [["ai_trader_id", TRADER_ID], ["version", 4]]);
  assert.deepEqual(filters.ai_trader_timeframe_profiles, [["ai_trader_version_id", "version-4"]]);
});

test("forged userId for an existing trader never returns config", async () => {
  const db = makeDb({ trader: traderRow({ user_id: USER_A }), version: versionRow(), tfProfile: tfProfileRow() });
  for (const forged of [USER_B, " user-a", "USER-A", "*"]) {
    await assert.rejects(
      () => loadCustomerAITraderConfig(db, TRADER_ID, forged),
      (e: unknown) => e instanceof TraderConfigError && e.code === "OWNER_MISMATCH",
    );
  }
});

// ── Schema contract: every selected column exists in Customer Supabase ──────
// The mocks above cannot catch a SELECT of a column that no migration creates
// (a real PostgREST call then fails for every trader).  Parse the migrations.

function migrationColumns(table: string): Set<string> {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const cols = new Set<string>();
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8").replace(/--[^\n]*/g, "");
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`).exec(sql);
    if (create) {
      for (const line of create[1].split("\n")) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s+(UUID|TEXT|INTEGER|NUMERIC|BOOLEAN|TIMESTAMPTZ|JSONB|DATE)/i.exec(line);
        if (m) cols.add(m[1]);
      }
    }
    const alter = new RegExp(`ALTER TABLE public\\.${table}\\s+ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)`, "g");
    for (const m of sql.matchAll(alter)) cols.add(m[1]);
  }
  return cols;
}

test("schema contract: loader SELECTs only columns created by migrations 001–038", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: tfProfileRow() });
  await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  for (const table of ["ai_traders", "ai_trader_versions", "ai_trader_timeframe_profiles"]) {
    const known = migrationColumns(table);
    assert.ok(known.size > 3, `no columns parsed for ${table}`);
    const missing = selected[table].filter(c => !known.has(c));
    assert.deepEqual(missing, [], `${table}: selected columns missing from migrations`);
  }
});

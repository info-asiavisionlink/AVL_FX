// Stage 5: Customer AI Trader Runtime Config Loader tests
import assert from "node:assert/strict";
import { test } from "node:test";
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

// Mock Supabase builder
function makeDb(
  rows: { trader: Record<string, unknown> | null; version: Record<string, unknown> | null; tfProfile: Record<string, unknown> | null },
  errors: { trader?: string; version?: string; tfProfile?: string } = {},
) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
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

test("uses DEFAULT_DAY_TRADING_TIMEFRAME_PROFILE when no profile row exists", async () => {
  const db = makeDb({ trader: traderRow(), version: versionRow(), tfProfile: null });
  const cfg = await loadCustomerAITraderConfig(db, TRADER_ID, USER_A);
  assert.equal(cfg.timeframeProfile.timeframe_style, "DAY_TRADING");
  assert.ok(cfg.timeframeProfile.trend_context_timeframes.length > 0);
  assert.ok(cfg.timeframeProfile.entry_timeframes.length > 0);
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

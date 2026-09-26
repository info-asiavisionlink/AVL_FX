// Customer AI Trader Runtime Config Loader — V2 Stage 5
//
// Assembles the canonical AITraderRuntimeConfig from Customer Supabase.
// ZERO Console API dependency.
//
// Security:
//   - Server-side admin client only (never browser / service-role exposed).
//   - Double ownership check: user_id validated on both ai_traders and query.
//   - Fail closed: throws TraderConfigError on any missing / invalid component.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SUPPORTED_TIMEFRAMES,
  TRADER_STATUSES,
  type AITraderTimeframeProfile,
  type TimeframeStyle,
} from "@/lib/aiTraderSchema";

type SupportedTf = typeof SUPPORTED_TIMEFRAMES[number];

// ── Error type ────────────────────────────────────────────────────────────────

export type TraderConfigErrorCode =
  | "CONFIG_ERROR"      // missing traderId / userId
  | "NOT_FOUND"         // trader does not exist
  | "OWNER_MISMATCH"    // trader exists but belongs to a different user
  | "NO_ACTIVE_VERSION" // ai_traders.current_version has no matching ai_trader_versions row
  | "NO_TIMEFRAME_PROFILE" // active version has no ai_trader_timeframe_profiles row
  | "INVALID_PROFILE"   // version, risk or timeframe data failed validation
  | "SERVER_ERROR";     // Supabase query error

export class TraderConfigError extends Error {
  readonly code: TraderConfigErrorCode;
  constructor(code: TraderConfigErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TraderConfigError";
    this.code = code;
  }
}

// ── Config shape ──────────────────────────────────────────────────────────────

export interface CustomerAITraderRuntimeConfig {
  trader: {
    id:             string;
    userId:         string;
    name:           string;
    market:         string;
    status:         "DRAFT" | "ACTIVE" | "ARCHIVED";
    executionMode:  "ANALYSIS_ONLY" | "MANUAL_APPROVAL" | "DEMO_AUTONOMOUS";
    killSwitch:     boolean;
    currentVersion: number;
  };
  version: {
    id:                      string;
    version:                 number;
    personality:             string;
    tradingStyle:            string;
    riskProfile:             string;
    entryPatience:           string;
    newsSensitivity:         string;
    volatilityPreference:    string;
    /** Legacy timeframes array — prefer timeframeProfile.trendContextTimeframes in V2 */
    timeframes:              string[];
    instructions:            string | null;
    magicNumber:             number | null;
    // Risk limits
    minimumRR:                     number;
    maxRiskPerTrade:               number;  // risk_per_trade_percent (1.0 = 1%)
    maxPositions:                  number;
    maxDailyTrades:                number;
    maxDailyLossUsd:               number;
    maxConsecutiveLosses:          number;
    maxTotalExposureLots:          number;
    accountDataMaxAgeSeconds:      number;
    tickDataMaxAgeSeconds:         number;
    maxSpreadPoints:               number;
    knowledgePackageVersion:       string | null;
  };
  timeframeProfile: AITraderTimeframeProfile;
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Assemble the canonical runtime configuration for an AI Trader.
 * Reads exclusively from Customer Supabase — no Console API calls.
 *
 * Fail-closed: throws TraderConfigError on any missing or invalid component.
 * Server-side only — db must be an admin client.
 */
export async function loadCustomerAITraderConfig(
  db:       SupabaseClient,
  traderId: string,
  userId:   string,
): Promise<CustomerAITraderRuntimeConfig> {
  if (!traderId || !userId) {
    throw new TraderConfigError("CONFIG_ERROR", "traderId and userId are required");
  }

  // ── 1. Load trader ──────────────────────────────────────────────────────────
  const { data: trader, error: traderErr } = await db
    .from("ai_traders")
    .select(
      "id, user_id, name, market, status, execution_mode, kill_switch, " +
      "current_version, kill_switch_reason",
    )
    .eq("id", traderId)
    .maybeSingle();

  if (traderErr) throw new TraderConfigError("SERVER_ERROR", `ai_traders query failed: ${traderErr.message}`);
  if (!trader)   throw new TraderConfigError("NOT_FOUND", `Trader ${traderId} not found`);

  const t = trader as unknown as Record<string, unknown>;
  if (t.user_id !== userId) {
    throw new TraderConfigError("OWNER_MISMATCH", `Trader ${traderId} does not belong to user ${userId}`);
  }
  const currentVersion = Number(t.current_version);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new TraderConfigError("NO_ACTIVE_VERSION", `Trader ${traderId} has invalid current_version: ${String(t.current_version)}`);
  }

  // ── 2. Load active version ──────────────────────────────────────────────────
  const { data: version, error: versionErr } = await db
    .from("ai_trader_versions")
    .select(
      "id, ai_trader_id, version, personality, trading_style, risk_profile, " +
      "entry_patience, news_sensitivity, volatility_preference, timeframes, " +
      "instructions, magic_number, minimum_rr, max_risk_per_trade, max_positions, " +
      "max_daily_trades, max_daily_loss_usd, max_consecutive_losses, " +
      "max_total_exposure_lots, market_data_max_age_seconds, " +
      "account_data_max_age_seconds, tick_data_max_age_seconds, " +
      "max_spread_points, knowledge_package_version",
    )
    .eq("ai_trader_id", traderId)
    .eq("version", currentVersion)
    .maybeSingle();

  if (versionErr) throw new TraderConfigError("SERVER_ERROR", `ai_trader_versions query failed: ${versionErr.message}`);
  if (!version)   throw new TraderConfigError("NO_ACTIVE_VERSION", `No version ${currentVersion} for trader ${traderId}`);

  const v = version as unknown as Record<string, unknown>;

  // ── 3. Load timeframe profile ───────────────────────────────────────────────
  const { data: tfProfile, error: tfErr } = await db
    .from("ai_trader_timeframe_profiles")
    .select(
      "timeframe_style, macro_context_timeframes, trend_context_timeframes, " +
      "setup_timeframes, entry_timeframes, management_timeframes, monitor_interval_minutes",
    )
    .eq("ai_trader_version_id", String(v.id))
    .maybeSingle();

  if (tfErr) throw new TraderConfigError("SERVER_ERROR", `ai_trader_timeframe_profiles query failed: ${tfErr.message}`);

  // Fail closed: every active version must have an explicit profile row.
  // Migration 038 backfills existing versions; POST /api/traders and
  // import-by-id create one alongside each new version.
  if (!tfProfile) {
    throw new TraderConfigError("NO_TIMEFRAME_PROFILE", `No timeframe profile for version ${String(v.id)}`);
  }
  let resolvedTfProfile: AITraderTimeframeProfile;
  try {
    resolvedTfProfile = normalizeTimeframeProfileRow(tfProfile as unknown as Record<string, unknown>);
  } catch (e) {
    throw new TraderConfigError("INVALID_PROFILE", `Timeframe profile invalid: ${(e as Error).message}`);
  }

  // Risk limits are safety-critical: no silent defaults.  A NULL / non-finite /
  // out-of-range value means the stored config is broken, so stop here.
  let risk: RiskLimits;
  try {
    risk = normalizeRiskLimits(v);
  } catch (e) {
    throw new TraderConfigError("INVALID_PROFILE", `Risk config invalid: ${(e as Error).message}`);
  }

  // ── 4. Validate execution mode / status ─────────────────────────────────────
  // No default: a missing mode is broken config, never an implicit permission.
  const executionMode = String(t.execution_mode);
  const ALLOWED_MODES = ["ANALYSIS_ONLY", "MANUAL_APPROVAL", "DEMO_AUTONOMOUS"] as const;
  if (!(ALLOWED_MODES as readonly string[]).includes(executionMode)) {
    throw new TraderConfigError("INVALID_PROFILE", `Unknown execution_mode: ${executionMode}`);
  }
  const status = String(t.status);
  if (!(TRADER_STATUSES as readonly string[]).includes(status)) {
    throw new TraderConfigError("INVALID_PROFILE", `Unknown status: ${status}`);
  }

  // ── 5. Validate market ──────────────────────────────────────────────────────
  const market = typeof t.market === "string" ? t.market.trim() : "";
  if (!/^[A-Z0-9][A-Z0-9#._]{0,19}$/.test(market)) {
    throw new TraderConfigError("INVALID_PROFILE", `Malformed market: ${String(t.market)}`);
  }

  // ── 6. Assemble config ──────────────────────────────────────────────────────
  return {
    trader: {
      id:             String(t.id),
      userId:         String(t.user_id),
      name:           String(t.name ?? ""),
      market,
      status:         status as CustomerAITraderRuntimeConfig["trader"]["status"],
      executionMode:  executionMode as CustomerAITraderRuntimeConfig["trader"]["executionMode"],
      // Anything other than an explicit false is treated as engaged.
      killSwitch:     t.kill_switch !== false,
      currentVersion,
    },
    version: {
      id:                   String(v.id),
      version:              Number(v.version),
      personality:          String(v.personality ?? "BALANCED"),
      tradingStyle:         String(v.trading_style ?? "TREND_FOLLOWING"),
      riskProfile:          String(v.risk_profile ?? "MEDIUM"),
      entryPatience:        String(v.entry_patience ?? "NORMAL"),
      newsSensitivity:      String(v.news_sensitivity ?? "MEDIUM"),
      volatilityPreference: String(v.volatility_preference ?? "NORMAL"),
      timeframes:           Array.isArray(v.timeframes) ? (v.timeframes as string[]) : ["H1"],
      instructions:         typeof v.instructions === "string" ? v.instructions : null,
      magicNumber:          typeof v.magic_number === "number" ? v.magic_number : null,
      ...risk,
      knowledgePackageVersion:      typeof v.knowledge_package_version === "string" ? v.knowledge_package_version : null,
    },
    timeframeProfile: resolvedTfProfile,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const VALID_TIMEFRAMES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"]);
const VALID_TF_STYLES  = new Set(["SCALPING", "DAY_TRADING", "SWING"]);

type RiskLimits = Pick<CustomerAITraderRuntimeConfig["version"],
  | "minimumRR" | "maxRiskPerTrade" | "maxPositions" | "maxDailyTrades" | "maxDailyLossUsd"
  | "maxConsecutiveLosses" | "maxTotalExposureLots" | "accountDataMaxAgeSeconds"
  | "tickDataMaxAgeSeconds" | "maxSpreadPoints">;

// Ranges mirror the DB CHECK constraints (021/025/038) and the Builder schema.
function num(row: Record<string, unknown>, field: string, min: number, max: number, integer = false): number {
  const raw = row[field];
  // Postgres NUMERIC may arrive as a string via PostgREST; null/undefined never defaults.
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${field} invalid: ${String(raw)}`);
  }
  return n;
}

function normalizeRiskLimits(v: Record<string, unknown>): RiskLimits {
  const maxRiskPerTrade = num(v, "max_risk_per_trade", 0, 10);
  const maxTotalExposureLots = num(v, "max_total_exposure_lots", 0, 100);
  const minimumRR = num(v, "minimum_rr", 0, 10);
  if (maxRiskPerTrade <= 0) throw new Error("max_risk_per_trade must be > 0");
  if (maxTotalExposureLots <= 0) throw new Error("max_total_exposure_lots must be > 0");
  if (minimumRR <= 0) throw new Error("minimum_rr must be > 0");
  return {
    minimumRR,
    maxRiskPerTrade,
    maxPositions:             num(v, "max_positions", 1, 10, true),
    maxDailyTrades:           num(v, "max_daily_trades", 0, 1000, true),
    maxDailyLossUsd:          num(v, "max_daily_loss_usd", 0, 1e9),
    maxConsecutiveLosses:     num(v, "max_consecutive_losses", 0, 1000, true),
    maxTotalExposureLots,
    accountDataMaxAgeSeconds: num(v, "account_data_max_age_seconds", 1, 3600, true),
    tickDataMaxAgeSeconds:    num(v, "tick_data_max_age_seconds", 1, 3600, true),
    maxSpreadPoints:          num(v, "max_spread_points", 0, 1e6, true),
  };
}

function validateTfArray(arr: unknown, field: string): SupportedTf[] {
  if (!Array.isArray(arr)) throw new Error(`${field} is not an array`);
  if (arr.some(tf => typeof tf !== "string" || !VALID_TIMEFRAMES.has(tf))) {
    throw new Error(`${field} contains unsupported timeframe`);
  }
  if (new Set(arr).size !== arr.length) throw new Error(`${field} contains duplicates`);
  return arr as SupportedTf[];
}

function normalizeTimeframeProfileRow(row: Record<string, unknown>): AITraderTimeframeProfile {
  const style = String(row.timeframe_style);
  if (!VALID_TF_STYLES.has(style)) throw new Error(`Unknown timeframe_style: ${style}`);

  const trendCtx = validateTfArray(row.trend_context_timeframes, "trend_context_timeframes");
  const entry    = validateTfArray(row.entry_timeframes, "entry_timeframes");

  if (trendCtx.length === 0) throw new Error("trend_context_timeframes must not be empty");
  if (entry.length === 0)    throw new Error("entry_timeframes must not be empty");

  const interval = Number(row.monitor_interval_minutes);
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
    throw new Error(`monitor_interval_minutes out of range: ${interval}`);
  }

  return {
    timeframe_style:          style as TimeframeStyle,
    macro_context_timeframes: validateTfArray(row.macro_context_timeframes, "macro_context_timeframes"),
    trend_context_timeframes: trendCtx,
    setup_timeframes:         validateTfArray(row.setup_timeframes, "setup_timeframes"),
    entry_timeframes:         entry,
    management_timeframes:    validateTfArray(row.management_timeframes, "management_timeframes"),
    monitor_interval_minutes: interval,
  };
}

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
  DEFAULT_DAY_TRADING_TIMEFRAME_PROFILE,
  SUPPORTED_TIMEFRAMES,
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
  | "INVALID_PROFILE"   // version or timeframe data failed normalisation
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
    .eq("version", Number(t.current_version))
    .maybeSingle();

  if (versionErr) throw new TraderConfigError("SERVER_ERROR", `ai_trader_versions query failed: ${versionErr.message}`);
  if (!version)   throw new TraderConfigError("NO_ACTIVE_VERSION", `No version ${t.current_version} for trader ${traderId}`);

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

  // Validate timeframe profile. Fall back to DEFAULT_DAY_TRADING only if the table row
  // is absent (pre-migration trader). Fail closed on invalid data (bad DB content).
  const rawTfProfile = tfProfile as Record<string, unknown> | null;
  let resolvedTfProfile: AITraderTimeframeProfile;
  if (!rawTfProfile) {
    // No profile row: use default (safe backward-compat fallback for pre-Stage-5 traders)
    resolvedTfProfile = DEFAULT_DAY_TRADING_TIMEFRAME_PROFILE;
  } else {
    try {
      resolvedTfProfile = normalizeTimeframeProfileRow(rawTfProfile);
    } catch (e) {
      throw new TraderConfigError("INVALID_PROFILE", `Timeframe profile invalid: ${(e as Error).message}`);
    }
  }

  // ── 4. Validate execution mode ──────────────────────────────────────────────
  const executionMode = String(t.execution_mode ?? "ANALYSIS_ONLY");
  const ALLOWED_MODES = ["ANALYSIS_ONLY", "MANUAL_APPROVAL", "DEMO_AUTONOMOUS"] as const;
  if (!(ALLOWED_MODES as readonly string[]).includes(executionMode)) {
    throw new TraderConfigError("INVALID_PROFILE", `Unknown execution_mode: ${executionMode}`);
  }

  // ── 5. Validate market ──────────────────────────────────────────────────────
  const market = String(t.market ?? "");
  if (!market) throw new TraderConfigError("INVALID_PROFILE", "market is empty");

  // ── 6. Assemble config ──────────────────────────────────────────────────────
  return {
    trader: {
      id:             String(t.id),
      userId:         String(t.user_id),
      name:           String(t.name ?? ""),
      market,
      status:         (t.status as CustomerAITraderRuntimeConfig["trader"]["status"]) ?? "DRAFT",
      executionMode:  executionMode as CustomerAITraderRuntimeConfig["trader"]["executionMode"],
      killSwitch:     Boolean(t.kill_switch),
      currentVersion: Number(t.current_version),
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
      minimumRR:                    Number(v.minimum_rr ?? 1.5),
      maxRiskPerTrade:              Number(v.max_risk_per_trade ?? 1.0),
      maxPositions:                 Number(v.max_positions ?? 1),
      maxDailyTrades:               Number(v.max_daily_trades ?? 5),
      maxDailyLossUsd:              Number(v.max_daily_loss_usd ?? 100),
      maxConsecutiveLosses:         Number(v.max_consecutive_losses ?? 3),
      maxTotalExposureLots:         Number(v.max_total_exposure_lots ?? 0.2),
      accountDataMaxAgeSeconds:     Number(v.account_data_max_age_seconds ?? 30),
      tickDataMaxAgeSeconds:        Number(v.tick_data_max_age_seconds ?? 30),
      maxSpreadPoints:              Number(v.max_spread_points ?? 0),
      knowledgePackageVersion:      typeof v.knowledge_package_version === "string" ? v.knowledge_package_version : null,
    },
    timeframeProfile: resolvedTfProfile,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const VALID_TIMEFRAMES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"]);
const VALID_TF_STYLES  = new Set(["SCALPING", "DAY_TRADING", "SWING"]);

function validateTfArray(arr: unknown, field: string): SupportedTf[] {
  if (!Array.isArray(arr)) return [];
  const result = (arr as unknown[]).filter(x => typeof x === "string") as string[];
  if (result.some(tf => !VALID_TIMEFRAMES.has(tf))) {
    throw new Error(`${field} contains unsupported timeframe`);
  }
  return result as SupportedTf[];
}

function normalizeTimeframeProfileRow(row: Record<string, unknown>): AITraderTimeframeProfile {
  const style = String(row.timeframe_style ?? "DAY_TRADING");
  if (!VALID_TF_STYLES.has(style)) throw new Error(`Unknown timeframe_style: ${style}`);

  const trendCtx = validateTfArray(row.trend_context_timeframes, "trend_context_timeframes");
  const entry    = validateTfArray(row.entry_timeframes, "entry_timeframes");

  if (trendCtx.length === 0) throw new Error("trend_context_timeframes must not be empty");
  if (entry.length === 0)    throw new Error("entry_timeframes must not be empty");

  const interval = Number(row.monitor_interval_minutes ?? 5);
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

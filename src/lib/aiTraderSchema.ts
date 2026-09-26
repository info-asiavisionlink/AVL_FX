// =================================================================
// aiTraderSchema.ts — AI Trader Profile の Zod バリデーション
// =================================================================

import { z } from "zod";
// ── Public ID 生成（cryptographically random、nanoid不要）────────
const TRADER_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字除外

export function generateTraderPublicId(): string {
  const arr = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    // Node.js fallback
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require("crypto") as { randomFillSync: (buf: Uint8Array) => void };
    nodeCrypto.randomFillSync(arr);
  }
  return Array.from(arr).map(b => TRADER_ID_ALPHABET[b % TRADER_ID_ALPHABET.length]).join("");
}

// ── Enums ─────────────────────────────────────────────────────────
export const PERSONALITIES = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as const;
export const TRADING_STYLES = [
  "TREND_FOLLOWING", "BREAKOUT", "REVERSAL",
  "PRICE_ACTION", "MULTI_TIMEFRAME", "HYBRID",
] as const;
export const RISK_PROFILES     = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"] as const;
export const ENTRY_PATIENCES   = ["VERY_PATIENT", "PATIENT", "NORMAL", "AGGRESSIVE"] as const;
export const NEWS_SENSITIVITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export const VOLATILITY_PREFS  = ["LOW", "NORMAL", "HIGH"] as const;
export const TRADER_STATUSES   = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export const SUPPORTED_MARKETS = ["GOLD"] as const;
export const SUPPORTED_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;
export const TIMEFRAME_STYLES = ["SCALPING", "DAY_TRADING", "SWING"] as const;
export type TimeframeStyle = typeof TIMEFRAME_STYLES[number];

// ── Labels (Japanese) ─────────────────────────────────────────────
export const PERSONALITY_LABELS: Record<string, string> = {
  CONSERVATIVE: "慎重型",
  BALANCED:     "バランス型",
  AGGRESSIVE:   "積極型",
};

export const TRADING_STYLE_LABELS: Record<string, string> = {
  TREND_FOLLOWING: "トレンドフォロー",
  BREAKOUT:        "ブレイクアウト",
  REVERSAL:        "リバーサル",
  PRICE_ACTION:    "プライスアクション",
  MULTI_TIMEFRAME: "マルチタイムフレーム",
  HYBRID:          "ハイブリッド",
};

export const RISK_PROFILE_LABELS: Record<string, string> = {
  VERY_LOW: "超低リスク",
  LOW:      "低リスク",
  MEDIUM:   "中リスク",
  HIGH:     "高リスク",
};

export const ENTRY_PATIENCE_LABELS: Record<string, string> = {
  VERY_PATIENT: "非常に慎重",
  PATIENT:      "慎重",
  NORMAL:       "標準",
  AGGRESSIVE:   "積極的",
};

export const NEWS_SENSITIVITY_LABELS: Record<string, string> = {
  HIGH:   "高（ニュース前後は回避）",
  MEDIUM: "中（注意して対応）",
  LOW:    "低（影響を受けにくい）",
};

export const VOLATILITY_PREF_LABELS: Record<string, string> = {
  LOW:    "低ボラ好み",
  NORMAL: "標準",
  HIGH:   "高ボラ好み",
};

// ── AI Trader Profile Schema ──────────────────────────────────────
export const AITraderProfileSchema = z.object({
  personality:           z.enum(PERSONALITIES).default("BALANCED"),
  trading_style:         z.enum(TRADING_STYLES).default("TREND_FOLLOWING"),
  risk_profile:          z.enum(RISK_PROFILES).default("MEDIUM"),
  entry_patience:        z.enum(ENTRY_PATIENCES).default("NORMAL"),
  news_sensitivity:      z.enum(NEWS_SENSITIVITIES).default("MEDIUM"),
  volatility_preference: z.enum(VOLATILITY_PREFS).default("NORMAL"),
  timeframes:            z.array(z.string()).min(1).max(5).default(["H4"]),
  minimum_rr:            z.number().min(0.5).max(10).default(1.5),
  max_risk_per_trade:    z.number().min(0.1).max(10).default(1.0),
  max_positions:         z.number().int().min(1).max(10).default(1),
  instructions:          z.string().max(2000).optional(),
});

export type AITraderProfile = z.infer<typeof AITraderProfileSchema>;

/**
 * The Builder/save boundary deliberately does not use the defaulted runtime
 * profile schema.  A generated profile must contain every field explicitly;
 * defaults are for legacy/runtime reads only and must never repair AI output.
 */
export const AITraderBuilderProfileSchema = z.object({
  personality:           z.enum(PERSONALITIES),
  trading_style:         z.enum(TRADING_STYLES),
  risk_profile:          z.enum(RISK_PROFILES),
  entry_patience:        z.enum(ENTRY_PATIENCES),
  news_sensitivity:      z.enum(NEWS_SENSITIVITIES),
  volatility_preference: z.enum(VOLATILITY_PREFS),
  timeframes:            z.array(z.string().min(1)).min(1).max(5),
  minimum_rr:            z.number().finite().min(0.5).max(10),
  max_risk_per_trade:    z.number().finite().min(0.1).max(10),
  max_positions:         z.number().finite().int().min(1).max(10),
  instructions:          z.string().min(1).max(2000),
}).strict();

export const AITraderBuilderOutputSchema = z.object({
  name:                    z.string().trim().min(2).max(50),
  description:             z.string().trim().min(1).max(500),
  reasoning:               z.string().trim().min(1).max(1000),
  profile:                 AITraderBuilderProfileSchema,
  suggested_knowledge_ids: z.array(z.string().min(1)).max(100).default([]),
  execution_mode:         z.literal("ANALYSIS_ONLY").default("ANALYSIS_ONLY"),
}).strict();

// V2 Timeframe Profile schema — stored in ai_trader_timeframe_profiles table.
// At least one trend_context and one entry timeframe required.
const tfArray = () =>
  z.array(z.enum(SUPPORTED_TIMEFRAMES)).min(0).max(5);

export const AITraderTimeframeProfileSchema = z.object({
  timeframe_style:          z.enum(TIMEFRAME_STYLES).default("DAY_TRADING"),
  macro_context_timeframes: tfArray().default([]),
  trend_context_timeframes: tfArray().min(1),
  setup_timeframes:         tfArray().default([]),
  entry_timeframes:         tfArray().min(1),
  management_timeframes:    tfArray().default([]),
  monitor_interval_minutes: z.number().int().min(1).max(60).default(5),
}).strict();

export type AITraderTimeframeProfile = z.infer<typeof AITraderTimeframeProfileSchema>;

// Default DAY_TRADING profile — matches V1 H1+M5 implicit behaviour.
export const DEFAULT_DAY_TRADING_TIMEFRAME_PROFILE: AITraderTimeframeProfile = {
  timeframe_style:          "DAY_TRADING",
  macro_context_timeframes: ["H4"],
  trend_context_timeframes: ["H4", "H1"],
  setup_timeframes:         ["M15", "M5"],
  entry_timeframes:         ["M5"],
  management_timeframes:    ["M15"],
  monitor_interval_minutes: 5,
};

export const AITraderBuilderSaveSchema = z.object({
  name:             z.string().trim().min(2).max(50),
  description:      z.string().trim().max(500).optional(),
  market:           z.string().trim().min(1).default("GOLD"),
  profile:          AITraderBuilderProfileSchema,
  timeframe_profile: AITraderTimeframeProfileSchema.optional(),
  // knowledge_ids removed in V2 Stage 5: knowledge is deployed via admin
  // HUMAN GATE operation (customer_knowledge table), not at trader creation time.
  raw_prompt:       z.string().trim().max(5000).optional(),
}).strict();

export type AITraderBuilderProfile = z.infer<typeof AITraderBuilderProfileSchema>;
export type AITraderBuilderOutput = z.infer<typeof AITraderBuilderOutputSchema>;

export function normalizeAndValidateBuilderProfile(input: unknown): AITraderBuilderProfile {
  const parsed = AITraderBuilderProfileSchema.parse(input);
  const timeframes = [...new Set(parsed.timeframes.map(tf => tf.trim().toUpperCase()))];
  if (timeframes.some(tf => !(SUPPORTED_TIMEFRAMES as readonly string[]).includes(tf))) {
    throw new Error("Unsupported timeframe");
  }
  if (timeframes.length === 0 || timeframes.length > 5) throw new Error("Invalid timeframe set");
  return { ...parsed, timeframes };
}

export function normalizeAndValidateBuilderSave(input: unknown): AITraderCreate {
  const parsed = AITraderBuilderSaveSchema.parse(input);
  const market = parsed.market.trim().toUpperCase();
  if (!(SUPPORTED_MARKETS as readonly string[]).includes(market)) throw new Error("Unsupported market");
  const timeframe_profile = normalizeAndValidateTimeframeProfile(
    parsed.timeframe_profile ?? null,
  );
  return {
    ...parsed,
    market,
    description: parsed.description || undefined,
    profile: normalizeAndValidateBuilderProfile(parsed.profile),
    timeframe_profile,
  };
}

// ── AI Trader Create Schema ───────────────────────────────────────
export const AITraderCreateSchema = AITraderBuilderSaveSchema;

export type AITraderCreate = z.infer<typeof AITraderCreateSchema>;

export function normalizeAndValidateTimeframeProfile(
  input: unknown,
  fallback = DEFAULT_DAY_TRADING_TIMEFRAME_PROFILE,
): AITraderTimeframeProfile {
  if (input == null) return fallback;
  const parsed = AITraderTimeframeProfileSchema.parse(input);
  const allTfs = [
    ...parsed.macro_context_timeframes,
    ...parsed.trend_context_timeframes,
    ...parsed.setup_timeframes,
    ...parsed.entry_timeframes,
    ...parsed.management_timeframes,
  ];
  if (allTfs.some(tf => !(SUPPORTED_TIMEFRAMES as readonly string[]).includes(tf))) {
    throw new Error("Unsupported timeframe in profile");
  }
  if (parsed.trend_context_timeframes.length === 0) throw new Error("trend_context_timeframes must not be empty");
  if (parsed.entry_timeframes.length === 0) throw new Error("entry_timeframes must not be empty");
  return parsed;
}

// ── DB record types ───────────────────────────────────────────────
export interface AITraderVersion {
  id:                    string;
  ai_trader_id:          string;
  version:               number;
  personality:           string;
  trading_style:         string;
  risk_profile:          string;
  entry_patience:        string;
  news_sensitivity:      string;
  volatility_preference: string;
  timeframes:            string[];
  minimum_rr:            number;
  max_risk_per_trade:    number;
  max_positions:         number;
  instructions:          string | null;
  model_config:          Record<string, unknown>;
  raw_prompt:            string | null;
  strategy_id:           string | null;
  created_at:            string;
}

export interface AITraderKnowledge {
  id:                   string;
  ai_trader_version_id: string;
  knowledge_id:         string;
  knowledge_version:    number | null;
  knowledge_title:      string | null;
  knowledge_category:   string | null;
  created_at:           string;
}

export type WatcherState = "SLEEPING" | "WATCHING" | "TRIGGERED" | "ANALYZING" | "ERROR";

export interface AITrader {
  id:                    string;
  user_id:               string | null;
  public_id:             string;
  name:                  string;
  description:           string | null;
  market:                string;
  status:                "DRAFT" | "ACTIVE" | "ARCHIVED";
  execution_mode:        "ANALYSIS_ONLY" | "MANUAL_APPROVAL" | "DEMO_AUTONOMOUS" | null;
  kill_switch:           boolean | null;
  current_version:       number;
  // Market Watcher state（DB: 024_ai_trader_watcher.sql で追加）
  watcher_state:         WatcherState | null;
  last_watcher_check_at: string | null;
  last_analysis_at:      string | null;
  created_at:            string;
  updated_at:            string;
  // Joined fields (optional)
  current_profile?: AITraderVersion;
  knowledge_list?:  AITraderKnowledge[];
}

// Watcher状態の日本語ラベル
export const WATCHER_STATE_LABELS: Record<WatcherState, { label: string; color: string; bg: string; pulse?: boolean }> = {
  SLEEPING:   { label: "待機中",   color: "#94a3b8", bg: "#f8fafc" },
  WATCHING:   { label: "監視中",   color: "#2563eb", bg: "#eff6ff", pulse: true },
  TRIGGERED:  { label: "検知！",   color: "#d97706", bg: "#fffbeb", pulse: true },
  ANALYZING:  { label: "AI分析中", color: "#7c3aed", bg: "#f5f3ff", pulse: true },
  ERROR:      { label: "エラー",   color: "#dc2626", bg: "#fef2f2" },
};

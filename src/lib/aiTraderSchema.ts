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

// ── AI Trader Create Schema ───────────────────────────────────────
export const AITraderCreateSchema = z.object({
  name:            z.string().min(2).max(50),
  description:     z.string().max(500).optional(),
  market:          z.string().default("GOLD"),
  profile:         AITraderProfileSchema,
  knowledge_ids:   z.array(z.string()).default([]),  // Console Knowledge IDs
  raw_prompt:      z.string().max(5000).optional(),
});

export type AITraderCreate = z.infer<typeof AITraderCreateSchema>;

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

export interface AITrader {
  id:              string;
  user_id:         string | null;
  public_id:       string;
  name:            string;
  description:     string | null;
  market:          string;
  status:          "DRAFT" | "ACTIVE" | "ARCHIVED";
  current_version: number;
  created_at:      string;
  updated_at:      string;
  // Joined fields (optional)
  current_profile?: AITraderVersion;
  knowledge_list?:  AITraderKnowledge[];
}

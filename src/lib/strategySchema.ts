// =================================================================
// strategySchema.ts — Strategy Specification の Zod バリデーション
//
// 設計原則:
//   - ホワイトリスト方式: 許可されたインジケーター・TF 以外は拒否
//   - AI が生成したコードを実行できないよう、実行可能命令を排除
//   - Supabase 保存前に必ず通過させること
// =================================================================

import { z } from "zod";

// ------------------------------------------------------------------
// ホワイトリスト定数
// ------------------------------------------------------------------

/** AVL FX で現在利用可能なインジケーター（MT5/Gateway から受信済み）*/
export const ALLOWED_INDICATORS = [
  "RSI",
  "EMA",
  "SMA",
  "MACD",
  "ADX",
  "ATR",
  "BOLLINGER_BANDS",
  "STOCHASTIC",
  "PRICE_ACTION",
  "MARKET_STRUCTURE",
  "SUPPORT_RESISTANCE",
] as const;

export const ALLOWED_TIMEFRAMES = [
  "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1",
] as const;

export const ALLOWED_STRATEGY_TYPES = [
  "SCALPING", "DAY_TRADE", "SWING",
] as const;

export const ALLOWED_SESSIONS = [
  "TOKYO", "LONDON", "NEW_YORK", "SYDNEY",
] as const;

export const ALLOWED_SYMBOLS = [
  "EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD",
  "USDCHF", "NZDUSD", "EURJPY", "GBPJPY", "AUDJPY",
  "CADJPY", "CHFJPY", "NZDJPY", "EURGBP", "EURAUD",
  "GOLD", "XAUUSD", "SILVER", "XAGUSD",
  "US30CASH", "US500CASH", "US100CASH",
  "OILCASH", "BRENTCASH",
] as const;

export const ALLOWED_OPERATORS = [
  "BELOW", "ABOVE", "CROSS_UP", "CROSS_DOWN",
  "PRICE_ABOVE", "PRICE_BELOW",
  "BULLISH_CROSS", "BEARISH_CROSS",
  "ABOVE_SIGNAL", "BELOW_SIGNAL",
  "HISTOGRAM_POSITIVE", "HISTOGRAM_NEGATIVE",
  "REVERSAL",
] as const;

export const ALLOWED_SL_METHODS = [
  "ATR", "FIXED_PIPS", "SWING_LOW", "SWING_HIGH", "PERCENTAGE",
] as const;

export const ALLOWED_TP_METHODS = [
  "ATR", "FIXED_PIPS", "SWING_LOW", "SWING_HIGH", "RR_RATIO", "PERCENTAGE",
] as const;

// ------------------------------------------------------------------
// サブスキーマ
// ------------------------------------------------------------------

/** 個別インジケーター条件 */
const IndicatorConditionSchema = z.object({
  indicator: z.enum(ALLOWED_INDICATORS),
  timeframe: z.enum(ALLOWED_TIMEFRAMES),
  period:    z.number().int().min(1).max(500).optional(),
  period2:   z.number().int().min(1).max(500).optional(), // MACD slow, etc.
  period3:   z.number().int().min(1).max(500).optional(), // MACD signal, etc.
  operator:  z.enum(ALLOWED_OPERATORS).optional(),
  threshold: z.number().min(-10000).max(10000).optional(),
  deviation: z.number().min(0.1).max(5).optional(),       // BB 偏差
  condition: z.string().max(50).optional(),               // 補足説明（表示用）
});

/** エントリー条件グループ */
const EntryConditionsSchema = z.object({
  logic:      z.enum(["AND", "OR"]),
  conditions: z.array(IndicatorConditionSchema).min(1).max(8),
});

/** SL/TP 条件 */
const ExitConditionsSchema = z.object({
  stop_loss: z.object({
    method:     z.enum(ALLOWED_SL_METHODS),
    period:     z.number().int().min(1).max(100).optional(),
    multiplier: z.number().min(0.1).max(10).optional(),
    pips:       z.number().min(1).max(1000).optional(),
    pct:        z.number().min(0.01).max(10).optional(),
  }).optional(),
  take_profit: z.object({
    method:     z.enum(ALLOWED_TP_METHODS),
    period:     z.number().int().min(1).max(100).optional(),
    multiplier: z.number().min(0.1).max(20).optional(),
    pips:       z.number().min(1).max(5000).optional(),
    rr_ratio:   z.number().min(0.5).max(20).optional(),
    pct:        z.number().min(0.01).max(20).optional(),
  }).optional(),
}).optional();

/** トレンドフィルター */
const TrendFilterSchema = z.object({
  timeframe:  z.enum(ALLOWED_TIMEFRAMES),
  indicator:  z.enum(ALLOWED_INDICATORS),
  period:     z.number().int().min(1).max(500).optional(),
  direction:  z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
}).optional();

/** フィルター */
const FiltersSchema = z.object({
  max_spread_pips: z.number().min(0).max(20).optional(),
  sessions:        z.array(z.enum(ALLOWED_SESSIONS)).max(4).optional(),
  trend_filter:    TrendFilterSchema,
  min_adx:         z.number().min(0).max(100).optional(),
}).optional();

/** リスク設定 */
const RiskSchema = z.object({
  risk_per_trade: z.number().min(0.01).max(5.0),
});

// ------------------------------------------------------------------
// メインスキーマ
// ------------------------------------------------------------------

export const StrategySpecSchema = z.object({
  name: z
    .string()
    .min(3, "名前は3文字以上")
    .max(50, "名前は50文字以内")
    .regex(/^[a-zA-Z0-9\s\-_]+$/, "名前に使用できない文字が含まれています"),

  strategy_type: z.enum(ALLOWED_STRATEGY_TYPES),

  description: z.string().max(500).optional(),

  symbols: z
    .array(z.string().max(20))
    .min(1, "シンボルを1つ以上指定")
    .max(5, "シンボルは最大5つ"),

  timeframes: z
    .array(z.enum(ALLOWED_TIMEFRAMES))
    .min(1, "時間足を1つ以上指定")
    .max(5, "時間足は最大5つ"),

  entry_conditions: EntryConditionsSchema,
  exit_conditions:  ExitConditionsSchema,
  filters:          FiltersSchema,

  risk: RiskSchema,
});

export type StrategySpec = z.infer<typeof StrategySpecSchema>;

// ------------------------------------------------------------------
// Supabase 保存用型（DB レコード）
// ------------------------------------------------------------------

export interface StrategyRecord {
  id:              string;
  name:            string;
  strategy_type:   "SCALPING" | "DAY_TRADE" | "SWING";
  description:     string | null;
  symbols:         string[];
  timeframes:      string[];
  entry_conditions: Record<string, unknown>;
  exit_conditions:  Record<string, unknown> | null;
  filters:          Record<string, unknown> | null;
  risk:             Record<string, unknown>;
  magic_number:     number | null;
  enabled:          boolean;
  status:           "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  backtest_status:  "NOT_TESTED" | "TESTING" | "PASSED" | "FAILED";
  ai_score:         number | null;
  ai_verdict:       string | null;
  raw_prompt:       string | null;
  created_at:       string;
  updated_at:       string;
}

// ------------------------------------------------------------------
// ヘルパー: 条件の人間可読文字列
// ------------------------------------------------------------------

export function conditionToJapanese(cond: z.infer<typeof IndicatorConditionSchema>): string {
  const tf = cond.timeframe;
  const ind = cond.indicator;
  const p = cond.period ? `(${cond.period})` : "";
  const op = cond.operator;
  const th = cond.threshold;

  switch (ind) {
    case "RSI": {
      if (op === "CROSS_UP"  && th !== undefined) return `${tf} RSI${p} ${th}以下から上向き転換`;
      if (op === "CROSS_DOWN"&& th !== undefined) return `${tf} RSI${p} ${th}以上から下向き転換`;
      if (op === "BELOW"     && th !== undefined) return `${tf} RSI${p} < ${th}`;
      if (op === "ABOVE"     && th !== undefined) return `${tf} RSI${p} > ${th}`;
      if (op === "REVERSAL")                      return `${tf} RSI${p} 反転`;
      return `${tf} RSI${p}`;
    }
    case "EMA":
    case "SMA": {
      if (op === "PRICE_ABOVE")    return `${tf} ${ind}${p} より価格が上`;
      if (op === "PRICE_BELOW")    return `${tf} ${ind}${p} より価格が下`;
      if (op === "BULLISH_CROSS")  return `${tf} ${ind}${p} ゴールデンクロス`;
      if (op === "BEARISH_CROSS")  return `${tf} ${ind}${p} デッドクロス`;
      return `${tf} ${ind}${p}`;
    }
    case "MACD": {
      if (op === "ABOVE_SIGNAL")         return `${tf} MACD がシグナルを上抜け`;
      if (op === "BELOW_SIGNAL")         return `${tf} MACD がシグナルを下抜け`;
      if (op === "HISTOGRAM_POSITIVE")   return `${tf} MACD ヒストグラム プラス`;
      if (op === "HISTOGRAM_NEGATIVE")   return `${tf} MACD ヒストグラム マイナス`;
      return `${tf} MACD`;
    }
    case "ADX": {
      if (op === "ABOVE" && th !== undefined) return `${tf} ADX${p} > ${th} (トレンド相場)`;
      if (op === "BELOW" && th !== undefined) return `${tf} ADX${p} < ${th} (レンジ相場)`;
      return `${tf} ADX${p}`;
    }
    case "BOLLINGER_BANDS": {
      if (op === "PRICE_ABOVE") return `${tf} BB 上限を上抜け`;
      if (op === "PRICE_BELOW") return `${tf} BB 下限を下抜け`;
      return `${tf} Bollinger Bands`;
    }
    case "STOCHASTIC": {
      if (op === "CROSS_UP"  && th !== undefined) return `${tf} Stochastic${p} ${th}以下から上転換`;
      if (op === "CROSS_DOWN"&& th !== undefined) return `${tf} Stochastic${p} ${th}以上から下転換`;
      return `${tf} Stochastic${p}`;
    }
    case "MARKET_STRUCTURE": {
      if (op === "ABOVE")  return `${tf} 上昇トレンド構造`;
      if (op === "BELOW")  return `${tf} 下降トレンド構造`;
      return `${tf} 市場構造`;
    }
    default:
      return `${tf} ${ind}${p}`;
  }
}

// =================================================================
// POST /api/ai/strategy/build
//
// 自然言語 → Strategy Specification JSON
//
// 入力フォーマット:
//   新形式（推奨）:
//     { entry_conditions_text, take_profit_conditions_text, stop_loss_conditions_text }
//   旧形式（後方互換）:
//     { prompt }
//
// フロー:
//   1. 入力受信・バリデーション
//   2. OpenAI に Structured Output を要求
//   3. Zod バリデーション（ホワイトリスト検証）
//   4. PASS → spec を返す（保存は /api/strategies で行う）
//   5. FAIL → エラー理由を返す
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";
import {
  StrategySpecSchema,
  ALLOWED_INDICATORS,
  ALLOWED_TIMEFRAMES,
  ALLOWED_SESSIONS,
  ALLOWED_OPERATORS,
  type StrategySpec,
} from "@/lib/strategySchema";

export const runtime = "nodejs";

// ------------------------------------------------------------------
// System Prompt — 3セクション分離対応
// ------------------------------------------------------------------

function buildSystemPrompt3Field(): string {
  return `You are AVL FX Strategy Architect. The user provides their trading rules in 3 clearly separated sections. Convert them into a structured Strategy Specification JSON.

## CRITICAL SECTION MAPPING — NEVER MIX SECTIONS

ENTRY CONDITIONS section  →  Populate: name, strategy_type, description, symbols, timeframes, entry_conditions, filters (sessions, max_spread_pips, trend_filter, trend_filters, min_adx)

TAKE PROFIT section  →  Populate: exit_conditions.take_profit ONLY. Do NOT put TP logic into entry_conditions.

STOP LOSS section  →  Populate: exit_conditions.stop_loss ONLY. Do NOT put SL logic into entry_conditions.

Both exit_conditions.take_profit AND exit_conditions.stop_loss are REQUIRED. Always populate both.

## OUTPUT FORMAT (strict JSON only — no markdown, no code blocks, no explanation)

{
  "name": string,
  "strategy_type": "SCALPING" | "DAY_TRADE" | "SWING",
  "description": string,
  "symbols": string[],
  "timeframes": string[],
  "entry_conditions": {
    "logic": "AND" | "OR",
    "conditions": [
      {
        "indicator": string,
        "timeframe": string,
        "period": number (optional),
        "operator": string (optional),
        "threshold": number (optional),
        "condition": string (optional, human-readable label)
      }
    ]
  },
  "exit_conditions": {
    "stop_loss": {
      "method": string,
      "period": number (optional),
      "multiplier": number (optional),
      "pips": number (optional)
    },
    "take_profit": {
      "method": string,
      "period": number (optional),
      "multiplier": number (optional),
      "pips": number (optional),
      "rr_ratio": number (optional)
    }
  },
  "filters": {
    "max_spread_pips": number (optional),
    "sessions": string[] (optional),
    "trend_filter": {
      "timeframe": string,
      "indicator": string,
      "period": number (optional),
      "direction": "BULLISH" | "BEARISH" | "NEUTRAL"
    } (optional),
    "min_adx": number (optional)
  },
  "risk": {
    "risk_per_trade": number
  }
}

## WHITELISTS — USE ONLY THESE VALUES

Indicators: ${ALLOWED_INDICATORS.join(", ")}
Timeframes: ${ALLOWED_TIMEFRAMES.join(", ")}
Strategy Types: SCALPING (M1–M15 primary), DAY_TRADE (M30–H4 primary), SWING (H4–W1 primary)
Sessions: ${ALLOWED_SESSIONS.join(", ")}
Operators: ${ALLOWED_OPERATORS.join(", ")}
SL methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, PERCENTAGE
TP methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, RR_RATIO, PERCENTAGE

## UNSUPPORTED CONDITIONS

If a condition in the ENTRY CONDITIONS section CANNOT be represented with available indicators
(e.g. Dow Theory, candlestick patterns like engulfing/doji/hammer, support/resistance zones,
higher highs/higher lows, trendlines, pivot points, day-of-week restrictions):
  - Use MARKET_STRUCTURE or PRICE_ACTION as the indicator
  - Set the condition field to: "UNSUPPORTED: <original description in the user's language>"
  - DO NOT silently replace with a different indicator
  - DO NOT approximate (e.g. do NOT convert "高値更新" into an EMA condition)

## SESSION HANDLING

"東京時間のみ"        → sessions: ["TOKYO"]
"ロンドン時間のみ"    → sessions: ["LONDON"]
"NY時間のみ"          → sessions: ["NEW_YORK"]
"ロンドン・NY時間"    → sessions: ["LONDON", "NEW_YORK"]
"ロンドン時間はエントリーしない" / "ロンドン時間は除外"
  → sessions: ["TOKYO", "NEW_YORK", "SYDNEY"]  (all except LONDON)
"東京時間はエントリーしない"
  → sessions: ["LONDON", "NEW_YORK", "SYDNEY"]  (all except TOKYO)
"金曜日は取引しない" → condition: "UNSUPPORTED: 金曜日はエントリーしない"  (no day-of-week field in schema)

## SPREAD FILTER

"スプレッド2pips以下" → max_spread_pips: 2
"スプレッド3pips未満" → max_spread_pips: 3

## MULTI-TIMEFRAME TREND FILTER

Higher timeframe trend mentioned in ENTRY CONDITIONS:
"H1がEMA21より上" → filters.trend_filter = { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" }
"H4の200EMAより上" → filters.trend_filter = { timeframe: "H4", indicator: "EMA", period: 200, direction: "BULLISH" }

## TAKE PROFIT PATTERNS

"ATR × 3" / "ATR14の3倍"  → { method: "ATR", period: 14, multiplier: 3.0 }
"直近高値"                 → { method: "SWING_HIGH" }
"直近安値"                 → { method: "SWING_LOW" }
"20pips"                   → { method: "FIXED_PIPS", pips: 20 }
"RR 1:2" / "リスクリワード1:2" / "RR2" → { method: "RR_RATIO", rr_ratio: 2.0 }
"RSI70以上で利確" → use RR_RATIO with rr_ratio: 2.0 as approximation, condition: "UNSUPPORTED: RSI70超えで利確"

## STOP LOSS PATTERNS

"ATR × 2" / "ATR14の2倍" → { method: "ATR", period: 14, multiplier: 2.0 }
"直近安値"                → { method: "SWING_LOW" }
"直近安値の3pips下"       → { method: "SWING_LOW" }
"直近高値"                → { method: "SWING_HIGH" }
"10pips"                  → { method: "FIXED_PIPS", pips: 10 }
"EMA200割れ"              → { method: "SWING_LOW" } with condition note

## GENERAL RULES

1. name: 3–50 chars, alphanumeric + spaces + dash + underscore only (English preferred)
2. symbols: standard names (EURUSD, USDJPY, GOLD, GBPUSD, etc.)
3. risk_per_trade: default 1.0 if not specified (range 0.01–5.0)
4. ATR period: 14 if not specified
5. RSI period: 14 if not specified
6. EMA common periods: 9, 21, 50, 100, 200

## NEW INDICATOR USAGE GUIDE

WMA (Weighted Moving Average):
  Operators: PRICE_ABOVE (bullish), PRICE_BELOW (bearish)
  Example: "WMAより価格が上" → { indicator: "WMA", operator: "PRICE_ABOVE", period: 14 }

VWMA (Volume Weighted Moving Average — institutional price level):
  Operators: PRICE_ABOVE (bullish), PRICE_BELOW (bearish)
  Example: "VWMA14より上" → { indicator: "VWMA", operator: "PRICE_ABOVE", period: 14 }

CCI (Commodity Channel Index — overbought/oversold ±100 standard):
  Operators: ABOVE (>threshold), BELOW (<threshold), CROSS_UP, CROSS_DOWN, REVERSAL
  Example: "CCIが-100以下から反転" → { indicator: "CCI", operator: "REVERSAL", threshold: -100 }
  Example: "CCI > 100 (overbought)" → { indicator: "CCI", operator: "ABOVE", threshold: 100 }
  REVERSAL BUY default threshold: -100. REVERSAL SELL default threshold: +100.

WILLIAMS_R (Williams %R — range -100 to 0):
  Oversold: below -80. Overbought: above -20.
  Operators: ABOVE (>threshold), BELOW (<threshold), REVERSAL
  Example: "Williams%Rが-80以下から反転(BUY)" → { indicator: "WILLIAMS_R", operator: "REVERSAL", threshold: -80 }
  Example: "Williams%R > -20 (overbought)" → { indicator: "WILLIAMS_R", operator: "ABOVE", threshold: -20 }

MOMENTUM (Price momentum = Close[i] - Close[i-period]):
  Positive = upward momentum. Negative = downward momentum.
  Operators: ABOVE (>0 by default), BELOW (<0 by default), CROSS_UP (zero cross up), CROSS_DOWN
  Example: "モメンタムがプラス" → { indicator: "MOMENTUM", operator: "ABOVE", threshold: 0, period: 10 }
  Example: "モメンタムがゼロをクロスアップ" → { indicator: "MOMENTUM", operator: "CROSS_UP", threshold: 0, period: 10 }

OBV (On Balance Volume — cumulative volume direction):
  Operators: ABOVE (OBV > threshold, default 0), BELOW, CROSS_UP (zero cross)
  Example: "OBVが上昇" → { indicator: "OBV", operator: "ABOVE", threshold: 0 }
  Note: OBV absolute value has no fixed meaning; use CROSS_UP for zero-cross confirmation.

VOLUME_RATIO (Volume / SMA(Volume, period) — high volume confirmation):
  1.0 = average. 1.5+ = high volume (significant move).
  Operators: ABOVE (>threshold, default 1.5), BELOW (<threshold)
  Example: "高ボリューム確認" → { indicator: "VOLUME_RATIO", operator: "ABOVE", threshold: 1.5, period: 20 }
  VOLUME_RATIO is direction-neutral — combine with directional indicators.

HMA (Hull Moving Average — fastest smooth trend indicator):
  Operators: PRICE_ABOVE (bullish), PRICE_BELOW (bearish)
  Example: "HMA14より価格が上" → { indicator: "HMA", operator: "PRICE_ABOVE", period: 14 }

DEMA (Double Exponential MA — reduces EMA lag):
  Operators: PRICE_ABOVE (bullish), PRICE_BELOW (bearish)
  Example: "DEMA21より価格が上" → { indicator: "DEMA", operator: "PRICE_ABOVE", period: 21 }

ICHIMOKU (一目均衡表):
  Operators: PRICE_ABOVE_CLOUD (雲の上), PRICE_BELOW_CLOUD (雲の下), BULLISH_CROSS (TKクロス買い), BEARISH_CROSS (TKクロス売り), PRICE_ABOVE (基準線より上), PRICE_BELOW (基準線より下)
  Example: "雲の上にいる" → { indicator: "ICHIMOKU", operator: "PRICE_ABOVE_CLOUD" }
  Example: "転換線が基準線を上抜け(TKクロス)" → { indicator: "ICHIMOKU", operator: "BULLISH_CROSS" }

DONCHIAN (ドンチャンチャネル — breakout detection):
  Operators: PRICE_ABOVE (upper channel break = BUY breakout), PRICE_BELOW (lower break = SELL breakdown)
  Example: "ドンチャン20のブレイクアウト" → { indicator: "DONCHIAN", operator: "PRICE_ABOVE", period: 20 }

KELTNER (ケルトナーチャネル — ATR-based volatility channel):
  Operators: PRICE_ABOVE (overbought/strong trend), PRICE_BELOW (oversold)
  Example: "ケルトナー上限超え" → { indicator: "KELTNER", operator: "PRICE_ABOVE", period: 20 }

STOCH_RSI (Stochastic RSI — faster RSI oscillator):
  値域 0〜1。0.8以上=オーバーボート、0.2以下=オーバーソールド
  Operators: ABOVE (>threshold), BELOW (<threshold), REVERSAL
  Example: "StochRSIが0.2以下から反転" → { indicator: "STOCH_RSI", operator: "REVERSAL", threshold: 0.2 }

ROC (Rate of Change — momentum %):
  Operators: ABOVE (>0 = 上昇), BELOW (<0 = 下降), CROSS_UP (ゼロクロスアップ), CROSS_DOWN
  Example: "ROCがゼロを上向きクロス" → { indicator: "ROC", operator: "CROSS_UP", threshold: 0, period: 14 }

AO (Awesome Oscillator — Bill Williams):
  Operators: ABOVE (>0 = 上昇), BELOW (<0 = 下降), CROSS_UP (ゼロクロス), CROSS_DOWN
  Example: "AOがプラス" → { indicator: "AO", operator: "ABOVE", threshold: 0 }

AROON (Aroon Oscillator — trend direction/strength):
  値域 -100〜+100。正=上昇トレンド、負=下降トレンド
  Operators: ABOVE (>threshold), BELOW (<threshold), CROSS_UP, CROSS_DOWN
  Example: "AroonOscillatorがプラス" → { indicator: "AROON", operator: "ABOVE", threshold: 0, period: 14 }

FORCE_INDEX (Force Index — price × volume momentum):
  Operators: ABOVE (>0 = 買い力), BELOW (<0 = 売り力), CROSS_UP, CROSS_DOWN
  Example: "Force Indexがプラス" → { indicator: "FORCE_INDEX", operator: "ABOVE", threshold: 0, period: 13 }

MFI (Money Flow Index — volume-weighted RSI):
  値域 0〜100。80以上=オーバーボート、20以下=オーバーソールド
  Operators: ABOVE (>threshold), BELOW (<threshold), REVERSAL
  Example: "MFIが20以下から反転" → { indicator: "MFI", operator: "REVERSAL", threshold: 20 }

CMF (Chaikin Money Flow — buy/sell pressure):
  値域 -1〜+1。0.2以上=買い圧力、-0.2以下=売り圧力
  Operators: ABOVE (>threshold), BELOW (<threshold), CROSS_UP (ゼロクロス), CROSS_DOWN
  Example: "CMFがゼロを上クロス" → { indicator: "CMF", operator: "CROSS_UP", threshold: 0 }

ATR (Average True Range — volatility filter as entry condition):
  Operators: ABOVE (高ボラティリティ環境フィルター), BELOW (低ボラティリティ)
  Example: "ATR14が0.001以上（高ボラ）" → { indicator: "ATR", operator: "ABOVE", threshold: 0.001, period: 14 }
  ATR is direction-neutral — combine with directional indicators.

PSAR (Parabolic SAR — directional reversal indicator):
  Operators: PRICE_ABOVE (price > SAR = uptrend BUY), PRICE_BELOW (price < SAR = downtrend SELL)
  Example: "PSARの上にいる(上昇トレンド)" → { indicator: "PSAR", operator: "PRICE_ABOVE" }

PRICE_ACTION (ローソク足パターン — candlestick pattern):
  operator: "BULLISH" or "BEARISH"
  condition (pattern name): "PIN_BAR" | "ENGULFING" | "HAMMER" | "SHOOTING_STAR" | "DOJI" | "INSIDE_BAR" | "MORNING_STAR" | "EVENING_STAR"
  Example: "ピンバーBUY" → { indicator: "PRICE_ACTION", operator: "BULLISH", condition: "PIN_BAR", timeframe: "H1" }
  Example: "エンゴルフィングSELL" → { indicator: "PRICE_ACTION", operator: "BEARISH", condition: "ENGULFING", timeframe: "H4" }
  Example: "ハンマー" → { indicator: "PRICE_ACTION", operator: "BULLISH", condition: "HAMMER", timeframe: "H1" }
  Example: "シューティングスター" → { indicator: "PRICE_ACTION", operator: "BEARISH", condition: "SHOOTING_STAR", timeframe: "H1" }
  Example: "インサイドバー (BUY)" → { indicator: "PRICE_ACTION", operator: "BULLISH", condition: "INSIDE_BAR", timeframe: "H1" }
  Example: "モーニングスター" → { indicator: "PRICE_ACTION", operator: "BULLISH", condition: "MORNING_STAR", timeframe: "H4" }
  HAMMER is BULLISH only. SHOOTING_STAR is BEARISH only. MORNING_STAR is BULLISH only. EVENING_STAR is BEARISH only.
  Note: operator must be "BULLISH" or "BEARISH" — NOT standard operators like PRICE_ABOVE, CROSS_UP etc.

## TRAILING STOP (in exit_conditions)

trailing_stop field in exit_conditions (optional):
  { method: "ATR", multiplier: 2.0, activation_pips: 10 }  // 10pips利益で発動、ATR2倍距離で追随
  { method: "FIXED_PIPS", pips: 20 }  // 20pips固定でトレーリング
  { method: "PERCENTAGE", pct: 0.5 }  // 価格の0.5%距離でトレーリング
  activation_pips: 最低何pips利益が出たら発動するか (省略可, default 0 = 即発動)
  Examples:
    "ATR2倍トレーリング" → trailing_stop: { method: "ATR", multiplier: 2.0 }
    "20pipsトレーリングストップ" → trailing_stop: { method: "FIXED_PIPS", pips: 20 }
    "10pips以上の利益が出たらATR1.5倍でトレーリング" → trailing_stop: { method: "ATR", multiplier: 1.5, activation_pips: 10 }

## MULTIPLE TAKE PROFITS (in exit_conditions)

take_profits array in exit_conditions (optional, max 3 levels):
  Each level: { method, portion, multiplier/pips/rr_ratio/pct (optional) }
  portion: この価格でクローズする割合 (0.5 = 50%)。全レベルのportionの合計 = 1.0
  Examples:
    "ATR1.5倍で半分利確、ATR3倍で残り利確":
      take_profits: [
        { method: "ATR", multiplier: 1.5, portion: 0.5 },
        { method: "ATR", multiplier: 3.0, portion: 0.5 }
      ]
    "20pipsで50%決済、RR2.0で残り全決済":
      take_profits: [
        { method: "FIXED_PIPS", pips: 20, portion: 0.5 },
        { method: "RR_RATIO", rr_ratio: 2.0, portion: 0.5 }
      ]
  Note: take_profits and take_profit can coexist; take_profits takes precedence in the engine.

## ABSOLUTE PROHIBITIONS

- DO NOT output: javascript, typescript, mql5, python, eval, exec, function, require, import
- DO NOT output: file paths, URLs, API keys, environment variables
- DO NOT make performance guarantees (win rate, profit factor, etc.)
- DO NOT use indicators not in the whitelist
- DO NOT add JSON keys not defined in the schema
- DO NOT generate MQL5 or any executable code

Respond with ONLY the JSON object.`;
}

function buildSystemPromptLegacy(): string {
  return `You are AVL FX Strategy Architect. Convert the user's natural language EA description into a structured Strategy Specification JSON.

## OUTPUT FORMAT (strict JSON only — no other text, no markdown, no code blocks)

{
  "name": string,
  "strategy_type": "SCALPING" | "DAY_TRADE" | "SWING",
  "description": string,
  "symbols": string[],
  "timeframes": string[],
  "entry_conditions": {
    "logic": "AND" | "OR",
    "conditions": [
      {
        "indicator": string,
        "timeframe": string,
        "period": number (optional),
        "operator": string (optional),
        "threshold": number (optional),
        "condition": string (optional, human-readable label)
      }
    ]
  },
  "exit_conditions": {
    "stop_loss": { "method": string, "period": number (optional), "multiplier": number (optional), "pips": number (optional) },
    "take_profit": { "method": string, "period": number (optional), "multiplier": number (optional), "pips": number (optional), "rr_ratio": number (optional) }
  },
  "filters": {
    "max_spread_pips": number (optional),
    "sessions": string[] (optional),
    "trend_filter": { "timeframe": string, "indicator": string, "period": number (optional), "direction": "BULLISH" | "BEARISH" | "NEUTRAL" } (optional),
    "min_adx": number (optional)
  },
  "risk": { "risk_per_trade": number }
}

## WHITELISTS

Indicators: ${ALLOWED_INDICATORS.join(", ")}
Timeframes: ${ALLOWED_TIMEFRAMES.join(", ")}
Strategy Types: SCALPING (M1-M15), DAY_TRADE (M30-H4), SWING (H4-W1)
Sessions: ${ALLOWED_SESSIONS.join(", ")}
Operators: ${ALLOWED_OPERATORS.join(", ")}
SL methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, PERCENTAGE
TP methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, RR_RATIO, PERCENTAGE

## RULES
1. name: 3-50 chars, alphanumeric + spaces + dash + underscore only
2. symbols: standard FX pair names (EURUSD, USDJPY, GOLD, etc.)
3. risk_per_trade: 0.01 to 5.0
4. ATR period typically 14, RSI period typically 14, EMA period 9/21/50/100/200
5. If user mentions London/NY/Tokyo session: add to sessions array

## NEW INDICATORS
WMA/VWMA: PRICE_ABOVE (bullish), PRICE_BELOW (bearish)
CCI: ABOVE/BELOW/CROSS_UP/CROSS_DOWN/REVERSAL. Standard overbought +100, oversold -100.
WILLIAMS_R: range -100 to 0. Oversold BELOW -80, overbought ABOVE -20. Operators: ABOVE/BELOW/REVERSAL.
MOMENTUM: ABOVE(>0)/BELOW(<0)/CROSS_UP/CROSS_DOWN. period default 10.
OBV: ABOVE(>0)/BELOW(<0)/CROSS_UP. Direction neutral — combine with directional indicators.
VOLUME_RATIO: ABOVE (default threshold 1.5 = high volume) / BELOW. period default 20.
HMA/DEMA: PRICE_ABOVE (bullish), PRICE_BELOW (bearish).
ICHIMOKU: PRICE_ABOVE_CLOUD/PRICE_BELOW_CLOUD/BULLISH_CROSS/BEARISH_CROSS/PRICE_ABOVE/PRICE_BELOW.
DONCHIAN: PRICE_ABOVE (upper break = BUY), PRICE_BELOW (lower break = SELL). period default 20.
KELTNER: PRICE_ABOVE (overbought), PRICE_BELOW (oversold). period default 20.
STOCH_RSI: range 0-1. ABOVE/BELOW/REVERSAL. default thresholds 0.8/0.2.
ROC: ABOVE(>0)/BELOW(<0)/CROSS_UP/CROSS_DOWN. period default 14.
AO: ABOVE(>0)/BELOW(<0)/CROSS_UP/CROSS_DOWN. Fixed 5/34 periods.
AROON: oscillator range -100 to +100. ABOVE/BELOW/CROSS_UP/CROSS_DOWN. period default 14.
FORCE_INDEX: ABOVE(>0)/BELOW(<0)/CROSS_UP/CROSS_DOWN. period default 13.
MFI: range 0-100. ABOVE/BELOW/REVERSAL. default thresholds 80/20. period default 14.
CMF: range -1 to +1. ABOVE/BELOW/CROSS_UP/CROSS_DOWN. period default 20.
ATR: ABOVE/BELOW (volatility filter, direction-neutral). threshold = raw price value (e.g. 0.001 for EURUSD).
PSAR: PRICE_ABOVE (uptrend BUY), PRICE_BELOW (downtrend SELL).
PRICE_ACTION: operator="BULLISH"/"BEARISH", condition="PIN_BAR"/"ENGULFING"/"HAMMER"/"SHOOTING_STAR"/"DOJI"/"INSIDE_BAR"/"MORNING_STAR"/"EVENING_STAR".
  Example: { indicator: "PRICE_ACTION", operator: "BULLISH", condition: "PIN_BAR", timeframe: "H1" }

trailing_stop in exit_conditions (optional): { method: "ATR"/"FIXED_PIPS"/"PERCENTAGE", multiplier/pips/pct, activation_pips }
take_profits in exit_conditions (optional, max 3): [{ method, portion, multiplier/pips/rr_ratio/pct }]. portion sums to 1.0.

## ABSOLUTE PROHIBITIONS
- DO NOT include: javascript, typescript, mql5, python, code, function, eval, exec, require, import
- DO NOT include: file paths, URLs, API keys, environment variables
- DO NOT make performance guarantees
- DO NOT use indicators not in the whitelist

Respond with ONLY the JSON object. No explanation, no markdown.`;
}

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      // 新形式
      entry_conditions_text?:       string;
      take_profit_conditions_text?:  string;
      stop_loss_conditions_text?:    string;
      // 旧形式（後方互換）
      prompt?: string;
    };

    const isNewFormat = !!(
      body.entry_conditions_text !== undefined ||
      body.take_profit_conditions_text !== undefined ||
      body.stop_loss_conditions_text !== undefined
    );

    let systemPrompt: string;
    let userMessage:  string;

    if (isNewFormat) {
      // ── 新形式バリデーション ──────────────────────────────────────
      const entryText  = (body.entry_conditions_text ?? "").trim();
      const tpText     = (body.take_profit_conditions_text ?? "").trim();
      const slText     = (body.stop_loss_conditions_text ?? "").trim();

      if (entryText.length < 10) {
        return NextResponse.json(
          { success: false, error: "エントリー条件を10文字以上入力してください" },
          { status: 400 }
        );
      }
      if (tpText.length < 3) {
        return NextResponse.json(
          { success: false, error: "利確条件を入力してください（3文字以上）" },
          { status: 400 }
        );
      }
      if (slText.length < 3) {
        return NextResponse.json(
          { success: false, error: "損切り条件を入力してください（3文字以上）" },
          { status: 400 }
        );
      }
      if (entryText.length + tpText.length + slText.length > 3000) {
        return NextResponse.json(
          { success: false, error: "入力の合計が長すぎます（合計3000文字以内）" },
          { status: 400 }
        );
      }

      systemPrompt = buildSystemPrompt3Field();
      userMessage  = [
        "=== ENTRY CONDITIONS ===",
        entryText,
        "",
        "=== TAKE PROFIT CONDITIONS ===",
        tpText,
        "",
        "=== STOP LOSS CONDITIONS ===",
        slText,
      ].join("\n");

    } else {
      // ── 旧形式（後方互換）────────────────────────────────────────
      const prompt = (body.prompt ?? "").trim();

      if (!prompt || prompt.length < 10) {
        return NextResponse.json(
          { success: false, error: "プロンプトが短すぎます（10文字以上）" },
          { status: 400 }
        );
      }
      if (prompt.length > 2000) {
        return NextResponse.json(
          { success: false, error: "プロンプトが長すぎます（2000文字以内）" },
          { status: 400 }
        );
      }

      systemPrompt = buildSystemPromptLegacy();
      userMessage  = prompt;
    }

    // ── OpenAI 呼び出し ───────────────────────────────────────────
    const client     = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model:   process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage  },
      ],
      max_completion_tokens: 4096,
      response_format:       { type: "json_object" },
    });

    const rawText = completion.choices[0]?.message?.content ?? "";

    // ── JSON パース ───────────────────────────────────────────────
    let rawSpec: unknown;
    try {
      rawSpec = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { success: false, error: "AI の出力が JSON 形式ではありませんでした。再試行してください。" },
        { status: 422 }
      );
    }

    // ── Zod バリデーション ────────────────────────────────────────
    const validation = StrategySpecSchema.safeParse(rawSpec);

    if (!validation.success) {
      const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      return NextResponse.json(
        {
          success: false,
          error:   "Strategy Specification が無効です",
          details: issues,
          raw:     rawSpec,
        },
        { status: 422 }
      );
    }

    const spec: StrategySpec = validation.data;

    // ── 新形式: SL/TP 存在確認 ───────────────────────────────────
    if (isNewFormat) {
      if (!spec.exit_conditions?.stop_loss) {
        return NextResponse.json(
          { success: false, error: "損切り条件が生成されませんでした。損切り条件をより具体的に入力してください。" },
          { status: 422 }
        );
      }
      if (!spec.exit_conditions?.take_profit) {
        return NextResponse.json(
          { success: false, error: "利確条件が生成されませんでした。利確条件をより具体的に入力してください。" },
          { status: 422 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      spec,
      model:  completion.model,
      usage:  completion.usage,
    });

  } catch (err) {
    console.error("[ai/strategy/build]", err);
    const msg = err instanceof Error ? err.message : "不明なエラー";
    return NextResponse.json(
      { success: false, error: `AI 処理エラー: ${msg}` },
      { status: 500 }
    );
  }
}

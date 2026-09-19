// =================================================================
// POST /api/ai/strategy/build-multi
//
// 自然言語 + 指標目標 → 5つの GOLD# Strategy Specification
//
// 入力: { description, targets: { minPF?, maxMDD?, minWR?, minPayoff? } }
// 出力: { success, specs: StrategySpec[] }
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS }   from "@/infrastructure/ai/openai-client";
import {
  StrategySpecSchema,
  ALLOWED_INDICATORS,
  ALLOWED_TIMEFRAMES,
  ALLOWED_SESSIONS,
  ALLOWED_OPERATORS,
  type StrategySpec,
} from "@/lib/strategySchema";
import { z } from "zod";

export const runtime   = "nodejs";
export const maxDuration = 120;

interface MetricTargets {
  minPF?:     number;
  maxMDD?:    number;
  minWR?:     number;
  minPayoff?: number;
}

function buildMultiPrompt(description: string, targets: MetricTargets): string {
  const targetLines: string[] = [];
  if (targets.minPF)     targetLines.push(`- Profit Factor ≥ ${targets.minPF}`);
  if (targets.maxMDD)    targetLines.push(`- Max Drawdown ≤ ${targets.maxMDD}%`);
  if (targets.minWR)     targetLines.push(`- Win Rate ≥ ${targets.minWR}%`);
  if (targets.minPayoff) targetLines.push(`- Payoff Ratio ≥ ${targets.minPayoff}`);
  const targetSection = targetLines.length
    ? `\nPerformance Targets:\n${targetLines.join("\n")}`
    : "";

  return `You are AVL FX Strategy Architect specializing in GOLD# (XAU/USD) trading.

Generate exactly 5 DIVERSE, SOPHISTICATED trading strategies for GOLD#.
Each strategy MUST be genuinely different in approach, indicator combination, and market logic.

## BAR DATA AVAILABLE (3-year backtest window: 2023-2026)
- H4: 3 years (2023-09 to 2026-09) ← PRIMARY timeframe for DAY_TRADE
- D1: 3 years (2023-09 to 2026-09) ← use for trend filters or SWING
- H1: 10 months (2025-11 to 2026-09) ← secondary only
- M30/M15/M5: limited (avoid as primary)

## USER REQUEST
"${description}"
${targetSection}

## INDICATOR CATALOG — USE THE FULL RANGE, NOT JUST MACD/EMA
You have access to 29 indicators. DO NOT default to only MACD/EMA/RSI. Mix categories:

OSCILLATORS (for entry timing / overbought-oversold):
- RSI(period): BELOW/ABOVE/CROSS_UP/CROSS_DOWN threshold, REVERSAL
- STOCHASTIC(period): CROSS_UP/CROSS_DOWN threshold, BELOW/ABOVE
- STOCH_RSI(period): CROSS_UP/CROSS_DOWN, ABOVE/BELOW 0.5 threshold, REVERSAL
- CCI(period): CROSS_UP/CROSS_DOWN, ABOVE/BELOW threshold (100/-100)
- WILLIAMS_R(period): ABOVE/BELOW threshold (-20/-80), REVERSAL
- MFI(period): ABOVE/BELOW threshold, REVERSAL

MOMENTUM (for direction and strength):
- MACD(12,26,9): ABOVE_SIGNAL/BELOW_SIGNAL, HISTOGRAM_POSITIVE/NEGATIVE, HISTOGRAM_CROSS_UP/DOWN
- AO: ABOVE/BELOW 0, CROSS_UP/CROSS_DOWN
- AROON(period): ABOVE/BELOW threshold, CROSS_UP/CROSS_DOWN
- MOMENTUM(period): ABOVE/BELOW 0, CROSS_UP/CROSS_DOWN
- ROC(period): ABOVE/BELOW 0, CROSS_UP/CROSS_DOWN
- FORCE_INDEX(period): ABOVE/BELOW 0, CROSS_UP/CROSS_DOWN
- CMF(period): ABOVE/BELOW 0, CROSS_UP/CROSS_DOWN (money flow)

TREND (for direction filter):
- EMA(period): PRICE_ABOVE/BELOW, BULLISH_CROSS/BEARISH_CROSS
- HMA(period): PRICE_ABOVE/BELOW (faster than EMA)
- ICHIMOKU: PRICE_ABOVE_CLOUD/BELOW_CLOUD, BULLISH_CROSS/BEARISH_CROSS (TK cross)
- PSAR: PRICE_ABOVE/BELOW (auto-trend detection)
- DONCHIAN(period): PRICE_ABOVE/BELOW (breakout)

CHANNEL / VOLATILITY (for mean-reversion or breakout):
- BOLLINGER_BANDS(period): PRICE_ABOVE/BELOW, REVERSAL
- KELTNER(period): PRICE_ABOVE/BELOW

TREND STRENGTH:
- ADX(period): ABOVE/BELOW threshold (20-30 = trending)

VOLUME-BASED:
- OBV: ABOVE/BELOW 0, CROSS_UP
- VOLUME_RATIO(period): ABOVE/BELOW threshold

## SOPHISTICATED STRATEGY PATTERNS (use these, not just MACD alone)

Pattern A — Oscillator + Trend filter (anti-false-signal):
  Entry: RSI or STOCH_RSI crosses into recovery zone
  Filter: ICHIMOKU PRICE_ABOVE_CLOUD or EMA trend
  → Reduces false entries in ranging markets

Pattern B — Multi-oscillator confluence:
  Entry: RSI oversold AND STOCHASTIC crossing up AND CCI < -100
  → Triple confirmation = fewer but higher quality signals

Pattern C — Momentum + Volume:
  Entry: MACD HISTOGRAM_CROSS_UP AND CMF ABOVE 0 (money flowing in)
  → Volume confirms momentum

Pattern D — Channel breakout + Momentum:
  Entry: DONCHIAN PRICE_ABOVE (new high) AND ADX ABOVE 25
  → Trend confirmed breakout only

Pattern E — Ichimoku multi-condition:
  Entry: PRICE_ABOVE_CLOUD AND TK bullish cross (BULLISH_CROSS)
  → Classic Ichimoku BUY setup

Pattern F — Mean reversion with strict filters:
  Entry: BB PRICE_BELOW (lower band) AND RSI < 30 AND ADX < 25
  → Buy oversold in ranging market

## MULTI-TIMEFRAME USAGE
Use trend_filter for D1 direction confirmation while trading H4:
  trend_filter: { "timeframe": "D1", "indicator": "EMA", "period": 50, "direction": "BULLISH" }
  or: { "timeframe": "D1", "indicator": "ICHIMOKU", "direction": "BULLISH" }

## DIVERSITY REQUIREMENT
Each of the 5 strategies MUST use a DIFFERENT primary indicator category:
- Strategy 1: Oscillator-based (RSI/STOCHASTIC/STOCH_RSI/CCI/WILLIAMS_R)
- Strategy 2: Momentum-based (MACD/AO/AROON/ROC/FORCE_INDEX)
- Strategy 3: Trend system (ICHIMOKU or PSAR or DONCHIAN breakout)
- Strategy 4: Multi-oscillator confluence (2+ oscillators combined)
- Strategy 5: Volume or channel based (CMF/MFI/OBV or BB/KELTNER)

DO NOT make all 5 strategies use MACD or EMA. Use the full indicator catalog.

## OUTPUT FORMAT
Respond with ONLY valid JSON — no markdown, no code blocks:
{
  "strategies": [spec1, spec2, spec3, spec4, spec5]
}

Each spec schema:
{
  "name": string (3-50 chars, alphanumeric + spaces + dash + underscore),
  "strategy_type": "SCALPING" | "DAY_TRADE" | "SWING",
  "description": string (explain WHY this indicator combo makes sense for GOLD),
  "symbols": ["GOLD#"],
  "timeframes": ["H4"],
  "entry_conditions": {
    "logic": "AND",
    "conditions": [
      { "indicator": string, "timeframe": "H4", "period"?: number, "period2"?: number, "period3"?: number, "operator": string, "threshold"?: number }
    ]
  },
  "exit_conditions": {
    "stop_loss": { "method": "ATR", "period": 14, "multiplier": 1.5 },
    "take_profit": { "method": "RR_RATIO", "rr_ratio": 2.5 }
  },
  "filters": {
    "max_spread_pips": 50,
    "sessions": ["LONDON", "NEW_YORK"],
    "trend_filter"?: { "timeframe": "D1", "indicator": "EMA", "period": 50, "direction": "BULLISH" },
    "min_adx"?: number
  },
  "risk": { "risk_per_trade": 1.0 }
}

## WHITELISTS
Indicators: ${ALLOWED_INDICATORS.join(", ")}
Timeframes: ${ALLOWED_TIMEFRAMES.join(", ")}
Sessions: ${ALLOWED_SESSIONS.join(", ")}
Operators: ${ALLOWED_OPERATORS.join(", ")}
SL methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, PERCENTAGE
TP methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, RR_RATIO, PERCENTAGE

## RULES
1. symbols MUST be ["GOLD#"]
2. risk_per_trade: always 1.0
3. Recommend sessions: ["LONDON", "NEW_YORK"] for most strategies
4. Both stop_loss AND take_profit REQUIRED
5. Names must be unique
6. EMA periods: use varied values (9, 21, 34, 50, 100, 200)
7. RSI period: 14 standard, STOCHASTIC: 14, CCI: 14 or 20
8. For ICHIMOKU: no period needed; for STOCH_RSI threshold use 0.2-0.8

## ABSOLUTE PROHIBITIONS
- DO NOT use only MACD and EMA — use the FULL indicator catalog
- DO NOT ignore oscillators (RSI/STOCHASTIC/CCI/WILLIAMS_R)
- DO NOT ignore volume indicators (CMF/MFI/OBV)
- DO NOT ignore ICHIMOKU, PSAR, DONCHIAN, KELTNER
- DO NOT generate 5 variations of the same MACD pattern`;
}

const MultiSpecSchema = z.object({
  strategies: z.array(StrategySpecSchema).min(1).max(5),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      description?: string;
      targets?: MetricTargets;
    };

    const description = (body.description ?? "").trim();
    if (description.length < 3) {
      return NextResponse.json(
        { success: false, error: "戦略の説明を入力してください（3文字以上）" },
        { status: 400 }
      );
    }
    if (description.length > 1000) {
      return NextResponse.json(
        { success: false, error: "説明が長すぎます（1000文字以内）" },
        { status: 400 }
      );
    }

    const targets: MetricTargets = body.targets ?? {};

    const systemPrompt = buildMultiPrompt(description, targets);

    const client     = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model:    process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Generate 5 diverse GOLD# trading strategies based on: "${description}"` },
      ],
      max_completion_tokens: 8192,
      response_format:       { type: "json_object" },
    });

    const rawText = completion.choices[0]?.message?.content ?? "";

    let rawData: unknown;
    try {
      rawData = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { success: false, error: "AI の出力が JSON ではありませんでした。再試行してください。" },
        { status: 422 }
      );
    }

    const validation = MultiSpecSchema.safeParse(rawData);
    if (!validation.success) {
      // Try to salvage individual valid specs
      const raw = rawData as { strategies?: unknown[] };
      const specs: StrategySpec[] = [];
      if (Array.isArray(raw?.strategies)) {
        for (const s of raw.strategies) {
          const v = StrategySpecSchema.safeParse(s);
          if (v.success) specs.push(v.data);
        }
      }
      if (specs.length === 0) {
        return NextResponse.json(
          { success: false, error: "戦略の生成に失敗しました。再試行してください。" },
          { status: 422 }
        );
      }
      return NextResponse.json({ success: true, specs });
    }

    return NextResponse.json({ success: true, specs: validation.data.strategies });

  } catch (e) {
    console.error("[build-multi]", e);
    return NextResponse.json(
      { success: false, error: "サーバーエラーが発生しました" },
      { status: 500 }
    );
  }
}

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
    ? `\nPerformance Targets (design strategies intended to achieve these):\n${targetLines.join("\n")}`
    : "";

  return `You are AVL FX Strategy Architect specializing exclusively in GOLD# (XAU/USD) trading.

Generate exactly 5 DIVERSE and DISTINCT trading strategies for GOLD#.
All 5 strategies MUST use symbol: ["GOLD#"].

IMPORTANT — Historical bar data available for backtesting:
- D1: 430 bars (2024-10 to 2026-06) ← best for backtesting
- H4: 83 bars (2026-05 to 2026-06) ← good for backtesting
- W1: 487 bars (2017 to 2026) ← very long range
- M1/M5/M15/M30/H1: minimal data (recent only)
Prefer D1 and H4 timeframes for strategies that will be backtested.

DIVERSITY REQUIREMENTS — Make each strategy genuinely different:
1. H4 trend-following (EMA or Ichimoku based, BUY direction focus)
2. D1 swing strategy (RSI or MACD oscillator, both BUY and SELL)
3. H4 counter-trend / mean-reversion (RSI or BB, SELL and BUY)
4. D1 momentum (ADX + another indicator, one direction)
5. H4 or D1 multi-indicator confluence (combine 2+ indicators)

User's description / request:
"${description}"
${targetSection}

## OUTPUT FORMAT
Respond with ONLY valid JSON — no markdown, no code blocks, no explanation:
{
  "strategies": [spec1, spec2, spec3, spec4, spec5]
}

Each spec must follow this exact schema:
{
  "name": string (3-50 chars, English preferred, alphanumeric + spaces + dash + underscore),
  "strategy_type": "SCALPING" | "DAY_TRADE" | "SWING",
  "description": string,
  "symbols": ["GOLD#"],
  "timeframes": [string],
  "entry_conditions": {
    "logic": "AND" | "OR",
    "conditions": [
      {
        "indicator": string,
        "timeframe": string,
        "period": number (optional),
        "operator": string (optional),
        "threshold": number (optional),
        "condition": string (optional)
      }
    ]
  },
  "exit_conditions": {
    "stop_loss": { "method": string, "period"?: number, "multiplier"?: number, "pips"?: number },
    "take_profit": { "method": string, "period"?: number, "multiplier"?: number, "pips"?: number, "rr_ratio"?: number }
  },
  "filters": {
    "max_spread_pips"?: number,
    "sessions"?: string[],
    "trend_filter"?: { "timeframe": string, "indicator": string, "period"?: number, "direction": "BULLISH"|"BEARISH"|"NEUTRAL" },
    "min_adx"?: number
  },
  "risk": { "risk_per_trade": 1.0 }
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
1. All symbols must be ["GOLD#"]
2. risk_per_trade: always 1.0
3. ATR period: 14, RSI period: 14, EMA common: 21/50/100/200
4. Both stop_loss AND take_profit are REQUIRED in every spec
5. Names must be unique across the 5 strategies
6. DO NOT include unsupported conditions (avoid candlestick patterns, trendlines, pivot points)
7. DO NOT make performance guarantees in descriptions

## ABSOLUTE PROHIBITIONS
- DO NOT include: javascript, typescript, mql5, python, code, function, eval, exec
- DO NOT include: file paths, URLs, API keys
- DO NOT use indicators not in the whitelist above`;
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

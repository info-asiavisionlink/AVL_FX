// =================================================================
// POST /api/ai/strategy/build
//
// 自然言語プロンプト → Strategy Specification JSON
//
// フロー:
//   1. ユーザープロンプト受信
//   2. OpenAI に Structured Output を要求
//   3. Zod バリデーション
//   4. PASS → spec を返す（保存は /api/strategies で行う）
//   5. FAIL → エラー理由を返す
//
// セキュリティ:
//   - AI が生成するのは Strategy Spec のみ
//   - 実行可能なコードを含む出力は Zod で拒否
//   - モデル名は環境変数から取得（ハードコード禁止）
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";
import {
  StrategySpecSchema,
  ALLOWED_INDICATORS,
  ALLOWED_TIMEFRAMES,
  ALLOWED_STRATEGY_TYPES,
  ALLOWED_SESSIONS,
  ALLOWED_SYMBOLS,
  ALLOWED_OPERATORS,
  type StrategySpec,
} from "@/lib/strategySchema";

export const runtime = "nodejs";

// ------------------------------------------------------------------
// System Prompt
// ------------------------------------------------------------------

function buildSystemPrompt(): string {
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

Strategy Types:
  SCALPING → M1-M15 主体
  DAY_TRADE → M30-H4 主体
  SWING → H4-W1 主体

Sessions: ${ALLOWED_SESSIONS.join(", ")}

Operators: ${ALLOWED_OPERATORS.join(", ")}

SL methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, PERCENTAGE
TP methods: ATR, FIXED_PIPS, SWING_LOW, SWING_HIGH, RR_RATIO, PERCENTAGE

## RULES

1. name: 3-50 chars, alphanumeric + spaces + dash + underscore only
2. symbols: use standard FX pair names (EURUSD, USDJPY, GOLD, etc.)
3. risk_per_trade: 0.01 to 5.0 (percent)
4. max_spread_pips: 0 to 20
5. ATR period typically 14, RSI period typically 14, EMA period 9/21/50/100/200
6. Infer timeframes intelligently from context
7. If user mentions London/NY/Tokyo session: add to sessions array

## ABSOLUTE PROHIBITIONS

- DO NOT include: javascript, typescript, mql5, python, code, function, eval, exec, require, import
- DO NOT include: file paths, URLs, API keys, environment variables
- DO NOT make performance guarantees (win rate, profit, etc.)
- DO NOT use indicators not in the whitelist
- DO NOT add extra JSON keys not defined in the schema

Respond with ONLY the JSON object. No explanation, no markdown.`;
}

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { prompt?: string };
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

    // OpenAI 呼び出し
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user",   content: prompt },
      ],
      temperature:     0.3,   // 低め: 構造化出力の安定性を優先
      max_tokens:      2048,
      response_format: { type: "json_object" }, // JSON モード
    });

    const rawText = completion.choices[0]?.message?.content ?? "";

    // JSON パース
    let rawSpec: unknown;
    try {
      rawSpec = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { success: false, error: "AI の出力が JSON 形式ではありませんでした。再試行してください。" },
        { status: 422 }
      );
    }

    // Zod バリデーション（ホワイトリスト検証）
    const validation = StrategySpecSchema.safeParse(rawSpec);

    if (!validation.success) {
      const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      return NextResponse.json(
        {
          success:  false,
          error:    "Strategy Specification が無効です",
          details:  issues,
          raw:      rawSpec, // デバッグ用（本番では除去可）
        },
        { status: 422 }
      );
    }

    const spec: StrategySpec = validation.data;

    return NextResponse.json({
      success: true,
      spec,
      model:   completion.model,
      usage:   completion.usage,
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

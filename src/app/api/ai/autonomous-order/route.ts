// =================================================================
// POST /api/ai/autonomous-order
// Autonomous モード専用: シグナル + 指標データをもとに
// AI が注文パラメータを生成して返す
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS } from "@/infrastructure/ai/openai-client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { signal, indicators } = await req.json() as {
      signal: {
        symbol:    string;
        type:      string;
        timeframe: string;
        message:   string;
        strength:  string;
      };
      indicators: {
        symbol:     string;
        spread:     number;
        timeframes: Record<string, { ema21: number; ema200: number; atr: number }>;
      };
    };

    const client = getOpenAIClient();

    const tfLines = Object.entries(indicators.timeframes ?? {})
      .map(([tf, v]) => `  ${tf}: EMA21=${v.ema21.toFixed(5)} EMA200=${v.ema200.toFixed(5)} ATR=${v.atr.toFixed(5)} dir=${v.ema21 > v.ema200 ? "UP" : "DOWN"}`)
      .join("\n");

    const systemPrompt = `あなたは FX 自律トレーディングエージェントです。
シグナルと市場データをもとに注文パラメータを生成してください。
必ず JSON のみで返答してください。他のテキストは禁止です。

JSON フォーマット:
{
  "direction": "BUY" or "SELL",
  "symbol": "EURUSD",
  "volume": 0.01,
  "sl": 1.08000,
  "tp": 1.09000,
  "magic": 99999,
  "reason": "判断根拠（50文字以内）"
}

リスク管理ルール:
- volume は常に 0.01（最小ロット）
- SL は ATR × 1.5 を目安にする
- TP は SL × 2 以上（RR 1:2）
- スプレッドが 5pips 以上なら direction を "SKIP" にして取引しない
- magic は 99999 を使用`;

    const userPrompt = `シグナル情報:
タイプ: ${signal.type}
シンボル: ${signal.symbol}
時間足: ${signal.timeframe}
メッセージ: ${signal.message}

市場データ (${signal.symbol}):
Spread: ${indicators.spread?.toFixed(1)} pips
${tfLines}

上記をもとに注文パラメータを生成してください。`;

    const res = await client.chat.completions.create({
      model: MODELS.chat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens:  300,
      response_format: { type: "json_object" },
    });

    const raw   = res.choices[0]?.message?.content ?? "{}";
    const order = JSON.parse(raw) as {
      direction: string; symbol: string; volume: number;
      sl: number; tp: number; magic: number; reason: string;
    };

    // SKIP 判定
    if (order.direction === "SKIP") {
      return NextResponse.json({ error: "SKIP", reason: order.reason }, { status: 422 });
    }

    // シンボル名を正規化（EURUSD 形式に）
    order.symbol = signal.symbol.replace("/", "");

    return NextResponse.json(order);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[autonomous-order]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

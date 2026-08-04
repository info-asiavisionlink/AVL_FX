// =================================================================
// POST /api/ai/analyze — シンボル分析（非ストリーミング）
// =================================================================
// Request:  { symbol: string }
// Response: { analysis: string, context: string }

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";
import { buildMarketContext, SYSTEM_PROMPT } from "@/infrastructure/ai/market-context";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { symbol = "EURUSD" } = await req.json() as { symbol?: string };

    const client    = getOpenAIClient();
    const marketCtx = await buildMarketContext(symbol);

    const completion = await client.chat.completions.create({
      model: MODELS.chat,
      messages: [
        { role: "system",  content: `${SYSTEM_PROMPT}\n\n${marketCtx}` },
        { role: "user",    content: `${symbol}を分析してください。` },
      ],
      temperature: 0.3,
      max_tokens:  1500,
    });

    const analysis = completion.choices[0]?.message?.content ?? "";

    return NextResponse.json({ analysis, context: marketCtx, symbol });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ai/analyze]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

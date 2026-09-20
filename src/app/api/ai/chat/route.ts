// =================================================================
// POST /api/ai/chat — AI チャット（ストリーミング対応）
// =================================================================
// Request:  { messages: [{role, content}], symbol?: string }
// Response: Server-Sent Events ストリーム or JSON

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";
import { buildMarketContext, SYSTEM_PROMPT } from "@/infrastructure/ai/market-context";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { messages, symbol = "EURUSD" } = await req.json() as {
      messages: { role: "user" | "assistant"; content: string }[];
      symbol?: string;
    };

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: "messages が必要です" }, { status: 400 });
    }

    const client = getOpenAIClient();

    // 市場コンテキストを取得してシステムプロンプトに注入
    const marketCtx = await buildMarketContext(symbol);
    const systemContent = `${SYSTEM_PROMPT}\n\n${marketCtx}`;

    // OpenAI Chat Completions（ストリーミング）
    const stream = await client.chat.completions.create({
      model:  MODELS.chat,
      stream: true,
      messages: [
        { role: "system", content: systemContent },
        ...messages,
      ],
      temperature: 0.3, // 分析タスクなので低め
      max_tokens: 2000,
    });

    // SSE レスポンスを返す
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ai/chat]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

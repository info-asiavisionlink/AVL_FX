import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS } from "@/infrastructure/ai/openai-client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { query } = await req.json() as { query: string };
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  try {
    const client = getOpenAIClient();
    const response = await client.responses.create({
      model: MODELS.chat,
      tools: [{ type: "web_search" as const }],
      input: query,
    });

    let text = "";
    for (const item of response.output) {
      if (item.type === "message") {
        for (const c of item.content) {
          if (c.type === "output_text") text += c.text;
        }
      }
    }

    return NextResponse.json(
      { result: text || "検索結果なし" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

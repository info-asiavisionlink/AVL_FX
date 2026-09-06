import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS } from "@/infrastructure/ai/openai-client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json() as { text: string };
    if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

    const client = getOpenAIClient();
    const result = await client.embeddings.create({
      model: MODELS.embedding,
      input: text,
      encoding_format: "float",
    });

    return NextResponse.json({ embedding: result.data[0]?.embedding ?? [] });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

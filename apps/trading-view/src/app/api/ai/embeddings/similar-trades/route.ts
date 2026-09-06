import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS } from "@/infrastructure/ai/openai-client";
import { createAdminClient } from "@/infrastructure/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { symbol, direction, trend, indicators } = await req.json() as {
      symbol: string;
      direction: string;
      trend: string;
      indicators: string;
    };

    const client = getOpenAIClient();

    const setupText = `${symbol} ${direction} ${trend} ${indicators}`;
    const embResult = await client.embeddings.create({
      model: MODELS.embedding,
      input: setupText,
      encoding_format: "float",
    });
    const embedding = embResult.data[0]?.embedding;
    if (!embedding) return NextResponse.json({ similar: [] });

    try {
      const db = createAdminClient();
      const { data } = await db.rpc("match_trade_setups", {
        query_embedding: embedding,
        match_threshold: 0.8,
        match_count: 5,
      });
      return NextResponse.json({ similar: data ?? [], setupText });
    } catch {
      return NextResponse.json({
        similar: [],
        setupText,
        note: "Supabase pgvector not configured. Set up the match_trade_setups function to enable similarity search.",
      });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

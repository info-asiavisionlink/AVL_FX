// =================================================================
// POST /api/ai/analyze — シンボル分析（非ストリーミング）
// =================================================================
// Request:  { symbol: string }
// Response: { analysis: string, context: string }

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";
import { buildMarketContext, SYSTEM_PROMPT } from "@/infrastructure/ai/market-context";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { symbol = "EURUSD", connection_id } = await req.json() as { symbol?: string; connection_id?: string };
    const cookieStore = await cookies();
    const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let connectionQuery = supabase.from("mt5_connections").select("id").eq("user_id", user.id);
    if (connection_id) connectionQuery = connectionQuery.eq("id", connection_id);
    const { data: connection, error: connectionError } = await connectionQuery.order("created_at", { ascending: false }).limit(1).single();
    if (connectionError) return NextResponse.json({ error: "Connection ownership unavailable" }, { status: 503 });
    if (!connection) return NextResponse.json({ error: "MT5 connection unavailable" }, { status: 404 });

    const client    = getOpenAIClient();
    const marketCtx = await buildMarketContext(symbol, connection.id);

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

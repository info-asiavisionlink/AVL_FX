import { NextResponse } from "next/server";
import { getOpenAIClient } from "@/infrastructure/ai/openai-client";

export const runtime = "nodejs";

export async function POST() {
  try {
    const client = getOpenAIClient();

    const existingId = process.env.OPENAI_VECTOR_STORE_ID;
    if (existingId) {
      try {
        const store = await client.vectorStores.retrieve(existingId);
        return NextResponse.json({ id: store.id, name: store.name, status: "existing" });
      } catch { /* not found, create new */ }
    }

    const store = await client.vectorStores.create({
      name: "AVL FX Trading Knowledge Base",
      expires_after: { anchor: "last_active_at", days: 365 },
    });

    return NextResponse.json({
      id: store.id,
      name: store.name,
      status: "created",
      instruction: `Add OPENAI_VECTOR_STORE_ID=${store.id} to your Vercel environment variables`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

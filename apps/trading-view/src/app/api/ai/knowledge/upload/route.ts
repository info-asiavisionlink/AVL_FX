import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient } from "@/infrastructure/ai/openai-client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { content, filename, vectorStoreId } = await req.json() as {
      content: string;
      filename: string;
      vectorStoreId: string;
    };

    if (!vectorStoreId) return NextResponse.json({ error: "vectorStoreId required" }, { status: 400 });

    const client = getOpenAIClient();

    const blob = new Blob([content], { type: "text/plain" });
    const file = new File([blob], filename, { type: "text/plain" });

    const uploaded = await client.files.create({
      file,
      purpose: "assistants",
    });

    await client.vectorStores.files.create(vectorStoreId, {
      file_id: uploaded.id,
    });

    return NextResponse.json({ file_id: uploaded.id, filename, status: "uploaded" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getOpenAIClient, KNOWLEDGE_STORE_ID } from "@/infrastructure/ai/openai-client";
import { TRADING_KNOWLEDGE, RISK_MANAGEMENT_KNOWLEDGE } from "@/infrastructure/ai/knowledge/trading-knowledge";

export const runtime = "nodejs";

export async function POST() {
  const storeId = KNOWLEDGE_STORE_ID;
  if (!storeId) {
    return NextResponse.json({
      error: "OPENAI_VECTOR_STORE_ID not set. Call POST /api/ai/knowledge/setup first.",
    }, { status: 400 });
  }

  const client = getOpenAIClient();
  const results = [];

  const docs = [
    { content: TRADING_KNOWLEDGE, filename: "avl-trading-system.txt" },
    { content: RISK_MANAGEMENT_KNOWLEDGE, filename: "avl-risk-management.txt" },
  ];

  for (const doc of docs) {
    try {
      const blob = new Blob([doc.content], { type: "text/plain" });
      const file = new File([blob], doc.filename, { type: "text/plain" });
      const uploaded = await client.files.create({ file, purpose: "assistants" });
      await client.vectorStores.files.create(storeId, { file_id: uploaded.id });
      results.push({ filename: doc.filename, status: "uploaded", file_id: uploaded.id });
    } catch (err) {
      results.push({ filename: doc.filename, status: "error", error: String(err) });
    }
  }

  return NextResponse.json({ store_id: storeId, results });
}

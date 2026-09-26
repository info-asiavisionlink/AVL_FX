// =================================================================
// GET /api/knowledge
//
// Console の ACTIVE Trading Knowledge 一覧を取得するプロキシ
//
// Customer Browser が Console Supabase を直接参照しないための境界。
// Console URL は環境変数で管理し、ブラウザへは露出しない。
// =================================================================

import { NextResponse }        from "next/server";
import { createClient }        from "@/infrastructure/supabase/server";
import { fetchActiveKnowledge, KnowledgeUnavailableError } from "@/lib/knowledge/knowledge-client";

export const runtime = "nodejs";

export async function GET() {
  // 認証チェック（ログイン済みユーザーのみ）
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  try {
    const items = await fetchActiveKnowledge();
    return NextResponse.json({ ok: true, items, source: "console", meta: { count: items.length, schema_version: 1 } });
  } catch (error) {
    const code = error instanceof KnowledgeUnavailableError ? error.code : "NETWORK_ERROR";
    console.warn(`[GET /api/knowledge] ${code}`);
    return NextResponse.json({ ok: false, error: "KNOWLEDGE_UNAVAILABLE", code }, { status: code === "AUTH_ERROR" ? 502 : 503 });
  }
}

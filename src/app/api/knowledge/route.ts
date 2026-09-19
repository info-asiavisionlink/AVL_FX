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

export const runtime = "nodejs";

const CONSOLE_URL             = process.env.CONSOLE_URL             ?? "https://avl-fx-console.vercel.app";
const KNOWLEDGE_API_SECRET    = process.env.KNOWLEDGE_API_SECRET    ?? "";

export async function GET() {
  // 認証チェック（ログイン済みユーザーのみ）
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  try {
    // Console API に転送（ACTIVE のみ）
    const res = await fetch(`${CONSOLE_URL}/api/trading-knowledge?status=ACTIVE`, {
      headers: {
        "Content-Type":           "application/json",
        "x-knowledge-api-secret": KNOWLEDGE_API_SECRET,
      },
      signal: AbortSignal.timeout(10_000),
      next:   { revalidate: 60 }, // 1分キャッシュ
    });

    if (!res.ok) {
      // Console が利用不可の場合は空配列を返す（グレースフルデグラデーション）
      console.warn("[GET /api/knowledge] Console API error:", res.status);
      return NextResponse.json({ items: [], source: "offline" });
    }

    const data = await res.json() as { items?: unknown[] };
    return NextResponse.json({ items: data.items ?? [], source: "console" });

  } catch (err) {
    console.warn("[GET /api/knowledge] fetch failed:", err);
    // Console 未設定時も空配列で継続（Phase 1: Console との接続は必須ではない）
    return NextResponse.json({ items: [], source: "offline" });
  }
}

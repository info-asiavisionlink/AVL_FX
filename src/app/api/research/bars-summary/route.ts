// GET /api/research/bars-summary
// Console の bars-summary API へのサーバーサイドプロキシ
// ブラウザからの CORS 問題を回避するため、Trading View サーバー経由で取得

import { NextResponse } from "next/server";

export const dynamic     = "force-dynamic";
export const runtime     = "nodejs";

const CONSOLE_URL = process.env.CONSOLE_URL ?? "https://avl-fx-console.vercel.app";

export async function GET() {
  try {
    const res = await fetch(`${CONSOLE_URL}/api/research/bars-summary`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Console API error" }, { status: res.status });
    }

    const data = await res.json() as unknown;
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "データ取得に失敗しました" }, { status: 503 });
  }
}

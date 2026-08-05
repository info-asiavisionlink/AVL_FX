import { NextRequest, NextResponse } from "next/server";
import { getRecentNews } from "@/infrastructure/supabase/repository";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get("symbol") ?? "EURUSD";
  const limit  = Number(searchParams.get("limit") ?? 10);

  try {
    const news = await getRecentNews(symbol, limit);
    return NextResponse.json(
      news.map(n => ({
        title:       n.title,
        excerpt:     n.excerpt,
        source:      n.source,
        publishedAt: n.published_at,
        url:         n.url,
      })),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

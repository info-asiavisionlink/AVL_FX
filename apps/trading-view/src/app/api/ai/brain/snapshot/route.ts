// =================================================================
// POST /api/ai/brain/snapshot
// MarketSnapshot を構築して返す
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { buildMarketSnapshot } from "@/infrastructure/trading/MarketSnapshotBuilder";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { symbol = "EURUSD" } = await req.json().catch(() => ({})) as { symbol?: string };
    const snapshot = await buildMarketSnapshot(symbol);
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[brain/snapshot]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

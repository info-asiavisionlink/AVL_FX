// =================================================================
// POST /api/ai/brain/validate
// Risk Engine — TradeProposal を検証して RiskDecision を返す
// =================================================================

import { NextRequest, NextResponse }      from "next/server";
import { validateTradeProposal, buildDefaultRiskSettings } from "@/infrastructure/trading/RiskEngine";
import type { TradeProposal, AccountSnapshot, PositionSnapshot } from "@/domain/trading/MarketSnapshot";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      proposal:   TradeProposal;
      account:    AccountSnapshot | null;
      positions:  PositionSnapshot[];
      spread:     number;
      newsRisk:   "HIGH" | "MEDIUM" | "LOW";
      settings?:  Partial<ReturnType<typeof buildDefaultRiskSettings>>;
    };

    const { proposal, account, positions, spread, newsRisk } = body;
    if (!proposal) return NextResponse.json({ error: "proposal required" }, { status: 400 });

    const settings = {
      ...buildDefaultRiskSettings(),
      ...(body.settings ?? {}),
      // ENABLE_LIVE_TRADING は env var で上書き（クライアントから変更不可）
      enableLiveTrading: process.env.ENABLE_LIVE_TRADING === "true",
    };

    const decision = validateTradeProposal({
      proposal,
      account:  account ?? null,
      positions: positions ?? [],
      spread:   spread ?? 0,
      settings,
      newsRisk: newsRisk ?? "LOW",
    });

    return NextResponse.json(decision, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[brain/validate]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

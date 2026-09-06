// GET /api/market/intelligence?symbol=EURUSD
// Market Intelligence 統合エンドポイント
// Sentiment + COT + Public Positioning を一括取得

import { NextRequest, NextResponse } from 'next/server';
import { MarketIntelligenceService } from '@/infrastructure/market-intelligence/MarketIntelligenceService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? 'EURUSD').toUpperCase();

  try {
    const intelligence = await MarketIntelligenceService.fetch(symbol);
    return NextResponse.json(intelligence, {
      headers: { 'Cache-Control': 'public, max-age=300' }, // 5分
    });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}

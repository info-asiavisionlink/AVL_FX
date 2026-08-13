// GET /api/market/cot?currency=EUR
// CFTC COT データ（Legacy Futures-Only, Non-Commercial）
// キャッシュ: 24時間（週次データのため）

import { NextRequest, NextResponse } from 'next/server';
import { COTProvider } from '@/infrastructure/market-intelligence/providers/COTProvider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const currency = (req.nextUrl.searchParams.get('currency') ?? 'EUR').toUpperCase();
  // symbolとして渡す（Provider内でslice(0,3)して通貨を取り出す）
  const symbol = `${currency}USD`;

  try {
    const data = await COTProvider.fetch(symbol);
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, max-age=86400' }, // 24時間
    });
  } catch (err) {
    return NextResponse.json(
      { status: 'SOURCE_UNAVAILABLE', error: String(err) },
      { status: 200 }, // エラー時も200で返しNO DATAとして扱う
    );
  }
}

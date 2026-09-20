// GET /api/market/cot?currency=EUR
// CFTC COT データ — Supabaseから読み取り
//
// データフロー: Supabase cot_positions → response
// CFTCへは直接アクセスしない（週次バッチ /api/cron/cot-fetch が担う）

import { NextRequest, NextResponse } from 'next/server';
import { COTProvider } from '@/infrastructure/market-intelligence/providers/COTProvider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const currency = (req.nextUrl.searchParams.get('currency') ?? 'EUR').toUpperCase();
  const symbol   = `${currency}USD`;

  try {
    const data = await COTProvider.fetch(symbol);

    // レスポンス整形（status明示 + 週次キャッシュ）
    return NextResponse.json(
      {
        currency:   data.currency,
        reportDate: data.reportDate,
        long:       data.nonCommLong,
        short:      data.nonCommShort,
        net:        data.netContracts,
        longPct:    data.longPct,
        shortPct:   data.shortPct,
        netPct:     data.netPct,
        source:     data.source.name,
        updatedAt:  data.source.updatedAt,
        status:     data.status,
        // 週次データなのでキャッシュは24時間
      },
      { headers: { 'Cache-Control': 'public, max-age=86400' } },
    );
  } catch (err) {
    return NextResponse.json(
      { status: 'SOURCE_UNAVAILABLE', error: String(err) },
      { status: 200 },
    );
  }
}

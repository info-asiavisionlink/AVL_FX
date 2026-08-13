// =================================================================
// CFTC COT Provider — Supabase読み取り版
//
// データフロー:
//   CFTC → /api/cron/cot-fetch (週1回) → Supabase cot_positions
//   → COTProvider.fetch() → MarketIntelligenceService → UI
//
// ⚠️ このエンドポイントはCFTCへ直接アクセスしない。
//    Supabaseに保存済みの週次データを返すのみ。
// =================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { COTData, ICOTProvider } from '../types';

// CFTC契約名（参照用）
const CURRENCY_TO_CONTRACT: Record<string, string> = {
  EUR: 'EURO FX - CME',
  JPY: 'JAPANESE YEN - CME',
  GBP: 'BRITISH POUND - CME',
  CHF: 'SWISS FRANC - CME',
  AUD: 'AUSTRALIAN DOLLAR - CME',
  CAD: 'CANADIAN DOLLAR - CME',
  NZD: 'NZ DOLLAR - CME',
};

// STALE判定: 14日超 = STALE（週次データは通常7日以内に更新）
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

function noData(currency: string, reason: 'NO_DATA' | 'SOURCE_UNAVAILABLE'): COTData {
  return {
    status:         reason,
    currency,
    contractName:   CURRENCY_TO_CONTRACT[currency] ?? null,
    nonCommLong:    null,
    nonCommShort:   null,
    netContracts:   null,
    longPct:        null,
    shortPct:       null,
    netPct:         null,
    reportDate:     null,
    dataDisclaimer: 'FUTURES_ONLY',
    source: {
      name:      'CFTC',
      status:    reason,
      updatedAt: null,
      ageMs:     null,
      url:       'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
    },
  };
}

async function fetchFromSupabase(currency: string): Promise<COTData> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  const { data, error } = await supabase
    .from('cot_positions')
    .select('*')
    .eq('currency', currency)
    .order('report_date', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return noData(currency, 'NO_DATA');
  }

  const reportMs  = new Date(data.report_date).getTime();
  const fetchedMs = new Date(data.fetched_at).getTime();
  const now       = Date.now();
  const ageMs     = now - fetchedMs;
  // stale判定はレポート日基準（週次なので14日が閾値）
  const reportAgeMs = now - reportMs;
  const status = reportAgeMs < STALE_MS ? 'FRESH' : 'STALE';

  return {
    status,
    currency,
    contractName:   data.contract_name ?? CURRENCY_TO_CONTRACT[currency] ?? null,
    nonCommLong:    data.long_contracts,
    nonCommShort:   data.short_contracts,
    netContracts:   data.net_contracts,
    longPct:        data.long_pct   !== null ? Number(data.long_pct)  : null,
    shortPct:       data.short_pct  !== null ? Number(data.short_pct) : null,
    netPct:         data.net_pct    !== null ? Number(data.net_pct)   : null,
    reportDate:     data.report_date,
    dataDisclaimer: 'FUTURES_ONLY',
    source: {
      name:      'CFTC',
      status,
      updatedAt: fetchedMs,
      ageMs,
      url:       'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
    },
  };
}

export const COTProvider: ICOTProvider = {
  name: 'CFTC',

  async fetch(symbol: string): Promise<COTData> {
    const currency = symbol.slice(0, 3).toUpperCase();

    if (!CURRENCY_TO_CONTRACT[currency]) {
      return noData(currency, 'NO_DATA');
    }

    try {
      return await fetchFromSupabase(currency);
    } catch (err) {
      console.error('[COTProvider]', err instanceof Error ? err.message : err);
      return noData(currency, 'SOURCE_UNAVAILABLE');
    }
  },
};

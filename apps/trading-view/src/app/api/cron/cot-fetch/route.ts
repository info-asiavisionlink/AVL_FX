// POST /api/cron/cot-fetch
// Vercel Cron: 毎週土曜 01:00 UTC（CFTC金曜公開 20:30 UTCの翌日）
//
// CFTCのLegacy Futures-Only週次ファイル（deafut.txt / 現在週のみ ~410KB）を取得し、
// 対象7通貨のNon-Commercialポジションをcot_positionsテーブルへupsert。
// このエンドポイントはサーバー側のみで実行される。

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/infrastructure/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// CFTC Legacy Futures-Only (現在週のみ) — 約410KB
const CFTC_URL = 'https://www.cftc.gov/dea/newcot/deafut.txt';

// 通貨 → CFTCコントラクト名の部分一致キーワード（実データで確認済み）
const CURRENCY_CONTRACTS: Record<string, { keyword: string; name: string }> = {
  EUR: { keyword: 'EURO FX',          name: 'EURO FX - CME' },
  JPY: { keyword: 'JAPANESE YEN',     name: 'JAPANESE YEN - CME' },
  GBP: { keyword: 'BRITISH POUND',    name: 'BRITISH POUND - CME' },
  CHF: { keyword: 'SWISS FRANC',      name: 'SWISS FRANC - CME' },
  AUD: { keyword: 'AUSTRALIAN DOLLAR',name: 'AUSTRALIAN DOLLAR - CME' },
  CAD: { keyword: 'CANADIAN DOLLAR',  name: 'CANADIAN DOLLAR - CME' },
  NZD: { keyword: 'NZ DOLLAR',        name: 'NZ DOLLAR - CME' },
};

// deafut.txt カラム定義（ヘッダー行なし）
// Col0: Market name, Col2: YYYY-MM-DD, Col8: NonComm_Long, Col9: NonComm_Short
const COL_DATE       = 2;
const COL_NC_LONG    = 8;
const COL_NC_SHORT   = 9;

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  result.push(cur.trim());
  return result;
}

export async function GET(req: NextRequest) {
  // Vercel Cronからのリクエスト検証
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    // CFTC データ取得（現在週のみ、約410KB）
    const res = await fetch(CFTC_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `CFTC HTTP ${res.status}`, url: CFTC_URL },
        { status: 502 },
      );
    }

    const text  = await res.text();
    const lines = text.split('\n');

    // 各通貨を探してデータ抽出
    const records: {
      report_date: string;
      currency: string;
      contract_name: string;
      long_contracts: number;
      short_contracts: number;
      net_contracts: number;
      long_pct: number | null;
      short_pct: number | null;
      net_pct: number | null;
      source: string;
      fetched_at: string;
    }[] = [];

    for (const [currency, { keyword, name }] of Object.entries(CURRENCY_CONTRACTS)) {
      // クロスレートを除外するため、単一通貨行だけを対象にする
      // "EURO FX/BRITISH POUND XRATE" などはキーワードが先頭に来ない行で除外
      const line = lines.find(l => {
        const upper = l.toUpperCase();
        const idx   = upper.indexOf(keyword.toUpperCase());
        if (idx < 0) return false;
        // クロスレート除外: "/" が keyword の直後にある行はスキップ
        const after = upper.slice(idx + keyword.length).trimStart();
        return !after.startsWith('/');
      });

      if (!line) {
        console.warn(`[COT] Not found: ${currency} (${keyword})`);
        continue;
      }

      const cells    = parseCSVLine(line);
      const dateStr  = cells[COL_DATE] ?? '';
      const ncLong   = parseInt(cells[COL_NC_LONG]?.replace(/,/g, '') ?? '', 10);
      const ncShort  = parseInt(cells[COL_NC_SHORT]?.replace(/,/g, '') ?? '', 10);

      if (!dateStr.match(/^\d{4}-\d{2}-\d{2}$/) || isNaN(ncLong) || isNaN(ncShort)) {
        console.warn(`[COT] Parse error: ${currency}`, { dateStr, ncLong, ncShort });
        continue;
      }

      const total     = ncLong + ncShort;
      const longPct   = total > 0 ? Math.round((ncLong  / total) * 100 * 100) / 100 : null;
      const shortPct  = total > 0 ? Math.round((ncShort / total) * 100 * 100) / 100 : null;
      const netPct    = longPct !== null && shortPct !== null
        ? Math.round((longPct - shortPct) * 100) / 100
        : null;

      records.push({
        report_date:    dateStr,
        currency,
        contract_name:  cells[0] ?? name,
        long_contracts: ncLong,
        short_contracts: ncShort,
        net_contracts:  ncLong - ncShort,
        long_pct:       longPct,
        short_pct:      shortPct,
        net_pct:        netPct,
        source:         'CFTC',
        fetched_at:     new Date().toISOString(),
      });
    }

    if (records.length === 0) {
      return NextResponse.json({ error: 'No currency records extracted' }, { status: 502 });
    }

    // Supabase upsert（report_date + currency で重複防止）
    const supabase = createAdminClient();
    const { error: dbError } = await supabase
      .from('cot_positions')
      .upsert(records, { onConflict: 'report_date,currency' });

    if (dbError) {
      console.error('[COT] Supabase upsert error:', dbError);
      return NextResponse.json({ error: dbError.message }, { status: 500 });
    }

    const elapsed = Date.now() - startTime;
    console.log(`[COT] Fetched ${records.length} currencies in ${elapsed}ms`);

    return NextResponse.json({
      success: true,
      fetched: records.length,
      currencies: records.map(r => r.currency),
      reportDate: records[0]?.report_date,
      elapsedMs: elapsed,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[COT] fetch error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

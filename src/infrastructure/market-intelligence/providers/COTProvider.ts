// =================================================================
// CFTC COT Provider
// ソース: CFTC 公式 Legacy Futures-Only Report
// https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm
//
// ⚠️ このデータはFXスポット市場ではなく通貨先物市場のポジションです。
// Non-Commercial（投機筋）のロング/ショートを使用します。
// 週次データ → 24時間キャッシュ
// =================================================================

import type { COTData, ICOTProvider, IntelligenceSource } from '../types';

// CFTC Legacy Futures-Only Report（週次、現在週）
// 固定幅テキスト形式 + CSVの混在版を使用
const CFTC_URL = 'https://www.cftc.gov/files/dea/newcot/futures_combined.txt';

// 通貨先物のCFTCコントラクト名マッピング
const CURRENCY_TO_CONTRACT: Record<string, string> = {
  EUR: 'EURO FX',
  JPY: 'JAPANESE YEN',
  GBP: 'BRITISH POUND',
  CHF: 'SWISS FRANC',
  AUD: 'AUSTRALIAN DOLLAR',
  CAD: 'CANADIAN DOLLAR',
  NZD: 'NEW ZEALAND DOLLAR',
};

// インメモリキャッシュ（24時間）
const CACHE_TTL = 24 * 60 * 60 * 1000;
let _cache: { data: Record<string, COTData>; ts: number } | null = null;

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

/**
 * CFTCのCSVをパースして通貨先物のNon-Commercialポジションを取得。
 * CSV形式: "Market_and_Exchange_Names","YYMMDD",...,"NonComm_Long","NonComm_Short",...
 */
async function fetchCFTCData(): Promise<Record<string, COTData>> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;

  const res = await fetch(CFTC_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept':     'text/plain,*/*',
    },
    // サーバーサイドのみ実行のためcache: no-storeでVercel Data Cacheをバイパス
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(`CFTC HTTP ${res.status}`);

  const text = await res.text();
  const lines = text.split('\n');

  if (lines.length < 2) throw new Error('CFTC: unexpected format');

  // ヘッダー行からカラムインデックスを特定
  const header = parseCSVLine(lines[0]);
  const col = (name: string) => header.findIndex(h => h.trim().toLowerCase().includes(name.toLowerCase()));

  const idxName         = 0;                              // Market_and_Exchange_Names
  const idxDate         = col('as_of_date');              // As_of_Date_In_Form_YYMMDD
  const idxNcLong       = col('noncomm_positions_long');  // NonComm_Positions_Long_All
  const idxNcShort      = col('noncomm_positions_short'); // NonComm_Positions_Short_All

  if (idxNcLong < 0 || idxNcShort < 0) throw new Error('CFTC: column not found');

  const result: Record<string, COTData> = {};
  const now = Date.now();

  // 各通貨を検索
  for (const [currency, contractKeyword] of Object.entries(CURRENCY_TO_CONTRACT)) {
    // 最新行を探す（ファイルは古い→新しい順、最後の行が最新）
    let latestLine: string[] | null = null;

    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const cells = parseCSVLine(line);
      if (!cells[idxName]) continue;
      // コントラクト名が部分一致するか確認
      if (cells[idxName].toUpperCase().includes(contractKeyword.toUpperCase())) {
        latestLine = cells;
        break;
      }
    }

    if (!latestLine) {
      result[currency] = noData(currency, 'NO_DATA');
      continue;
    }

    const ncLong  = parseInt(latestLine[idxNcLong]?.replace(/,/g, '').trim() ?? '', 10);
    const ncShort = parseInt(latestLine[idxNcShort]?.replace(/,/g, '').trim() ?? '', 10);

    if (isNaN(ncLong) || isNaN(ncShort)) {
      result[currency] = noData(currency, 'NO_DATA');
      continue;
    }

    // YYMMDD → YYYY-MM-DD
    const rawDate   = latestLine[idxDate]?.trim() ?? '';
    const reportDate = parseReportDate(rawDate);

    const total  = ncLong + ncShort;
    const longPct  = total > 0 ? Math.round((ncLong  / total) * 100) : null;
    const shortPct = total > 0 ? Math.round((ncShort / total) * 100) : null;
    const netPct   = (longPct !== null && shortPct !== null) ? longPct - shortPct : null;

    // レポート日からの経過時間
    const reportMs = reportDate ? new Date(reportDate).getTime() : null;
    const ageMs    = reportMs ? now - reportMs : null;

    result[currency] = {
      status:         ageMs !== null && ageMs < 8 * 24 * 3600 * 1000 ? 'FRESH' : 'STALE',
      currency,
      contractName:   latestLine[idxName] ?? CURRENCY_TO_CONTRACT[currency],
      nonCommLong:    ncLong,
      nonCommShort:   ncShort,
      netContracts:   ncLong - ncShort,
      longPct,
      shortPct,
      netPct,
      reportDate,
      dataDisclaimer: 'FUTURES_ONLY',
      source: {
        name:      'CFTC',
        status:    'FRESH',
        updatedAt: reportMs,
        ageMs,
        url:       'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
      },
    };
  }

  _cache = { data: result, ts: now };
  return result;
}

/** 簡易CSVパーサー（ダブルクォート対応） */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { result.push(cur); cur = ''; continue; }
    cur += c;
  }
  result.push(cur);
  return result;
}

/** YYMMDD → YYYY-MM-DD */
function parseReportDate(raw: string): string | null {
  if (raw.length === 6) {
    const yy = parseInt(raw.slice(0, 2), 10);
    const mm = raw.slice(2, 4);
    const dd = raw.slice(4, 6);
    const yyyy = yy >= 50 ? `19${yy}` : `20${yy < 10 ? '0' + yy : yy}`;
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────────────────────────

export const COTProvider: ICOTProvider = {
  name: 'CFTC',

  async fetch(symbol: string): Promise<COTData> {
    const currency = symbol.slice(0, 3).toUpperCase();

    if (!CURRENCY_TO_CONTRACT[currency]) {
      return noData(currency, 'NO_DATA');
    }

    try {
      const allData = await fetchCFTCData();
      return allData[currency] ?? noData(currency, 'NO_DATA');
    } catch (err) {
      console.error('[COTProvider]', err instanceof Error ? err.message : err);
      return noData(currency, 'SOURCE_UNAVAILABLE');
    }
  },
};

// =================================================================
// Market Intelligence Service
// 各Providerを統合してMarketIntelligenceを構築するオーケストレーター。
// 将来のMarketSnapshot拡張に備えた設計。
// =================================================================

import type { MarketIntelligence } from './types';
import { extractBaseCurrency, extractQuoteCurrency } from './types';
import { COTProvider }              from './providers/COTProvider';
import { SentimentProvider }        from './providers/SentimentProvider';
import { PublicPositioningProvider } from './providers/PublicPositioningProvider';

// シンボルごとの短時間キャッシュ（同一リクエストの重複防止）
const _symCache = new Map<string, { data: MarketIntelligence; ts: number }>();
const SYM_CACHE_TTL = 5 * 60 * 1000; // 5分

export const MarketIntelligenceService = {
  /**
   * 指定シンボルのMarketIntelligenceを取得。
   * 各Providerを並列実行し、失敗しても他のデータは返す。
   */
  async fetch(symbol: string): Promise<MarketIntelligence> {
    const cached = _symCache.get(symbol);
    if (cached && Date.now() - cached.ts < SYM_CACHE_TTL) {
      return cached.data;
    }

    // 全Provider並列実行 — 一つが失敗しても他は継続
    const [sentiment, cot, publicPositioning] = await Promise.all([
      SentimentProvider.fetch(symbol).catch(e => {
        console.error('[MarketIntelligenceService] sentiment error', e);
        return SentimentProvider.fetch('_error').catch(() => ({
          status: 'SOURCE_UNAVAILABLE' as const,
          longPct: null,
          shortPct: null,
          source: { name: 'Broker Sentiment', status: 'SOURCE_UNAVAILABLE' as const, updatedAt: null, ageMs: null },
        }));
      }),
      COTProvider.fetch(symbol).catch(e => {
        console.error('[MarketIntelligenceService] cot error', e);
        return {
          status:         'SOURCE_UNAVAILABLE' as const,
          currency:       symbol.slice(0, 3).toUpperCase(),
          contractName:   null,
          nonCommLong:    null,
          nonCommShort:   null,
          netContracts:   null,
          longPct:        null,
          shortPct:       null,
          netPct:         null,
          reportDate:     null,
          dataDisclaimer: 'FUTURES_ONLY' as const,
          source:         { name: 'CFTC', status: 'SOURCE_UNAVAILABLE' as const, updatedAt: null, ageMs: null },
        };
      }),
      PublicPositioningProvider.fetch(symbol).catch(e => {
        console.error('[MarketIntelligenceService] public error', e);
        return {
          status:     'SOURCE_UNAVAILABLE' as const,
          longPct:    null,
          shortPct:   null,
          tradeCount: null,
          provider:   null,
          source:     { name: 'Public Positioning', status: 'SOURCE_UNAVAILABLE' as const, updatedAt: null, ageMs: null },
        };
      }),
    ]);

    const intelligence: MarketIntelligence = {
      symbol,
      baseCurrency:  extractBaseCurrency(symbol),
      quoteCurrency: extractQuoteCurrency(symbol),
      sentiment,
      cot,
      publicPositioning,
      sources: [
        { name: 'MT5', status: 'LIVE', updatedAt: Date.now(), ageMs: 0 },
        sentiment.source,
        cot.source,
        publicPositioning.source,
      ],
      fetchedAt: Date.now(),
    };

    _symCache.set(symbol, { data: intelligence, ts: Date.now() });
    return intelligence;
  },

  /** キャッシュをクリア（テスト用） */
  clearCache() {
    _symCache.clear();
  },
};

// =================================================================
// Sentiment Provider — Adapter Pattern
//
// 現時点では信頼できる無料公式APIが存在しないため、
// UnavailableProvider を使用。
//
// 将来の拡張:
//   - OANDAProvider: OANDA Open Position Ratios API
//   - BrokerProvider: ブローカー独自のポジションデータ
//   - MyfxbookProvider: Myfxbook Community Outlook
//
// NO DATA ≠ NEUTRAL: データ不在を明確に区別する。
// =================================================================

import type { SentimentData, ISentimentProvider, IntelligenceSource } from '../types';

// ── UnavailableProvider（現在使用中） ──────────────────────────────

class UnavailableProvider implements ISentimentProvider {
  readonly name = 'UNAVAILABLE';

  async fetch(symbol: string): Promise<SentimentData> {
    const source: IntelligenceSource = {
      name:      'Broker Sentiment',
      status:    'NO_DATA',
      updatedAt: null,
      ageMs:     null,
    };

    // NO DATA を返す — 0%やNEUTRALとして扱わない
    return {
      status:   'NO_DATA',
      longPct:  null,
      shortPct: null,
      source,
    };

    void symbol; // suppress unused warning
  }
}

// ── OANDA Provider（将来実装用スタブ） ────────────────────────────
// OANDA Open Position Ratios API を使う場合:
// GET https://api-fxtrade.oanda.com/labs/v1/historical_position_ratios
// APIキーが必要。

// class OANDAProvider implements ISentimentProvider {
//   readonly name = 'OANDA';
//   constructor(private apiKey: string) {}
//   async fetch(symbol: string): Promise<SentimentData> { ... }
// }

// ── Broker Provider（将来実装用スタブ） ───────────────────────────
// ブローカー固有の公開ポジションデータを使う場合。

// class BrokerProvider implements ISentimentProvider { ... }

// ── エクスポート ──────────────────────────────────────────────────

/** 現在アクティブなSentimentProvider */
export const SentimentProvider: ISentimentProvider = new UnavailableProvider();

// =================================================================
// Public Positioning Provider — Adapter Pattern
//
// 現時点では利用規約・API安定性の観点から実装見送り。
// 構造のみ定義し、将来の拡張に対応する。
//
// 将来の拡張候補:
//   - MQL5 Signals 公開データ
//   - Myfxbook 公開ポートフォリオ統計
//   - その他公式公開データ
//
// 重要: 推測値・ダミー値は絶対に生成しない。
// =================================================================

import type { PublicPositioningData, IPublicPositioningProvider, IntelligenceSource } from '../types';

// ── UnavailableProvider（現在使用中） ──────────────────────────────

class UnavailableProvider implements IPublicPositioningProvider {
  readonly name = 'UNAVAILABLE';

  async fetch(symbol: string): Promise<PublicPositioningData> {
    const source: IntelligenceSource = {
      name:      'Public Positioning',
      status:    'NO_DATA',
      updatedAt: null,
      ageMs:     null,
    };

    return {
      status:     'NO_DATA',
      longPct:    null,
      shortPct:   null,
      tradeCount: null,
      provider:   null,
      source,
    };

    void symbol;
  }
}

// ── MQL5 Provider（将来実装用スタブ） ─────────────────────────────
// MQL5 Signals 公開API経由でシグナルプロバイダーの
// 集計データを取得する場合:

// class MQL5Provider implements IPublicPositioningProvider { ... }

// ── エクスポート ──────────────────────────────────────────────────

export const PublicPositioningProvider: IPublicPositioningProvider = new UnavailableProvider();

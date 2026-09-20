// =================================================================
// Market Intelligence Layer — Core Types
// 既存MarketSnapshotを変更せず、拡張レイヤーとして設計。
// NO DATA ≠ NEUTRAL: データ不在と中立は厳密に区別する。
// =================================================================

/** データの鮮度・取得状態 */
export type DataStatus =
  | 'LIVE'               // リアルタイム（MT5等）
  | 'FRESH'              // 直近取得済み（許容範囲内）
  | 'STALE'              // 古い（許容範囲外だが存在する）
  | 'NO_DATA'            // データが存在しない（正常な欠損）
  | 'SOURCE_UNAVAILABLE' // ソース自体が利用不可（システムエラー）

/** データソース情報 */
export interface IntelligenceSource {
  name:      string;
  status:    DataStatus;
  updatedAt: number | null; // unix timestamp (ms)
  /** 取得からの経過時間 (ms)。null = 未取得 */
  ageMs:     number | null;
  url?:      string;
}

// ──────────────────────────────────────────────────────────────────
// SENTIMENT
// ──────────────────────────────────────────────────────────────────

export interface SentimentData {
  status:   DataStatus;
  /** ロング比率 0〜100。null = NO_DATA */
  longPct:  number | null;
  /** ショート比率 0〜100。null = NO_DATA */
  shortPct: number | null;
  source:   IntelligenceSource;
}

// ──────────────────────────────────────────────────────────────────
// COT (CFTC Commitments of Traders)
// ──────────────────────────────────────────────────────────────────

/**
 * COTは通貨先物市場のデータであり、FXスポット市場の直接的な
 * ポジションデータではないことをモデル上で明示する。
 */
export interface COTData {
  status: DataStatus;
  /** 対象の通貨（例: "EUR", "JPY"） */
  currency: string;
  /** CFTCコントラクト名（例: "EURO FX"） */
  contractName: string | null;
  /** Non-Commercial (投機) ロング枚数 */
  nonCommLong:  number | null;
  /** Non-Commercial (投機) ショート枚数 */
  nonCommShort: number | null;
  /** Net = Long - Short */
  netContracts: number | null;
  /** ロング比率 0〜100。null = NO_DATA */
  longPct:      number | null;
  /** ショート比率 0〜100。null = NO_DATA */
  shortPct:     number | null;
  /** Net% = longPct - shortPct */
  netPct:       number | null;
  /** レポート基準日 YYYY-MM-DD */
  reportDate:   string | null;
  /** 注意: これはFXスポットではなく通貨先物のデータ */
  dataDisclaimer: 'FUTURES_ONLY';
  source: IntelligenceSource;
}

// ──────────────────────────────────────────────────────────────────
// PUBLIC POSITIONING
// ──────────────────────────────────────────────────────────────────

export interface PublicPositioningData {
  status:     DataStatus;
  longPct:    number | null;
  shortPct:   number | null;
  /** 公開されている場合の追加情報 */
  tradeCount: number | null;
  provider:   string | null;
  source:     IntelligenceSource;
}

// ──────────────────────────────────────────────────────────────────
// Market Intelligence（統合型）
// ──────────────────────────────────────────────────────────────────

export interface MarketIntelligence {
  symbol:            string;
  /** シンボルから抽出した基軸通貨（例: EURUSDならEUR） */
  baseCurrency:      string;
  /** シンボルから抽出した決済通貨（例: EURUSDならUSD） */
  quoteCurrency:     string;
  sentiment:         SentimentData;
  cot:               COTData;
  publicPositioning: PublicPositioningData;
  /** 全データソースの一覧 */
  sources:           IntelligenceSource[];
  fetchedAt:         number; // unix timestamp (ms)
}

// ──────────────────────────────────────────────────────────────────
// Provider インターフェース
// ──────────────────────────────────────────────────────────────────

/** Sentimentデータプロバイダーのインターフェース */
export interface ISentimentProvider {
  readonly name: string;
  fetch(symbol: string): Promise<SentimentData>;
}

/** COTデータプロバイダーのインターフェース */
export interface ICOTProvider {
  readonly name: string;
  /** symbol例: "EURUSD" → 内部でEURに変換 */
  fetch(symbol: string): Promise<COTData>;
}

/** Public Positioningプロバイダーのインターフェース */
export interface IPublicPositioningProvider {
  readonly name: string;
  fetch(symbol: string): Promise<PublicPositioningData>;
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

/** symbolから基軸通貨を取得（EURUSD→EUR） */
export function extractBaseCurrency(symbol: string): string {
  if (symbol.length >= 6) return symbol.slice(0, 3).toUpperCase();
  return symbol.toUpperCase();
}

/** symbolから決済通貨を取得（EURUSD→USD） */
export function extractQuoteCurrency(symbol: string): string {
  if (symbol.length >= 6) return symbol.slice(3, 6).toUpperCase();
  return '';
}

/** ageMs から DataStatus を判定 */
export function ageToStatus(ageMs: number | null, freshMs: number, staleMs: number): DataStatus {
  if (ageMs === null) return 'NO_DATA';
  if (ageMs < freshMs)  return 'FRESH';
  if (ageMs < staleMs)  return 'STALE';
  return 'STALE';
}

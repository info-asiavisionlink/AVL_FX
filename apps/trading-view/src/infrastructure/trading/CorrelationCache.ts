// =================================================================
// CorrelationCache — 相関市場の価格履歴管理
//
// Gateway の symbolStore は現在価格のみ保持する。
// 相関の方向判定には価格変化が必要なため、
// サーバーサイドでインメモリに直近価格履歴を保持する。
//
// Vercel serverless のため: 関数インスタンス間でキャッシュは共有されない。
// 各インスタンスが独立して価格を蓄積する。
// =================================================================

interface PriceRecord {
  bid:  number;
  ts:   number;
}

// シンボルごとに最新5件の価格を保持（各スナップショット呼び出しで更新）
const priceHistory = new Map<string, PriceRecord[]>();
const MAX_HISTORY  = 10;

export function updatePrice(symbol: string, bid: number): void {
  const key  = symbol.toUpperCase();
  const hist = priceHistory.get(key) ?? [];
  hist.push({ bid, ts: Date.now() });
  if (hist.length > MAX_HISTORY) hist.shift();
  priceHistory.set(key, hist);
}

export type CorrelationDirection = "UP" | "DOWN" | "FLAT";
export type CorrelationState     = "CONFIRMING" | "CONTRADICTING" | "NEUTRAL" | "INSUFFICIENT_DATA";

export interface CorrelationStatus {
  symbol:       string;
  bid:          number;
  prevBid:      number | null;
  direction:    CorrelationDirection | null;
  relationship: "positive" | "negative";
  weight:       number;
  state:        CorrelationState;
  confirms:     boolean;
}

/**
 * プライマリ通貨ペアの方向（BUY=UP / SELL=DOWN）に対して
 * 相関市場が確認・矛盾・不明かを判定する。
 */
export function evalCorrelation(
  corrSymbol:    string,
  relationship:  "positive" | "negative",
  weight:        number,
  primaryDir:    "BUY" | "SELL" | "NEUTRAL",
  currentBid:    number,
): CorrelationStatus {
  const key  = corrSymbol.toUpperCase();
  const hist = priceHistory.get(key) ?? [];

  // 価格を更新
  if (currentBid > 0) {
    updatePrice(key, currentBid);
  }

  if (hist.length < 2 || currentBid === 0) {
    return {
      symbol: corrSymbol, bid: currentBid, prevBid: null,
      direction: null, relationship, weight,
      state: "INSUFFICIENT_DATA", confirms: false,
    };
  }

  const prev = hist[hist.length - 2];
  const cur  = hist[hist.length - 1];
  const diff = cur.bid - prev.bid;
  const pct  = Math.abs(diff) / (prev.bid || 1);

  // 変化が小さすぎる場合は FLAT
  const direction: CorrelationDirection =
    pct < 0.00005 ? "FLAT" :
    diff > 0 ? "UP" : "DOWN";

  if (direction === "FLAT" || primaryDir === "NEUTRAL") {
    return {
      symbol: corrSymbol, bid: currentBid, prevBid: prev.bid,
      direction, relationship, weight,
      state: "NEUTRAL", confirms: false,
    };
  }

  // 相関関係に基づく期待方向
  const primaryUp   = primaryDir === "BUY";
  const expectedDir = relationship === "positive"
    ? (primaryUp ? "UP" : "DOWN")
    : (primaryUp ? "DOWN" : "UP");

  const confirms = direction === expectedDir;
  const state: CorrelationState = confirms ? "CONFIRMING" : "CONTRADICTING";

  return {
    symbol: corrSymbol, bid: currentBid, prevBid: prev.bid,
    direction, relationship, weight,
    state, confirms,
  };
}

/** 全シンボルの履歴クリア（テスト用） */
export function clearHistory(): void {
  priceHistory.clear();
}

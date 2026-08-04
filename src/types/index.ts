// ==================================================
// AVL FX v2 - Global Type Definitions
// ==================================================

// --------------------------------------------------
// Symbol / Instrument
// --------------------------------------------------

export type Symbol = string; // 例: "EURUSD", "USDJPY"

export type Timeframe =
  | "M1"
  | "M5"
  | "M15"
  | "M30"
  | "H1"
  | "H4"
  | "D1"
  | "W1"
  | "MN";

// --------------------------------------------------
// Price Data
// --------------------------------------------------

export interface OHLCBar {
  time: number;    // UTC Unix timestamp (ミリ秒 / ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  symbol: Symbol;
  time: number;     // UTC Unix timestamp (ミリ秒 / ms)
  timeMsc: number;  // UTC Unix timestamp (ミリ秒 / ms) — same unit as time
  bid: number;
  ask: number;
  spread: number;   // pips
  last: number;     // 最終取引価格
}

export interface PriceUpdate {
  symbol: Symbol;
  timeframe: Timeframe;
  bid: number;
  ask: number;
  spread: number;
  time: number;
}

// --------------------------------------------------
// Order / Position (Phase4〜)
// --------------------------------------------------

export type OrderType = "BUY" | "SELL" | "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP";
export type OrderStatus = "PENDING" | "OPEN" | "CLOSED" | "CANCELLED";

export interface Order {
  id: string;
  symbol: Symbol;
  type: OrderType;
  volume: number;   // lot
  openPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  openTime: number;
  status: OrderStatus;
  comment?: string;
  magic?: number;   // EA識別番号
}

export interface Position {
  id: string;
  symbol: Symbol;
  type: "LONG" | "SHORT";
  volume: number;
  openPrice: number;
  currentPrice: number;
  profit: number;
  swap: number;
  commission: number;
  openTime: number;
  stopLoss?: number;
  takeProfit?: number;
  magic?: number;
}

// --------------------------------------------------
// MT5 Gateway Message
// --------------------------------------------------

export type MT5MessageType =
  | "TICK"
  | "BAR"
  | "ORDER"
  | "POSITION"
  | "ACCOUNT"
  | "HEARTBEAT";

export interface MT5Message<T = unknown> {
  type: MT5MessageType;
  symbol?: Symbol;
  timeframe?: Timeframe;
  data: T;
  timestamp: number;
}

// --------------------------------------------------
// Economic Calendar
// --------------------------------------------------

export type ImpactLevel = 1 | 2 | 3 | 4 | 5;

export interface EconomicEvent {
  id: string;
  time: number;          // Unix timestamp
  currency: string;      // "USD" | "EUR" | "JPY" etc.
  title: string;
  impact: ImpactLevel;
  forecast?: string;
  previous?: string;
  actual?: string;
  country: string;
}

// --------------------------------------------------
// AI Analysis (Phase3〜)
// --------------------------------------------------

export type TrendDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface AIAnalysis {
  symbol: Symbol;
  timeframe: Timeframe;
  trend: TrendDirection;
  confidence: number;    // 0〜100
  summary: string;
  entrySignal?: {
    direction: "BUY" | "SELL";
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    rr: number;          // Risk/Reward ratio
  };
  generatedAt: number;
}

// --------------------------------------------------
// Watchlist
// --------------------------------------------------

export interface WatchlistItem {
  symbol: Symbol;
  bid: number;
  ask: number;
  spread: number;
  dailyChange: number;       // pips
  dailyChangePercent: number; // %
  isConnected: boolean;
}

// --------------------------------------------------
// WebSocket Connection State
// --------------------------------------------------

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface WebSocketState {
  status: ConnectionStatus;
  lastPing?: number;
  reconnectCount: number;
}

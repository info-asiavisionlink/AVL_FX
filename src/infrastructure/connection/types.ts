// ==================================================
// Connection Types — ブローカー接続の型定義
// ==================================================
//
// discriminated union で将来のブローカーを型安全に追加できる。
//
//   Phase1: MT5 Gateway
//   将来:   Binance / Bybit / OANDA / cTrader
// ==================================================

// --------------------------------------------------
// ブローカータイプ識別子
// --------------------------------------------------

export type BrokerType =
  | "mt5_gateway"   // MetaTrader5 via Local Gateway (Phase1)
  | "binance"       // Binance REST + WebSocket (将来)
  | "bybit"         // Bybit REST + WebSocket (将来)
  | "oanda"         // OANDA v20 API (将来)
  | "ctrader";      // cTrader Open API (将来)

// --------------------------------------------------
// 接続状態
// --------------------------------------------------

export type ConnectionStatus =
  | "disconnected"  // 未接続
  | "connecting"    // 接続中
  | "connected"     // 接続済み
  | "error";        // エラー

// --------------------------------------------------
// 接続設定の基底型
// --------------------------------------------------

export interface BaseConnectionConfig {
  /** ユニーク ID（複数接続を将来サポートするため）*/
  id: string;
  /** 表示名 */
  name: string;
  /** ブローカー識別子 */
  type: BrokerType;
  /** 起動時に自動接続するか */
  autoConnect: boolean;
}

// --------------------------------------------------
// MT5 Gateway 接続設定（Phase1）
// --------------------------------------------------

export interface MT5GatewayConfig extends BaseConnectionConfig {
  type: "mt5_gateway";
  /** Gateway HTTP URL（EA からのデータ受信 / REST API）*/
  gatewayUrl: string;
  /** Gateway WebSocket URL（フロントエンドへのリアルタイム配信）*/
  wsUrl: string;
  /** 共有シークレット */
  secret: string;
}

// --------------------------------------------------
// 将来ブローカー設定（スタブ）
// --------------------------------------------------

export interface BinanceConfig extends BaseConnectionConfig {
  type: "binance";
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface BybitConfig extends BaseConnectionConfig {
  type: "bybit";
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface OandaConfig extends BaseConnectionConfig {
  type: "oanda";
  accountId: string;
  apiKey: string;
  environment: "practice" | "live";
}

export interface CTraderConfig extends BaseConnectionConfig {
  type: "ctrader";
  clientId: string;
  clientSecret: string;
  accessToken: string;
  accountId: number;
}

/** 全ブローカー設定の union */
export type AnyConnectionConfig =
  | MT5GatewayConfig
  | BinanceConfig
  | BybitConfig
  | OandaConfig
  | CTraderConfig;

// --------------------------------------------------
// 接続結果
// --------------------------------------------------

export interface ConnectionResult {
  success: boolean;
  error?: string;
}

// --------------------------------------------------
// Gateway のヘルスレスポンス
// --------------------------------------------------

export interface GatewayHealthResponse {
  status: "ok";
  ea: { symbol: string; account: string } | null;
  symbols: string[];
  barKeys: string[];
  clients: number;
  uptime: number;
  memory: string;
}

// --------------------------------------------------
// LocalStorage キー定数
// --------------------------------------------------

export const STORAGE_KEY_MT5_CONFIG = "avl_fx_mt5_config" as const;

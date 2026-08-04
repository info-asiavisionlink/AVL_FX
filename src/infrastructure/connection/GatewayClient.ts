// =================================================================
// GatewayClient v3.0 — AVL Market Server クライアント
// =================================================================
//
// 設計原則
//   受信したデータを加工しない。
//   時刻・価格はサーバーから受け取った値のまま使用する。
//
// エンドポイント
//   GET  /health
//   GET  /bars/:symbol/:tf?count=N
//   GET  /tick/:symbol
//   GET  /positions
//   GET  /account
//   GET  /symbols
//   WebSocket /ws   — TICK / BAR / POSITIONS / ACCOUNT / HEARTBEAT
//
// UI → ConnectionManager → GatewayClient → Market Server → MT5
// =================================================================

import type { MT5GatewayConfig, ConnectionStatus, GatewayHealthResponse } from "./types";
import type { IndicatorData } from "@/application/stores/indicatorStore";

// -----------------------------------------------------------------
// Market Server から届くデータ型
// -----------------------------------------------------------------

/** バー（時刻はブローカー秒 = rates[i].time そのまま） */
export interface MarketBar {
  time:   number; // ブローカー秒（rates[i].time）
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

/** Tick */
export interface MarketTick {
  symbol: string;
  bid:    number;
  ask:    number;
  spread: number;
  digits: number;
  time:   number; // ブローカー秒（TimeCurrent()）
}

/** ポジション */
export interface MarketPosition {
  ticket:       number;
  type:         number;
  volume:       number;
  openPrice:    number;
  currentPrice: number;
  sl:           number;
  tp:           number;
  profit:       number;
  swap:         number;
  openTime:     number;
  magic:        number;
}

/** 口座情報 */
export interface MarketAccount {
  login:       number;
  broker:      string;
  currency:    string;
  balance:     number;
  equity:      number;
  margin:      number;
  freeMargin:  number;
  marginLevel: number;
  leverage:    number;
}

/** Market Watch シンボル（完全データ） */
export interface MarketSymbol {
  symbol:       string;
  bid:          number;
  ask:          number;
  spread:       number;
  changePct:    number;
  digits:       number;
  point:        number;
  contractSize: number;
  tickValue:    number;
  tickSize:     number;
  high52:       number;
  low52:        number;
  prevClose:    number;
  time:         number;
  receivedAt?:  number;
}

/** 注文（Pending + Position） */
export interface MarketOrder {
  ticket:        number;
  symbol:        string;
  type:          number;
  orderType:     "pending" | "position";
  volume:        number;
  openPrice:     number;
  currentPrice?: number;
  sl:            number;
  tp:            number;
  profit:        number;
  swap:          number;
  commission:    number;
  openTime:      number;
  magic:         number;
  comment:       string;
}

/** 拡張インジケーター（時間足単位） */
export interface TFIndicatorData {
  ema21:      number;
  ema200:     number;
  sma50:      number;
  atr:        number;
  rsi:        number;
  macd:       number;
  macdSignal: number;
  macdHist:   number;
  adx:        number;
  diPlus:     number;
  diMinus:    number;
  bbUpper:    number;
  bbMid:      number;
  bbLower:    number;
  bbWidth:    number;
  trend:      "UP" | "DOWN" | "FLAT";
}

// -----------------------------------------------------------------
// コールバック型
// -----------------------------------------------------------------

type TickHandler      = (tick: MarketTick)        => void;
type BarHandler       = (bar: MarketBar)           => void;
type StatusHandler    = (status: ConnectionStatus) => void;
type AccountHandler   = (acc: MarketAccount)       => void;
type PositionHandler  = (pos: MarketPosition[])    => void;
type IndicatorHandler = (ind: IndicatorData)       => void;
type SymbolsHandler   = (syms: MarketSymbol[])     => void;
type OrdersHandler    = (orders: MarketOrder[])    => void;
type Unsubscribe      = () => void;

// -----------------------------------------------------------------
// GatewayClient
// -----------------------------------------------------------------

export class GatewayClient {
  private readonly httpUrl:   string;
  private readonly wsBaseUrl: string;
  private readonly secret:    string;

  private ws:             WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount  = 0;
  private readonly maxReconnect = 10;
  private destroyed = false;

  private tickHandlers      = new Map<string, Set<TickHandler>>();
  private barHandlers       = new Map<string, Set<BarHandler>>();
  private statusHandlers    = new Set<StatusHandler>();
  private accountHandlers   = new Set<AccountHandler>();
  private positionHandlers  = new Set<PositionHandler>();
  private indicatorHandlers = new Set<IndicatorHandler>();
  private symbolsHandlers   = new Set<SymbolsHandler>();
  private ordersHandlers    = new Set<OrdersHandler>();

  constructor(config: MT5GatewayConfig) {
    this.httpUrl   = config.gatewayUrl.replace(/\/$/, "");
    const wsFixed  = config.wsUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
    this.wsBaseUrl = wsFixed.replace(/\/$/, "");
    this.secret    = config.secret;
  }

  // ---------------------------------------------------------------
  // HTTP API
  // ---------------------------------------------------------------

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.httpUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch { return false; }
  }

  async getHealth(): Promise<GatewayHealthResponse | null> {
    try {
      const res = await fetch(`${this.httpUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return res.json() as Promise<GatewayHealthResponse>;
    } catch { return null; }
  }

  async getSymbols(): Promise<MarketSymbol[]> {
    try {
      const res = await fetch(`${this.httpUrl}/symbols`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      return res.json() as Promise<MarketSymbol[]>;
    } catch { return []; }
  }

  async getLatestTick(symbol: string): Promise<MarketTick | null> {
    try {
      const res = await fetch(`${this.httpUrl}/tick/${symbol.toUpperCase()}`, {
        headers: this.authHeaders(), signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return res.json() as Promise<MarketTick>;
    } catch { return null; }
  }

  /**
   * 過去バー取得
   * サーバーは count 本の最新バーを返す（時刻フィルターなし）。
   * 受け取った Bar.time はブローカー秒 — 加工しない。
   */
  async getBars(symbol: string, timeframe: string, count = 500): Promise<MarketBar[]> {
    try {
      const params = new URLSearchParams({ count: String(count) });
      const url    = `${this.httpUrl}/bars/${symbol.toUpperCase()}/${timeframe}?${params}`;
      const res    = await fetch(url, {
        headers: this.authHeaders(), signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      return res.json() as Promise<MarketBar[]>;
    } catch { return []; }
  }

  async getPositions(): Promise<MarketPosition[]> {
    try {
      const res = await fetch(`${this.httpUrl}/positions`, {
        headers: this.authHeaders(), signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      return res.json() as Promise<MarketPosition[]>;
    } catch { return []; }
  }

  async getAccount(): Promise<MarketAccount | null> {
    try {
      const res = await fetch(`${this.httpUrl}/account`, {
        headers: this.authHeaders(), signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return res.json() as Promise<MarketAccount>;
    } catch { return null; }
  }

  // ---------------------------------------------------------------
  // WebSocket 接続
  // ---------------------------------------------------------------

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) { resolve(); return; }

      this.destroyed = false;
      const wsUrl    = `${this.wsBaseUrl}/ws`;
      this.ws        = new WebSocket(wsUrl);

      const onOpen  = () => { this.reconnectCount = 0; this.notifyStatus("connected"); resolve(); };
      const onError = (e: Event) => reject(new Error(`WS接続失敗: ${wsUrl} (${String(e)})`));

      this.ws.addEventListener("open",    onOpen,  { once: true });
      this.ws.addEventListener("error",   onError, { once: true });
      this.ws.addEventListener("message", this.handleMessage);
      this.ws.addEventListener("close",   this.handleClose);
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this.notifyStatus("disconnected");
  }

  // ---------------------------------------------------------------
  // 購読 API
  // ---------------------------------------------------------------

  onTick(symbol: string, handler: TickHandler): Unsubscribe {
    const key = symbol.toUpperCase();
    if (!this.tickHandlers.has(key)) this.tickHandlers.set(key, new Set());
    this.tickHandlers.get(key)!.add(handler);
    return () => this.tickHandlers.get(key)?.delete(handler);
  }

  onBar(symbol: string, timeframe: string, handler: BarHandler): Unsubscribe {
    const key = `${symbol.toUpperCase()}:${timeframe.toUpperCase()}`;
    if (!this.barHandlers.has(key)) this.barHandlers.set(key, new Set());
    this.barHandlers.get(key)!.add(handler);
    return () => this.barHandlers.get(key)?.delete(handler);
  }

  onStatusChange(handler: StatusHandler): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onAccount(handler: AccountHandler): Unsubscribe {
    this.accountHandlers.add(handler);
    return () => this.accountHandlers.delete(handler);
  }

  onPosition(handler: PositionHandler): Unsubscribe {
    this.positionHandlers.add(handler);
    return () => this.positionHandlers.delete(handler);
  }

  onIndicators(handler: IndicatorHandler): Unsubscribe {
    this.indicatorHandlers.add(handler);
    return () => this.indicatorHandlers.delete(handler);
  }

  onSymbols(handler: SymbolsHandler): Unsubscribe {
    this.symbolsHandlers.add(handler);
    return () => this.symbolsHandlers.delete(handler);
  }

  onOrders(handler: OrdersHandler): Unsubscribe {
    this.ordersHandlers.add(handler);
    return () => this.ordersHandlers.delete(handler);
  }

  // ---------------------------------------------------------------
  // 内部: WS メッセージ処理（データを加工しない）
  // ---------------------------------------------------------------

  private handleMessage = (event: MessageEvent) => {
    let msg: { type: string; symbol?: string; timeframe?: string; data?: unknown };
    try { msg = JSON.parse(event.data as string); }
    catch { return; }

    switch (msg.type) {
      case "TICK": {
        if (!msg.symbol) break;
        const tick = msg.data as MarketTick;
        this.tickHandlers.get(msg.symbol.toUpperCase())?.forEach((h) => h(tick));
        break;
      }
      case "BAR": {
        if (!msg.symbol || !msg.timeframe) break;
        const bar = msg.data as MarketBar;
        const key = `${msg.symbol.toUpperCase()}:${msg.timeframe.toUpperCase()}`;
        this.barHandlers.get(key)?.forEach((h) => h(bar));
        break;
      }
      case "ACCOUNT": {
        const acc = msg.data as MarketAccount;
        this.accountHandlers.forEach((h) => h(acc));
        break;
      }
      case "POSITIONS": {
        const pos = msg.data as MarketPosition[];
        this.positionHandlers.forEach((h) => h(pos));
        break;
      }
      case "INDICATORS": {
        const ind = msg.data as IndicatorData;
        this.indicatorHandlers.forEach((h) => h(ind));
        break;
      }
      case "SYMBOLS": {
        const syms = msg.data as MarketSymbol[];
        this.symbolsHandlers.forEach((h) => h(syms));
        break;
      }
      case "ORDERS": {
        const orders = msg.data as MarketOrder[];
        this.ordersHandlers.forEach((h) => h(orders));
        break;
      }
      case "EA_CONNECTED":
        console.log("[GatewayClient] EA 接続:", (msg.data as Record<string, unknown>)?.symbol);
        break;
    }
  };

  private handleClose = () => {
    if (this.destroyed) return;
    this.notifyStatus("disconnected");
    this.scheduleReconnect();
  };

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectCount >= this.maxReconnect) return;
    const delay = Math.min(2000 * Math.pow(1.5, this.reconnectCount), 30000);
    this.reconnectCount++;
    console.log(`[GatewayClient] ${(delay / 1000).toFixed(1)}s 後に再接続... (${this.reconnectCount}/${this.maxReconnect})`);
    this.reconnectTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.notifyStatus("connecting");
      this.connect().catch(() => {});
    }, delay);
  }

  private notifyStatus(status: ConnectionStatus): void {
    this.statusHandlers.forEach((h) => h(status));
  }

  private authHeaders(): Record<string, string> {
    return this.secret ? { Authorization: `Bearer ${this.secret}` } : {};
  }
}

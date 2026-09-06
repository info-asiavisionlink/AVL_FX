import type { MT5Message, Symbol, Timeframe, OHLCBar, Tick, ConnectionStatus } from "@/types";

type MessageHandler<T = unknown> = (message: MT5Message<T>) => void;

export class MT5WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private status: ConnectionStatus = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;
  private readonly maxReconnect = 10;
  private readonly reconnectDelay = 3000;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly onStatusChange?: (status: ConnectionStatus) => void
  ) {}

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setStatus("connecting");
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectCount = 0;
      this.setStatus("connected");
      // 認証
      this.ws?.send(JSON.stringify({ type: "AUTH", secret: this.secret }));
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as MT5Message;
        this.dispatch(message);
      } catch {
        // 不正なメッセージは無視
      }
    };

    this.ws.onclose = () => {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.setStatus("error");
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  subscribe(symbol: Symbol, timeframe?: Timeframe): void {
    this.send({ type: "SUBSCRIBE", symbol, timeframe });
  }

  unsubscribe(symbol: Symbol, timeframe?: Timeframe): void {
    this.send({ type: "UNSUBSCRIBE", symbol, timeframe });
  }

  onTick(symbol: Symbol, handler: (tick: Tick) => void): () => void {
    const key = `TICK:${symbol}`;
    return this.addHandler(key, (msg) => {
      if (msg.type === "TICK" && msg.symbol === symbol) {
        handler(msg.data as Tick);
      }
    });
  }

  onBar(symbol: Symbol, timeframe: Timeframe, handler: (bar: OHLCBar) => void): () => void {
    const key = `BAR:${symbol}:${timeframe}`;
    return this.addHandler(key, (msg) => {
      if (msg.type === "BAR" && msg.symbol === symbol && msg.timeframe === timeframe) {
        handler(msg.data as OHLCBar);
      }
    });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private dispatch(message: MT5Message): void {
    const keys = [
      message.type,
      `${message.type}:${message.symbol}`,
      `${message.type}:${message.symbol}:${message.timeframe}`,
    ];
    keys.forEach((key) => {
      this.handlers.get(key)?.forEach((h) => h(message));
    });
  }

  private addHandler(key: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler);
    return () => this.handlers.get(key)?.delete(handler);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }

  private scheduleReconnect(): void {
    if (this.reconnectCount >= this.maxReconnect) return;
    this.reconnectCount++;
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
  }
}

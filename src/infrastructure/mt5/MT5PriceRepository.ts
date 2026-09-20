import type { OHLCBar, Symbol, Timeframe, Tick } from "@/types";
import type { IPriceRepository } from "@/domain/repositories/IPriceRepository";
import type { MT5WebSocketClient } from "@/infrastructure/websocket/MT5WebSocketClient";

// MT5 Gateway を通じて価格データを取得するリポジトリ実装
export class MT5PriceRepository implements IPriceRepository {
  constructor(
    private readonly wsClient: MT5WebSocketClient,
    private readonly gatewayUrl: string
  ) {}

  async getBars(
    symbol: Symbol,
    timeframe: Timeframe,
    from: number,
    to: number
  ): Promise<OHLCBar[]> {
    const params = new URLSearchParams({
      symbol,
      timeframe,
      from: String(from),
      to: String(to),
    });

    const res = await fetch(`${this.gatewayUrl}/bars?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch bars: ${res.statusText}`);

    const data = await res.json();
    return data as OHLCBar[];
  }

  async getLatestTick(symbol: Symbol): Promise<Tick | null> {
    const res = await fetch(`${this.gatewayUrl}/tick/${symbol}`);
    if (!res.ok) return null;
    return res.json() as Promise<Tick>;
  }

  subscribeTick(symbol: Symbol, callback: (tick: Tick) => void): () => void {
    this.wsClient.subscribe(symbol);
    return this.wsClient.onTick(symbol, callback);
  }

  subscribeBar(
    symbol: Symbol,
    timeframe: Timeframe,
    callback: (bar: OHLCBar) => void
  ): () => void {
    this.wsClient.subscribe(symbol, timeframe);
    return this.wsClient.onBar(symbol, timeframe, callback);
  }
}

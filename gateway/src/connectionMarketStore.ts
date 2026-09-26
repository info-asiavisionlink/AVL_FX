export interface ConnectionTickLike {
  symbol: string;
}

export interface ConnectionBarLike {
  time: number;
}

export function connectionTickKey(connectionId: string, symbol: string): string {
  return `${connectionId}:${symbol.toUpperCase()}`;
}

export function connectionBarKey(connectionId: string, symbol: string, timeframe: string): string {
  return `${connectionId}:${symbol.toUpperCase()}:${timeframe.toUpperCase()}`;
}

/** Runtime market state keyed by authenticated connection identity. */
export class ConnectionMarketStore<
  TTick extends ConnectionTickLike,
  TBar extends ConnectionBarLike,
> {
  private readonly ticks = new Map<string, TTick>();
  private readonly bars = new Map<string, TBar[]>();
  private readonly m5Times = new Map<string, number>();

  setTick(connectionId: string, tick: TTick): void {
    this.ticks.set(connectionTickKey(connectionId, tick.symbol), tick);
  }

  getTick(connectionId: string, symbol: string): TTick | undefined {
    return this.ticks.get(connectionTickKey(connectionId, symbol));
  }

  upsertBars(
    connectionId: string,
    symbol: string,
    timeframe: string,
    bars: readonly TBar[],
    maxBars: number,
  ): void {
    const key = connectionBarKey(connectionId, symbol, timeframe);
    this.bars.set(key, [...bars].slice(-maxBars));
  }

  getBars(connectionId: string, symbol: string, timeframe: string): TBar[] {
    return [...(this.bars.get(connectionBarKey(connectionId, symbol, timeframe)) ?? [])];
  }

  getBarCount(connectionId: string, symbol: string, timeframe: string): number {
    return this.bars.get(connectionBarKey(connectionId, symbol, timeframe))?.length ?? 0;
  }

  setLastM5Time(connectionId: string, symbol: string, timestamp: number): void {
    this.m5Times.set(connectionTickKey(connectionId, symbol), timestamp);
  }

  getLastM5Time(connectionId: string, symbol: string): number | undefined {
    return this.m5Times.get(connectionTickKey(connectionId, symbol));
  }
}

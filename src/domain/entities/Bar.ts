import type { OHLCBar, Symbol, Timeframe } from "@/types";

export class Bar {
  constructor(
    public readonly symbol: Symbol,
    public readonly timeframe: Timeframe,
    public readonly time: number,
    public readonly open: number,
    public readonly high: number,
    public readonly low: number,
    public readonly close: number,
    public readonly volume: number
  ) {}

  get isBullish(): boolean {
    return this.close > this.open;
  }

  get bodySize(): number {
    return Math.abs(this.close - this.open);
  }

  toOHLC(): OHLCBar {
    return {
      time: this.time,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
      volume: this.volume,
    };
  }

  static fromRaw(symbol: Symbol, timeframe: Timeframe, raw: OHLCBar): Bar {
    return new Bar(
      symbol,
      timeframe,
      raw.time,
      raw.open,
      raw.high,
      raw.low,
      raw.close,
      raw.volume
    );
  }
}

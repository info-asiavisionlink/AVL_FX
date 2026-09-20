import type { Symbol } from "@/types";

export class Instrument {
  constructor(
    public readonly symbol: Symbol,
    public readonly digits: number,    // 小数点桁数 (例: USDJPY=3, EURUSD=5)
    public readonly pointSize: number, // 1point の価格単位
    public readonly contractSize: number = 100000
  ) {}

  get pipSize(): number {
    // JPY系は 0.01、それ以外は 0.0001
    return this.digits === 3 || this.digits === 2 ? 0.01 : 0.0001;
  }

  spreadToPips(spreadPoints: number): number {
    return spreadPoints * this.pointSize / this.pipSize;
  }

  formatPrice(price: number): string {
    return price.toFixed(this.digits);
  }
}

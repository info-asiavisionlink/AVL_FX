import type { OHLCBar, Symbol, Timeframe } from "@/types";
import type { IPriceRepository } from "@/domain/repositories/IPriceRepository";

export class GetBarsUseCase {
  constructor(private readonly priceRepository: IPriceRepository) {}

  async execute(
    symbol: Symbol,
    timeframe: Timeframe,
    from: number,
    to: number
  ): Promise<OHLCBar[]> {
    if (from >= to) {
      throw new Error("from must be earlier than to");
    }
    return this.priceRepository.getBars(symbol, timeframe, from, to);
  }
}

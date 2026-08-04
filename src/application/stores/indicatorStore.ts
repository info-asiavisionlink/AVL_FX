import { create } from "zustand";

export interface TFIndicator {
  ema21:  number;
  ema200: number;
  atr:    number;
}

export interface IndicatorData {
  symbol:     string;
  spread:     number;
  digits:     number;
  brokerTime: number;
  timeframes: Record<string, TFIndicator>;
  receivedAt: number;
  sessions?:  string[]; // Tokyo / London / New York / Sydney
}

interface IndicatorStore {
  indicators: Record<string, IndicatorData>;
  setIndicators: (data: IndicatorData) => void;
  getForSymbol: (symbol: string) => IndicatorData | undefined;
}

export const useIndicatorStore = create<IndicatorStore>((set, get) => ({
  indicators: {},

  setIndicators: (data) =>
    set((s) => ({
      indicators: {
        ...s.indicators,
        [data.symbol.toUpperCase()]: { ...data, receivedAt: Date.now() },
      },
    })),

  getForSymbol: (symbol) =>
    get().indicators[symbol.toUpperCase()],
}));

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
  setIndicatorsBatch: (dataList: IndicatorData[]) => void;
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

  // Single store write for multiple symbols — prevents N re-renders from N symbols
  setIndicatorsBatch: (dataList) =>
    set((s) => {
      const next = { ...s.indicators };
      const now = Date.now();
      for (const data of dataList) {
        next[data.symbol.toUpperCase()] = { ...data, receivedAt: now };
      }
      return { indicators: next };
    }),

  getForSymbol: (symbol) =>
    get().indicators[symbol.toUpperCase()],
}));

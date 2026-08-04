import { create } from "zustand";
import type { Tick, Symbol, Timeframe, WatchlistItem } from "@/types";

interface PriceState {
  activeSymbol: Symbol;
  activeTimeframe: Timeframe;
  watchlist: WatchlistItem[];
  ticks: Record<Symbol, Tick>;

  setActiveSymbol:     (symbol: Symbol) => void;
  setActiveTimeframe:  (timeframe: Timeframe) => void;
  updateTick:          (tick: Tick) => void;
  /** シンボルの任意フィールドを部分更新（前日比・isConnected など）*/
  updateWatchlistItem: (symbol: Symbol, patch: Partial<WatchlistItem>) => void;
  addToWatchlist:      (symbol: Symbol) => void;
  removeFromWatchlist: (symbol: Symbol) => void;
  setWatchlist:        (items: WatchlistItem[]) => void;
  /** 未接続状態にリセット（切断時）*/
  resetConnectionState: () => void;
}

const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { symbol: "EURUSD", bid: 0, ask: 0, spread: 0, dailyChange: 0, dailyChangePercent: 0, isConnected: false },
  { symbol: "USDJPY", bid: 0, ask: 0, spread: 0, dailyChange: 0, dailyChangePercent: 0, isConnected: false },
  { symbol: "GBPUSD", bid: 0, ask: 0, spread: 0, dailyChange: 0, dailyChangePercent: 0, isConnected: false },
  { symbol: "AUDUSD", bid: 0, ask: 0, spread: 0, dailyChange: 0, dailyChangePercent: 0, isConnected: false },
  { symbol: "XAUUSD", bid: 0, ask: 0, spread: 0, dailyChange: 0, dailyChangePercent: 0, isConnected: false },
];

export const usePriceStore = create<PriceState>((set) => ({
  activeSymbol:    "EURUSD",
  activeTimeframe: "H1",
  watchlist:       DEFAULT_WATCHLIST,
  ticks:           {},

  setActiveSymbol:    (symbol)    => set({ activeSymbol: symbol }),
  setActiveTimeframe: (timeframe) => set({ activeTimeframe: timeframe }),

  updateTick: (tick) =>
    set((state) => ({
      ticks: { ...state.ticks, [tick.symbol]: tick },
      watchlist: state.watchlist.map((item) =>
        item.symbol === tick.symbol
          ? { ...item, bid: tick.bid, ask: tick.ask, spread: tick.spread, isConnected: true }
          : item
      ),
    })),

  updateWatchlistItem: (symbol, patch) =>
    set((state) => ({
      watchlist: state.watchlist.map((item) =>
        item.symbol === symbol ? { ...item, ...patch } : item
      ),
    })),

  addToWatchlist: (symbol) =>
    set((state) => {
      if (state.watchlist.some((w) => w.symbol === symbol)) return state;
      return {
        watchlist: [
          ...state.watchlist,
          { symbol, bid: 0, ask: 0, spread: 0, dailyChange: 0, dailyChangePercent: 0, isConnected: false },
        ],
      };
    }),

  removeFromWatchlist: (symbol) =>
    set((state) => ({
      watchlist: state.watchlist.filter((w) => w.symbol !== symbol),
    })),

  setWatchlist: (items) => set({ watchlist: items }),

  resetConnectionState: () =>
    set((state) => ({
      watchlist: state.watchlist.map((w) => ({
        ...w, bid: 0, ask: 0, spread: 0, isConnected: false,
        dailyChange: 0, dailyChangePercent: 0,
      })),
      ticks: {},
    })),
}));

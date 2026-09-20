import { create } from "zustand";
import type { MarketSymbol, MarketOrder } from "@/infrastructure/connection/GatewayClient";

// -----------------------------------------------------------------
// Market Watch Store — 全シンボル + 全注文のリアルタイム状態
// -----------------------------------------------------------------

interface MarketState {
  // Market Watch シンボル（Map: symbol → MarketSymbol）
  symbols:       Map<string, MarketSymbol>;
  symbolList:    MarketSymbol[];          // レンダリング用配列

  // 注文（Pending + Position）
  orders:        Map<number, MarketOrder>;
  orderList:     MarketOrder[];

  // アクション
  setSymbols:    (syms: MarketSymbol[]) => void;
  updateSymbol:  (sym: MarketSymbol)    => void;
  setOrders:     (orders: MarketOrder[]) => void;
  clearSymbols:  () => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  symbols:    new Map(),
  symbolList: [],
  orders:     new Map(),
  orderList:  [],

  setSymbols: (syms) => {
    const map = new Map<string, MarketSymbol>();
    for (const s of syms) map.set(s.symbol.toUpperCase(), s);
    set({ symbols: map, symbolList: syms });
  },

  updateSymbol: (sym) => set((state) => {
    const next = new Map(state.symbols);
    next.set(sym.symbol.toUpperCase(), sym);
    return { symbols: next, symbolList: Array.from(next.values()) };
  }),

  setOrders: (orders) => {
    const map = new Map<number, MarketOrder>();
    for (const o of orders) map.set(o.ticket, o);
    set({ orders: map, orderList: orders });
  },

  clearSymbols: () => set({ symbols: new Map(), symbolList: [], orders: new Map(), orderList: [] }),
}));

"use client";

// =================================================================
// useWatchlistData v3.0 — ウォッチリスト データ管理
// =================================================================
//
// 接続時:
//   1. REST で最新 Tick を即時取得
//   2. WebSocket で Tick をリアルタイム購読
//   3. WebSocket で Account をリアルタイム購読
//
// 受け取ったデータは加工せずにストアへ渡す。
// =================================================================

import { useEffect } from "react";
import { useConnectionStore } from "@/application/stores/connectionStore";
import { usePriceStore }      from "@/application/stores/priceStore";
import { ConnectionManager }  from "@/infrastructure/connection/ConnectionManager";

const DEFAULT_SYMBOLS = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "XAUUSD", "BTCUSD"];

export function useWatchlistData() {
  const { status }                                             = useConnectionStore();
  const { watchlist, updateTick, resetConnectionState, setWatchlist } = usePriceStore();

  useEffect(() => {
    if (status !== "connected") {
      resetConnectionState();
      return;
    }

    const client = ConnectionManager.instance.client;
    if (!client) return;

    // ウォッチリストにデフォルトシンボルを補完
    const current = watchlist.map((w) => w.symbol);
    const missing = DEFAULT_SYMBOLS.filter((s) => !current.includes(s));
    if (missing.length > 0) {
      setWatchlist([
        ...watchlist,
        ...missing.map((s) => ({
          symbol: s, bid: 0, ask: 0, spread: 0,
          dailyChange: 0, dailyChangePercent: 0, isConnected: false,
        })),
      ]);
    }

    const allSymbols = [...new Set([...current, ...DEFAULT_SYMBOLS])];

    // REST で初期 Tick を取得
    allSymbols.forEach(async (symbol) => {
      const tick = await client.getLatestTick(symbol);
      if (!tick) return;
      // 受け取った bid/ask をそのまま渡す（加工禁止）
      updateTick({
        symbol:  tick.symbol ?? symbol,
        time:    tick.time,
        timeMsc: tick.time,
        bid:     tick.bid,
        ask:     tick.ask,
        spread:  tick.spread,
        last:    tick.bid,
      });
    });

    // WebSocket で Tick をリアルタイム購読
    const unsubTicks = allSymbols.map((symbol) =>
      client.onTick(symbol, (tick) => {
        updateTick({
          symbol:  tick.symbol ?? symbol,
          time:    tick.time,
          timeMsc: tick.time,
          bid:     tick.bid,
          ask:     tick.ask,
          spread:  tick.spread,
          last:    tick.bid,
        });
      })
    );

    return () => unsubTicks.forEach((u) => u());
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
}

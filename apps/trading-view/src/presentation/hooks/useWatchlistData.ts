"use client";

// =================================================================
// useWatchlistData v4.0 — EA稼働銘柄ベースのリアルタイムデータ管理
// =================================================================
//
// 変更点 (v3 → v4):
//   - DEFAULT_SYMBOLS固定リストを廃止
//   - indicatorStore のEA稼働銘柄を購読対象に使用
//   - Chart/Markets 両ページでIndicator/Symbol/Tickを購読
//   - Tick購読はEA稼働銘柄セットが変わった時のみ再購読
//
// データフロー:
//   WebSocket INDICATORS → indicatorStore → eaSymbols
//   WebSocket SYMBOLS    → marketStore
//   WebSocket TICK       → priceStore.ticks (EA銘柄のみ)
// =================================================================

import { useEffect, useMemo }    from "react";
import { useConnectionStore }    from "@/application/stores/connectionStore";
import { usePriceStore }         from "@/application/stores/priceStore";
import { useIndicatorStore }     from "@/application/stores/indicatorStore";
import { useMarketStore }        from "@/application/stores/marketStore";
import { ConnectionManager }     from "@/infrastructure/connection/ConnectionManager";

export function useWatchlistData() {
  const { status }                                           = useConnectionStore();
  const { updateTick, setWatchlist }                        = usePriceStore();
  const { indicators, setIndicators, setIndicatorsBatch }   = useIndicatorStore();
  const { setSymbols }                                      = useMarketStore();

  // EA稼働銘柄キー（変化時のみ再購読）
  const eaSymbolsKey = useMemo(
    () => Object.keys(indicators).sort().join(","),
    [indicators]
  );

  // ── Indicator / Symbol 購読（全ページ共通）──────────────────────
  // ChartページでもIndicatorStoreが正しく埋まるようにグローバルで購読する
  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;

    const unsubInd  = client.onIndicators((ind) => setIndicators(ind));
    const unsubSyms = client.onSymbols((syms) => setSymbols(syms));

    // 接続直後にHTTPで初期データを取得（WS初回送信を逃した場合の補完）
    client.getIndicators().then((list) => {
      if (list.length > 0) setIndicatorsBatch(list);
    }).catch(() => {});

    client.getSymbols().then((syms) => {
      if (syms.length > 0) setSymbols(syms);
    }).catch(() => {});

    // EAがTICKを個別送信しないケースに対応するため定期ポーリング（2秒ごと）
    // WebSocket SYMBOLS は初回のみのため、REST で価格を継続更新する
    const pollSymbols = () => {
      client.getSymbols().then((syms) => {
        if (syms.length > 0) setSymbols(syms);
      }).catch(() => {});
    };
    const pollId = setInterval(pollSymbols, 2000);

    return () => {
      unsubInd();
      unsubSyms();
      clearInterval(pollId);
    };
  }, [status, setIndicators, setIndicatorsBatch, setSymbols]);

  // ── Tick購読（EA稼働銘柄のみ、銘柄セット変化時に再購読）────────
  useEffect(() => {
    if (status !== "connected") return;
    const client = ConnectionManager.instance.client;
    if (!client) return;

    const symbols = eaSymbolsKey ? eaSymbolsKey.split(",").filter(Boolean) : [];
    if (symbols.length === 0) return;

    // priceStore.watchlist をEA銘柄で同期（後方互換）
    setWatchlist(
      symbols.map((s) => ({
        symbol: s, bid: 0, ask: 0, spread: 0,
        dailyChange: 0, dailyChangePercent: 0, isConnected: false,
      }))
    );

    // REST で初期Tick取得（表示を即座に埋める）
    symbols.forEach(async (symbol) => {
      const tick = await client.getLatestTick(symbol);
      if (!tick) return;
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

    // WebSocket Tick リアルタイム購読（EA稼働銘柄のみ）
    const unsubTicks = symbols.map((symbol) =>
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
  }, [status, eaSymbolsKey, updateTick, setWatchlist]);
}

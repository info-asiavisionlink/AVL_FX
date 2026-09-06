"use client";

// ==================================================
// TradingView Charting Library の React ラッパー
//
// 前提条件:
//   public/charting_library/ に TradingView ライブラリを配置すること
//   ライブラリ取得: https://www.tradingview.com/HTML5-stock-forex-bitcoin-charting-library/
//
// ライブラリが未配置の場合は ChartPlaceholder を表示する
// ==================================================

import { useEffect, useRef, useState } from "react";
import { usePriceStore } from "@/application/stores/priceStore";
import { TVDatafeed } from "@/infrastructure/tradingview/TVDatafeed";
import { ChartPlaceholder } from "./ChartPlaceholder";

// TradingView グローバル型定義（ライブラリ読み込み後に window に付与される）
declare global {
  interface Window {
    TradingView?: {
      widget: new (options: TVWidgetOptions) => TVWidget;
    };
  }
}

interface TVWidgetOptions {
  container: HTMLElement;
  locale: string;
  library_path: string;
  datafeed: TVDatafeed;
  symbol: string;
  interval: string;
  fullscreen: boolean;
  autosize: boolean;
  theme: "dark" | "light";
  style: string;
  toolbar_bg: string;
  overrides: Record<string, string | number | boolean>;
  disabled_features: string[];
  enabled_features: string[];
}

interface TVWidget {
  remove(): void;
}

// TradingView resolution マッピング（AVL FX 時間足 → TV resolution）
const TF_TO_RESOLUTION: Record<string, string> = {
  M1: "1", M5: "5", M15: "15", M30: "30",
  H1: "60", H4: "240", D1: "D", W1: "W", MN: "M",
};

// Datafeed インスタンスはチャートを再描画しても再利用する
let sharedDatafeed: TVDatafeed | null = null;

function getDatafeed(): TVDatafeed {
  if (sharedDatafeed) return sharedDatafeed;
  const gatewayWs   = process.env.NEXT_PUBLIC_MT5_GATEWAY_WS_URL   ?? "ws://localhost:8080";
  const gatewayHttp = process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "http://localhost:8080";
  sharedDatafeed = new TVDatafeed(gatewayWs, gatewayHttp);
  return sharedDatafeed;
}

export function TradingViewChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TVWidget | null>(null);
  const [tvLoaded, setTvLoaded] = useState(false);

  const { activeSymbol, activeTimeframe } = usePriceStore();

  // クライアントサイドでライブラリ読み込みを確認
  useEffect(() => {
    setTvLoaded(!!window.TradingView);
  }, []);

  // シンボル / 時間足が変わったらウィジェットを再初期化
  useEffect(() => {
    if (!tvLoaded) return;
    if (!containerRef.current) return;
    if (!window.TradingView) return;

    const datafeed = getDatafeed();

    const widget = new window.TradingView.widget({
      container: containerRef.current,
      locale: "en",
      library_path: process.env.NEXT_PUBLIC_TRADINGVIEW_LIBRARY_PATH ?? "/charting_library/",
      datafeed,
      symbol: activeSymbol,
      interval: TF_TO_RESOLUTION[activeTimeframe] ?? "60",
      fullscreen: false,
      autosize: true,
      theme: "dark",
      style: "1", // Candlestick
      toolbar_bg: "#1a1d29",
      overrides: {
        // 背景
        "paneProperties.background": "#131722",
        "paneProperties.backgroundType": "solid",
        // テキスト
        "scalesProperties.textColor": "#9ca3af",
        "scalesProperties.lineColor": "#2a2d3a",
        // ローソク足: 陽線
        "mainSeriesProperties.candleStyle.upColor": "#26a69a",
        "mainSeriesProperties.candleStyle.borderUpColor": "#26a69a",
        "mainSeriesProperties.candleStyle.wickUpColor": "#26a69a",
        // ローソク足: 陰線
        "mainSeriesProperties.candleStyle.downColor": "#ef5350",
        "mainSeriesProperties.candleStyle.borderDownColor": "#ef5350",
        "mainSeriesProperties.candleStyle.wickDownColor": "#ef5350",
        // グリッド
        "paneProperties.separatorColor": "#2a2d3a",
        "paneProperties.gridProperties.color": "#1e2030",
      },
      disabled_features: [
        "use_localstorage_for_settings",
        "header_symbol_search",   // 独自 Watchlist を使用するため無効
        "header_compare",
        "display_market_status",
      ],
      enabled_features: [
        "side_toolbar_in_fullscreen_mode",
        "hide_last_na_study_output",
      ],
    });

    widgetRef.current = widget;

    return () => {
      widget.remove();
      widgetRef.current = null;
    };
  }, [tvLoaded, activeSymbol, activeTimeframe]);

  // ライブラリ未配置: プレースホルダーを表示
  if (!tvLoaded) {
    return <ChartPlaceholder />;
  }

  return <div ref={containerRef} className="w-full h-full" />;
}

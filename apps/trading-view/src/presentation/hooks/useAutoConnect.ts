"use client";

// ==================================================
// useAutoConnect — 起動時に localStorage から設定を読み込んで自動接続
// ==================================================
//
// AppProviders.tsx から呼び出す。
// config.autoConnect === true の場合のみ接続を試みる。
// ==================================================

import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/application/stores/connectionStore";

// 環境変数からデフォルト接続設定を生成
function getDefaultConfig(): import("@/infrastructure/connection/types").MT5GatewayConfig {
  return {
    id:          "mt5_default",
    name:        "MT5 Gateway",
    type:        "mt5_gateway",
    autoConnect: true,
    gatewayUrl:  process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "http://127.0.0.1:8080",
    wsUrl:       process.env.NEXT_PUBLIC_MT5_GATEWAY_WS_URL   ?? "ws://127.0.0.1:8080",
    secret:      "",
  };
}

export function useAutoConnect() {
  const { config, connect, status } = useConnectionStore();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    if (status === "connected" || status === "connecting") return;

    // 保存済み設定があればそれを使い、なければ env vars のデフォルトで接続
    const cfg = (config?.autoConnect ? config : null) ?? getDefaultConfig();

    attempted.current = true;
    console.log("[AutoConnect] 接続開始:", cfg.gatewayUrl);
    connect(cfg).catch((err) => {
      console.warn("[AutoConnect] 自動接続に失敗しました:", err);
    });
  }, [config, connect, status]);
}

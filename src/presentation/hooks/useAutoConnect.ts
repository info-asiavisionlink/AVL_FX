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

export function useAutoConnect() {
  const { config, connect, status } = useConnectionStore();
  const attempted = useRef(false);

  useEffect(() => {
    // 既に接続試行済み・接続中・接続済みの場合はスキップ
    if (attempted.current) return;
    if (status === "connected" || status === "connecting") return;
    if (!config?.autoConnect) return;

    attempted.current = true;
    console.log("[AutoConnect] localStorage の設定で自動接続を開始します...");
    connect(config).catch((err) => {
      console.warn("[AutoConnect] 自動接続に失敗しました:", err);
    });
  }, [config, connect, status]);
}

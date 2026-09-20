"use client";

import { useState, useEffect, useCallback } from "react";

export interface UserMT5Connection {
  connected:      boolean;
  online:         boolean;
  connectionId:   string | null;
  broker:         string | null;
  serverName:     string | null;
  mt5Login:       number | null;
  accountType:    "REAL" | "DEMO" | null;
  tradingEnabled: boolean;
  emergencyStop:  boolean;
  lastHeartbeatAt: string | null;
  ageSeconds:     number | null;
}

const DEFAULT: UserMT5Connection = {
  connected:      false,
  online:         false,
  connectionId:   null,
  broker:         null,
  serverName:     null,
  mt5Login:       null,
  accountType:    null,
  tradingEnabled: false,
  emergencyStop:  false,
  lastHeartbeatAt: null,
  ageSeconds:     null,
};

/** Authenticated UserのアクティブなMT5接続状態を取得するhook */
export function useUserMT5Connection(pollIntervalMs = 15_000) {
  const [status,  setStatus]  = useState<UserMT5Connection>(DEFAULT);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch("/api/live/connection/status");
      if (!res.ok) { setStatus(DEFAULT); return; }
      const data = await res.json() as Record<string, unknown>;
      setStatus({
        connected:      !!data.connected,
        online:         !!data.online,
        connectionId:   (data.connectionId as string) ?? null,
        broker:         (data.broker as string) ?? null,
        serverName:     (data.serverName as string) ?? null,
        mt5Login:       (data.mt5Login as number) ?? null,
        accountType:    (data.accountType as "REAL" | "DEMO") ?? null,
        tradingEnabled: !!data.tradingEnabled,
        emergencyStop:  !!data.emergencyStop,
        lastHeartbeatAt: (data.lastHeartbeatAt as string) ?? null,
        ageSeconds:     (data.ageSeconds as number) ?? null,
      });
    } catch {
      setStatus(DEFAULT);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetch_();
    const id = setInterval(() => void fetch_(), pollIntervalMs);
    return () => clearInterval(id);
  }, [fetch_, pollIntervalMs]);

  return { status, loading, refresh: fetch_ };
}

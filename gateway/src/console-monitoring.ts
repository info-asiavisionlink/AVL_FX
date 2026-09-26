type MonitoringPayload = {
  gateway_online: boolean;
  mt5_connected: boolean;
  mt5_account_mode?: "HEDGING" | "NETTING" | null;
  bridge_version?: string | null;
  active_strategy_count?: number;
  metadata?: Record<string, unknown>;
};

/** Optional server-to-server Console heartbeat; secrets never reach clients. */
export async function sendConsoleMonitoringHeartbeat(payload: MonitoringPayload, timeoutMs = 3000): Promise<void> {
  const endpoint = process.env.CONSOLE_MONITORING_URL?.trim();
  const token = process.env.CONSOLE_SYSTEM_TOKEN?.trim();
  if (!endpoint || !token) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-system-token": token },
      body: JSON.stringify({ ...payload, observed_at: new Date().toISOString() }),
      signal: controller.signal,
    });
    if (!response.ok) console.warn(`[monitoring] Console heartbeat rejected: ${response.status}`);
  } catch (error) {
    console.warn(`[monitoring] Console heartbeat unavailable: ${error instanceof Error ? error.name : "error"}`);
  } finally {
    clearTimeout(timer);
  }
}

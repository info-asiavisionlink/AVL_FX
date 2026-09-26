export type ConsoleRegistrationPayload = {
  share_code: string; tv_strategy_id: string; tv_user_id: string | null;
  name: string; strategy_type: string; spec: unknown;
  backtest_result?: unknown; raw_prompt?: string | null;
};

export type ConsoleRegistrationResult =
  | { ok: true; status: number }
  | { ok: false; reason: "HTTP_ERROR" | "NETWORK_ERROR" | "MALFORMED_RESPONSE"; status?: number };

export async function registerToConsole(
  consoleUrl: string,
  secret: string,
  payload: ConsoleRegistrationPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<ConsoleRegistrationResult> {
  try {
    const response = await fetchImpl(`${consoleUrl.replace(/\/$/, "")}/api/ea-registry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ea-registry-secret": secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, reason: "HTTP_ERROR", status: response.status };
    const body = await response.json().catch(() => null) as { id?: unknown; share_code?: unknown } | null;
    if (!body || typeof body.id !== "string" || body.share_code !== payload.share_code) {
      return { ok: false, reason: "MALFORMED_RESPONSE", status: response.status };
    }
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, reason: "NETWORK_ERROR" };
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { sendConsoleMonitoringHeartbeat } from "./console-monitoring";

const originalFetch = globalThis.fetch;
const originalEndpoint = process.env.CONSOLE_MONITORING_URL;
const originalToken = process.env.CONSOLE_SYSTEM_TOKEN;

function restore() {
  globalThis.fetch = originalFetch;
  if (originalEndpoint === undefined) delete process.env.CONSOLE_MONITORING_URL;
  else process.env.CONSOLE_MONITORING_URL = originalEndpoint;
  if (originalToken === undefined) delete process.env.CONSOLE_SYSTEM_TOKEN;
  else process.env.CONSOLE_SYSTEM_TOKEN = originalToken;
}

test("sender posts a bounded server-side heartbeat without exposing token", async () => {
  process.env.CONSOLE_MONITORING_URL = "https://console.example/api/monitoring/report";
  process.env.CONSOLE_SYSTEM_TOKEN = "server-only-test-token";
  let request: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { request = init; return new Response("{}", { status: 200 }); };
  try {
    await sendConsoleMonitoringHeartbeat({ gateway_online: true, mt5_connected: false }, 100);
    assert.equal(request?.method, "POST");
    assert.equal((request?.headers as Record<string, string>)["x-system-token"], "server-only-test-token");
    const body = JSON.parse(String(request?.body));
    assert.equal(body.customer_system_id, undefined);
    assert.equal(body.gateway_online, true);
    assert.equal(body.mt5_connected, false);
    assert.doesNotMatch(JSON.stringify(body), /server-only-test-token/);
  } finally { restore(); }
});

test("sender handles Console failure and malformed response without throwing", async () => {
  process.env.CONSOLE_MONITORING_URL = "https://console.example/api/monitoring/report";
  process.env.CONSOLE_SYSTEM_TOKEN = "server-only-test-token";
  globalThis.fetch = async () => new Response("not-json", { status: 502 });
  try {
    await assert.doesNotReject(sendConsoleMonitoringHeartbeat({ gateway_online: true, mt5_connected: false }, 100));
    globalThis.fetch = async () => { throw new Error("unavailable"); };
    await assert.doesNotReject(sendConsoleMonitoringHeartbeat({ gateway_online: true, mt5_connected: false }, 100));
  } finally { restore(); }
});

test("sender timeout is bounded and has no execution side effect", async () => {
  process.env.CONSOLE_MONITORING_URL = "https://console.example/api/monitoring/report";
  process.env.CONSOLE_SYSTEM_TOKEN = "server-only-test-token";
  globalThis.fetch = async (_input, init) => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
  });
  try { await assert.doesNotReject(sendConsoleMonitoringHeartbeat({ gateway_online: true, mt5_connected: false }, 5)); }
  finally { restore(); }
});

test("sender is server-only and cannot choose arbitrary systems", () => {
  const source = readFileSync("src/console-monitoring.ts", "utf8");
  assert.doesNotMatch(source, /NEXT_PUBLIC/);
  assert.doesNotMatch(source, /customer_system_id/);
  assert.doesNotMatch(source, /execution_commands|sendOrder|placeOrder|BUY|SELL/);
});

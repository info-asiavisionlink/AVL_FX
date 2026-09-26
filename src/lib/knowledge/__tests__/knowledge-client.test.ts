import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

process.env.CONSOLE_URL = "https://console.test";
process.env.KNOWLEDGE_API_SECRET = "server-secret";

import * as client from "../knowledge-client";
const item = (overrides: Record<string, unknown> = {}) => ({
  id: "k1", title: "Structure", category: "Market Structure", summary: "summary",
  content: "content", ai_usage: "use it", market: ["GOLD"], timeframes: ["H1"], tags: ["trend"],
  status: "ACTIVE", version: 3, updated_at: "2026-09-23T00:00:00Z", ...overrides,
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [item()] }), { status: 200 })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("valid server knowledge response returns ACTIVE items and metadata", async () => {
  const items = await client.fetchActiveKnowledge();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.version, 3);
  const selected = client.selectKnowledgeForTrader(items, { market: "GOLD", timeframe: "H1", triggerType: "HOURLY_ANALYSIS" });
  assert.equal(selected[0]?.id, "k1");
  assert.match(client.formatKnowledgeForPrompt(selected), /v3/);
});

test("invalid response is explicit, never an empty-success fallback", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ source: "offline" }), { status: 200 })) as typeof fetch;
  await assert.rejects(client.fetchActiveKnowledge(), (e: unknown) => e instanceof client.KnowledgeUnavailableError && e.code === "INVALID_RESPONSE");
});

test("API failure and true empty result remain distinguishable", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await client.fetchActiveKnowledge(), []);
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  await assert.rejects(client.fetchActiveKnowledge(), (e: unknown) => e instanceof client.KnowledgeUnavailableError && e.code === "SERVER_ERROR");
});

test("selector applies trader market/timeframe and selected IDs", () => {
  const items = [item(), item({ id: "k2", market: ["USDJPY"] }), item({ id: "k3", timeframes: ["M5"] })];
  const selected = client.selectKnowledgeForTrader(items, { market: "GOLD", timeframe: "H1", selectedIds: ["k1", "k3"] });
  assert.deepEqual(selected.map(x => x.id), ["k1"]);
});

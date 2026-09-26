// V2 Stage 5: position review binds knowledge from Customer Supabase, never the Console API.
import "./helpers/position-review-env";
import assert from "node:assert/strict";
import test from "node:test";
import { handleManagePositions } from "../position-review-runtime";

function db(knowledgeRows: Record<string, unknown>[], knowledgeError: string | null = null) {
  const knowledgeFilters: [string, unknown][] = [];
  const rowsFor: Record<string, unknown[]> = {
    ai_traders: [{ id: "trader-a", user_id: "user-a", market: "GOLD", current_version: 1 }],
    ai_trader_versions: [{ id: "version-a", version: 1, magic_number: 900001 }],
    ai_positions: [{ id: "pos-a", scenario_id: "sc-a", side: "BUY", entry_price: 100, stop_loss: 90, take_profit: 110, volume: 0.01, status: "OPEN" }],
    mt5_connections: [{ id: "conn-a", last_heartbeat_at: new Date().toISOString() }],
    customer_knowledge: knowledgeRows,
  };
  const client = {
    from: (table: string) => {
      let one = false;
      const self: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "neq", "in"]) self[m] = () => self;
      self.eq = (col: string, val: unknown) => { if (table === "customer_knowledge") knowledgeFilters.push([col, val]); return self; };
      self.single = () => { one = true; return self; };
      self.maybeSingle = () => { one = true; return self; };
      self.then = (resolve: (v: unknown) => unknown) => {
        const rows = rowsFor[table] ?? [];
        const error = table === "customer_knowledge" && knowledgeError ? { message: knowledgeError } : null;
        return Promise.resolve(resolve({ data: one ? (rows[0] ?? null) : rows, error }));
      };
      return self;
    },
  };
  return { client: client as never, knowledgeFilters };
}

function stubFetch() {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("http://gateway.stage5.test/")) {
      return new Response(JSON.stringify({ bid: 100, ask: 100.2, time: Math.floor(Date.now() / 1000) }), { status: 200 });
    }
    throw new Error(`unexpected network call: ${url}`);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

for (const [label, rows, err] of [
  ["no ACTIVE customer knowledge", [], null],
  ["customer_knowledge query error", [], "relation does not exist"],
] as const) {
  test(`position review: ${label} → 503 KNOWLEDGE_UNAVAILABLE, no AI, no Console call`, async () => {
    const { client, knowledgeFilters } = db([...rows], err);
    const net = stubFetch();
    let aiCalls = 0;
    try {
      const result = await handleManagePositions({
        db: client, traderId: "trader-a", userId: "user-a", barTime: 1, trigger: "POSITION_REVIEW",
        aiDecision: async () => { aiCalls += 1; return { decision: "HOLD" }; },
      });
      assert.equal(result.status, 503);
      assert.equal((result.body as { error?: string }).error, "KNOWLEDGE_UNAVAILABLE");
      assert.equal(aiCalls, 0);
      assert.deepEqual(knowledgeFilters.slice(0, 2), [["ai_trader_id", "trader-a"], ["user_id", "user-a"]]);
      assert.equal(net.urls.some(u => u.includes("console")), false, net.urls.join(","));
    } finally {
      net.restore();
    }
  });
}

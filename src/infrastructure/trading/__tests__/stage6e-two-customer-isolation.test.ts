import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ConnectionMarketStore } from "../../../../gateway/src/connectionMarketStore";

type Tick = { symbol: string; bid: number; ask: number };
type Bar = { time: number; close: number };

test("two customers keep same-symbol ticks, bars, latest prices and M5 dedup independent", () => {
  const store = new ConnectionMarketStore<Tick, Bar>();
  store.setTick("connection-a", { symbol: "GOLD", bid: 4101.11, ask: 4101.21 });
  store.setTick("connection-b", { symbol: "GOLD", bid: 4202.22, ask: 4202.32 });
  assert.equal(store.getTick("connection-a", "GOLD")?.bid, 4101.11);
  assert.equal(store.getTick("connection-b", "GOLD")?.bid, 4202.22);
  assert.equal(store.getTick("unknown", "GOLD"), undefined);

  store.setTick("connection-a", { symbol: "GOLD", bid: 4105.11, ask: 4105.21 });
  assert.equal(store.getTick("connection-b", "GOLD")?.bid, 4202.22);
  store.setTick("connection-b", { symbol: "GOLD", bid: 4210.22, ask: 4210.32 });
  assert.equal(store.getTick("connection-a", "GOLD")?.bid, 4105.11);

  store.upsertBars("connection-a", "GOLD", "M5", [{ time: 1, close: 4101 }], 100);
  store.upsertBars("connection-b", "GOLD", "M5", [{ time: 1, close: 4201 }], 100);
  store.upsertBars("connection-a", "GOLD", "H1", [{ time: 1, close: 4150 }], 100);
  store.upsertBars("connection-b", "GOLD", "H1", [{ time: 1, close: 4250 }], 100);
  assert.equal(store.getBars("connection-a", "GOLD", "M5")[0].close, 4101);
  assert.equal(store.getBars("connection-b", "GOLD", "M5")[0].close, 4201);
  assert.equal(store.getBars("connection-a", "GOLD", "H1")[0].close, 4150);
  assert.equal(store.getBars("connection-b", "GOLD", "H1")[0].close, 4250);
  assert.deepEqual(store.getBars("missing", "GOLD", "M5"), []);

  store.setLastM5Time("connection-a", "GOLD", 123);
  store.setLastM5Time("connection-b", "GOLD", 123);
  assert.equal(store.getLastM5Time("connection-a", "GOLD"), 123);
  assert.equal(store.getLastM5Time("connection-b", "GOLD"), 123);
});

test("production paths retain explicit owner/connection boundaries", () => {
  const gateway = fs.readFileSync("gateway/src/index.ts", "utf8");
  const client = fs.readFileSync("src/infrastructure/connection/GatewayClient.ts", "utf8");
  const ticks = fs.readFileSync("src/app/api/live/connection/ticks/route.ts", "utf8");
  const bars = fs.readFileSync("src/app/api/live/connection/bars/route.ts", "utf8");
  const history = fs.readFileSync("src/app/api/mt5/history/route.ts", "utf8");
  assert.match(gateway, /broadcastToConnection\(connectionId/);
  assert.doesNotMatch(gateway, /broadcast\(\{\s*type:\s*["'`](?:TICK|BAR|ACCOUNT|POSITIONS|ORDERS|EXECUTION_RESULT|EA_CONNECTED|HEARTBEAT|DISCONNECT|SYMBOLS|INDICATORS)/);
  assert.match(client, /ws-token/);
  assert.match(client, /accessToken/);
  assert.match(ticks, /connection_id/);
  assert.match(bars, /connection_id/);
  assert.match(history, /\.eq\("user_id", user\.id\)/);
  assert.match(history, /\.eq\("connection_id", connection\.id\)/);
  assert.doesNotMatch(history, /\/history\//);
  assert.doesNotMatch(history, /getRecentTrades|upsertTrades/);
});

test("snapshot and execution production stores use connection and owner correlation", () => {
  const execution = fs.readFileSync("gateway/src/executionStore.ts", "utf8");
  assert.match(execution, /connection_id/);
  assert.match(execution, /user_id/);
  assert.match(execution, /position_ticket/);
  const reconciliation = fs.readFileSync("gateway/src/reconciliation-snapshot.test.ts", "utf8");
  assert.match(reconciliation, /connection_id/);
  assert.match(reconciliation, /owner mismatch/);
});

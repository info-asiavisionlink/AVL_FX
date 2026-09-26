import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type Row = { connection_id: string | null; symbol: string; timeframe: string; time_utc: string; close: number };

function keyedUpsert(rows: Row[], row: Row): void {
  const index = rows.findIndex((candidate) => candidate.connection_id === row.connection_id
    && candidate.symbol === row.symbol && candidate.timeframe === row.timeframe && candidate.time_utc === row.time_utc);
  if (index === -1) rows.push(row); else rows[index] = row;
}

test("same GOLD/timeframe/timestamp can coexist for two connections", () => {
  const rows: Row[] = [];
  const timestamp = "2026-09-24T00:00:00.000Z";
  keyedUpsert(rows, { connection_id: "connection-a", symbol: "GOLD", timeframe: "M5", time_utc: timestamp, close: 4101 });
  keyedUpsert(rows, { connection_id: "connection-b", symbol: "GOLD", timeframe: "M5", time_utc: timestamp, close: 4201 });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.connection_id === "connection-a")?.close, 4101);
  assert.equal(rows.find((row) => row.connection_id === "connection-b")?.close, 4201);
  keyedUpsert(rows, { connection_id: "connection-a", symbol: "GOLD", timeframe: "M5", time_utc: timestamp, close: 4105 });
  assert.equal(rows.find((row) => row.connection_id === "connection-b")?.close, 4201);
});

test("legacy NULL rows are never a customer scoped read result", () => {
  const rows: Row[] = [{ connection_id: null, symbol: "GOLD", timeframe: "M5", time_utc: "2026-09-24T00:00:00.000Z", close: 9999 }];
  const scoped = rows.filter((row) => row.connection_id === "connection-a" && row.symbol === "GOLD" && row.timeframe === "M5");
  assert.deepEqual(scoped, []);
});

test("migration, writer, restore, and datafeed are connection-scoped", () => {
  const migration = fs.readFileSync("supabase/migrations/034_bar_data_connection_isolation.sql", "utf8");
  const store = fs.readFileSync("gateway/src/barDataStore.ts", "utf8");
  const gateway = fs.readFileSync("gateway/src/index.ts", "utf8");
  const datafeed = fs.readFileSync("src/app/api/datafeed/route.ts", "utf8");
  assert.match(migration, /connection_id UUID/);
  assert.match(migration, /bar_data_connection_id_fkey/);
  assert.match(migration, /UNIQUE \(connection_id, symbol, timeframe, time_utc\)/);
  assert.match(migration, /bar_data_select_owned_connection/);
  assert.match(store, /connection_id,symbol,timeframe,time_utc/);
  assert.match(store, /BAR_DATA_CONNECTION_ID_REQUIRED/);
  assert.match(gateway, /connection_id=not\.is\.null/);
  assert.match(gateway, /connectionMarketStore\.upsertBars\(connectionId/);
  assert.match(datafeed, /getOwnedConnection/);
  assert.match(datafeed, /\.eq\("connection_id", owned\.connectionId\)/);
  assert.doesNotMatch(datafeed, /\.eq\("connection_id", null\)/);
});

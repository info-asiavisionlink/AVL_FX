import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConnectionMarketStore,
  connectionBarKey,
  connectionTickKey,
} from "./connectionMarketStore";

type Tick = { symbol: string; bid: number };
type Bar = { time: number; close: number };

function bar(time: number, close: number): Bar {
  return { time, close };
}

test("connection market store isolates same-symbol ticks and updates", () => {
  const store = new ConnectionMarketStore<Tick, Bar>();
  store.setTick("A", { symbol: "GOLD", bid: 2600 });
  store.setTick("B", { symbol: "GOLD", bid: 2700 });

  assert.equal(store.getTick("A", "GOLD")?.bid, 2600);
  assert.equal(store.getTick("B", "GOLD")?.bid, 2700);
  assert.equal(store.getTick("C", "GOLD"), undefined);

  store.setTick("A", { symbol: "GOLD", bid: 2605 });
  assert.equal(store.getTick("A", "GOLD")?.bid, 2605);
  assert.equal(store.getTick("B", "GOLD")?.bid, 2700);
});

test("connection market store isolates same-symbol bars and timeframes", () => {
  const store = new ConnectionMarketStore<Tick, Bar>();
  store.upsertBars("A", "GOLD", "M5", [bar(100, 2601)], 100);
  store.upsertBars("B", "GOLD", "M5", [bar(100, 2701)], 100);
  store.upsertBars("A", "GOLD", "H1", [bar(100, 2610)], 100);

  assert.deepEqual(store.getBars("A", "GOLD", "M5"), [bar(100, 2601)]);
  assert.deepEqual(store.getBars("B", "GOLD", "M5"), [bar(100, 2701)]);
  assert.deepEqual(store.getBars("A", "GOLD", "H1"), [bar(100, 2610)]);
  assert.deepEqual(store.getBars("C", "GOLD", "M5"), []);
});

test("missing scoped market data never falls back to another connection", () => {
  const store = new ConnectionMarketStore<Tick, Bar>();
  store.setTick("A", { symbol: "GOLD", bid: 2600 });
  store.upsertBars("A", "GOLD", "M5", [bar(100, 2601)], 100);

  assert.equal(store.getTick("B", "GOLD"), undefined);
  assert.deepEqual(store.getBars("B", "GOLD", "M5"), []);
});

test("M5 deduplication state is independently keyed by connection and symbol", () => {
  const store = new ConnectionMarketStore<Tick, Bar>();
  store.setLastM5Time("A", "GOLD", 100);
  store.setLastM5Time("B", "GOLD", 200);

  assert.equal(store.getLastM5Time("A", "GOLD"), 100);
  assert.equal(store.getLastM5Time("B", "GOLD"), 200);
  assert.equal(store.getLastM5Time("C", "GOLD"), undefined);
});

test("canonical keys include connection, symbol, and timeframe", () => {
  assert.equal(connectionTickKey("A", "GOLD"), "A:GOLD");
  assert.equal(connectionBarKey("A", "GOLD", "M5"), "A:GOLD:M5");
});

test("production Gateway bridge ingestion and scoped reads use the store", () => {
  const source = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
  const ticks = source.slice(source.indexOf('app.post("/bridge/ticks"'));
  const bars = source.slice(source.indexOf('app.post("/bridge/bars"'));
  const scopedTickRead = source.slice(source.indexOf('app.get("/connections/:connectionId/tick/:symbol"'));
  const scopedBarRead = source.slice(source.indexOf('app.get("/connections/:connectionId/bars/:symbol/:timeframe"'));

  assert.match(ticks.slice(0, 500), /connectionMarketStore\.setTick/);
  assert.match(bars.slice(0, 900), /connectionMarketStore\.upsertBars/);
  assert.match(scopedTickRead.slice(0, 900), /connectionMarketStore\.getTick/);
  assert.match(scopedBarRead.slice(0, 600), /connectionMarketStore\.getBars/);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertPositions, type BridgePosition } from "./executionStore";

type Row = { connection_id: string; user_id: string; position_ticket: number; status: "OPEN" | "CLOSED"; symbol?: string };
type Result = { data: unknown; error: { message: string } | null };
interface Query {
  update(values: Record<string, unknown>): Query; upsert(values: Row[], options: Record<string, unknown>): Query;
  select(fields?: string): Query; eq(field: string, value: unknown): Query; in(field: string, values: unknown[]): Query;
  then(resolve: (value: Result) => void, reject?: (reason: unknown) => void): void;
}

const position = (ticket: number, symbol = "GOLD#"): BridgePosition => ({
  positionTicket: ticket, symbol, direction: "BUY", volume: 0.1, openPrice: 3300,
  currentPrice: 3310, stopLoss: 3290, takeProfit: 3400, unrealizedPnl: 1,
  commission: 0, swap: 0, magicNumber: 1, openedAt: "2026-09-24T00:00:00.000Z",
});

function db(initial: Row[], failures: { upsert?: boolean; read?: boolean; close?: boolean } = {}) {
  const rows = initial;
  const client = {
    from(table: string) {
      let op = "select"; let values: Record<string, unknown> = {}; const filters: Record<string, unknown> = {}; let inTickets: unknown[] | undefined;
      const query: Query = {
        update(next) { op = "update"; values = next; return query; },
        upsert(next) { op = "upsert"; values = { rows: next }; return query; },
        select() { return query; },
        eq(field, value) { filters[field] = value; return query; },
        in(field, valuesIn) { if (field === "position_ticket") inTickets = valuesIn; return query; },
        then(resolve, reject) {
          try {
            if (table !== "live_positions") { resolve({ data: [], error: null }); return; }
            const matches = rows.filter(row => Object.entries(filters).every(([field, value]) => row[field as keyof Row] === value) && (!inTickets || inTickets.includes(row.position_ticket)));
            if (op === "upsert") {
              if (failures.upsert) { resolve({ data: null, error: { message: "upsert failed" } }); return; }
              const incoming = values.rows as Row[];
              for (const item of incoming) { const found = rows.find(row => row.connection_id === item.connection_id && row.position_ticket === item.position_ticket); if (found) Object.assign(found, item); else rows.push({ ...item }); }
              resolve({ data: incoming, error: null }); return;
            }
            if (op === "update") {
              if (failures.close) { resolve({ data: null, error: { message: "close failed" } }); return; }
              for (const row of matches) Object.assign(row, values);
              resolve({ data: matches, error: null }); return;
            }
            if (failures.read) { resolve({ data: null, error: { message: "read failed" } }); return; }
            resolve({ data: matches.map(row => ({ position_ticket: row.position_ticket })), error: null });
          } catch (error) { if (reject) reject(error); }
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, rows };
}

test("complete snapshots close missing positions and preserve present/new positions", async () => {
  const state = db([
    { connection_id: "a", user_id: "u", position_ticket: 1001, status: "OPEN" },
    { connection_id: "a", user_id: "u", position_ticket: 1002, status: "OPEN" },
    { connection_id: "b", user_id: "v", position_ticket: 1001, status: "OPEN" },
  ]);
  await upsertPositions("a", "u", [position(1001), position(1003)], state.client, true);
  assert.equal(state.rows.find(row => row.connection_id === "a" && row.position_ticket === 1001)?.status, "OPEN");
  assert.equal(state.rows.find(row => row.connection_id === "a" && row.position_ticket === 1002)?.status, "CLOSED");
  assert.equal(state.rows.find(row => row.connection_id === "a" && row.position_ticket === 1003)?.status, "OPEN");
  assert.equal(state.rows.find(row => row.connection_id === "b" && row.position_ticket === 1001)?.status, "OPEN");
});

test("empty complete snapshot closes only the same owner's connection", async () => {
  const state = db([{ connection_id: "a", user_id: "u", position_ticket: 1001, status: "OPEN" }, { connection_id: "b", user_id: "v", position_ticket: 2001, status: "OPEN" }]);
  await upsertPositions("a", "u", [], state.client, true);
  assert.equal(state.rows[0].status, "CLOSED"); assert.equal(state.rows[1].status, "OPEN");
});

test("unknown/partial snapshots do not mass-close missing positions", async () => {
  const state = db([{ connection_id: "a", user_id: "u", position_ticket: 1001, status: "OPEN" }, { connection_id: "a", user_id: "u", position_ticket: 1002, status: "OPEN" }]);
  await upsertPositions("a", "u", [position(1001)], state.client, false);
  assert.equal(state.rows.find(row => row.position_ticket === 1002)?.status, "OPEN");
  await upsertPositions("a", "u", [], state.client, false);
  assert.equal(state.rows.every(row => row.status === "OPEN"), true);
});

test("invalid items and persistence failures fail closed before missing close", async () => {
  const invalid = db([{ connection_id: "a", user_id: "u", position_ticket: 1001, status: "OPEN" }]);
  await assert.rejects(() => upsertPositions("a", "u", [{ ...position(1002), positionTicket: 0 }], invalid.client, true), /POSITION_SNAPSHOT_INVALID_ITEM/);
  assert.equal(invalid.rows[0].status, "OPEN");
  const failedUpsert = db([{ connection_id: "a", user_id: "u", position_ticket: 1001, status: "OPEN" }], { upsert: true });
  await assert.rejects(() => upsertPositions("a", "u", [position(1002)], failedUpsert.client, true), /POSITION_RECONCILIATION_UPSERT_FAILED/);
  assert.equal(failedUpsert.rows[0].status, "OPEN");
});

test("read and close failures are explicit; already closed rows remain closed", async () => {
  const readFailed = db([{ connection_id: "a", user_id: "u", position_ticket: 1001, status: "OPEN" }], { read: true });
  await assert.rejects(() => upsertPositions("a", "u", [position(1002)], readFailed.client, true), /POSITION_RECONCILIATION_READ_FAILED/);
  const closeFailed = db([{ connection_id: "a", user_id: "u", position_ticket: 1001, status: "OPEN" }], { close: true });
  await assert.rejects(() => upsertPositions("a", "u", [position(1002)], closeFailed.client, true), /POSITION_RECONCILIATION_CLOSE_FAILED/);
  const closed = db([{ connection_id: "a", user_id: "u", position_ticket: 1001, status: "CLOSED" }]);
  await upsertPositions("a", "u", [], closed.client, true);
  assert.equal(closed.rows[0].status, "CLOSED");
});

test("EA position payload explicitly identifies an authoritative complete snapshot", () => {
  const ea = fs.readFileSync("../ea/AVL_FX_Bridge.mq5", "utf8");
  assert.match(ea, /snapshot_complete\\\":true/);
  assert.match(ea, /PositionsTotal\(\)/);
});

test("owner mismatch cannot close another owner's rows", async () => {
  const state = db([{ connection_id: "a", user_id: "owner-a", position_ticket: 1001, status: "OPEN" }]);
  await upsertPositions("a", "owner-b", [], state.client, true);
  assert.equal(state.rows[0].status, "OPEN");
});

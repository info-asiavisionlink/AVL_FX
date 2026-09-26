import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { submitCommandResult, type BridgeResultInput } from "./executionStore";

type Command = {
  command_id: string; action: string; ai_position_id: string; user_id: string;
  connection_id: string; stop_loss: number | null; take_profit: number | null;
  created_at: string; status: string;
};
type Position = { id: string; user_id: string; connection_id: string; status: string; stop_loss: number | null; take_profit: number | null };
type QueryResult = { data: unknown; error: { message: string } | null };
interface Query {
  select(fields?: string): Query;
  update(values: Record<string, unknown>): Query;
  eq(field: string, value: unknown): Query;
  in(field: string, values: unknown[]): Query;
  order(field: string, options: { ascending: boolean }): Query;
  limit(value: number): Query;
  maybeSingle(): Query;
  then(onfulfilled: (value: QueryResult) => void, onrejected?: (reason: unknown) => void): void;
}

function fakeDb(commands: Command[], positions: Position[], failPositionSync = false): SupabaseClient {
  return {
    from(table: string) {
      let op: "select" | "update" = "select";
      let values: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      let inStatus: unknown[] | undefined;
      let ordered = false;
      const q: Query = {
        update(next) { op = "update"; values = next; return q; },
        select() { return q; },
        eq(field, value) { filters[field] = value; return q; },
        in(field, valuesIn) { if (field === "status") inStatus = valuesIn; return q; },
        order() { ordered = true; return q; },
        limit() { return q; },
        maybeSingle() { return q; },
        then(resolve, reject) {
          const finish = (value: QueryResult) => { resolve(value); };
          try {
            const matches = (rows: Array<Command | Position>) => rows.filter(row =>
              Object.entries(filters).every(([field, value]) => (row as Record<string, unknown>)[field] === value)
              && (!inStatus || inStatus.includes((row as Record<string, unknown>).status)));
            if (table === "execution_commands") {
              if (op === "update") {
                const row = matches(commands)[0];
                if (!row) { finish({ data: [], error: null }); return; }
                Object.assign(row, values);
                finish({ data: [row], error: null }); return;
              }
              let rows = matches(commands);
              if (ordered) rows = [...rows].sort((a, b) => (a as Command).created_at.localeCompare((b as Command).created_at)).reverse();
              finish({ data: rows.length ? rows[0] : null, error: null }); return;
            }
            if (table === "ai_positions") {
              if (op === "update") {
                const row = matches(positions)[0];
                if (!row) { finish({ data: [], error: null }); return; }
                if (failPositionSync) { finish({ data: null, error: { message: "sync failed" } }); return; }
                Object.assign(row, values);
                finish({ data: [row], error: null }); return;
              }
              finish({ data: positions[0] ?? null, error: null }); return;
            }
            finish({ data: null, error: null });
          } catch (error) { if (reject) reject(error); }
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const result = (commandId: string, success = true): BridgeResultInput => ({
  commandId, success, status: success ? "FILLED" : "FAILED", retcode: 0,
  orderTicket: null, dealTicket: null, positionTicket: 7001, requestedPrice: null,
  executionPrice: null, requestedVolume: 0.1, executedVolume: 0.1,
  stopLoss: null, takeProfit: null, brokerTime: "2026-09-24T00:00:00.000Z",
  errorCode: success ? null : 100, errorMessage: success ? null : "rejected",
});

function fixture(action: "MODIFY_SL" | "MODIFY_TP", commandId = "c1", createdAt = "2026-09-24T00:00:00.000Z") {
  const command: Command = { command_id: commandId, action, ai_position_id: "p1", user_id: "u1", connection_id: "conn1", stop_loss: action === "MODIFY_SL" ? 3320 : 3300, take_profit: action === "MODIFY_TP" ? 3450 : 3400, created_at: createdAt, status: "CLAIMED" };
  const position: Position = { id: "p1", user_id: "u1", connection_id: "conn1", status: "OPEN", stop_loss: 3300, take_profit: 3400 };
  return { command, position };
}

test("successful MODIFY_SL/TP mirror only the confirmed protection value", async () => {
  for (const action of ["MODIFY_SL", "MODIFY_TP"] as const) {
    const { command, position } = fixture(action);
    await submitCommandResult(result(command.command_id), "conn1", fakeDb([command], [position]));
    assert.equal(position.stop_loss, action === "MODIFY_SL" ? 3320 : 3300);
    assert.equal(position.take_profit, action === "MODIFY_TP" ? 3450 : 3400);
    assert.equal(position.status, "OPEN");
  }
});

test("failed and closed/pending modifications do not change the mirror", async () => {
  const failed = fixture("MODIFY_SL");
  await submitCommandResult(result(failed.command.command_id, false), "conn1", fakeDb([failed.command], [failed.position]));
  assert.equal(failed.position.stop_loss, 3300);
  const closed = fixture("MODIFY_SL"); closed.command.status = "CLAIMED"; closed.position.status = "CLOSED";
  await submitCommandResult(result(closed.command.command_id), "conn1", fakeDb([closed.command], [closed.position]));
  assert.equal(closed.position.stop_loss, 3300);
  const pending = fixture("MODIFY_SL"); pending.command.status = "PENDING";
  const pendingResult = await submitCommandResult(result(pending.command.command_id), "conn1", fakeDb([pending.command], [pending.position]));
  assert.equal(pendingResult.rowsAffected, 0);
  assert.equal(pending.position.stop_loss, 3300);
});

test("a stale older successful modification cannot roll back a newer one", async () => {
  const a = fixture("MODIFY_SL", "a", "2026-09-24T00:00:00.000Z");
  const b = fixture("MODIFY_SL", "b", "2026-09-24T00:01:00.000Z");
  b.command.stop_loss = 3330;
  const position = a.position;
  const db = fakeDb([a.command, b.command], [position]);
  await submitCommandResult(result("b"), "conn1", db);
  assert.equal(position.stop_loss, 3330);
  a.command.status = "CLAIMED";
  await submitCommandResult(result("a"), "conn1", db);
  assert.equal(position.stop_loss, 3330);
});

test("mirror sync failure is surfaced", async () => {
  const { command, position } = fixture("MODIFY_TP");
  await assert.rejects(() => submitCommandResult(result(command.command_id), "conn1", fakeDb([command], [position], true)), /MODIFY_POSITION_SYNC_FAILED/);
});

test("the next position context read observes broker-confirmed SL and TP", async () => {
  const sl = fixture("MODIFY_SL", "sl-next");
  const tp = fixture("MODIFY_TP", "tp-next");
  const commands = [sl.command, tp.command];
  const db = fakeDb(commands, [sl.position]);
  await submitCommandResult(result(sl.command.command_id), "conn1", db);
  await submitCommandResult(result(tp.command.command_id), "conn1", db);
  assert.equal(sl.position.stop_loss, 3320);
  assert.equal(sl.position.take_profit, 3450);
});

test("connection and owner scope prevents cross-customer mirror mutation", async () => {
  const { command, position } = fixture("MODIFY_SL");
  command.user_id = "customer-a";
  position.user_id = "customer-a";
  const resultForOtherConnection = await submitCommandResult(result(command.command_id), "customer-b-connection", fakeDb([command], [position]));
  assert.equal(resultForOtherConnection.rowsAffected, 0);
  assert.equal(position.stop_loss, 3300);
});

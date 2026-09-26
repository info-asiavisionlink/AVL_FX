import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionExecutionStore,
  processExecutionResult,
  reconcilePositionSnapshot,
  type BridgePosition,
  type BridgeResultInput,
  type ExecutionStore,
} from "./executionStore";

function fakeStore() {
  const calls = { result: 0, snapshot: 0, emptySnapshot: 0 };
  const store: ExecutionStore = {
    async submitCommandResult(result: BridgeResultInput, connectionId: string) {
      calls.result += 1;
      assert.equal(connectionId, "connection-a");
      assert.equal(result.status, "FILLED");
      return { rowsAffected: 1 };
    },
    async upsertPositions(connectionId: string, userId: string, positions: BridgePosition[]) {
      calls.snapshot += 1;
      assert.equal(connectionId, "connection-a");
      assert.equal(userId, "user-a");
      if (positions.length === 0) calls.emptySnapshot += 1;
    },
  };
  return { calls, store };
}

const filled: BridgeResultInput = {
  commandId: "command-a", success: true, status: "FILLED", retcode: 0,
  orderTicket: 11, dealTicket: 12, positionTicket: 13, requestedPrice: 100,
  executionPrice: 100.1, requestedVolume: 0.01, executedVolume: 0.01,
  stopLoss: 99, takeProfit: 102, brokerTime: "2026-09-23T00:00:00.000Z",
  errorCode: null, errorMessage: null,
};

test("Gateway result processor uses injected store for FILLED", async () => {
  const { calls, store } = fakeStore();
  const result = await processExecutionResult(filled, "connection-a", store);
  assert.deepEqual(result, { rowsAffected: 1 });
  assert.equal(calls.result, 1);
  assert.equal(typeof createProductionExecutionStore, "function");
});

test("Gateway reconciliation uses injected store, including complete empty snapshots", async () => {
  const { calls, store } = fakeStore();
  await reconcilePositionSnapshot("connection-a", "user-a", [{
    positionTicket: 13, symbol: "GOLD#", direction: "BUY", volume: 0.01,
    openPrice: 100, currentPrice: 100.2, stopLoss: 99, takeProfit: 102,
    unrealizedPnl: 0.2, commission: 0, swap: 0, magicNumber: 1,
    openedAt: "2026-09-23T00:00:00.000Z",
  }], store);
  await reconcilePositionSnapshot("connection-a", "user-a", [], store);
  assert.equal(calls.snapshot, 2);
  assert.equal(calls.emptySnapshot, 1);
});

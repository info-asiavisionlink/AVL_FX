import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateFavorableStopLossMove } from "@/lib/ai-trader/market-data-validator";
import { RuntimeService, type RuntimePosition, type RuntimeRepository, type RuntimeScenario } from "@/lib/ai-trader/runtime-service";

const allow = (newSl: number, currentSl: number, side: "BUY" | "SELL", tickSize?: number) =>
  validateFavorableStopLossMove(newSl, currentSl, side, 2, tickSize).valid;

test("BUY and SELL favorable direction is deterministic", () => {
  assert.equal(allow(3320, 3300, "BUY"), true);
  assert.equal(allow(3280, 3300, "BUY"), false);
  assert.equal(allow(3380, 3400, "SELL"), true);
  assert.equal(allow(3420, 3400, "SELL"), false);
  assert.equal(allow(3300, 3300, "BUY"), true);
  assert.equal(allow(3400, 3400, "SELL"), true);
});

test("break-even and profit-lock values compare against current SL, not entry", () => {
  assert.equal(allow(3280, 3300, "BUY"), false);
  assert.equal(allow(3310, 3320, "BUY"), false);
  assert.equal(allow(3420, 3400, "SELL"), false);
  assert.equal(allow(3370, 3350, "SELL"), false);
});

test("invalid current/new SL values fail closed and tick normalization is stable", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(allow(value, 3300, "BUY"), false);
    assert.equal(allow(3320, value, "BUY"), false);
  }
  assert.equal(validateFavorableStopLossMove(3300.1000000001, 3300.1, "BUY", 2, 0.1).valid, true);
  assert.equal(validateFavorableStopLossMove(3300.14, 3300.1, "BUY", 2, 0.1).valid, true);
});

test("EA uses actual broker SL/type and guards before PositionModify", () => {
  const ea = fs.readFileSync("ea/AVL_ExecutionBridge.mq5", "utf8");
  assert.match(ea, /PositionGetDouble\(POSITION_SL\)/);
  assert.match(ea, /PositionGetInteger\(POSITION_TYPE\)/);
  assert.match(ea, /MODIFY_SL_CURRENT_BROKER_SL_INVALID/);
  assert.match(ea, /applyingSL < currentSL/);
  assert.match(ea, /applyingSL > currentSL/);
  const guard = ea.indexOf("MODIFY_SL_CURRENT_BROKER_SL_INVALID");
  const modify = ea.indexOf("g_Trade.PositionModify", guard);
  assert.ok(guard >= 0 && modify > guard);
  assert.match(ea, /Send_Failed\(commandId, "MODIFY_SL_BUY_DIRECTION_OR_STOPS_INVALID"\)/);
  assert.match(ea, /Send_Failed\(commandId, "MODIFY_SL_SELL_DIRECTION_OR_STOPS_INVALID"\)/);
});

class DirectionRepo implements RuntimeRepository {
  readonly claims = new Set<string>();
  readonly commands: string[] = [];
  async claim(key: string) { if (this.claims.has(key)) return false; this.claims.add(key); return true; }
  async transition() { return true; }
  async createScenario(input: { h1BarTime: number; state: string; traderId: string; userId: string; traderVersionId: string }) { return { id: "s1", version: 1, state: input.state, h1BarTime: input.h1BarTime } satisfies RuntimeScenario; }
  async createCommand(input: { action: string }) { this.commands.push(input.action); return { id: `c${this.commands.length}` }; }
  async openPosition(input: { commandId: string; traderId: string; scenarioId: string }) { return { id: "p1", commandId: input.commandId, traderId: input.traderId, scenarioId: input.scenarioId, status: "OPEN", side: "BUY", entryPrice: 3300, currentPrice: 3350, stopLoss: 3300, takeProfit: 3400, volume: 1 } satisfies RuntimePosition; }
  async closePosition() { return { outcomeId: "o1", closed: false }; }
  async saveLog() {}
}

test("production RuntimeService market boundary rejects an unfavorable BUY MODIFY_SL", async () => {
  const repo = new DirectionRepo();
  const service = new RuntimeService(repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "MODIFY_SL", newSl: 3280 }) }, { entry: async () => ({ approved: false }) }, {
    validEntry: () => false, validPosition: () => true, validateHardSl: () => true,
    validateModifySl: (position, value) => validateFavorableStopLossMove(typeof value === "number" ? value : null, position.stopLoss, position.side, 2).valid,
    validateModifyTp: () => true,
  });
  const position: RuntimePosition = { id: "p1", traderId: "t1", scenarioId: "s1", status: "OPEN", side: "BUY", entryPrice: 3300, currentPrice: 3350, stopLoss: 3300, takeProfit: 3400, volume: 1 };
  const result = await service.positionReview({ userId: "u1", traderId: "t1", traderVersionId: "v1", position, trigger: "SL_RECHECK", barTime: 1, knowledgeSnapshot: [] });
  assert.equal(result.commandId, undefined);
  assert.equal(repo.commands.length, 0);
});

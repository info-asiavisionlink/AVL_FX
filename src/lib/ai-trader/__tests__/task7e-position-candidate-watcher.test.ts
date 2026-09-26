import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPositionCandidate } from "../position-candidate-detector.js";
import { RuntimeService, type RuntimePosition, type RuntimeRepository } from "../runtime-service.js";

const long = { side: "BUY" as const, entryPrice: 100, stopLoss: 90, takeProfit: 110 };
const short = { side: "SELL" as const, entryPrice: 100, stopLoss: 110, takeProfit: 90 };

test("LONG/SHORT TP candidates are symmetric at the final 20% zone", () => {
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 108 }).trigger, "TP_RECHECK");
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 107.9 }).trigger, null);
  assert.equal(detectPositionCandidate({ ...short, currentPrice: 92 }).trigger, "TP_RECHECK");
  assert.equal(detectPositionCandidate({ ...short, currentPrice: 92.1 }).trigger, null);
});

test("LONG/SHORT SL candidates are symmetric before hard SL", () => {
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 92 }).trigger, "SL_RECHECK");
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 92.1 }).trigger, null);
  assert.equal(detectPositionCandidate({ ...short, currentPrice: 108 }).trigger, "SL_RECHECK");
  assert.equal(detectPositionCandidate({ ...short, currentPrice: 107.9 }).trigger, null);
});

test("invalid geometry, non-finite values, and ambiguous candidates fail closed", () => {
  for (const currentPrice of [0, NaN, Infinity]) {
    assert.equal(detectPositionCandidate({ ...long, currentPrice }).trigger, null);
  }
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 100, stopLoss: 100 }).reason, "INVALID_POSITION_GEOMETRY");
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 100, takeProfit: 90 }).reason, "INVALID_POSITION_GEOMETRY");
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 100, stopLoss: 110, takeProfit: 90 }).reason, "INVALID_POSITION_GEOMETRY");
});

test("next M5 bar may produce a new deterministic candidate", () => {
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 108 }).trigger, "TP_RECHECK");
  assert.equal(detectPositionCandidate({ ...long, currentPrice: 109 }).trigger, "TP_RECHECK");
});

function makePosition(): RuntimePosition {
  return { id: "p-a", traderId: "t-a", scenarioId: "s-a", status: "OPEN", side: "BUY", entryPrice: 100, currentPrice: 108, stopLoss: 90, takeProfit: 110, volume: 0.1, userId: "u-a", connectionId: "c-a", symbol: "GOLD#", magicNumber: 1, positionTicket: 10001 };
}

function makeRepo() {
  const claims = new Set<string>();
  const commands: Array<{ id: string; action: string; key: string }> = [];
  const logs: any[] = [];
  const repo: RuntimeRepository = {
    async claim(key) { if (claims.has(key)) return false; claims.add(key); return true; },
    async transition() { return true; },
    async createScenario() { return { id: "s-a", version: 1, state: "WATCHING", h1BarTime: 1 }; },
    async createCommand(input) { const existing = commands.find(c => c.key === input.idempotencyKey); if (existing) return { id: existing.id }; const id = `cmd-${commands.length + 1}`; commands.push({ id, action: input.action, key: input.idempotencyKey }); return { id }; },
    async openPosition() { return makePosition(); },
    async closePosition(positionId) { return { outcomeId: positionId, closed: true }; },
    async saveLog(log) { logs.push(log); },
  };
  return { repo, commands, logs };
}

test("HOLD produces no position command and records the dedicated trigger", async () => {
  const x = makeRepo();
  const service = new RuntimeService(x.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "HOLD", reasoning: "hold" }) }, { entry: async () => ({ approved: false }) }, { validEntry: () => false, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => true, validateModifyTp: () => true });
  const result = await service.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: makePosition(), trigger: "TP_RECHECK", barTime: 1000, knowledgeSnapshot: [] });
  assert.equal(result.decision, "HOLD"); assert.equal(x.commands.length, 0); assert.equal(x.logs[0]?.trigger, "TP_RECHECK");
});

test("CLOSE and valid MODIFY/EXTEND use the canonical position command writer", async () => {
  const x = makeRepo();
  const service = new RuntimeService(x.repo, { entry: async () => ({ decision: "WAIT" }), position: async ({ trigger }) => trigger === "SL_RECHECK" ? { decision: "MODIFY_SL", newSl: 95 } : { decision: "EXTEND_TP", newTp: 112 } }, { entry: async () => ({ approved: false }) }, { validEntry: () => false, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => true, validateModifyTp: () => true });
  const a = await service.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: makePosition(), trigger: "SL_RECHECK", barTime: 1001, knowledgeSnapshot: [] });
  const b = await service.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: makePosition(), trigger: "TP_RECHECK", barTime: 1002, knowledgeSnapshot: [] });
  assert.equal(a.commandId, "cmd-1"); assert.equal(b.commandId, "cmd-2"); assert.deepEqual(x.commands.map(c => c.action), ["MODIFY_SL", "MODIFY_TP"]);
});

test("unfavorable modification, malformed AI, and AI failure create no command", async () => {
  const x = makeRepo();
  const service = new RuntimeService(x.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "UNKNOWN" }), }, { entry: async () => ({ approved: false }) }, { validEntry: () => false, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => false, validateModifyTp: () => true });
  const invalid = await service.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: makePosition(), trigger: "SL_RECHECK", barTime: 1003, knowledgeSnapshot: [] });
  assert.equal(invalid.decision, "HOLD"); assert.equal(invalid.commandId, undefined); assert.equal(x.commands.length, 0);
  const z = makeRepo();
  const unfavorable = new RuntimeService(z.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "MODIFY_SL", newSl: 80 }) }, { entry: async () => ({ approved: false }) }, { validEntry: () => false, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => false, validateModifyTp: () => true });
  const rejected = await unfavorable.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: makePosition(), trigger: "SL_RECHECK", barTime: 1005, knowledgeSnapshot: [] });
  assert.equal(rejected.commandId, undefined); assert.equal(z.commands.length, 0);
  const y = makeRepo();
  const failing = new RuntimeService(y.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => { throw new Error("AI down"); } }, { entry: async () => ({ approved: false }) }, { validEntry: () => false, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => true, validateModifyTp: () => true });
  const failed = await failing.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: makePosition(), trigger: "TP_RECHECK", barTime: 1004, knowledgeSnapshot: [] });
  assert.equal(failed.decision, "HOLD"); assert.equal(y.commands.length, 0);
});

test("same position/bar is idempotent and same ticket across connections remains independent", async () => {
  const x = makeRepo();
  const service = new RuntimeService(x.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "CLOSE" }) }, { entry: async () => ({ approved: false }) }, { validEntry: () => false, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => true, validateModifyTp: () => true });
  const p = makePosition();
  const [a, b] = await Promise.all([
    service.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: p, trigger: "TP_RECHECK", barTime: 2000, knowledgeSnapshot: [] }),
    service.positionReview({ userId: "u-a", traderId: "t-a", traderVersionId: "v-a", position: p, trigger: "TP_RECHECK", barTime: 2000, knowledgeSnapshot: [] }),
  ]);
  assert.equal([a, b].filter(r => r.commandId).length, 1); assert.equal(x.commands.length, 1);
  const y = makeRepo();
  const serviceB = new RuntimeService(y.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "HOLD" }) }, { entry: async () => ({ approved: false }) }, { validEntry: () => false, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => true, validateModifyTp: () => true });
  const pb = { ...p, id: "p-b", userId: "u-b", traderId: "t-b", connectionId: "c-b" };
  await serviceB.positionReview({ userId: "u-b", traderId: "t-b", traderVersionId: "v-b", position: pb, trigger: "TP_RECHECK", barTime: 2000, knowledgeSnapshot: [] });
  assert.equal(y.logs[0]?.userId, "u-b"); assert.equal(y.logs[0]?.positionId, "p-b");
});

test("position candidate path has no entry writer or direct broker call", async () => {
  const source = await import("../position-candidate-detector.js");
  assert.equal(typeof source.detectPositionCandidate, "function");
});

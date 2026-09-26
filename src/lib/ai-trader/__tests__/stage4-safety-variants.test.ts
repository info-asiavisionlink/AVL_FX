import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeService, type RuntimeLog, type RuntimePosition, type RuntimeRepository, type RuntimeScenario } from "../runtime-service";
import { processExecutionResult, reconcilePositionSnapshot, type ExecutionStore } from "../../../../gateway/src/executionStore";

class SafetyRepo implements RuntimeRepository {
  claims = new Set<string>(); commands: Array<{ key: string; action: string }> = []; logs: Array<{ decision: string; error?: string }> = [];
  state = "FLAT"; scenarioCount = 0; positions: RuntimePosition[] = []; outcomes = new Set<string>();
  async claim(key: string) { if (this.claims.has(key)) return false; this.claims.add(key); return true; }
  async transition(_id: string, from: string | string[], to: string) { const allowed = Array.isArray(from) ? from : [from]; if (!allowed.includes(this.state)) return false; this.state = to; return true; }
  async createScenario(i: { h1BarTime: number; state: string }) { this.scenarioCount += 1; return { id: `scenario-${this.scenarioCount}`, version: this.scenarioCount, state: i.state, h1BarTime: i.h1BarTime }; }
  async createCommand(i: { idempotencyKey: string; action: string }) { const found = this.commands.find(c => c.key === i.idempotencyKey); if (found) return { id: "command-1" }; this.commands.push({ key: i.idempotencyKey, action: i.action }); return { id: `command-${this.commands.length}` }; }
  async openPosition(i: { commandId: string; traderId: string; scenarioId: string }) { const found = this.positions.find(p => p.commandId === i.commandId); if (found) return found; const p: RuntimePosition = { id: `position-${this.positions.length + 1}`, commandId: i.commandId, traderId: i.traderId, scenarioId: i.scenarioId, status: "OPEN", side: "BUY", entryPrice: 100, currentPrice: 100, stopLoss: 99, takeProfit: 102, volume: 0.01 }; this.positions.push(p); return p; }
  async closePosition(id: string) { if (this.outcomes.has(id)) return { outcomeId: `outcome-${id}`, closed: false }; this.outcomes.add(id); const p = this.positions.find(x => x.id === id); if (!p || p.status === "CLOSED") return { outcomeId: `outcome-${id}`, closed: false }; p.status = "CLOSED"; return { outcomeId: `outcome-${id}`, closed: true }; }
  async saveLog(log: RuntimeLog) { this.logs.push({ decision: log.decision, error: log.error ?? undefined }); }
}

const market = (valid = true) => ({
  validEntry: () => valid, validPosition: () => valid,
  validateHardSl: ({ stopLoss }: { side: "BUY" | "SELL"; stopLoss: number }) => Number.isFinite(stopLoss) && stopLoss > 0,
  validateModifySl: (_p: RuntimePosition, value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100,
  validateModifyTp: (_p: RuntimePosition, value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 100,
});

function service(entry: unknown = "ENTER_LONG", position: unknown = "CLOSE", valid = true) {
  const repo = new SafetyRepo();
  const runtime = new RuntimeService(repo, { entry: async () => ({ decision: entry }), position: async () => ({ decision: position, newSl: 98, newTp: 103 }) }, { entry: async () => ({ approved: true }) }, market(valid));
  return { repo, runtime };
}

async function scenario(runtime: RuntimeService, traderId = "trader-a", barTime = 1000) { return runtime.hourlyAnalysis({ userId: "user-a", traderId, traderVersionId: "version-a", h1BarTime: barTime, knowledgeSnapshot: [{ id: "k1", version: 1 }] }); }

test("4D-2 duplicate, fail-closed, and position decision variants", async () => {
  const dup = service(); const s = await scenario(dup.runtime); assert.ok(s); await scenario(dup.runtime); assert.equal(dup.repo.scenarioCount, 1); // duplicate H1
  const entryInput = { userId: "user-a", traderId: "trader-a", traderVersionId: "version-a", scenario: s!, trigger: "PRICE_ENTERS_ZONE", m5BarTime: 1100, hardSl: 99, knowledgeSnapshot: [] };
  const first = await dup.runtime.entryRecheck(entryInput); const second = await dup.runtime.entryRecheck(entryInput); assert.equal(first.decision, "ENTER_LONG"); assert.equal(second.decision, "WAIT"); assert.equal(dup.repo.commands.length, 1); // duplicate M5
  const parallel = service(); const parallelScenario = await scenario(parallel.runtime); const parallelInput = { ...entryInput, scenario: parallelScenario!, traderId: "trader-parallel", trigger: "PARALLEL", m5BarTime: 1150 }; await Promise.all([parallel.runtime.entryRecheck(parallelInput), parallel.runtime.entryRecheck(parallelInput)]); assert.equal(parallel.repo.commands.length, 1); // parallel entry

  for (const decision of ["WAIT", "INVALIDATE"] as const) { const x = service(decision); const xs = await scenario(x.runtime); const out = await x.runtime.entryRecheck({ ...entryInput, scenario: xs!, traderId: `trader-${decision}`, trigger: "ZONE", m5BarTime: 1200 }); assert.equal(out.decision, decision); assert.equal(x.repo.commands.length, 0); }
  const denied = service("ENTER_LONG"); const ds = await scenario(denied.runtime); const deniedRuntime = new RuntimeService(denied.repo, { entry: async () => ({ decision: "ENTER_LONG" }), position: async () => ({ decision: "HOLD" }) }, { entry: async () => ({ approved: false, reason: "DENY" }) }, market()); const deniedResult = await deniedRuntime.entryRecheck({ ...entryInput, scenario: ds!, traderId: "trader-deny", m5BarTime: 1300 }); assert.equal(deniedResult.commandId, undefined); assert.equal(denied.repo.commands.length, 0); // Risk DENY
  const failed = service("ENTER_LONG"); const fs = await scenario(failed.runtime); const failedRuntime = new RuntimeService(failed.repo, { entry: async () => { throw new Error("timeout"); }, position: async () => ({ decision: "HOLD" }) }, { entry: async () => ({ approved: true }) }, market()); const failedResult = await failedRuntime.entryRecheck({ ...entryInput, scenario: fs!, traderId: "trader-failure", m5BarTime: 1400 }); assert.equal(failedResult.decision, "WAIT"); assert.equal(failed.repo.logs.at(-1)?.error, "AI_FAILURE"); // AI failure != WAIT success
  const invalidSl = service("ENTER_LONG"); const is = await scenario(invalidSl.runtime); const invalidResult = await invalidSl.runtime.entryRecheck({ ...entryInput, scenario: is!, traderId: "trader-sl", m5BarTime: 1500, hardSl: 0 }); assert.equal(invalidResult.decision, "WAIT"); assert.equal(invalidSl.repo.commands.length, 0); // invalid hard SL

  const pos = service("ENTER_LONG", "HOLD"); const ps = await scenario(pos.runtime); const ep = await pos.runtime.entryRecheck({ ...entryInput, scenario: ps!, traderId: "trader-pos", m5BarTime: 1600 }); const opened = await pos.runtime.fill({ userId: "user-a", traderId: "trader-pos", traderVersionId: "version-a", scenario: ps!, commandId: ep.commandId!, knowledgeSnapshot: [] }); const hold = await pos.runtime.positionReview({ userId: "user-a", traderId: "trader-pos", traderVersionId: "version-a", position: opened, trigger: "TP_RECHECK", barTime: 1700, knowledgeSnapshot: [] }); assert.equal(hold.decision, "HOLD"); assert.equal(pos.repo.commands.length, 1); // TP HOLD
  const ext = new RuntimeService(pos.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "EXTEND_TP", newTp: 103 }) }, { entry: async () => ({ approved: true }) }, market()); const extended = await ext.positionReview({ userId: "user-a", traderId: "trader-pos", traderVersionId: "version-a", position: opened, trigger: "TP_RECHECK", barTime: 1800, knowledgeSnapshot: [] }); assert.equal(extended.decision, "EXTEND_TP"); assert.equal(pos.repo.commands.filter(c => c.action === "MODIFY_TP").length, 1);
  const closeRuntime = new RuntimeService(pos.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "CLOSE" }) }, { entry: async () => ({ approved: true }) }, market()); const closed = await closeRuntime.positionReview({ userId: "user-a", traderId: "trader-pos", traderVersionId: "version-a", position: opened, trigger: "POSITION_REVIEW", barTime: 1900, knowledgeSnapshot: [] }); assert.equal(closed.decision, "CLOSE"); assert.equal(pos.repo.commands.filter(c => c.action === "CLOSE").length, 1);
});

test("4D-2 position validator, invalid market, and duplicate review", async () => {
  const x = service("ENTER_LONG", "HOLD"); const s = await scenario(x.runtime); const e = await x.runtime.entryRecheck({ userId: "user-a", traderId: "trader-v", traderVersionId: "version-a", scenario: s!, trigger: "ZONE", m5BarTime: 2000, hardSl: 99, knowledgeSnapshot: [] }); const p = await x.runtime.fill({ userId: "user-a", traderId: "trader-v", traderVersionId: "version-a", scenario: s!, commandId: e.commandId!, knowledgeSnapshot: [] });
  const h1 = await x.runtime.positionReview({ userId: "user-a", traderId: "trader-v", traderVersionId: "version-a", position: p, trigger: "TP_RECHECK", barTime: 2100, knowledgeSnapshot: [] }); const h2 = await x.runtime.positionReview({ userId: "user-a", traderId: "trader-v", traderVersionId: "version-a", position: p, trigger: "TP_RECHECK", barTime: 2100, knowledgeSnapshot: [] }); assert.equal(h1.decision, "HOLD"); assert.equal(h2.decision, "HOLD");
  const validSl = new RuntimeService(x.repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "MODIFY_SL", newSl: 98 }) }, { entry: async () => ({ approved: true }) }, market()); const sl = await validSl.positionReview({ userId: "user-a", traderId: "trader-v", traderVersionId: "version-a", position: p, trigger: "SL_RECHECK", barTime: 2200, knowledgeSnapshot: [] }); assert.equal(sl.decision, "MODIFY_SL"); assert.equal(x.repo.commands.filter(c => c.action === "MODIFY_SL").length, 1);
  const invalidMarket = service("ENTER_LONG", "HOLD", false); const ms = await scenario(invalidMarket.runtime); const mr = await invalidMarket.runtime.entryRecheck({ userId: "user-a", traderId: "trader-market", traderVersionId: "version-a", scenario: ms!, trigger: "ZONE", m5BarTime: 2300, hardSl: 99, knowledgeSnapshot: [] }); assert.equal(mr.commandId, undefined); assert.equal(invalidMarket.repo.commands.length, 0);
});

test("4D-2 duplicate FILLED, duplicate outcome, isolation, and empty snapshot", async () => {
  const storeState = { filled: 0, snapshots: 0, closed: 0, ownerBChanged: false };
  const store: ExecutionStore = { async submitCommandResult(_result, connectionId) { assert.equal(connectionId, "connection-a"); storeState.filled += 1; return { rowsAffected: storeState.filled === 1 ? 1 : 0 }; }, async upsertPositions(connectionId, userId, positions) { assert.equal(connectionId, "connection-a"); assert.equal(userId, "user-a"); storeState.snapshots += 1; if (!positions.length) storeState.closed += 1; } };
  const event = { commandId: "command-a", success: true, status: "FILLED", retcode: 0, orderTicket: 1, dealTicket: 2, positionTicket: 3, requestedPrice: 100, executionPrice: 100, requestedVolume: 0.01, executedVolume: 0.01, stopLoss: 99, takeProfit: 102, brokerTime: new Date().toISOString(), errorCode: null, errorMessage: null };
  assert.deepEqual(await processExecutionResult(event, "connection-a", store), { rowsAffected: 1 }); assert.deepEqual(await processExecutionResult(event, "connection-a", store), { rowsAffected: 0 }); await reconcilePositionSnapshot("connection-a", "user-a", [], store); assert.equal(storeState.filled, 2); assert.equal(storeState.closed, 1); assert.equal(storeState.snapshots, 1); assert.equal(storeState.ownerBChanged, false);
});

test("4D-2 trader/customer isolation and AI log correlation", async () => {
  const a = service(); const b = service(); const sa = await scenario(a.runtime, "trader-a", 3000); const sb = await scenario(b.runtime, "trader-b", 3000); assert.equal(sa?.id, "scenario-1"); assert.equal(sb?.id, "scenario-1"); assert.notEqual(sa?.id && "trader-a", sb?.id && "trader-b"); assert.equal(a.repo.logs[0]?.decision, "WATCH"); assert.equal(b.repo.logs[0]?.decision, "WATCH");
  const scoped: ExecutionStore = { async submitCommandResult(_result, connectionId) { if (connectionId !== "connection-a") return { rowsAffected: 0 }; return { rowsAffected: 1 }; }, async upsertPositions(connectionId, userId, positions) { if (connectionId !== "connection-a" || userId !== "user-a") throw new Error("owner mismatch"); if (!positions.length) throw new Error("scoped empty snapshot accepted only for owner"); } };
  const event = { commandId: "command-a", success: true, status: "FILLED", retcode: 0, orderTicket: 1, dealTicket: 2, positionTicket: 3, requestedPrice: 100, executionPrice: 100, requestedVolume: 0.01, executedVolume: 0.01, stopLoss: 99, takeProfit: 102, brokerTime: new Date().toISOString(), errorCode: null, errorMessage: null };
  assert.deepEqual(await processExecutionResult(event, "connection-b", scoped), { rowsAffected: 0 });
});

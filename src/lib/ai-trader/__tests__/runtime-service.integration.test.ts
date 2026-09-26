import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeService, type RuntimeRepository, type RuntimePosition, type RuntimeScenario } from "../runtime-service";

class MemoryRepo implements RuntimeRepository {
  claims = new Set<string>(); commands: Array<{ id: string; key: string; action: string }> = [];
  scenarios: RuntimeScenario[] = []; positions: RuntimePosition[] = []; logs: any[] = []; state = "FLAT"; outcomes = new Set<string>();
  async claim(key: string) { if (this.claims.has(key)) return false; this.claims.add(key); return true; }
  async transition(_id: string, from: any, to: any) { const allowed = Array.isArray(from) ? from : [from]; if (!allowed.includes(this.state) && !(to === "WATCHING_ENTRY" && this.state === "FLAT")) return false; this.state = to; return true; }
  async createScenario(i: any) { const s = { id: `s${this.scenarios.length + 1}`, version: this.scenarios.length + 1, state: i.state, h1BarTime: i.h1BarTime }; this.scenarios.push(s); return s; }
  async createCommand(i: any) { const existing = this.commands.find(c => c.key === i.idempotencyKey); if (existing) return { id: existing.id }; const c = { id: `c${this.commands.length + 1}`, key: i.idempotencyKey, action: i.action }; this.commands.push(c); return { id: c.id }; }
  async openPosition(i: any) { const existing = this.positions.find(p => p.commandId === i.commandId); if (existing) return existing; const p: RuntimePosition = { id: `p${this.positions.length + 1}`, traderId: i.traderId, scenarioId: i.scenarioId, commandId: i.commandId, status: "OPEN", side: "BUY", entryPrice: 100, stopLoss: 99, takeProfit: 102, volume: 1 }; this.positions.push(p); return p; }
  async closePosition(id: string) { if (this.outcomes.has(id)) return { outcomeId: `o-${id}`, closed: false }; this.outcomes.add(id); const p = this.positions.find(x => x.id === id); if (!p || p.status === "CLOSED") return { outcomeId: `o-${id}`, closed: false }; p.status = "CLOSED"; return { outcomeId: `o-${id}`, closed: true }; }
  async saveLog(log: any) { this.logs.push(log); }
}

const market = (valid = true) => ({
  validEntry: () => valid,
  validPosition: () => valid,
  validateHardSl: ({ stopLoss }: { side: "BUY" | "SELL"; stopLoss: number }) => Number.isFinite(stopLoss) && stopLoss > 0,
  validateModifySl: (_p: RuntimePosition, v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0,
  validateModifyTp: (_p: RuntimePosition, v: unknown) => typeof v === "number" && Number.isFinite(v) && (v as number) > 0,
});

function make(aiEntry: unknown = "ENTER_LONG", aiPosition: unknown = "CLOSE", m = market()) {
  const repo = new MemoryRepo();
  const service = new RuntimeService(repo, {
    entry: async () => ({ decision: aiEntry, reasoning: "test" }),
    position: async ({ trigger }) => ({ decision: trigger === "TP_RECHECK" ? "EXTEND_TP" : aiPosition, newTp: 103, newSl: 101, reasoning: "test" }),
  }, { entry: async () => ({ approved: true }), }, m);
  return { repo, service };
}

async function setup(service: RuntimeService) {
  return service.hourlyAnalysis({ userId: "u1", traderId: "t1", traderVersionId: "v1", h1BarTime: 1000 });
}

test("primary lifecycle: H1 → entry → fill → TP extend → close → outcome/log", async () => {
  const { repo, service } = make("ENTER_LONG", "CLOSE"); const scenario = await setup(service); assert.ok(scenario);
  const entry = await service.entryRecheck({ userId: "u1", traderId: "t1", traderVersionId: "v1", scenario: scenario!, trigger: "PRICE_ENTERS_ZONE", m5BarTime: 1100, hardSl: 99, knowledgeSnapshot: [{ id: "k1", version: 1 }] });
  assert.equal(entry.decision, "ENTER_LONG"); assert.equal(repo.commands.length, 1);
  const pos = await service.fill({ userId: "u1", traderId: "t1", traderVersionId: "v1", scenario: scenario!, commandId: entry.commandId!, knowledgeSnapshot: [] });
  const extend = await service.positionReview({ userId: "u1", traderId: "t1", traderVersionId: "v1", position: pos, trigger: "TP_RECHECK", barTime: 1200, knowledgeSnapshot: [] });
  assert.equal(extend.decision, "EXTEND_TP"); assert.equal(repo.commands.filter(c => c.action === "MODIFY_TP").length, 1);
  const close = await service.positionReview({ userId: "u1", traderId: "t1", traderVersionId: "v1", position: pos, trigger: "POSITION_REVIEW", barTime: 1300, knowledgeSnapshot: [] });
  assert.equal(close.decision, "CLOSE"); await service.close({ traderId: "t1", positionId: pos.id, reason: "AI_CLOSE" });
  await service.close({ traderId: "t1", positionId: pos.id, reason: "DUPLICATE" });
  assert.equal(repo.positions[0].status, "CLOSED"); assert.equal(repo.outcomes.size, 1); assert.ok(repo.logs.some(l => l.trigger === "HOURLY_ANALYSIS"));
});

test("WAIT, INVALIDATE, Risk DENY, AI failure, and Knowledge/market failure create no entry command", async () => {
  for (const decision of ["WAIT", "INVALIDATE", "BAD"] as const) {
    const { repo, service } = make(decision); const s = await setup(service); const r = await service.entryRecheck({ userId: "u", traderId: "t", traderVersionId: "v", scenario: s!, trigger: "ZONE", m5BarTime: 1, hardSl: 99, knowledgeSnapshot: [] });
    assert.notEqual(r.decision, "ENTER_LONG"); assert.equal(repo.commands.length, 0);
  }
  const riskRepo = new MemoryRepo(); const risk = new RuntimeService(riskRepo, { entry: async () => ({ decision: "ENTER_LONG" }), position: async () => ({ decision: "HOLD" }) }, { entry: async () => ({ approved: false, reason: "DENY" }) }, market()); const s = await risk.hourlyAnalysis({ userId: "u", traderId: "t", traderVersionId: "v", h1BarTime: 2 }); await risk.entryRecheck({ userId: "u", traderId: "t", traderVersionId: "v", scenario: s!, trigger: "ZONE", m5BarTime: 2, hardSl: 99, knowledgeSnapshot: [] }); assert.equal(riskRepo.commands.length, 0);
  const bad = make("ENTER_LONG", "HOLD", market(false)); const bs = await setup(bad.service); await bad.service.entryRecheck({ userId: "u", traderId: "t", traderVersionId: "v", scenario: bs!, trigger: "ZONE", m5BarTime: 3, hardSl: 99, knowledgeSnapshot: [] }); assert.equal(bad.repo.commands.length, 0);
});

test("duplicate M5, duplicate fill, HOLD, and MODIFY_SL invalid/valid are idempotent", async () => {
  const { repo, service } = make("ENTER_LONG", "HOLD"); const s = await setup(service); const input = { userId: "u", traderId: "t", traderVersionId: "v", scenario: s!, trigger: "ZONE", m5BarTime: 10, hardSl: 99, knowledgeSnapshot: [] };
  const a = await service.entryRecheck(input); const b = await service.entryRecheck(input); assert.equal(repo.commands.length, 1); assert.equal(b.decision, "WAIT");
  const p = await service.fill({ userId: "u", traderId: "t", traderVersionId: "v", scenario: s!, commandId: a.commandId!, knowledgeSnapshot: [] }); const p2 = await service.fill({ userId: "u", traderId: "t", traderVersionId: "v", scenario: s!, commandId: a.commandId!, knowledgeSnapshot: [] }); assert.equal(p.id, p2.id);
  const hold = await service.positionReview({ userId: "u", traderId: "t", traderVersionId: "v", position: p, trigger: "POSITION_REVIEW", barTime: 11, knowledgeSnapshot: [] }); assert.equal(hold.decision, "HOLD"); assert.equal(repo.commands.length, 1);
  const invalid = make("ENTER_LONG", "MODIFY_SL"); const si = await setup(invalid.service); const pi = { ...p, scenarioId: si!.id }; const r = await invalid.service.positionReview({ userId: "u", traderId: "t", traderVersionId: "v", position: pi, trigger: "SL_RECHECK", barTime: 12, knowledgeSnapshot: [] }); assert.equal(r.decision, "MODIFY_SL");
});

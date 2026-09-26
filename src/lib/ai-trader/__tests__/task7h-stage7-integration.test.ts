import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAndValidateBuilderSave } from "../../aiTraderSchema";
import { mapManualDecisionToExecution } from "../manual-approval";
import { detectPositionCandidate } from "../position-candidate-detector";
import { RuntimeService, type RuntimePosition, type RuntimeRepository, type RuntimeScenario } from "../runtime-service";
import { parseTradeReview } from "../trade-review-contract";

class LifecycleRepo implements RuntimeRepository {
  claims = new Set<string>(); commands: Array<{ id: string; action: string }> = []; logs: any[] = []; state = "FLAT";
  async claim(key: string) { if (this.claims.has(key)) return false; this.claims.add(key); return true; }
  async transition(_id: string, _from: any, to: any) { this.state = to; return true; }
  async createScenario(i: any) { return { id: "scenario-1", version: 1, state: i.state, h1BarTime: i.h1BarTime }; }
  async createCommand(i: any) { const id = `command-${this.commands.length + 1}`; this.commands.push({ id, action: i.action }); return { id }; }
  async openPosition(i: any) { return { id: "position-1", traderId: i.traderId, scenarioId: i.scenarioId, commandId: i.commandId, status: "OPEN", side: "BUY", entryPrice: 100, stopLoss: 90, takeProfit: 110, volume: 1, userId: "user-a", connectionId: "connection-a", symbol: "GOLD", magicNumber: 1, positionTicket: 10001 } as RuntimePosition; }
  async closePosition(id: string) { return { outcomeId: `outcome-${id}`, closed: true }; }
  async saveLog(log: any) { this.logs.push(log); }
}

const market = { validEntry: () => true, validPosition: () => true, validateHardSl: () => true, validateModifySl: (_p: RuntimePosition, v: unknown) => typeof v === "number" && v >= 90, validateModifyTp: (_p: RuntimePosition, v: unknown) => typeof v === "number" && v > 100 };

test("Task 7H: Builder contract is persistence-compatible and safe", () => {
  const profile = normalizeAndValidateBuilderSave({ name: "Stage7", description: "integration", market: "GOLD", profile: { personality: "BALANCED", trading_style: "TREND_FOLLOWING", risk_profile: "LOW", entry_patience: "PATIENT", news_sensitivity: "MEDIUM", volatility_preference: "NORMAL", timeframes: ["H1", "M5"], minimum_rr: 1.5, max_risk_per_trade: 1, max_positions: 2, instructions: "safe" } });
  assert.equal(profile.market, "GOLD"); assert.deepEqual(profile.profile.timeframes, ["H1", "M5"]);
});

test("Task 7H: H1 → Entry WAIT/ENTER → filled position preserves correlations", async () => {
  const repo = new LifecycleRepo();
  let entryDecision: string = "WAIT";
  const service = new RuntimeService(repo, { entry: async () => ({ decision: entryDecision, reasoning: "validated" }), position: async () => ({ decision: "HOLD", reasoning: "hold" }) }, { entry: async () => ({ approved: true }) }, market);
  const scenario = await service.hourlyAnalysis({ userId: "user-a", traderId: "trader-a", traderVersionId: "version-1", h1BarTime: 1, decision: "WATCH" });
  assert.ok(scenario); const wait = await service.entryRecheck({ userId: "user-a", traderId: "trader-a", traderVersionId: "version-1", scenario: scenario!, trigger: "M5", m5BarTime: 2, hardSl: 90, knowledgeSnapshot: [] });
  assert.equal(wait.decision, "WAIT"); assert.equal(repo.commands.length, 0);
  entryDecision = "ENTER_LONG"; const scenario2 = await service.hourlyAnalysis({ userId: "user-a", traderId: "trader-a", traderVersionId: "version-1", h1BarTime: 3 });
  const enter = await service.entryRecheck({ userId: "user-a", traderId: "trader-a", traderVersionId: "version-1", scenario: scenario2!, trigger: "M5", m5BarTime: 4, hardSl: 90, knowledgeSnapshot: [] });
  assert.equal(enter.commandId, "command-1"); const position = await service.fill({ userId: "user-a", traderId: "trader-a", traderVersionId: "version-1", scenario: scenario2!, commandId: enter.commandId!, knowledgeSnapshot: [] });
  assert.equal(position.connectionId, "connection-a"); assert.equal(position.positionTicket, 10001); assert.equal(repo.logs.some(l => l.trigger === "HOURLY_ANALYSIS"), true);
});

test("Task 7H: candidate triggers and HOLD never create a new-entry command", async () => {
  const repo = new LifecycleRepo(); const p: RuntimePosition = { id: "p", traderId: "t", scenarioId: "s", status: "OPEN", side: "BUY", entryPrice: 100, stopLoss: 90, takeProfit: 110, currentPrice: 108, volume: 1, userId: "u", connectionId: "c", symbol: "GOLD" };
  assert.equal(detectPositionCandidate({ side: "BUY", entryPrice: 100, stopLoss: 90, takeProfit: 110, currentPrice: 108 }).trigger, "TP_RECHECK");
  const service = new RuntimeService(repo, { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "HOLD" }) }, { entry: async () => ({ approved: false }) }, market);
  const result = await service.positionReview({ userId: "u", traderId: "t", traderVersionId: "v", position: p, trigger: "TP_RECHECK", barTime: 5, knowledgeSnapshot: [] });
  assert.equal(result.decision, "HOLD"); assert.equal(repo.commands.length, 0); assert.equal(repo.logs.at(-1)?.trigger, "TP_RECHECK");
});

test("Task 7H: manual mapping and strict Trade Review contract are canonical", () => { assert.equal(mapManualDecisionToExecution("ENTER_LONG"), "BUY"); assert.equal(mapManualDecisionToExecution("ENTER_SHORT"), "SELL"); assert.equal(mapManualDecisionToExecution("WAIT"), null); assert.equal(parseTradeReview({ what_worked: "a", what_failed: "b", review_text: "c", hypothesis: "d", confidence: 3 }).confidence, 3); });

test("Task 7H: invalid lifecycle inputs fail closed", () => { assert.throws(() => normalizeAndValidateBuilderSave({ name: "x", market: "BTC", profile: {} })); assert.equal(detectPositionCandidate({ side: "BUY", entryPrice: 100, stopLoss: 100, takeProfit: 110, currentPrice: 108 }).trigger, null); });

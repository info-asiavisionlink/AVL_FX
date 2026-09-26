import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateRiskReward,
  normalizeLot,
  runRiskEngine,
  type RiskEngineInput,
  type RiskEngineSymbolSpec,
} from "../../../lib/ai-trader/risk-engine.js";

const db = {} as any;
const spec: RiskEngineSymbolSpec = {
  contractSize: 100, tickSize: 0.01, tickValue: 1,
  volumeMin: 0.001, volumeMax: 100, volumeStep: 0.001,
  stopsLevelPrice: 0, digits: 3, marginInitial: 100,
  maxSpreadAllowed: 50,
};

function input(overrides: Partial<RiskEngineInput> = {}): RiskEngineInput {
  return {
    trader: {
      id: "t", user_id: "u", execution_mode: "DEMO_AUTONOMOUS",
      kill_switch: false, kill_switch_reason: null, daily_stats_date: null,
      daily_trade_count: 0, daily_loss_usd: 0, daily_consecutive_losses: 0,
    },
    profile: {
      id: "v1", magic_number: 900001, max_daily_trades: 10,
      max_daily_loss_usd: 1000, max_consecutive_losses: 5,
      max_total_exposure_lots: 100, account_data_max_age_seconds: 60,
      tick_data_max_age_seconds: 60, max_spread_points: 50,
      max_risk_per_trade: 1, minimum_rr: 2, max_positions: 3,
    },
    accountSnapshot: {
      connectionId: "c", accountType: "DEMO", accountMode: "HEDGING",
      balance: 10000, equity: 10000, freeMargin: 9000, margin: 1000,
      currency: "USD", updatedAtMs: Date.now(),
    },
    symbolSpec: spec,
    liveQuote: { bid: 2600, ask: 2600, spread: 1, timestampMs: Date.now() },
    decision: { decision: "ENTER_LONG", suggestedSl: 2590, suggestedTp: 2620 },
    openPositionCount: 0, totalExposureLots: 0, skipGlobalKillSwitch: true,
    enforceProfileLimits: true, requireMarginValidation: true,
    ...overrides,
  };
}

test("TP direction is deterministic for BUY and SELL", async () => {
  assert.equal((await runRiskEngine(input(), db)).approved, true);
  assert.match((await runRiskEngine(input({ decision: { decision: "ENTER_LONG", suggestedSl: 2590, suggestedTp: 2590 } }), db)).deniedReason ?? "", /tp_direction/);
  { const r = await runRiskEngine(input({ decision: { decision: "ENTER_SHORT", suggestedSl: 2610, suggestedTp: 2580 }, liveQuote: { bid: 2600, ask: 2600, spread: 1, timestampMs: Date.now() } }), db); assert.equal(r.approved, true, r.deniedReason); }
  assert.match((await runRiskEngine(input({ decision: { decision: "ENTER_SHORT", suggestedSl: 2610, suggestedTp: 2610 }, liveQuote: { bid: 2600, ask: 2600, spread: 1, timestampMs: Date.now() } }), db)).deniedReason ?? "", /tp_direction/);
});

test("minimum RR uses exact boundary and rejects below/invalid", async () => {
  assert.equal(calculateRiskReward("BUY", 2600, 2590, 2620), 2);
  assert.equal((await runRiskEngine(input(), db)).approved, true);
  assert.match((await runRiskEngine(input({ profile: { ...input().profile, minimum_rr: 2.1 } }), db)).deniedReason ?? "", /minimum_rr/);
  assert.match((await runRiskEngine(input({ decision: { decision: "ENTER_LONG", suggestedSl: 2600, suggestedTp: 2620 } }), db)).deniedReason ?? "", /minimum_rr|sl_wrong_side/);
});

test("max_positions is a profile ceiling", async () => {
  assert.equal((await runRiskEngine(input({ openPositionCount: 2 }), db)).approved, true);
  assert.match((await runRiskEngine(input({ openPositionCount: 3 }), db)).deniedReason ?? "", /max_positions/);
  assert.match((await runRiskEngine(input({ openPositionCount: Number.NaN }), db)).deniedReason ?? "", /numeric_invalid/);
});

test("margin is fail-closed when authoritative data is unavailable", async () => {
  assert.equal((await runRiskEngine(input(), db)).approved, true);
  assert.match((await runRiskEngine(input({ symbolSpec: { ...spec, marginInitial: 0 } }), db)).deniedReason ?? "", /margin_data_unavailable/);
  assert.match((await runRiskEngine(input({ accountSnapshot: { ...input().accountSnapshot!, freeMargin: 0 } }), db)).deniedReason ?? "", /margin_data_unavailable/);
  assert.match((await runRiskEngine(input({ accountSnapshot: { ...input().accountSnapshot!, freeMargin: 10 } }), db)).deniedReason ?? "", /margin_insufficient/);
});

test("lot normalization floors arbitrary broker precision", () => {
  for (const [step, raw, expected] of [[1, 3.9, 3], [0.1, 1.27, 1.2], [0.01, 1.278, 1.27], [0.001, 1.2789, 1.278], [0.0001, 1.27899, 1.2789]] as const) {
    assert.equal(normalizeLot(raw, { ...spec, volumeStep: step, volumeMin: step }), expected);
  }
});

test("execution mode is canonical and fail-closed", async () => {
  assert.match((await runRiskEngine(input({ trader: { ...input().trader, execution_mode: "ANALYSIS_ONLY" } }), db)).deniedReason ?? "", /execution_mode/);
  assert.match((await runRiskEngine(input({ trader: { ...input().trader, execution_mode: "MANUAL_APPROVAL" } }), db)).deniedReason ?? "", /execution_mode/);
  assert.equal((await runRiskEngine(input({ trader: { ...input().trader, execution_mode: "MANUAL_APPROVAL" }, manualApproval: true }), db)).approved, true);
  assert.match((await runRiskEngine(input({ trader: { ...input().trader, execution_mode: "AUTO" } }), db)).deniedReason ?? "", /execution_mode/);
});

test("missing profile limits fail closed on AI Trader path", async () => {
  const p = { ...input().profile };
  delete (p as any).minimum_rr;
  assert.match((await runRiskEngine(input({ profile: p }), db)).deniedReason ?? "", /invalid_profile_limits/);
});

test("missing symbol specification and position count fail closed", async () => {
  assert.match((await runRiskEngine(input({ symbolSpec: null }), db)).deniedReason ?? "", /symbol_spec_missing/);
  assert.match((await runRiskEngine(input({ positionCountAvailable: false }), db)).deniedReason ?? "", /position_count_unavailable/);
});

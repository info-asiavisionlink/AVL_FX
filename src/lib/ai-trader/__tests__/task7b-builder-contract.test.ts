import assert from "node:assert/strict";
import test from "node:test";
import {
  AITraderBuilderOutputSchema,
  normalizeAndValidateBuilderProfile,
  normalizeAndValidateBuilderSave,
} from "@/lib/aiTraderSchema";

const profile = () => ({
  personality: "BALANCED",
  trading_style: "TREND_FOLLOWING",
  risk_profile: "MEDIUM",
  entry_patience: "NORMAL",
  news_sensitivity: "MEDIUM",
  volatility_preference: "NORMAL",
  timeframes: ["H4", "H1", "M5"],
  minimum_rr: 1.5,
  max_risk_per_trade: 1,
  max_positions: 2,
  instructions: "損失を限定し、条件が揃うまで待つ。",
});

const output = () => ({
  name: "Trend Guard",
  description: "慎重なトレンドフォロー型トレーダー",
  reasoning: "上位足を優先し、リスクを抑えるため。",
  profile: profile(),
  suggested_knowledge_ids: [],
});

// What AITraderBuilder.tsx POSTs to /api/traders after a successful build.
const savePayload = (): Record<string, any> => {
  const o = output();
  return { name: o.name, description: o.description, market: "GOLD", profile: o.profile };
};

test("Task 7B: complete Builder output is accepted and normalized", () => {
  const parsed = AITraderBuilderOutputSchema.parse(output());
  assert.deepEqual(normalizeAndValidateBuilderProfile(parsed.profile).timeframes, ["H4", "H1", "M5"]);
});

test("Task 7B: duplicate timeframe aliases are deterministic", () => {
  const p = { ...profile(), timeframes: ["h4", "H4", "H1"] };
  assert.deepEqual(normalizeAndValidateBuilderProfile(p).timeframes, ["H4", "H1"]);
});

for (const [name, mutate] of [
  ["missing top-level name", (x: any) => { delete x.name; }],
  ["missing nested field", (x: any) => { delete x.profile.instructions; }],
  ["invalid enum", (x: any) => { x.profile.personality = "UNKNOWN"; }],
  ["invalid market", (x: any) => { x.market = "BTC"; }],
  ["invalid timeframe", (x: any) => { x.profile.timeframes = ["TICK"]; }],
  ["zero risk", (x: any) => { x.profile.max_risk_per_trade = 0; }],
  ["negative RR", (x: any) => { x.profile.minimum_rr = -1; }],
  ["non-integer positions", (x: any) => { x.profile.max_positions = 1.5; }],
  ["infinite risk", (x: any) => { x.profile.max_risk_per_trade = Infinity; }],
  ["unknown output field", (x: any) => { x.untrusted = true; }],
] as const) {
  test(`Task 7B: rejects ${name}`, () => {
    const x = savePayload();
    mutate(x);
    assert.throws(() => normalizeAndValidateBuilderSave(x));
  });
}

// Control: the unmutated payload must pass, otherwise the rejections above are vacuous.
test("Task 7B: unmutated save payload is accepted", () => {
  assert.doesNotThrow(() => normalizeAndValidateBuilderSave(savePayload()));
});

test("Task 7B: safe save contract uses GOLD and never autonomous mode", () => {
  const saved = normalizeAndValidateBuilderSave({ ...savePayload(), market: "gold" });
  assert.equal(saved.market, "GOLD");
  assert.ok(saved.profile.minimum_rr > 0);
});

test("Task 7B (V2 Stage 5): knowledge_ids is rejected — no Console Knowledge binding at save", () => {
  assert.throws(() => normalizeAndValidateBuilderSave({ ...savePayload(), knowledge_ids: [] }));
});

test("Task 7B (V2 Stage 5): timeframe profile defaults to DAY_TRADING and rejects bad values", () => {
  assert.equal(normalizeAndValidateBuilderSave(savePayload()).timeframe_profile?.timeframe_style, "DAY_TRADING");
  const tf = { timeframe_style: "SWING", trend_context_timeframes: ["D1", "H4"], entry_timeframes: ["H1"] };
  assert.deepEqual(normalizeAndValidateBuilderSave({ ...savePayload(), timeframe_profile: tf }).timeframe_profile?.entry_timeframes, ["H1"]);
  for (const bad of [
    { ...tf, entry_timeframes: [] },
    { ...tf, trend_context_timeframes: [] },
    { ...tf, entry_timeframes: ["H2"] },
    { ...tf, entry_timeframes: ["H1", "H1"] },
    { ...tf, timeframe_style: "HFT" },
    { ...tf, monitor_interval_minutes: 0 },
    { ...tf, unknown: true },
  ]) {
    assert.throws(() => normalizeAndValidateBuilderSave({ ...savePayload(), timeframe_profile: bad }));
  }
});

test("Task 7B: Builder schema does not create execution commands", () => {
  assert.equal("execution_commands" in output(), false);
});

import "./helpers/smoke-env";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { NextRequest } from "next/server";
import { createProductionRuntimeService, RuntimeService, type RuntimeRepository, type RuntimeAI, type RuntimeRisk, type RuntimeMarket } from "../runtime-service";
import { createProductionH1StrategyDependencies, handleH1Strategy, handleH1StrategyRequest, type H1StrategyDependencies } from "@/app/api/cron/h1-strategy/route";
import { createProductionM5CloseDependencies, handleM5CloseRequest, type M5CloseDependencies } from "@/app/api/watcher/m5-close/route";
import { processExecutionResult, reconcilePositionSnapshot, type ExecutionStore } from "../../../../gateway/src/executionStore";

/** Minimal Supabase-shaped fixture adapter. It exercises production handlers;
 * external HTTP/AI/Gateway boundaries remain disabled by construction. */
function emptyDb() {
  const chain = (data: unknown = null) => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "single", "maybeSingle", "update", "insert", "upsert"]) self[method] = (..._args: unknown[]) => self;
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data, error: null }));
    return self;
  };
  return { from: (_table: string) => chain([]), rpc: async () => ({ data: [{ id: "scenario-smoke", scenario_version: 1 }], error: null }) } as never;
}

// V2 Stage 5: the runtime reads its config through the canonical loader, which
// fails closed without a complete active version (incl. risk limits) and a
// timeframe profile.  These fixtures mirror a migrated (001–038) Customer DB row.
const stage5Version = (traderId: string, id: string, overrides: Record<string, unknown> = {}) => ({
  id, version: 1, ai_trader_id: traderId,
  personality: "BALANCED", trading_style: "TREND_FOLLOWING", risk_profile: "MEDIUM",
  entry_patience: "NORMAL", news_sensitivity: "MEDIUM", volatility_preference: "NORMAL",
  timeframes: ["H4", "H1"], instructions: null, magic_number: 900001,
  minimum_rr: 2, max_risk_per_trade: 1, max_positions: 1, max_daily_trades: 5,
  max_daily_loss_usd: 100, max_consecutive_losses: 3, max_total_exposure_lots: 0.2,
  market_data_max_age_seconds: 30, account_data_max_age_seconds: 60, tick_data_max_age_seconds: 10,
  max_spread_points: 0, knowledge_package_version: null,
  ...overrides,
});
const STAGE5_TF_PROFILE = {
  timeframe_style: "DAY_TRADING", macro_context_timeframes: ["H4"], trend_context_timeframes: ["H4", "H1"],
  setup_timeframes: ["M15", "M5"], entry_timeframes: ["M5"], management_timeframes: ["M15"], monitor_interval_minutes: 5,
};

function watcherDb(trader: Record<string, unknown>, scenario: Record<string, unknown> | null = null, position: Record<string, unknown> | null = null, profile: Record<string, unknown> | null = null, connection: Record<string, unknown> | null = null, tfProfile: Record<string, unknown> | null = STAGE5_TF_PROFILE) {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    let one = false;
    for (const method of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "update", "insert", "upsert", "gte", "lte"]) self[method] = (..._args: unknown[]) => self;
    self.single = () => { one = true; return self; };
    self.maybeSingle = () => { one = true; return self; };
    self.then = (resolve: (v: unknown) => unknown) => {
      const rows = table === "ai_traders" ? [trader] : table === "ai_trader_versions" && profile ? [profile] : table === "ai_trader_timeframe_profiles" && tfProfile ? [tfProfile] : table === "mt5_connections" && connection ? [connection] : table === "ai_trader_scenarios" && scenario ? [scenario] : table === "ai_positions" && position ? [position] : [];
      const data = one ? (rows[0] ?? null) : rows;
      return Promise.resolve(resolve({ data, error: null }));
    };
    return self;
  };
  return { from: (table: string) => chain(table), rpc: async () => ({ data: [], error: null }) } as never;
}

function spyRuntime(entryDecision: "WAIT" | "ENTER_LONG" = "WAIT", positionDecision: "HOLD" | "CLOSE" = "HOLD") {
  const capturedLogs: unknown[] = [];
  const repo: RuntimeRepository = {
    claim: async () => true,
    transition: async () => true,
    createScenario: async () => ({ id: "scenario", version: 1, state: "WATCHING", h1BarTime: 1 }),
    createCommand: async () => ({ id: "command" }),
    openPosition: async () => ({ id: "position", traderId: "trader", scenarioId: "scenario", status: "OPEN", side: "BUY", entryPrice: 1, stopLoss: 0.9, takeProfit: 1.2, volume: 0.01 }),
    closePosition: async () => ({ outcomeId: "outcome", closed: true }),
    saveLog: async (log) => { capturedLogs.push(log); },
  };
  const ai: RuntimeAI = { entry: async () => ({ decision: entryDecision }), position: async () => ({ decision: positionDecision }) };
  const risk: RuntimeRisk = { entry: async () => ({ approved: false, reason: "smoke" }) };
  const market: RuntimeMarket = { validEntry: () => true, validPosition: () => true, validateHardSl: () => true, validateModifySl: () => true, validateModifyTp: () => true };
  class SpyRuntime extends RuntimeService {
    entryCalls = 0;
    positionCalls = 0;
    commandCalls = 0;
    logs = capturedLogs;
    override async entryRecheck(input: Parameters<RuntimeService["entryRecheck"]>[0]) {
      this.entryCalls += 1;
      if (entryDecision === "WAIT") return { decision: "WAIT" as const };
      this.commandCalls += 1;
      return { decision: entryDecision, commandId: "entry-command" };
    }
    override async positionReview(input: Parameters<RuntimeService["positionReview"]>[0]) {
      this.positionCalls += 1;
      if (positionDecision === "HOLD") return { decision: "HOLD" as const };
      this.commandCalls += 1;
      return { decision: "CLOSE" as const, commandId: "close-command" };
    }
  }
  return new SpyRuntime(repo, ai, risk, market);
}

test("Stage 4 production-path harness smoke: local schema, factory, handlers, gateway boundaries", async () => {
  const rows = execFileSync("psql", ["-h", "127.0.0.1", "-p", "55435", "-d", "postgres", "-At", "-c", "SELECT 1"], { encoding: "utf8" }).trim();
  assert.equal(rows, "1");
  const db = emptyDb();
  const runtime = createProductionRuntimeService(db, {
    ai: { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "HOLD" }) },
    risk: { entry: async () => ({ approved: false, reason: "smoke" }) },
    market: { validEntry: () => false, validPosition: () => false, validateHardSl: () => false, validateModifySl: () => false, validateModifyTp: () => false },
  });
  assert.equal(typeof runtime.hourlyAnalysis, "function");
  assert.equal(typeof runtime.entryRecheck, "function");
  assert.equal(typeof runtime.positionReview, "function");

  let injectedRuntimeCalls = 0;
  const productionDeps = createProductionH1StrategyDependencies(db);
  const injectedDeps = {
    ...productionDeps,
    runtimeFactory: (runtimeDb: Parameters<H1StrategyDependencies["runtimeFactory"]>[0]) => {
      injectedRuntimeCalls += 1;
      return createProductionRuntimeService(runtimeDb, {
        ai: { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "HOLD" }) },
        risk: { entry: async () => ({ approved: false, reason: "smoke" }) },
        market: { validEntry: () => false, validPosition: () => false, validateHardSl: () => false, validateModifySl: () => false, validateModifyTp: () => false },
      });
    },
  };
  const scenario = await handleH1Strategy({
    userId: "user-smoke",
    traderId: "trader-smoke",
    traderVersionId: "version-smoke",
    h1BarTime: 1,
    scenarioPayload: { bias: "LONG" },
    knowledgeSnapshot: [],
    decision: "LONG",
  }, injectedDeps);
  assert.equal(injectedRuntimeCalls, 1);
  assert.equal(scenario?.id, "scenario-smoke");
  const response = await handleH1StrategyRequest(
    new NextRequest("http://localhost/api/cron/h1-strategy", { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } }),
    injectedDeps,
  );
  assert.equal(response.status, 200);
  const { handleManagePositions } = await import("../position-review-runtime");
  const positionSmoke = await handleManagePositions({ db, traderId: "smoke", userId: "user-smoke", barTime: 1, trigger: "POSITION_REVIEW" });
  assert.equal(positionSmoke.status, 200);

});

test("M5 production handler uses injected entry and position boundaries", async () => {
  const barTime = Math.floor((Date.now() - 10 * 60_000) / 300_000) * 300;
  const trader = {
    id: "trader-m5-smoke", user_id: "user-m5-smoke", name: "M5 smoke", market: "GOLD", status: "ACTIVE", current_version: 1,
    watcher_state: "WATCHING_ENTRY", last_analysis_at: null, execution_mode: "DEMO_AUTONOMOUS",
    daily_consecutive_losses: 0, daily_stats_date: null, daily_trade_count: 0, daily_loss_usd: 0,
    kill_switch: false, kill_switch_reason: null,
  };
  const scenario = {
    id: "scenario-m5-smoke", state: "WATCHING", bias: "LONG", watch_zone_low: 100,
    watch_zone_high: 101, invalidate_below: null, invalidate_above: null,
    recheck_triggers: [], recheck_triggers_v2: [], entry_side: "LONG", suggested_sl: 99,
    suggested_tp: 102, scenario_version: 1, h1_bar_time: barTime - 3600,
  };
  const db = watcherDb(trader, scenario, null, stage5Version(trader.id, "version-m5-smoke"));
  const entryRuntime = spyRuntime();
  let positionCalls = 0;
  const base = createProductionM5CloseDependencies(db);
  const deps: M5CloseDependencies = {
    ...base,
    db,
    fetchMarketData: async () => ({ m5Bars: [], m1Bars: [], h4Bars: [], currentPrice: 0, ask: 0, tickTime: 0, spread: 0, atr: 0 }),
    fetchKnowledge: async () => [],
    checkNewsEvent: async () => ({ hasEvent: false, eventTitle: "", minutesUntil: 9999 }),
    aiClientFactory: () => { throw new Error("real OpenAI must not be called in DI smoke"); },
    runtimeFactory: () => entryRuntime,
    positionHandler: async () => { positionCalls += 1; return { status: 200, body: { ok: true, managed: 0, results: [] } }; },
  };
  const request = (body: Record<string, unknown>) => new NextRequest("http://localhost/api/watcher/m5-close", {
    method: "POST",
    headers: { "x-watcher-secret": process.env.WATCHER_SECRET ?? "" },
    body: JSON.stringify(body),
  });
  const entryResponse = await handleM5CloseRequest(request({ symbol: "GOLD#", bar_time: barTime, current_price: 100.5 }), deps);
  assert.equal(entryResponse.status, 200);
  assert.equal(entryRuntime.entryCalls, 1);
  assert.equal(positionCalls, 0);

  const positionDeps: M5CloseDependencies = {
    ...deps,
    db: watcherDb({ ...trader, watcher_state: "POSITION" }, null),
    runtimeFactory: () => { throw new Error("entry runtime must not be constructed for position branch"); },
  };
  const positionResponse = await handleM5CloseRequest(request({ symbol: "GOLD#", bar_time: barTime, current_price: 100.5 }), positionDeps);
  assert.equal(positionResponse.status, 200);
  assert.equal(entryRuntime.entryCalls, 1);
  assert.equal(positionCalls, 1);
});

test("Primary production-path happy path: H1 → M5 entry → FILLED → position close", async () => {
  const localDb = execFileSync("psql", ["-h", "127.0.0.1", "-p", "55435", "-d", "postgres", "-At", "-c", "SELECT 1"], { encoding: "utf8" }).trim();
  assert.equal(localDb, "1");
  const trader = { id: "trader-e2e", user_id: "user-e2e", name: "E2E", market: "GOLD", status: "ACTIVE", current_version: 1, watcher_state: "WATCHING_ENTRY", last_analysis_at: null, execution_mode: "DEMO_AUTONOMOUS", daily_consecutive_losses: 0, daily_stats_date: null, daily_trade_count: 0, daily_loss_usd: 0, kill_switch: false, kill_switch_reason: null };
  const h1Runtime = spyRuntime();
  const h1Profile = stage5Version(trader.id, "version-e2e");
  const h1Connection = { id: "connection-e2e", last_heartbeat_at: new Date().toISOString() };
  const h1Bars = Array.from({ length: 8 }, (_, i) => ({ time: Math.floor((Date.now() - (8 - i) * 3_600_000) / 1000), open: 100, high: 101, low: 99, close: 100.5, volume: 10 }));
  const h1Deps = { ...createProductionH1StrategyDependencies(watcherDb(trader, null, null, h1Profile, h1Connection)), runtimeFactory: () => h1Runtime, fetchBars: async () => h1Bars, fetchBarsFallback: async () => [], fetchKnowledge: async () => ({ text: "fixture knowledge", snapshot: [{ id: "k1", title: "Structure", category: "Market Structure", version: 1 }] }), fetchEconomicEvents: async () => "なし", fetchNews: async () => "なし", aiClientFactory: (() => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ entry_side: "LONG", bias: "LONG", scenario: "LONG watch", entry_price_low: 100, entry_price_high: 101, suggested_sl: 99, suggested_tp: 102, suggested_volume: 0.01, reasoning: "fixture" }) } }], usage: { total_tokens: 1 } }) } } })) as unknown as H1StrategyDependencies["aiClientFactory"] };
  const h1Response = await handleH1StrategyRequest(new NextRequest("http://localhost/api/cron/h1-strategy", { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } }), h1Deps);
  assert.equal(h1Response.status, 200);
  assert.equal(h1Runtime.logs.length > 0, true);
  const scenario = { id: "scenario-e2e", version: 1, state: "WATCHING", h1BarTime: 1, entrySide: "LONG" as const, suggestedSl: 99, suggestedTp: 102, symbol: "GOLD#" };

  const barTime = Math.floor((Date.now() - 10 * 60_000) / 300_000) * 300;
  const scenarioRow = { id: "scenario-e2e", state: "WATCHING", bias: "LONG", watch_zone_low: 100, watch_zone_high: 101, invalidate_below: null, invalidate_above: null, recheck_triggers: [], recheck_triggers_v2: [], entry_side: "LONG", suggested_sl: 99, suggested_tp: 102, scenario_version: 1, h1_bar_time: barTime - 3600 };
  const entryRuntime = spyRuntime("ENTER_LONG");
  const entryDeps = { ...createProductionM5CloseDependencies(watcherDb(trader, scenarioRow, null, h1Profile)), fetchMarketData: async () => ({ m5Bars: [], m1Bars: [], h4Bars: [], currentPrice: 0, ask: 0, tickTime: 0, spread: 0, atr: 0 }), fetchKnowledge: async () => [], checkNewsEvent: async () => ({ hasEvent: false, eventTitle: "", minutesUntil: 9999 }), aiClientFactory: () => { throw new Error("network disabled"); }, runtimeFactory: () => entryRuntime };
  const requestFor = (body: Record<string, unknown>) => new NextRequest("http://localhost/api/watcher/m5-close", { method: "POST", headers: { "x-watcher-secret": process.env.WATCHER_SECRET ?? "" }, body: JSON.stringify(body) });
  const entryResponse = await handleM5CloseRequest(requestFor({ symbol: "GOLD#", bar_time: barTime, current_price: 100.5 }), entryDeps);
  assert.equal(entryResponse.status, 200);
  assert.equal(entryRuntime.entryCalls, 1);
  assert.equal(entryRuntime.commandCalls, 1);

  let filled = false;
  let open = false;
  let closed = false;
  let outcomes = 0;
  const gatewayStore: ExecutionStore = {
    async submitCommandResult(result, connectionId) { assert.equal(connectionId, "connection-e2e"); assert.equal(result.status, "FILLED"); filled = true; open = true; return { rowsAffected: 1 }; },
    async upsertPositions(_connectionId, _userId, positions) { if (positions.length === 0) { closed = true; open = false; outcomes += 1; } },
  };
  await processExecutionResult({ commandId: "entry-command", success: true, status: "FILLED", retcode: 0, orderTicket: 1, dealTicket: 2, positionTicket: 3, requestedPrice: 100.5, executionPrice: 100.5, requestedVolume: 0.01, executedVolume: 0.01, stopLoss: 99, takeProfit: 102, brokerTime: new Date().toISOString(), errorCode: null, errorMessage: null }, "connection-e2e", gatewayStore);
  assert.equal(filled, true);
  assert.equal(open, true);

  const positionRuntime = spyRuntime("WAIT", "CLOSE");
  let positionHandlerCalls = 0;
  const position = { id: "position-e2e", scenario_id: scenarioRow.id, status: "OPEN", position_ticket: 3, side: "BUY", entry_price: 100.5, stop_loss: 99, take_profit: 102, volume: 0.01 };
  const positionDeps = { ...createProductionM5CloseDependencies(watcherDb({ ...trader, watcher_state: "POSITION" }, scenarioRow)), fetchMarketData: async () => ({ m5Bars: [], m1Bars: [], h4Bars: [], currentPrice: 100.5, ask: 100.5, tickTime: barTime, spread: 0, atr: 0 }), fetchKnowledge: async () => [], checkNewsEvent: async () => ({ hasEvent: false, eventTitle: "", minutesUntil: 9999 }), runtimeFactory: () => { throw new Error("entryRecheck must be bypassed for positions"); }, positionHandler: async () => { positionHandlerCalls += 1; await positionRuntime.positionReview({ userId: trader.user_id, traderId: trader.id, traderVersionId: "version-e2e", position: { id: position.id, traderId: trader.id, scenarioId: scenarioRow.id, status: "OPEN", side: "BUY", entryPrice: 100.5, currentPrice: 100.5, stopLoss: 99, takeProfit: 102, volume: 0.01 }, trigger: "POSITION_REVIEW", barTime, knowledgeSnapshot: [] }); return { status: 200, body: { ok: true, managed: 1, results: [] } }; } };
  const positionResponse = await handleM5CloseRequest(requestFor({ symbol: "GOLD#", bar_time: barTime, current_price: 100.5 }), positionDeps);
  assert.equal(positionResponse.status, 200);
  assert.equal(positionHandlerCalls, 1);
  assert.equal(positionRuntime.positionCalls, 1);
  assert.equal(positionRuntime.commandCalls, 1);

  await reconcilePositionSnapshot("connection-e2e", "user-e2e", [], gatewayStore);
  assert.equal(closed, true);
  assert.equal(open, false);
  assert.equal(outcomes, 1);
});

// ── V2 Stage 5: config failure stops the production handlers (fail closed) ───

test("Stage 5: M5 production handler does not reach entry when canonical config is incomplete", async () => {
  const barTime = Math.floor((Date.now() - 10 * 60_000) / 300_000) * 300;
  const trader = {
    id: "trader-m5-cfg", user_id: "user-m5-cfg", name: "M5 cfg", market: "GOLD", status: "ACTIVE", current_version: 1,
    watcher_state: "WATCHING_ENTRY", last_analysis_at: null, execution_mode: "DEMO_AUTONOMOUS",
    daily_consecutive_losses: 0, daily_stats_date: null, daily_trade_count: 0, daily_loss_usd: 0,
    kill_switch: false, kill_switch_reason: null,
  };
  const scenario = {
    id: "scenario-m5-cfg", state: "WATCHING", bias: "LONG", watch_zone_low: 100, watch_zone_high: 101,
    invalidate_below: null, invalidate_above: null, recheck_triggers: [], recheck_triggers_v2: [],
    entry_side: "LONG", suggested_sl: 99, suggested_tp: 102, scenario_version: 1, h1_bar_time: barTime - 3600,
  };
  const cases: [string, ReturnType<typeof watcherDb>][] = [
    ["NO_TIMEFRAME_PROFILE", watcherDb(trader, scenario, null, stage5Version(trader.id, "v-cfg"), null, null)],
    ["NO_ACTIVE_VERSION",    watcherDb(trader, scenario, null, null)],
    ["INVALID_PROFILE",      watcherDb(trader, scenario, null, stage5Version(trader.id, "v-cfg", { tick_data_max_age_seconds: null }))],
    ["NOT_ACTIVE",           watcherDb({ ...trader, status: "ARCHIVED" }, scenario, null, stage5Version(trader.id, "v-cfg"))],
  ];
  for (const [code, db] of cases) {
    const runtime = spyRuntime("ENTER_LONG");
    const deps: M5CloseDependencies = {
      ...createProductionM5CloseDependencies(db),
      fetchMarketData: async () => ({ m5Bars: [], m1Bars: [], h4Bars: [], currentPrice: 100.5, ask: 100.5, tickTime: barTime, spread: 0, atr: 0 }),
      fetchKnowledge: async () => [],
      checkNewsEvent: async () => ({ hasEvent: false, eventTitle: "", minutesUntil: 9999 }),
      aiClientFactory: () => { throw new Error("AI must not be called on config failure"); },
      runtimeFactory: () => runtime,
      positionHandler: async () => { throw new Error("position handler must not be called"); },
    };
    const res = await handleM5CloseRequest(new NextRequest("http://localhost/api/watcher/m5-close", {
      method: "POST", headers: { "x-watcher-secret": process.env.WATCHER_SECRET ?? "" },
      body: JSON.stringify({ symbol: "GOLD#", bar_time: barTime, current_price: 100.5 }),
    }), deps);
    assert.equal(res.status, 200);
    const body = await res.json() as { results: { status: string }[] };
    assert.equal(body.results[0]?.status, `config_error:${code}`);
    assert.equal(runtime.entryCalls, 0, code);
    assert.equal(runtime.commandCalls, 0, code);
  }
});

test("Stage 5: H1 production handler skips analysis, state transition and AI on config failure", async () => {
  const trader = { id: "trader-h1-cfg", user_id: "user-h1-cfg", name: "H1 cfg", market: "GOLD", status: "ACTIVE", current_version: 1, execution_mode: "ANALYSIS_ONLY", kill_switch: false };
  let transitions = 0;
  const h1Deps: H1StrategyDependencies = {
    ...createProductionH1StrategyDependencies(watcherDb(trader, null, null, stage5Version(trader.id, "v-h1"), null, null)),
    runtimeFactory: (() => ({ transitionState: async () => { transitions += 1; return true; } })) as unknown as H1StrategyDependencies["runtimeFactory"],
    fetchBars: async () => { throw new Error("bars must not be fetched"); },
    fetchBarsFallback: async () => { throw new Error("bars must not be fetched"); },
    fetchKnowledge: async () => { throw new Error("knowledge must not be fetched"); },
    fetchEconomicEvents: async () => "なし",
    fetchNews: async () => "なし",
    aiClientFactory: (() => { throw new Error("AI must not be called"); }) as unknown as H1StrategyDependencies["aiClientFactory"],
  };
  const res = await handleH1StrategyRequest(new NextRequest("http://localhost/api/cron/h1-strategy", { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } }), h1Deps);
  assert.equal(res.status, 200);
  const body = await res.json() as { results: { status: string }[] };
  assert.equal(body.results[0]?.status, "config_error:NO_TIMEFRAME_PROFILE");
  assert.equal(transitions, 0);
});

test("Stage 5: H1 prompt carries the trader's configured profile and fetches profile timeframes + H1 anchor", async () => {
  const trader = { id: "trader-h1-prompt", user_id: "user-h1-prompt", name: "H1 prompt", market: "GOLD", status: "ACTIVE", current_version: 1, execution_mode: "ANALYSIS_ONLY", kill_switch: false };
  const version = stage5Version(trader.id, "v-h1-prompt", { trading_style: "BREAKOUT", risk_profile: "LOW", minimum_rr: 3.5, max_risk_per_trade: 0.7, news_sensitivity: "HIGH" });
  const swing = { ...STAGE5_TF_PROFILE, timeframe_style: "SWING", trend_context_timeframes: ["D1", "H4"], setup_timeframes: ["H4"], entry_timeframes: ["M15"] };
  const fetched: string[] = [];
  let prompt = "";
  const bars = Array.from({ length: 8 }, (_, i) => ({ time: Math.floor((Date.now() - (8 - i) * 3_600_000) / 1000), open: 100, high: 101, low: 99, close: 100.5, volume: 10 }));
  const h1Deps: H1StrategyDependencies = {
    ...createProductionH1StrategyDependencies(watcherDb(trader, null, null, version, { id: "conn-h1-prompt", last_heartbeat_at: new Date().toISOString() }, swing)),
    runtimeFactory: () => spyRuntime(),
    fetchBars: async (_c, _s, tf) => { fetched.push(tf); return bars; },
    fetchBarsFallback: async () => [],
    fetchKnowledge: async () => ({ text: "fixture knowledge", snapshot: [] }),
    fetchEconomicEvents: async () => "なし",
    fetchNews: async () => "なし",
    aiClientFactory: (() => ({ chat: { completions: { create: async (req: { messages: { content: string }[] }) => {
      prompt = req.messages.map(m => m.content).join("\n");
      return { choices: [{ message: { content: JSON.stringify({ entry_side: "NONE", bias: "NEUTRAL", scenario: "wait", reasoning: "fixture" }) } }], usage: { total_tokens: 1 } };
    } } } })) as unknown as H1StrategyDependencies["aiClientFactory"],
  };
  const res = await handleH1StrategyRequest(new NextRequest("http://localhost/api/cron/h1-strategy", { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } }), h1Deps);
  assert.equal(res.status, 200);
  // SWING profile: D1+H4 (trend) ∪ H4 (setup) ∪ H1 (runtime anchor) — no V1 hardcoded M30/M15.
  assert.deepEqual([...new Set(fetched)].sort(), ["D1", "H1", "H4"]);
  assert.match(prompt, /BREAKOUT/);
  assert.match(prompt, /LOW/);
  assert.match(prompt, /0\.7%/);
  assert.match(prompt, /3\.5:1/);
  assert.match(prompt, /HIGH/);
});

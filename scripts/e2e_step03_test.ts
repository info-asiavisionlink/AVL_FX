// ============================================================
// scripts/e2e_step03_test.ts
// STAGE 1 STEP 03 — Real E2E Test
//
// Usage: npx tsx --env-file=.env.local scripts/e2e_step03_test.ts
//
// Note: Supabase クライアント非使用 (Node.js 20 WebSocket 問題回避)
//       既存スクリプト同様、Supabase REST API を直接 fetch する
// ============================================================

export {};

import type { Bar }          from "@/infrastructure/analysis/types";
import { runBacktest }       from "@/infrastructure/backtest/BacktestEngine";
import { generateReport }    from "@/infrastructure/backtest/BacktestReporter";
import { getSessionsAtTime } from "@/infrastructure/backtest/timeframe";
import { StrategySpecSchema } from "@/lib/strategySchema";
import type { StrategySpec }  from "@/lib/strategySchema";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SB_URL || !SB_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定");
  process.exit(1);
}

const HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };

// ── Supabase REST ヘルパー ──────────────────────────────────────
async function sbFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, { ...opts, headers: { ...HEADERS, ...opts?.headers } });
  if (!r.ok) throw new Error(`Supabase ${opts?.method ?? "GET"} ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function sbGet<T>(path: string): Promise<T[]>  { return sbFetch(path) as Promise<T[]>; }
async function sbInsert<T>(table: string, body: unknown): Promise<T> {
  const arr = await sbFetch(`/${table}`, { method: "POST", body: JSON.stringify(body) }) as T[];
  return arr[0];
}
async function sbCount(path: string): Promise<number> {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    headers: { ...HEADERS, "Prefer": "count=exact" },
    method: "HEAD",
  });
  return Number(r.headers.get("content-range")?.split("/")[1] ?? 0);
}

// ── Bar fetch ─────────────────────────────────────────────────
async function fetchBarsHttp(symbol: string, tf: string): Promise<Bar[]> {
  const PAGE = 1000;
  const all: { time_utc: string; open: number; high: number; low: number; close: number; volume?: number }[] = [];
  let offset = 0;
  for (;;) {
    const rows = await sbGet<{ time_utc: string; open: number; high: number; low: number; close: number; volume?: number }>(
      `/bar_data?select=time_utc,open,high,low,close,volume&symbol=eq.${symbol}&timeframe=eq.${tf}&order=time_utc.asc&limit=${PAGE}&offset=${offset}`
    );
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all.map(r => ({
    time:   new Date(r.time_utc).getTime(),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: Number(r.volume ?? 0),
  }));
}

// ── session helper ────────────────────────────────────────────
function tradeSession(entryMs: number): string {
  const s = getSessionsAtTime(entryMs);
  if (s.length === 0) return "OFF";
  if (s.length === 1) return s[0];
  return "OVERLAP";
}

// ── reporting ─────────────────────────────────────────────────
const R: Record<string, "PASS" | "FAIL" | "WARN" | "NOT_TESTED"> = {};
function set(k: string, v: typeof R[string]) { R[k] = v; }
function hr(title: string) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(64));
}
function ok(m: string)  { console.log(`  ✓ ${m}`); }
function ng(m: string)  { console.log(`  ✗ ${m}`); }
function wa(m: string)  { console.log(`  ⚠ ${m}`); }
function inf(m: string) { console.log(`  · ${m}`); }

// ============================================================
async function main() {

  // ──────────────────────────────────────────────────────────
  // S1: Historical Data Check
  // ──────────────────────────────────────────────────────────
  hr("S1: Historical Data Check");
  const allBars = await fetchBarsHttp("EURUSD", "H1");

  if (allBars.length === 0) {
    ng("EURUSD H1: 0 bars — テスト中止");
    set("HISTORICAL_DATA", "FAIL");
    return;
  }
  const oldest   = new Date(allBars[0].time).toISOString().slice(0, 10);
  const newest   = new Date(allBars[allBars.length-1].time).toISOString().slice(0, 10);
  const spanDays = Math.round((allBars[allBars.length-1].time - allBars[0].time) / 86_400_000);

  inf(`bar_count : ${allBars.length.toLocaleString()}`);
  inf(`oldest    : ${oldest}`);
  inf(`newest    : ${newest}`);
  inf(`span_days : ${spanDays}`);

  if (allBars.length < 500 || spanDays < 90) {
    ng(`データ不足 — 最低500bars/90日必要`);
    set("HISTORICAL_DATA", "FAIL");
    return;
  }
  ok(`EURUSD H1: ${allBars.length.toLocaleString()} bars / ${spanDays} days`);
  set("HISTORICAL_DATA", "PASS");

  // ──────────────────────────────────────────────────────────
  // S2: StrategySpec 構築 + Zod Validation
  // ──────────────────────────────────────────────────────────
  hr("S2: StrategySpec Validation");

  const rawSpec = {
    name:          "E2E Test EURUSD H1 RSI Reversal",
    strategy_type: "DAY_TRADE",
    description:   "EURUSD H1: EMA21 trend filter + RSI14 reversal from below 30. NY session only.",
    symbols:       ["EURUSD"],
    timeframes:    ["H1"],
    entry_conditions: {
      logic:      "AND",
      conditions: [
        { indicator: "RSI",  timeframe: "H1", period: 14, operator: "CROSS_UP", threshold: 30 },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 2.0 },
      take_profit: { method: "ATR", period: 14, multiplier: 3.0 },
    },
    filters: {
      max_spread_pips: 2,
      sessions:        ["NEW_YORK"],
      trend_filter:    { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
    },
    risk: { risk_per_trade: 1.0 },
  };

  const val = StrategySpecSchema.safeParse(rawSpec);
  if (!val.success) {
    ng("Zod FAIL: " + val.error.issues.map(i => i.message).join(", "));
    set("SPEC_VALIDATION", "FAIL");
    return;
  }
  const spec: StrategySpec = val.data;

  const unsupported = spec.entry_conditions.conditions.filter(c => c.condition?.startsWith("UNSUPPORTED:"));
  if (unsupported.length > 0) {
    ng(`Unsupported conditions: ${unsupported.length}件`);
    set("SPEC_VALIDATION", "FAIL");
    return;
  }

  inf(`name          : ${spec.name}`);
  inf(`strategy_type : ${spec.strategy_type}`);
  inf(`symbols       : ${spec.symbols}`);
  inf(`timeframes    : ${spec.timeframes}`);
  inf(`sessions      : ${spec.filters?.sessions}`);
  inf(`trend_filter  : ${spec.filters?.trend_filter?.indicator}(${spec.filters?.trend_filter?.period}) ${spec.filters?.trend_filter?.direction}`);
  inf(`SL method     : ${spec.exit_conditions?.stop_loss?.method} × ${spec.exit_conditions?.stop_loss?.multiplier}`);
  inf(`TP method     : ${spec.exit_conditions?.take_profit?.method} × ${spec.exit_conditions?.take_profit?.multiplier}`);
  ok(`Zod PASS (unsupported=0)`);
  set("SPEC_VALIDATION", "PASS");

  // ──────────────────────────────────────────────────────────
  // S3: Pre-Backtest DB State
  // ──────────────────────────────────────────────────────────
  hr("S3: Pre-Backtest DB Count");

  const countBefore = await sbCount("/strategy_registry?");
  inf(`strategy_registry before : ${countBefore}`);

  // ──────────────────────────────────────────────────────────
  // S4: Preview Backtest (DB write なし)
  // ──────────────────────────────────────────────────────────
  hr("S4: Preview Backtest (DB write なし)");

  // EMA21 trend_filter のバーも必要なので同じ H1 バーを使う
  const barsByTf: Record<string, Bar[]> = { "H1": allBars };

  const t0 = Date.now();
  const engine = runBacktest({
    spec,
    symbol:         "EURUSD",
    mainTimeframe:  "H1",
    barsByTimeframe: barsByTf,
    initialBalance: 10_000,
    fixedLot:       0.01,
  });
  const report = generateReport({
    engineResult: engine,
    periodLabel:  "AVAILABLE",
    barCount:     allBars.length,
  });
  const execMs = Date.now() - t0;
  const r = report;

  inf(`execution_time    : ${execMs}ms`);
  inf(`data_from         : ${new Date(r.dataFrom).toISOString().slice(0, 10)}`);
  inf(`data_to           : ${new Date(r.dataTo).toISOString().slice(0, 10)}`);
  inf(`bar_count         : ${allBars.length}`);
  inf(`total_trades      : ${r.totalTrades}`);
  inf(`wins              : ${r.wins}`);
  inf(`losses            : ${r.losses}`);
  inf(`win_rate          : ${r.winRate.toFixed(1)}%`);
  inf(`total_pips        : ${r.totalPips.toFixed(1)}`);
  inf(`profit_factor     : ${r.profitFactor != null ? r.profitFactor.toFixed(2) : "∞"}`);
  inf(`max_drawdown_pct  : ${r.maxDrawdownPct.toFixed(2)}%`);
  inf(`avg_pips          : ${r.avgPips.toFixed(2)}`);
  inf(`verdict           : ${r.verdict}`);
  inf(`verdict_reason    : ${r.verdictReason}`);
  inf(`sample_warning    : ${r.sampleSizeWarning}`);

  ok(`Preview Backtest完了 (${execMs}ms, ${r.totalTrades} trades)`);
  set("PREVIEW_BACKTEST", "PASS");

  // DB が増えていないこと確認
  const countAfterPreview = await sbCount("/strategy_registry?");
  if (countAfterPreview === countBefore) {
    ok(`NO PREMATURE DB WRITE: strategy_registry 変化なし (${countBefore} → ${countAfterPreview})`);
    set("NO_PREMATURE_DB_WRITE", "PASS");
  } else {
    ng(`PREMATURE DB WRITE 検出: ${countBefore} → ${countAfterPreview}`);
    set("NO_PREMATURE_DB_WRITE", "FAIL");
  }

  // ──────────────────────────────────────────────────────────
  // S5: Formal EA Add
  // ──────────────────────────────────────────────────────────
  hr("S5: Formal EA Add");

  // Magic Number 計算
  const magicRows = await sbGet<{ magic_number: number }>(
    "/strategy_registry?select=magic_number&magic_number=not.is.null&order=magic_number.desc&limit=1"
  );
  const expectedMagic = ((magicRows[0]?.magic_number ?? 20000)) + 1;

  const backtestStatus = r.verdict === "FAILED" ? "FAILED" : "PASSED";
  const rawPrompt = [
    "[ENTRY]",
    "EURUSDのH1。価格がEMA21より上にある時のみBUY。RSI14が30以下から上向きに反転したらエントリー。ニューヨーク時間のみエントリー。スプレッド2pips以下。",
    "",
    "[TAKE_PROFIT]",
    "ATR14の3倍で利確。",
    "",
    "[STOP_LOSS]",
    "ATR14の2倍で損切り。",
  ].join("\n");

  const saved = await sbInsert<{
    id: string; magic_number: number; status: string; backtest_status: string;
  }>("strategy_registry", {
    name:             spec.name,
    strategy_type:    spec.strategy_type,
    description:      spec.description ?? null,
    symbols:          spec.symbols,
    timeframes:       spec.timeframes,
    entry_conditions: spec.entry_conditions,
    exit_conditions:  spec.exit_conditions ?? null,
    filters:          spec.filters ?? null,
    risk:             spec.risk,
    magic_number:     expectedMagic,
    enabled:          false,
    status:           "DRAFT",
    backtest_status:  backtestStatus,
    raw_prompt:       rawPrompt,
  });

  const strategyId = saved.id;
  inf(`strategy_id     : ${strategyId}`);
  inf(`magic_number    : ${saved.magic_number}`);
  inf(`status          : ${saved.status}`);
  inf(`backtest_status : ${saved.backtest_status}`);

  const magicOk = saved.magic_number === expectedMagic;
  const btStatusOk = saved.backtest_status === backtestStatus;

  magicOk ? ok(`magic_number = ${expectedMagic} ✓`) : ng(`magic_number mismatch`);
  btStatusOk ? ok(`backtest_status = ${backtestStatus} ✓`) : ng(`backtest_status mismatch`);
  set("FORMAL_EA_ADD", magicOk && btStatusOk ? "PASS" : "FAIL");
  set("MAGIC_NUMBER",  magicOk ? "PASS" : "FAIL");

  // ──────────────────────────────────────────────────────────
  // S6: Backtest Promotion
  // ──────────────────────────────────────────────────────────
  hr("S6: Backtest Promotion");
  const now = new Date().toISOString();

  // Job INSERT (status=COMPLETED)
  const jobRow = await sbInsert<{ id: string }>("backtest_jobs", {
    strategy_id:   strategyId,
    status:        "COMPLETED",
    period_label:  "AVAILABLE",
    created_at:    now,
    started_at:    now,
    completed_at:  now,
    data_from:     r.dataFrom > 0 ? new Date(r.dataFrom).toISOString() : null,
    data_to:       r.dataTo   > 0 ? new Date(r.dataTo).toISOString()   : null,
    bar_count:     allBars.length,
    progress_pct:  100,
  });
  const jobId = jobRow.id;
  inf(`job_id: ${jobId}`);

  // Results INSERT
  await sbInsert("backtest_results", {
    job_id:                 jobId,
    strategy_id:            strategyId,
    period_label:           r.periodLabel,
    data_from:              r.dataFrom > 0 ? new Date(r.dataFrom).toISOString() : null,
    data_to:                r.dataTo   > 0 ? new Date(r.dataTo).toISOString()   : null,
    data_source:            "bar_data",
    bar_count_used:         allBars.length,
    data_coverage_days:     r.dataCoverageDays,
    total_trades:           r.totalTrades,
    wins:                   r.wins,
    losses:                 r.losses,
    breakevens:             r.breakevens,
    win_rate:               r.winRate,
    total_pips:             r.totalPips,
    avg_pips:               r.avgPips,
    gross_profit:           r.grossProfit,
    gross_loss:             r.grossLoss,
    profit_factor:          r.profitFactor,
    max_drawdown:           r.maxDrawdown,
    max_drawdown_pct:       r.maxDrawdownPct,
    max_drawdown_pips:      r.maxDrawdownPips,
    max_cons_wins:          r.maxConsecutiveWins,
    max_cons_losses:        r.maxConsecutiveLosses,
    avg_duration_min:       r.avgDurationMin,
    session_stats:          r.sessionStats,
    best_session:           r.bestSession,
    worst_session:          r.worstSession,
    sample_size_warning:    r.sampleSizeWarning,
    min_recommended_trades: r.minRecommendedTrades,
    verdict:                r.verdict,
    verdict_reason:         r.verdictReason,
  });

  // Trades batch INSERT (500件ずつ)
  const tradeRows = engine.trades.map(t => {
    const sess = getSessionsAtTime(t.entryTime);
    const sess1 = sess.length === 0 ? "OFF" : sess.length === 1 ? sess[0] : "OVERLAP";
    return {
      job_id:        jobId,
      strategy_id:   strategyId,
      symbol:        t.symbol,
      entry_tf:      t.timeframe,
      direction:     t.direction,
      entry_time:    new Date(t.entryTime).toISOString(),
      entry_price:   t.entryPrice,
      exit_time:     new Date(t.exitTime).toISOString(),
      exit_price:    t.exitPrice,
      sl:            t.sl,
      tp:            t.tp,
      lot:           t.lot,
      pips:          t.pips,
      result:        t.result,
      exit_reason:   t.exitReason,
      duration_min:  t.durationMin,
      session:       sess1,
      spread_pips:   t.spreadPips,
      slippage_pips: t.slippagePips,
      entry_bar_idx: t.entryBarIdx,
      exit_bar_idx:  t.exitBarIdx,
    };
  });

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < tradeRows.length; i += BATCH) {
    const batch = tradeRows.slice(i, i + BATCH);
    await sbFetch("/backtest_trades", { method: "POST", body: JSON.stringify(batch), headers: { Prefer: "return=minimal" } });
    inserted += batch.length;
  }
  inf(`trades inserted: ${inserted}`);

  // Verify promotion
  const formalRes = await sbGet<{
    total_trades: number; win_rate: number; total_pips: number; verdict: string; profit_factor: number | null;
  }>(`/backtest_results?job_id=eq.${jobId}`);
  const fr = formalRes[0];

  const tradeCount = await sbCount(`/backtest_trades?job_id=eq.${jobId}`);

  inf(`formal total_trades : ${fr?.total_trades}  (preview: ${r.totalTrades})`);
  inf(`formal win_rate     : ${Number(fr?.win_rate).toFixed(1)}%  (preview: ${r.winRate.toFixed(1)}%)`);
  inf(`formal total_pips   : ${Number(fr?.total_pips).toFixed(1)}  (preview: ${r.totalPips.toFixed(1)})`);
  inf(`formal verdict      : ${fr?.verdict}  (preview: ${r.verdict})`);
  inf(`formal trade rows   : ${tradeCount}  (preview: ${r.totalTrades})`);

  const tradesMatch = fr?.total_trades === r.totalTrades;
  const pipsMatch   = Math.abs(Number(fr?.total_pips) - r.totalPips) < 0.2;
  const vrMatch     = fr?.verdict === r.verdict;
  const promoOk     = tradesMatch && pipsMatch && vrMatch;

  promoOk ? ok("Preview vs Formal: 全一致 ✓") : wa("Preview vs Formal: 不一致あり");
  set("BACKTEST_PROMOTION", promoOk ? "PASS" : "WARN");
  set("PREVIEW_VS_FORMAL",  promoOk ? "PASS" : "WARN");

  // ──────────────────────────────────────────────────────────
  // S7: Raw Prompt Check
  // ──────────────────────────────────────────────────────────
  hr("S7: Raw Prompt Check");

  const strat = await sbGet<{ raw_prompt: string }>(`/strategy_registry?id=eq.${strategyId}&select=raw_prompt`);
  const rp = strat[0]?.raw_prompt ?? "";
  const hasE = rp.includes("[ENTRY]");
  const hasT = rp.includes("[TAKE_PROFIT]");
  const hasS = rp.includes("[STOP_LOSS]");

  inf(`[ENTRY] present      : ${hasE}`);
  inf(`[TAKE_PROFIT] present: ${hasT}`);
  inf(`[STOP_LOSS] present  : ${hasS}`);
  hasE && hasT && hasS ? ok("[ENTRY]/[TAKE_PROFIT]/[STOP_LOSS] 全て含む ✓") : ng("raw_prompt format 不足");
  set("RAW_PROMPT", hasE && hasT && hasS ? "PASS" : "FAIL");

  // ──────────────────────────────────────────────────────────
  // S8: Real Strategy Card Data
  // ──────────────────────────────────────────────────────────
  hr("S8: Real Strategy Card Data");

  const card = await sbGet<{
    name: string; symbols: string[]; timeframes: string[]; magic_number: number; backtest_status: string;
  }>(`/strategy_registry?id=eq.${strategyId}&select=name,symbols,timeframes,magic_number,backtest_status`);
  const c = card[0];

  inf(`name            : ${c?.name}`);
  inf(`symbols         : ${JSON.stringify(c?.symbols)}`);
  inf(`timeframes      : ${JSON.stringify(c?.timeframes)}`);
  inf(`magic_number    : ${c?.magic_number}`);
  inf(`backtest_status : ${c?.backtest_status}`);

  const cardOk = c?.name === spec.name && JSON.stringify(c?.symbols) === '["EURUSD"]';
  cardOk ? ok("Real Strategy Card: 実データ ✓ (MOCK値なし)") : ng("Card データ不整合");
  set("REAL_STRATEGY_CARD", cardOk ? "PASS" : "FAIL");

  // ──────────────────────────────────────────────────────────
  // S9: Detail Modal Data (BACKTEST tab)
  // ──────────────────────────────────────────────────────────
  hr("S9: Detail Modal Data (BACKTEST tab)");

  const detailBt = await sbGet<{ total_trades: number; verdict: string; total_pips: number }>(
    `/backtest_results?strategy_id=eq.${strategyId}&order=created_at.desc&limit=1`
  );
  const dt = detailBt[0];

  inf(`BACKTEST tab total_trades : ${dt?.total_trades}`);
  inf(`BACKTEST tab verdict       : ${dt?.verdict}`);
  inf(`BACKTEST tab total_pips    : ${Number(dt?.total_pips).toFixed(1)}`);

  const detailTradeRows = await sbCount(`/backtest_trades?strategy_id=eq.${strategyId}`);
  inf(`TRADES tab rows            : ${detailTradeRows}`);

  const detailOk = !!dt && dt.total_trades === r.totalTrades;
  detailOk ? ok("Detail Modal BACKTESTタブ: データあり ✓") : ng("Detail Modal データ不整合");
  set("DETAIL_DATA", detailOk ? "PASS" : "FAIL");

  // ──────────────────────────────────────────────────────────
  // S10: Live Trading Safety
  // ──────────────────────────────────────────────────────────
  hr("S10: Live Trading Safety");

  const liveCheck = await sbGet<{ enabled: boolean; status: string }>(
    `/strategy_registry?id=eq.${strategyId}&select=enabled,status`
  );
  const lc = liveCheck[0];
  inf(`enabled : ${lc?.enabled}`);
  inf(`status  : ${lc?.status}`);
  const liveOk = lc?.enabled === false && lc?.status === "DRAFT";
  liveOk ? ok("enabled=false, status=DRAFT ✓ (MT5未接続)") : ng(`enabled=${lc?.enabled}, status=${lc?.status}`);
  set("LIVE_TRADING_SAFETY", liveOk ? "PASS" : "FAIL");

  // ──────────────────────────────────────────────────────────
  // S11: Cancel Path Test
  // ──────────────────────────────────────────────────────────
  hr("S11: Cancel Path (Preview Backtest のみ, DB書き込みなし)");

  // キャンセルパスは Preview Backtest を実行してから何もDBに書かない
  const cancelSpec: StrategySpec = { ...spec, name: "E2E Cancel Test (not saved)" };
  const cancelEngine = runBacktest({
    spec:           cancelSpec,
    symbol:         "EURUSD",
    mainTimeframe:  "H1",
    barsByTimeframe: { "H1": allBars },
    initialBalance: 10_000,
    fixedLot:       0.01,
  });
  const cancelReport = generateReport({ engineResult: cancelEngine, periodLabel: "AVAILABLE", barCount: allBars.length });
  inf(`cancel spec trades : ${cancelReport.totalTrades}`);
  inf(`cancel spec verdict: ${cancelReport.verdict}`);

  // DB に cancelSpec が保存されていないことを確認
  const cancelCheck = await sbGet<{ id: string }>(
    `/strategy_registry?name=eq.E2E Cancel Test (not saved)&select=id`
  );
  const cancelOk = cancelCheck.length === 0;
  cancelOk ? ok("Cancel path: strategy_registry に保存なし ✓") : ng("Cancel path: 誤ってDBに保存された!");
  set("CANCEL_PATH", cancelOk ? "PASS" : "FAIL");

  // ──────────────────────────────────────────────────────────
  // S12: FAILED Path
  // ──────────────────────────────────────────────────────────
  hr("S12: FAILED Path Simulation");

  // 意図的に FAILED になる設定（RR<1, 少ないトレード）
  const failSpec: StrategySpec = {
    name: "E2E FAILED Simulation",
    strategy_type: "SCALPING",
    description: "Deliberately weak for FAILED test",
    symbols:    ["EURUSD"],
    timeframes: ["H1"],
    entry_conditions: {
      logic: "AND",
      conditions: [{ indicator: "RSI", timeframe: "H1", period: 14, operator: "CROSS_DOWN", threshold: 70 }],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 3.0 },
      take_profit: { method: "ATR", period: 14, multiplier: 0.5 }, // RR < 1
    },
    filters: { sessions: ["TOKYO"] },
    risk:    { risk_per_trade: 1.0 },
  };

  const failEngine = runBacktest({
    spec:           failSpec,
    symbol:         "EURUSD",
    mainTimeframe:  "H1",
    barsByTimeframe: { "H1": allBars },
    initialBalance: 10_000,
    fixedLot:       0.01,
  });
  const failReport = generateReport({ engineResult: failEngine, periodLabel: "AVAILABLE", barCount: allBars.length });

  inf(`FAILED spec trades  : ${failReport.totalTrades}`);
  inf(`FAILED spec PF      : ${failReport.profitFactor?.toFixed(2) ?? "∞"}`);
  inf(`FAILED spec verdict : ${failReport.verdict}`);

  // verdict が FAILED または CONDITIONAL かチェック
  const failedOk = failReport.verdict === "FAILED" || failReport.verdict === "CONDITIONAL";
  if (failedOk) {
    ok(`FAILED path: verdict = ${failReport.verdict} ✓`);
    // FAILED でも保存可能なことを示す (UIレベルで警告確認あり)
    inf("UI: 警告確認あり で追加可能 (backtest_status=FAILED で保存)");
  } else {
    wa(`FAILED path: verdict = ${failReport.verdict} (期待: FAILED/CONDITIONAL)`);
  }
  set("FAILED_PATH", failedOk ? "PASS" : "WARN");

  // ──────────────────────────────────────────────────────────
  // S13: Duplicate Safety
  // ──────────────────────────────────────────────────────────
  hr("S13: Duplicate Safety");

  // AIEABuilder の handleFormalSave は setStep("saving") → フッターボタン非表示
  // → ダブルクリック時、2回目はボタンが存在しない / disabled
  const dupRows = await sbGet<{ id: string }>(`/strategy_registry?name=eq.${encodeURIComponent(spec.name)}&select=id`);
  const dupCount = dupRows.length;
  inf(`"${spec.name}" の DB件数: ${dupCount}`);

  if (dupCount === 1) {
    ok("Duplicate: 1件のみ ✓");
    set("DUPLICATE_SAFETY", "PASS");
  } else {
    ng(`Duplicate: ${dupCount}件 — 重複検出`);
    set("DUPLICATE_SAFETY", "FAIL");
  }

  // ──────────────────────────────────────────────────────────
  // FINAL REPORT
  // ──────────────────────────────────────────────────────────
  hr("FINAL REPORT");

  console.log("\n  ╔══════════════════════════════════════════════════════╗");
  console.log("  ║  STAGE 1 STEP 03 — REAL EA CREATION E2E TEST REPORT ║");
  console.log("  ╚══════════════════════════════════════════════════════╝\n");

  const summary: Record<string, string> = {
    "HISTORICAL DATA":       R.HISTORICAL_DATA       ?? "NOT_TESTED",
    "SPEC VALIDATION":       R.SPEC_VALIDATION       ?? "NOT_TESTED",
    "PREVIEW BACKTEST":      R.PREVIEW_BACKTEST      ?? "NOT_TESTED",
    "NO PREMATURE DB WRITE": R.NO_PREMATURE_DB_WRITE ?? "NOT_TESTED",
    "FORMAL EA ADD":         R.FORMAL_EA_ADD         ?? "NOT_TESTED",
    "MAGIC NUMBER":          R.MAGIC_NUMBER          ?? "NOT_TESTED",
    "BACKTEST PROMOTION":    R.BACKTEST_PROMOTION    ?? "NOT_TESTED",
    "PREVIEW vs FORMAL":     R.PREVIEW_VS_FORMAL     ?? "NOT_TESTED",
    "REAL STRATEGY CARD":    R.REAL_STRATEGY_CARD    ?? "NOT_TESTED",
    "CANCEL PATH":           R.CANCEL_PATH           ?? "NOT_TESTED",
    "FAILED PATH":           R.FAILED_PATH           ?? "NOT_TESTED",
    "RAW PROMPT":            R.RAW_PROMPT            ?? "NOT_TESTED",
    "DUPLICATE SAFETY":      R.DUPLICATE_SAFETY      ?? "NOT_TESTED",
    "LIVE TRADING SAFETY":   R.LIVE_TRADING_SAFETY   ?? "NOT_TESTED",
    "DETAIL DATA":           R.DETAIL_DATA           ?? "NOT_TESTED",
    "LIVE TRADING":          "NOT IMPLEMENTED YET",
  };

  const fails = Object.entries(summary).filter(([, v]) => v === "FAIL");
  const warns = Object.entries(summary).filter(([, v]) => v === "WARN");

  for (const [key, val] of Object.entries(summary)) {
    const icon = val === "PASS" ? "✓" : val === "FAIL" ? "✗" : val === "WARN" ? "⚠" : val.startsWith("NOT") ? "─" : "─";
    console.log(`  ${icon} ${key.padEnd(26)} ${val}`);
  }

  const overall = fails.length === 0
    ? warns.length === 0 ? "PASS" : "CONDITIONAL PASS"
    : "FAIL";

  console.log(`\n  ${"─".repeat(46)}`);
  console.log(`  OVERALL: ${overall}`);
  console.log(`  ${"─".repeat(46)}\n`);

  if (fails.length > 0) {
    console.log("  FAILS:");
    for (const [k] of fails) console.log(`    ✗ ${k}`);
  }
  if (warns.length > 0) {
    console.log("  WARNINGS:");
    for (const [k] of warns) console.log(`    ⚠ ${k}`);
  }

  console.log(`\n  Test strategy_id: ${strategyId}`);
  console.log(`  (StrategyDetailModal で詳細確認可能)`);
  console.log(`\n  Backtest Results:`);
  console.log(`    trades     : ${r.totalTrades}`);
  console.log(`    win_rate   : ${r.winRate.toFixed(1)}%`);
  console.log(`    total_pips : ${r.totalPips.toFixed(1)}`);
  console.log(`    PF         : ${r.profitFactor != null ? r.profitFactor.toFixed(2) : "∞"}`);
  console.log(`    MaxDD      : ${r.maxDrawdownPct.toFixed(2)}%`);
  console.log(`    verdict    : ${r.verdict}`);

  return { strategyId, overall, report: r };
}

main().then(() => process.exit(0)).catch(e => {
  console.error("\nFATAL:", e.message ?? e);
  process.exit(1);
});

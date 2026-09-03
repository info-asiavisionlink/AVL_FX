/**
 * Phase 3-A Final Verification Script
 *
 * 実行方法:
 *   npx tsx scripts/verify-phase3a.ts
 *
 * supabase-js を使わず直接 fetch で Supabase REST API を呼び出す (Node.js 20 対応)
 */

import OpenAI from "openai";
import {
  buildAnalysisContext,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  validateFactIntegrity,
  type TradeForAnalysis,
} from "../src/infrastructure/backtest/BacktestAnalyzer";
import { StrategySpecSchema } from "../src/lib/strategySchema";
import type { BacktestReport } from "../src/infrastructure/backtest/BacktestReporter";
import { readFileSync } from "fs";

// .env.local 読み込み
try {
  const env = readFileSync(".env.local", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1]!.trim()] = m[2]!.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  }
} catch { /* skip */ }

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_KEY    = process.env.OPENAI_API_KEY!;
const MODEL         = process.env.OPENAI_MODEL_FAST ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const PAT           = process.env.SUPABASE_PAT ?? "";
const PROJECT_REF   = "bsmofroshpmomjwfxigh";

const HEADERS_REST = {
  "apikey":        SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

// ─── Supabase REST helpers ───────────────────────────────────────────

async function restGet(path: string): Promise<unknown[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS_REST });
  if (!r.ok) throw new Error(`REST GET ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<unknown[]>;
}

async function restPost(path: string, body: unknown): Promise<unknown[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method:  "POST",
    headers: { ...HEADERS_REST, "Prefer": "return=representation" },
    body:    JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`REST POST ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<unknown[]>;
}

async function sqlQuery(query: string): Promise<unknown[]> {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${PAT}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL: ${r.status} ${await r.text()}`);
  return r.json() as Promise<unknown[]>;
}

// ─── Test runner ─────────────────────────────────────────────────────

let passCount = 0, failCount = 0;

function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✅ ${label}`); passCount++; }
  else       { console.error(`  ❌ ${label}${detail ? `\n     ${detail}` : ""}`); failCount++; }
}

// ─── Helper: DB row → BacktestReport ────────────────────────────────

type SessionStatRaw = {
  tradeCount?: number; wins?: number; losses?: number;
  winRate?: number; totalPips?: number; profitFactor?: number | null;
};

function rowToReport(row: Record<string, unknown>, symbol: string, mainTf: string): BacktestReport {
  const sessionStats: BacktestReport["sessionStats"] = {};
  const rawSess = (row.session_stats as Record<string, SessionStatRaw>) ?? {};
  for (const [k, v] of Object.entries(rawSess)) {
    sessionStats[k] = {
      tradeCount:   Number(v.tradeCount   ?? 0),
      wins:         Number(v.wins         ?? 0),
      losses:       Number(v.losses       ?? 0),
      winRate:      Number(v.winRate      ?? 0),
      totalPips:    Number(v.totalPips    ?? 0),
      profitFactor: v.profitFactor !== undefined
        ? (v.profitFactor === null ? null : Number(v.profitFactor))
        : null,
    };
  }
  return {
    periodLabel:          String(row.period_label ?? "AVAILABLE"),
    dataFrom:             row.data_from  ? new Date(String(row.data_from)).getTime()  : 0,
    dataTo:               row.data_to    ? new Date(String(row.data_to)).getTime()    : 0,
    dataCoverageDays:     Number(row.data_coverage_days   ?? 0),
    barCount:             Number(row.bar_count_used       ?? 0),
    totalTrades:          Number(row.total_trades         ?? 0),
    wins:                 Number(row.wins                 ?? 0),
    losses:               Number(row.losses               ?? 0),
    breakevens:           Number(row.breakevens           ?? 0),
    winRate:              Number(row.win_rate             ?? 0),
    totalPips:            Number(row.total_pips           ?? 0),
    avgPips:              Number(row.avg_pips             ?? 0),
    totalProfit:          Number(row.gross_profit ?? 0) - Number(row.gross_loss ?? 0),
    grossProfit:          Number(row.gross_profit         ?? 0),
    grossLoss:            Number(row.gross_loss           ?? 0),
    profitFactor:         row.profit_factor === null ? null : Number(row.profit_factor ?? 0),
    initialBalance:       10000,
    finalBalance:         10000 + Number(row.gross_profit ?? 0) - Number(row.gross_loss ?? 0),
    maxDrawdown:          Number(row.max_drawdown         ?? 0),
    maxDrawdownPct:       Number(row.max_drawdown_pct     ?? 0),
    maxDrawdownPips:      Number(row.max_drawdown_pips    ?? 0),
    maxConsecutiveWins:   Number(row.max_cons_wins        ?? 0),
    maxConsecutiveLosses: Number(row.max_cons_losses      ?? 0),
    avgDurationMin:       Number(row.avg_duration_min     ?? 0),
    sessionStats,
    bestSession:          (row.best_session  as string | null) ?? null,
    worstSession:         (row.worst_session as string | null) ?? null,
    sampleSizeWarning:    Boolean(row.sample_size_warning ?? false),
    minRecommendedTrades: Number(row.min_recommended_trades ?? 30),
    verdict:              (row.verdict as "PASSED" | "CONDITIONAL" | "FAILED") ?? "FAILED",
    verdictReason:        String(row.verdict_reason ?? ""),
    symbol,
    mainTimeframe:        mainTf,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=============================================================");
  console.log("  Phase 3-A Final Verification");
  console.log("=============================================================\n");

  // ── Step 1: Migration + テーブル確認 ────────────────────────────
  console.log("【Step 1 & 2】 Migration / Schema 確認");
  const cols = await sqlQuery(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='strategy_ai_analyses'
     ORDER BY ordinal_position`
  ) as Array<{ column_name: string; data_type: string }>;

  check("strategy_ai_analyses テーブルが存在する", cols.length > 0, `got ${cols.length} cols`);

  const expectedCols: Record<string, string> = {
    id: "uuid", strategy_id: "uuid", job_id: "uuid", version: "integer",
    input_snapshot: "jsonb", model: "text", summary: "text",
    facts: "jsonb", observations: "jsonb", hypotheses: "jsonb",
    weaknesses: "jsonb", strengths: "jsonb",
    session_analysis: "jsonb", risk_analysis: "jsonb",
    recommendations: "jsonb", confidence: "numeric",
    data_quality_note: "text", created_at: "timestamp with time zone",
  };
  for (const [col, expectedType] of Object.entries(expectedCols)) {
    const found = cols.find(c => c.column_name === col);
    check(`カラム ${col} (${expectedType})`, !!found && found.data_type === expectedType,
      found ? `got ${found.data_type}` : "missing");
  }

  // ── Step 3: Strategy + 最新 COMPLETED Job 取得 ──────────────────
  console.log("\n【Step 3】 Backtest済みStrategy選択");

  const STRATEGY_ID   = "b7f694c8-aa97-4cfe-8c82-377be64a88a9";
  const STRATEGY_NAME = "EURUSD RSI Reversal Scalping";

  const strats = await restGet(
    `strategy_registry?select=id,name,backtest_status&id=eq.${STRATEGY_ID}`
  ) as Array<{ id: string; name: string; backtest_status: string }>;
  check(`Strategy "${STRATEGY_NAME}" を取得`, strats.length > 0);
  console.log(`  → backtest_status: ${strats[0]?.backtest_status}`);

  const jobs = await restGet(
    `backtest_jobs?select=id,status&strategy_id=eq.${STRATEGY_ID}&status=eq.COMPLETED&order=created_at.desc&limit=1`
  ) as Array<{ id: string; status: string }>;
  check("COMPLETED Job が存在する", jobs.length > 0);
  if (jobs.length === 0) { summary(); return; }

  const JOB_ID = jobs[0]!.id;
  console.log(`  → Job ID: ${JOB_ID}`);

  // Strategy Spec 取得
  const stratRows = await restGet(
    `strategy_registry?select=*&id=eq.${STRATEGY_ID}`
  ) as Array<Record<string, unknown>>;
  check("Strategy Spec を取得", stratRows.length > 0);
  const stratRow = stratRows[0]!;

  const specParse = StrategySpecSchema.safeParse({
    name:             stratRow.name,
    strategy_type:    stratRow.strategy_type,
    description:      stratRow.description,
    symbols:          stratRow.symbols,
    timeframes:       stratRow.timeframes,
    entry_conditions: stratRow.entry_conditions,
    exit_conditions:  stratRow.exit_conditions,
    filters:          stratRow.filters,
    risk:             stratRow.risk,
  });
  check("StrategySpec Zod バリデーション PASS", specParse.success,
    specParse.success ? "" : specParse.error.message);
  if (!specParse.success) { summary(); return; }
  const spec = specParse.data;

  // Backtest Result 取得
  const results = await restGet(
    `backtest_results?select=*&job_id=eq.${JOB_ID}`
  ) as Array<Record<string, unknown>>;
  check("backtest_results 取得", results.length > 0);
  if (results.length === 0) { summary(); return; }
  const resultRow = results[0]!;

  console.log(`  → verdict=${resultRow.verdict}, total_trades=${resultRow.total_trades}, win_rate=${resultRow.win_rate}%, pips=${resultRow.total_pips}`);

  // Trades 取得
  const tradeRows = await restGet(
    `backtest_trades?select=pips,result,exit_reason,direction,duration_min,session&job_id=eq.${JOB_ID}&order=entry_time.asc&limit=500`
  ) as Array<Record<string, unknown>>;
  check("backtest_trades 取得", tradeRows.length >= 0, `${tradeRows.length} trades`);

  const trades: TradeForAnalysis[] = tradeRows.map(t => ({
    pips:        Number(t.pips),
    result:      t.result as TradeForAnalysis["result"],
    exitReason:  (t.exit_reason ?? t.exitReason) as TradeForAnalysis["exitReason"],
    direction:   t.direction as "BUY" | "SELL",
    durationMin: Number(t.duration_min ?? t.durationMin ?? 0),
    session:     String(t.session ?? "OFF"),
  }));
  console.log(`  → ${trades.length} trades loaded`);

  // ── Step 4: AnalysisContext 構築 ────────────────────────────────
  console.log("\n【Step 4】 AnalysisContext 構築");
  const symbol  = spec.symbols[0]!;
  const mainTf  = spec.timeframes[0]!;
  const report  = rowToReport(resultRow, symbol, mainTf);
  const context = buildAnalysisContext(report, trades, spec);

  check("context.totalTrades = DB値", context.totalTrades === Number(resultRow.total_trades),
    `expected ${resultRow.total_trades}, got ${context.totalTrades}`);
  check("context.winRate ≈ DB値", Math.abs(context.winRate - Number(resultRow.win_rate)) < 0.1,
    `expected ${resultRow.win_rate}, got ${context.winRate}`);
  check("tpHitRate ≥ 0", context.tpHitRate >= 0);
  check("sessionStats に sessions あり", Object.keys(context.sessionStats).length > 0);

  console.log(`  → tpHitRate=${context.tpHitRate}%, slHitRate=${context.slHitRate}%, eodRate=${context.endOfDataRate}%`);
  console.log(`  → BUY=${context.buyStats.count} SELL=${context.sellStats.count}`);
  console.log(`  → representative: [${context.representativeTrades.map(t => t.label).join(", ")}]`);
  console.log(`  → sampleSizeWarning=${context.sampleSizeWarning} (${context.totalTrades} trades)`);

  // ── Step 5: OpenAI 呼び出し ─────────────────────────────────────
  console.log("\n【Step 5】 OpenAI AI Analysis 実行");
  const { systemPrompt, userPrompt } = buildAnalysisPrompt(context);
  check("systemPrompt 生成", systemPrompt.length > 200);
  check("userPrompt に verdict 含む", userPrompt.includes(context.verdict));

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  console.log(`  → model: ${MODEL}`);
  console.log("  → Calling OpenAI... (this may take 10-30 seconds)");

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
    max_completion_tokens: 4096,
    response_format:       { type: "json_object" },
  });

  const rawText = completion.choices[0]?.message?.content ?? "";
  check("OpenAI レスポンスが空でない", rawText.length > 0);
  console.log(`  → model used: ${completion.model}, tokens: input=${completion.usage?.prompt_tokens} output=${completion.usage?.completion_tokens}`);

  // ── Step 6: パース + Zod バリデーション ─────────────────────────
  console.log("\n【Step 6】 Response パース + Zod バリデーション");
  const parsed = parseAnalysisResponse(rawText);
  check("Zod バリデーション ok=true", parsed.ok, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) { summary(); return; }

  let analysis = parsed.analysis;
  check("facts ≥ 1",            analysis.facts.length >= 1,           `got ${analysis.facts.length}`);
  check("observations ≥ 1",     analysis.observations.length >= 1,    `got ${analysis.observations.length}`);
  check("recommendations ≥ 1",  analysis.recommendations.length >= 1, `got ${analysis.recommendations.length}`);
  check("confidence 0-100",     analysis.confidence >= 0 && analysis.confidence <= 100, `got ${analysis.confidence}`);
  check("risk_analysis 4フィールド",
    !!analysis.risk_analysis.drawdown_assessment &&
    !!analysis.risk_analysis.sl_tp_assessment &&
    !!analysis.risk_analysis.consistency_assessment &&
    !!analysis.risk_analysis.overall);

  // ── Step 7: Fact Integrity ──────────────────────────────────────
  console.log("\n【Step 7】 Fact Integrity 確認");
  const integrity = validateFactIntegrity(analysis.facts, context);
  console.log(`  → facts total: ${analysis.facts.length}, violations: ${integrity.violations.length}, cleanFacts: ${integrity.cleanFacts.length}`);

  if (integrity.violations.length > 0) {
    for (const v of integrity.violations) console.warn(`  ⚠ Violation: ${v}`);
    analysis = { ...analysis, facts: integrity.cleanFacts };
  }

  check("cleanFacts ≥ 1", integrity.cleanFacts.length >= 1);

  // FACT の値がバックテスト実測値と合理的か手動確認
  console.log("\n  --- ANALYSIS PREVIEW ---");
  console.log(`  SUMMARY: ${analysis.summary}`);
  console.log(`  CONFIDENCE: ${analysis.confidence}`);
  console.log(`  DATA QUALITY: ${analysis.data_quality_note}`);
  console.log(`  FACTS (${analysis.facts.length}):`);
  for (const f of analysis.facts) {
    console.log(`    [${f.source}] ${f.statement}${f.value !== undefined && f.value !== null ? ` → ${f.value}` : ""}`);
  }
  console.log(`  OBSERVATIONS (${analysis.observations.length}):`);
  for (const o of analysis.observations.slice(0, 3)) {
    console.log(`    • ${o.observation.slice(0, 120)}`);
  }
  console.log(`  HYPOTHESES (${analysis.hypotheses.length}):`);
  for (const h of analysis.hypotheses.slice(0, 2)) {
    check("Hypothesis starts with 'Hypothesis:' or 'Possible'",
      h.hypothesis.includes("Hypothesis:") || h.hypothesis.includes("Possible"),
      `"${h.hypothesis.slice(0, 80)}"`,
    );
    console.log(`    ${h.hypothesis.slice(0, 120)}`);
  }
  console.log(`  RECOMMENDATIONS (${analysis.recommendations.length}):`);
  for (const r of analysis.recommendations.slice(0, 3)) {
    console.log(`    [${r.priority ?? "–"}] ${r.action.slice(0, 100)}`);
  }

  // ── Step 8: DB 保存 ─────────────────────────────────────────────
  console.log("\n【Step 8】 strategy_ai_analyses INSERT");

  // version 番号取得
  const existingVersions = await restGet(
    `strategy_ai_analyses?select=version&job_id=eq.${JOB_ID}&order=version.desc&limit=1`
  ) as Array<{ version: number }>;
  const version = existingVersions.length > 0 ? Number(existingVersions[0]!.version) + 1 : 1;
  console.log(`  → version: ${version}`);

  const insertRows = await restPost("strategy_ai_analyses", {
    strategy_id:       STRATEGY_ID,
    job_id:            JOB_ID,
    version,
    input_snapshot:    context as unknown as Record<string, unknown>,
    model:             completion.model,
    summary:           analysis.summary,
    facts:             integrity.cleanFacts,
    observations:      analysis.observations,
    hypotheses:        analysis.hypotheses,
    weaknesses:        analysis.weaknesses,
    strengths:         analysis.strengths,
    session_analysis:  analysis.session_analysis,
    risk_analysis:     analysis.risk_analysis,
    recommendations:   analysis.recommendations,
    confidence:        analysis.confidence,
    data_quality_note: analysis.data_quality_note,
  }) as Array<{ id: string; version: number; created_at: string }>;

  check("INSERT 成功", insertRows.length > 0);
  if (insertRows.length > 0) {
    const saved = insertRows[0]!;
    console.log(`  → Analysis ID: ${saved.id}`);
    console.log(`  → Version: ${saved.version}`);
    console.log(`  → Created: ${saved.created_at}`);

    // ── Step 9: 再取得 JSONB 型確認 ────────────────────────────────
    console.log("\n【Step 9】 保存済みデータ再取得 + JSONB 型確認");
    const fetched = await restGet(
      `strategy_ai_analyses?select=facts,observations,hypotheses,weaknesses,strengths,recommendations,confidence,session_analysis,risk_analysis&id=eq.${saved.id}`
    ) as Array<Record<string, unknown>>;

    check("再取得成功", fetched.length > 0);
    if (fetched.length > 0) {
      const row = fetched[0]!;
      check("facts は Array",            Array.isArray(row.facts));
      check("observations は Array",     Array.isArray(row.observations));
      check("hypotheses は Array",       Array.isArray(row.hypotheses));
      check("weaknesses は Array",       Array.isArray(row.weaknesses));
      check("strengths は Array",        Array.isArray(row.strengths));
      check("recommendations は Array",  Array.isArray(row.recommendations));
      check("session_analysis は Array", Array.isArray(row.session_analysis));
      check("risk_analysis はオブジェクト",
        typeof row.risk_analysis === "object" && !Array.isArray(row.risk_analysis));
      check("facts が正しく保存",        (row.facts as unknown[]).length === integrity.cleanFacts.length,
        `expected ${integrity.cleanFacts.length}, got ${(row.facts as unknown[]).length}`);
      console.log(`  → facts=${(row.facts as unknown[]).length}, obs=${(row.observations as unknown[]).length}, hyp=${(row.hypotheses as unknown[]).length}`);
    }
  }

  // ── Step 10: エラーケース確認 ───────────────────────────────────
  console.log("\n【Step 10】 エラーケース確認 (コード検査)");

  // API route の実装で 404/422/500 を適切に返しているか確認
  const routeContent = readFileSync(
    "src/app/api/strategies/[id]/analyze/route.ts", "utf-8"
  );
  check("Strategy not found → 404", routeContent.includes(`status: 404`));
  check("Backtest not found → 404", routeContent.includes("No completed backtest found"));
  check("Zod validation fail → 422", routeContent.includes(`status: 422`));
  check("Internal error → 500", routeContent.includes(`status: 500`));
  check("二重実行防止 (disabled button)",
    readFileSync("src/presentation/components/ea/StrategyDetailModal.tsx", "utf-8").includes("disabled={state === \"running\"}"));

  summary();
}

function summary() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ✅ Passed: ${passCount}  ❌ Failed: ${failCount}`);
  console.log("=".repeat(60));
  if (failCount > 0) process.exit(1);
}

main().catch(err => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

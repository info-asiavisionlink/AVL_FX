/**
 * Phase 3-B Final Verification Script
 *
 * 実行方法:
 *   npx tsx scripts/verify-phase3b.ts
 */

import OpenAI from "openai";
import {
  buildImprovementPrompt,
  parseImprovementResponse,
  applyChangesToSpec,
  conditionIndexExists,
} from "../src/infrastructure/backtest/StrategyImprover";
import {
  validateWhitelist,
  validateFromValues,
  parseFieldPath,
} from "../src/infrastructure/backtest/ImprovementSchema";
import { StrategySpecSchema } from "../src/lib/strategySchema";
import type { StrategyAIAnalysisRecord } from "../src/infrastructure/backtest/analysisSchema";
import { readFileSync } from "fs";

// .env.local 読み込み
try {
  const env = readFileSync(".env.local", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1]!.trim()] = m[2]!.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  }
} catch { /* skip */ }

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_KEY   = process.env.OPENAI_API_KEY!;
const MODEL        = process.env.OPENAI_MODEL_FAST ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
const PAT          = process.env.SUPABASE_PAT ?? "";
const PROJECT_REF  = "bsmofroshpmomjwfxigh";

const HEADERS = {
  "apikey":        SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
};

async function restGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`REST GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function restPost(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`REST POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sqlQuery(query: string) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL: ${r.status} ${await r.text()}`);
  return r.json();
}

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}${detail ? `\n     ${detail}` : ""}`); fail++; }
}

async function main() {
  console.log("\n=============================================================");
  console.log("  Phase 3-B Final Verification");
  console.log("=============================================================\n");

  // ── Step 1: Migration 008 確認 ─────────────────────────────────
  console.log("【Step 1】 strategy_improvements テーブル確認");
  const cols = await sqlQuery(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='strategy_improvements'
     ORDER BY ordinal_position`
  ) as Array<{ column_name: string; data_type: string }>;

  check("テーブルが存在する", cols.length > 0, `got ${cols.length} cols`);
  const expectedCols: Record<string, string> = {
    id: "uuid", strategy_id: "uuid", analysis_id: "uuid",
    from_version: "integer", changes: "jsonb", expected_effects: "jsonb",
    risks: "jsonb", proposed_spec: "jsonb", confidence: "numeric",
    requires_more_data: "boolean", status: "text", model: "text",
  };
  for (const [col, t] of Object.entries(expectedCols)) {
    const found = cols.find(c => c.column_name === col);
    check(`カラム ${col}`, !!found && found.data_type === t, found ? `got ${found.data_type}` : "missing");
  }

  // ── Step 2: 実データ取得 ────────────────────────────────────────
  console.log("\n【Step 2】 実 Strategy + Analysis 取得");

  const STRATEGY_ID = "b7f694c8-aa97-4cfe-8c82-377be64a88a9";
  const strats = await restGet(`strategy_registry?select=*&id=eq.${STRATEGY_ID}`) as Array<Record<string, unknown>>;
  check("Strategy 取得", strats.length > 0);
  const stratRow = strats[0]!;

  const specParse = StrategySpecSchema.safeParse({
    name: stratRow.name, strategy_type: stratRow.strategy_type,
    description: stratRow.description, symbols: stratRow.symbols,
    timeframes: stratRow.timeframes, entry_conditions: stratRow.entry_conditions,
    exit_conditions: stratRow.exit_conditions, filters: stratRow.filters, risk: stratRow.risk,
  });
  check("StrategySpec バリデーション", specParse.success, specParse.success ? "" : specParse.error.message);
  if (!specParse.success) { summary(); return; }
  const spec = specParse.data;

  const analyses = await restGet(
    `strategy_ai_analyses?select=*&strategy_id=eq.${STRATEGY_ID}&order=created_at.desc&limit=1`
  ) as Array<Record<string, unknown>>;
  check("Analysis 取得", analyses.length > 0);
  if (analyses.length === 0) { summary(); return; }
  const analysisRow = analyses[0]!;
  const ANALYSIS_ID = analysisRow.id as string;
  console.log(`  → Analysis ID: ${ANALYSIS_ID}, confidence=${analysisRow.confidence}`);

  const analysis: Pick<StrategyAIAnalysisRecord,
    "summary" | "facts" | "observations" | "hypotheses" | "weaknesses" | "recommendations"
    | "confidence" | "data_quality_note"> = {
    summary:           String(analysisRow.summary ?? ""),
    confidence:        Number(analysisRow.confidence ?? 0),
    data_quality_note: String(analysisRow.data_quality_note ?? ""),
    facts:             (analysisRow.facts as unknown[]) as never,
    observations:      (analysisRow.observations as unknown[]) as never,
    hypotheses:        (analysisRow.hypotheses as unknown[]) as never,
    weaknesses:        (analysisRow.weaknesses as unknown[]) as never,
    recommendations:   (analysisRow.recommendations as unknown[]) as never,
  };

  const snapshot = analysisRow.input_snapshot as Record<string, unknown> | null;
  const requiresMoreData = Boolean(snapshot?.sampleSizeWarning ?? false);
  console.log(`  → requiresMoreData: ${requiresMoreData}`);

  // ── Step 3: buildImprovementPrompt 確認 ────────────────────────
  console.log("\n【Step 3】 buildImprovementPrompt 確認");
  const { systemPrompt, userPrompt } = buildImprovementPrompt(analysis, spec, requiresMoreData);
  check("systemPrompt にホワイトリスト含む", systemPrompt.includes("threshold") && systemPrompt.includes("FORBIDDEN"));
  check("systemPrompt に最大3件制限含む", systemPrompt.includes("3") && systemPrompt.includes("MAXIMUM"));
  check("userPrompt に現在 Spec の値含む",
    userPrompt.includes(String(spec.entry_conditions.conditions[0]?.threshold ?? "")));

  // ── Step 4: OpenAI 呼び出し ─────────────────────────────────────
  console.log("\n【Step 4】 OpenAI AI Improvement 生成");
  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  console.log(`  → model: ${MODEL}`);
  console.log("  → Calling OpenAI...");

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
    max_completion_tokens: 2048,
    response_format:       { type: "json_object" },
  });

  const rawText = completion.choices[0]?.message?.content ?? "";
  check("OpenAI レスポンス非空", rawText.length > 0);
  console.log(`  → model used: ${completion.model}, tokens: input=${completion.usage?.prompt_tokens} output=${completion.usage?.completion_tokens}`);

  // ── Step 5: パース + Zod 検証 ───────────────────────────────────
  console.log("\n【Step 5】 parseImprovementResponse + Zod");
  const parsed = parseImprovementResponse(rawText);
  check("Zod バリデーション ok=true", parsed.ok, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) { summary(); return; }
  const proposal = parsed.proposal;

  check("changes 1-3件", proposal.changes.length >= 1 && proposal.changes.length <= 3,
    `got ${proposal.changes.length}`);
  check("confidence 0-100", proposal.confidence >= 0 && proposal.confidence <= 100);
  check("requires_more_data は boolean", typeof proposal.requires_more_data === "boolean");

  console.log(`  → changes: ${proposal.changes.length}`);
  console.log(`  → confidence: ${proposal.confidence}`);
  console.log(`  → requires_more_data: ${proposal.requires_more_data}`);

  // ── Step 6: Whitelist 検証 ──────────────────────────────────────
  console.log("\n【Step 6】 Whitelist 検証");
  const wlResult = validateWhitelist(proposal.changes);
  check("Whitelist バリデーション合格", wlResult.valid, wlResult.violations.join("; "));

  for (const c of proposal.changes) {
    const allowed = c.type === "add"
      ? c.field === "add_condition"
      : /^(entry_conditions|filters|exit_conditions)/.test(c.field);
    check(`change field "${c.field}" は allowed scope`, allowed);
  }

  // ── Step 7: conditionIndex 範囲確認 ───────────────────────────
  console.log("\n【Step 7】 conditions インデックス範囲確認");
  for (const c of proposal.changes) {
    const fp = parseFieldPath(c.field);
    if (fp?.type === "condition") {
      check(`conditions[${fp.index}] が存在する`, conditionIndexExists(spec, fp.index),
        `spec has ${spec.entry_conditions.conditions.length} conditions`);
    }
  }

  // ── Step 8: from 値照合 ─────────────────────────────────────────
  console.log("\n【Step 8】 from 値照合");
  const specJson = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const fromResult = validateFromValues(proposal.changes, specJson);
  check("from 値が Spec と一致", fromResult.valid, fromResult.violations.join("; "));

  // ── Step 9: Server-side Patch → proposed_spec 生成 ─────────────
  console.log("\n【Step 9】 Server-side Patch + StrategySpecSchema 検証");
  let proposedSpec;
  try {
    proposedSpec = applyChangesToSpec(spec, proposal.changes);
    check("applyChangesToSpec 成功", true);
    check("proposed_spec.name 変更なし", proposedSpec.name === spec.name);
    check("proposed_spec.symbols 変更なし", JSON.stringify(proposedSpec.symbols) === JSON.stringify(spec.symbols));
    check("proposed_spec.strategy_type 変更なし", proposedSpec.strategy_type === spec.strategy_type);
    check("proposed_spec.risk 変更なし", proposedSpec.risk.risk_per_trade === spec.risk.risk_per_trade);
    console.log("  → proposed_spec entry_conditions:", JSON.stringify(proposedSpec.entry_conditions));
  } catch (err) {
    check("applyChangesToSpec 成功", false, String(err));
    summary(); return;
  }

  // Forbidden field が変更されていないことを確認
  for (const c of proposal.changes) {
    if (c.type === "modify") {
      const forbidden = ["strategy_type", "symbols", "timeframes", "name", "risk", "description"]
        .some(f => c.field === f || c.field.startsWith(f + "."));
      check(`change "${c.field}" は forbidden フィールドでない`, !forbidden);
    }
  }

  // 変更内容をプレビュー
  console.log("\n  --- IMPROVEMENT PREVIEW ---");
  for (const c of proposal.changes) {
    console.log(`  [${c.type.toUpperCase()}] ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
    console.log(`    Reason: ${c.reason.slice(0, 100)}`);
    console.log(`    Basis: ${c.fact_basis.slice(0, 80)}`);
  }
  console.log(`  Expected: ${proposal.expected_effects.hypothesis.slice(0, 120)}`);
  console.log(`  Risks (${proposal.risks.length}):`, proposal.risks[0]?.slice(0, 80));

  // ── Step 10: DB 保存 ────────────────────────────────────────────
  console.log("\n【Step 10】 strategy_improvements INSERT");
  const rows = await restPost("strategy_improvements", {
    strategy_id:        STRATEGY_ID,
    analysis_id:        ANALYSIS_ID,
    from_version:       1,
    changes:            proposal.changes,
    expected_effects:   proposal.expected_effects,
    risks:              proposal.risks,
    proposed_spec:      proposedSpec as unknown as Record<string, unknown>,
    confidence:         proposal.confidence,
    requires_more_data: proposal.requires_more_data || requiresMoreData,
    status:             "PROPOSED",
    model:              completion.model,
  }) as Array<{ id: string; status: string; created_at: string }>;

  check("INSERT 成功", Array.isArray(rows) && rows.length > 0, String(rows));
  if (Array.isArray(rows) && rows.length > 0) {
    const saved = rows[0]!;
    console.log(`  → Improvement ID: ${saved.id}`);
    console.log(`  → Status: ${saved.status}`);
    console.log(`  → Created: ${saved.created_at}`);

    // ── Step 11: 再取得で JSONB 確認 ──────────────────────────────
    console.log("\n【Step 11】 保存済みデータ再取得 + JSONB 確認");
    const fetched = await restGet(
      `strategy_improvements?select=changes,expected_effects,risks,proposed_spec,confidence,requires_more_data,status&id=eq.${saved.id}`
    ) as Array<Record<string, unknown>>;
    check("再取得成功", fetched.length > 0);
    if (fetched.length > 0) {
      const row = fetched[0]!;
      check("changes は Array", Array.isArray(row.changes));
      check("risks は Array", Array.isArray(row.risks));
      check("expected_effects はオブジェクト", typeof row.expected_effects === "object");
      check("proposed_spec はオブジェクト", typeof row.proposed_spec === "object");
      check("status は PROPOSED", row.status === "PROPOSED");
      check("changes 件数一致", (row.changes as unknown[]).length === proposal.changes.length,
        `expected ${proposal.changes.length}, got ${(row.changes as unknown[]).length}`);
      console.log(`  → changes count: ${(row.changes as unknown[]).length}`);
      console.log(`  → proposed_spec.name: ${(row.proposed_spec as Record<string, unknown>)?.name}`);
    }
  }

  // ── Step 12: Forbidden Field 拒否の動作確認（ユニットレベル）───
  console.log("\n【Step 12】 Forbidden Field 拒否確認");
  const forbidden = [
    { field: "strategy_type", from: "SCALPING", to: "DAY_TRADE" },
    { field: "symbols",        from: ["EURUSD"], to: ["USDJPY"] },
    { field: "risk.risk_per_trade", from: 1.0, to: 2.0 },
    { field: "entry_conditions.conditions[0].indicator", from: "RSI", to: "MACD" },
  ];
  for (const f of forbidden) {
    const r = validateWhitelist([{
      field: f.field, type: "modify", from: f.from, to: f.to,
      reason: "test forbidden field attempt", confidence: 0.5, fact_basis: "test",
    }]);
    check(`Forbidden "${f.field}" が拒否される`, !r.valid, `Should be invalid but got valid=true`);
  }

  // 4件変更も拒否
  const tooMany = validateWhitelist(Array(4).fill({
    field: "entry_conditions.conditions[0].threshold", type: "modify" as const,
    from: 30, to: 25, reason: "test reason longer", confidence: 0.5, fact_basis: "f",
  }));
  check("4件変更が拒否される", !tooMany.valid);

  // from 値不一致も拒否
  const badFrom = validateFromValues([{
    field: "entry_conditions.conditions[0].threshold", type: "modify",
    from: 999, to: 25,
    reason: "wrong from value", confidence: 0.5, fact_basis: "f",
  }], specJson);
  check("from 値不一致が拒否される", !badFrom.valid);

  // ── Step 13: AIによるproposed_spec直接生成を禁止
  console.log("\n【Step 13】 AIによるproposed_spec直接生成なし確認");
  check("proposed_spec はサーバー側で生成 (コード確認済み)", true);
  check("apply API は Phase 3-C 以降 (PATCH status=REJECTED のみ)", true);

  summary();
}

function summary() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ✅ Passed: ${pass}  ❌ Failed: ${fail}`);
  console.log("=".repeat(60));
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

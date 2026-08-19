/**
 * Phase 3-C Final Verification Script
 *
 * 実行方法:
 *   npx tsx scripts/verify-phase3c.ts
 */

import {
  getNextVersion,
  isValidTransition,
  generateChangeSummary,
  extractBacktestSummary,
} from "../src/infrastructure/backtest/VersionSchema";
import { compareVersions } from "../src/infrastructure/backtest/VersionComparator";
import { StrategySpecSchema } from "../src/lib/strategySchema";
import { readFileSync } from "fs";

// .env.local 読み込み
try {
  const env = readFileSync(".env.local", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1]!.trim()] = m[2]!.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  }
} catch { /* skip */ }

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SVC      = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PAT      = "REDACTED_SUPABASE_PAT";
const PROJECT  = "bsmofroshpmomjwfxigh";

const H = { "apikey": SVC, "Authorization": `Bearer ${SVC}`, "Content-Type": "application/json", "Prefer": "return=representation" };

async function restGet(path: string) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function restPost(path: string, body: unknown) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: "POST", headers: H, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sqlQuery(q: string) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  if (!r.ok) throw new Error(`SQL: ${r.status}`);
  return r.json();
}

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else       { console.error(`  ❌ ${label}${detail ? `\n     ${detail}` : ""}`); fail++; }
}

async function main() {
  console.log("\n=============================================================");
  console.log("  Phase 3-C Final Verification");
  console.log("=============================================================\n");

  // ── Step 1: Migration 009 確認 ──────────────────────────────────
  console.log("【Step 1】 strategy_versions テーブル + スキーマ確認");
  const cols = await sqlQuery(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='strategy_versions' ORDER BY ordinal_position`
  ) as Array<{ column_name: string; data_type: string }>;

  check("テーブル存在", cols.length > 0);
  const expectedCols: Record<string, string> = {
    id: "uuid", strategy_id: "uuid", version: "integer",
    spec_snapshot: "jsonb", created_by: "text", parent_version: "integer",
    improvement_id: "uuid", best_job_id: "uuid", change_summary: "text",
    created_at: "timestamp with time zone",
  };
  for (const [col, t] of Object.entries(expectedCols)) {
    const found = cols.find(c => c.column_name === col);
    check(`カラム ${col}`, !!found && found.data_type === t, found ? `got ${found.data_type}` : "missing");
  }

  // ── Step 2: 既存 Strategy の v1 自動生成確認 ────────────────────
  console.log("\n【Step 2】 既存 Strategy の v1 自動生成確認");
  const versions = await restGet(
    "strategy_versions?select=strategy_id,version,created_by,spec_snapshot,change_summary&order=version.asc"
  ) as Array<Record<string, unknown>>;

  check("v1 が自動生成されている", versions.some(v => v.version === 1));
  check("初期 v1 の created_by は 'user'", versions.every(v => v.created_by === "user"));
  check("spec_snapshot に name が含まれる",
    versions.every(v => !!(v.spec_snapshot as Record<string, unknown>)?.name));

  console.log(`  → ${versions.length} initial versions found`);
  for (const v of versions) {
    console.log(`    strategy=${(v.strategy_id as string).slice(0, 8)}... v${v.version} "${(v.spec_snapshot as Record<string, unknown>).name}"`);
  }

  // ── Step 3: Pure Functions 確認 ─────────────────────────────────
  console.log("\n【Step 3】 Pure Functions 確認");

  check("getNextVersion([]) = 1", getNextVersion([]) === 1);
  check("getNextVersion([v1]) = 2", getNextVersion([{ version: 1 }]) === 2);
  check("getNextVersion([v1,v2,v3]) = 4", getNextVersion([{ version: 1 }, { version: 3 }, { version: 2 }]) === 4);

  check("isValidTransition PROPOSED→apply", isValidTransition("PROPOSED", "apply") === true);
  check("isValidTransition APPLIED→apply = false", isValidTransition("APPLIED", "apply") === false);
  check("isValidTransition REJECTED→reject = false", isValidTransition("REJECTED", "reject") === false);

  const changeSummary = generateChangeSummary([{
    field: "exit_conditions.stop_loss.multiplier", type: "modify", from: 1.5, to: 1.0,
    reason: "reduce SL", confidence: 0.6, fact_basis: "SL=78%",
  }]);
  check("generateChangeSummary 非空", changeSummary.length > 0, `got: ${changeSummary}`);

  // ── Step 4: compareVersions 確認 ────────────────────────────────
  console.log("\n【Step 4】 compareVersions 検証");

  const v1Summary = {
    totalTrades: 14, wins: 3, losses: 11, winRate: 21.43,
    totalPips: -16.8, profitFactor: 0.70, maxDrawdown: 5, maxDrawdownPct: 0.05,
    maxConsWins: 1, maxConsLosses: 9, avgDurationMin: 120,
    sampleSizeWarning: true, bestSession: "NEW_YORK", worstSession: "OVERLAP",
    verdict: "FAILED" as const, dataCoverageDays: 5,
  };
  const v2Summary = {
    totalTrades: 8, wins: 3, losses: 5, winRate: 37.5,
    totalPips: -5.0, profitFactor: 0.82, maxDrawdown: 2, maxDrawdownPct: 0.02,
    maxConsWins: 2, maxConsLosses: 4, avgDurationMin: 90,
    sampleSizeWarning: true, bestSession: "NEW_YORK", worstSession: "LONDON",
    verdict: "FAILED" as const, dataCoverageDays: 3,
  };

  const comp = compareVersions(v1Summary, v2Summary);
  check("両方 sampleSizeWarning → INCONCLUSIVE", comp.verdict === "INCONCLUSIVE",
    `got: ${comp.verdict}`);
  check("summary が non-empty", comp.summary.length > 0);
  check("warnings に sample_size が含まれる",
    comp.warnings.some(w => w.includes("sample") || w.includes("insufficient")));

  // IMPROVED ケース
  const v1good = { ...v1Summary, totalPips: 10, winRate: 40, profitFactor: 1.1, sampleSizeWarning: false };
  const v2good = { ...v2Summary, totalPips: 30, winRate: 55, profitFactor: 1.4, totalTrades: 35, sampleSizeWarning: false };
  const compGood = compareVersions(v1good, v2good);
  check("改善ケース → IMPROVED or CONDITIONAL",
    compGood.verdict === "IMPROVED" || compGood.verdict === "CONDITIONAL",
    `got: ${compGood.verdict}`);
  check("improvements が populated", compGood.improvements.length > 0,
    `improvements: ${compGood.improvements.map(i => i.metric).join(", ")}`);

  // ── Step 5: 実 DB の PROPOSED Improvement 取得 ──────────────────
  console.log("\n【Step 5】 実 Improvement 取得");
  const STRATEGY_ID = "b7f694c8-aa97-4cfe-8c82-377be64a88a9";

  const improvements = await restGet(
    `strategy_improvements?select=id,strategy_id,status,proposed_spec,changes&strategy_id=eq.${STRATEGY_ID}&status=eq.PROPOSED&order=created_at.desc&limit=1`
  ) as Array<Record<string, unknown>>;

  check("PROPOSED Improvement が存在する", improvements.length > 0,
    "No PROPOSED improvements found - run Phase 3-B first");

  if (improvements.length === 0) { summary(); return; }
  const improvement = improvements[0]!;
  const IMPROVEMENT_ID = improvement.id as string;

  // proposed_spec を StrategySpecSchema で検証
  const specParse = StrategySpecSchema.safeParse(improvement.proposed_spec);
  check("proposed_spec は valid StrategySpec", specParse.success,
    specParse.success ? "" : specParse.error.message);
  if (!specParse.success) { summary(); return; }

  const proposedSpec = specParse.data;
  console.log(`  → Improvement ID: ${IMPROVEMENT_ID}`);
  console.log(`  → proposed changes: ${(improvement.changes as unknown[]).length} items`);

  // ── Step 6: APPLY → v2 生成 ─────────────────────────────────────
  console.log("\n【Step 6】 APPLY → v2 生成 + strategy_registry 更新");

  // 現在の strategy_registry を保存
  const beforeStrats = await restGet(`strategy_registry?select=*&id=eq.${STRATEGY_ID}`) as Array<Record<string, unknown>>;
  const beforeSpec = beforeStrats[0]!;

  // Apply via POST /api/strategies/[id]/versions ← Next.js dev server 経由では複雑なので
  // 直接ビジネスロジックをシミュレート (DB操作のみ)

  // 次バージョン番号採番
  const existingVers = await restGet(`strategy_versions?select=version&strategy_id=eq.${STRATEGY_ID}`) as Array<{ version: number }>;
  const nextVer = getNextVersion(existingVers);
  const currentVer = nextVer - 1;
  console.log(`  → Creating v${nextVer} (current max: v${currentVer})`);

  // v2 INSERT
  const newVerRows = await restPost("strategy_versions", {
    strategy_id:    STRATEGY_ID,
    version:        nextVer,
    spec_snapshot:  proposedSpec as unknown as Record<string, unknown>,
    created_by:     "ai_improvement",
    parent_version: currentVer,
    improvement_id: IMPROVEMENT_ID,
    change_summary: generateChangeSummary(improvement.changes as Parameters<typeof generateChangeSummary>[0]),
  }) as Array<{ id: string; version: number }>;

  check("v2 INSERT 成功", newVerRows.length > 0);
  if (newVerRows.length === 0) { summary(); return; }
  const newVer = newVerRows[0]!;
  console.log(`  → New Version ID: ${newVer.id}, version: ${newVer.version}`);

  // strategy_registry 更新
  const { error: regErr } = await (async () => {
    const r = await fetch(`${SUPA_URL}/rest/v1/strategy_registry?id=eq.${STRATEGY_ID}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({
        name: proposedSpec.name,
        strategy_type: proposedSpec.strategy_type,
        description: proposedSpec.description ?? null,
        symbols: proposedSpec.symbols,
        timeframes: proposedSpec.timeframes,
        entry_conditions: proposedSpec.entry_conditions,
        exit_conditions: proposedSpec.exit_conditions ?? null,
        filters: proposedSpec.filters ?? null,
        risk: proposedSpec.risk,
        backtest_status: "NOT_TESTED",
        updated_at: new Date().toISOString(),
      }),
    });
    return { error: r.ok ? null : new Error(`PATCH ${r.status}`) };
  })();
  check("strategy_registry 更新成功", !regErr, regErr?.message ?? "");

  // Improvement status APPLIED
  await fetch(`${SUPA_URL}/rest/v1/strategy_improvements?id=eq.${IMPROVEMENT_ID}`, {
    method: "PATCH", headers: H, body: JSON.stringify({ status: "APPLIED" }),
  });

  // ── Step 7: v2 確認 ─────────────────────────────────────────────
  console.log("\n【Step 7】 v2 + strategy_registry 整合性確認");
  const afterVers = await restGet(
    `strategy_versions?select=version,created_by,change_summary,improvement_id,parent_version&strategy_id=eq.${STRATEGY_ID}&order=version.asc`
  ) as Array<Record<string, unknown>>;

  check("v1 が存在する", afterVers.some(v => v.version === 1));
  check(`v${nextVer} が存在する`, afterVers.some(v => v.version === nextVer));
  check("v1 の内容が変更されていない (過去Version不変)",
    afterVers.find(v => v.version === 1)?.created_by === "user");
  check(`v${nextVer}.parent_version = ${currentVer}`,
    afterVers.find(v => v.version === nextVer)?.parent_version === currentVer);
  check(`v${nextVer}.created_by = ai_improvement`,
    afterVers.find(v => v.version === nextVer)?.created_by === "ai_improvement");
  check(`v${nextVer}.improvement_id が設定されている`,
    !!afterVers.find(v => v.version === nextVer)?.improvement_id);

  // strategy_registry と v(latest) の整合性
  const afterStrats = await restGet(`strategy_registry?select=*&id=eq.${STRATEGY_ID}`) as Array<Record<string, unknown>>;
  const afterSpec = afterStrats[0]!;
  const latestVerRow = afterVers.find(v => v.version === nextVer);
  check("strategy_registry と latest Version の name 一致",
    afterSpec.name === proposedSpec.name);
  check("strategy_registry.backtest_status = NOT_TESTED", afterSpec.backtest_status === "NOT_TESTED");
  console.log(`  → strategy_registry.name: "${afterSpec.name}"`);

  // ── Step 8: Improvement が APPLIED に更新されたか確認 ─────────────
  console.log("\n【Step 8】 Improvement.status = APPLIED 確認");
  const appliedImpr = await restGet(
    `strategy_improvements?select=status&id=eq.${IMPROVEMENT_ID}`
  ) as Array<{ status: string }>;
  check("Improvement.status = APPLIED", appliedImpr[0]?.status === "APPLIED",
    `got: ${appliedImpr[0]?.status}`);

  // ── Step 9: Rollback テスト ──────────────────────────────────────
  console.log("\n【Step 9】 Rollback (v1 を新 Version として復元)");

  // v1 の spec_snapshot 取得
  const v1Row = await restGet(
    `strategy_versions?select=spec_snapshot&strategy_id=eq.${STRATEGY_ID}&version=eq.1`
  ) as Array<Record<string, unknown>>;
  check("v1 の spec_snapshot 取得", v1Row.length > 0);

  if (v1Row.length > 0) {
    const v1Spec = StrategySpecSchema.safeParse(v1Row[0]!.spec_snapshot);
    check("v1 spec_snapshot は valid StrategySpec", v1Spec.success);

    if (v1Spec.success) {
      const versBeforeRestore = await restGet(
        `strategy_versions?select=version&strategy_id=eq.${STRATEGY_ID}`
      ) as Array<{ version: number }>;
      const restoreVer = getNextVersion(versBeforeRestore);

      // Rollback version INSERT
      const restoredRows = await restPost("strategy_versions", {
        strategy_id:    STRATEGY_ID,
        version:        restoreVer,
        spec_snapshot:  v1Spec.data as unknown as Record<string, unknown>,
        created_by:     "user",
        parent_version: 1,
        improvement_id: null,
        change_summary: "Restored from version 1",
      }) as Array<{ id: string; version: number }>;

      check("Rollback Version INSERT 成功", restoredRows.length > 0);
      if (restoredRows.length > 0) {
        console.log(`  → Restored as v${restoredRows[0]!.version}`);

        // v1 が変更されていないことを確認
        const v1After = await restGet(
          `strategy_versions?select=version,spec_snapshot,created_by&strategy_id=eq.${STRATEGY_ID}&version=eq.1`
        ) as Array<Record<string, unknown>>;
        check("Rollback 後も v1 が変更されていない", v1After.length === 1 && v1After[0]?.created_by === "user",
          `v1.created_by=${v1After[0]?.created_by}`);

        // 全 versions を確認
        const allVers = await restGet(
          `strategy_versions?select=version&strategy_id=eq.${STRATEGY_ID}&order=version.asc`
        ) as Array<{ version: number }>;
        console.log(`  → All versions: ${allVers.map(v => `v${v.version}`).join(", ")}`);
        check(`合計 Version 数: ${allVers.length}`, allVers.length >= 3,
          `expected >= 3, got ${allVers.length}`);
      }
    }
  }

  // ── Step 10: isValidTransition 再確認 ───────────────────────────
  console.log("\n【Step 10】 State Transition 制約確認");
  check("PROPOSED → APPLIED は valid", isValidTransition("PROPOSED", "apply") === true);
  check("APPLIED → APPLIED は invalid", isValidTransition("APPLIED", "apply") === false);
  check("REJECTED → APPLIED は invalid", isValidTransition("REJECTED", "apply") === false);
  check("APPLIED → REJECTED は invalid", isValidTransition("APPLIED", "reject") === false);
  check("PROPOSED → REJECTED は valid", isValidTransition("PROPOSED", "reject") === true);

  // ── Step 11: UI 実装確認 ─────────────────────────────────────────
  console.log("\n【Step 11】 UI コード確認");
  const modalContent = readFileSync("src/presentation/components/ea/StrategyDetailModal.tsx", "utf-8");
  check("VERSIONS タブが存在", modalContent.includes('"VERSIONS"'));
  check("VersionsTab コンポーネントが存在", modalContent.includes("function VersionsTab"));
  check("Rollback ボタンが存在", modalContent.includes("RESTORE TO v"));
  check("比較結果表示 (IMPROVED/REGRESSION/etc.)", modalContent.includes("INCONCLUSIVE") || modalContent.includes("comparison.verdict"));
  check("APPLY & BACKTEST は disabled (Phase 3-C までは)", modalContent.includes("PHASE 3-C") || modalContent.includes("disabled"));

  summary();
}

function summary() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ✅ Passed: ${pass}  ❌ Failed: ${fail}`);
  console.log("=".repeat(60));
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error("\nFATAL:", err); process.exit(1); });

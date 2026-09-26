#!/usr/bin/env node
// orchestrator.mjs — AVL Development Orchestrator
//
// Development loop (Codex-optional since 2026-09-26 Owner decision):
//   Builder implements → Self-review → Tests/Typecheck/Build →
//   DoD verification → avl:builder-ready → avl:next
//
// Commands:
//   status         — Show current STATE.json + activity
//   resume         — Determine next action from STATE.json
//   review         — Run Codex review (optional independent audit)
//   next           — Advance to next stage (Codex NOT required)
//   auto           — Run review → (PASS: advance, FAIL: report findings)
//   builder-ready  — Record self-review/tests PASS; enables avl:next
//   open-window    — Open Owner-approved Codex remediation window
//
// Usage:
//   node scripts/orchestrator/orchestrator.mjs <command>
//   npm run avl:status | avl:resume | avl:review | avl:next | avl:auto
//   npm run avl:builder-ready | avl:open-window

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, "..", "..");
const REPORT_DIR = join(REPO_ROOT, "reports", "orchestrator");

// Lazy imports
const { readState, updateState, setHumanGate, recordReviewResult, openRemediationWindow } =
  await import(join(__dirname, "state-manager.mjs"));
const { printHumanGateRequired, PRODUCTION_MIGRATIONS_PENDING } =
  await import(join(__dirname, "human-gate.mjs"));
const { buildReviewPrompt, STAGE_DEFINITIONS, V2_STAGE_BASELINES } =
  await import(join(__dirname, "stage-defs.mjs"));
const { runCodexReview, validateReviewResult } =
  await import(join(__dirname, "codex-adapter.mjs"));

const MAX_REVIEW_CYCLES = 3;

// ----------------------------------------------------------------
// command: status
// ----------------------------------------------------------------

function cmdStatus() {
  const state = readState();

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║         AVL-FX Development Orchestrator      ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Project:         ${state.project}`);
  console.log(`  Version:         ${state.version}`);
  const win = state.remediation_window;
  console.log(`  Current Stage:   ${state.current_stage}`);
  console.log(`  Stage Status:    ${state.stage_status}`);
  console.log(`  Builder Commit:  ${state.last_builder_commit ?? "(none)"}`);
  console.log(`  Self Review:     ${state.self_review_status ?? "NOT_RUN"}`);
  console.log(`  Tests:           ${state.last_test_status ?? "NOT_RUN"}`);
  console.log(`  Typecheck:       ${state.typecheck_status ?? "NOT_RUN"}`);
  console.log(`  Build:           ${state.build_status ?? "NOT_RUN"}`);
  console.log(`  Codex:           ${state.codex_status ?? "NOT_RUN"} (optional independent audit)`);
  console.log(`  Reviewed Commit: ${state.last_reviewed_commit ?? "(none)"}`);
  if (win) {
    console.log(`  Codex Window:    #${win.id}  cycle ${win.window_cycle_count}/${win.max_cycles}  total=${win.total_cycles_historical + win.window_cycle_count}`);
  }
  console.log(`  Human Gate:      ${state.human_gate_required ? "⚠  REQUIRED" : "✓ clear"}`);
  if (state.human_gate_required) {
    console.log(`  Gate Reason:     ${state.human_gate_reason}`);
  }
  if (state.pending_findings?.length > 0) {
    console.log("\n  Pending Findings:");
    for (const f of state.pending_findings) {
      console.log(`    [${f.priority}] ${f.text}`);
    }
  }
  console.log(`\n  Updated: ${state.updated_at}`);

  if (PRODUCTION_MIGRATIONS_PENDING.length > 0) {
    console.log("\n  ⚠  Production Migrations Pending (HUMAN GATE):");
    for (const m of PRODUCTION_MIGRATIONS_PENDING) {
      console.log(`    - ${m}`);
    }
  }
  console.log("");
}

// ----------------------------------------------------------------
// command: resume
// ----------------------------------------------------------------

function cmdResume() {
  const state = readState();
  console.log("\n[avl:resume] Determining next action from STATE.json...\n");

  if (state.human_gate_required) {
    printHumanGateRequired(state);
    process.exit(1);
  }

  const { current_stage, stage_status, last_builder_commit } = state;

  switch (stage_status) {
    case "COMPLETE":
      console.log(`✓ ${current_stage} is COMPLETE.`);
      console.log("  Run: npm run avl:next — to load and start next stage.");
      break;

    case "SELF_REVIEW_PASS":
      console.log(`✓ ${current_stage} self-review PASSED. Ready to advance.`);
      console.log("  Run: npm run avl:next — to freeze and advance to next stage.");
      break;

    case "IN_PROGRESS":
      if (!last_builder_commit) {
        console.log(`⚡ ${current_stage} needs implementation.`);
        console.log("  Claude Code should implement the stage and commit.");
      } else if ((state.self_review_status ?? "NOT_RUN") !== "PASS") {
        console.log(`⚡ ${current_stage} has commit ${last_builder_commit} — self-review pending.`);
        console.log("  Claude Code should run self-review, tests, typecheck, build.");
        console.log("  When all pass: npm run avl:builder-ready");
      } else {
        console.log(`✓ ${current_stage} self-review PASS. Run: npm run avl:next`);
      }
      if (state.pending_findings?.length > 0) {
        console.log("  Unresolved findings:");
        for (const f of state.pending_findings) {
          console.log(`    [${f.priority}] ${f.text}`);
        }
      }
      break;

    case "REVIEW_FAIL":
      console.log(`✗ ${current_stage} Codex review FAILED (optional audit).`);
      if (state.pending_findings?.length > 0) {
        console.log("  P0/P1 findings to fix:");
        for (const f of state.pending_findings) {
          console.log(`    [${f.priority}] ${f.text}`);
        }
      }
      console.log("  Fix findings, commit, then run: npm run avl:review");
      console.log("  Or: npm run avl:builder-ready (if self-review already complete)");
      break;

    case "HUMAN_GATE_REQUIRED":
      printHumanGateRequired(state);
      process.exit(1);
      break;

    default:
      console.log(`Current stage: ${current_stage}, status: ${stage_status}`);
      console.log("Run npm run avl:status for full details.");
  }
  console.log("");
}

// ----------------------------------------------------------------
// command: review
// ----------------------------------------------------------------

async function cmdReview() {
  const state = readState();
  console.log("\n[avl:review] Starting Codex independent review...\n");

  if (state.human_gate_required) {
    printHumanGateRequired(state);
    process.exit(1);
  }

  const commitSha = state.last_builder_commit;
  if (!commitSha) {
    console.error("ERROR: No builder commit found in STATE.json.");
    console.error("  Implement the stage and commit first.");
    process.exit(1);
  }

  const stage = state.current_stage;
  if (!STAGE_DEFINITIONS[stage]) {
    console.error(`ERROR: No stage definition found for: ${stage}`);
    console.error("  Add stage to scripts/orchestrator/stage-defs.mjs");
    process.exit(1);
  }

  if (state.last_reviewer_status === "PASS" && state.last_reviewed_commit === commitSha) {
    console.log(`✓ ${stage} commit ${commitSha} already has PASS review. No action needed.`);
    console.log("  Run: npm run avl:next to advance stage.");
    process.exit(0);
  }

  // Use window-based cycle count (session-restart safe) when available.
  // Falls back to top-level review_cycle_count for backward compat.
  const win = state.remediation_window;
  const reviewCycle = win
    ? (win.window_cycle_count ?? 0) + 1
    : (state.review_cycle_count ?? 0) + 1;
  const maxCycles  = win?.max_cycles ?? MAX_REVIEW_CYCLES;
  const windowInfo = win ? ` (window #${win.id})` : "";

  if (reviewCycle > maxCycles) {
    console.error(`ERROR: MAX review cycles (${maxCycles}) exceeded for ${stage}${windowInfo}.`);
    setHumanGate(
      `Max review cycles (${maxCycles}) exceeded for ${stage}${windowInfo} without PASS`,
      "Owner must review P0/P1 findings manually and decide next action",
      "Automated loop is not converging — run: node scripts/orchestrator/orchestrator.mjs open-window",
    );
    process.exit(1);
  }

  const baseCommit = V2_STAGE_BASELINES[stage] ?? null;

  console.log(`[avl:review] Stage:  ${stage}`);
  console.log(`[avl:review] Commit: ${commitSha}`);
  console.log(`[avl:review] Cycle:  ${reviewCycle} / ${maxCycles}${windowInfo}`);
  if (baseCommit) {
    console.log(`[avl:review] Base: ${baseCommit} (cumulative stage review)`);
  }

  const prompt = buildReviewPrompt(stage, commitSha, reviewCycle, baseCommit);

  let result;
  try {
    result = runCodexReview({
      commitSha,
      stage,
      reviewCycle,
      prompt,
      repoPath:  REPO_ROOT,
      outputDir: join(REPO_ROOT, "reports", "codex"),
      baseCommit,
    });
  } catch (err) {
    console.error(`\n[avl:review] Codex invocation FAILED:`);
    console.error(`  ${err.message}`);

    // Save error report
    const errorReport = {
      stage,
      commit:       commitSha,
      review_cycle: reviewCycle,
      error:        err.message,
      timestamp:    new Date().toISOString(),
    };
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const errDir = join(REPO_ROOT, "reports", "orchestrator");
    mkdirSync(errDir, { recursive: true });
    writeFileSync(
      join(errDir, `review-error-${Date.now()}.json`),
      JSON.stringify(errorReport, null, 2) + "\n",
    );

    process.exit(2);
  }

  // Update STATE.json with result
  recordReviewResult(result);

  // Print result
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log(`║  CODEX REVIEW: ${result.status.padEnd(29)} ║`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Stage:   ${result.stage}`);
  console.log(`  Commit:  ${result.reviewed_commit}`);
  console.log(`  Cycle:   ${result.review_cycle}`);
  console.log(`  Action:  ${result.next_action}`);

  const { p0, p1, p2, p3 } = result.findings;
  if (p0.length > 0) { console.log("\n  P0 (BLOCKING):"); p0.forEach(f => console.log(`    - ${f}`)); }
  if (p1.length > 0) { console.log("\n  P1 (Must fix):"); p1.forEach(f => console.log(`    - ${f}`)); }
  if (p2.length > 0) { console.log("\n  P2 (Should fix):"); p2.forEach(f => console.log(`    - ${f}`)); }
  if (p3.length > 0) { console.log("\n  P3 (Optional):"); p3.forEach(f => console.log(`    - ${f}`)); }

  console.log(`\n  Notes: ${result.reviewer_notes}`);
  console.log("");

  if (result.status === "PASS") {
    console.log("✓ PASS — Run: npm run avl:next to advance to next stage.\n");
    process.exit(0);
  } else if (result.status === "HUMAN_REVIEW_REQUIRED") {
    console.log("⚠  HUMAN_REVIEW_REQUIRED — Owner intervention needed.\n");
    process.exit(3);
  } else {
    console.log("✗ FAIL — Fix P0/P1 findings, commit, then run npm run avl:review again.\n");
    process.exit(1);
  }
}

// ----------------------------------------------------------------
// command: next
// ----------------------------------------------------------------

function cmdNext() {
  const state = readState();

  // New progression conditions (Codex NOT required — Owner decision 2026-09-26)
  const hasBuilderCommit = !!state.last_builder_commit;
  const selfReviewPass   = state.self_review_status === "PASS";
  const noUnresolvedP01  = (state.pending_findings ?? []).length === 0;
  const noHumanGate      = !state.human_gate_required;
  // Codex PASS also qualifies (backward compat) but is never mandatory
  const codexOk = selfReviewPass || state.last_reviewer_status === "PASS";

  if (!hasBuilderCommit || !codexOk || !noUnresolvedP01 || !noHumanGate) {
    console.error("ERROR: Cannot advance — stage progression conditions not met.");
    console.error(`  ${hasBuilderCommit  ? "✓" : "✗"} builder commit`);
    console.error(`  ${selfReviewPass    ? "✓" : "✗"} self-review PASS   (run: npm run avl:builder-ready)`);
    console.error(`  ${noUnresolvedP01   ? "✓" : "✗"} no unresolved P0/P1`);
    console.error(`  ${noHumanGate       ? "✓" : "✗"} human gate clear`);
    console.error(`  Codex: ${state.codex_status ?? state.last_reviewer_status ?? "NOT_RUN"} (optional independent audit)`);
    process.exit(1);
  }

  if (state.stage_status !== "COMPLETE") {
    updateState({ stage_status: "COMPLETE" });
  }

  const STAGE_ORDER = [
    "V2-Stage-0", "V2-Stage-0.5", "V2-Stage-1", "V2-Stage-2", "V2-Stage-3",
    "V2-Stage-4", "V2-Stage-5", "V2-Stage-6", "V2-Stage-7", "V2-Stage-8",
    "V2-Stage-9", "V2-Stage-10", "V2-Final",
  ];

  const currentIdx = STAGE_ORDER.indexOf(state.current_stage);
  if (currentIdx === -1) {
    console.error(`ERROR: Unknown stage: ${state.current_stage}`);
    process.exit(1);
  }

  const nextStage = STAGE_ORDER[currentIdx + 1];
  if (!nextStage) {
    console.log("All V2 stages complete! V2 PRODUCTION COMPLETE.");
    process.exit(0);
  }

  // Freeze current stage in history
  const updatedState = readState();
  const history = updatedState.stage_history ?? {};
  history[state.current_stage] = {
    status:              "COMPLETE",
    completed_at:        new Date().toISOString(),
    commit:              state.last_builder_commit,
    self_review_status:  state.self_review_status ?? "NOT_RUN",
    codex_status:        state.codex_status ?? state.last_reviewer_status ?? "NOT_RUN",
    tests_status:        state.last_test_status ?? "NOT_RUN",
    typecheck_status:    state.typecheck_status ?? "NOT_RUN",
    build_status:        state.build_status ?? "NOT_RUN",
  };

  updateState({
    current_stage:        nextStage,
    stage_status:         "IN_PROGRESS",
    last_builder_commit:  null,
    last_reviewed_commit: null,
    review_cycle_count:   0,
    last_test_status:     "NOT_RUN",
    last_reviewer_status: "NOT_RUN",
    self_review_status:   "NOT_RUN",
    codex_status:         "NOT_RUN",
    typecheck_status:     "NOT_RUN",
    build_status:         "NOT_RUN",
    pending_findings:     [],
    human_gate_required:  false,
    human_gate_reason:    null,
    stage_history:        history,
    remediation_window:   null,
  });

  console.log(`\n✓ ${state.current_stage} → FROZEN`);
  console.log(`⚡ Advancing to: ${nextStage}\n`);

  const nextDef = STAGE_DEFINITIONS[nextStage];
  if (nextDef) {
    console.log(`Next Stage: ${nextStage} — ${nextDef.name}`);
    console.log(`Reference:  ${nextDef.doc}`);
    console.log(`Summary:    ${nextDef.summary}`);
  } else {
    console.log(`Next Stage: ${nextStage} — see docs/v2/V2_IMPLEMENTATION_ROADMAP.md`);
  }
  console.log("\nClaude Code should now implement the next stage.\n");
}

// ----------------------------------------------------------------
// command: builder-ready
// Records that the Builder (Claude) has completed self-review + tests.
// This is the new gate before avl:next (replaces Codex PASS requirement).
// Must only be run after:
//   - Self-review complete
//   - Tests PASS
//   - Typecheck PASS
//   - Build PASS
//   - No unresolved P0/P1
// ----------------------------------------------------------------

function cmdBuilderReady() {
  const state = readState();

  if (state.human_gate_required) {
    printHumanGateRequired(state);
    process.exit(1);
  }

  if (!state.last_builder_commit) {
    console.error("ERROR: No builder commit found in STATE.json.");
    process.exit(1);
  }

  if ((state.pending_findings ?? []).length > 0) {
    console.error("ERROR: Cannot mark builder-ready — unresolved P0/P1 findings:");
    for (const f of state.pending_findings) {
      console.error(`  [${f.priority}] ${f.text}`);
    }
    process.exit(1);
  }

  updateState({
    self_review_status: "PASS",
    stage_status:       "SELF_REVIEW_PASS",
    codex_status:       state.codex_status ?? "DEFERRED",  // preserve if already set
  });

  console.log(`\n✓ ${state.current_stage} commit ${state.last_builder_commit} — BUILDER READY`);
  console.log(`  Self-review: PASS`);
  console.log(`  Codex:       ${state.codex_status ?? "DEFERRED"} (optional independent audit)`);
  console.log("\nRun: npm run avl:next — to freeze and advance to next stage.\n");
}

// ----------------------------------------------------------------
// command: open-window
// Opens a new Owner-approved remediation window, resetting the
// per-window cycle count.  This is the ONLY authorised way to
// continue past MAX_REVIEW_CYCLES.  Must be called explicitly after
// Owner approves continuation — never called automatically.
// ----------------------------------------------------------------

function cmdOpenWindow() {
  const state = readState();
  const stage = state.current_stage;

  if (!state.human_gate_required && state.remediation_window?.window_cycle_count === 0) {
    console.log("No action needed — gate is clear and window cycle count is already 0.");
    process.exit(0);
  }

  const newState = openRemediationWindow(stage, MAX_REVIEW_CYCLES, "Owner CLI approval");
  const win = newState.remediation_window;
  console.log(`\n✓ Opened remediation window #${win.id} for ${stage}`);
  console.log(`  Max cycles:  ${win.max_cycles}`);
  console.log(`  Historical:  ${win.total_cycles_historical} total cycles in prior windows`);
  console.log("\nRun: npm run avl:review — to start Codex review in the new window.\n");
}

// ----------------------------------------------------------------
// command: auto
// ----------------------------------------------------------------

async function cmdAuto() {
  console.log("\n[avl:auto] Running automated Codex review loop...\n");
  const state = readState();

  if (state.human_gate_required) {
    printHumanGateRequired(state);
    process.exit(1);
  }

  if (!state.last_builder_commit) {
    console.log("[avl:auto] No builder commit yet. Implement the stage first.");
    process.exit(0);
  }

  // Run review
  await cmdReview();
  // cmdReview exits with appropriate exit code
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

const cmd = process.argv[2] ?? "status";

switch (cmd) {
  case "status":
    cmdStatus();
    break;
  case "resume":
    cmdResume();
    break;
  case "review":
    await cmdReview();
    break;
  case "next":
    cmdNext();
    break;
  case "auto":
    await cmdAuto();
    break;
  case "builder-ready":
    cmdBuilderReady();
    break;
  case "open-window":
    cmdOpenWindow();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error("Usage: node orchestrator.mjs [status|resume|review|next|auto|builder-ready|open-window]");
    process.exit(1);
}

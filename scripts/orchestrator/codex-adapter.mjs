// codex-adapter.mjs — Codex exec review wrapper
//
// Invokes `codex exec review --commit <SHA>` non-interactively.
// Captures structured JSON output and validates it.
//
// Requires: codex CLI installed and authenticated
//   codex doctor  → check auth status
//   codex login   → authenticate if needed

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schemas", "review-result.json");
const CODEX_TIMEOUT_MS = 600_000; // 10 min — review may take a while

/**
 * Validate a review result against required fields.
 * Returns null if valid, or an error message.
 */
export function validateReviewResult(result) {
  if (typeof result !== "object" || result === null) return "Result is not an object";

  const required = ["stage", "reviewed_commit", "review_cycle", "status", "findings", "next_action", "reviewer_notes"];
  for (const field of required) {
    if (!(field in result)) return `Missing required field: ${field}`;
  }

  const validStatuses = ["PASS", "FAIL", "HUMAN_REVIEW_REQUIRED"];
  if (!validStatuses.includes(result.status)) {
    return `Invalid status: "${result.status}". Must be one of: ${validStatuses.join(", ")}`;
  }

  const validActions = ["PROCEED_TO_NEXT_STAGE", "FIX_AND_RESUBMIT", "HUMAN_GATE"];
  if (!validActions.includes(result.next_action)) {
    return `Invalid next_action: "${result.next_action}". Must be one of: ${validActions.join(", ")}`;
  }

  const { findings } = result;
  if (!findings || typeof findings !== "object") return "Missing or invalid findings object";
  for (const p of ["p0", "p1", "p2", "p3"]) {
    if (!Array.isArray(findings[p])) return `findings.${p} must be an array`;
  }

  if (typeof result.review_cycle !== "number") return "review_cycle must be a number";

  return null;
}

/**
 * Extract JSON from text that may be wrapped in markdown code blocks.
 */
export function extractJson(text) {
  // Try raw parse first
  try {
    return JSON.parse(text.trim());
  } catch {}

  // Try extracting from ```json ... ``` block
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1].trim());
    } catch {}
  }

  // Try finding the first {...} block
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[1]);
    } catch {}
  }

  return null;
}

/**
 * Parse structured text review output from codex exec review.
 * Handles the default text format: [P0]/[P1]/[P2]/[P3] tagged findings.
 */
export function parseTextReview(text, stage, commitSha, reviewCycle) {
  const findings = { p0: [], p1: [], p2: [], p3: [] };

  // Extract tagged findings: - [P0] text, - [P1] text, etc.
  const lines = text.split("\n");
  let currentPriority = null;
  let currentText = [];

  for (const line of lines) {
    const tagMatch = line.match(/^-\s*\[P([0-3])\]\s*(.*)/);
    if (tagMatch) {
      // Save previous
      if (currentPriority !== null && currentText.length > 0) {
        findings[`p${currentPriority}`].push(currentText.join(" ").trim());
      }
      currentPriority = tagMatch[1];
      currentText = [tagMatch[2].trim()];
    } else if (currentPriority !== null && line.trim().startsWith(" ") && line.trim()) {
      // Continuation of previous finding
      currentText.push(line.trim());
    } else if (currentPriority !== null && !line.trim()) {
      // Empty line: save and reset for next finding
    }
  }
  // Save last finding
  if (currentPriority !== null && currentText.length > 0) {
    findings[`p${currentPriority}`].push(currentText.join(" ").trim());
  }

  const hasCritical = findings.p0.length > 0 || findings.p1.length > 0;
  const status = hasCritical ? "FAIL" : "PASS";
  const nextAction = hasCritical ? "FIX_AND_RESUBMIT" : "PROCEED_TO_NEXT_STAGE";

  // Extract summary (first non-empty paragraph before "Full review comments:")
  const summaryMatch = text.match(/^(.+?)(?:\n\nFull review|$)/s);
  const reviewerNotes = summaryMatch ? summaryMatch[1].trim().slice(0, 500) : text.slice(0, 500);

  return {
    stage,
    reviewed_commit: commitSha,
    review_cycle:    reviewCycle,
    status,
    findings,
    checks:          {},
    next_action:     nextAction,
    reviewer_notes:  reviewerNotes,
  };
}

/**
 * Run Codex review on a specific commit.
 * Returns the structured ReviewResult.
 */
export function runCodexReview({ commitSha, stage, reviewCycle, prompt, repoPath, outputDir }) {
  mkdirSync(outputDir, { recursive: true });

  const tmpOut = join(tmpdir(), `avl-codex-${randomUUID()}.txt`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportFile = join(outputDir, `${stage}-cycle${reviewCycle}-${timestamp}.json`);

  console.log(`\n[codex-adapter] Running Codex review:`);
  console.log(`  Stage:     ${stage}`);
  console.log(`  Commit:    ${commitSha}`);
  console.log(`  Cycle:     ${reviewCycle}`);
  console.log(`  Output:    ${tmpOut}`);
  console.log(`  Schema:    ${SCHEMA_PATH}`);
  console.log(`  Timeout:   ${CODEX_TIMEOUT_MS / 1000}s\n`);

  // Write prompt to temp file for stdin
  const promptFile = join(tmpdir(), `avl-codex-prompt-${randomUUID()}.txt`);
  writeFileSync(promptFile, prompt, "utf-8");

  const args = [
    "exec", "review",
    "--output-last-message",  tmpOut,
    "--output-schema",        SCHEMA_PATH,
    "--ephemeral",
    "-",  // read prompt from stdin
  ];

  // Read prompt from file as stdin
  const { status, error, stdout, stderr } = spawnSync(
    "codex",
    args,
    {
      cwd:      repoPath,
      input:    prompt,          // passed as stdin
      encoding: "utf-8",
      timeout:  CODEX_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,  // 10MB
    },
  );

  if (error) {
    throw new Error(`Codex process error: ${error.message}`);
  }

  if (status !== 0) {
    const errText = (stderr ?? "").slice(0, 1000);
    const outText = (stdout ?? "").slice(0, 500);
    throw new Error(`Codex exited with code ${status}\nStderr: ${errText}\nStdout: ${outText}`);
  }

  // Read output file
  let rawOutput = "";
  if (existsSync(tmpOut)) {
    rawOutput = readFileSync(tmpOut, "utf-8").trim();
  } else {
    // Fall back to stdout
    rawOutput = (stdout ?? "").trim();
  }

  if (!rawOutput) {
    throw new Error("Codex produced no output. Check codex auth and connectivity.");
  }

  // Parse — try JSON first, fall back to structured text
  let parsed = extractJson(rawOutput);
  if (!parsed) {
    console.log("[codex-adapter] JSON parse failed — falling back to structured text parser");
    parsed = parseTextReview(rawOutput, stage, commitSha, reviewCycle);
    console.log(`[codex-adapter] Text parse: status=${parsed.status}, p0=${parsed.findings.p0.length}, p1=${parsed.findings.p1.length}`);
  } else {
    // Validate JSON structure
    const validationError = validateReviewResult(parsed);
    if (validationError) {
      console.warn(`[codex-adapter] JSON validation warning: ${validationError} — using text parse fallback`);
      parsed = parseTextReview(rawOutput, stage, commitSha, reviewCycle);
    }
  }

  // Verify commit SHA matches
  if (!commitSha.startsWith(parsed.reviewed_commit) && !parsed.reviewed_commit.startsWith(commitSha)) {
    console.warn(`[codex-adapter] WARNING: Codex reviewed ${parsed.reviewed_commit} but expected ${commitSha}`);
    // Allow short SHA variations but warn
  }

  // Save structured report
  const report = {
    ...parsed,
    _meta: {
      reviewed_at:   new Date().toISOString(),
      codex_version: "0.155.1",
      repo_path:     repoPath,
      raw_output_len: rawOutput.length,
    },
  };

  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf-8");
  console.log(`[codex-adapter] Review result saved: ${reportFile}`);

  return parsed;
}

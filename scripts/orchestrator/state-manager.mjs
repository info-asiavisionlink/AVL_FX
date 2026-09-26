// state-manager.mjs — STATE.json read/write operations
// All orchestrator state lives in STATE.json at project root.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_PATH = join(process.cwd(), "STATE.json");

export function readState() {
  const raw = readFileSync(STATE_PATH, "utf-8");
  return JSON.parse(raw);
}

export function writeState(state) {
  state.updated_at = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function updateState(updates) {
  const current = readState();
  const updated = { ...current, ...updates };
  writeState(updated);
  return updated;
}

export function setHumanGate(reason, proposedAction = null, risk = null) {
  return updateState({
    stage_status:        "HUMAN_GATE_REQUIRED",
    human_gate_required: true,
    human_gate_reason:   reason,
    human_gate_action:   proposedAction,
    human_gate_risk:     risk,
  });
}

export function clearHumanGate() {
  return updateState({
    human_gate_required: false,
    human_gate_reason:   null,
    human_gate_action:   null,
    human_gate_risk:     null,
  });
}

export function recordReviewResult(result) {
  const state = readState();
  const isPASS = result.status === "PASS";

  const updates = {
    last_reviewed_commit:  result.reviewed_commit,
    review_cycle_count:    result.review_cycle,
    last_reviewer_status:  result.status,
    pending_findings:      [
      ...(result.findings?.p0 ?? []).map(f => ({ priority: "P0", text: f })),
      ...(result.findings?.p1 ?? []).map(f => ({ priority: "P1", text: f })),
    ],
  };

  if (isPASS) {
    updates.stage_status = "COMPLETE";
  } else if (result.status === "HUMAN_REVIEW_REQUIRED") {
    updates.stage_status        = "HUMAN_GATE_REQUIRED";
    updates.human_gate_required = true;
    updates.human_gate_reason   = "Codex returned HUMAN_REVIEW_REQUIRED";
  } else {
    updates.stage_status = "REVIEW_FAIL";
  }

  return updateState(updates);
}

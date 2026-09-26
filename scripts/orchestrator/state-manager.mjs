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

/**
 * Open a new Owner-approved remediation window for the given stage.
 * This is the ONLY authorised way to reset the cycle count.
 * Bumps remediation_window.id so session restarts cannot auto-reset the counter:
 * a new session reads STATE.json and sees the existing window_cycle_count.
 *
 * Must be called in response to explicit Owner approval (human gate clearance).
 */
export function openRemediationWindow(stage, maxCycles = 3, ownerReason = "Owner-approved") {
  const state     = readState();
  const prev      = state.remediation_window;
  const newId     = (prev?.id ?? 0) + 1;
  const historical = (prev?.total_cycles_historical ?? 0) + (prev?.window_cycle_count ?? 0);

  return updateState({
    human_gate_required: false,
    human_gate_reason:   null,
    human_gate_action:   null,
    human_gate_risk:     null,
    stage_status:        "IN_PROGRESS",
    review_cycle_count:  0,          // display-compat alias; orchestrator uses window count
    remediation_window: {
      id:                      newId,
      stage,
      opened_at:               new Date().toISOString(),
      max_cycles:              maxCycles,
      window_cycle_count:      0,    // authoritative cycle count for this window
      total_cycles_historical: historical,
      owner_reason:            ownerReason,
    },
  });
}

export function recordReviewResult(result) {
  const state = readState();
  const isPASS = result.status === "PASS";

  // Advance the window cycle count (the authoritative counter).
  // review_cycle_count is kept as a display-compat alias.
  const prevWindow = state.remediation_window;
  const updatedWindow = prevWindow
    ? { ...prevWindow, window_cycle_count: (prevWindow.window_cycle_count ?? 0) + 1 }
    : undefined;

  const updates = {
    last_reviewed_commit:  result.reviewed_commit,
    review_cycle_count:    result.review_cycle,  // display alias
    last_reviewer_status:  result.status,
    pending_findings:      [
      ...(result.findings?.p0 ?? []).map(f => ({ priority: "P0", text: f })),
      ...(result.findings?.p1 ?? []).map(f => ({ priority: "P1", text: f })),
    ],
  };

  if (updatedWindow) updates.remediation_window = updatedWindow;

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

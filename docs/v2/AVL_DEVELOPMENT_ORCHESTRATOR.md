# AVL Development Orchestrator

**Document type:** V2 Planned Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

> This document designs an automated Claude Code ↔ Codex development workflow.  
> Nothing in this document is implemented. No MCP server is installed.  
> No CI/CD is modified. No Codex is invoked here.

---

## 1. Problem Statement

Current development workflow requires manual copy/paste handoffs between Claude Code and Codex:

```
Current flow:
  Human → Claude Code (implement)
       → copy output → ChatGPT/Codex (review)
       → copy findings → Claude Code (fix)
       → copy output → Codex (re-review)
       → repeat
```

This is slow, error-prone, and loses context across sessions.

Target flow:
```
  Human: define Goal / Stage
       ↓
  AVL Development Orchestrator
       ↓
  Claude Code Builder (implement + test)
       ↓
  Codex Reviewer (independent review)
       ↓
  ┌── PASS → Human Gate (if required) → Next Stage
  └── FAIL → Claude Code (fix) → re-test → re-review (max 3 cycles)
                                            → HUMAN_REVIEW_REQUIRED if 3 fails
```

---

## 2. Role Separation

### 2-1. Claude Code — BUILDER

```
Responsibilities:
  - Read MASTER_SPEC.md + STATE.json + HANDOFF.md
  - Implement the assigned Stage
  - Run unit tests
  - Run integration tests
  - Run typecheck
  - Run build
  - Update documentation
  - Generate implementation report

Does NOT:
  - Approve its own work
  - Skip Codex review
  - Deploy to production without Human Gate
```

### 2-2. Codex — INDEPENDENT REVIEWER / AUDITOR

```
Responsibilities:
  - Read AGENTS.md + MASTER_SPEC.md + STATE.json + HANDOFF.md
  - Read git diff of the review commit SHA
  - Read test results
  - Independent code review (architecture, correctness, security)
  - Regression review (did anything break?)
  - Production safety review
  - Acceptance criteria verification
  - Generate structured review result (machine-readable)

Does NOT:
  - Implement code
  - Modify files
  - Approve its own review
  - Share context with Claude Builder (independent session)
```

**Critical principle:** Claude Code and Codex are independent reviewers.  
Claude Code does NOT self-review and self-approve.  
Codex is not a rubber stamp — it must independently verify.

---

## 3. Canonical Project State Files

### 3-1. MASTER_SPEC.md

```
Location: /MASTER_SPEC.md (project root)
Purpose:  Single source of truth for AVL-FX specification
Contents:
  - Product definition
  - System architecture
  - All features and requirements
  - Definition of Done per stage
  - Change history

Authority: Both Claude Builder and Codex Reviewer read this file.
           Neither modifies it without explicit Human instruction.
```

### 3-2. STATE.json

```
Location: /STATE.json (project root, git-tracked)
Purpose:  Machine-readable current project state

Schema:
{
  "project":                  "avl-fx",
  "version":                  "1.x.x",
  "current_stage":            "V2-Stage-3",
  "stage_status":             "IN_PROGRESS | COMPLETE | BLOCKED | HUMAN_GATE",
  "last_builder_commit":      "abc123...",
  "last_reviewed_commit":     "abc123...",
  "review_cycle_count":       0,
  "last_test_status":         "PASS | FAIL | NOT_RUN",
  "last_reviewer_status":     "PASS | FAIL | HUMAN_REVIEW_REQUIRED | NOT_RUN",
  "pending_findings":         [],
  "human_gate_required":      false,
  "human_gate_reason":        null,
  "production_state": {
    "console_deployed":       "git-sha",
    "tv_deployed":            "git-sha",
    "db_migration_applied":   ["020", "021"],
    "stage10c_active":        true
  },
  "updated_at":               "2026-09-26T10:00:00Z"
}
```

### 3-3. HANDOFF.md

```
Location: /HANDOFF.md (project root, git-tracked, updated each cycle)
Purpose:  Human-readable current status and handoff state

Contents:
  ## Current Objective
  ## Completed Work (this session)
  ## Files Changed
  ## Tests Executed and Results
  ## Known Findings / Issues
  ## Reviewer Requests (from Codex)
  ## Next Action
  ## Forbidden Actions (for current stage)
  ## V1 Safety Confirmation
```

### 3-4. Project Directory Structure

```
/
├── MASTER_SPEC.md          (canonical specification)
├── CLAUDE.md               (Claude Builder rules)
├── AGENTS.md               (Codex Reviewer rules)
├── STATE.json              (machine-readable state)
├── HANDOFF.md              (latest handoff)
├── docs/
│   └── v2/                 (V2 architecture docs — current docs)
└── reports/
    ├── builder/            (Claude implementation reports)
    ├── tests/              (test result reports)
    ├── codex/              (Codex review results)
    ├── security/           (security audit reports)
    └── deployment/         (deployment records)
```

---

## 4. Automated Flow Design

### 4-1. Stage Execution Flow

```
Step 1: Human defines Stage
  → Updates STATE.json: current_stage, stage_status = IN_PROGRESS
  → Creates or updates Stage specification in docs/

Step 2: Orchestrator reads state
  → MASTER_SPEC.md (requirements)
  → STATE.json (current state)
  → HANDOFF.md (last session state)
  → Stage specification

Step 3: Claude Code Builder executes
  → Implements stage
  → Runs test pipeline (unit → integration → typecheck → build)

Step 4: Test failure handling
  → If tests fail: Claude fixes and re-runs
  → Max 3 fix attempts before HUMAN_GATE escalation

Step 5: Tests pass → Commit
  → Git commit with descriptive message
  → Commit SHA recorded in STATE.json: last_builder_commit
  → HANDOFF.md updated with implementation summary

Step 6: Codex Review triggered
  → Codex reads: AGENTS.md, MASTER_SPEC.md, STATE.json, HANDOFF.md, git diff
  → Independent review (no shared context with Builder)

Step 7A: PASS
  → REVIEW_PASS artifact created
  → STATE.json updated: last_reviewer_status = PASS
  → If human_gate_required: pause for Human
  → If not: proceed to next Stage

Step 7B: FAIL
  → REVIEW_FAIL artifact with structured findings
  → Findings returned to Claude Builder
  → Claude fixes (new commit)
  → Tests re-run
  → Codex re-review
  → review_cycle_count ++

Step 7C: MAX_REVIEW_CYCLES exceeded
  → STATE.json: stage_status = HUMAN_GATE
  → HANDOFF.md: human_gate_reason = "max review cycles exceeded"
  → Human notified (via LINE AVL AI if integrated)
  → Human reviews manually, decides next action
```

### 4-2. Max Review Cycle Policy

```
MAX_REVIEW_CYCLES = 3

After 3 FAIL cycles:
  → stage_status = HUMAN_REVIEW_REQUIRED
  → Orchestrator stops automated loop
  → Human receives notification

Repeat finding policy:
  If the same P0 or P1 finding appears in ≥ 2 cycles:
  → Escalate to HUMAN_REVIEW_REQUIRED immediately
  (Loop is not converging — requires human decision)
```

---

## 5. Structured Review Result Schema

Codex produces machine-readable review result:

```json
{
  "stage":              "V2-Stage-3",
  "reviewed_commit":    "abc123...",
  "review_cycle":       1,
  "status":             "PASS | FAIL | HUMAN_REVIEW_REQUIRED",
  "findings": {
    "p0": [],
    "p1": [],
    "p2": [],
    "p3": []
  },
  "checks": {
    "tests_verified":       true,
    "build_verified":       true,
    "security_verified":    true,
    "production_safe":      true,
    "acceptance_criteria":  true,
    "regression_clean":     true,
    "v1_untouched":         true
  },
  "next_action": "PROCEED_TO_NEXT_STAGE | FIX_AND_RESUBMIT | HUMAN_GATE",
  "reviewer_notes":     "Brief summary of review",
  "reviewed_at":        "2026-09-26T12:00:00Z"
}
```

Finding severity:
- P0: Blocking, must fix before any merge (security, data loss, V1 breakage)
- P1: Must fix before production (correctness, safety)
- P2: Should fix (maintainability, test coverage)
- P3: Optional (style, minor improvement)

PASS = no P0/P1 findings. P2/P3 may exist with PASS status.

---

## 6. Human Gate Policy

### 6-1. Mandatory Human Gates

These require explicit human approval before proceeding:

```
Production DB destructive migration (DROP TABLE, DELETE data, TRUNCATE)
Production DB data deletion or bulk update
Production secret creation or rotation
Production ENV variable mutation (Vercel production, Railway production)
Vercel Production promotion (where deployment risk exists)
Railway Production service mutation
Customer data deletion (individual or bulk)
LIVE MT5 connection establishment
LIVE broker order placement
LIVE broker account mutation
Money movement of any kind
Irreversible infrastructure deletion
Domain transfer or DNS modification
GitHub repository deletion
Supabase project deletion
Console admin role grant/revoke
Any action flagged by Codex as HUMAN_REVIEW_REQUIRED
```

### 6-2. Auto-Approved Actions (no human confirmation needed)

```
Local file edits
Documentation updates
Unit test runs
Integration test runs (non-production)
Typecheck
Build
Lint
Local Playwright tests
Non-production test fixture creation
Read-only code inspection
Git diff / git log / git status
Pull request creation (preview, not production merge)
Preview deployment (Vercel preview URL)
```

---

## 7. Test Pipeline Standard

```
Standard test pipeline for each Stage:

1. Unit Tests          → fast, isolated, no external dependencies
2. Integration Tests   → service-level, with test DB
3. Contract Tests      → API contract verification
4. Security Tests      → auth, isolation, secret handling
5. Playwright E2E      → critical user paths (non-production)
6. Typecheck           → TypeScript strict mode
7. Build               → production build verification

AVL-FX Specific Safety Tests (required for all execution-related stages):
  wrong_customer_denied
  wrong_owner_denied
  stale_market_denied
  knowledge_unavailable_denied
  mt5_disconnected_denied
  live_account_denied (DEMO guard)
  risk_violation_denied
  expired_approval_denied
  duplicate_execution_denied
  broker_fill_required
  broker_close_evidence_required
```

---

## 8. Claude → Codex Handoff Options

Current technical options for automated handoff (to be selected at implementation):

### Option A — MCP-Based Codex Invocation

```
Claude Code has an MCP server that can invoke Codex API
Codex receives:
  - git SHA to review
  - path to HANDOFF.md
  - path to AGENTS.md
  - structured invocation context

Advantage: native tool integration
Challenge: requires MCP server implementation + Codex API access
Status: verify available Claude Code MCP capabilities at implementation
```

### Option B — CLI/Script-Based Invocation

```
Claude generates a review invocation script:
  review.sh {commit_sha} {handoff_path}
  → calls OpenAI API (Codex model)
  → passes structured prompt with diff + context
  → writes result to reports/codex/{timestamp}.json

Advantage: simple, controllable
Challenge: manual script maintenance, API key management
```

### Option C — GitHub Actions Workflow

```
Claude Builder commits and pushes to review branch
GitHub Action triggers:
  - reads HANDOFF.md
  - calls OpenAI API (Codex)
  - posts review result as PR comment
  - updates STATE.json

Advantage: integrated with git workflow
Challenge: requires GitHub Actions modification (Human Gate for CI changes)
```

### Option D — OpenAI API Review Service

```
Separate small service that:
  - accepts {repo_path, commit_sha, handoff_path}
  - calls OpenAI API with structured prompt
  - returns structured review result

Advantage: reusable, isolated
Challenge: additional service to deploy
```

### Option E — Hybrid Local Orchestrator

```
Local Python/Node script that:
  - reads STATE.json
  - invokes Claude Code CLI (builder)
  - invokes OpenAI API (reviewer)
  - updates STATE.json
  - manages the review loop

Advantage: no additional deployment
Challenge: requires script maintenance, API keys locally
```

**Recommendation at V2 initial:** Start with Option B (CLI script). Migrate to Option C (GitHub Actions) when CI pipeline is stable. Option A (MCP) is ideal long-term but requires verifying Claude Code MCP capabilities.

---

## 9. Slash Commands (Future UX)

Proposed command interface for Human to interact with the Orchestrator:

```
/avl:status        — Show STATE.json summary + recent HANDOFF
/avl:build         — Trigger Claude Code Builder for current stage
/avl:test          — Run test pipeline only (no implementation)
/codex:review      — Freeze current commit, trigger Codex review
/avl:handoff       — Generate HANDOFF.md from current session
/avl:resume        — Resume from STATE.json after session loss
/avl:next-stage    — Advance to next stage (if current is COMPLETE + PASS)
```

### /codex:review flow

```
/codex:review triggered:
  1. Verify no uncommitted changes (or auto-commit current state)
  2. Record current git SHA → STATE.json: last_builder_commit
  3. Run test pipeline
  4. Update HANDOFF.md with current state
  5. Invoke Codex (via chosen mechanism)
  6. Wait for structured review result
  7. Update STATE.json with review result
  8. Report to Human
```

### /avl:resume flow

```
/avl:resume triggered (new Claude session):
  1. Read STATE.json → current_stage, stage_status
  2. Read HANDOFF.md → last completed work, pending findings
  3. Read MASTER_SPEC.md → full specification
  4. Read git log → recent commits
  5. Report current state to Human
  6. Ask: "Continue with {current_stage}?" or "Review pending findings?"
```

---

## 10. Context Loss Recovery

### 10-1. Problem

Claude Code and Codex operate in conversation sessions. Session end = context loss.  
A new session has no memory of previous work.

### 10-2. Solution: File-Based State (not conversation-based)

```
Source of Truth Priority:
  1. Git commit log (immutable history)
  2. STATE.json (current machine-readable state)
  3. HANDOFF.md (human-readable context)
  4. reports/ directory (audit trail)
  5. docs/ (specifications)

NOT source of truth:
  - Claude conversation history (ephemeral)
  - Codex conversation history (ephemeral)
```

### 10-3. Git as Handoff Authority

```
Codex reviews a FIXED git SHA:
  → last_builder_commit in STATE.json
  → Git diff from main to that SHA

This SHA does NOT change during review:
  If Claude commits during Codex review → review is invalidated
  Codex must re-start from the new SHA

Review cycle number prevents re-reviewing old SHAs:
  STATE.json: review_cycle_count increments per cycle
```

---

## 11. LINE Notification Integration

When AVL Notification Infrastructure (V2-01) is live, the Orchestrator can use it:

```
Orchestrator events → AVL Notification Service → LINE AVL AI

Examples:
  "V2 Stage 3 implementation complete — Codex review starting"
  "Codex review PASSED — ready for Human Gate"
  "Codex review FAILED — findings returned to Builder"
  "HUMAN_GATE: Production approval required for Stage 5"
  "Build FAILED — test errors detected"
```

LINE messages from Orchestrator: informational only.  
LINE cannot approve Human Gates in V2 initial.  
Human Gate approval happens in Console or explicit human input.

---

## 12. Implementation Roadmap Position

The AVL Development Orchestrator is a development tool, not a customer-facing feature.  
Implementation priority: after V2 core features are designed and V1 is Production Complete.

Suggested implementation stage: **V2-Orchestrator** (between V2-Stage-1 and V2-Stage-2)

Rationale: Orchestrator enables automated implementation of remaining V2 stages.  
Building the Orchestrator first makes subsequent V2 stages faster and more reliable.

See: [V2_IMPLEMENTATION_ROADMAP.md](./V2_IMPLEMENTATION_ROADMAP.md)

// stage-defs.mjs — Stage Definition of Done and review context
// Source of truth: docs/v2/V2_IMPLEMENTATION_ROADMAP.md
// This file provides the structured review context sent to Codex for each stage.

// Commit SHA just before V2 Stage 1 started (last V1 commit).
// Used as --base for cumulative stage review.
export const V2_STAGE_BASELINES = {
  "V2-Stage-1": "f530d5e",
  "V2-Stage-2": "9b3e77c",  // last commit of Stage 1 FROZEN
  // Add future stage baselines here
};

export const STAGE_DEFINITIONS = {
  "V2-Stage-1": {
    name:    "Customer Market Data Persistence",
    doc:     "docs/v2/CUSTOMER_MARKET_DATA_ARCHITECTURE.md",
    summary: "Customer MT5 OHLC bars persisted to Customer Supabase customer_bar_data table.",
    files_changed: [
      "supabase/migrations/035_customer_bar_data.sql",
      "gateway/src/customerBarDataStore.ts",
      "gateway/src/customer-bar-data.test.ts",
      "gateway/src/index.ts (new /market-data/* routes)",
      "gateway/package.json",
    ],
    dod: [
      "customer_bar_data table migration is additive (new table only, V1 bar_data untouched)",
      "POST /market-data/bars: realtime bar ingestion, authenticated via verifyBridgeAuth",
      "POST /market-data/backfill: recovery bar ingestion, authenticated",
      "GET /market-data/last-bar: returns MAX(time_utc) per connection+symbol+tf for gap detection",
      "Idempotent upsert: UNIQUE (connection_id, canonical_symbol, timeframe, time_utc)",
      "UTC normalization: broker server time + utc_offset_hours → UTC",
      "Symbol canonicalization: GOLD#→GOLD, XAUUSD→GOLD",
      "Data validation: reject bars with open=0, high<low, future timestamp, unknown timeframe",
      "Batch limit: 500 bars max per request",
      "RLS: authenticated users read only their own connection's bars",
      "23 unit tests PASS (no mocked Supabase — pure function tests)",
      "Typecheck PASS",
      "Build PASS",
    ],
    security_checklist: [
      "Bridge auth required for all /market-data/* endpoints (verifyBridgeAuth, not just gateway SECRET)",
      "No cross-customer data leakage (RLS enforced)",
      "No secret values in migration SQL or gateway source",
      "connection_id scope: user can only read/write their own connection's bars",
      "No SQL injection vectors (using Supabase client with parameterized queries)",
    ],
    v1_safety: [
      "V1 bar_data table: NOT modified (no ALTER TABLE, no DROP)",
      "V1 execution paths: NOT changed (/bar, /bars/bulk, /bridge/bars, /bridge/bars/bulk routes)",
      "Migration 035 is additive ONLY (new table, new indexes, new RLS policies)",
    ],
    codex_focus: [
      "Idempotency: does ON CONFLICT correctly prevent duplicates?",
      "UTC conversion: is `broker_time_sec - utc_offset * 3600` correct direction?",
      "RLS: can Customer A read Customer B's bars?",
      "Auth: are endpoints properly authenticated? Is gateway SECRET alone sufficient? (Should NOT be)",
      "Validation: are all invalid bar cases rejected?",
      "V1 regression: are any V1 paths affected?",
      "Test adequacy: do 23 tests cover the key requirements?",
    ],
  },

  "V2-Stage-2": {
    name:    "Historical Backfill / Recovery",
    doc:     "docs/v2/CUSTOMER_MARKET_DATA_ARCHITECTURE.md#6-historical-backfill--recovery",
    summary: "Bridge EA reconnect automatically backfills missing bars from MT5 history.",
    files_changed: [
      "supabase/migrations/036_customer_backfill_logs.sql",
      "gateway/src/customerBarDataStore.ts (conflict resolution, countBarsInRange, logBackfill)",
      "gateway/src/customer-backfill.test.ts",
      "gateway/src/index.ts (GET /market-data/bar-count, POST /market-data/backfill/complete)",
    ],
    dod: [
      "GET /market-data/last-bar returns MAX(time_utc) per connection+symbol+tf (Stage 1 carries forward)",
      "Conflict resolution: bridge_recovery/backfill → ignoreDuplicates=true (never overwrite realtime)",
      "GET /market-data/bar-count: returns count of bars in a time range for completeness verification",
      "POST /market-data/backfill/complete: EA signals completion, Gateway logs backfill_summary",
      "customer_backfill_logs table (migration 036, additive)",
      "countCustomerBarsInRange() for completeness verification",
      "logCustomerBackfill() writes summary to customer_backfill_logs",
      "All three endpoints authenticated via verifyBridgeAuth",
      "25 unit tests: gap detection, idempotency, out-of-order, conflict resolution, large-gap, partial retry, completeness, memory safety",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "All /market-data/* endpoints require verifyBridgeAuth (not just gateway SECRET)",
      "No cross-customer data leakage in bar-count query (connection_id scoped)",
      "backfill_logs RLS: authenticated users see only their own logs",
    ],
    v1_safety: [
      "Migration 036 is additive (new table only)",
      "No V1 execution path modified",
      "No changes to Stage 1 features",
    ],
    codex_focus: [
      "Idempotency: does ignoreDuplicates=true correctly prevent realtime bar overwrite?",
      "Completeness: does bar-count use correct connection_id scope?",
      "Authentication: are bar-count and backfill/complete using verifyBridgeAuth?",
      "No false success on partial failure (error propagation)",
      "Memory safety: no unbounded batch accumulation",
      "UTC normalization: is timestamp handling consistent with Stage 1?",
    ],
  },
};

/**
 * Get the review prompt for a given stage and commit.
 * This is sent to Codex as the review instruction.
 */
export function buildReviewPrompt(stageName, commitSha, reviewCycle, baseCommit) {
  const def = STAGE_DEFINITIONS[stageName];
  if (!def) {
    throw new Error(`No stage definition found for: ${stageName}`);
  }

  const dodList  = def.dod.map((d, i) => `  ${i + 1}. ${d}`).join("\n");
  const secList  = def.security_checklist.map(s => `  - ${s}`).join("\n");
  const v1List   = def.v1_safety.map(s => `  - ${s}`).join("\n");
  const focusList = def.codex_focus.map(f => `  - ${f}`).join("\n");
  const filesList = def.files_changed.map(f => `  - ${f}`).join("\n");
  const resolvedBase = baseCommit ?? (V2_STAGE_BASELINES[stageName] ?? "HEAD~10");
  const gitRangeInstructions = `
HOW TO FIND THE STAGE CHANGES (SCOPED):
  IMPORTANT: Only review the Stage 1 specific files listed below.
  Do NOT review pre-existing V1 code or unrelated changes.
  Run: git diff ${resolvedBase} HEAD -- supabase/migrations/035_customer_bar_data.sql
  Run: git diff ${resolvedBase} HEAD -- gateway/src/customerBarDataStore.ts
  Run: git diff ${resolvedBase} HEAD -- gateway/src/customer-bar-data.test.ts
  Then read the NEW routes added to index.ts (search for /market-data/ in the file)
  Run: grep -n "market-data" gateway/src/index.ts
  Run: git diff ${resolvedBase} HEAD -- gateway/src/barDataStore.ts
  Run: git diff ${resolvedBase} HEAD -- gateway/package.json

SCOPE RESTRICTION: The DoD and findings should ONLY cover:
  1. supabase/migrations/035_customer_bar_data.sql (new migration)
  2. gateway/src/customerBarDataStore.ts (new module)
  3. gateway/src/customer-bar-data.test.ts (new tests)
  4. /market-data/bars, /market-data/backfill, /market-data/last-bar routes in index.ts
  5. gateway/package.json (test script)
  6. Scripts and documentation files

DO NOT flag issues in pre-existing V1 routes (/bar, /bridge/bars, /tick, /positions, etc.)
that existed before this stage. Those are V1 code outside Stage 1 scope.
V1 route changes in the cumulative diff are backward-compat maintenance, not Stage 1 deliverables.`;

  return `You are Codex, an INDEPENDENT code reviewer for the AVL-FX trading system.

ROLE: REVIEWER ONLY. Do NOT modify any files. Do NOT write code. Only read and review.
${gitRangeInstructions}

═══════════════════════════════════════════════════
REVIEW TARGET
  Stage:        ${stageName} — ${def.name}
  Commit SHA:   ${commitSha}
  Review Cycle: ${reviewCycle}
═══════════════════════════════════════════════════

CHANGED FILES (read these via git diff of commit ${commitSha}):
${filesList}

═══════════════════════════════════════════════════
DEFINITION OF DONE (verify each):
${dodList}

═══════════════════════════════════════════════════
SECURITY CHECKLIST:
${secList}

═══════════════════════════════════════════════════
V1 SAFETY BASELINE (must not be broken):
${v1List}

═══════════════════════════════════════════════════
FOCUS AREAS:
${focusList}

═══════════════════════════════════════════════════
SEVERITY DEFINITIONS:
  P0 = Blocking: security holes, data loss, V1 execution path broken
  P1 = Must fix before production: correctness bugs, safety violations
  P2 = Should fix: missing tests, maintainability issues
  P3 = Optional: style, minor improvements

PASS = p0 is empty AND p1 is empty
FAIL = p0 OR p1 has items

═══════════════════════════════════════════════════
OUTPUT REQUIREMENT:
Respond with ONLY a valid JSON object. No other text before or after.
No markdown code blocks. Raw JSON only.

{
  "stage": "${stageName}",
  "reviewed_commit": "${commitSha}",
  "review_cycle": ${reviewCycle},
  "status": "PASS",
  "findings": {
    "p0": [],
    "p1": [],
    "p2": [],
    "p3": []
  },
  "checks": {
    "idempotency_correct": true,
    "utc_normalization_correct": true,
    "customer_isolation_correct": true,
    "authentication_correct": true,
    "validation_correct": true,
    "v1_regression_clean": true,
    "security_clean": true,
    "test_adequate": true,
    "migration_safe": true,
    "dod_satisfied": true
  },
  "next_action": "PROCEED_TO_NEXT_STAGE",
  "reviewer_notes": "..."
}
`;
}

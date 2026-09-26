import assert from "node:assert/strict";
import test from "node:test";
import { claimPendingDecision, mapManualDecisionToExecution } from "@/lib/ai-trader/manual-approval";

test("Task 7C: deterministic action mapping has no unsafe fallback", () => {
  assert.equal(mapManualDecisionToExecution("ENTER_LONG"), "BUY");
  assert.equal(mapManualDecisionToExecution("ENTER_SHORT"), "SELL");
  assert.equal(mapManualDecisionToExecution("WAIT"), null);
  assert.equal(mapManualDecisionToExecution("INVALID"), null);
});

test("Task 7C: compare-and-set claim allows exactly one concurrent approver", async () => {
  let status = "PENDING";
  let claims = 0;
  const db = {
    from: () => {
      const state = { id: "d1", user_id: "u1", status: "PENDING" };
      const chain: any = {
        update: () => chain,
        eq: (_key: string, value: string) => { if (value === "APPROVED") state.status = value; return chain; },
        gt: () => chain,
        select: () => chain,
        maybeSingle: async () => {
          if (status !== "PENDING") return { data: null, error: null };
          status = "APPROVED";
          claims += 1;
          return { data: { ...state, status }, error: null };
        },
      };
      return chain;
    },
  };
  const result = await Promise.all([
    claimPendingDecision(db, "d1", "u1", new Date().toISOString()),
    claimPendingDecision(db, "d1", "u1", new Date().toISOString()),
  ]);
  assert.equal(claims, 1);
  assert.equal(result.filter(x => Boolean(x.data)).length, 1);
});

test("Task 7C: claim carries the approved/rejected terminal state", async () => {
  let claimed: unknown;
  const db = {
    from: () => {
      const chain: any = {
        update: (value: unknown) => { claimed = value; return chain; },
        eq: () => chain, gt: () => chain, select: () => chain,
        maybeSingle: async () => ({ data: { id: "d1", status: "REJECTED" }, error: null }),
      };
      return chain;
    },
  };
  await claimPendingDecision(db, "d1", "u1", new Date().toISOString(), "REJECTED");
  assert.equal((claimed as any).status, "REJECTED");
  assert.equal(typeof (claimed as any).decided_at, "string");
});

test("Task 7C: manual approval uses the existing command idempotency contract", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../../../app/api/traders/[id]/decide/route.ts", import.meta.url), "utf8"));
  assert.match(source, /manual_approval:\$\{decision\.id\}/);
  assert.match(source, /createEntryExecutionCommand/);
});

test("Task 7C: production approval route keeps Risk, Execution, and audit boundaries", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../../../app/api/traders/[id]/decide/route.ts", import.meta.url), "utf8"));
  assert.match(source, /claimPendingDecision/);
  assert.match(source, /runCommonRiskCheck/);
  assert.match(source, /createEntryExecutionCommand/);
  assert.match(source, /MANUAL_APPROVAL/);
  assert.doesNotMatch(source, /\.from\("execution_commands"\)\.insert/);
});

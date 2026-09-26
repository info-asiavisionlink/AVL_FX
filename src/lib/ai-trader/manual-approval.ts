export type ManualApprovalAction = "approve" | "reject";
export type ManualDecisionAction = "ENTER_LONG" | "ENTER_SHORT";

export function mapManualDecisionToExecution(action: string): "BUY" | "SELL" | null {
  if (action === "ENTER_LONG") return "BUY";
  if (action === "ENTER_SHORT") return "SELL";
  return null;
}

export function isExecutableManualDecision(action: string): action is ManualDecisionAction {
  return action === "ENTER_LONG" || action === "ENTER_SHORT";
}

/**
 * The update is intentionally a single compare-and-set statement. Supabase
 * translates the chained filters into one PostgreSQL UPDATE, so concurrent
 * approvers cannot both claim the same PENDING row.
 */
export async function claimPendingDecision(
  db: { from: (table: string) => any },
  decisionId: string,
  userId: string,
  now: string,
  claimedStatus: "APPROVED" | "REJECTED" = "APPROVED",
) {
  return db.from("trade_decisions")
    .update({ status: claimedStatus, decided_at: now })
    .eq("id", decisionId)
    .eq("user_id", userId)
    .eq("status", "PENDING")
    .gt("expires_at", now)
    .select("*")
    .maybeSingle();
}

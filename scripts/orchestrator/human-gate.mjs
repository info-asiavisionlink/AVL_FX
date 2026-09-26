// human-gate.mjs — Human Gate enforcement
// These operations ALWAYS require Owner approval. Never auto-execute.

export const HUMAN_GATE_OPERATIONS = [
  "Production DB destructive migration (DROP TABLE, DELETE data, TRUNCATE)",
  "Production DB migration apply (even additive)",
  "Production customer data deletion",
  "Production secret creation or rotation",
  "Production ENV variable mutation (Vercel production, Railway production)",
  "Vercel Production deployment (where deployment risk exists)",
  "Railway Production service mutation",
  "LIVE MT5 connection establishment",
  "LIVE broker order placement",
  "LIVE broker account mutation",
  "Money movement of any kind",
  "Irreversible infrastructure deletion",
  "Domain transfer or DNS modification",
  "GitHub repository deletion",
  "Supabase project deletion",
  "Console admin role grant/revoke",
];

export const PRODUCTION_MIGRATIONS_PENDING = [
  "035_customer_bar_data.sql — HUMAN GATE (apply to Production Supabase)",
];

/**
 * Checks if the proposed action is a Human Gate operation.
 * Returns null if safe, or a description of why it needs human approval.
 */
export function checkHumanGate(action) {
  const lower = action.toLowerCase();

  if (lower.includes("production") && (lower.includes("deploy") || lower.includes("migration") || lower.includes("env") || lower.includes("secret"))) {
    return `Production operation detected: "${action}" requires Human Gate approval`;
  }
  if (lower.includes("drop table") || lower.includes("drop column") || lower.includes("truncate")) {
    return `Destructive DB operation: "${action}" requires Human Gate approval`;
  }
  if (lower.includes("live") && (lower.includes("mt5") || lower.includes("order") || lower.includes("trading"))) {
    return `LIVE trading operation: "${action}" requires Human Gate approval`;
  }
  if (lower.includes("delete") && lower.includes("customer")) {
    return `Customer data deletion: "${action}" requires Human Gate approval`;
  }
  if (lower.includes("money") || lower.includes("stripe") || lower.includes("payment")) {
    return `Money movement: "${action}" requires Human Gate approval`;
  }

  return null;
}

export function printHumanGateRequired(state) {
  console.error("\n╔══════════════════════════════════════════════╗");
  console.error("║           HUMAN GATE REQUIRED                ║");
  console.error("╚══════════════════════════════════════════════╝");
  console.error(`\nStage:   ${state.current_stage}`);
  console.error(`Reason:  ${state.human_gate_reason ?? "See STATE.json"}`);
  if (state.human_gate_action) {
    console.error(`Action:  ${state.human_gate_action}`);
  }
  if (state.human_gate_risk) {
    console.error(`Risk:    ${state.human_gate_risk}`);
  }
  console.error("\nTo proceed: Owner must approve and update STATE.json manually.");
  console.error("Then run: npm run avl:resume\n");
}

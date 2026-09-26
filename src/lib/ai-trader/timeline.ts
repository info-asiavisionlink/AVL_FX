export type TimelineLogRow = {
  id: string;
  user_id: string;
  trader_id: string;
  ai_trader_version_id?: string | null;
  scenario_id?: string | null;
  position_id?: string | null;
  command_id?: string | null;
  trigger_type: string;
  analysis_type?: string | null;
  decision?: string | null;
  market_timestamp?: string | null;
  market_context?: unknown;
  reasoning_summary?: string | null;
  error?: string | null;
  created_at: string;
  ai_traders?: { name?: string | null; market?: string | null; user_id?: string | null } | null;
};

const SAFE_CONTEXT_KEYS = new Set([
  "connection_id", "decision_id", "symbol", "market", "timeframe",
  "approval_status", "result_status", "risk_reason", "position_ticket",
]);

export type TimelineEntry = {
  id: string;
  type: "ai_decision";
  ts: string;
  trader: string;
  market: string;
  trigger: string;
  trigger_label: string;
  decision: string | null;
  decision_label: string;
  reasoning: string;
  error: string | null;
  symbol: string | null;
  user_id: string;
  trader_id: string;
  trader_version_id: string | null;
  scenario_id: string | null;
  decision_id: string | null;
  position_id: string | null;
  command_id: string | null;
  connection_id: string | null;
  market_context: Record<string, string | number | boolean | null>;
};

const TRIGGER_LABELS: Record<string, string> = {
  HOURLY_ANALYSIS: "H1分析", ENTRY_RECHECK: "Entry Recheck", TP_RECHECK: "TP Recheck",
  SL_RECHECK: "SL Recheck", POSITION_REVIEW: "Position Review",
  MANUAL_APPROVAL: "手動承認", H1_BAR_CLOSED: "H1分析", EXECUTION_RESULT: "実行結果",
};

const DECISION_LABELS: Record<string, string> = {
  WAIT: "WAIT", WATCH: "WATCH", ENTER_LONG: "ENTER LONG", ENTER_SHORT: "ENTER SHORT",
  HOLD: "HOLD", CLOSE: "CLOSE", EXTEND_TP: "EXTEND TP", MODIFY_SL: "MODIFY SL",
  MODIFY_TP: "MODIFY TP", INVALIDATE: "INVALIDATE", ERROR: "処理失敗",
};

function safeContext(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    if (raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") out[key] = raw;
  }
  return out;
}

export function sanitizeTimelineLog(row: TimelineLogRow): TimelineEntry | null {
  const owner = row.ai_traders?.user_id;
  if (owner && owner !== row.user_id) return null;
  const context = safeContext(row.market_context);
  const decision = row.decision ?? null;
  const trigger = row.trigger_type || row.analysis_type || "UNKNOWN";
  const rawError = row.error ? String(row.error) : "";
  // Provider/DB exception text can contain secrets or stack traces. Only
  // stable machine-readable reason codes are safe for a customer timeline.
  const error = rawError && /^[A-Z0-9_:\-. ]{1,120}$/.test(rawError)
    ? rawError.slice(0, 120)
    : (rawError ? "AI分析または実行を安全のため見送りました" : null);
  return {
    id: row.id, type: "ai_decision", ts: row.created_at,
    trader: row.ai_traders?.name ?? row.trader_id, market: row.ai_traders?.market ?? "—",
    trigger, trigger_label: TRIGGER_LABELS[trigger] ?? trigger,
    decision, decision_label: decision ? (DECISION_LABELS[decision] ?? decision) : "判断中",
    reasoning: String(row.reasoning_summary ?? (error ? "安全のため処理を見送りました" : "" )).slice(0, 500),
    error, symbol: typeof context.symbol === "string" ? context.symbol : null,
    user_id: row.user_id, trader_id: row.trader_id,
    trader_version_id: row.ai_trader_version_id ?? null, scenario_id: row.scenario_id ?? null,
    decision_id: typeof context.decision_id === "string" ? context.decision_id : null,
    position_id: row.position_id ?? null, command_id: row.command_id ?? null,
    connection_id: typeof context.connection_id === "string" ? context.connection_id : null,
    market_context: context,
  };
}

export function dedupeTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    // The database id is intentionally not the only key: retries can create
    // equivalent rows with different ids. Correlation + event time suppresses
    // those duplicates while allowing the same decision on a later bar.
    const key = [entry.command_id ?? entry.decision_id ?? entry.position_id ?? entry.scenario_id ?? entry.trader_id, entry.trigger, entry.decision ?? "", entry.ts].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

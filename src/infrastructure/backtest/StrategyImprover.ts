// =================================================================
// StrategyImprover.ts — Strategy Improvement Pure Functions (Phase 3-B)
//
// Pure functions のみ。OpenAI 呼び出しは API Route 側で行う。
//
// Exports:
//   buildImprovementPrompt    — analysis + spec → {systemPrompt, userPrompt}
//   parseImprovementResponse  — AI JSON → StrategyImprovementProposal | error
//   applyChangesToSpec        — spec + validated changes → proposed StrategySpec
// =================================================================

import { StrategySpecSchema, type StrategySpec } from "@/lib/strategySchema";
import {
  StrategyImprovementProposalSchema,
  type StrategyImprovementProposal,
  type ChangeItem,
  ALLOWED_FIELD_PATTERNS,
  FORBIDDEN_FIELD_PREFIXES,
} from "./ImprovementSchema";
import type { StrategyAIAnalysisRecord } from "./analysisSchema";

// ------------------------------------------------------------------
// Parse result type
// ------------------------------------------------------------------

export type ImprovementParseResult =
  | { ok: true;  proposal: StrategyImprovementProposal }
  | { ok: false; error: string; raw?: unknown };

// ------------------------------------------------------------------
// buildImprovementPrompt
// ------------------------------------------------------------------

export function buildImprovementPrompt(
  analysis: Pick<StrategyAIAnalysisRecord,
    "summary" | "facts" | "observations" | "hypotheses" | "weaknesses" | "recommendations"
    | "confidence" | "data_quality_note">,
  spec:     StrategySpec,
  requiresMoreData: boolean,
): { systemPrompt: string; userPrompt: string } {

  const systemPrompt = `You are AVL FX Strategy Improvement Advisor.

## YOUR ROLE
Based on an AI backtest analysis, propose a MINIMAL, targeted set of strategy parameter changes.
You do NOT modify the strategy directly. A human must review and APPLY your proposal.

## STRICT RULES

### CHANGE CONSTRAINTS
- changes: 1-3 items MAXIMUM. Fewer is better.
- add_condition: at most 1 (type="add", field="add_condition")
- NEVER propose the same field twice in one proposal.
- Each change must have a unique field path.

### ALLOWED FIELDS (whitelist — reject anything else)
Modify existing conditions:
  entry_conditions.conditions[N].threshold
  entry_conditions.conditions[N].period
  entry_conditions.conditions[N].operator
  entry_conditions.logic

Modify filters:
  filters.max_spread_pips
  filters.sessions
  filters.trend_filter
  filters.min_adx

Modify exit conditions:
  exit_conditions.stop_loss.multiplier
  exit_conditions.stop_loss.pips
  exit_conditions.take_profit.rr_ratio
  exit_conditions.take_profit.pips

Add a new entry condition:
  field: "add_condition", type: "add"

### ABSOLUTELY FORBIDDEN
- strategy_type, symbols, timeframes, name, risk, description
- Changing any .indicator or .timeframe of an existing condition
- Removing or deleting conditions (no "remove", "delete", or null in "to")
- Any field NOT in the whitelist above

### "from" VALUE REQUIREMENT
For type="modify" changes:
  The "from" field MUST match the current strategy spec EXACTLY.
  Do not invent or estimate the current value.
  Use the exact values shown in the "CURRENT STRATEGY SPEC" section below.

### fact_basis REQUIREMENT
  Must reference a specific fact or observation from the analysis.
  Quote it briefly (e.g., "SL hit rate=78.57%", "LOW win rate=21.4%").

### LANGUAGE REQUIREMENTS
  expected_effects.hypothesis: Use "may", "might", "could", "hypothesis", "possible"
  NEVER assert improvements as guaranteed.
  risks: Be honest. Include the possibility of worse results.

### requires_more_data
  Set true if the analysis has low confidence (sampleSizeWarning).
  A proposal can still be generated but the UI will show a warning.

## OUTPUT FORMAT (strict JSON only — no markdown, no explanation)
{
  "changes": [
    {
      "field": "string (exact path from whitelist)",
      "type": "modify" | "add",
      "from": <exact current value>,
      "to": <proposed new value>,
      "reason": "string (10-500 chars, why this specific change)",
      "confidence": 0.0-1.0,
      "fact_basis": "string (quote a specific fact or observation)"
    }
  ],
  "expected_effects": {
    "hypothesis": "string (must use hypothetical language)",
    "metric_targets": {
      "win_rate": "string (optional, e.g., 'may improve from 21% to 30-35%')",
      "profit_factor": "string (optional)",
      "total_pips": "string (optional)",
      "max_drawdown_pct": "string (optional)"
    }
  },
  "risks": ["string (1-300 chars each)"],
  "confidence": 0-100 (integer, your confidence level),
  "requires_more_data": true | false
}`;

  // ── User Prompt ────────────────────────────────────────────────

  // Current spec をフォーマット
  const conds = spec.entry_conditions.conditions.map((c, i) => {
    const parts = [
      `[${i}] ${c.indicator} (${c.timeframe})`,
      c.operator ? `op=${c.operator}` : "",
      c.threshold !== undefined ? `threshold=${c.threshold}` : "",
      c.period !== undefined ? `period=${c.period}` : "",
    ].filter(Boolean);
    return `    ${parts.join(", ")}`;
  }).join("\n");

  const filtersStr = spec.filters
    ? JSON.stringify(spec.filters, null, 2).split("\n").map(l => "  " + l).join("\n")
    : "  (none)";

  const exitStr = spec.exit_conditions
    ? JSON.stringify(spec.exit_conditions, null, 2).split("\n").map(l => "  " + l).join("\n")
    : "  (none)";

  // Analysis 要約
  const factsStr = analysis.facts.slice(0, 10).map((f, i) =>
    `  F${i+1}. [${f.source}] ${f.statement}${f.value !== undefined && f.value !== null ? ` (${f.value})` : ""}`
  ).join("\n");

  const obsStr = analysis.observations.slice(0, 5).map((o, i) =>
    `  O${i+1}. ${o.observation}`
  ).join("\n");

  const hypStr = analysis.hypotheses.slice(0, 4).map((h, i) =>
    `  H${i+1}. ${h.hypothesis}`
  ).join("\n");

  const weakStr = analysis.weaknesses.slice(0, 4).map(w =>
    `  - ${w.point}${w.detail ? `: ${w.detail}` : ""}`
  ).join("\n");

  const recStr = analysis.recommendations.slice(0, 4).map(r =>
    `  [${r.priority ?? "LOW"}] ${r.action}`
  ).join("\n");

  const dataWarning = requiresMoreData
    ? "\n⚠ SAMPLE SIZE WARNING: Less than 30 trades. Set requires_more_data=true and keep confidence low (≤50)."
    : "";

  const userPrompt = `## CURRENT STRATEGY SPEC

Name:         ${spec.name}
Type:         ${spec.strategy_type}
Symbols:      ${spec.symbols.join(", ")}
Timeframes:   ${spec.timeframes.join(", ")}
Entry Logic:  ${spec.entry_conditions.logic}

Entry Conditions:
${conds}

Filters:
${filtersStr}

Exit Conditions:
${exitStr}

Risk: ${spec.risk.risk_per_trade}%

## BACKTEST ANALYSIS RESULTS

Summary: ${analysis.summary}
Analysis Confidence: ${analysis.confidence}/100
Data Quality: ${analysis.data_quality_note}
${dataWarning}

FACTS (verified from backtest data):
${factsStr}

OBSERVATIONS:
${obsStr}

HYPOTHESES:
${hypStr}

WEAKNESSES:
${weakStr}

ANALYST RECOMMENDATIONS:
${recStr}

## YOUR TASK

Based on the above analysis, generate a MINIMAL improvement proposal (1-3 changes).
Focus on the most impactful, evidence-based changes.
Use exact values from the CURRENT STRATEGY SPEC for all "from" fields.
Do not change indicators, symbols, timeframes, or risk settings.

Output the JSON proposal now.`;

  return { systemPrompt, userPrompt };
}

// ------------------------------------------------------------------
// parseImprovementResponse
// ------------------------------------------------------------------

export function parseImprovementResponse(jsonText: string): ImprovementParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "AI output is not valid JSON", raw: jsonText };
  }

  const result = StrategyImprovementProposalSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Schema validation failed: ${issues}`, raw };
  }

  return { ok: true, proposal: result.data };
}

// ------------------------------------------------------------------
// applyChangesToSpec
//
// Current StrategySpec に検証済み changes を適用して
// proposed_spec を生成する。AI に spec を自由生成させない。
//
// Throws if:
//   - field path is invalid
//   - conditions index out of range
//   - resulting spec fails StrategySpecSchema
// ------------------------------------------------------------------

export function applyChangesToSpec(
  spec:    StrategySpec,
  changes: ChangeItem[],
): StrategySpec {
  // ディープコピー
  const proposed = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;

  for (const change of changes) {
    const { field, type, to } = change;

    if (type === "add") {
      // add_condition: entry_conditions.conditions に追加
      const ec = proposed.entry_conditions as Record<string, unknown>;
      const conds = ec.conditions as unknown[];
      if (conds.length >= 8) {
        throw new Error("Cannot add condition: maximum 8 conditions already reached");
      }
      conds.push(to);
      continue;
    }

    // modify: フィールドパスを解析して適用
    applyFieldValue(proposed, field, to);
  }

  // StrategySpecSchema で再バリデーション
  const validation = StrategySpecSchema.safeParse(proposed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Proposed spec failed validation: ${issues}`);
  }

  return validation.data;
}

// ------------------------------------------------------------------
// Internal: set nested value by dot-bracket path
// ------------------------------------------------------------------

function applyFieldValue(
  obj:   Record<string, unknown>,
  path:  string,
  value: unknown,
): void {
  // "entry_conditions.conditions[0].threshold"
  // → ["entry_conditions", "conditions", "0", "threshold"]
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cur[p] === null || cur[p] === undefined || typeof cur[p] !== "object") {
      throw new Error(`Invalid path at "${p}" in "${path}"`);
    }
    cur = cur[p] as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1]!;
  cur[leaf] = value;
}

// ------------------------------------------------------------------
// conditionIndexExists — API Route から呼ぶユーティリティ
// ------------------------------------------------------------------

export function conditionIndexExists(spec: StrategySpec, index: number): boolean {
  return index >= 0 && index < spec.entry_conditions.conditions.length;
}

// ------------------------------------------------------------------
// isAllowedField — whitelist チェックユーティリティ
// ------------------------------------------------------------------

export function isAllowedField(field: string): boolean {
  if (FORBIDDEN_FIELD_PREFIXES.some(p => field === p || field.startsWith(p + "."))) {
    return false;
  }
  if (field.endsWith(".indicator") || field.endsWith(".timeframe")) {
    return false;
  }
  return ALLOWED_FIELD_PATTERNS.some(p => p.test(field));
}

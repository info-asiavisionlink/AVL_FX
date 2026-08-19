// =================================================================
// ImprovementSchema.ts — AI Strategy Improvement の Zod バリデーション
//
// Phase 3-B: Phase 3-A Analysis → Improvement Proposal
//
// 設計原則:
//   - AI は proposed_spec を直接生成しない
//   - Changes → Whitelist → from値検証 → Server-side Patch
//   - Whitelist 外の変更は Zod レイヤーで拒否する前に別途検証
//   - changes は最大3件、add_condition は最大1件
// =================================================================

import { z } from "zod";
import {
  ALLOWED_INDICATORS,
  ALLOWED_TIMEFRAMES,
  ALLOWED_OPERATORS,
} from "@/lib/strategySchema";

// ------------------------------------------------------------------
// Whitelist 定数
// ------------------------------------------------------------------

/** AI が変更できるフィールドパスのパターン（正規表現） */
export const ALLOWED_FIELD_PATTERNS: ReadonlyArray<RegExp> = [
  /^entry_conditions\.conditions\[\d+\]\.threshold$/,
  /^entry_conditions\.conditions\[\d+\]\.period$/,
  /^entry_conditions\.conditions\[\d+\]\.operator$/,
  /^entry_conditions\.logic$/,
  /^filters\.max_spread_pips$/,
  /^filters\.sessions$/,
  /^filters\.trend_filter$/,
  /^filters\.min_adx$/,
  /^exit_conditions\.stop_loss\.multiplier$/,
  /^exit_conditions\.stop_loss\.pips$/,
  /^exit_conditions\.take_profit\.rr_ratio$/,
  /^exit_conditions\.take_profit\.pips$/,
  /^add_condition$/,   // type="add" 専用
] as const;

/** AI が変更禁止のフィールド（前方一致で拒否） */
export const FORBIDDEN_FIELD_PREFIXES: ReadonlyArray<string> = [
  "strategy_type",
  "symbols",
  "timeframes",
  "name",
  "risk",
  "description",
] as const;

/** 条件の indicator 変更禁止キーワード */
export const FORBIDDEN_SUBFIELDS: ReadonlyArray<string> = [
  ".indicator",
  ".timeframe",
] as const;

// ------------------------------------------------------------------
// Sub-schemas
// ------------------------------------------------------------------

/** ChangeItem — 1件の変更提案 */
export const ChangeItemSchema = z.object({
  field:      z.string().min(1).max(200),
  type:       z.enum(["modify", "add"]),
  from:       z.unknown(),   // Server-side で現 Spec 値と照合
  to:         z.unknown(),   // 適用する新値
  reason:     z.string().min(10).max(500),
  confidence: z.number().min(0).max(1),
  fact_basis: z.string().min(1).max(500),
});

/** ExpectedEffects — 期待効果 */
export const ExpectedEffectsSchema = z.object({
  hypothesis:     z.string().min(1).max(600),
  metric_targets: z.object({
    win_rate:          z.string().max(200).optional(),
    profit_factor:     z.string().max(200).optional(),
    total_pips:        z.string().max(200).optional(),
    max_drawdown_pct:  z.string().max(200).optional(),
  }),
});

/** AI が返す Improvement Proposal の全体スキーマ */
export const StrategyImprovementProposalSchema = z.object({
  changes:            z.array(ChangeItemSchema).min(1).max(3),
  expected_effects:   ExpectedEffectsSchema,
  risks:              z.array(z.string().min(1).max(300)).min(1).max(8),
  confidence:         z.number().int().min(0).max(100),
  requires_more_data: z.boolean(),
});

// ------------------------------------------------------------------
// TypeScript types
// ------------------------------------------------------------------

export type ChangeItem                   = z.infer<typeof ChangeItemSchema>;
export type ExpectedEffects              = z.infer<typeof ExpectedEffectsSchema>;
export type StrategyImprovementProposal  = z.infer<typeof StrategyImprovementProposalSchema>;

// ------------------------------------------------------------------
// DB Record 型 (strategy_improvements テーブル)
// ------------------------------------------------------------------

export interface StrategyImprovementRecord {
  id:                 string;
  strategy_id:        string;
  analysis_id:        string;
  from_version:       number;
  changes:            ChangeItem[];
  expected_effects:   ExpectedEffects;
  risks:              string[];
  proposed_spec:      Record<string, unknown>;
  confidence:         number;
  requires_more_data: boolean;
  status:             "PROPOSED" | "APPLIED" | "REJECTED";
  model:              string;
  created_at:         string;
}

// ------------------------------------------------------------------
// Parsed field path
// ------------------------------------------------------------------

export interface ParsedConditionPath {
  type:  "condition";
  index: number;       // entry_conditions.conditions[N]
  leaf:  "threshold" | "period" | "operator";
}

export interface ParsedSimplePath {
  type: "simple";
  path: string;        // filters.max_spread_pips など
}

export interface ParsedAddCondition {
  type: "add_condition";
}

export type ParsedFieldPath =
  | ParsedConditionPath
  | ParsedSimplePath
  | ParsedAddCondition;

/** "entry_conditions.conditions[2].threshold" をパース */
export function parseFieldPath(field: string): ParsedFieldPath | null {
  // add_condition
  if (field === "add_condition") return { type: "add_condition" };

  // entry_conditions.conditions[N].leaf
  const condMatch = field.match(/^entry_conditions\.conditions\[(\d+)\]\.(threshold|period|operator)$/);
  if (condMatch) {
    const leaf = condMatch[2] as "threshold" | "period" | "operator";
    return { type: "condition", index: Number(condMatch[1]), leaf };
  }

  // simple path (filters.*, exit_conditions.*, entry_conditions.logic)
  if (ALLOWED_FIELD_PATTERNS.some(p => p.test(field))) {
    return { type: "simple", path: field };
  }

  return null;
}

// ------------------------------------------------------------------
// Validation helpers (used in tests and API route)
// ------------------------------------------------------------------

/** Whitelist + forbidden フィールド検証 */
export interface WhitelistResult {
  valid:      boolean;
  violations: string[];
}

export function validateWhitelist(
  changes: ChangeItem[],
): WhitelistResult {
  const violations: string[] = [];
  const seenFields = new Set<string>();

  // 最大3件
  if (changes.length > 3) {
    violations.push(`Too many changes: ${changes.length} (maximum is 3)`);
  }

  // add_condition は最大1件
  const addCount = changes.filter(c => c.type === "add").length;
  if (addCount > 1) {
    violations.push(`add_condition cannot exceed 1 (got ${addCount})`);
  }

  for (const change of changes) {
    const field = change.field;

    // 重複フィールド禁止
    if (seenFields.has(field)) {
      violations.push(`Duplicate field: "${field}"`);
    }
    seenFields.add(field);

    // FORBIDDEN_FIELD_PREFIXES チェック
    const isForbiddenPrefix = FORBIDDEN_FIELD_PREFIXES.some(p =>
      field === p || field.startsWith(p + ".")
    );
    if (isForbiddenPrefix) {
      violations.push(`Forbidden field: "${field}" — strategy_type/symbols/timeframes/name/risk cannot be changed`);
      continue;
    }

    // Forbidden subfields (indicator / timeframe of a condition)
    const hasForbiddenSub = FORBIDDEN_SUBFIELDS.some(s => field.endsWith(s));
    if (hasForbiddenSub) {
      violations.push(`Forbidden field: "${field}" — indicator and timeframe of conditions cannot be changed`);
      continue;
    }

    // type 検証
    if (change.type !== "modify" && change.type !== "add") {
      violations.push(`Invalid type "${change.type}" for field "${field}"`);
      continue;
    }

    // add_condition は field="add_condition" のみ許可
    if (change.type === "add" && field !== "add_condition") {
      violations.push(`type="add" must have field="add_condition" (got "${field}")`);
      continue;
    }

    // Whitelist パターン照合（modify のみ）
    if (change.type === "modify") {
      const allowed = ALLOWED_FIELD_PATTERNS.some(p => p.test(field));
      if (!allowed) {
        violations.push(`Field "${field}" is not in the allowed whitelist`);
      }
    }

    // conditions[N] の N が存在するかは API Route 側でチェック（spec 依存）
  }

  return { valid: violations.length === 0, violations };
}

/** from 値と現 Spec の照合 */
export interface FromValueResult {
  valid:      boolean;
  violations: string[];
}

export function validateFromValues(
  changes:  ChangeItem[],
  specJson: Record<string, unknown>,
): FromValueResult {
  const violations: string[] = [];

  for (const change of changes) {
    if (change.type === "add") continue; // add は from 検証不要

    const parsed = parseFieldPath(change.field);
    if (!parsed || parsed.type === "add_condition") continue;

    let actual: unknown;
    try {
      actual = getNestedValue(specJson, change.field);
    } catch {
      violations.push(`Cannot read field "${change.field}" from current spec`);
      continue;
    }

    if (!deepEqual(actual, change.from)) {
      violations.push(
        `Field "${change.field}" from=${JSON.stringify(change.from)} ` +
        `but current spec has ${JSON.stringify(actual)}`
      );
    }
  }

  return { valid: violations.length === 0, violations };
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  // Handle array notation: "entry_conditions.conditions[0].threshold"
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      throw new Error(`Cannot navigate path at "${p}"`);
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  // null と undefined は「未設定」として同等扱い
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 0.001;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && b !== null) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ));
  }
  return false;
}

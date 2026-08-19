// =================================================================
// VersionSchema.ts — Strategy Version の型定義・Pure Utilities
//
// Phase 3-C: Version Management
//
// Exports:
//   Types: BacktestSummary, ComparisonItem, VersionComparisonResult,
//          StrategyVersionRecord
//   extractBacktestSummary — DB row → BacktestSummary
//   getNextVersion         — version 採番
//   isValidTransition      — status 遷移バリデーション
//   generateChangeSummary  — changes[] → 人間可読要約
// =================================================================

import type { ChangeItem } from "./ImprovementSchema";

// ------------------------------------------------------------------
// Backtest Summary (比較用に必要な最小セット)
// ------------------------------------------------------------------

export interface BacktestSummary {
  totalTrades:      number;
  wins:             number;
  losses:           number;
  winRate:          number;
  totalPips:        number;
  profitFactor:     number | null;
  maxDrawdown:      number;
  maxDrawdownPct:   number;
  maxConsWins:      number;
  maxConsLosses:    number;
  avgDurationMin:   number;
  sampleSizeWarning: boolean;
  bestSession:      string | null;
  worstSession:     string | null;
  verdict:          "PASSED" | "CONDITIONAL" | "FAILED";
  dataCoverageDays: number;
}

// ------------------------------------------------------------------
// Comparison Result
// ------------------------------------------------------------------

export interface ComparisonItem {
  metric:  string;
  before:  number | string | null;
  after:   number | string | null;
  delta:   number | null;
  note:    string;    // "↑ improved", "↓ regressed", "~" unchanged
}

export interface VersionComparisonResult {
  verdict:      "IMPROVED" | "CONDITIONAL" | "REGRESSION" | "INCONCLUSIVE";
  improvements: ComparisonItem[];
  regressions:  ComparisonItem[];
  unchanged:    ComparisonItem[];
  warnings:     string[];
  summary:      string;
}

// ------------------------------------------------------------------
// DB Record 型
// ------------------------------------------------------------------

export interface StrategyVersionRecord {
  id:             string;
  strategy_id:    string;
  version:        number;
  spec_snapshot:  Record<string, unknown>;
  created_by:     "user" | "ai_improvement";
  parent_version: number | null;
  improvement_id: string | null;
  best_job_id:    string | null;
  change_summary: string | null;
  created_at:     string;
  // Joined (optional)
  backtest?:      BacktestSummary | null;
}

// ------------------------------------------------------------------
// extractBacktestSummary — backtest_results DB row → BacktestSummary
// ------------------------------------------------------------------

export function extractBacktestSummary(
  row: Record<string, unknown> | null | undefined,
): BacktestSummary | null {
  if (!row) return null;

  const pf = row.profit_factor;
  return {
    totalTrades:      Number(row.total_trades   ?? 0),
    wins:             Number(row.wins            ?? 0),
    losses:           Number(row.losses          ?? 0),
    winRate:          Number(row.win_rate        ?? 0),
    totalPips:        Number(row.total_pips      ?? 0),
    profitFactor:     pf === null || pf === undefined ? null : Number(pf),
    maxDrawdown:      Number(row.max_drawdown    ?? 0),
    maxDrawdownPct:   Number(row.max_drawdown_pct ?? 0),
    maxConsWins:      Number(row.max_cons_wins   ?? 0),
    maxConsLosses:    Number(row.max_cons_losses ?? 0),
    avgDurationMin:   Number(row.avg_duration_min ?? 0),
    sampleSizeWarning: Boolean(row.sample_size_warning ?? false),
    bestSession:      (row.best_session  as string | null) ?? null,
    worstSession:     (row.worst_session as string | null) ?? null,
    verdict:          (row.verdict as "PASSED" | "CONDITIONAL" | "FAILED") ?? "FAILED",
    dataCoverageDays: Number(row.data_coverage_days ?? 0),
  };
}

// ------------------------------------------------------------------
// getNextVersion — 既存 Version 一覧から次番号を算出
// ------------------------------------------------------------------

export function getNextVersion(
  versions: ReadonlyArray<{ version: number }>,
): number {
  if (versions.length === 0) return 1;
  return Math.max(...versions.map(v => v.version)) + 1;
}

// ------------------------------------------------------------------
// isValidTransition — Improvement status 遷移の検証
//
// PROPOSED → apply   → APPLIED   ✅
// PROPOSED → reject  → REJECTED  ✅
// APPLIED  → any     → ✗
// REJECTED → any     → ✗
// ------------------------------------------------------------------

export function isValidTransition(
  fromStatus: string,
  action:     "apply" | "reject",
): boolean {
  if (fromStatus !== "PROPOSED") return false;
  return action === "apply" || action === "reject";
}

// ------------------------------------------------------------------
// generateChangeSummary — ChangeItem[] → 人間可読要約
// ------------------------------------------------------------------

export function generateChangeSummary(changes: ChangeItem[]): string {
  if (changes.length === 0) return "";

  const parts = changes.map(c => {
    if (c.type === "add") {
      const to = c.to as Record<string, unknown> | null;
      const ind = to?.indicator ?? "condition";
      return `Added ${ind} condition`;
    }
    // modify: extract friendly name
    const field = c.field;
    const friendly = field
      .replace(/^entry_conditions\.conditions\[(\d+)\]\./, "Cond[$1].")
      .replace(/^exit_conditions\./, "Exit.")
      .replace(/^filters\./, "Filter.");
    return `${friendly}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
  });

  return parts.join("; ");
}

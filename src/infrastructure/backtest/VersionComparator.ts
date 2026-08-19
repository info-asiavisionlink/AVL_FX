// =================================================================
// VersionComparator.ts — Backtest バージョン間比較 (Phase 3-C)
//
// Pure function のみ。DB / OpenAI 非依存。
//
// Verdict:
//   IMPROVED     — 主要指標が改善、リグレッションなし、十分なサンプル
//   CONDITIONAL  — 改善あるが不確実（サンプル不足 or 混在）
//   REGRESSION   — リグレッションが改善を上回る
//   INCONCLUSIVE — データ不足で判定不能
// =================================================================

import type {
  BacktestSummary,
  ComparisonItem,
  VersionComparisonResult,
} from "./VersionSchema";

// ------------------------------------------------------------------
// Thresholds — 有意な変化とみなす最小差分
// ------------------------------------------------------------------

const THRESHOLD = {
  totalPips:      5,    // ±5 pips 以上で meaningful
  profitFactor:   0.1,  // ±0.10 以上
  winRate:        4,    // ±4% 以上
  maxDrawdownPct: 0.5,  // ±0.5% 以上
  maxConsLosses:  1,    // ±1 以上
  totalTrades:    3,    // ±3 以上
} as const;

// ------------------------------------------------------------------
// compareMetric — 1メトリックの改善/リグレッション判定
// ------------------------------------------------------------------

interface MetricSpec {
  label:         string;
  prev:          number | null;
  curr:          number | null;
  higherBetter:  boolean;
  threshold:     number;
  unit?:         string;
}

function compareMetric(spec: MetricSpec): ComparisonItem {
  const { label, prev, curr, higherBetter, threshold, unit = "" } = spec;

  if (prev === null || curr === null) {
    return { metric: label, before: prev, after: curr, delta: null, note: "~" };
  }

  const delta     = curr - prev;
  const absDelta  = Math.abs(delta);
  const positive  = higherBetter ? delta > 0 : delta < 0;

  let note: string;
  if (absDelta < threshold) {
    note = `~ (Δ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}${unit}, below threshold)`;
  } else if (positive) {
    note = `↑ improved (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}${unit})`;
  } else {
    note = `↓ regressed (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}${unit})`;
  }

  return { metric: label, before: prev, after: curr, delta, note };
}

// ------------------------------------------------------------------
// determineVerdict
// ------------------------------------------------------------------

function determineVerdict(
  improvements:    ComparisonItem[],
  regressions:     ComparisonItem[],
  warnings:        string[],
  prevSampleWarn:  boolean,
  currSampleWarn:  boolean,
  tradeDropRatio:  number,   // curr.totalTrades / prev.totalTrades
): "IMPROVED" | "CONDITIONAL" | "REGRESSION" | "INCONCLUSIVE" {

  // INCONCLUSIVE の条件:
  //   - 両方サンプル不足
  //   - Trade 数が半分以下に減少
  //   - 新 Version が極端に少ない (< 15 trades 相当 = sampleSizeWarning)
  const bothSmall    = prevSampleWarn && currSampleWarn;
  const tradeDrop    = tradeDropRatio < 0.5;

  if (bothSmall || tradeDrop) return "INCONCLUSIVE";

  // REGRESSION の条件
  if (improvements.length === 0 && regressions.length > 0) return "REGRESSION";
  if (regressions.length > improvements.length)             return "REGRESSION";

  // IMPROVED or CONDITIONAL
  if (improvements.length > 0 && regressions.length === 0) {
    // サンプル警告や警告がある場合は CONDITIONAL
    if (currSampleWarn || warnings.length > 0) return "CONDITIONAL";
    return "IMPROVED";
  }

  // 混在 (improvements ≥ regressions > 0) → CONDITIONAL
  return "CONDITIONAL";
}

// ------------------------------------------------------------------
// buildSummary — 人間可読サマリー
// ------------------------------------------------------------------

function buildSummary(
  verdict:      "IMPROVED" | "CONDITIONAL" | "REGRESSION" | "INCONCLUSIVE",
  improvements: ComparisonItem[],
  regressions:  ComparisonItem[],
  warnings:     string[],
): string {
  const parts: string[] = [];

  switch (verdict) {
    case "IMPROVED":
      parts.push("Version shows overall improvement.");
      break;
    case "CONDITIONAL":
      parts.push("Version shows mixed or uncertain results.");
      break;
    case "REGRESSION":
      parts.push("Version shows regression in key metrics.");
      break;
    case "INCONCLUSIVE":
      parts.push("Cannot determine improvement due to insufficient data.");
      break;
  }

  if (improvements.length > 0) {
    parts.push(`Improved: ${improvements.map(i => i.metric).join(", ")}.`);
  }
  if (regressions.length > 0) {
    parts.push(`Regressed: ${regressions.map(r => r.metric).join(", ")}.`);
  }
  if (warnings.length > 0) {
    parts.push(`Warning: ${warnings[0]}`);
  }

  return parts.join(" ");
}

// ------------------------------------------------------------------
// compareVersions — メイン関数
// ------------------------------------------------------------------

export function compareVersions(
  prev: BacktestSummary,
  curr: BacktestSummary,
): VersionComparisonResult {

  const improvements: ComparisonItem[] = [];
  const regressions:  ComparisonItem[] = [];
  const unchanged:    ComparisonItem[] = [];
  const warnings:     string[]         = [];

  // ── メトリック比較 ─────────────────────────────────────────────

  const metrics: MetricSpec[] = [
    { label: "totalPips",      prev: prev.totalPips,      curr: curr.totalPips,      higherBetter: true,  threshold: THRESHOLD.totalPips,      unit: " pips" },
    { label: "profitFactor",   prev: prev.profitFactor,   curr: curr.profitFactor,   higherBetter: true,  threshold: THRESHOLD.profitFactor,              },
    { label: "winRate",        prev: prev.winRate,        curr: curr.winRate,        higherBetter: true,  threshold: THRESHOLD.winRate,        unit: "%"    },
    { label: "maxDrawdownPct", prev: prev.maxDrawdownPct, curr: curr.maxDrawdownPct, higherBetter: false, threshold: THRESHOLD.maxDrawdownPct, unit: "%"    },
    { label: "maxConsLosses",  prev: prev.maxConsLosses,  curr: curr.maxConsLosses,  higherBetter: false, threshold: THRESHOLD.maxConsLosses             },
    { label: "totalTrades",    prev: prev.totalTrades,    curr: curr.totalTrades,    higherBetter: true,  threshold: THRESHOLD.totalTrades               },
  ];

  for (const spec of metrics) {
    const item = compareMetric(spec);
    const absDelta = Math.abs(item.delta ?? 0);
    const threshold = spec.threshold;

    if (item.delta === null || absDelta < threshold) {
      unchanged.push(item);
    } else if (item.note.startsWith("↑")) {
      improvements.push(item);
    } else {
      regressions.push(item);
    }
  }

  // ── 警告 ────────────────────────────────────────────────────────

  if (curr.sampleSizeWarning) {
    warnings.push(`New version has insufficient sample size (< 30 trades, got ${curr.totalTrades})`);
  }

  const prevTrades = prev.totalTrades;
  const currTrades = curr.totalTrades;
  const tradeDropRatio = prevTrades > 0 ? currTrades / prevTrades : 1;

  if (prevTrades > 0 && tradeDropRatio < 0.5) {
    warnings.push(
      `Trade count dropped significantly: ${prevTrades} → ${currTrades} (${Math.round(tradeDropRatio * 100)}% of previous)`
    );
  }

  if (curr.dataCoverageDays < prev.dataCoverageDays * 0.5 && curr.dataCoverageDays > 0) {
    warnings.push(
      `Data coverage reduced: ${prev.dataCoverageDays} → ${curr.dataCoverageDays} days`
    );
  }

  // ── Verdict 判定 ────────────────────────────────────────────────

  const verdict = determineVerdict(
    improvements,
    regressions,
    warnings,
    prev.sampleSizeWarning,
    curr.sampleSizeWarning,
    tradeDropRatio,
  );

  // セッション変化を unchanged に追加（情報提供目的）
  if (prev.bestSession !== curr.bestSession) {
    unchanged.push({
      metric: "bestSession",
      before: prev.bestSession,
      after:  curr.bestSession,
      delta:  null,
      note:   "changed",
    });
  }

  const summary = buildSummary(verdict, improvements, regressions, warnings);

  return { verdict, improvements, regressions, unchanged, warnings, summary };
}

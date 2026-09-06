// =================================================================
// InterpretationEngine.ts — Phase 4-D Cross-Phase AI Interpretation
//
// Pure functions のみ。DB / OpenAI 呼び出しは API Route 側で行う。
//
// 設計原則:
//   - Phase 3-A/4-A/4-B/4-C の結果を横断的に AI 解釈させる
//   - AI は Fact を述べる。将来予測・パラメータ推奨は禁止
//   - Confidence はコードで決定論的に計算 (AI の自己申告を使わない)
//   - 数値 Integrity チェック: AI が述べた数値が Context と一致するか確認
//   - STRICTLY READ-ONLY: この Engine はいかなる DB テーブルも変更しない
// =================================================================

import type {
  InterpretationContext,
  Phase4DInterpretationAIOutput,
  Phase4DInterpretationAIOutputSchema,
  IntegrityResult,
} from "./InterpretationSchema";
import {
  Phase4DInterpretationAIOutputSchema as _schema,
} from "./InterpretationSchema";

// エクスポート (API Route, Tests が import できるよう)
export type {
  InterpretationContext,
  Phase4DInterpretationAIOutput,
  IntegrityResult,
};
export {
  Phase4DInterpretationAIOutputSchema,
  Phase4DInterpretationSchema,
} from "./InterpretationSchema";
export type {
  Phase4DInterpretationRecord,
} from "./InterpretationSchema";

// Zod エイリアス (TS 的に問題ないよう明示)
const Phase4DSchema = _schema;

// ------------------------------------------------------------------
// Confidence 計算 (決定論的)
//
// フェーズ数 → ベース値
//   4 phases: 77 (65-90 の中央付近)
//   3 phases: 62 (50-75 の中央付近)
//   2 phases: 42 (30-55 の中央付近)
//   1 phase:  20 (10-30 の中央付近)
//   0 phases:  5  (実質意味なし)
//
// ペナルティ:
//   sampleSizeWarning = true  → -15
//   WF validWindowCount < 2  → -10
//   Optimization INSUFFICIENT → -10
//   WF INCONCLUSIVE           → -10
// ------------------------------------------------------------------

export function calcDeterministicConfidence(ctx: InterpretationContext): number {
  const n = ctx.availablePhases.length;

  let base: number;
  if      (n >= 4) base = 77;
  else if (n === 3) base = 62;
  else if (n === 2) base = 42;
  else if (n === 1) base = 20;
  else             return 5;

  let penalty = 0;

  if (ctx.backtestAnalysis?.sampleSizeWarning) penalty += 15;
  if (ctx.walkForward !== undefined && ctx.walkForward.validWindowCount < 2) penalty += 10;
  if (ctx.optimization?.rank1SampleStatus === "INSUFFICIENT") penalty += 10;
  if (ctx.walkForward?.verdict === "INCONCLUSIVE") penalty += 10;

  return Math.max(5, Math.min(90, base - penalty));
}

// ------------------------------------------------------------------
// Prompt Construction
// ------------------------------------------------------------------

function formatPF(pf: number | null): string {
  return pf === null ? "∞ (no losing trades with profit)" : pf.toFixed(4);
}

function formatProb(p: number): string {
  return `${(p * 100).toFixed(1)}% (decimal: ${p.toFixed(6)})`;
}

export function buildInterpretationPrompt(ctx: InterpretationContext): {
  systemPrompt: string;
  userPrompt:   string;
} {
  // ── System Prompt ──────────────────────────────────────────────

  const systemPrompt = `You are AVL FX Phase 4-D Interpretation Engine.

## YOUR ROLE
Synthesize outputs from a multi-phase trading strategy validation pipeline and produce
a fact-based, cross-phase interpretation. You describe what the validation results show.
You do NOT predict future performance.

## STRICTLY PROHIBITED

### Predictions (ALL FORMS FORBIDDEN)
Never output any of these constructions:
  "will be profitable", "is likely to succeed", "should perform well",
  "is expected to", "will generalize", "is robust", "is safe to trade",
  "would make money", "you should use", "is likely to make",
  "shows strong potential", "has demonstrated that"

### Parameter recommendations (ALL FORMS FORBIDDEN)
Never suggest parameter changes:
  "increase RSI", "use RR 2.0", "change EMA period",
  "optimize toward", "recommended parameters", "suggested settings",
  "adjust the stop loss", "modify the entry condition"

### Unsupported numbers (FORBIDDEN)
Every numeric value you cite MUST appear verbatim in the VALIDATION CONTEXT section below.
Do NOT calculate new statistics. Do NOT estimate missing values.
Do NOT round differently without acknowledging the approximation.
Probabilities may be expressed as decimals (0.123) OR percentages (12.3%) — both forms are acceptable.
Percentile rank may be expressed as P58, 58th percentile, or similar.

## FACT vs OBSERVATION
FACT: A number or categorical result directly stated in the validation context.
OBSERVATION: An inference strictly derived from one or more stated facts.
Never state as a fact something not present in the context.

## LIMITATIONS (MANDATORY — minimum 2 required)
Your "limitations" array MUST include at least 2 of these:
  - "Future live-trading profitability cannot be concluded from these validation results."
  - "Market conditions and regimes outside the tested historical period cannot be evaluated."
  - "Monte Carlo Trade Order Shuffle assumes trade-to-trade independence and does not capture serial correlation, regime shifts, or volatility clustering."
  - "Walk Forward OOS results reflect historical generalization only and do not guarantee future generalization."

You may rephrase them but CANNOT remove or reduce below 2 items.

## CROSS-PHASE SYNTHESIS RULES
CONVERGENCE: Multiple independent phases show compatible signals. Must cite specific numbers from at least 2 phases.
DIVERGENCE: Phases show materially different signals. Must cite the conflicting values from each phase.
UNCERTAINTY: Insufficient data prevents a reliable cross-phase observation.
Do NOT declare CONVERGENCE merely because two numbers are both positive or both negative.
The relationship must be explicitly supported by the supplied statistics.

## OUTPUT FORMAT (strict JSON — no markdown, no explanation)

{
  "overall_assessment": "2-4 sentences describing what the multi-phase validation results show. No predictions. Max 800 characters.",
  "phase_observations": [
    {
      "phase": "BACKTEST_ANALYSIS" | "OPTIMIZATION" | "WALK_FORWARD" | "MONTE_CARLO",
      "observation": "One factual statement about this phase result. No predictions.",
      "supporting_data": "The specific metric(s) and numeric values that support this observation."
    }
  ],
  "cross_phase_synthesis": [
    {
      "type": "CONVERGENCE" | "DIVERGENCE" | "UNCERTAINTY",
      "observation": "Cross-phase pattern with specific values from multiple phases cited.",
      "phases_involved": ["PHASE_A", "PHASE_B"]
    }
  ],
  "risk_dimensions": [
    {
      "dimension": "SEQUENCE_RISK" | "OOS_GENERALIZATION" | "DRAWDOWN_RISK" | "SAMPLE_QUALITY" | "PARAMETER_STABILITY",
      "assessment": "Factual description from available data. No predictions.",
      "data_source": "Which phase and metric provides this information."
    }
  ],
  "limitations": [
    "Required limitation statement 1 (minimum 2 total)"
  ],
  "data_completeness_note": "Which phases were available, which were not, and what that means for interpretation completeness. Max 400 characters."
}

## CONSTRAINTS
- overall_assessment: 1–800 characters
- phase_observations: 1–12 items; cover only AVAILABLE phases
- cross_phase_synthesis: 0–6 items
- risk_dimensions: 1–5 items
- limitations: minimum 2, maximum 8 items
- Respond with ONLY the JSON object. No markdown fences, no preamble.`;

  // ── User Prompt ────────────────────────────────────────────────

  const avail = ctx.availablePhases;
  const unavail: string[] = (
    ["BACKTEST_ANALYSIS", "OPTIMIZATION", "WALK_FORWARD", "MONTE_CARLO"] as const
  ).filter(p => !avail.includes(p));

  const lines: string[] = [
    `Interpret the validation results for the following trading strategy.`,
    ``,
    `## STRATEGY`,
    `  Name:      ${ctx.strategy.name}`,
    `  Type:      ${ctx.strategy.type}`,
    `  Symbol:    ${ctx.strategy.symbol}`,
    `  Timeframe: ${ctx.strategy.timeframe}`,
    `  Version:   ${ctx.strategy.versionNum !== null ? `v${ctx.strategy.versionNum}` : "unknown"}`,
    ``,
    `## AVAILABLE PHASES`,
    `  ${avail.join(", ") || "(none)"}`,
    ``,
    `## UNAVAILABLE PHASES (not tested — DO NOT reference or infer data for these)`,
    `  ${unavail.join(", ") || "(all phases available)"}`,
  ];

  // Phase 3-A
  if (ctx.backtestAnalysis) {
    const b = ctx.backtestAnalysis;
    lines.push(``,
      `## PHASE 3-A: BACKTEST ANALYSIS`,
      `  Verdict:           ${b.verdict} — ${b.verdictReason}`,
      `  Total Trades:      ${b.totalTrades}`,
      `  Total Pips:        ${b.totalPips >= 0 ? "+" : ""}${b.totalPips}`,
      `  Win Rate:          ${b.winRate.toFixed(1)}%`,
      `  Max Drawdown:      ${b.maxDrawdownPct.toFixed(1)}%`,
      `  Profit Factor:     ${formatPF(b.profitFactor)}`,
      `  Data Coverage:     ${b.dataCoverageDays} days`,
      `  Sample Warning:    ${b.sampleSizeWarning ? "YES — fewer than 30 trades" : "No"}`,
      `  Analysis Confidence: ${b.confidence}/100`,
      `  Data Quality Note: ${b.dataQualityNote}`,
    );
    if (b.topFacts.length > 0) {
      lines.push(`  Top Facts:`);
      b.topFacts.forEach((f, i) => {
        const val = f.value !== null && f.value !== undefined ? ` [value=${f.value}]` : "";
        lines.push(`    ${i + 1}. ${f.statement}${val}`);
      });
    }
    if (b.topWeaknesses.length > 0) {
      lines.push(`  Top Weaknesses:`);
      b.topWeaknesses.forEach((w, i) => {
        lines.push(`    ${i + 1}. ${w.point}`);
      });
    }
  } else {
    lines.push(``,
      `## PHASE 3-A: BACKTEST ANALYSIS`,
      `  Status: NOT AVAILABLE`
    );
  }

  // Phase 4-A
  if (ctx.optimization) {
    const o = ctx.optimization;
    lines.push(``,
      `## PHASE 4-A: PARAMETER OPTIMIZATION`,
      `  Total Combinations Tested: ${o.totalCombinations}`,
      `  Rank-1 Total Pips:         ${o.rank1TotalPips >= 0 ? "+" : ""}${o.rank1TotalPips}`,
      `  Rank-1 Profit Factor:      ${formatPF(o.rank1ProfitFactor)}`,
      `  Rank-1 Degradation Ratio:  ${o.rank1DegradationRatio !== null ? o.rank1DegradationRatio.toFixed(4) : "N/A (IS pips = 0)"}`,
      `  Rank-1 Sample Status:      ${o.rank1SampleStatus}`,
      `  Stable Zone Count:         ${o.stableZoneCount}`,
      `  Robust Count:              ${o.robustCount}`,
    );
  } else {
    lines.push(``,
      `## PHASE 4-A: PARAMETER OPTIMIZATION`,
      `  Status: NOT AVAILABLE`
    );
  }

  // Phase 4-B
  if (ctx.walkForward) {
    const w = ctx.walkForward;
    lines.push(``,
      `## PHASE 4-B: WALK FORWARD VALIDATION`,
      `  Verdict:                 ${w.verdict}`,
      `  Consistency Score:       ${w.consistencyScore !== null ? w.consistencyScore.toFixed(3) : "null (INCONCLUSIVE)"}`,
      `  Parameter Stability Avg: ${w.parameterStabilityAvg.toFixed(3)}`,
      `  Total Windows:           ${w.totalWindowCount}`,
      `  Valid Windows:           ${w.validWindowCount}`,
      `  Positive Windows:        ${w.positiveWindowCount}`,
      `  Skipped Windows:         ${w.skippedWindowCount}`,
    );
  } else {
    lines.push(``,
      `## PHASE 4-B: WALK FORWARD VALIDATION`,
      `  Status: NOT AVAILABLE`
    );
  }

  // Phase 4-C
  if (ctx.monteCarlo) {
    const m = ctx.monteCarlo;
    lines.push(``,
      `## PHASE 4-C: MONTE CARLO SIMULATION`,
      `  Method:                      ${m.method}`,
      `  Simulations:                 ${m.iterations.toLocaleString()}`,
      `  Trade Count:                 ${m.tradeCount}`,
      `  DD Threshold:                ${m.drawdownThresholdPct}%`,
      `  Original Final Pips:         ${m.originalFinalPips >= 0 ? "+" : ""}${m.originalFinalPips}`,
      `  Original Max DD:             ${m.originalMaxDdPct.toFixed(1)}%`,
      `  Original Sequence Percentile: ${m.originalPercentileRank.toFixed(1)} (P${Math.round(m.originalPercentileRank)})`,
      `  P(Final Pips < 0):           ${formatProb(m.probabilityOfLoss)}`,
      `  P(DD >= ${m.drawdownThresholdPct}%):            ${formatProb(m.probabilityOfDrawdownThreshold)}`,
      `  Final Pips Distribution:`,
      `    P5  = ${m.pipsP5 >= 0 ? "+" : ""}${m.pipsP5}`,
      `    P25 = ${m.pipsP25 >= 0 ? "+" : ""}${m.pipsP25}`,
      `    P50 = ${m.pipsP50 >= 0 ? "+" : ""}${m.pipsP50}  ← MEDIAN`,
      `    P75 = ${m.pipsP75 >= 0 ? "+" : ""}${m.pipsP75}`,
      `    P95 = ${m.pipsP95 >= 0 ? "+" : ""}${m.pipsP95}`,
      `  Max Drawdown Distribution:`,
      `    P50 = ${m.ddP50.toFixed(1)}%`,
      `    P95 = ${m.ddP95.toFixed(1)}%`,
    );
  } else {
    lines.push(``,
      `## PHASE 4-C: MONTE CARLO SIMULATION`,
      `  Status: NOT AVAILABLE`
    );
  }

  lines.push(``, `Now produce the JSON interpretation following the system instructions exactly.`);

  return { systemPrompt, userPrompt: lines.join("\n") };
}

// ------------------------------------------------------------------
// Correction Prompt (for retry after integrity violation)
// ------------------------------------------------------------------

export function buildCorrectionPrompt(violations: string[]): string {
  const violationList = violations.map((v, i) => `  ${i + 1}. ${v}`).join("\n");
  return (
    `Your previous response contained numerical claims that could not be verified against the supplied context.\n\n` +
    `Detected violations:\n${violationList}\n\n` +
    `Rewrite the response using ONLY numbers explicitly supported by the context. ` +
    `Each numeric value in phase_observations.supporting_data and cross_phase_synthesis.observation ` +
    `must appear verbatim in the VALIDATION CONTEXT. ` +
    `If you cannot cite an accurate number for a claim, omit the claim entirely.`
  );
}

// ------------------------------------------------------------------
// Parse AI Response
// ------------------------------------------------------------------

export type ParseResult =
  | { ok: true;  output: Phase4DInterpretationAIOutput }
  | { ok: false; error: string; raw?: unknown };

export function parseInterpretationResponse(jsonText: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "AI output is not valid JSON", raw: jsonText };
  }

  const result = Phase4DSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Schema validation failed: ${issues}`, raw };
  }

  return { ok: true, output: result.data };
}

// ------------------------------------------------------------------
// Numeric Integrity Validation
//
// AI が述べた数値が InterpretationContext の値と一致するか検証する。
//
// 検証対象メトリクス:
//   - Monte Carlo: pipsP50, probabilityOfLoss, probabilityOfDrawdownThreshold, originalPercentileRank
//   - Walk Forward: consistencyScore
//   - Backtest: totalPips, maxDrawdownPct
//
// 正規化ルール:
//   - probability: 0.123 と 12.3% は等価
//   - percentile: P58, 58th percentile, 58 はすべて整数58と照合
//   - pips: +215 と 215 は等価
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Internal: keyword-anchored metric claim check
//
// 数値の整合性検証は「そのメトリクス名と共に引用された数値」のみを検査する。
// メトリクス名なしで出現する数値は別のメトリクスを指している可能性があるため検査しない。
//
// これにより false positive を大幅に削減する:
//   - "P50=215" → pipsP50 の引用として検査 ✓
//   - "215 days" → pipsP50 の引用ではないため検査しない ✓
//   - "consistency_score=0.60" → WF score の引用として検査 ✓
// ------------------------------------------------------------------

function checkMetricClaim(
  text:                string,
  metricName:          string,
  patterns:            RegExp[],
  expectedValue:       number,
  tolerance:           number,
  /** true = expectedValue × 100 (%) 形式も許容 */
  allowPercentageForm: boolean,
  violations:          string[],
): void {
  for (const pat of patterns) {
    const gPat = new RegExp(pat.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = gPat.exec(text)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      const n = parseFloat(raw.replace(/,/g, ""));
      if (isNaN(n)) continue;

      const matchExact = Math.abs(n - expectedValue) <= tolerance;
      const matchPct   = allowPercentageForm &&
                         Math.abs(n - expectedValue * 100) <= tolerance * 100;
      if (!matchExact && !matchPct) {
        const pctHint = allowPercentageForm ? ` (${(expectedValue * 100).toFixed(1)}%)` : "";
        violations.push(
          `${metricName}: context=${expectedValue}${pctHint}, ` +
          `but AI claims ${n}.`
        );
        return; // 同一メトリクスで最初の違反のみ記録
      }
    }
  }
}

export function validateInterpretationIntegrity(
  output: Phase4DInterpretationAIOutput,
  ctx:    InterpretationContext,
): IntegrityResult {
  const violations: string[] = [];

  // 全テキストを結合 (観察文・合成文・リスク評価・総括)
  const combined = [
    output.overall_assessment,
    ...output.phase_observations.map(p => `${p.observation} ${p.supporting_data}`),
    ...output.cross_phase_synthesis.map(s => s.observation),
    ...output.risk_dimensions.map(r => `${r.assessment} ${r.data_source}`),
  ].join(" | ");

  // ── Monte Carlo ─────────────────────────────────────────────────
  if (ctx.monteCarlo) {
    const mc = ctx.monteCarlo;

    // pipsP50: "P50 = +215" / "pipsP50=215.3" / "median simulation was +215"
    checkMetricClaim(combined, "MC pipsP50", [
      /(?:P50|p50|median|50th\s+percentile)\s+(?:final\s+)?pips?\s*(?:was|=|:|\()?\s*([+-]?[\d,]+\.?\d*)/i,
      /pipsP50\s*[=:]\s*([+-]?[\d,]+\.?\d*)/i,
      /median\s+simulation\s+was\s+([+-]?[\d,]+\.?\d*)\s*pips?/i,
      /pips?\s+(?:at\s+)?(?:P50|median|50th)\s*(?:=|:|\()?\s*([+-]?[\d,]+\.?\d*)/i,
    ], mc.pipsP50, 0.5, false, violations);

    // probabilityOfLoss: "P(loss)=12.3%" / "P(Final Pips < 0) = 0.123"
    checkMetricClaim(combined, "MC probabilityOfLoss", [
      /[Pp]\((?:final\s+pips?\s*<\s*0|loss)\)\s*[=:]\s*([\d.]+)%?/i,
      /probability\s+of\s+loss\s*[=:]\s*([\d.]+)%?/i,
      /probabilityOfLoss\s*[=:]\s*([\d.]+)%?/i,
    ], mc.probabilityOfLoss, 0.005, true, violations);

    // probabilityOfDrawdownThreshold: "P(DD >= 20%) = 8.1%"
    checkMetricClaim(combined, "MC probabilityOfDrawdownThreshold", [
      /[Pp]\(DD?\s*[≥≧>=]+\s*[\d.]+%?\)\s*[=:]\s*([\d.]+)%?/i,
      /probability\s+of\s+(?:drawdown|dd)\s+threshold\s*[=:]\s*([\d.]+)%?/i,
      /probabilityOfDrawdownThreshold\s*[=:]\s*([\d.]+)%?/i,
    ], mc.probabilityOfDrawdownThreshold, 0.005, true, violations);

    // originalPercentileRank: "P53" / "53rd percentile" / "Original Sequence: P53"
    const rank = Math.round(mc.originalPercentileRank);
    checkMetricClaim(combined, "MC originalPercentileRank", [
      /[Oo]riginal\s+[Ss]equence\s*:\s*[Pp](\d+)/i,
      /[Oo]riginal\s+(?:falls?\s+)?(?:at\s+|is\s+at\s+)?[Pp](\d+)/i,
      /[Oo]riginal\s+(?:is\s+)?(?:at\s+)?(?:approximately\s+)?[Pp]?(\d+)(?:th|st|nd|rd)?\s+percentile/i,
      /originalPercentileRank\s*[=:]\s*(\d+)/i,
    ], rank, 1, false, violations);
  }

  // ── Walk Forward ─────────────────────────────────────────────────
  if (ctx.walkForward !== undefined && ctx.walkForward.consistencyScore !== null) {
    const cs = ctx.walkForward.consistencyScore;
    checkMetricClaim(combined, "WF consistencyScore", [
      /[Cc]onsistency\s*[Ss]core\s*[=:]\s*([\d.]+)/i,
      /[Cc]onsistencyScore\s*[=:]\s*([\d.]+)/i,
      /[Ss]core\s+of\s+([\d.]+)\s+(?:\(|for\s+CONDITIONAL)/i,
    ], cs, 0.005, false, violations);
  }

  // ── Backtest ─────────────────────────────────────────────────────
  if (ctx.backtestAnalysis) {
    checkMetricClaim(combined, "Backtest totalPips", [
      /total\s+pips?\s*[=:]\s*([+-]?[\d,]+\.?\d*)/i,
      /total_pips\s*[=:]\s*([+-]?[\d,]+\.?\d*)/i,
    ], ctx.backtestAnalysis.totalPips, 0.5, false, violations);
  }

  return { valid: violations.length === 0, violations };
}

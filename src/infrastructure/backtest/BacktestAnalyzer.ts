// =================================================================
// BacktestAnalyzer.ts — Backtest AI Analysis (Phase 3-A)
//
// Pure functions のみ。OpenAI 呼び出しは API Route 側で行う。
//
// Exports:
//   TradeForAnalysis       — 分析用トレード型
//   buildAnalysisContext   — BacktestReport + trades + spec → AnalysisContext
//   buildAnalysisPrompt    — AnalysisContext → { systemPrompt, userPrompt }
//   parseAnalysisResponse  — AI JSON text → StrategyAnalysis | error
//   validateFactIntegrity  — Facts の数値が input_snapshot と矛盾しないか検証
// =================================================================

import type { BacktestReport } from "./BacktestReporter";
import type { StrategySpec }   from "@/lib/strategySchema";
import {
  StrategyAnalysisSchema,
  type StrategyAnalysis,
  type AnalysisContext,
  type TradeStat,
  type RepresentativeTrade,
  type FactItem,
} from "./analysisSchema";

// ------------------------------------------------------------------
// Input trade type (DB rows or BacktestTrade[] から変換して渡す)
// ------------------------------------------------------------------

export interface TradeForAnalysis {
  pips:        number;
  result:      "WIN" | "LOSS" | "BREAKEVEN" | "END_OF_DATA";
  exitReason:  "TP" | "SL" | "END_OF_DATA";
  direction:   "BUY" | "SELL";
  durationMin: number;
  session:     string;
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10)  / 10; }

function tradeStat(trades: TradeForAnalysis[]): TradeStat {
  if (trades.length === 0) {
    return { count: 0, avgPips: 0, totalPips: 0, avgDurationMin: 0 };
  }
  const totalPips = trades.reduce((s, t) => s + t.pips, 0);
  const totalDur  = trades.reduce((s, t) => s + t.durationMin, 0);
  return {
    count:          trades.length,
    avgPips:        round2(totalPips / trades.length),
    totalPips:      round2(totalPips),
    avgDurationMin: round1(totalDur / trades.length),
  };
}

function pickRepresentativeTrades(trades: TradeForAnalysis[]): RepresentativeTrade[] {
  if (trades.length === 0) return [];

  const wins   = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");
  const sorted = [...trades].sort((a, b) => a.pips - b.pips);

  // オブジェクト参照で重複排除（index 混在バグを防ぐ）
  const used   = new Set<TradeForAnalysis>();
  const result: RepresentativeTrade[] = [];

  const add = (label: string, t: TradeForAnalysis) => {
    if (used.has(t)) return;
    used.add(t);
    result.push({
      label,
      direction:   t.direction,
      pips:        round2(t.pips),
      durationMin: round1(t.durationMin),
      exitReason:  t.exitReason,
      session:     t.session,
    });
  };

  // Max Win
  const maxWin = sorted[sorted.length - 1];
  if (maxWin && maxWin.pips > 0)   add("Max Win",  maxWin);

  // Max Loss
  const maxLoss = sorted[0];
  if (maxLoss && maxLoss.pips < 0) add("Max Loss", maxLoss);

  // Avg Win (closest to mean)
  if (wins.length > 0) {
    const avgWinPips = wins.reduce((s, t) => s + t.pips, 0) / wins.length;
    let best: TradeForAnalysis = wins[0]!, bestDiff = Infinity;
    for (const t of wins) {
      const diff = Math.abs(t.pips - avgWinPips);
      if (diff < bestDiff) { bestDiff = diff; best = t; }
    }
    add("Typical Win", best);
  }

  // Avg Loss (closest to mean)
  if (losses.length > 0) {
    const avgLossPips = losses.reduce((s, t) => s + t.pips, 0) / losses.length;
    let best: TradeForAnalysis = losses[0]!, bestDiff = Infinity;
    for (const t of losses) {
      const diff = Math.abs(t.pips - avgLossPips);
      if (diff < bestDiff) { bestDiff = diff; best = t; }
    }
    add("Typical Loss", best);
  }

  // Shortest & Longest (> 0 duration)
  const withDur = trades.filter(t => t.durationMin > 0);
  if (withDur.length > 0) {
    const shortest = withDur.reduce((a, b) => b.durationMin < a.durationMin ? b : a);
    const longest  = withDur.reduce((a, b) => b.durationMin > a.durationMin ? b : a);
    add("Shortest Trade", shortest);
    add("Longest Trade",  longest);
  }

  return result;
}

// ------------------------------------------------------------------
// buildAnalysisContext
// ------------------------------------------------------------------

export function buildAnalysisContext(
  report: BacktestReport,
  trades: TradeForAnalysis[],
  spec:   StrategySpec,
): AnalysisContext {
  const total = trades.length;

  // Exit reason rates
  const tpCount   = trades.filter(t => t.exitReason === "TP").length;
  const slCount   = trades.filter(t => t.exitReason === "SL").length;
  const eodCount  = trades.filter(t => t.exitReason === "END_OF_DATA").length;
  const tpHitRate  = total > 0 ? round2(tpCount  / total * 100) : 0;
  const slHitRate  = total > 0 ? round2(slCount  / total * 100) : 0;
  const endOfDataRate = total > 0 ? round2(eodCount / total * 100) : 0;

  // Direction stats
  const buyTrades  = trades.filter(t => t.direction === "BUY");
  const sellTrades = trades.filter(t => t.direction === "SELL");

  // Winning / losing stats
  const winTrades  = trades.filter(t => t.result === "WIN");
  const lossTrades = trades.filter(t => t.result === "LOSS");

  // Session stats from report (wins/losses included for semantic validation)
  const sessionStats: AnalysisContext["sessionStats"] = {};
  for (const [sess, s] of Object.entries(report.sessionStats)) {
    sessionStats[sess] = {
      tradeCount:   s.tradeCount,
      wins:         s.wins,
      losses:       s.losses,
      winRate:      s.winRate,
      totalPips:    s.totalPips,
      profitFactor: s.profitFactor,
    };
  }

  return {
    // Strategy
    strategyName:   spec.name,
    strategyType:   spec.strategy_type,
    symbols:        spec.symbols,
    timeframes:     spec.timeframes,
    entryLogic:     spec.entry_conditions.logic,
    conditionCount: spec.entry_conditions.conditions.length,

    // Overall stats (from report)
    totalTrades:   report.totalTrades,
    wins:          report.wins,
    losses:        report.losses,
    breakevens:    report.breakevens,
    winRate:       report.winRate,
    totalPips:     report.totalPips,
    avgPips:       report.avgPips,
    profitFactor:  report.profitFactor,

    // DD
    maxDrawdown:     report.maxDrawdown,
    maxDrawdownPct:  report.maxDrawdownPct,
    maxDrawdownPips: report.maxDrawdownPips,

    // Streaks
    maxConsWins:   report.maxConsecutiveWins,
    maxConsLosses: report.maxConsecutiveLosses,

    // Duration
    avgDurationMin: report.avgDurationMin,

    // Exit reason rates
    tpHitRate,
    slHitRate,
    endOfDataRate,

    // Direction stats
    buyStats:  tradeStat(buyTrades),
    sellStats: tradeStat(sellTrades),

    // Session stats
    sessionStats,
    bestSession:  report.bestSession,
    worstSession: report.worstSession,

    // Win/loss patterns
    winningStats: tradeStat(winTrades),
    losingStats:  tradeStat(lossTrades),

    // Representative trades
    representativeTrades: pickRepresentativeTrades(trades),

    // Data quality
    dataCoverageDays:  report.dataCoverageDays,
    barCount:          report.barCount,
    sampleSizeWarning: report.sampleSizeWarning,
    verdict:           report.verdict,
    verdictReason:     report.verdictReason,
  };
}

// ------------------------------------------------------------------
// buildAnalysisPrompt
// ------------------------------------------------------------------

function formatPF(pf: number | null): string {
  return pf === null ? "∞ (all wins)" : pf.toFixed(2);
}

function formatStat(s: TradeStat): string {
  if (s.count === 0) return "0 trades";
  return `${s.count} trades, avg=${s.avgPips >= 0 ? "+" : ""}${s.avgPips}p, total=${s.totalPips >= 0 ? "+" : ""}${s.totalPips}p, avg_dur=${s.avgDurationMin}min`;
}

export function buildAnalysisPrompt(ctx: AnalysisContext): {
  systemPrompt: string;
  userPrompt:   string;
} {
  const systemPrompt = `You are AVL FX Backtest Analyst. Analyze the provided backtest statistics for a trading strategy and output a structured JSON analysis.

## CRITICAL RULES

### FACT / OBSERVATION / HYPOTHESIS separation — STRICTLY ENFORCED

FACT:
  - ONLY statements that are directly derivable from the provided backtest data.
  - MUST reference a specific number from the provided statistics.
  - source field: use one of "backtest_stats", "session_stats", "direction_stats", "exit_stats", "streak_stats"
  - value field: use the exact numeric value from the provided data.
  - DO NOT state anything not present in the input data.

OBSERVATION:
  - A pattern or insight inferred from one or more FACTs.
  - basis field: list the fact statements that support this observation.
  - DO NOT use it to state raw numbers (those belong in FACT).

HYPOTHESIS:
  - A POSSIBLE CAUSE or explanation for an observation.
  - You MUST use language like "This may be due to...", "A possible explanation is...", "One hypothesis is..."
  - NEVER state a hypothesis as confirmed fact.
  - confidence: "LOW" unless strongly supported by multiple facts.

### NUMBER RULES
  - DO NOT invent numbers not present in the provided statistics.
  - If you reference a percentage or count, it MUST match the provided data exactly.
  - Use the exact values from "BACKTEST STATISTICS" section below.

### HYPOTHESIS LABELING
  - Each hypothesis.hypothesis string MUST start with: "Hypothesis:" or "Possible cause:"
  - Never write "The strategy fails because..." — write "Hypothesis: The strategy may fail because..."

## OUTPUT FORMAT (strict JSON only)

{
  "summary": "string (1-3 sentences, overall assessment)",
  "facts": [
    {"statement": "string", "source": "string", "value": number|string|null}
  ],
  "observations": [
    {"observation": "string", "basis": "string (which facts)", "confidence": "HIGH"|"MEDIUM"|"LOW"}
  ],
  "hypotheses": [
    {"hypothesis": "string (MUST start with Hypothesis: or Possible cause:)", "rationale": "string", "confidence": "HIGH"|"MEDIUM"|"LOW"}
  ],
  "weaknesses": [
    {"point": "string", "detail": "string|null"}
  ],
  "strengths": [
    {"point": "string", "detail": "string|null"}
  ],
  "session_analysis": [
    {"session": "string", "observation": "string", "recommendation": "string|null"}
  ],
  "risk_analysis": {
    "drawdown_assessment": "string",
    "sl_tp_assessment": "string",
    "consistency_assessment": "string",
    "overall": "string"
  },
  "recommendations": [
    {"action": "string", "rationale": "string|null", "priority": "HIGH"|"MEDIUM"|"LOW"}
  ],
  "confidence": number (0-100, your confidence in this analysis given data quality),
  "data_quality_note": "string (note about sample size, data coverage, limitations)"
}

## CONSTRAINTS
  - facts: 3-15 items. Each must have a specific numeric value.
  - observations: 3-10 items.
  - hypotheses: 0-6 items. Can be empty array if no hypotheses warranted.
  - weaknesses: 1-6 items.
  - strengths: 0-5 items. Can be empty if no strengths.
  - recommendations: 3-8 items.
  - confidence: Use lower values (30-50) for < 30 trade samples. Use 60-80 for 30-100 trades. Use 80-95 for 100+ trades.
  - Respond with ONLY the JSON object. No markdown, no explanation.`;

  // ----------------------------------------------------------------
  // User prompt: formatted statistics
  // ----------------------------------------------------------------

  const conds = (ctx.conditionCount === 1)
    ? `${ctx.conditionCount} condition (${ctx.entryLogic})`
    : `${ctx.conditionCount} conditions (${ctx.entryLogic})`;

  const sessionLines = Object.entries(ctx.sessionStats)
    .map(([s, st]) =>
      `    ${s}: ${st.tradeCount} trades, WR=${st.winRate}%, pips=${st.totalPips >= 0 ? "+" : ""}${st.totalPips}, PF=${formatPF(st.profitFactor)}`
    ).join("\n");

  const repTradeLines = ctx.representativeTrades
    .map(t =>
      `    [${t.label}] ${t.direction} ${t.pips >= 0 ? "+" : ""}${t.pips}p, dur=${t.durationMin}min, exit=${t.exitReason}, session=${t.session}`
    ).join("\n");

  const userPrompt = `Analyze the following backtest results for a trading strategy.

## STRATEGY
  Name:         ${ctx.strategyName}
  Type:         ${ctx.strategyType}
  Symbols:      ${ctx.symbols.join(", ")}
  Timeframes:   ${ctx.timeframes.join(", ")}
  Entry logic:  ${conds}

## BACKTEST STATISTICS
  Verdict:             ${ctx.verdict} — ${ctx.verdictReason}
  Total Trades:        ${ctx.totalTrades}
  Wins:                ${ctx.wins}
  Losses:              ${ctx.losses}
  Breakevens:          ${ctx.breakevens}
  Win Rate:            ${ctx.winRate.toFixed(1)}%
  Total Pips:          ${ctx.totalPips >= 0 ? "+" : ""}${ctx.totalPips}
  Average Pips/Trade:  ${ctx.avgPips >= 0 ? "+" : ""}${ctx.avgPips}
  Profit Factor:       ${formatPF(ctx.profitFactor)}
  Max Drawdown:        ${ctx.maxDrawdownPct}% ($${ctx.maxDrawdown}, ${ctx.maxDrawdownPips}p)
  Max Cons. Wins:      ${ctx.maxConsWins}
  Max Cons. Losses:    ${ctx.maxConsLosses}
  Avg Trade Duration:  ${ctx.avgDurationMin} min
  Data Coverage:       ${ctx.dataCoverageDays} days, ${ctx.barCount} bars
  Sample Warning:      ${ctx.sampleSizeWarning ? "YES — less than 30 trades" : "No"}

## EXIT REASON BREAKDOWN
  TP Hit Rate:         ${ctx.tpHitRate}%
  SL Hit Rate:         ${ctx.slHitRate}%
  End-of-Data Rate:    ${ctx.endOfDataRate}%

## DIRECTION STATISTICS
  BUY  trades: ${formatStat(ctx.buyStats)}
  SELL trades: ${formatStat(ctx.sellStats)}

## TRADE QUALITY
  Winning trades: ${formatStat(ctx.winningStats)}
  Losing trades:  ${formatStat(ctx.losingStats)}

## SESSION STATISTICS
${sessionLines || "  (no session data)"}
  Best session:   ${ctx.bestSession ?? "N/A"}
  Worst session:  ${ctx.worstSession ?? "N/A"}

## REPRESENTATIVE TRADES
${repTradeLines || "  (no trades)"}

Now produce the JSON analysis following the system instructions exactly.`;

  return { systemPrompt, userPrompt };
}

// ------------------------------------------------------------------
// parseAnalysisResponse
// ------------------------------------------------------------------

export type ParseResult =
  | { ok: true;  analysis: StrategyAnalysis }
  | { ok: false; error: string; raw?: unknown };

export function parseAnalysisResponse(jsonText: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "AI output is not valid JSON", raw: jsonText };
  }

  const result = StrategyAnalysisSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Schema validation failed: ${issues}`, raw };
  }

  return { ok: true, analysis: result.data };
}

// ------------------------------------------------------------------
// validateFactIntegrity
//
// Semantic/scope-aware validation:
//   1. source フィールドからスコープ（overall/session/direction）を推定
//   2. statement テキストからメトリック名を識別
//   3. メトリック×スコープ×エンティティで期待値を引いて比較
//
// 「数字がデータに存在する」だけでは合格させない。
// 「どのメトリックとして主張しているか」を判定し、
// その期待値と照合する。
//
// 識別できないメトリックは skip（cleanFacts に含める）。
// 識別できたメトリックが期待値と合わない場合は violation。
// ------------------------------------------------------------------

interface FactIntegrityResult {
  valid:      boolean;
  violations: string[];
  cleanFacts: FactItem[];
}

// ── セッション名抽出 ────────────────────────────────────────────────

const KNOWN_SESSIONS = ["LONDON", "NEW_YORK", "OVERLAP", "OFF", "TOKYO", "SYDNEY"] as const;

function extractSessionName(stmt: string): string | null {
  const upper = stmt.toUpperCase();
  // "NEW YORK" も "NEW_YORK" として扱う
  if (upper.includes("NEW YORK") || upper.includes("NEW_YORK")) return "NEW_YORK";
  for (const name of KNOWN_SESSIONS) {
    if (name !== "NEW_YORK" && upper.includes(name)) return name;
  }
  return null;
}

// ── メトリック候補 ──────────────────────────────────────────────────

type Scope   = "overall" | "session" | "direction";
type MetricMatch = { metric: string; scope: Scope; entity: string | null };

function findMetricMatches(stmt: string, source: string): MetricMatch[] {
  const sessionEntity = extractSessionName(stmt);
  const results: MetricMatch[] = [];

  // ── 1. CONSECUTIVE（最優先・最特定）──────────────────────────────
  if (/max(?:imum)?\s+consecutive/i.test(stmt) || /consecutive\s+(?:win|loss)/i.test(stmt)) {
    if (/loss/i.test(stmt)) results.push({ metric: "max_cons_losses", scope: "overall", entity: null });
    if (/win/i.test(stmt))  results.push({ metric: "max_cons_wins",   scope: "overall", entity: null });
    return results;  // consecutive は他と混合しない
  }

  // ── 2. Win rate ───────────────────────────────────────────────────
  if (/win\s*rate|win_rate/i.test(stmt)) {
    const sc = sessionEntity ? "session" : "overall";
    results.push({ metric: "win_rate", scope: sc, entity: sessionEntity });
  }

  // ── 3. Pips（total → avg → generic の順）─────────────────────────
  if (/total\s+pips?/i.test(stmt)) {
    const sc = sessionEntity ? "session" : "overall";
    results.push({ metric: "total_pips", scope: sc, entity: sessionEntity });
  } else if (/avg(?:erage)?\s+pips?\s+per\s+trade|avg(?:erage)?\s+pips?/i.test(stmt)) {
    results.push({ metric: "avg_pips", scope: "overall", entity: null });
  } else if (/pips?/i.test(stmt)) {
    // generic "pips" → スコープに従って total_pips とみなす
    const sc = sessionEntity ? "session" : "overall";
    results.push({ metric: "total_pips", scope: sc, entity: sessionEntity });
  }

  // ── 4. Profit factor ─────────────────────────────────────────────
  if (/profit\s+factor/i.test(stmt)) {
    const sc = sessionEntity ? "session" : "overall";
    results.push({ metric: "profit_factor", scope: sc, entity: sessionEntity });
  }

  // ── 5. Total trades / Trade count ────────────────────────────────
  if (/total\s+(?:number\s+of\s+)?trades?/i.test(stmt)) {
    if (sessionEntity) {
      results.push({ metric: "trade_count", scope: "session", entity: sessionEntity });
    } else {
      results.push({ metric: "total_trades", scope: "overall", entity: null });
    }
  } else if (sessionEntity && /\d+\s+trades?|\btrades?\b/i.test(stmt)) {
    // セッション文脈での "N trades" → trade_count
    results.push({ metric: "trade_count", scope: "session", entity: sessionEntity });
  } else if (!sessionEntity && /\brecorded\s+\d+\s+trades?|\ball\s+\d+\s+trades?\b/i.test(stmt)) {
    results.push({ metric: "total_trades", scope: "overall", entity: null });
  }

  // ── 6. Drawdown ──────────────────────────────────────────────────
  if (/max(?:imum)?\s+drawdown.*?%|drawdown.*?%/i.test(stmt)) {
    results.push({ metric: "max_drawdown_pct", scope: "overall", entity: null });
  }

  // ── 7. Exit rates ────────────────────────────────────────────────
  if (/sl\s+hit\s+rate|stop.?loss\s+(?:hit\s+)?rate/i.test(stmt)) {
    results.push({ metric: "sl_hit_rate", scope: "overall", entity: null });
  }
  if (/tp\s+hit\s+rate|take.?profit\s+(?:hit\s+)?rate/i.test(stmt)) {
    results.push({ metric: "tp_hit_rate", scope: "overall", entity: null });
  }

  // ── 8. Duration（特定 → 汎用の順）───────────────────────────────
  if (/winning\s+trades?\b.*\bduration|duration\b.*\bwinning\s+trades?/i.test(stmt)) {
    results.push({ metric: "winning_avg_duration", scope: "overall", entity: null });
  } else if (/losing\s+trades?\b.*\bduration|duration\b.*\blosing\s+trades?/i.test(stmt)) {
    results.push({ metric: "losing_avg_duration", scope: "overall", entity: null });
  } else if (/avg(?:erage)?\s+(?:trade\s+)?duration|duration.*min/i.test(stmt)) {
    results.push({ metric: "avg_duration", scope: "overall", entity: null });
  }

  // ── 9. Direction stats ───────────────────────────────────────────
  if (/buy\s+trades?/i.test(stmt))  results.push({ metric: "buy_count",  scope: "direction", entity: null });
  if (/sell\s+trades?/i.test(stmt)) results.push({ metric: "sell_count", scope: "direction", entity: null });

  // ── 10. Wins / Losses（consecutive でないもの）───────────────────
  if (/\bwins?\b|\bwon\b/i.test(stmt) && !/consecutive/i.test(stmt)) {
    const sc = sessionEntity ? "session" : "overall";
    results.push({ metric: "wins", scope: sc, entity: sessionEntity });
  }
  if (/\blosses?\b|\blost\b/i.test(stmt) && !/consecutive/i.test(stmt)) {
    const sc = sessionEntity ? "session" : "overall";
    results.push({ metric: "losses", scope: sc, entity: sessionEntity });
  }

  return results;
}

// ── コンテキストからの期待値取得 ────────────────────────────────────

type LookupResult = { expected: number; tolerance: number } | null;

function lookupMetricValue(
  metric: string,
  scope:  Scope,
  entity: string | null,
  ctx:    AnalysisContext,
): LookupResult {
  if (scope === "session" && entity) {
    const sess = ctx.sessionStats[entity];
    if (!sess) return null;
    switch (metric) {
      case "win_rate":      return { expected: sess.winRate,    tolerance: 0.5 };
      case "total_pips":    return { expected: sess.totalPips,  tolerance: 0.5 };
      case "trade_count":   return { expected: sess.tradeCount, tolerance: 0   };
      case "wins":          return sess.wins   !== undefined ? { expected: sess.wins,   tolerance: 0 } : null;
      case "losses":        return sess.losses !== undefined ? { expected: sess.losses, tolerance: 0 } : null;
      case "profit_factor": return sess.profitFactor !== null && sess.profitFactor !== undefined
        ? { expected: sess.profitFactor, tolerance: 0.1 }
        : null;
      default: return null;
    }
  }

  if (scope === "direction") {
    switch (metric) {
      case "buy_count":  return { expected: ctx.buyStats.count,  tolerance: 0 };
      case "sell_count": return { expected: ctx.sellStats.count, tolerance: 0 };
      default: return null;
    }
  }

  // overall
  switch (metric) {
    case "total_trades":          return { expected: ctx.totalTrades,              tolerance: 0 };
    case "wins":                  return { expected: ctx.wins,                     tolerance: 0 };
    case "losses":                return { expected: ctx.losses,                   tolerance: 0 };
    case "win_rate":              return { expected: ctx.winRate,                  tolerance: 0.5 };
    case "total_pips":            return { expected: ctx.totalPips,                tolerance: 0.5 };
    case "avg_pips":              return { expected: ctx.avgPips,                  tolerance: 0.5 };
    case "profit_factor":         return ctx.profitFactor !== null
      ? { expected: ctx.profitFactor, tolerance: 0.1 }
      : null;
    case "max_drawdown_pct":      return { expected: ctx.maxDrawdownPct,           tolerance: 0.5 };
    case "max_cons_wins":         return { expected: ctx.maxConsWins,              tolerance: 0 };
    case "max_cons_losses":       return { expected: ctx.maxConsLosses,            tolerance: 0 };
    case "tp_hit_rate":           return { expected: ctx.tpHitRate,                tolerance: 0.5 };
    case "sl_hit_rate":           return { expected: ctx.slHitRate,                tolerance: 0.5 };
    case "avg_duration":          return { expected: ctx.avgDurationMin,           tolerance: 1   };
    case "winning_avg_duration":  return { expected: ctx.winningStats.avgDurationMin, tolerance: 1 };
    case "losing_avg_duration":   return { expected: ctx.losingStats.avgDurationMin,  tolerance: 1 };
    case "winning_avg_pips":      return { expected: ctx.winningStats.avgPips,     tolerance: 0.5 };
    case "losing_avg_pips":       return { expected: ctx.losingStats.avgPips,      tolerance: 0.5 };
    default: return null;
  }
}

// ── 単一 Fact の検証 ────────────────────────────────────────────────

type SingleFactResult =
  | { status: "pass" }
  | { status: "skip";  reason: string }
  | { status: "fail";  reason: string };

function checkSingleFact(fact: FactItem, context: AnalysisContext): SingleFactResult {
  if (typeof fact.value !== "number") return { status: "pass" };

  const matches = findMetricMatches(fact.statement, fact.source);

  if (matches.length === 0) {
    // メトリックを識別できない → スキップ（安全側＝含める）
    return { status: "skip", reason: `Cannot identify metric: "${fact.statement.slice(0, 60)}"` };
  }

  // いずれかのメトリックの期待値と一致すれば合格
  for (const { metric, scope, entity } of matches) {
    const lookup = lookupMetricValue(metric, scope, entity, context);
    if (!lookup) continue;
    if (Math.abs(fact.value - lookup.expected) <= lookup.tolerance) {
      return { status: "pass" };
    }
  }

  // 識別できたが値が合わない → 違反
  const best  = matches[0]!;
  const bestL = lookupMetricValue(best.metric, best.scope, best.entity, context);
  const where = best.entity ? ` [${best.scope}:${best.entity}]` : ` [${best.scope}]`;
  const reason = bestL
    ? `Fact "${fact.statement.slice(0, 80)}" value=${fact.value} but ${best.metric}=${bestL.expected}${where} (diff=${Math.abs(fact.value - bestL.expected).toFixed(2)})`
    : `Fact "${fact.statement.slice(0, 80)}" value=${fact.value}: metric "${best.metric}" not found in context`;

  return { status: "fail", reason };
}

// ── メイン関数 ──────────────────────────────────────────────────────

export function validateFactIntegrity(
  facts:   FactItem[],
  context: AnalysisContext,
): FactIntegrityResult {
  const violations: string[] = [];
  const cleanFacts: FactItem[] = [];

  for (const fact of facts) {
    const result = checkSingleFact(fact, context);
    if (result.status === "fail") {
      violations.push(result.reason);
    } else {
      // pass または skip → cleanFacts に含める
      cleanFacts.push(fact);
    }
  }

  return { valid: violations.length === 0, violations, cleanFacts };
}

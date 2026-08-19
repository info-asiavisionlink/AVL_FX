// =================================================================
// GET  /api/strategies/[id]/interpret  → 最新 Phase 4-D 解釈結果
// POST /api/strategies/[id]/interpret  → Phase 4-D AI 解釈実行
//
// Phase 4-D: Cross-Phase AI Interpretation
//
// POST フロー:
//   1.  Strategy + Strategy Version 取得
//   2.  各フェーズの最新結果を DB から取得 (全て Optional)
//   3.  InterpretationContext 組み立て
//   4.  buildInterpretationPrompt() → system/user prompt
//   5.  OpenAI 呼び出し (MODELS.chat, max_completion_tokens: 6000)
//   6.  parseInterpretationResponse() → Zod 検証
//   7.  validateInterpretationIntegrity() → 数値整合性チェック
//   8.  整合性違反があれば Correction Prompt でリトライ (最大1回)
//   9.  calcDeterministicConfidence() → Confidence 計算
//  10.  strategy_phase4d_interpretations INSERT
//  11.  レスポンス返却
//
// 設計:
//   - STRICTLY READ-ONLY: strategy_phase4d_interpretations のみ書き込む
//   - Version 自動作成なし / Parameter 推奨なし / 将来予測なし
//   - AI 使用 (MODELS.chat = 高能力モデル)
//   - Confidence はコードで決定論的に計算 (AI の自己申告を使わない)
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }           from "@/lib/strategySchema";
import { getOpenAIClient, MODELS }     from "@/infrastructure/ai/openai-client";
import {
  buildInterpretationPrompt,
  buildCorrectionPrompt,
  parseInterpretationResponse,
  validateInterpretationIntegrity,
  calcDeterministicConfidence,
} from "@/infrastructure/backtest/InterpretationEngine";
import type { InterpretationContext }  from "@/infrastructure/backtest/InterpretationSchema";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ------------------------------------------------------------------
// Helper: Supabase row → optimization context
// ------------------------------------------------------------------

function extractOptimizationCtx(
  jobRow: Record<string, unknown>,
  rank1:  Record<string, unknown> | null,
): InterpretationContext["optimization"] | undefined {
  if (!rank1) return undefined;
  const summary = jobRow.summary as Record<string, unknown> | null;
  return {
    totalCombinations:    Number(summary?.totalCombinations ?? jobRow.total_combinations ?? 0),
    rank1TotalPips:       Number(rank1.oos_total_pips      ?? rank1.is_total_pips       ?? 0),
    rank1ProfitFactor:    (rank1.oos_profit_factor === null || rank1.oos_profit_factor === undefined)
                            ? null : Number(rank1.oos_profit_factor),
    rank1DegradationRatio: (rank1.degradation_ratio === null || rank1.degradation_ratio === undefined)
                            ? null : Number(rank1.degradation_ratio),
    rank1SampleStatus:    (rank1.sample_status as "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT") ?? "INSUFFICIENT",
    stableZoneCount:      Number(summary?.stableZoneCount ?? 0),
    robustCount:          Number(summary?.robustCount     ?? 0),
  };
}

// ------------------------------------------------------------------
// GET — 最新 Phase 4-D 結果
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const { data } = await db
      .from("strategy_phase4d_interpretations")
      .select("*")
      .eq("strategy_id", strategyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return NextResponse.json({ status: "NOT_INTERPRETED" });
    return NextResponse.json({ status: "HAS_INTERPRETATION", interpretation: data });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/interpret]", err);
    return NextResponse.json({ error: "Failed to fetch interpretation" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// POST — Phase 4-D 解釈実行
// ------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  let body: {
    analysisId?: string;
    wfJobId?:    string;
    mcResultId?: string;
    optJobId?:   string;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    body = {};
  }

  // ── 1. Strategy + Spec + Version ────────────────────────────────

  const { data: stratRow, error: stratErr } = await db
    .from("strategy_registry")
    .select("name, strategy_type, symbols, timeframes, entry_conditions, exit_conditions, filters, risk, description")
    .eq("id", strategyId)
    .single();

  if (stratErr || !stratRow) {
    return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
  }

  const specValidation = StrategySpecSchema.safeParse({
    name:             stratRow.name,
    strategy_type:    stratRow.strategy_type,
    description:      stratRow.description,
    symbols:          stratRow.symbols,
    timeframes:       stratRow.timeframes,
    entry_conditions: stratRow.entry_conditions,
    exit_conditions:  stratRow.exit_conditions,
    filters:          stratRow.filters,
    risk:             stratRow.risk,
  });
  if (!specValidation.success) {
    return NextResponse.json({ error: "Invalid strategy spec" }, { status: 422 });
  }

  const symbol  = (stratRow.symbols as string[])[0] ?? "UNKNOWN";
  const mainTf  = (stratRow.timeframes as string[])[0] ?? "UNKNOWN";

  const { data: latestVersion } = await db
    .from("strategy_versions")
    .select("id, version")
    .eq("strategy_id", strategyId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const strategyVersionId = latestVersion?.id ?? null;
  const strategyVersionNum = latestVersion ? Number(latestVersion.version) : null;

  // ── 2. 各フェーズの最新結果を DB 取得 ───────────────────────────

  const availablePhases: InterpretationContext["availablePhases"] = [];

  // Phase 3-A: strategy_ai_analyses
  let analysisId: string | null = body.analysisId ?? null;
  let analysisRow: Record<string, unknown> | null = null;
  {
    let q = db.from("strategy_ai_analyses")
      .select("*")
      .eq("strategy_id", strategyId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (analysisId) q = db.from("strategy_ai_analyses").select("*").eq("id", analysisId).eq("strategy_id", strategyId);
    const { data } = await q.maybeSingle();
    analysisRow = (data as Record<string, unknown>) ?? null;
    if (analysisRow) { analysisId = String(analysisRow.id); availablePhases.push("BACKTEST_ANALYSIS"); }
  }

  // Phase 4-A: optimization_jobs + rank-1 candidate
  let optJobId: string | null = body.optJobId ?? null;
  let optCtx: InterpretationContext["optimization"] | undefined;
  {
    let q = db.from("optimization_jobs")
      .select("id, summary, total_combinations")
      .eq("strategy_id", strategyId)
      .eq("status", "COMPLETED")
      .order("created_at", { ascending: false })
      .limit(1);
    if (optJobId) q = db.from("optimization_jobs").select("id, summary, total_combinations").eq("id", optJobId).eq("strategy_id", strategyId);
    const { data: optJob } = await q.maybeSingle();
    if (optJob) {
      optJobId = String(optJob.id);
      const { data: rank1 } = await db
        .from("optimization_candidates")
        .select("oos_total_pips, is_total_pips, oos_profit_factor, degradation_ratio, sample_status")
        .eq("job_id", optJob.id)
        .eq("rank", 1)
        .maybeSingle();
      optCtx = extractOptimizationCtx(optJob as Record<string, unknown>, rank1 as Record<string, unknown> | null);
      if (optCtx) availablePhases.push("OPTIMIZATION");
    }
  }

  // Phase 4-B: walk_forward_jobs
  // カラム名: window_count (total_window_count は存在しない — Migration 011 参照)
  let wfJobId: string | null = body.wfJobId ?? null;
  let wfCtx: InterpretationContext["walkForward"] | undefined;
  {
    let q = db.from("walk_forward_jobs")
      .select("id, verdict, consistency_score, parameter_stability, window_count, valid_window_count, positive_window_count, skipped_window_count")
      .eq("strategy_id", strategyId)
      .eq("status", "COMPLETED")
      .order("created_at", { ascending: false })
      .limit(1);
    if (wfJobId) q = db.from("walk_forward_jobs").select("id, verdict, consistency_score, parameter_stability, window_count, valid_window_count, positive_window_count, skipped_window_count").eq("id", wfJobId).eq("strategy_id", strategyId);
    const { data: wfRow, error: wfQueryError } = await q.maybeSingle();
    if (wfQueryError) {
      console.error("[POST /interpret] walk_forward_jobs query error:", wfQueryError.message);
    } else if (wfRow) {
      wfJobId = String(wfRow.id);
      const stability = wfRow.parameter_stability as Record<string, number> | null;
      const stabilityValues = stability ? Object.values(stability) : [];
      const avgStability = stabilityValues.length > 0
        ? stabilityValues.reduce((s, v) => s + v, 0) / stabilityValues.length
        : 0;
      wfCtx = {
        verdict:               wfRow.verdict as "ROBUST" | "CONDITIONAL" | "OVERFIT" | "INCONCLUSIVE",
        consistencyScore:      wfRow.consistency_score !== null ? Number(wfRow.consistency_score) : null,
        parameterStabilityAvg: Math.round(avgStability * 1000) / 1000,
        totalWindowCount:      Number(wfRow.window_count       ?? 0),
        validWindowCount:      Number(wfRow.valid_window_count  ?? 0),
        positiveWindowCount:   Number(wfRow.positive_window_count ?? 0),
        skippedWindowCount:    Number(wfRow.skipped_window_count ?? 0),
      };
      availablePhases.push("WALK_FORWARD");
    }
  }

  // Phase 4-C: monte_carlo_results
  let mcResultId: string | null = body.mcResultId ?? null;
  let mcCtx: InterpretationContext["monteCarlo"] | undefined;
  {
    let q = db.from("monte_carlo_results")
      .select("id, original_final_pips, original_max_dd_pct, original_percentile_rank, probability_of_loss, probability_of_drawdown_threshold, drawdown_threshold_pct, iterations, trade_count, distributions")
      .eq("strategy_id", strategyId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (mcResultId) q = db.from("monte_carlo_results").select("id, original_final_pips, original_max_dd_pct, original_percentile_rank, probability_of_loss, probability_of_drawdown_threshold, drawdown_threshold_pct, iterations, trade_count, distributions").eq("id", mcResultId).eq("strategy_id", strategyId);
    const { data: mcRow } = await q.maybeSingle();
    if (mcRow) {
      mcResultId = String(mcRow.id);
      const dist = mcRow.distributions as Record<string, Record<string, number | null>> | null;
      const fp = dist?.finalPips;
      const dd = dist?.maxDrawdownPct;
      mcCtx = {
        method:                         "TRADE_ORDER_SHUFFLE",
        iterations:                     Number(mcRow.iterations),
        tradeCount:                     Number(mcRow.trade_count),
        drawdownThresholdPct:           Number(mcRow.drawdown_threshold_pct),
        originalFinalPips:              Number(mcRow.original_final_pips),
        originalMaxDdPct:               Number(mcRow.original_max_dd_pct),
        originalPercentileRank:         Number(mcRow.original_percentile_rank),
        probabilityOfLoss:              Number(mcRow.probability_of_loss),
        probabilityOfDrawdownThreshold: Number(mcRow.probability_of_drawdown_threshold),
        pipsP5:  Number(fp?.p5  ?? 0),
        pipsP25: Number(fp?.p25 ?? 0),
        pipsP50: Number(fp?.p50 ?? 0),
        pipsP75: Number(fp?.p75 ?? 0),
        pipsP95: Number(fp?.p95 ?? 0),
        ddP50:   Number(dd?.p50 ?? 0),
        ddP95:   Number(dd?.p95 ?? 0),
      };
      availablePhases.push("MONTE_CARLO");
    }
  }

  // 利用可能なフェーズが0の場合はエラー
  if (availablePhases.length === 0) {
    return NextResponse.json(
      { error: "No validation results available. Run at least one of: Backtest Analysis, Optimization, Walk Forward, or Monte Carlo first." },
      { status: 422 },
    );
  }

  // ── 3. InterpretationContext 組み立て ────────────────────────────

  // Phase 3-A から backtestCtx を構築
  // 数値メトリクスは strategy_ai_analyses.input_snapshot から読む
  // (verdict / totalPips 等は直接カラムではなく input_snapshot JSONB に保存されている)
  let backtestCtx: InterpretationContext["backtestAnalysis"] | undefined;
  if (analysisRow) {
    const snap = (
      typeof analysisRow.input_snapshot === "object" && analysisRow.input_snapshot !== null
        ? analysisRow.input_snapshot
        : null
    ) as Record<string, unknown> | null;

    if (snap) {
      const facts = (analysisRow.facts as Array<{ statement: string; value?: unknown }> | null) ?? [];
      const weaknesses = (analysisRow.weaknesses as Array<{ point: string }> | null) ?? [];
      backtestCtx = {
        verdict:           snap.verdict as "PASSED" | "CONDITIONAL" | "FAILED",
        verdictReason:     String(snap.verdictReason    ?? ""),
        totalPips:         Number(snap.totalPips         ?? 0),
        winRate:           Number(snap.winRate            ?? 0),
        maxDrawdownPct:    Number(snap.maxDrawdownPct    ?? 0),
        profitFactor:      snap.profitFactor == null ? null : Number(snap.profitFactor),
        totalTrades:       Number(snap.totalTrades       ?? 0),
        dataCoverageDays:  Number(snap.dataCoverageDays  ?? 0),
        sampleSizeWarning: Boolean(snap.sampleSizeWarning ?? false),
        topFacts:          facts.slice(0, 5).map(f => ({
          statement: String(f.statement ?? ""),
          value:     (f.value !== undefined && f.value !== null) ? (typeof f.value === "number" ? f.value : String(f.value)) : null,
        })),
        topWeaknesses:     weaknesses.slice(0, 5).map(w => ({ point: String(w.point ?? "") })),
        confidence:        Number(analysisRow.confidence ?? 0),
        dataQualityNote:   String(analysisRow.data_quality_note ?? ""),
      };
    } else {
      // input_snapshot が null/malformed → BACKTEST_ANALYSIS を利用可能フェーズから除外
      const idx = availablePhases.indexOf("BACKTEST_ANALYSIS");
      if (idx !== -1) availablePhases.splice(idx, 1);
    }
  }

  const ctx: InterpretationContext = {
    strategy: {
      name:       stratRow.name as string,
      type:       stratRow.strategy_type as string,
      symbol,
      timeframe:  mainTf,
      versionId:  strategyVersionId,
      versionNum: strategyVersionNum,
    },
    backtestAnalysis: backtestCtx,
    optimization:     optCtx,
    walkForward:      wfCtx,
    monteCarlo:       mcCtx,
    availablePhases,
  };

  // ── 4. Prompt 生成 ───────────────────────────────────────────────

  const { systemPrompt, userPrompt } = buildInterpretationPrompt(ctx);
  const client = getOpenAIClient();
  const model  = MODELS.chat;

  // ── 5. OpenAI 呼び出し (1回目) ──────────────────────────────────

  let rawText: string;
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      max_completion_tokens: 6000,
      response_format:       { type: "json_object" },
    });
    rawText = completion.choices[0]?.message?.content ?? "";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /interpret] OpenAI error:", err);
    return NextResponse.json({ error: `AI call failed: ${msg}` }, { status: 500 });
  }

  // ── 6. Zod 検証 ─────────────────────────────────────────────────

  const parsed = parseInterpretationResponse(rawText);
  if (!parsed.ok) {
    console.error("[POST /interpret] Schema validation failed:", parsed.error);
    return NextResponse.json(
      { error: "AI output schema validation failed", detail: parsed.error },
      { status: 422 },
    );
  }

  let aiOutput = parsed.output;

  // ── 7. 数値 Integrity チェック ───────────────────────────────────

  let integrityResult = validateInterpretationIntegrity(aiOutput, ctx);

  // ── 8. Integrity 違反 → Correction Prompt でリトライ ─────────────

  if (integrityResult.violations.length > 0) {
    console.warn("[POST /interpret] Integrity violations on attempt 1:", integrityResult.violations);

    const correctionMsg = buildCorrectionPrompt(integrityResult.violations);
    try {
      const correction = await client.chat.completions.create({
        model,
        messages: [
          { role: "system",    content: systemPrompt    },
          { role: "user",      content: userPrompt      },
          { role: "assistant", content: rawText          },
          { role: "user",      content: correctionMsg   },
        ],
        max_completion_tokens: 6000,
        response_format:       { type: "json_object" },
      });
      const retryText = correction.choices[0]?.message?.content ?? "";
      const retryParsed = parseInterpretationResponse(retryText);

      if (retryParsed.ok) {
        const retryIntegrity = validateInterpretationIntegrity(retryParsed.output, ctx);
        if (retryIntegrity.violations.length < integrityResult.violations.length) {
          // リトライで改善した場合は採用
          aiOutput = retryParsed.output;
          integrityResult = retryIntegrity;
        }
        // リトライ後も違反が残る場合: 元の出力で継続 (violations を記録)
      }
    } catch (retryErr) {
      console.warn("[POST /interpret] Correction retry failed:", retryErr);
      // リトライ失敗 → 元の出力で継続
    }
  }

  // ── 9. Confidence 決定論的計算 ───────────────────────────────────

  const confidence = calcDeterministicConfidence(ctx);

  // ── 10. DB INSERT ────────────────────────────────────────────────

  const { data: inserted, error: insertErr } = await db
    .from("strategy_phase4d_interpretations")
    .insert({
      strategy_id:            strategyId,
      strategy_version_id:    strategyVersionId,
      analysis_id:            analysisId,
      wf_job_id:              wfJobId,
      mc_result_id:           mcResultId,
      opt_job_id:             optJobId,
      available_phases:       availablePhases,
      model,
      input_snapshot:         ctx as unknown as Record<string, unknown>,
      overall_assessment:     aiOutput.overall_assessment,
      phase_observations:     aiOutput.phase_observations as unknown as Record<string, unknown>[],
      cross_phase_synthesis:  aiOutput.cross_phase_synthesis as unknown as Record<string, unknown>[],
      risk_dimensions:        aiOutput.risk_dimensions as unknown as Record<string, unknown>[],
      limitations:            aiOutput.limitations,
      confidence,
      data_completeness_note: aiOutput.data_completeness_note,
      integrity_violations:   integrityResult.violations,
    })
    .select("id, created_at")
    .single();

  if (insertErr || !inserted) {
    console.error("[POST /interpret] INSERT failed:", insertErr);
    return NextResponse.json({ error: `Failed to save interpretation: ${insertErr?.message}` }, { status: 500 });
  }

  // ── 11. レスポンス ───────────────────────────────────────────────

  return NextResponse.json({
    interpretationId:      inserted.id,
    createdAt:             inserted.created_at,
    status:                "COMPLETED",
    availablePhases,
    confidence,
    integrityViolations:   integrityResult.violations.length,
    overallAssessment:     aiOutput.overall_assessment,
    phaseObservations:     aiOutput.phase_observations,
    crossPhaseSynthesis:   aiOutput.cross_phase_synthesis,
    riskDimensions:        aiOutput.risk_dimensions,
    limitations:           aiOutput.limitations,
    dataCompletenessNote:  aiOutput.data_completeness_note,
  });
}

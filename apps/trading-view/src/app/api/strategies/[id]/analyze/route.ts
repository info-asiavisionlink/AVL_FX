// =================================================================
// POST /api/strategies/[id]/analyze
// GET  /api/strategies/[id]/analyze
//
// Phase 3-A: Backtest 結果を OpenAI で分析し strategy_ai_analyses へ保存
//
// POST フロー:
//   1. strategy_registry から Strategy Spec を取得
//   2. backtest_jobs + backtest_results + backtest_trades を取得
//      (jobId 指定あり → 指定 Job / なし → 最新 COMPLETED Job)
//   3. BacktestAnalyzer でコンテキスト + プロンプト生成
//   4. OpenAI chat.completions (json_object mode)
//   5. Zod バリデーション + Fact Integrity チェック
//   6. strategy_ai_analyses INSERT
//
// GET フロー:
//   最新の分析結果を返す (未分析なら NOT_ANALYZED)
//
// 設計原則:
//   - strategy_registry.ai_score / ai_verdict は変更しない (Phase 3-B 以降)
//   - BacktestEngine / Reporter は変更しない
//   - 個別トレードは取得するが AI には統計のみ渡す
// =================================================================

import { NextRequest, NextResponse }      from "next/server";
import { createAdminClient }              from "@/infrastructure/supabase/admin";
import { StrategySpecSchema }             from "@/lib/strategySchema";
import { getOpenAIClient, MODELS }        from "@/infrastructure/ai/openai-client";
import {
  buildAnalysisContext,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  validateFactIntegrity,
  type TradeForAnalysis,
} from "@/infrastructure/backtest/BacktestAnalyzer";
import type { BacktestReport }            from "@/infrastructure/backtest/BacktestReporter";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ------------------------------------------------------------------
// DB Row 型 (最低限必要なフィールドのみ)
// ------------------------------------------------------------------

type StrategyRow = {
  name:             string;
  strategy_type:    string;
  description:      string | null;
  symbols:          string[];
  timeframes:       string[];
  entry_conditions: unknown;
  exit_conditions:  unknown;
  filters:          unknown;
  risk:             unknown;
};

type BacktestResultRow = {
  period_label:          string;
  data_from:             string | null;
  data_to:               string | null;
  data_coverage_days:    number;
  bar_count_used:        number;
  total_trades:          number;
  wins:                  number;
  losses:                number;
  breakevens:            number;
  win_rate:              number;
  total_pips:            number;
  avg_pips:              number;
  gross_profit:          number;
  gross_loss:            number;
  profit_factor:         number | null;
  max_drawdown:          number;
  max_drawdown_pct:      number;
  max_drawdown_pips:     number;
  max_cons_wins:         number;
  max_cons_losses:       number;
  avg_duration_min:      number;
  session_stats:         Record<string, unknown>;
  best_session:          string | null;
  worst_session:         string | null;
  sample_size_warning:   boolean;
  min_recommended_trades: number;
  verdict:               "PASSED" | "CONDITIONAL" | "FAILED";
  verdict_reason:        string;
};

type BacktestTradeRow = {
  pips:          number;
  result:        "WIN" | "LOSS" | "BREAKEVEN" | "END_OF_DATA";
  exit_reason:   "TP" | "SL" | "END_OF_DATA";
  direction:     "BUY" | "SELL";
  duration_min:  number;
  session:       string;
};

// ------------------------------------------------------------------
// Helper: DB result row → BacktestReport
// ------------------------------------------------------------------

function rowToReport(row: BacktestResultRow, symbol: string, mainTf: string): BacktestReport {
  type SessionStatRaw = {
    tradeCount?: number;
    wins?: number;
    losses?: number;
    winRate?: number;
    totalPips?: number;
    profitFactor?: number | null;
  };

  const sessionStats: BacktestReport["sessionStats"] = {};
  for (const [k, v] of Object.entries(row.session_stats)) {
    const s = v as SessionStatRaw;
    sessionStats[k] = {
      tradeCount:   Number(s.tradeCount   ?? 0),
      wins:         Number(s.wins         ?? 0),
      losses:       Number(s.losses       ?? 0),
      winRate:      Number(s.winRate      ?? 0),
      totalPips:    Number(s.totalPips    ?? 0),
      profitFactor: s.profitFactor !== undefined ? (s.profitFactor === null ? null : Number(s.profitFactor)) : null,
    };
  }

  return {
    periodLabel:          row.period_label,
    dataFrom:             row.data_from  ? new Date(row.data_from).getTime()  : 0,
    dataTo:               row.data_to    ? new Date(row.data_to).getTime()    : 0,
    dataCoverageDays:     Number(row.data_coverage_days),
    barCount:             Number(row.bar_count_used),
    totalTrades:          Number(row.total_trades),
    wins:                 Number(row.wins),
    losses:               Number(row.losses),
    breakevens:           Number(row.breakevens),
    winRate:              Number(row.win_rate),
    totalPips:            Number(row.total_pips),
    avgPips:              Number(row.avg_pips),
    totalProfit:          Number(row.gross_profit) - Number(row.gross_loss),
    grossProfit:          Number(row.gross_profit),
    grossLoss:            Number(row.gross_loss),
    profitFactor:         row.profit_factor === null ? null : Number(row.profit_factor),
    initialBalance:       10000,  // stored in job, not result — use default
    finalBalance:         10000 + (Number(row.gross_profit) - Number(row.gross_loss)),
    maxDrawdown:          Number(row.max_drawdown),
    maxDrawdownPct:       Number(row.max_drawdown_pct),
    maxDrawdownPips:      Number(row.max_drawdown_pips),
    maxConsecutiveWins:   Number(row.max_cons_wins),
    maxConsecutiveLosses: Number(row.max_cons_losses),
    avgDurationMin:       Number(row.avg_duration_min),
    sessionStats,
    bestSession:          row.best_session,
    worstSession:         row.worst_session,
    sampleSizeWarning:    Boolean(row.sample_size_warning),
    minRecommendedTrades: Number(row.min_recommended_trades),
    verdict:              row.verdict,
    verdictReason:        row.verdict_reason,
    symbol,
    mainTimeframe:        mainTf,
  };
}

// ------------------------------------------------------------------
// POST — AI 分析実行
// ------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const body = await req.json().catch(() => ({})) as { jobId?: string };

    // 1. Strategy 取得
    const { data: stratRow, error: stratErr } = await db
      .from("strategy_registry")
      .select("name,strategy_type,description,symbols,timeframes,entry_conditions,exit_conditions,filters,risk")
      .eq("id", strategyId)
      .single();

    if (stratErr || !stratRow) {
      return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
    }

    const strategy = stratRow as StrategyRow;

    // StrategySpec 再構築 + バリデーション
    const specParse = StrategySpecSchema.safeParse({
      name:             strategy.name,
      strategy_type:    strategy.strategy_type,
      description:      strategy.description,
      symbols:          strategy.symbols,
      timeframes:       strategy.timeframes,
      entry_conditions: strategy.entry_conditions,
      exit_conditions:  strategy.exit_conditions,
      filters:          strategy.filters,
      risk:             strategy.risk,
    });
    if (!specParse.success) {
      return NextResponse.json({ error: "Invalid strategy spec in database" }, { status: 422 });
    }
    const spec = specParse.data;

    // 2. Job 取得 (指定あり / なし)
    let jobId: string;
    if (body.jobId) {
      // 指定 Job の存在確認
      const { data: jobRow, error: jobErr } = await db
        .from("backtest_jobs")
        .select("id,status")
        .eq("id", body.jobId)
        .eq("strategy_id", strategyId)
        .single();

      if (jobErr || !jobRow) {
        return NextResponse.json({ error: "Backtest job not found" }, { status: 404 });
      }
      if (jobRow.status !== "COMPLETED") {
        return NextResponse.json({ error: "Backtest job is not COMPLETED" }, { status: 422 });
      }
      jobId = body.jobId;
    } else {
      // 最新 COMPLETED Job
      const { data: jobs } = await db
        .from("backtest_jobs")
        .select("id")
        .eq("strategy_id", strategyId)
        .eq("status", "COMPLETED")
        .order("created_at", { ascending: false })
        .limit(1);

      if (!jobs || jobs.length === 0) {
        return NextResponse.json({ error: "No completed backtest found for this strategy" }, { status: 404 });
      }
      jobId = jobs[0]!.id as string;
    }

    // 3. backtest_results 取得
    const { data: resultRow, error: resultErr } = await db
      .from("backtest_results")
      .select("*")
      .eq("job_id", jobId)
      .single();

    if (resultErr || !resultRow) {
      return NextResponse.json({ error: "Backtest result not found" }, { status: 404 });
    }

    // 4. backtest_trades 取得（統計化用に上限 500 件）
    const { data: tradeRows } = await db
      .from("backtest_trades")
      .select("pips,result,exit_reason,direction,duration_min,session")
      .eq("job_id", jobId)
      .order("entry_time", { ascending: true })
      .limit(500);

    const trades: TradeForAnalysis[] = ((tradeRows ?? []) as BacktestTradeRow[]).map(t => ({
      pips:        Number(t.pips),
      result:      t.result,
      exitReason:  t.exit_reason,
      direction:   t.direction,
      durationMin: Number(t.duration_min),
      session:     t.session ?? "OFF",
    }));

    // 5. AnalysisContext 構築
    const symbol  = spec.symbols[0]!;
    const mainTf  = spec.timeframes[0]!;
    const report  = rowToReport(resultRow as BacktestResultRow, symbol, mainTf);
    const context = buildAnalysisContext(report, trades, spec);

    // 6. OpenAI 呼び出し
    const { systemPrompt, userPrompt } = buildAnalysisPrompt(context);
    const client  = getOpenAIClient();
    const model   = MODELS.chatFast;

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      max_completion_tokens: 4096,
      response_format:       { type: "json_object" },
    });

    const rawText = completion.choices[0]?.message?.content ?? "";

    // 7. パース + Zod バリデーション
    const parsed = parseAnalysisResponse(rawText);
    if (!parsed.ok) {
      console.error("[analyze] Zod validation failed:", parsed.error);
      return NextResponse.json(
        { error: "AI output validation failed", detail: parsed.error },
        { status: 422 },
      );
    }

    let analysis = parsed.analysis;

    // 8. Fact Integrity チェック
    const integrityResult = validateFactIntegrity(analysis.facts, context);
    if (integrityResult.violations.length > 0) {
      console.warn("[analyze] Fact violations:", integrityResult.violations);
      // 矛盾した fact を除去して保存継続
      analysis = { ...analysis, facts: integrityResult.cleanFacts };
    }

    // 9. version 番号決定（同一 job_id の MAX + 1）
    const { data: versionRow } = await db
      .from("strategy_ai_analyses")
      .select("version")
      .eq("job_id", jobId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    const version = versionRow ? Number(versionRow.version) + 1 : 1;

    // 10. strategy_ai_analyses INSERT
    const { data: saved, error: insertErr } = await db
      .from("strategy_ai_analyses")
      .insert({
        strategy_id:       strategyId,
        job_id:            jobId,
        version,
        input_snapshot:    context as unknown as Record<string, unknown>,
        model,
        summary:           analysis.summary,
        facts:             analysis.facts,
        observations:      analysis.observations,
        hypotheses:        analysis.hypotheses,
        weaknesses:        analysis.weaknesses,
        strengths:         analysis.strengths,
        session_analysis:  analysis.session_analysis,
        risk_analysis:     analysis.risk_analysis,
        recommendations:   analysis.recommendations,
        confidence:        analysis.confidence,
        data_quality_note: analysis.data_quality_note,
      })
      .select("id,version,created_at")
      .single();

    if (insertErr || !saved) {
      console.error("[analyze] INSERT failed:", insertErr);
      return NextResponse.json({ error: "Failed to save analysis" }, { status: 500 });
    }

    return NextResponse.json({
      analysisId:         saved.id,
      version:            saved.version,
      factViolations:     integrityResult.violations.length,
      analysis,
    });

  } catch (err) {
    console.error("[POST /api/strategies/[id]/analyze]", err);
    const msg = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// GET — 最新分析結果取得
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const { data, error } = await db
      .from("strategy_ai_analyses")
      .select("*")
      .eq("strategy_id", strategyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return NextResponse.json({ status: "NOT_ANALYZED" });
    }

    return NextResponse.json({ status: "HAS_ANALYSIS", analysis: data });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/analyze]", err);
    return NextResponse.json({ error: "Failed to fetch analysis" }, { status: 500 });
  }
}

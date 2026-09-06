// =================================================================
// POST /api/strategies/[id]/improve
// GET  /api/strategies/[id]/improve
//
// Phase 3-B: AI Strategy Improvement Proposal 生成・保存・取得
//
// POST フロー:
//   1. strategy_registry → StrategySpec 再構築
//   2. strategy_ai_analyses → 指定 Analysis 取得
//   3. analysis.input_snapshot から sampleSizeWarning 取得
//   4. buildImprovementPrompt → OpenAI (json_object mode)
//   5. parseImprovementResponse → Zod 検証
//   6. validateWhitelist → Whitelist 検証
//   7. conditions[N] のインデックス範囲確認
//   8. validateFromValues → from 値照合
//   9. applyChangesToSpec → Server-side Patch → StrategySpecSchema 再検証
//  10. strategy_improvements INSERT
//
// 設計原則:
//   - AI は proposed_spec を直接生成しない (Step 9 でサーバー側生成)
//   - Phase 3-B では Apply なし (status='PROPOSED' のみ)
//   - strategy_registry は変更しない
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { createAdminClient }           from "@/infrastructure/supabase/admin";
import { StrategySpecSchema, type StrategySpec } from "@/lib/strategySchema";
import { getOpenAIClient, MODELS }     from "@/infrastructure/ai/openai-client";
import {
  buildImprovementPrompt,
  parseImprovementResponse,
  applyChangesToSpec,
  conditionIndexExists,
} from "@/infrastructure/backtest/StrategyImprover";
import {
  validateWhitelist,
  validateFromValues,
  parseFieldPath,
  type StrategyImprovementRecord,
} from "@/infrastructure/backtest/ImprovementSchema";
import type { StrategyAIAnalysisRecord } from "@/infrastructure/backtest/analysisSchema";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ------------------------------------------------------------------
// POST — Improvement Proposal 生成
// ------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const body = await req.json().catch(() => ({})) as { analysisId?: string };

    if (!body.analysisId) {
      return NextResponse.json({ error: "analysisId is required" }, { status: 400 });
    }

    // 1. Strategy 取得
    const { data: stratRow, error: stratErr } = await db
      .from("strategy_registry")
      .select("name,strategy_type,description,symbols,timeframes,entry_conditions,exit_conditions,filters,risk")
      .eq("id", strategyId)
      .single();

    if (stratErr || !stratRow) {
      return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
    }

    // 2. StrategySpec 再バリデーション
    const specParse = StrategySpecSchema.safeParse({
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
    if (!specParse.success) {
      return NextResponse.json({ error: "Invalid strategy spec in database" }, { status: 422 });
    }
    const spec: StrategySpec = specParse.data;

    // 3. Analysis 取得
    const { data: analysisRow, error: analysisErr } = await db
      .from("strategy_ai_analyses")
      .select("id,strategy_id,summary,facts,observations,hypotheses,weaknesses,recommendations,confidence,data_quality_note,input_snapshot")
      .eq("id", body.analysisId)
      .single();

    if (analysisErr || !analysisRow) {
      return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
    }

    if (analysisRow.strategy_id !== strategyId) {
      return NextResponse.json(
        { error: "Analysis does not belong to this strategy" },
        { status: 422 },
      );
    }

    const analysis = analysisRow as Pick<StrategyAIAnalysisRecord,
      "summary" | "facts" | "observations" | "hypotheses" | "weaknesses" | "recommendations"
      | "confidence" | "data_quality_note">;

    // 4. sampleSizeWarning を input_snapshot から取得
    const snapshot = analysisRow.input_snapshot as Record<string, unknown> | null;
    const requiresMoreData = Boolean(snapshot?.sampleSizeWarning ?? false);

    // 5. OpenAI 呼び出し
    const { systemPrompt, userPrompt } = buildImprovementPrompt(analysis, spec, requiresMoreData);
    const client = getOpenAIClient();
    const model  = MODELS.chatFast;

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      max_completion_tokens: 2048,
      response_format:       { type: "json_object" },
    });

    const rawText = completion.choices[0]?.message?.content ?? "";

    // 6. パース + Zod 検証
    const parsed = parseImprovementResponse(rawText);
    if (!parsed.ok) {
      console.error("[improve] Zod validation failed:", parsed.error);
      return NextResponse.json(
        { error: "AI output validation failed", detail: parsed.error },
        { status: 422 },
      );
    }
    const proposal = parsed.proposal;

    // 7. Whitelist 検証
    const whitelistResult = validateWhitelist(proposal.changes);
    if (!whitelistResult.valid) {
      console.warn("[improve] Whitelist violations:", whitelistResult.violations);
      return NextResponse.json(
        { error: "Whitelist violation", violations: whitelistResult.violations },
        { status: 422 },
      );
    }

    // 8. conditions[N] インデックス範囲確認
    for (const change of proposal.changes) {
      const parsed_ = parseFieldPath(change.field);
      if (parsed_?.type === "condition") {
        if (!conditionIndexExists(spec, parsed_.index)) {
          return NextResponse.json(
            { error: `Condition index [${parsed_.index}] does not exist in current spec (${spec.entry_conditions.conditions.length} conditions)` },
            { status: 422 },
          );
        }
      }
    }

    // 9. from 値照合
    const specJson = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
    const fromResult = validateFromValues(proposal.changes, specJson);
    if (!fromResult.valid) {
      console.warn("[improve] From value violations:", fromResult.violations);
      return NextResponse.json(
        { error: "from value mismatch", violations: fromResult.violations },
        { status: 422 },
      );
    }

    // 10. Server-side Patch → proposed_spec 生成
    let proposedSpec: StrategySpec;
    try {
      proposedSpec = applyChangesToSpec(spec, proposal.changes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Proposed spec generation failed: ${msg}` },
        { status: 422 },
      );
    }

    // 11. strategy_improvements INSERT
    const { data: saved, error: insertErr } = await db
      .from("strategy_improvements")
      .insert({
        strategy_id:        strategyId,
        analysis_id:        body.analysisId,
        from_version:       1,
        changes:            proposal.changes,
        expected_effects:   proposal.expected_effects,
        risks:              proposal.risks,
        proposed_spec:      proposedSpec as unknown as Record<string, unknown>,
        confidence:         proposal.confidence,
        requires_more_data: proposal.requires_more_data || requiresMoreData,
        status:             "PROPOSED",
        model:              completion.model,
      })
      .select("id,status,created_at")
      .single();

    if (insertErr || !saved) {
      console.error("[improve] INSERT failed:", insertErr);
      return NextResponse.json({ error: "Failed to save improvement" }, { status: 500 });
    }

    return NextResponse.json({
      improvementId: saved.id,
      improvement:   {
        ...proposal,
        proposed_spec: proposedSpec,
        status:        "PROPOSED",
        created_at:    saved.created_at,
      },
    });

  } catch (err) {
    console.error("[POST /api/strategies/[id]/improve]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

// ------------------------------------------------------------------
// GET — 最新 Improvement Proposal 取得
// ------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const { data, error } = await db
      .from("strategy_improvements")
      .select("*")
      .eq("strategy_id", strategyId)
      .eq("status", "PROPOSED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return NextResponse.json({ status: "NO_PROPOSAL" });
    }

    return NextResponse.json({ status: "HAS_PROPOSAL", improvement: data as StrategyImprovementRecord });

  } catch (err) {
    console.error("[GET /api/strategies/[id]/improve]", err);
    return NextResponse.json({ error: "Failed to fetch improvement" }, { status: 500 });
  }
}

// ------------------------------------------------------------------
// PATCH — status 更新 (REJECTED のみ Phase 3-B で許可)
// ------------------------------------------------------------------

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;
  const db = createAdminClient();

  try {
    const body = await req.json() as { improvementId?: string; status?: string };

    if (!body.improvementId || body.status !== "REJECTED") {
      return NextResponse.json(
        { error: "improvementId and status=REJECTED required. Apply is Phase 3-C." },
        { status: 400 },
      );
    }

    const { data, error } = await db
      .from("strategy_improvements")
      .update({ status: "REJECTED" })
      .eq("id", body.improvementId)
      .eq("strategy_id", strategyId)
      .eq("status", "PROPOSED")
      .select("id,status")
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "Improvement not found or not PROPOSED" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, status: "REJECTED" });

  } catch (err) {
    console.error("[PATCH /api/strategies/[id]/improve]", err);
    return NextResponse.json({ error: "Failed to update improvement" }, { status: 500 });
  }
}

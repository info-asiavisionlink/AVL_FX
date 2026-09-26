// =================================================================
// POST /api/ai/trader/build
//
// 自然言語 → AI Trader Profile へ変換
//
// 入力: { description: string, knowledge_list?: {id, title, category}[] }
// 出力: { success, profile: AITraderProfile, name, description, reasoning }
// =================================================================

import { NextRequest, NextResponse }  from "next/server";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";
import {
  AITraderBuilderOutputSchema,
  normalizeAndValidateBuilderProfile,
  PERSONALITIES,
  TRADING_STYLES,
  RISK_PROFILES,
  ENTRY_PATIENCES,
  NEWS_SENSITIVITIES,
  VOLATILITY_PREFS,
} from "@/lib/aiTraderSchema";

export const runtime   = "nodejs";
export const maxDuration = 120;

interface KnowledgeHint {
  id:       string;
  title:    string;
  category: string;
}

function buildTraderPrompt(description: string, knowledgeList: KnowledgeHint[]): string {
  const knowledgeSection = knowledgeList.length > 0
    ? `\n## AVAILABLE KNOWLEDGE BASE\nThe following knowledge items are available for selection:\n${
        knowledgeList.map(k => `- [${k.id}] ${k.title} (${k.category})`).join("\n")
      }\n\nSelect the knowledge IDs that are most relevant to this trader's approach.`
    : "";

  return `You are AVL FX AI Trader Architect. Your task is to analyze a natural language description of a desired trading personality and convert it into a structured AI Trader Profile.

IMPORTANT PHILOSOPHY:
- This is NOT creating a fixed IF-condition EA
- This creates a trader PERSONALITY and MINDSET
- The trader will OBSERVE → THINK → SCENARIO → WAIT → RE-EVALUATE → TRADE → REVIEW → LEARN
- Do NOT guarantee profits or win rates
- Focus on risk management philosophy, patience, and market approach

## USER DESCRIPTION
"${description}"
${knowledgeSection}

## OUTPUT FORMAT
Respond with ONLY valid JSON:
{
  "name": string (2-50 chars, Japanese OK, concise trader name),
  "description": string (1-2 sentences describing the trader's philosophy),
  "reasoning": string (explain why you chose these settings, in Japanese),
    "profile": {
    "personality": "${PERSONALITIES.join('" | "')}",
    "trading_style": "${TRADING_STYLES.join('" | "')}",
    "risk_profile": "${RISK_PROFILES.join('" | "')}",
    "entry_patience": "${ENTRY_PATIENCES.join('" | "')}",
    "news_sensitivity": "${NEWS_SENSITIVITIES.join('" | "')}",
    "volatility_preference": "${VOLATILITY_PREFS.join('" | "')}",
    "timeframes": string[] (supported values: M1, M5, M15, M30, H1, H4, D1, W1),
    "minimum_rr": number (e.g. 2.0),
    "max_risk_per_trade": number (0.5-2.0),
    "max_positions": integer (1-3),
    "instructions": string (key behavioral rules for this trader, in Japanese, max 2000 chars)
  },
  "suggested_knowledge_ids": string[] (IDs from available knowledge that match this trader)
  "execution_mode": "ANALYSIS_ONLY"
}

## RULES
1. personality CONSERVATIVE = 勝率重視、慎重、少ないトレード数
2. personality AGGRESSIVE = 積極的なエントリー、高いリスク許容
3. entry_patience VERY_PATIENT = 完璧なセットアップのみ待つ
4. news_sensitivity HIGH = 重要指標前後はトレード回避
5. minimum_rr should reflect risk management philosophy (conservative → higher RR)
6. max_risk_per_trade should reflect risk profile (VERY_LOW=0.25, LOW=0.5, MEDIUM=1.0, HIGH=2.0)
7. timeframes should reflect the described analysis approach
8. instructions must be behavioral rules, NOT entry conditions

## ABSOLUTE PROHIBITIONS
- Do NOT include specific indicator conditions (no "RSI > 50")
- Do NOT include price levels or specific values
- Do NOT guarantee or imply profit
- Do NOT set personality/risk inconsistently`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      description?:   string;
      knowledge_list?: KnowledgeHint[];
    };

    const description = (body.description ?? "").trim();
    if (description.length < 5) {
      return NextResponse.json(
        { success: false, error: "説明を入力してください（5文字以上）" },
        { status: 400 }
      );
    }
    if (description.length > 3000) {
      return NextResponse.json(
        { success: false, error: "説明が長すぎます（3000文字以内）" },
        { status: 400 }
      );
    }

    const knowledgeList = body.knowledge_list ?? [];
    const prompt = buildTraderPrompt(description, knowledgeList);

    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model:                 process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat,
      messages: [
        { role: "system", content: prompt },
        { role: "user",   content: `Create an AI Trader profile from this description: "${description}"` },
      ],
      max_completion_tokens: 2048,
      response_format:       { type: "json_object" },
    });

    const rawText = completion.choices[0]?.message?.content ?? "";

    let rawData: unknown;
    try {
      rawData = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { success: false, error: "AI の出力が JSON ではありませんでした。再試行してください。" },
        { status: 422 }
      );
    }

    const validation = AITraderBuilderOutputSchema.safeParse(rawData);
    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: "AIプロフィールの形式または必須項目が不正です。再試行してください。" },
        { status: 422 }
      );
    }

    let profile;
    try {
      profile = normalizeAndValidateBuilderProfile(validation.data.profile);
    } catch {
      return NextResponse.json(
        { success: false, error: "AIプロフィールの市場・時間足・リスク設定が不正です。再試行してください。" },
        { status: 422 }
      );
    }
    const out = validation.data;
    return NextResponse.json({
      success:                 true,
      name:                    out.name,
      description:             out.description,
      reasoning:               out.reasoning,
      profile,
      suggested_knowledge_ids: out.suggested_knowledge_ids,
      execution_mode:          out.execution_mode,
    });

  } catch (e) {
    console.error("[POST /api/ai/trader/build]", e);
    return NextResponse.json(
      { success: false, error: "サーバーエラーが発生しました" },
      { status: 500 }
    );
  }
}

// =================================================================
// POST /api/ai/strategy/chat
//
// Conversational Strategy Research Assistant
//
// 入力:
//   { spec, backtestResult, revisionHistory, messages, mode }
//
// 出力:
//   { message, proposedChange?, overfittingWarning?, stopRecommendation? }
//
// 設計原則:
//   - 内部ロジック・DB・BacktestEngineは変更しない
//   - AI提案はユーザー承認なしにSpecを変更しない
//   - proposedChange.newSpecはStrategySpecSchema検証済みのもののみ返す
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient }           from "@/infrastructure/ai/openai-client";
import { StrategySpecSchema }         from "@/lib/strategySchema";

export const runtime = "nodejs";

// ------------------------------------------------------------------
// 型定義
// ------------------------------------------------------------------

interface DirStat {
  trades:  number;
  wins:    number;
  pips:    number;
  winRate: number;
}

interface PreviewReport {
  totalTrades:    number;
  wins:           number;
  losses:         number;
  winRate:        number;
  totalPips:      number;
  avgPips:        number;
  profitFactor:   number | null;
  maxDrawdown:    number;
  maxDrawdownPct: number;
  verdict:        string;
  verdictReason:  string;
  [key: string]: unknown;
}

interface BacktestResultSummary {
  report:             PreviewReport;
  directionBreakdown: { buy: DirStat; sell: DirStat };
  barCount:           number;
}

interface RevisionSummary {
  id:                string;
  changeDescription: string;
  pf:                number | null;
  totalPips:         number;
  totalTrades:       number;
  verdict:           string;
}

interface ChatMessage {
  role:    "user" | "assistant";
  content: string;
}

interface RequestBody {
  spec:             unknown;
  backtestResult:   BacktestResultSummary;
  revisionHistory:  RevisionSummary[];
  messages:         ChatMessage[];
  mode:             "diagnose" | "chat";
}

// ------------------------------------------------------------------
// システムプロンプト生成
// ------------------------------------------------------------------

function buildSystemPrompt(
  spec:           unknown,
  bt:             BacktestResultSummary,
  history:        RevisionSummary[],
): string {
  const r   = bt.report;
  const buy  = bt.directionBreakdown.buy;
  const sell = bt.directionBreakdown.sell;
  const pf   = r.profitFactor != null ? r.profitFactor.toFixed(2) : "∞";

  const historyJson = history.length > 0
    ? JSON.stringify(history, null, 2)
    : "（まだリビジョンなし）";

  return `あなたはFX戦略の研究アシスタントです。
ユーザーはバックテスト結果を見ながらStrategyを改善しようとしています。

現在のStrategy Spec:
${JSON.stringify(spec, null, 2)}

現在のバックテスト結果:
- 総取引数: ${r.totalTrades}
- 勝ち: ${r.wins} / 負け: ${r.losses}
- 勝率: ${r.winRate.toFixed(1)}%
- PF: ${pf}
- 合計PIPS: ${r.totalPips.toFixed(1)}
- 平均PIPS/トレード: ${r.avgPips.toFixed(1)}
- 最大DD: ${r.maxDrawdownPct.toFixed(1)}%
- 判定: ${r.verdict}
- 判定理由: ${r.verdictReason}
- BUY: ${buy.trades} trades, ${buy.winRate.toFixed(1)}% WR, ${buy.pips.toFixed(1)} pips
- SELL: ${sell.trades} trades, ${sell.winRate.toFixed(1)}% WR, ${sell.pips.toFixed(1)} pips
- バーカウント: ${bt.barCount}

過去のリビジョン履歴:
${historyJson}

ルール:
1. 事実に基づいた分析をする（数字を捏造しない）
2. PFが高いだけで「勝てる」と断言しない
3. 改善提案とEdge確認を区別する
4. 過学習警告: 同じchangeTypeが3回以上続いた場合にoverfittingWarningを設定する
5. 5回以上リビジョンしてもPF < 1.0が続く場合はstopRecommendationを設定する
6. proposedChange.newSpecは必ず完全なStrategy Specオブジェクトを含めること

応答は必ずJSON形式で:
{
  "message": "テキスト回答（必須・日本語）",
  "proposedChange": {
    "description": "変更内容の説明（日本語）",
    "changeType": "ENTRY_CHANGE|EXIT_CHANGE|FILTER_CHANGE|DIRECTION_CHANGE|SESSION_CHANGE|HYPOTHESIS_CHANGE",
    "reasoning": "変更理由（日本語）",
    "newSpec": {変更後の完全なStrategy Specオブジェクト}
  },
  "overfittingWarning": null,
  "stopRecommendation": null
}

proposedChangeがない場合は "proposedChange": null にすること。`;
}

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as RequestBody;

    const { spec, backtestResult, revisionHistory, messages, mode } = body;

    if (!spec || !backtestResult) {
      return NextResponse.json(
        { success: false, error: "spec と backtestResult は必須です" },
        { status: 400 }
      );
    }

    const client      = getOpenAIClient();
    const systemPrompt = buildSystemPrompt(spec, backtestResult, revisionHistory ?? []);

    // mode === "diagnose" の場合、ユーザーメッセージなしで初回診断
    const userContent = mode === "diagnose"
      ? "このバックテスト結果を分析してください。強みと弱みを指摘し、改善提案があれば提示してください。"
      : (messages[messages.length - 1]?.content ?? "");

    // 会話履歴を構築（diagnoseは空）
    const conversationMessages: Array<{ role: "user" | "assistant"; content: string }> =
      mode === "diagnose"
        ? []
        : messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system",  content: systemPrompt },
        ...conversationMessages,
        { role: "user",    content: userContent  },
      ],
      max_completion_tokens: 2048,
      response_format:       { type: "json_object" },
    });

    const rawText = completion.choices[0]?.message?.content ?? "{}";

    // JSON パース
    let parsed: {
      message:             string;
      proposedChange?:     {
        description: string;
        changeType:  string;
        reasoning:   string;
        newSpec:     unknown;
      } | null;
      overfittingWarning?: string | null;
      stopRecommendation?: string | null;
    };

    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      return NextResponse.json({
        message:             "申し訳ありません。応答の解析に失敗しました。もう一度お試しください。",
        proposedChange:      null,
        overfittingWarning:  null,
        stopRecommendation:  null,
      });
    }

    // proposedChange の newSpec を Zod で検証
    let validatedProposedChange = parsed.proposedChange ?? null;

    if (validatedProposedChange?.newSpec) {
      const specValidation = StrategySpecSchema.safeParse(validatedProposedChange.newSpec);
      if (!specValidation.success) {
        // 検証失敗の場合はproposedChangeをnullにする（エラーにしない）
        validatedProposedChange = null;
      }
    }

    return NextResponse.json({
      message:             parsed.message ?? "分析が完了しました。",
      proposedChange:      validatedProposedChange,
      overfittingWarning:  parsed.overfittingWarning  ?? null,
      stopRecommendation:  parsed.stopRecommendation ?? null,
    });

  } catch (err) {
    console.error("[ai/strategy/chat]", err);
    const msg = err instanceof Error ? err.message : "不明なエラー";
    return NextResponse.json(
      { success: false, error: `AI 処理エラー: ${msg}` },
      { status: 500 }
    );
  }
}

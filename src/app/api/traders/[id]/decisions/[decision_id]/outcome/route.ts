// =================================================================
// POST /api/traders/[id]/decisions/[decision_id]/outcome
//
// 承認済み Decision の取引結果を記録する。
//
// フロー:
//   APPROVED decision → trade_outcome 作成
//   → trade_review 自動生成（AI使用）
//   → experience_memory HYPOTHESIS として登録
//
// 安全ルール:
//   - APPROVED decision にのみ記録可能
//   - experience_memory は HYPOTHESIS で登録（VALIDATED への昇格は手動）
//   - AI が自動で VALIDATED にすることは禁止
// =================================================================

import { NextRequest, NextResponse }    from "next/server";
import { createAdminClient }             from "@/infrastructure/supabase/admin";
import { createClient }                  from "@/infrastructure/supabase/server";
import { getOpenAIClient, MODELS }       from "@/infrastructure/ai/openai-client";

export const runtime    = "nodejs";
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; decision_id: string }> },
) {
  const { id, decision_id } = await params;

  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const body = await req.json().catch(() => null) as {
    outcome:     "WIN" | "LOSS" | "BREAKEVEN" | "CANCELLED";
    exit_price:  number;
    profit_usd?: number;
    pips?:       number;
    broker_ticket?: number;
    entry_time?: string;
    exit_time?:  string;
    note?:       string; // ユーザーメモ
  } | null;

  if (!body || !body.outcome || !body.exit_price) {
    return NextResponse.json({ error: "outcome と exit_price が必要です" }, { status: 400 });
  }
  if (!["WIN", "LOSS", "BREAKEVEN", "CANCELLED"].includes(body.outcome)) {
    return NextResponse.json({ error: "outcome は WIN / LOSS / BREAKEVEN / CANCELLED のいずれかです" }, { status: 400 });
  }

  const db = createAdminClient();

  // Decision 取得（所有権 + APPROVED 確認）
  const { data: decision } = await db
    .from("trade_decisions")
    .select("*")
    .eq("id", decision_id)
    .eq("ai_trader_id", id)
    .eq("user_id", user.id)
    .single();

  if (!decision) return NextResponse.json({ error: "Decisionが見つかりません" }, { status: 404 });
  if (decision.status !== "APPROVED") {
    return NextResponse.json({ error: "承認済みの Decision にのみ結果を記録できます" }, { status: 409 });
  }

  // 既に outcome が存在するか確認
  const { data: existingOutcome } = await db
    .from("trade_outcomes")
    .select("id")
    .eq("decision_id", decision_id)
    .maybeSingle();

  if (existingOutcome) {
    return NextResponse.json({ error: "この Decision の結果は既に記録されています" }, { status: 409 });
  }

  // pips 計算（入力なければ entry/exit から計算）
  const entryPrice = decision.reference_price as number ?? 0;
  const exitPrice  = body.exit_price;
  const direction  = (decision.decision as string) === "BUY" ? 1 : -1;
  const calcPips   = body.pips ?? (exitPrice > 0 && entryPrice > 0
    ? Math.round((exitPrice - entryPrice) * direction * 100) / 100
    : 0);

  // 1. trade_outcome 作成
  const { data: outcome, error: outcomeErr } = await db
    .from("trade_outcomes")
    .insert({
      decision_id:   decision_id,
      ai_trader_id:  id,
      user_id:       user.id,
      outcome:       body.outcome,
      entry_price:   entryPrice || null,
      exit_price:    exitPrice,
      pips:          calcPips,
      profit_usd:    body.profit_usd ?? null,
      entry_time:    body.entry_time ?? null,
      exit_time:     body.exit_time ?? new Date().toISOString(),
      broker_ticket: body.broker_ticket ?? null,
    })
    .select()
    .single();

  if (outcomeErr) {
    return NextResponse.json({ error: "結果の記録に失敗しました: " + outcomeErr.message }, { status: 500 });
  }

  // 2. AI によるトレードレビュー自動生成
  let reviewText = "";
  let hypothesis = "";
  let whatWorked = "";
  let whatFailed = "";

  try {
    const client = getOpenAIClient();
    const reviewPrompt = `あなたはFXトレーディングアドバイザーです。以下のトレード結果を分析して、短い振り返りを日本語で生成してください。

トレード内容:
- 判断: ${decision.decision} (${decision.market})
- エントリー価格: ${entryPrice?.toFixed(2) ?? "不明"}
- 決済価格: ${exitPrice.toFixed(2)}
- 結果: ${body.outcome} (${calcPips >= 0 ? "+" : ""}${calcPips.toFixed(2)} pips)
- AI判断理由: ${(decision.reasoning as string)?.slice(0, 200) ?? "なし"}
- ユーザーメモ: ${body.note ?? "なし"}

以下の形式でJSONで回答してください:
{
  "review_text": "全体的な振り返り（2〜3文）",
  "what_worked": "${body.outcome === "WIN" ? "うまくいった点" : "何が課題だったか"}",
  "what_failed": "${body.outcome === "LOSS" ? "うまくいかなかった点" : "改善できる点"}",
  "hypothesis": "今後に活かせる仮説（1文）"
}`;

    const completion = await client.chat.completions.create({
      model: MODELS.chat,
      messages: [{ role: "user", content: reviewPrompt }],
      max_completion_tokens: 400,
      response_format: { type: "json_object" },
    });

    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
      review_text?: string; what_worked?: string; what_failed?: string; hypothesis?: string;
    };
    reviewText = raw.review_text ?? "";
    whatWorked = raw.what_worked ?? "";
    whatFailed = raw.what_failed ?? "";
    hypothesis = raw.hypothesis ?? "";
  } catch {
    reviewText = `${decision.decision} ${body.outcome}: ${body.note ?? "記録なし"}`;
    hypothesis = body.outcome === "WIN"
      ? "この設定は有効だった可能性がある。継続観察が必要。"
      : "このエントリー条件を再検討する必要がある。";
  }

  // 3. trade_review 作成
  const { data: review, error: reviewErr } = await db
    .from("trade_reviews")
    .insert({
      outcome_id:   outcome!.id,
      ai_trader_id: id,
      user_id:      user.id,
      review_text:  reviewText,
      what_worked:  whatWorked,
      what_failed:  whatFailed,
      hypothesis:   hypothesis,
      confidence:   body.outcome === "WIN" ? 4 : body.outcome === "LOSS" ? 2 : 3,
      validated:    false,
    })
    .select()
    .single();

  if (reviewErr) {
    console.error("[outcome] review insert failed:", reviewErr.message);
  }

  // 4. experience_memory を HYPOTHESIS として登録
  const memoryTitle = `${decision.decision}設定 (${body.outcome}) — ${decision.market} @${exitPrice.toFixed(2)}`;
  const { data: memory } = await db
    .from("experience_memories")
    .insert({
      ai_trader_id:     id,
      user_id:          user.id,
      title:            memoryTitle,
      insight:          hypothesis,
      market_condition: `${decision.decision} at ${entryPrice?.toFixed(2) ?? "?"} → ${exitPrice.toFixed(2)} (${calcPips >= 0 ? "+" : ""}${calcPips.toFixed(1)} pips)`,
      source_review_id: review?.id ?? null,
      status:           "HYPOTHESIS", // 自動で VALIDATED にしない
      confidence:       body.outcome === "WIN" ? 4 : body.outcome === "LOSS" ? 2 : 3,
    })
    .select()
    .single();

  return NextResponse.json({
    ok:            true,
    outcome:       outcome,
    review:        review ?? null,
    memory:        memory ?? null,
    memory_status: "HYPOTHESIS",
    note:          "経験メモリーは HYPOTHESIS として登録されました。Walk Forward検証後に手動でVALIDATEDに昇格させてください。",
  }, { status: 201 });
}

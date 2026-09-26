// =================================================================
// POST /api/traders/[id]/review
//
// ポジションクローズ後の AI 振り返りを生成する。
//
// 呼び出し元:
//   Watcher (handlePositionState) — ポジションクローズ検知後に自動ディスパッチ
//
// フロー:
//   1. ai_positions + trade_decisions + シナリオを取得
//   2. AI に振り返りを依頼（何がうまくいったか・いかなかったか・仮説）
//   3. trade_reviews 保存
//   4. experience_memories (HYPOTHESIS) 作成
//   5. watcher_state を REVIEWING → WATCHING に遷移
//
// SAFETY:
//   - HYPOTHESIS は VALIDATED にしない（手動昇格のみ）
//   - AI はトレーダー設定を自動変更しない
// =================================================================

import { NextRequest, NextResponse }   from "next/server";
import { createAdminClient }            from "@/infrastructure/supabase/admin";
import { createClient }                 from "@/infrastructure/supabase/server";
import { getOpenAIClient, MODELS }      from "@/infrastructure/ai/openai-client";
import { parseTradeReview, type TradeReview } from "@/lib/ai-trader/trade-review-contract";

export const runtime     = "nodejs";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET ?? "";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // ── 認証 ──────────────────────────────────────────────────────
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  const isCron = CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
  const cronUserId = isCron ? (req.headers.get("x-user-id") ?? "") : null;

  if (!user && !isCron) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const effectiveUserId = user?.id ?? cronUserId ?? "";

  const db = createAdminClient();

  const body = await req.json().catch(() => ({})) as {
    position_id?: string;
    outcome?:     string;
    pips?:        number | null;
    profit_usd?:  number;
  };

  if (!body.position_id) {
    return NextResponse.json({ error: "position_id が必要です" }, { status: 400 });
  }

  // ── Trader 取得 ──────────────────────────────────────────────
  const { data: trader } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version")
    .eq("id", id)
    .eq("user_id", effectiveUserId)
    .single();

  if (!trader) {
    return NextResponse.json({ error: "Trader が見つかりません" }, { status: 404 });
  }

  // ── Profile 取得 ─────────────────────────────────────────────
  const { data: profile } = await db
    .from("ai_trader_versions")
    .select("id, trading_style, personality, instructions")
    .eq("ai_trader_id", id)
    .eq("version", trader.current_version)
    .single();

  // ── ai_position 取得 ──────────────────────────────────────────
  const { data: position } = await db
    .from("ai_positions")
    .select("id, user_id, status, side, volume, entry_price, exit_price, stop_loss, take_profit, realized_profit, realized_pips, opened_at, closed_at, duration_seconds, symbol, decision_id, scenario_id, magic_number")
    .eq("id", body.position_id)
    .eq("ai_trader_id", id)
    .eq("user_id", effectiveUserId)
    .single();

  if (!position) {
    return NextResponse.json({ error: "Position が見つかりません" }, { status: 404 });
  }
  if (position.status !== "CLOSED" || !position.closed_at) {
    return NextResponse.json({ error: "CLOSED状態のPositionのみレビューできます" }, { status: 409 });
  }

  // ── trade_outcomes 取得（decision_id 経由）────────────────────
  let outcomeId: string | null = null;
  if (position.decision_id) {
    const { data: outcome } = await db
      .from("trade_outcomes")
      .select("id, outcome, pips, profit_usd, entry_time, exit_time")
      .eq("decision_id", position.decision_id as string)
      .maybeSingle();
    outcomeId = outcome?.id ?? null;

    // review が既にあれば重複作成しない
    if (outcomeId) {
      const { data: existingReview } = await db
        .from("trade_reviews")
        .select("id")
        .eq("outcome_id", outcomeId).eq("user_id", effectiveUserId)
        .maybeSingle();
      if (existingReview) {
        return NextResponse.json({ ok: true, already_reviewed: true, review_id: existingReview.id });
      }
    }
  }

  // ── シナリオ取得 ───────────────────────────────────────────────
  let scenarioText = "";
  if (position.scenario_id) {
    const { data: scenario } = await db
      .from("ai_trader_scenarios")
      .select("scenario_text, bias, market_view")
      .eq("id", position.scenario_id as string)
      .maybeSingle();
    if (scenario) {
      scenarioText = `バイアス: ${scenario.bias}\nシナリオ: ${scenario.scenario_text}`;
    }
  }

  // ── past memories（VALIDATED）を参照 ─────────────────────────
  const { data: memories } = await db
    .from("experience_memories")
    .select("title, insight")
    .eq("ai_trader_id", id)
    .eq("status", "VALIDATED")
    .limit(5);

  // ── AI レビュープロンプト生成 ─────────────────────────────────
  const outcome    = body.outcome ?? ((position.realized_profit as number ?? 0) > 0 ? "WIN" : "LOSS");
  const pips       = body.pips       ?? position.realized_pips as number | null;
  const profitUsd  = body.profit_usd ?? (position.realized_profit as number | null) ?? 0;
  const durationMin = position.duration_seconds
    ? Math.round((position.duration_seconds as number) / 60)
    : null;

  const entryPrice = position.entry_price as number | null;
  const exitPrice  = position.exit_price  as number | null;
  const sl         = position.stop_loss   as number | null;
  const tp         = position.take_profit as number | null;

  const rrAchieved = (sl && tp && entryPrice && exitPrice)
    ? (() => {
        const risk   = Math.abs(entryPrice - sl);
        const reward = Math.abs(exitPrice - entryPrice);
        return risk > 0 ? (reward / risk).toFixed(2) : null;
      })()
    : null;

  const prompt = `あなたは${profile?.trading_style ?? "スウィング"}スタイルの FX AI トレーダーです。
以下の取引結果を振り返り、学びを抽出してください。

## 取引結果
- 方向: ${position.side}
- シンボル: ${position.symbol}
- ロット: ${position.volume}
- エントリー価格: ${entryPrice ?? "不明"}
- クローズ価格: ${exitPrice ?? "不明"}
- SL: ${sl ?? "未設定"}
- TP: ${tp ?? "未設定"}
- 結果: ${outcome} / ${pips != null ? `${pips.toFixed(1)} pips` : "不明"} / $${profitUsd.toFixed(2)}
- 保有時間: ${durationMin != null ? `${durationMin} 分` : "不明"}
- 達成 R:R: ${rrAchieved ?? "不明"}

## エントリー時のシナリオ
${scenarioText || "（シナリオ情報なし）"}

## 過去の検証済み経験
${(memories ?? []).length > 0
  ? (memories ?? []).map((m: { title: string; insight: string }) => `- ${m.title}: ${m.insight}`).join("\n")
  : "（まだ検証済み経験なし）"}

## 振り返り依頼
以下を日本語で回答してください。

1. **what_worked**: うまくいった点（エントリー根拠・SL/TP 設定・タイミング等）
2. **what_failed**: うまくいかなかった点（なぜそうなったか）
3. **review_text**: 総合的な振り返り（2〜4文）
4. **hypothesis**: 今後の仮説（「〜の相場状況で〜した場合、〜する傾向がある」形式・検証可能な命題として）
5. **confidence**: 仮説の確信度（1〜5の整数）

## 重要ルール
- 結果を正当化しない（WIN でも反省点を探す）
- 「次回は〜する」でなく「〜という条件の場合、〜する傾向が観察された」形式の仮説を立てる
- 仮説は具体的・検証可能に（「改善する」「注意する」は仮説ではない）

## 出力形式（JSON）
{
  "what_worked": "...",
  "what_failed": "...",
  "review_text": "...",
  "hypothesis":  "...",
  "confidence":  3
}`;

  // ── AI 呼び出し ────────────────────────────────────────────────
  const client    = getOpenAIClient();
  const aiModel   = process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat;
  let rawText     = "{}";
  let aiError: string | null = null;

  try {
    const completion = await client.chat.completions.create({
      model: aiModel,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "この取引を振り返ってください。" },
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" },
    });
    rawText = completion.choices[0]?.message?.content ?? "{}";
  } catch (e) {
    aiError = e instanceof Error ? e.message : String(e);
  }

  if (aiError) {
    // AI 失敗でも watcher_state は WATCHING に戻す
    await db.from("ai_traders").update({ watcher_state: "WATCHING" }).eq("id", id).eq("user_id", effectiveUserId);
    return NextResponse.json({ error: "AI レビュー生成失敗", detail: aiError }, { status: 503 });
  }

  let review: TradeReview;
  try {
    review = parseTradeReview(JSON.parse(rawText));
  } catch {
    await db.from("ai_traders").update({ watcher_state: "WATCHING" }).eq("id", id).eq("user_id", effectiveUserId);
    return NextResponse.json({ error: "AI 応答の検証に失敗しました。レビューを完了できません" }, { status: 422 });
  }

  // ── trade_reviews 保存 ──────────────────────────────────────────
  let reviewId: string | null = null;
  if (outcomeId) {
    const { data: saved, error: reviewError } = await db.from("trade_reviews").insert({
      outcome_id:   outcomeId,
      ai_trader_id: id,
      user_id:      effectiveUserId,
      review_text:  review.review_text,
      what_worked:  review.what_worked,
      what_failed:  review.what_failed,
      hypothesis:   review.hypothesis,
      confidence:   Math.min(5, Math.max(1, review.confidence ?? 3)),
      validated:    false,  // 自動で VALIDATED にしない
    }).select("id, outcome_id, user_id").single();
    if (reviewError?.code === "23505") {
      const { data: existing } = await db.from("trade_reviews").select("id").eq("outcome_id", outcomeId).eq("user_id", effectiveUserId).maybeSingle();
      if (existing) return NextResponse.json({ ok: true, already_reviewed: true, review_id: existing.id });
    }
    if (reviewError || !saved || saved.outcome_id !== outcomeId || saved.user_id !== effectiveUserId) {
      await db.from("ai_traders").update({ watcher_state: "WATCHING" }).eq("id", id).eq("user_id", effectiveUserId);
      return NextResponse.json({ error: "Trade Reviewの保存を確認できないため完了扱いにしません" }, { status: 503 });
    }
    reviewId = saved?.id ?? null;
  } else {
    await db.from("ai_traders").update({ watcher_state: "WATCHING" }).eq("id", id).eq("user_id", effectiveUserId);
    return NextResponse.json({ error: "Trade Outcomeがないためレビューできません" }, { status: 409 });
  }

  // ── experience_memories（HYPOTHESIS）作成 ────────────────────
  // 仮説段階。VALIDATED への昇格は手動のみ（walk-forward 検証後）。
  let memoryId: string | null = null;
  if (review.hypothesis) {
    const { data: mem } = await db.from("experience_memories").insert({
      ai_trader_id:     id,
      user_id:          effectiveUserId,
      title:            `${outcome === "WIN" ? "WIN" : "LOSS"}: ${position.symbol} ${position.side} @ ${entryPrice ?? "?"} → ${exitPrice ?? "?"}`,
      insight:          review.hypothesis,
      market_condition: scenarioText ? scenarioText.slice(0, 200) : null,
      source_review_id: reviewId ?? null,
      status:           "HYPOTHESIS",  // 自動で VALIDATED にしない
      confidence:       Math.min(5, Math.max(1, review.confidence ?? 3)),
    }).select("id").single();
    memoryId = mem?.id ?? null;
  }

  // ── watcher_state を REVIEWING → WATCHING に遷移 ─────────────
  await db.from("ai_traders").update({
    watcher_state:    "WATCHING",
    last_analysis_at: new Date().toISOString(),
  }).eq("id", id).eq("user_id", effectiveUserId);

  return NextResponse.json({
    ok:          true,
    review_id:   reviewId,
    memory_id:   memoryId,
    outcome,
    review: {
      what_worked: review.what_worked,
      what_failed:  review.what_failed,
      hypothesis:   review.hypothesis,
      confidence:   review.confidence,
    },
  });
}

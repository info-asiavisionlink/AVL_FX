// =================================================================
// POST /api/traders/[id]/decide
//
// trade_decision の承認・却下 → 承認時に execution_command を発行
//
// body: { decision_id, action: "approve" | "reject" }
//
// 安全ルール:
//   - ユーザーが明示的に "approve" しなければ execution しない
//   - strategy_id は ai_trader_versions.strategy_id を使用
//   - strategy_id が null の場合は実行できない（エラー）
//   - 期限切れ decision は実行不可
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { createClient }               from "@/infrastructure/supabase/server";
import { randomUUID }                 from "crypto";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const body = await req.json() as {
    decision_id: string;
    action:      "approve" | "reject";
  };

  if (!body.decision_id || !["approve", "reject"].includes(body.action)) {
    return NextResponse.json({ error: "decision_id と action（approve/reject）が必要です" }, { status: 400 });
  }

  const db = createAdminClient();

  // Decision 取得（所有権確認）
  const { data: decision } = await db
    .from("trade_decisions")
    .select("*")
    .eq("id", body.decision_id)
    .eq("ai_trader_id", id)
    .eq("user_id", user.id)
    .single();

  if (!decision) return NextResponse.json({ error: "決断が見つかりません" }, { status: 404 });
  if (decision.status !== "PENDING") {
    return NextResponse.json({ error: `既に${decision.status}です` }, { status: 409 });
  }
  if (new Date(decision.expires_at) < new Date()) {
    await db.from("trade_decisions").update({ status: "EXPIRED" }).eq("id", decision.id);
    return NextResponse.json({ error: "この判断は期限切れです" }, { status: 410 });
  }

  // 却下
  if (body.action === "reject") {
    await db.from("trade_decisions")
      .update({ status: "REJECTED", decided_at: new Date().toISOString() })
      .eq("id", decision.id);
    return NextResponse.json({ ok: true, status: "REJECTED" });
  }

  // 承認 → execution_command を発行
  // MT5接続確認
  const { data: conn } = await db
    .from("mt5_connections").select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false }).limit(1).single();

  if (!conn) return NextResponse.json({ error: "MT5が接続されていません" }, { status: 503 });

  const ageMs = Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime();
  if (ageMs > 90_000) return NextResponse.json({ error: "MT5がオフラインです" }, { status: 503 });

  // AI Trader Version から strategy_id を取得
  const { data: version } = await db
    .from("ai_trader_versions").select("strategy_id")
    .eq("id", decision.ai_trader_version_id).single();

  if (!version?.strategy_id) {
    return NextResponse.json({
      error: "このAIトレーダーにはMT5実行用のStrategyが設定されていません。管理者にお問い合わせください。",
    }, { status: 422 });
  }

  // strategy の magic_number を取得
  const { data: strategy } = await db
    .from("strategy_registry").select("magic_number")
    .eq("id", version.strategy_id).single();

  if (!strategy?.magic_number) {
    return NextResponse.json({ error: "MagicNumberが設定されていません" }, { status: 422 });
  }

  // execution_command 発行（30分有効）
  const commandId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const { data: command, error: cmdErr } = await db
    .from("execution_commands")
    .insert({
      command_id:      commandId,
      user_id:         user.id,
      connection_id:   conn.id,
      strategy_id:     version.strategy_id,
      magic_number:    strategy.magic_number,
      signal_id:       null,
      action:          decision.decision as string,
      symbol:          decision.symbol as string,
      volume:          decision.suggested_volume ?? 0.01,
      requested_price: decision.reference_price ?? null,
      stop_loss:       decision.suggested_sl ?? null,
      take_profit:     decision.suggested_tp ?? null,
      status:          "PENDING",
      expires_at:      expiresAt,
      metadata:        { ai_trader_id: id, decision_id: decision.id, source: "ai_trader" },
    })
    .select()
    .single();

  if (cmdErr) {
    return NextResponse.json({ error: "注文の発行に失敗しました: " + cmdErr.message }, { status: 500 });
  }

  // Decision を APPROVED に更新
  await db.from("trade_decisions")
    .update({ status: "APPROVED", command_id: command.id, decided_at: new Date().toISOString() })
    .eq("id", decision.id);

  return NextResponse.json({ ok: true, status: "APPROVED", command_id: command.id });
}

// =================================================================
// POST /api/traders/[id]/decide
//
// trade_decision の承認・却下 → 承認時に execution_command を発行
//
// body: { decision_id, action: "approve" | "reject" }
//
// 安全ルール:
//   - ユーザーが明示的に "approve" しなければ execution しない
//   - 人間が承認してもRisk Engineを通す（承認とRisk Validationは別責務）
//   - 期限切れ decision は実行不可
//   - SL必須
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { createClient }               from "@/infrastructure/supabase/server";
import {
  runCommonRiskCheck,
  createEntryExecutionCommand,
} from "@/lib/ai-trader/execution-service";
import { claimPendingDecision, isExecutableManualDecision } from "@/lib/ai-trader/manual-approval";

export const runtime = "nodejs";

const GATEWAY_URL    = process.env.MT5_GATEWAY_URL    ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

async function writeApprovalLog(db: any, input: {
  userId: string; traderId: string; traderVersionId?: string | null;
  scenarioId?: string | null; decisionId: string; connectionId?: string | null;
  decision: string; status: string; commandId?: string | null; error?: string | null;
}) {
  return db.from("ai_analysis_logs").insert({
    user_id: input.userId,
    trader_id: input.traderId,
    ai_trader_version_id: input.traderVersionId ?? null,
    scenario_id: input.scenarioId ?? null,
    command_id: input.commandId ?? null,
    trigger_type: "MANUAL_APPROVAL",
    analysis_type: "MANUAL_APPROVAL",
    decision: input.decision,
    reasoning_summary: `Manual approval ${input.status}`,
    error: input.error ?? null,
    market_context: {
      approval_status: input.status,
      decision_id: input.decisionId,
      connection_id: input.connectionId ?? null,
    },
  }).select("id").single();
}

async function finalizeRejected(db: any, decisionId: string, reason: string) {
  await db.from("trade_decisions")
    .update({ status: "REJECTED", decided_at: new Date().toISOString() })
    .eq("id", decisionId)
    .eq("status", "APPROVED");
  return reason;
}

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
  const { data: loadedDecision } = await db
    .from("trade_decisions")
    .select("*")
    .eq("id", body.decision_id)
    .eq("ai_trader_id", id)
    .eq("user_id", user.id)
    .single();

  if (!loadedDecision) return NextResponse.json({ error: "決断が見つかりません" }, { status: 404 });
  if (loadedDecision.status !== "PENDING") {
    return NextResponse.json({ error: `既に${loadedDecision.status}です`, command_id: loadedDecision.command_id ?? null }, { status: 409 });
  }
  if (new Date(loadedDecision.expires_at) <= new Date()) {
    await db.from("trade_decisions").update({ status: "EXPIRED", decided_at: new Date().toISOString() }).eq("id", loadedDecision.id).eq("status", "PENDING");
    return NextResponse.json({ error: "この判断は期限切れです" }, { status: 410 });
  }

  // The status transition is the single atomic approval claim. Only the
  // request which changes PENDING can continue into Risk/Execution.
  const claimStatus = body.action === "reject" ? "REJECTED" : "APPROVED";
  const { data: claimedDecision, error: claimError } = await claimPendingDecision(db, loadedDecision.id as string, user.id, new Date().toISOString(), claimStatus);
  if (claimError) return NextResponse.json({ error: "承認状態の確定に失敗しました" }, { status: 503 });
  if (!claimedDecision) {
    const { data: current } = await db.from("trade_decisions").select("status,command_id").eq("id", loadedDecision.id).eq("user_id", user.id).maybeSingle();
    return NextResponse.json({ error: `既に${current?.status ?? "処理済み"}です`, command_id: current?.command_id ?? null }, { status: 409 });
  }
  const decision = claimedDecision as any;

  // 却下はclaim済みのterminal stateへ記録し、同じownerの監査ログを残す。
  if (body.action === "reject") {
    const { error: logError } = await writeApprovalLog(db, {
      userId: user.id, traderId: id, traderVersionId: decision.ai_trader_version_id,
      scenarioId: decision.scenario_id, decisionId: decision.id, decision: String(decision.decision), status: "REJECTED",
    });
    if (logError) return NextResponse.json({ error: "却下ログの保存に失敗しました" }, { status: 500 });
    return NextResponse.json({ ok: true, status: "REJECTED" });
  }

  // ── 承認 → Risk Engine → execution_command 発行 ─────────────────

  // Decision は ENTER_LONG / ENTER_SHORT のみ実行可能
  const decisionVal = decision.decision as string;
  if (!isExecutableManualDecision(decisionVal)) {
    await finalizeRejected(db, decision.id, "INVALID_ACTION");
    await writeApprovalLog(db, { userId: user.id, traderId: id, traderVersionId: decision.ai_trader_version_id, scenarioId: decision.scenario_id, decisionId: decision.id, decision: decisionVal, status: "REJECTED", error: "INVALID_ACTION" });
    return NextResponse.json({
      error: `decision=${decisionVal} は実行候補ではありません（ENTER_LONG/ENTER_SHORT のみ）`
    }, { status: 400 });
  }

  // Trader + Profile 取得（所有権確認済み）
  const { data: trader } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version, execution_mode, kill_switch, kill_switch_reason, daily_stats_date, daily_trade_count, daily_loss_usd, daily_consecutive_losses")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!trader) {
    await finalizeRejected(db, decision.id, "TRADER_NOT_FOUND");
    await writeApprovalLog(db, { userId: user.id, traderId: id, traderVersionId: decision.ai_trader_version_id, scenarioId: decision.scenario_id, decisionId: decision.id, decision: decisionVal, status: "REJECTED", error: "TRADER_NOT_FOUND" });
    return NextResponse.json({ error: "Trader が見つかりません" }, { status: 404 });
  }

  const { data: profile } = await db
    .from("ai_trader_versions")
    .select("id, magic_number, max_daily_trades, max_daily_loss_usd, max_consecutive_losses, max_total_exposure_lots, max_risk_per_trade, minimum_rr, max_positions")
    .eq("ai_trader_id", id)
    .eq("version", trader.current_version as number)
    .single();

  if (!profile) {
    await finalizeRejected(db, decision.id, "PROFILE_NOT_FOUND");
    await writeApprovalLog(db, { userId: user.id, traderId: id, traderVersionId: decision.ai_trader_version_id, scenarioId: decision.scenario_id, decisionId: decision.id, decision: decisionVal, status: "REJECTED", error: "PROFILE_NOT_FOUND" });
    return NextResponse.json({ error: "Profile が見つかりません" }, { status: 404 });
  }

  // MT5接続確認
  const { data: conn } = await db
    .from("mt5_connections")
    .select("id")
    .eq("user_id", user.id)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conn) {
    await finalizeRejected(db, decision.id, "CONNECTION_NOT_FOUND");
    await writeApprovalLog(db, { userId: user.id, traderId: id, traderVersionId: profile.id, scenarioId: decision.scenario_id, decisionId: decision.id, decision: decisionVal, status: "REJECTED", error: "CONNECTION_NOT_FOUND" });
    return NextResponse.json({ error: "MT5が接続されていません" }, { status: 503 });
  }

  // Persist the claimed approval before any command can be created. If this
  // audit write fails, fail closed and leave no execution opportunity.
  const { data: approvalLog, error: approvalLogError } = await writeApprovalLog(db, {
    userId: user.id,
    traderId: id,
    traderVersionId: decision.ai_trader_version_id ?? profile?.id ?? null,
    scenarioId: decision.scenario_id,
    decisionId: decision.id,
    connectionId: conn.id as string,
    decision: decisionVal,
    status: "CLAIMED",
  });
  if (approvalLogError || !approvalLog?.id) {
    await finalizeRejected(db, decision.id, "APPROVAL_LOG_FAILED");
    return NextResponse.json({ error: "承認監査ログを保存できないため実行を停止しました" }, { status: 503 });
  }

  // Open positions count
  const { data: openPositions, error: openPositionsError } = await db
    .from("ai_positions")
    .select("volume")
    .eq("ai_trader_id", id)
    .in("status", ["OPEN", "PENDING_OPEN"]);

  const openPositionCount = openPositions?.length ?? 0;
  const totalExposureLots = (openPositions ?? []).reduce(
    (sum: number, p: { volume: number }) => sum + ((p.volume as number) ?? 0), 0
  );

  const symbol = (trader.market as string) === "GOLD" ? "GOLD#" : (trader.market as string);

  // ── Human approval: also requires Risk Engine (AUDIT-P1-04) ─────
  let riskResult;
  try {
    ({ riskResult } = await runCommonRiskCheck({
    trader: {
      id:                       trader.id as string,
      user_id:                  trader.user_id as string,
      execution_mode:           (trader.execution_mode as string) ?? "ANALYSIS_ONLY",
      kill_switch:              (trader.kill_switch as boolean) ?? false,
      kill_switch_reason:       (trader.kill_switch_reason as string | null) ?? null,
      daily_stats_date:         (trader.daily_stats_date as string | null) ?? null,
      daily_trade_count:        (trader.daily_trade_count as number) ?? 0,
      daily_loss_usd:           (trader.daily_loss_usd as number) ?? 0,
      daily_consecutive_losses: (trader.daily_consecutive_losses as number) ?? 0,
    },
    profile: {
      id:                           profile.id as string,
      magic_number:                 profile.magic_number as number | null,
      max_daily_trades:             profile.max_daily_trades as number,
      max_daily_loss_usd:           profile.max_daily_loss_usd as number,
      max_consecutive_losses:       profile.max_consecutive_losses as number,
      max_total_exposure_lots:      profile.max_total_exposure_lots as number,
      account_data_max_age_seconds: 60,
      tick_data_max_age_seconds:    10,
      max_spread_points:            0,
      max_risk_per_trade:           profile.max_risk_per_trade as number,
      minimum_rr:                    profile.minimum_rr as number,
      max_positions:                 profile.max_positions as number,
    },
    connectionId:    conn.id as string,
    symbol,
    decision:        decisionVal as "ENTER_LONG" | "ENTER_SHORT",
    suggestedSl:     (decision.suggested_sl as number | null) ?? null,
    suggestedTp:     (decision.suggested_tp as number | null) ?? null,
    openPositionCount,
    totalExposureLots,
    enforceProfileLimits: true,
    manualApproval: true,
    requireMarginValidation: true,
    positionCountAvailable: !openPositionsError,
    }, db, GATEWAY_URL, GATEWAY_SECRET));
  } catch (error) {
    await finalizeRejected(db, decision.id, "RISK_EXCEPTION");
    await db.from("ai_analysis_logs").update({ decision: decisionVal, error: "RISK_EXCEPTION", market_context: { approval_status: "RISK_REJECTED", decision_id: decision.id, connection_id: conn.id } }).eq("id", approvalLog.id);
    return NextResponse.json({ error: "Risk Engineで検証できないため実行を停止しました" }, { status: 422 });
  }

  if (!riskResult.approved) {
    await finalizeRejected(db, decision.id, riskResult.deniedReason ?? "RISK_REJECTED");
    await db.from("ai_analysis_logs").update({ decision: decisionVal, error: riskResult.deniedReason ?? "RISK_REJECTED", market_context: { approval_status: "RISK_REJECTED", decision_id: decision.id, connection_id: conn.id } }).eq("id", approvalLog.id);

    return NextResponse.json({
      ok:            false,
      status:        "REJECTED_BY_RISK_ENGINE",
      denied_reason: riskResult.deniedReason,
    }, { status: 422 });
  }

  // Magic number
  let magicNumber = profile.magic_number as number | null;
  if (!magicNumber) {
    magicNumber = 900001 + Math.floor(Math.random() * 99998);
    await db.from("ai_trader_versions").update({ magic_number: magicNumber }).eq("id", profile.id);
  }

  // Create execution command via common service
  let commandResult: { commandDbId: string; commandId: string };
  try {
    commandResult = await createEntryExecutionCommand({
      userId:       user.id,
      connectionId: conn.id as string,
      symbol,
      riskResult,
      magicNumber,
      aiTraderId:   id,
      decisionId:   decision.id as string,
      idempotencyKey: `manual_approval:${decision.id}`,
      metadata:     {
        source: "manual_approve",
        ai_decision: decisionVal,
        trader_version_id: decision.ai_trader_version_id ?? profile.id,
        scenario_id: decision.scenario_id ?? null,
      },
    }, db);
  } catch (e) {
    await finalizeRejected(db, decision.id, "COMMAND_CREATION_FAILED");
    await db.from("ai_analysis_logs").update({ decision: decisionVal, error: "COMMAND_CREATION_FAILED", market_context: { approval_status: "COMMAND_CREATION_FAILED", decision_id: decision.id, connection_id: conn.id } }).eq("id", approvalLog.id);
    return NextResponse.json({ error: "注文の発行に失敗しました: " + (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }

  // Decision を APPROVED に更新
  const { error: correlationError } = await db.from("trade_decisions")
    .update({ status: "APPROVED", command_id: commandResult.commandDbId, decided_at: new Date().toISOString() })
    .eq("id", decision.id)
    .eq("status", "APPROVED")
    .select("id")
    .single();
  if (correlationError) {
    await db.from("ai_analysis_logs").update({ error: "DECISION_COMMAND_CORRELATION_FAILED", market_context: { approval_status: "CORRELATION_FAILED", decision_id: decision.id, connection_id: conn.id, command_id: commandResult.commandDbId } }).eq("id", approvalLog.id);
    return NextResponse.json({ error: "承認と注文の相関保存に失敗しました" }, { status: 500 });
  }

  const { error: finalLogError } = await db.from("ai_analysis_logs").update({
    decision: decisionVal,
    command_id: commandResult.commandDbId,
    reasoning_summary: "Manual approval accepted; execution command created",
    market_context: { approval_status: "COMMAND_CREATED", decision_id: decision.id, connection_id: conn.id, command_id: commandResult.commandDbId },
  }).eq("id", approvalLog.id);
  if (finalLogError) {
    return NextResponse.json({ error: "承認ログの完了処理に失敗しました", command_id: commandResult.commandDbId }, { status: 500 });
  }

  return NextResponse.json({
    ok:         true,
    status:     "APPROVED",
    command_id: commandResult.commandDbId,
    lot:        riskResult.lot,
    side:       riskResult.side,
    stop_loss:  riskResult.stopLoss,
    take_profit: riskResult.takeProfit,
  });
}

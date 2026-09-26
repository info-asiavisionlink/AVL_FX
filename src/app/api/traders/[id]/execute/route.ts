// =================================================================
// POST /api/traders/[id]/execute
//
// AI Decision → Risk Engine → Demo MT5 Execution
//
// フロー:
//   1.  Decision 取得・有効期限確認
//   2.  Live Quote (tick) 取得
//   3.  Account Snapshot (mt5_connections から) 取得
//   4.  Symbol Spec (DB から) 取得
//   5.  Risk Engine 実行（16 チェック）
//   6.  approved → PENDING_OPEN ai_positions + execution_command 発行
//   7.  denied   → Decision REJECTED
//
// SAFETY (Fail Closed):
//   - DEMO_AUTONOMOUS 以外は実行しない
//   - DEMO MT5 以外は実行しない
//   - Account Snapshot なし/古い → NO TRADE
//   - Symbol Spec なし → NO TRADE
//   - Tick なし/古い → NO TRADE
//   - 異常 Spread → NO TRADE
//   - demo_execution_enabled=false → NO TRADE（グローバル Kill Switch）
//   - このルートは直接注文しない（execution_commands を作成するだけ）
//   - Bridge EA が execution_commands をポーリングして MT5 に注文する
//
// Decision Idempotency:
//   - ai_positions (decision_id) に UNIQUE INDEX あり（ERROR/CLOSED を除く）
//   - 同一 decision_id から複数 Position を作成できない（DB レベル保証）
// =================================================================

import { NextRequest, NextResponse }   from "next/server";
import { createAdminClient }            from "@/infrastructure/supabase/admin";
import { createClient }                 from "@/infrastructure/supabase/server";
import { runRiskEngine,
         type RiskEngineAccountSnapshot,
         type RiskEngineSymbolSpec,
         type RiskEngineLiveQuote }     from "@/lib/ai-trader/risk-engine";
import { createEntryExecutionCommand, runCommonRiskCheck }  from "@/lib/ai-trader/execution-service";
import { validateBarsForEntry, type Bar } from "@/lib/ai-trader/market-data-validator";

export const runtime     = "nodejs";
export const maxDuration = 30;

const CRON_SECRET    = process.env.CRON_SECRET    ?? "";
const GATEWAY_URL    = process.env.MT5_GATEWAY_URL    ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

// ─────────────────────────────────────────────────────────────────

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

  // ── リクエストボディ ──────────────────────────────────────────
  const body = await req.json().catch(() => ({})) as {
    decision_id?:  string;
    trigger_type?: string;
  };

  if (!body.decision_id) {
    return NextResponse.json({ error: "decision_id が必要です" }, { status: 400 });
  }

  // ── Trader 取得 ──────────────────────────────────────────────
  const { data: trader } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version, execution_mode, kill_switch, kill_switch_reason, daily_stats_date, daily_trade_count, daily_loss_usd, daily_consecutive_losses, watcher_state")
    .eq("id", id)
    .eq("user_id", effectiveUserId)
    .single();

  if (!trader) {
    return NextResponse.json({ error: "Trader が見つかりません" }, { status: 404 });
  }

  // ── Profile 取得 ──────────────────────────────────────────────
  const { data: profile } = await db
    .from("ai_trader_versions")
    .select("id, magic_number, max_daily_trades, max_daily_loss_usd, max_consecutive_losses, max_total_exposure_lots, market_data_max_age_seconds, max_risk_per_trade, minimum_rr, max_positions, timeframes")
    .eq("ai_trader_id", id)
    .eq("version", trader.current_version as number)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "Profile が見つかりません" }, { status: 404 });
  }

  // ── Trade Decision 取得 ──────────────────────────────────────
  const { data: decision } = await db
    .from("trade_decisions")
    .select("id, decision, reference_price, suggested_sl, suggested_tp, suggested_volume, status, expires_at, scenario_id, reasoning")
    .eq("id", body.decision_id)
    .eq("ai_trader_id", id)
    .single();

  if (!decision) {
    return NextResponse.json({ error: "Decision が見つかりません" }, { status: 404 });
  }

  // Decision 有効性チェック
  if ((decision.status as string) !== "PENDING") {
    return NextResponse.json({ error: `Decision は既に ${decision.status} です`, decision_status: decision.status }, { status: 409 });
  }
  if (new Date(decision.expires_at as string) < new Date()) {
    await db.from("trade_decisions").update({ status: "EXPIRED" }).eq("id", decision.id);
    return NextResponse.json({ error: "Decision が期限切れです", decision_status: "EXPIRED" }, { status: 410 });
  }
  if (decision.decision !== "ENTER_LONG" && decision.decision !== "ENTER_SHORT") {
    return NextResponse.json({ error: `decision=${decision.decision} は実行候補ではありません（ENTER_LONG/ENTER_SHORT のみ）` }, { status: 400 });
  }

  // ── Decision Idempotency チェック ────────────────────────────
  // 同一 decision_id に PENDING_OPEN / OPEN のポジションが存在しないか確認
  const { data: existingPos } = await db
    .from("ai_positions")
    .select("id, status")
    .eq("decision_id", decision.id as string)
    .in("status", ["PENDING_OPEN", "OPEN"])
    .limit(1)
    .maybeSingle();

  if (existingPos) {
    return NextResponse.json({
      ok: true,
      already_executing: true,
      position_id: existingPos.id,
      message:     "この Decision は既に実行中です（Idempotency）",
    }, { status: 200 });
  }

  // ── MT5 接続取得 ─────────────────────────────────────────────
  const { data: conn } = await db
    .from("mt5_connections")
    .select("id, account_type, account_mode, balance, equity, margin, free_margin, account_balance_updated_at, account_max_age_seconds, last_heartbeat_at")
    .eq("user_id", effectiveUserId)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── Account Snapshot 構築 ─────────────────────────────────────
  let accountSnapshot: RiskEngineAccountSnapshot | null = null;
  if (conn) {
    const updatedAt = conn.account_balance_updated_at ?? conn.last_heartbeat_at;
    accountSnapshot = {
      connectionId:  conn.id,
      accountType:   (conn.account_type as string) ?? "REAL",
      accountMode:   (conn.account_mode  as string) ?? "NETTING",
      balance:       (conn.balance      as number) ?? 0,
      equity:        (conn.equity       as number) ?? 0,
      freeMargin:    (conn.free_margin  as number) ?? 0,
      margin:        (conn.margin       as number) ?? 0,
      currency:      "USD",
      updatedAtMs:   updatedAt ? new Date(updatedAt as string).getTime() : 0,
    };
  }

  // ── Symbol Spec 取得 ─────────────────────────────────────────
  const symbol = (trader.market as string) === "GOLD" ? "GOLD#" : (trader.market as string);
  const canonicalSymbol = (trader.market as string).toUpperCase();

  let symbolSpec: RiskEngineSymbolSpec | null = null;
  if (conn) {
    const { data: spec } = await db
      .from("symbol_specs")
      .select("contract_size, tick_size, tick_value, volume_min, volume_max, volume_step, stops_level_price, digits, margin_initial, max_spread_allowed")
      .eq("connection_id", conn.id)
      .or(`symbol.eq.${canonicalSymbol},broker_symbol.eq.${symbol}`)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (spec) {
      symbolSpec = {
        contractSize:     (spec.contract_size  as number) ?? 0,
        tickSize:         (spec.tick_size       as number) ?? 0,
        tickValue:        (spec.tick_value      as number) ?? 0,
        volumeMin:        (spec.volume_min      as number) ?? 0.01,
        volumeMax:        (spec.volume_max      as number) ?? 100,
        volumeStep:       (spec.volume_step     as number) ?? 0.01,
        stopsLevelPrice:  (spec.stops_level_price as number) ?? 0,
        digits:           (spec.digits          as number) ?? 2,
        marginInitial:    (spec.margin_initial   as number) ?? 0,
        maxSpreadAllowed: (spec.max_spread_allowed as number) ?? 50,
      };
    }
  }

  // ── Live Tick 取得（Execution Freshness） ─────────────────────
  let liveQuote: RiskEngineLiveQuote | null = null;
  if (GATEWAY_URL && conn) {
    try {
      const tickRes = await fetch(
        `${GATEWAY_URL}/connections/${conn.id}/tick/${encodeURIComponent(symbol)}`,
        { headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, "x-internal-service-auth": GATEWAY_SECRET, "x-connection-id": conn.id as string }, signal: AbortSignal.timeout(4_000) }
      );
      if (tickRes.ok) {
        const tick = await tickRes.json() as { bid?: number; ask?: number; spread?: number; time?: number };
        // P0-02: tick.time missing = FAIL CLOSED. Do NOT substitute Date.now().
        // An unknown timestamp = STALE/INVALID. liveQuote stays null → Risk Engine DENY.
        if (tick.bid && tick.ask && tick.time && Number.isFinite(tick.time) && tick.time > 0) {
          liveQuote = {
            bid:         tick.bid,
            ask:         tick.ask,
            spread:      tick.spread ?? (tick.ask - tick.bid),
            timestampMs: tick.time * 1000,
          };
        }
      }
    } catch { /* Fail Closed: liveQuote stays null → Risk Engine will DENY */ }
  }

  // Final market-context check immediately before Risk/Execution.  Analysis
  // freshness is not reused: a stale or malformed bar set produces no command.
  let finalBars: Bar[] | undefined;
  if (GATEWAY_URL && conn) {
    try {
      const barsRes = await fetch(
        `${GATEWAY_URL}/connections/${conn.id}/bars/${encodeURIComponent(symbol)}/M5?count=100`,
        { headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, "x-internal-service-auth": GATEWAY_SECRET, "x-connection-id": conn.id as string }, signal: AbortSignal.timeout(4_000) },
      );
      if (barsRes.ok) finalBars = await barsRes.json() as Bar[];
    } catch { /* validator below fails closed when bars are unavailable */ }
  }
  const finalBarsCheck = validateBarsForEntry(finalBars ?? [], "M5", 5);
  if (!finalBarsCheck.valid) {
    await db.from("trade_decisions").update({ status: "REJECTED", decided_at: new Date().toISOString() }).eq("id", decision.id);
    return NextResponse.json({ ok: false, status: "REJECTED", reason: finalBarsCheck.reason }, { status: 409 });
  }

  // ── 現在の OPEN + PENDING_OPEN ポジション確認 ─────────────────
  const { data: openPositions, error: openPositionsError } = await db
    .from("ai_positions")
    .select("volume")
    .eq("ai_trader_id", id)
    .in("status", ["OPEN", "PENDING_OPEN"]);

  const openPositionCount = openPositions?.length ?? 0;
  const totalExposureLots = (openPositions ?? []).reduce(
    (sum: number, p: { volume: number }) => sum + ((p.volume as number) ?? 0), 0
  );

  // ── Profile のカラムを Risk Engine 用にマッピング ─────────────
  // market_data_max_age_seconds は M5 bar 用。
  // Phase 3.5 では account/tick 別々の鮮度上限を使う。
  const profileForRisk = {
    id:                           profile.id as string,
    magic_number:                 (profile.magic_number as number | null),
    max_daily_trades:             profile.max_daily_trades as number,
    max_daily_loss_usd:           profile.max_daily_loss_usd as number,
    max_consecutive_losses:       profile.max_consecutive_losses as number,
    max_total_exposure_lots:      profile.max_total_exposure_lots as number,
    account_data_max_age_seconds: 60,   // account snapshot 1分以内
    tick_data_max_age_seconds:    10,   // live tick 10秒以内
    max_spread_points:            0,    // 0 = symbol_specs.max_spread_allowed を使用
    max_risk_per_trade:           profile.max_risk_per_trade as number,
    minimum_rr:                    profile.minimum_rr as number,
    max_positions:                 profile.max_positions as number,
  };

  // ── Risk Engine 実行 ──────────────────────────────────────────
  const { riskResult } = await runCommonRiskCheck({
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
    profile:         profileForRisk,
    connectionId:   conn?.id as string ?? "",
    symbol,
    decision:        decision.decision as "ENTER_LONG" | "ENTER_SHORT",
      suggestedSl: (decision.suggested_sl as number | null) ?? null,
      suggestedTp: (decision.suggested_tp as number | null) ?? null,
    openPositionCount,
    totalExposureLots,
    marketBars: finalBars,
    marketTimeframe: "M5",
    enforceProfileLimits: true,
    requireMarginValidation: true,
    positionCountAvailable: !openPositionsError,
  }, db, GATEWAY_URL, GATEWAY_SECRET);

  // ── Risk Engine 拒否 ──────────────────────────────────────────
  if (!riskResult.approved) {
    await db.from("trade_decisions").update({
      status:     "REJECTED",
      decided_at: new Date().toISOString(),
    }).eq("id", decision.id);

    // watcher_state を WATCHING に戻す（EXECUTING を解除）
    await db.from("ai_traders").update({ watcher_state: "WATCHING" }).eq("id", id);

    return NextResponse.json({
      ok:            false,
      approved:      false,
      denied_reason: riskResult.deniedReason,
      calc:          riskResult.calc,
    });
  }

  // ── Magic Number 確保 ─────────────────────────────────────────
  // Phase 3 AI Trader 専用レンジ: 900001〜999999
  // EA の Validate_Volume と同じレンジを使う
  let magicNumber = profileForRisk.magic_number;
  if (!magicNumber) {
    // 900001〜999999 で既存と重複しない番号を割り当て
    // （割り当てはランダムだが UNIQUE 制約により衝突時は DB エラー）
    magicNumber = 900001 + Math.floor(Math.random() * 99998);
    await db.from("ai_trader_versions").update({
      magic_number: magicNumber,
    }).eq("id", profile.id);
  }

  // ── 日次リセット ──────────────────────────────────────────────
  if (riskResult.dailyReset) {
    const todayStr = new Date().toISOString().slice(0, 10);
    await db.from("ai_traders").update({
      daily_stats_date:         todayStr,
      daily_trade_count:        0,
      daily_loss_usd:           0,
      daily_consecutive_losses: 0,
    }).eq("id", id);
  }

  // ── watcher_state を EXECUTING に更新 ─────────────────────────
  await db.from("ai_traders").update({ watcher_state: "EXECUTING" }).eq("id", id);

  // ── ai_positions 作成（PENDING_OPEN）─────────────────────────
  // MT5 約定前は PENDING_OPEN で管理する。
  // Watcher が execution_command FILLED → OPEN に更新する。
  const { data: aiPosition, error: posErr } = await db
    .from("ai_positions")
    .insert({
      ai_trader_id:         id,
      ai_trader_version_id: profile.id,
      user_id:              effectiveUserId,
      connection_id:        conn?.id ?? null,
      scenario_id:          (decision.scenario_id as string | null) ?? null,
      decision_id:          decision.id,
      magic_number:         magicNumber,
      symbol,
      side:                 riskResult.side,
      volume:               riskResult.lot,
      stop_loss:            riskResult.stopLoss,
      take_profit:          riskResult.takeProfit,
      entry_price:          null,        // 約定後に更新
      status:               "PENDING_OPEN",
      opened_at:            null,        // 約定後に更新
    })
    .select("id")
    .single();

  if (posErr || !aiPosition) {
    // UNIQUE INDEX 違反（同じ decision_id が既に存在）の場合も安全に扱う
    const isDuplicate = posErr?.message?.includes("duplicate") || posErr?.message?.includes("unique");
    if (isDuplicate) {
      await db.from("ai_traders").update({ watcher_state: "POSITION" }).eq("id", id);
      return NextResponse.json({ ok: true, already_executing: true, message: "Idempotency: 既存 Position あり" });
    }
    await db.from("ai_traders").update({ watcher_state: "ERROR" }).eq("id", id);
    return NextResponse.json({ error: `ai_positions 作成失敗: ${posErr?.message}` }, { status: 500 });
  }

  // ── execution_command 発行 ────────────────────────────────────
  if (!conn) {
    await db.from("ai_positions").update({ status: "ERROR" }).eq("id", aiPosition.id);
    await db.from("ai_traders").update({ watcher_state: "ERROR" }).eq("id", id);
    return NextResponse.json({ error: "MT5 接続なし（内部エラー）" }, { status: 500 });
  }

  let command: { commandDbId: string; commandId: string };
  try {
    command = await createEntryExecutionCommand({
      userId: effectiveUserId,
      connectionId: conn.id,
      symbol,
      riskResult,
      magicNumber,
      aiTraderId: id,
      aiPositionId: aiPosition.id,
      decisionId: decision.id as string,
      metadata: {
        ai_decision: decision.decision,
        trigger_type: body.trigger_type ?? null,
        account_equity: accountSnapshot?.equity ?? 0,
        spread: liveQuote?.spread ?? 0,
      },
    }, db);
  } catch (e) {
    // ロールバック: ai_positions を ERROR に更新
    await db.from("ai_positions").update({ status: "ERROR" }).eq("id", aiPosition.id);
    await db.from("ai_traders").update({ watcher_state: "ERROR" }).eq("id", id);
    return NextResponse.json({ error: `execution_command 作成失敗: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }

  // ai_positions に execution_command_id を紐付け
  await db.from("ai_positions").update({
    execution_command_id: command.commandDbId,
  }).eq("id", aiPosition.id);

  // ── Decision を APPROVED に更新 ──────────────────────────────
  await db.from("trade_decisions").update({
    status:     "APPROVED",
    command_id: command.commandDbId,
    decided_at: new Date().toISOString(),
  }).eq("id", decision.id);

  // ── daily_trade_count インクリメント ──────────────────────────
  const currentCount = (trader.daily_trade_count as number) ?? 0;
  await db.from("ai_traders").update({
    daily_trade_count: currentCount + 1,
    watcher_state:     "POSITION",
    last_analysis_at:  new Date().toISOString(),
  }).eq("id", id);

  return NextResponse.json({
    ok:           true,
    approved:     true,
    position_id:  aiPosition.id,
    command_id:   command.commandId,
    magic_number: magicNumber,
    lot:          riskResult.lot,
    side:         riskResult.side,
    entry_price:  riskResult.entryPrice,
    stop_loss:    riskResult.stopLoss,
    take_profit:  riskResult.takeProfit,
    expires_at:   riskResult.expiresAt,
    calc:         riskResult.calc,
  });
}

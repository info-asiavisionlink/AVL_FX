// =================================================================
// POST /api/traders/[id]/dry-run
//
// EXECUTION_DRY_RUN — 実データで Risk Engine 全チェックを検証する。
//
// フロー:
//   1. 実 Account Snapshot (mt5_connections) を取得
//   2. 実 Symbol Spec (symbol_specs) を取得
//   3. 実 Live Tick (Gateway) を取得
//   4. Override データが提供されていればそれを優先（テストハーネス用）
//   5. Risk Engine を実行（skipGlobalKillSwitch=true）
//   6. 結果を dry_run_logs に保存
//   7. execution_commands は 絶対に作成しない
//
// SAFETY GUARANTEE:
//   - execution_commands を PENDING で INSERT しない
//   - ai_positions を作成しない
//   - MT5 への注文は 0 件
//   - demo_execution_enabled は変更しない（false のまま）
//   - Kill Switch を迂回するが、実注文パスには接続されない
// =================================================================

import { NextRequest, NextResponse }   from "next/server";
import { createAdminClient }            from "@/infrastructure/supabase/admin";
import { createClient }                 from "@/infrastructure/supabase/server";
import { runRiskEngine,
         type RiskEngineAccountSnapshot,
         type RiskEngineSymbolSpec,
         type RiskEngineLiveQuote }     from "@/lib/ai-trader/risk-engine";

export const runtime     = "nodejs";
export const maxDuration = 30;

const CRON_SECRET    = process.env.CRON_SECRET    ?? "";
const GATEWAY_URL    = process.env.MT5_GATEWAY_URL    ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

// ── テスト用 XM GOLD デフォルト仕様 ────────────────────────────
// Bridge EA が未接続の場合のフォールバック（calculation logic の検証用）。
// 実 MT5 接続後は実データで上書きされる。
const XM_GOLD_DEFAULT_SPEC: RiskEngineSymbolSpec = {
  contractSize:     100,     // 100 oz
  tickSize:         0.01,    // $0.01 per oz
  tickValue:        1.00,    // $1.00 per lot per tick (100oz × $0.01)
  volumeMin:        0.01,
  volumeMax:        50.00,
  volumeStep:       0.01,
  stopsLevelPrice:  0.10,    // 10 points minimum stop distance
  digits:           2,
  marginInitial:    0,       // XM は leverage-based、marginInitial は未使用
  maxSpreadAllowed: 50,      // 50 points (= $0.50)
};

// ── 型定義 ────────────────────────────────────────────────────────

interface DryRunRequest {
  // テストケース識別ラベル
  test_label?: string;

  // Override: 実データがない場合はこちらを使用（テストハーネス用）
  override_account?: {
    account_type?: string;
    account_mode?: string;
    equity?:       number;
    balance?:      number;
    free_margin?:  number;
  };
  override_spec?: Partial<RiskEngineSymbolSpec & { broker_symbol?: string }>;
  override_tick?: {
    bid?:          number;
    ask?:          number;
    spread?:       number;  // in points
  };

  // Decision: テストケースとして注入
  side:            "BUY" | "SELL";
  entry_price?:    number;  // null → live ask/bid
  stop_loss:       number;
  take_profit:     number;

  // 現在の OPEN ポジション数（テスト用 override）
  override_open_positions?: number;
}

export interface DryRunResult {
  test_label:         string;
  approved:           boolean;
  denied_reason?:     string;
  mt5_orders_sent:    0;  // 常に 0

  // Source of data
  data_source: {
    account:    "live" | "override" | "missing";
    symbol_spec: "live" | "default" | "override" | "missing";
    tick:       "live" | "override" | "missing";
  };

  // Input
  side:               string;
  entry_price:        number | null;
  stop_loss:          number;
  take_profit:        number;

  // Account
  account_type?:      string;
  account_mode?:      string;
  equity?:            number;
  balance?:           number;
  free_margin?:       number;
  account_age_sec?:   number;

  // Symbol Spec
  broker_symbol?:     string;
  tick_size?:         number;
  tick_value?:        number;
  contract_size?:     number;
  volume_min?:        number;
  volume_max?:        number;
  volume_step?:       number;
  stops_level_price?: number;
  digits?:            number;

  // Tick
  bid?:               number;
  ask?:               number;
  spread_points?:     number;
  tick_age_sec?:      number;

  // Risk Calculation
  calc?:              {
    riskUsd:        number;
    slDistance:     number;
    ticksAtRisk:    number;
    lossPerLot:     number;
    rawLot:         number;
    normalizedLot:  number;
    requiredMargin: number;
    expectedMaxLoss: number;
  };

  log_id?: string;
}

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

  const body = await req.json().catch(() => ({})) as DryRunRequest;

  if (!body.side || !body.stop_loss) {
    return NextResponse.json({ error: "side と stop_loss が必要です" }, { status: 400 });
  }

  // ── Trader 取得 ──────────────────────────────────────────────
  // Cron 認証済み（x-cron-secret）の場合は user_id フィルタ不要
  const traderQuery = db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version, execution_mode, kill_switch, kill_switch_reason, daily_stats_date, daily_trade_count, daily_loss_usd, daily_consecutive_losses, watcher_state")
    .eq("id", id);

  // ユーザーセッションがある場合のみ user_id フィルタを適用
  if (user) {
    traderQuery.eq("user_id", user.id);
  }

  const { data: trader } = await traderQuery.single();

  if (!trader) {
    return NextResponse.json({ error: "Trader が見つかりません" }, { status: 404 });
  }

  // ── Profile 取得 ──────────────────────────────────────────────
  const { data: profile } = await db
    .from("ai_trader_versions")
    .select("id, magic_number, max_daily_trades, max_daily_loss_usd, max_consecutive_losses, max_total_exposure_lots, market_data_max_age_seconds, max_risk_per_trade")
    .eq("ai_trader_id", id)
    .eq("version", trader.current_version as number)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "Profile が見つかりません" }, { status: 404 });
  }

  const symbol         = (trader.market as string) === "GOLD" ? "GOLD#" : (trader.market as string);
  const canonicalSymbol = (trader.market as string).toUpperCase();

  // ── 1. Account Snapshot ──────────────────────────────────────
  let accountSnapshot: RiskEngineAccountSnapshot | null = null;
  let accountSource: "live" | "override" | "missing" = "missing";

  const { data: conn } = await db
    .from("mt5_connections")
    .select("id, account_type, account_mode, balance, equity, margin, free_margin, account_balance_updated_at, last_heartbeat_at")
    .eq("user_id", effectiveUserId)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conn) {
    const updatedAt = conn.account_balance_updated_at ?? conn.last_heartbeat_at;
    const updatedMs = updatedAt ? new Date(updatedAt as string).getTime() : 0;
    const liveBalance = (conn.equity as number) ?? 0;

    if (liveBalance > 0) {
      accountSnapshot = {
        connectionId:  conn.id,
        accountType:   (conn.account_type as string) ?? "REAL",
        accountMode:   (conn.account_mode  as string) ?? "NETTING",
        balance:       (conn.balance      as number) ?? 0,
        equity:        liveBalance,
        freeMargin:    (conn.free_margin  as number) ?? 0,
        margin:        (conn.margin       as number) ?? 0,
        currency:      "USD",
        updatedAtMs:   updatedMs,
      };
      accountSource = "live";
    }
  }

  // Override で上書き
  if (body.override_account) {
    const ov = body.override_account;
    accountSnapshot = {
      connectionId:  conn?.id ?? "override",
      accountType:   ov.account_type ?? "DEMO",
      accountMode:   ov.account_mode ?? "HEDGING",
      balance:       ov.balance      ?? ov.equity ?? 10000,
      equity:        ov.equity       ?? ov.balance ?? 10000,
      freeMargin:    ov.free_margin  ?? ov.equity  ?? 10000,
      margin:        0,
      currency:      "USD",
      updatedAtMs:   Date.now(),
    };
    accountSource = "override";
  }

  // ── 2. Symbol Spec ───────────────────────────────────────────
  let symbolSpec: RiskEngineSymbolSpec | null = null;
  let brokerSymbol = symbol;
  let specSource: "live" | "default" | "override" | "missing" = "missing";

  if (conn) {
    const { data: spec } = await db
      .from("symbol_specs")
      .select("broker_symbol, contract_size, tick_size, tick_value, volume_min, volume_max, volume_step, stops_level_price, digits, margin_initial, max_spread_allowed")
      .eq("connection_id", conn.id)
      .or(`symbol.eq.${canonicalSymbol},broker_symbol.eq.${symbol}`)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (spec && (spec.tick_value as number) > 0) {
      brokerSymbol  = (spec.broker_symbol as string) ?? symbol;
      symbolSpec = {
        contractSize:     (spec.contract_size    as number) ?? 0,
        tickSize:         (spec.tick_size         as number) ?? 0,
        tickValue:        (spec.tick_value        as number) ?? 0,
        volumeMin:        (spec.volume_min        as number) ?? 0.01,
        volumeMax:        (spec.volume_max        as number) ?? 100,
        volumeStep:       (spec.volume_step       as number) ?? 0.01,
        stopsLevelPrice:  (spec.stops_level_price as number) ?? 0,
        digits:           (spec.digits            as number) ?? 2,
        marginInitial:    (spec.margin_initial     as number) ?? 0,
        maxSpreadAllowed: (spec.max_spread_allowed as number) ?? 50,
      };
      specSource = "live";
    }
  }

  // Override
  if (body.override_spec) {
    const ov = body.override_spec;
    brokerSymbol  = ov.broker_symbol ?? symbol;
    symbolSpec = {
      contractSize:     ov.contractSize     ?? XM_GOLD_DEFAULT_SPEC.contractSize,
      tickSize:         ov.tickSize         ?? XM_GOLD_DEFAULT_SPEC.tickSize,
      tickValue:        ov.tickValue        ?? XM_GOLD_DEFAULT_SPEC.tickValue,
      volumeMin:        ov.volumeMin        ?? XM_GOLD_DEFAULT_SPEC.volumeMin,
      volumeMax:        ov.volumeMax        ?? XM_GOLD_DEFAULT_SPEC.volumeMax,
      volumeStep:       ov.volumeStep       ?? XM_GOLD_DEFAULT_SPEC.volumeStep,
      stopsLevelPrice:  ov.stopsLevelPrice  ?? XM_GOLD_DEFAULT_SPEC.stopsLevelPrice,
      digits:           ov.digits           ?? XM_GOLD_DEFAULT_SPEC.digits,
      marginInitial:    ov.marginInitial    ?? XM_GOLD_DEFAULT_SPEC.marginInitial,
      maxSpreadAllowed: ov.maxSpreadAllowed ?? XM_GOLD_DEFAULT_SPEC.maxSpreadAllowed,
    };
    specSource = "override";
  }

  // Live spec がなく override もなければ XM default を使用
  if (!symbolSpec) {
    symbolSpec = { ...XM_GOLD_DEFAULT_SPEC };
    specSource = "default";
  }

  // ── 3. Live Tick ──────────────────────────────────────────────
  let liveQuote: RiskEngineLiveQuote | null = null;
  let tickSource: "live" | "override" | "missing" = "missing";

  if (GATEWAY_URL && conn) {
    try {
      const tickRes = await fetch(
        `${GATEWAY_URL}/connections/${conn.id}/tick/${encodeURIComponent(symbol)}`,
        { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, signal: AbortSignal.timeout(4_000) }
      );
      if (tickRes.ok) {
        const tick = await tickRes.json() as { bid?: number; ask?: number; spread?: number; time?: number };
        if (tick.bid && tick.ask) {
          liveQuote = {
            bid:         tick.bid,
            ask:         tick.ask,
            spread:      tick.spread ?? 0,
            timestampMs: tick.time ? tick.time * 1000 : Date.now(),
          };
          tickSource = "live";
        }
      }
    } catch { /* best-effort */ }
  }

  // Override
  if (body.override_tick) {
    const ov = body.override_tick;
    const entryPrice = body.entry_price ?? (body.side === "BUY" ? (ov.ask ?? 2000) : (ov.bid ?? 2000));
    const spread     = ov.spread ?? 20;
    liveQuote = {
      bid:         ov.bid ?? (entryPrice - spread * (symbolSpec.tickSize ?? 0.01)),
      ask:         ov.ask ?? (entryPrice + spread * (symbolSpec.tickSize ?? 0.01)),
      spread:      spread,
      timestampMs: Date.now(),
    };
    tickSource = "override";
  }

  // Tick がない場合、entry_price から bid/ask を推定してテスト継続
  if (!liveQuote && body.entry_price) {
    liveQuote = {
      bid:         body.entry_price - 0.20,
      ask:         body.entry_price + 0.20,
      spread:      20,
      timestampMs: Date.now() - 5000,  // 5秒前（stale 検知のテスト）
    };
    tickSource = "missing";
  }

  // ── 4. OPEN ポジション数 ──────────────────────────────────────
  let openPositionCount = body.override_open_positions ?? 0;
  let totalExposureLots = 0;
  if (!body.override_open_positions) {
    const { data: openPos } = await db
      .from("ai_positions")
      .select("volume")
      .eq("ai_trader_id", id)
      .in("status", ["OPEN", "PENDING_OPEN"]);
    openPositionCount = openPos?.length ?? 0;
    totalExposureLots = (openPos ?? []).reduce((s: number, p: { volume: number }) => s + ((p.volume as number) ?? 0), 0);
  }

  // ── 5. Risk Engine 実行（Dry Run: skipGlobalKillSwitch=true）──
  const riskResult = await runRiskEngine({
    trader: {
      id:                       trader.id as string,
      user_id:                  trader.user_id as string,
      execution_mode:           "DEMO_AUTONOMOUS",  // Dry Run は mode 判定をスキップ
      kill_switch:              (trader.kill_switch as boolean) ?? false,
      kill_switch_reason:       (trader.kill_switch_reason as string | null),
      daily_stats_date:         (trader.daily_stats_date as string | null),
      daily_trade_count:        (trader.daily_trade_count as number) ?? 0,
      daily_loss_usd:           (trader.daily_loss_usd as number) ?? 0,
      daily_consecutive_losses: (trader.daily_consecutive_losses as number) ?? 0,
    },
    profile: {
      id:                           profile.id as string,
      magic_number:                 (profile.magic_number as number | null),
      max_daily_trades:             (profile.max_daily_trades as number) ?? 5,
      max_daily_loss_usd:           (profile.max_daily_loss_usd as number) ?? 100,
      max_consecutive_losses:       (profile.max_consecutive_losses as number) ?? 3,
      max_total_exposure_lots:      (profile.max_total_exposure_lots as number) ?? 0.20,
      account_data_max_age_seconds: 60,
      tick_data_max_age_seconds:    10,
      max_spread_points:            0,
      max_risk_per_trade:           (profile.max_risk_per_trade as number) ?? 1,
    },
    accountSnapshot,
    symbolSpec,
    liveQuote,
    decision: {
      decision:    body.side === "BUY" ? "ENTER_LONG" : "ENTER_SHORT",
      suggestedSl: body.stop_loss,
      suggestedTp: body.take_profit,
    },
    openPositionCount,
    totalExposureLots,
    skipGlobalKillSwitch: true,  // Dry Run: Global Kill Switch をスキップ
  }, db);

  // ── 6. 結果構築 ──────────────────────────────────────────────
  const expectedMaxLoss = riskResult.approved
    ? riskResult.calc.normalizedLot * riskResult.calc.lossPerLot
    : 0;

  const result: DryRunResult = {
    test_label:       body.test_label ?? `dry_run_${new Date().toISOString()}`,
    approved:         riskResult.approved,
    denied_reason:    riskResult.deniedReason,
    mt5_orders_sent:  0,  // 絶対に 0

    data_source: {
      account:     accountSource,
      symbol_spec: specSource,
      tick:        tickSource,
    },

    side:         body.side,
    entry_price:  riskResult.entryPrice || body.entry_price || null,
    stop_loss:    body.stop_loss,
    take_profit:  body.take_profit,

    account_type:  accountSnapshot?.accountType,
    account_mode:  accountSnapshot?.accountMode,
    equity:        accountSnapshot?.equity,
    balance:       accountSnapshot?.balance,
    free_margin:   accountSnapshot?.freeMargin,
    account_age_sec: accountSnapshot
      ? Math.round((Date.now() - accountSnapshot.updatedAtMs) / 1000)
      : undefined,

    broker_symbol:     brokerSymbol,
    tick_size:         symbolSpec.tickSize,
    tick_value:        symbolSpec.tickValue,
    contract_size:     symbolSpec.contractSize,
    volume_min:        symbolSpec.volumeMin,
    volume_max:        symbolSpec.volumeMax,
    volume_step:       symbolSpec.volumeStep,
    stops_level_price: symbolSpec.stopsLevelPrice,
    digits:            symbolSpec.digits,

    bid:           liveQuote?.bid,
    ask:           liveQuote?.ask,
    spread_points: liveQuote?.spread,
    tick_age_sec:  liveQuote ? Math.round((Date.now() - liveQuote.timestampMs) / 1000) : undefined,

    calc: riskResult.approved ? {
      ...riskResult.calc,
      expectedMaxLoss,
    } : undefined,
  };

  // ── 7. dry_run_logs 保存 ──────────────────────────────────────
  // execution_commands は 絶対に作成しない
  let logId: string | null = null;
  try {
    const { data: logRow } = await db
      .from("dry_run_logs")
      .insert({
        ai_trader_id:       id,
        user_id:            effectiveUserId,
        test_label:         result.test_label,
        side:               result.side,
        entry_price:        result.entry_price,
        stop_loss:          result.stop_loss,
        take_profit:        result.take_profit,
        sl_distance:        riskResult.calc.slDistance,
        account_type:       result.account_type ?? null,
        account_mode:       result.account_mode ?? null,
        balance:            result.balance ?? null,
        equity:             result.equity ?? null,
        free_margin:        result.free_margin ?? null,
        account_age_sec:    result.account_age_sec ?? null,
        broker_symbol:      result.broker_symbol ?? null,
        tick_size:          result.tick_size ?? null,
        tick_value:         result.tick_value ?? null,
        contract_size:      result.contract_size ?? null,
        volume_min:         result.volume_min ?? null,
        volume_max:         result.volume_max ?? null,
        volume_step:        result.volume_step ?? null,
        stops_level_price:  result.stops_level_price ?? null,
        digits:             result.digits ?? null,
        bid:                result.bid ?? null,
        ask:                result.ask ?? null,
        spread_points:      result.spread_points ?? null,
        tick_age_sec:       result.tick_age_sec ?? null,
        risk_percent:       (profile.max_risk_per_trade as number) ?? 1,
        risk_money:         riskResult.calc.riskUsd,
        ticks_at_risk:      riskResult.calc.ticksAtRisk,
        loss_per_lot:       riskResult.calc.lossPerLot,
        raw_lot:            riskResult.calc.rawLot,
        normalized_lot:     riskResult.calc.normalizedLot,
        expected_max_loss:  expectedMaxLoss,
        margin_required:    riskResult.calc.requiredMargin,
        current_exposure_lots: totalExposureLots,
        open_position_count:   openPositionCount,
        approved:           result.approved,
        denied_reason:      result.denied_reason ?? null,
        mt5_orders_sent:    0,
        is_override:        accountSource === "override" || specSource === "override" || tickSource === "override",
      })
      .select("id")
      .single();
    logId = logRow?.id ?? null;
  } catch { /* ログ保存失敗は無視 — Dry Run は続行 */ }

  return NextResponse.json({ ...result, log_id: logId });
}

// =================================================================
// POST /api/watcher/m5-close
//
// Gateway(Railway) → Vercel Market Watcher
//
// M5バー確定 / ポジション変化 / 外部トリガー を受けて
// ACTIVE な AI Trader のトリガー条件を軽量評価する。
// AI は呼ばない。条件成立したトレーダーのみ analyze へ委譲。
//
// Phase 2 で追加したトリガー:
//   M5_STRUCTURE_CHANGE   : M5足の方向転換を検知
//   NEWS_EVENT            : 2時間以内の高インパクト指標が接近
//   POSITION_CHANGED      : ポジション開始/決済を検知
//   SPREAD_TOO_HIGH       : スプレッド異常拡大（分析スキップ）
//   SCENARIO_INVALIDATED  : 無効化価格を突破
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { randomUUID }                 from "crypto";

export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const maxDuration = 60;

const WATCHER_SECRET = process.env.WATCHER_SECRET ?? "";
const CRON_SECRET    = process.env.CRON_SECRET    ?? "";
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "";
const GATEWAY_URL    = process.env.MT5_GATEWAY_URL    ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

// クールダウン・スケジュール設定（環境変数で上書き可能）
const MIN_COOLDOWN_MINUTES  = parseInt(process.env.WATCHER_COOLDOWN_MINUTES  ?? "10",  10);
const SCHEDULE_MINUTES      = parseInt(process.env.WATCHER_SCHEDULE_MINUTES  ?? "60",  10);

// ── 型定義 ────────────────────────────────────────────────────────
interface WatcherTrigger {
  type:   string;
  low?:   number;
  high?:  number;
  value?: number;
}

interface ScenarioRow {
  id:                  string;
  state:               string;
  bias:                string | null;
  watch_zone_low:      number | null;
  watch_zone_high:     number | null;
  invalidate_below:    number | null;
  invalidate_above:    number | null;
  recheck_triggers:    string[];
  recheck_triggers_v2: WatcherTrigger[] | null;
}

interface M5Bar {
  time: number; open: number; high: number; low: number; close: number;
}

// ── Market データ取得 ─────────────────────────────────────────────
interface MarketData {
  m5Bars:       M5Bar[];
  h4Bars:       M5Bar[];
  currentPrice: number;
  spread:       number;
  atr:          number;
}

async function fetchMarketData(connectionId: string, symbol: string): Promise<MarketData> {
  const empty: MarketData = { m5Bars: [], h4Bars: [], currentPrice: 0, spread: 0, atr: 0 };
  if (!GATEWAY_URL || !connectionId) return empty;

  try {
    const headers = { Authorization: `Bearer ${GATEWAY_SECRET}` };
    const [tickRes, m5Res, h4Res] = await Promise.all([
      fetch(`${GATEWAY_URL}/connections/${connectionId}/tick/${encodeURIComponent(symbol)}`,
        { headers, signal: AbortSignal.timeout(4_000) }),
      fetch(`${GATEWAY_URL}/connections/${connectionId}/bars/${encodeURIComponent(symbol)}/M5?count=10`,
        { headers, signal: AbortSignal.timeout(4_000) }),
      fetch(`${GATEWAY_URL}/connections/${connectionId}/bars/${encodeURIComponent(symbol)}/H4?count=20`,
        { headers, signal: AbortSignal.timeout(4_000) }),
    ]);

    let currentPrice = 0;
    let spread       = 0;
    if (tickRes.ok) {
      const t = await tickRes.json() as { bid?: number; spread?: number };
      currentPrice = t.bid ?? 0;
      spread       = t.spread ?? 0;
    }

    let m5Bars: M5Bar[] = [];
    if (m5Res.ok) m5Bars = await m5Res.json() as M5Bar[];

    let h4Bars: M5Bar[] = [];
    let atr = 0;
    if (h4Res.ok) {
      h4Bars = await h4Res.json() as M5Bar[];
      if (h4Bars.length >= 2) {
        const trs = h4Bars.slice(-14).map((b, i, arr) => {
          if (i === 0) return b.high - b.low;
          const prev = arr[i - 1];
          return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
        });
        atr = trs.reduce((a, b) => a + b, 0) / trs.length;
      }
    }

    return { m5Bars, h4Bars, currentPrice, spread, atr };
  } catch {
    return empty;
  }
}

// ── M5_MOMENTUM_SHIFT 検知（旧: M5_STRUCTURE_CHANGE）─────────────
// 直近3本 vs その前3本の方向が逆転 = モメンタムの転換
// 注意: これは本当の "Structure Change"（Swing高安更新）ではなく
//       "Momentum Shift"（方向転換の兆候）であることに注意。
//       本当のBOS（Break of Structure）は detectBreakOfStructure を使用。
function detectMomentumShift(bars: M5Bar[]): boolean {
  if (bars.length < 6) return false;

  const prior  = bars.slice(-6, -3);
  const recent = bars.slice(-3);

  const priorMove  = prior[prior.length - 1].close  - prior[0].open;
  const recentMove = recent[recent.length - 1].close - recent[0].open;

  const threshold = 0.5; // GOLD: 最低0.5ドルの動きを要求
  if (Math.abs(priorMove) < threshold || Math.abs(recentMove) < threshold) return false;

  return (priorMove > 0 && recentMove < 0) || (priorMove < 0 && recentMove > 0);
}

// ── BREAK_OF_STRUCTURE 検知 ──────────────────────────────────────
// 直近Swing High/Lowの更新を判定（シンプルなBOS）
// 過去5本の高安を基準に、最新バーが更新したか確認。
function detectBreakOfStructure(bars: M5Bar[]): { bos: boolean; direction: "UP" | "DOWN" | null } {
  if (bars.length < 8) return { bos: false, direction: null };

  const lookback = bars.slice(-8, -1); // 最新1本を除く7本でSwingを計算
  const current  = bars[bars.length - 1];

  const swingHigh = Math.max(...lookback.map(b => b.high));
  const swingLow  = Math.min(...lookback.map(b => b.low));

  if (current.close > swingHigh) return { bos: true, direction: "UP" };
  if (current.close < swingLow  ) return { bos: true, direction: "DOWN" };
  return { bos: false, direction: null };
}

// ── POSITION 状態ハンドリング ─────────────────────────────────────

/**
 * EXECUTING 状態: FILLED になったコマンドから ai_positions にチケットを反映する。
 * POSITION 状態: live_deals の OUT エントリーでポジションクローズを検知する。
 */
async function handlePositionState(
  trader: Record<string, unknown>,
  db:     ReturnType<typeof createAdminClient>,
  appUrl: string,
  cronSecret: string,
): Promise<{ handled: boolean; result: string }> {

  const traderId = trader.id as string;
  const userId   = trader.user_id as string;

  // ── Step 1: OPEN ai_positions のチケット同期 ─────────────────
  // execution_command が FILLED になっていれば position_ticket / entry_price を更新
  {
    const { data: unticketedPositions } = await db
      .from("ai_positions")
      .select("id, execution_command_id")
      .eq("ai_trader_id", traderId)
      .eq("status", "OPEN")
      .is("position_ticket", null)
      .not("execution_command_id", "is", null);

    for (const pos of unticketedPositions ?? []) {
      const { data: cmd } = await db
        .from("execution_commands")
        .select("status, broker_position_ticket, broker_order_ticket, broker_deal_ticket, execution_price, executed_at, error_message")
        .eq("id", pos.execution_command_id as string)
        .single();

      if (!cmd) continue;

      if (cmd.status === "FILLED" && cmd.broker_position_ticket) {
        await db.from("ai_positions").update({
          position_ticket:   cmd.broker_position_ticket,
          order_ticket:      cmd.broker_order_ticket ?? null,
          entry_deal_ticket: cmd.broker_deal_ticket ?? null,
          entry_price:       cmd.execution_price ?? null,
          opened_at:         cmd.executed_at ?? new Date().toISOString(),
        }).eq("id", pos.id as string);
      } else if (["REJECTED", "FAILED", "EXPIRED", "CANCELLED"].includes(cmd.status as string)) {
        // Command 失敗 → ポジション ERROR に更新してトレーダーをリセット
        await db.from("ai_positions").update({ status: "ERROR" }).eq("id", pos.id as string);
        await db.from("ai_traders").update({ watcher_state: "WATCHING" }).eq("id", traderId);
        return { handled: true, result: `command_${cmd.status}_position_error` };
      }
    }
  }

  // ── Step 2: OPEN ai_positions（チケット有り）のクローズ検知 ──
  const { data: openPositions } = await db
    .from("ai_positions")
    .select("id, position_ticket, magic_number, opened_at, volume, entry_price, stop_loss, take_profit, side, decision_id, review_dispatched")
    .eq("ai_trader_id", traderId)
    .eq("status", "OPEN")
    .not("position_ticket", "is", null);

  if (!openPositions || openPositions.length === 0) {
    // チケット未取得のポジションのみ → まだ EXECUTING
    return { handled: false, result: "waiting_for_fill" };
  }

  for (const pos of openPositions) {
    // live_deals で entry_type=OUT を探す
    const { data: exitDeal } = await db
      .from("live_deals")
      .select("deal_ticket, position_ticket, price, profit, volume, deal_time, commission, swap")
      .eq("user_id", userId)
      .eq("entry_type", "OUT")
      .eq("position_ticket", pos.position_ticket as number)
      .order("deal_time", { ascending: false })
      .limit(1)
      .maybeSingle();

    // live_positions の status=CLOSED もフォールバックで確認
    let closedByLivePos = false;
    let liveClosePrice: number | null = null;
    if (!exitDeal) {
      const { data: lp } = await db
        .from("live_positions")
        .select("status, current_price")
        .eq("user_id", userId)
        .eq("position_ticket", pos.position_ticket as number)
        .maybeSingle();
      if (lp?.status === "CLOSED") {
        closedByLivePos = true;
        liveClosePrice  = lp.current_price as number | null;
      }
    }

    if (!exitDeal && !closedByLivePos) continue;

    // ── ポジションクローズ検知 ──────────────────────────────────
    const exitPrice  = exitDeal ? (exitDeal.price as number)  : (liveClosePrice ?? 0);
    const profitUsd  = exitDeal ? (exitDeal.profit as number) : 0;
    const exitTime   = exitDeal ? (exitDeal.deal_time as string) : new Date().toISOString();
    const exitDealTk = exitDeal ? (exitDeal.deal_ticket as number) : null;

    const entryPrice = pos.entry_price as number | null;
    const pips: number | null = (entryPrice && exitPrice)
      ? (pos.side === "BUY"
          ? parseFloat((exitPrice - entryPrice).toFixed(2))
          : parseFloat((entryPrice - exitPrice).toFixed(2)))
      : null;

    const outcome: "WIN" | "LOSS" | "BREAKEVEN" =
      profitUsd > 0.01 ? "WIN"
      : profitUsd < -0.01 ? "LOSS"
      : "BREAKEVEN";

    // ai_positions を CLOSED に更新
    const durationSeconds = pos.opened_at
      ? Math.round((new Date(exitTime).getTime() - new Date(pos.opened_at as string).getTime()) / 1000)
      : null;

    await db.from("ai_positions").update({
      status:           "CLOSED",
      exit_price:       exitPrice,
      exit_deal_ticket: exitDealTk,
      realized_profit:  profitUsd,
      realized_pips:    pips,
      closed_at:        exitTime,
      duration_seconds: durationSeconds,
    }).eq("id", pos.id as string);

    // trade_outcomes 作成（decision_id は UNIQUE なので重複しない）
    if (pos.decision_id) {
      const { error: outcomeErr } = await db.from("trade_outcomes").insert({
        decision_id: pos.decision_id,
        ai_trader_id: traderId,
        user_id:      userId,
        outcome,
        entry_price:  entryPrice ?? null,
        exit_price:   exitPrice || null,
        pips,
        profit_usd:   profitUsd,
        entry_time:   pos.opened_at ?? null,
        exit_time:    exitTime,
        broker_ticket: pos.position_ticket as number,
      });

      // ── AI Review ディスパッチ（未ディスパッチの場合のみ）──────
      if (!outcomeErr && !(pos.review_dispatched as boolean) && appUrl) {
        // review_dispatched フラグを立ててから非同期ディスパッチ
        await db.from("ai_positions").update({ review_dispatched: true }).eq("id", pos.id as string);

        fetch(`${appUrl}/api/traders/${traderId}/review`, {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "x-cron-secret": cronSecret,
            "x-user-id":     userId,
          },
          body: JSON.stringify({
            position_id: pos.id,
            outcome,
            pips,
            profit_usd: profitUsd,
          }),
          signal: AbortSignal.timeout(30_000),
        }).catch(() => { /* review は best-effort */ });
      }
    }

    // daily_loss_usd / consecutive_losses 更新
    {
      const { data: current } = await db.from("ai_traders")
        .select("daily_loss_usd, daily_consecutive_losses")
        .eq("id", traderId).single();
      if (current) {
        const updatePayload: Record<string, unknown> = outcome === "LOSS"
          ? {
              daily_loss_usd:           ((current.daily_loss_usd as number) ?? 0) + Math.abs(profitUsd),
              daily_consecutive_losses: ((current.daily_consecutive_losses as number) ?? 0) + 1,
            }
          : outcome === "WIN"
          ? { daily_consecutive_losses: 0 }
          : {};
        if (Object.keys(updatePayload).length > 0) {
          await db.from("ai_traders").update(updatePayload).eq("id", traderId);
        }
      }
    }

    // watcher_state を REVIEWING → WATCHING に遷移
    await db.from("ai_traders").update({
      watcher_state:            "REVIEWING",
      last_watcher_check_at:    new Date().toISOString(),
    }).eq("id", traderId);

    // Review が完了したら WATCHING に戻す（review route が行う）
    return {
      handled: true,
      result: `position_closed_${outcome}_pips=${pips?.toFixed(1) ?? "?"}_pnl=${profitUsd.toFixed(2)}`,
    };
  }

  // OPEN ポジションが存在するが、まだクローズされていない
  return { handled: false, result: "position_open" };
}

// ── NEWS_EVENT 検知 ───────────────────────────────────────────────
// GOLD に関係する高インパクト経済指標（USD/XAU）が2時間以内に控えているか
async function checkNewsEvent(db: ReturnType<typeof createAdminClient>): Promise<{
  hasEvent: boolean; eventTitle: string; minutesUntil: number;
}> {
  try {
    const now   = new Date().toISOString();
    const in2h  = new Date(Date.now() + 2 * 3_600_000).toISOString();

    const { data } = await db
      .from("economic_events")
      .select("title, event_time, currency, impact")
      .in("currency", ["USD", "XAU"])
      .gte("event_time", now)
      .lte("event_time", in2h)
      .gte("impact", 3)           // HIGH インパクトのみ
      .order("event_time", { ascending: true })
      .limit(1);

    if (!data || data.length === 0) {
      return { hasEvent: false, eventTitle: "", minutesUntil: 9999 };
    }

    const ev = data[0] as { title: string; event_time: string };
    const minutesUntil = (new Date(ev.event_time).getTime() - Date.now()) / 60_000;
    return { hasEvent: true, eventTitle: ev.title, minutesUntil };
  } catch {
    return { hasEvent: false, eventTitle: "", minutesUntil: 9999 };
  }
}

// ── 単一トリガー評価 ─────────────────────────────────────────────
interface TriggerContext {
  price:     number;
  atr:       number;
  spread:    number;
  m5Bars:    M5Bar[];
  newsEvent: { hasEvent: boolean; eventTitle: string; minutesUntil: number };
  triggerTypeOverride?: string; // POSITION_CHANGED等の外部トリガー
}

function evalSingleTrigger(trig: WatcherTrigger, ctx: TriggerContext): boolean {
  const { price, atr, spread, m5Bars, newsEvent } = ctx;

  switch (trig.type) {
    case "PRICE_ENTERS_ZONE":
      if (trig.low !== undefined && trig.high !== undefined) {
        return price >= trig.low && price <= trig.high;
      }
      return false;

    case "PRICE_ABOVE":
      return trig.value !== undefined && price > trig.value;

    case "PRICE_BELOW":
      return trig.value !== undefined && price < trig.value;

    case "VOLATILITY_SPIKE":
      // ATRが通常の1.5倍以上（GOLD H4: 80ドル超）
      return atr > 80;

    case "ATR_THRESHOLD":
      return trig.value !== undefined ? atr > trig.value : atr > 60;

    case "M5_MOMENTUM_SHIFT":
    case "M5_STRUCTURE_CHANGE":  // 旧名称との後方互換
      return detectMomentumShift(m5Bars);

    case "BREAK_OF_STRUCTURE":
      return detectBreakOfStructure(m5Bars).bos;

    case "NEWS_EVENT":
      // 2時間以内の高インパクト指標
      return newsEvent.hasEvent && newsEvent.minutesUntil < 120;

    case "SPREAD_TOO_HIGH":
      // スプレッド3.0pips以上 → 分析スキップ（戻り値はfalseにして安全側）
      return spread > 3.0;

    case "SCHEDULE":
    case "SCENARIO_INVALIDATED":
    case "FIRST_RUN":
    case "POSITION_CHANGED":
      // これらは上位の evaluateTriggers で処理
      return false;

    default:
      // 未実装トリガーは常にfalse（NOT_IMPLEMENTED）
      return false;
  }
}

// ── メイン評価ロジック ───────────────────────────────────────────
function evaluateTriggers(
  scenario:     ScenarioRow | null,
  ctx:          TriggerContext,
  lastAnalysisAt: Date | null,
): { shouldTrigger: boolean; reason: string; skipReason?: string } {

  const { price, spread, newsEvent } = ctx;

  // FIRST_RUN: シナリオなし
  if (!scenario) {
    return { shouldTrigger: true, reason: "FIRST_RUN" };
  }

  // クールダウン: 最低MIN_COOLDOWN分は再分析しない
  if (lastAnalysisAt) {
    const minsSince = (Date.now() - lastAnalysisAt.getTime()) / 60_000;
    if (minsSince < MIN_COOLDOWN_MINUTES) {
      return { shouldTrigger: false, reason: "COOLDOWN" };
    }
  } else {
    return { shouldTrigger: true, reason: "FIRST_RUN" };
  }

  // スプレッド過大: 高ボラ時のゴミデータ防止
  if (spread > 5.0) {
    return { shouldTrigger: false, reason: "SPREAD_TOO_HIGH", skipReason: `spread=${spread.toFixed(1)}pips` };
  }

  // 経済指標30分前: 分析しない（指標直前のエントリーは避ける）
  if (newsEvent.hasEvent && newsEvent.minutesUntil < 30) {
    // ただし指標接近は「監視強化」のトリガーとして再分析する
    return { shouldTrigger: true, reason: "NEWS_IMMINENT" };
  }

  // 無効化条件
  if (price > 0) {
    if (scenario.invalidate_below && price < scenario.invalidate_below) {
      return { shouldTrigger: true, reason: "SCENARIO_INVALIDATED" };
    }
    if (scenario.invalidate_above && price > scenario.invalidate_above) {
      return { shouldTrigger: true, reason: "SCENARIO_INVALIDATED" };
    }
  }

  // 外部トリガーオーバーライド（POSITION_CHANGED等）
  if (ctx.triggerTypeOverride) {
    return { shouldTrigger: true, reason: ctx.triggerTypeOverride };
  }

  // 構造化トリガー v2 を評価
  const triggersV2 = scenario.recheck_triggers_v2;
  if (triggersV2 && triggersV2.length > 0) {
    for (const trig of triggersV2) {
      if (evalSingleTrigger(trig, ctx)) {
        return { shouldTrigger: true, reason: trig.type };
      }
    }
    // v2トリガーがあるが全て未成立 → SCHEDULE チェックのみ
    if (lastAnalysisAt) {
      const mins = (Date.now() - lastAnalysisAt.getTime()) / 60_000;
      if (mins >= SCHEDULE_MINUTES) return { shouldTrigger: true, reason: "SCHEDULE_60MIN" };
    }
    return { shouldTrigger: false, reason: "WATCHING" };
  }

  // フォールバック: 旧 watch_zone
  if (price > 0 && scenario.watch_zone_low !== null && scenario.watch_zone_high !== null) {
    if (price >= scenario.watch_zone_low && price <= scenario.watch_zone_high) {
      return { shouldTrigger: true, reason: "PRICE_ENTERS_ZONE" };
    }
  }

  // SCHEDULE: 60分以上再分析なし
  if (lastAnalysisAt) {
    const mins = (Date.now() - lastAnalysisAt.getTime()) / 60_000;
    if (mins >= 60) return { shouldTrigger: true, reason: "SCHEDULE_60MIN" };
  }

  return { shouldTrigger: false, reason: "WATCHING" };
}

// ── メインハンドラー ───────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 認証
  const incomingSecret = req.headers.get("x-watcher-secret") ?? "";
  const isCron = CRON_SECRET && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;

  if (!isCron && (!WATCHER_SECRET || incomingSecret !== WATCHER_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as {
    symbol?:          string;
    bar_time?:        number;
    current_price?:   number;
    trigger_override?: string; // POSITION_CHANGED 等の外部トリガー
    source?:          string;
  };

  const symbol          = (body.symbol ?? "GOLD#").toUpperCase();
  const barTime         = body.bar_time;
  const priceOverride   = body.current_price ?? 0;
  const triggerOverride = body.trigger_override;
  const marketSymbol    = symbol.replace("#", "").replace(/-[A-Z0-9]+$/, ""); // GOLD# → GOLD

  const db = createAdminClient();

  // ACTIVE な対象トレーダーを取得（watcher_state / execution_mode も含む）
  const { data: traders } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version, watcher_state, last_analysis_at, execution_mode, daily_consecutive_losses")
    .eq("status", "ACTIVE")
    .eq("market", marketSymbol);

  if (!traders || traders.length === 0) {
    return NextResponse.json({ ok: true, symbol, evaluated: 0, triggered: 0 });
  }

  // 経済指標を一度だけ取得（全トレーダー共通）
  const newsEvent = await checkNewsEvent(db);

  let triggered = 0;
  const results: Array<{ trader: string; reason: string; status: string }> = [];

  for (const trader of traders) {
    try {
      // MT5接続取得
      const { data: conn } = await db
        .from("mt5_connections")
        .select("id, last_heartbeat_at, account_type")
        .eq("user_id", trader.user_id as string)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const mt5Online = conn &&
        (Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime()) < 90_000;

      // ── POSITION / EXECUTING 状態: ポジションクローズ検知優先 ──
      const ws = trader.watcher_state as string;
      if (ws === "POSITION" || ws === "EXECUTING") {
        const { handled, result } = await handlePositionState(
          trader as Record<string, unknown>,
          db,
          APP_URL,
          CRON_SECRET,
        );
        results.push({ trader: trader.name as string, reason: ws, status: result });
        if (handled) triggered++;
        continue;
      }

      // Market データ取得（MT5オンライン時のみ）
      let marketData: MarketData = { m5Bars: [], h4Bars: [], currentPrice: priceOverride, spread: 0, atr: 0 };
      if (mt5Online && conn) {
        marketData = await fetchMarketData(conn.id, symbol);
        if (marketData.currentPrice === 0 && priceOverride > 0) {
          marketData.currentPrice = priceOverride;
        }
      }

      // 現在のシナリオ取得（H1戦略セッションのエントリーゾーンも含む）
      const { data: scenario } = await db
        .from("ai_trader_scenarios")
        .select("id,state,bias,watch_zone_low,watch_zone_high,invalidate_below,invalidate_above,recheck_triggers,recheck_triggers_v2,entry_side,entry_price_low,entry_price_high,suggested_sl,suggested_tp,suggested_volume")
        .eq("ai_trader_id", trader.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // ── Layer 2: M5エントリーチェック（AIなし・価格比較のみ） ──────
      // H1戦略セッションで設定されたエントリーゾーンに価格が入ったら即エントリー
      const currentPriceNow = marketData.currentPrice;
      const sc = scenario as (ScenarioRow & {
        entry_side?: string; entry_price_low?: number; entry_price_high?: number;
        suggested_sl?: number; suggested_tp?: number; suggested_volume?: number;
      }) | null;

      const canAutoExecute = ["DEMO_AUTONOMOUS", "AUTO"].includes(trader.execution_mode as string);
      if (
        canAutoExecute &&
        sc?.entry_side && sc.entry_side !== "NONE" &&
        sc.entry_price_low != null && sc.entry_price_high != null &&
        currentPriceNow > 0 &&
        currentPriceNow >= sc.entry_price_low &&
        currentPriceNow <= sc.entry_price_high &&
        trader.watcher_state !== "EXECUTING" &&
        trader.watcher_state !== "POSITION"
      ) {
        // エントリーゾーンに入った → AIを呼ばず直接注文発行
        const profileData = await db
          .from("ai_trader_versions")
          .select("magic_number, max_positions")
          .eq("ai_trader_id", trader.id as string)
          .eq("version", trader.current_version as number)
          .single();

        const magicNumber = profileData.data?.magic_number ?? 900000 + Math.floor(Math.random() * 99999);
        const action      = sc.entry_side === "LONG" ? "BUY" : "SELL";

        await db.from("execution_commands").insert({
          command_id:    randomUUID(),
          ai_trader_id:  trader.id,
          user_id:       trader.user_id,
          connection_id: conn?.id ?? null,
          action,
          symbol,
          volume:        sc.suggested_volume ?? 0.01,
          stop_loss:     sc.suggested_sl ?? null,
          take_profit:   sc.suggested_tp ?? null,
          magic_number:  magicNumber,
          expires_at:    new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          status:        "PENDING",
          metadata:      { source: "h1_strategy", bias: sc.bias, price: currentPriceNow, zone: `${sc.entry_price_low}-${sc.entry_price_high}` },
        });

        await db.from("ai_traders").update({
          watcher_state:         "EXECUTING",
          last_watcher_check_at: new Date().toISOString(),
        }).eq("id", trader.id);

        results.push({ trader: trader.name as string, reason: "ENTRY_ZONE_HIT", status: `${action}_command_issued` });
        triggered++;
        continue;
      }

      // ── Layer 3: オープンポジション管理（M5毎・AIあり） ─────────────
      if ((trader.watcher_state === "POSITION" || trader.watcher_state === "EXECUTING") && APP_URL) {
        try {
          await fetch(`${APP_URL}/api/traders/${trader.id}/manage-positions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-cron-secret": CRON_SECRET,
              "x-user-id": trader.user_id as string,
            },
            signal: AbortSignal.timeout(20_000),
          });
        } catch { /* position management failure is non-fatal */ }
      }

      const lastAnalysisAt = trader.last_analysis_at
        ? new Date(trader.last_analysis_at as string)
        : null;

      const ctx: TriggerContext = {
        price:     marketData.currentPrice,
        atr:       marketData.atr,
        spread:    marketData.spread,
        m5Bars:    marketData.m5Bars,
        newsEvent,
        triggerTypeOverride: triggerOverride,
      };

      const { shouldTrigger, reason, skipReason } = evaluateTriggers(
        scenario as ScenarioRow | null,
        ctx,
        lastAnalysisAt,
      );

      // watcher_state 更新
      await db.from("ai_traders").update({
        watcher_state:         shouldTrigger ? "TRIGGERED" : "WATCHING",
        last_watcher_check_at: new Date().toISOString(),
      }).eq("id", trader.id);

      if (!shouldTrigger) {
        results.push({ trader: trader.name as string, reason, status: skipReason ?? "WATCHING" });
        continue;
      }

      // ── 重複防止 ──────────────────────────────────────────────
      const dedupBarTime = barTime ?? 0;

      const isScheduleTrigger = reason === "SCHEDULE_60MIN" || reason === "SCHEDULE";

      if (dedupBarTime > 0 && !isScheduleTrigger) {
        // M5 バー起点: watcher_events の UNIQUE(trader_id, m5_bar_time, trigger_type) で dedup
        const { error: insertErr } = await db.from("watcher_events").insert({
          trader_id:           trader.id,
          user_id:             trader.user_id,
          symbol,
          m5_bar_time:         dedupBarTime,
          trigger_type:        reason,
          analysis_dispatched: false,
        });

        if (insertErr) {
          results.push({ trader: trader.name as string, reason, status: "DUPLICATE_SKIPPED" });
          continue;
        }
      } else if (isScheduleTrigger) {
        // Cron/Schedule 起点: schedule_bucket で dedup
        // bucket = "YYYY-MM-DDTHH:00" (UTC 1時間単位)
        const bucket = new Date().toISOString().slice(0, 13) + ":00";
        const { error: schedErr } = await db.from("cron_schedules").insert({
          trader_id:      trader.id,
          user_id:        trader.user_id,
          trigger_type:   reason,
          schedule_bucket: bucket,
          dispatched:      false,
        });

        if (schedErr) {
          // UNIQUE 違反 = 同一 bucket で既に処理済み
          results.push({ trader: trader.name as string, reason, status: "CRON_DUPLICATE_SKIPPED" });
          continue;
        }
      }

      // AI 分析を起動
      await db.from("ai_traders")
        .update({ watcher_state: "ANALYZING" })
        .eq("id", trader.id);

      let analyzeStatus = "no_app_url";
      if (APP_URL) {
        try {
          const analyzeRes = await fetch(`${APP_URL}/api/traders/${trader.id}/analyze`, {
            method:  "POST",
            headers: {
              "Content-Type":  "application/json",
              "x-cron-secret": CRON_SECRET,
              "x-user-id":     trader.user_id as string,
            },
            body:   JSON.stringify({
              trigger_type:  reason,
              bar_time:      dedupBarTime,
              current_price: marketData.currentPrice,
              news_event:    newsEvent.hasEvent ? newsEvent.eventTitle : null,
            }),
            signal: AbortSignal.timeout(50_000),
          });
          analyzeStatus = analyzeRes.ok ? "analyzed" : `failed_${analyzeRes.status}`;
        } catch {
          analyzeStatus = "timeout";
          await db.from("ai_traders")
            .update({ watcher_state: "WATCHING" })
            .eq("id", trader.id);
        }
      }

      // watcher_events を更新
      if (dedupBarTime > 0) {
        await db.from("watcher_events")
          .update({ analysis_dispatched: true, analysis_result: analyzeStatus })
          .eq("trader_id", trader.id)
          .eq("m5_bar_time", dedupBarTime)
          .eq("trigger_type", reason);
      }

      triggered++;
      results.push({ trader: trader.name as string, reason, status: analyzeStatus });

    } catch (e) {
      results.push({ trader: trader.name as string, reason: "ERROR", status: String(e).slice(0, 80) });
      await db.from("ai_traders").update({ watcher_state: "ERROR" }).eq("id", trader.id);
    }
  }

  return NextResponse.json({
    ok:          true,
    symbol,
    bar_time:    barTime,
    evaluated:   traders.length,
    triggered,
    news_event:  newsEvent.hasEvent ? { title: newsEvent.eventTitle, minutes_until: Math.round(newsEvent.minutesUntil) } : null,
    results,
  });
}

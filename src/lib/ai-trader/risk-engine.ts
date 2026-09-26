// =================================================================
// Risk Engine v2 — Phase 3.5: Demo Execution Safety Gate
//
// 責務:
//   AI Decision → Execution 前にすべての安全条件を検査する。
//   いずれか一つでも失敗 → DENIED（Fail Closed）。
//   Balance/SymbolSpec のどちらか一方が欠けても DENIED。
//
// チェック順序:
//   1.  Execution Mode (DEMO_AUTONOMOUS 必須)
//   2.  Global Kill Switch (system_settings)
//   3.  Trader Kill Switch
//   4.  Demo Account Guard (FAIL CLOSED)
//   5.  Hedging Mode Guard
//   6.  Account Snapshot Freshness (stale → DENIED)
//   7.  Symbol Specification (missing → DENIED)
//   8.  Daily Risk Limits (日付変更時リセット)
//   9.  Duplicate Open Position
//   10. Live Quote Freshness (tick stale → DENIED)
//   11. Spread Guard (abnormal → DENIED)
//   12. Decision Expiry
//   13. Tick-Value Based Lot Calculation
//   14. Stop Level Validation (Broker stops_level)
//   15. Margin Check (free_margin)
//   16. Total Exposure
//
// Daily Reset Timezone: UTC
//   - Server-side UTC で統一。Browser timezone に依存しない。
//   - Broker Server Day や Trading Day の変化はフェーズ4で対応。
// =================================================================

import { SupabaseClient } from "@supabase/supabase-js";
import { createCommandExpiryUtc } from "./command-expiry";

// ── 型定義 ────────────────────────────────────────────────────────

export interface RiskEngineTrader {
  id:                         string;
  user_id:                    string;
  execution_mode:             string;
  kill_switch:                boolean;
  kill_switch_reason:         string | null;
  daily_stats_date:           string | null;  // "YYYY-MM-DD" (UTC)
  daily_trade_count:          number;
  daily_loss_usd:             number;
  daily_consecutive_losses:   number;
}

export interface RiskEngineProfile {
  id:                           string;
  magic_number:                 number | null;
  max_daily_trades:             number;
  max_daily_loss_usd:           number;
  max_consecutive_losses:       number;
  max_total_exposure_lots:      number;
  account_data_max_age_seconds: number;  // account snapshot 鮮度
  tick_data_max_age_seconds:    number;  // live quote 鮮度
  max_spread_points:            number;  // スプレッド上限（0 = 無制限）
  max_risk_per_trade:           number;  // % of equity
  /** AI Trader profile controls. Required when enforceProfileLimits is true. */
  minimum_rr?:                  number;
  max_positions?:               number;
}

export interface RiskEngineAccountSnapshot {
  connectionId:  string;
  accountType:   "REAL" | "DEMO" | string;
  accountMode:   "HEDGING" | "NETTING" | string;
  balance:       number;
  equity:        number;
  freeMargin:    number;
  margin:        number;
  currency:      string;
  updatedAtMs:   number;  // epoch ms of last account update
}

export interface RiskEngineSymbolSpec {
  contractSize:      number;
  tickSize:          number;
  tickValue:         number;   // per lot per tick, in deposit currency
  volumeMin:         number;
  volumeMax:         number;
  volumeStep:        number;
  stopsLevelPrice:   number;   // minimum SL/TP distance from price
  digits:            number;
  marginInitial:     number;   // required margin per lot (if available)
  maxSpreadAllowed:  number;   // from DB or profile setting
}

export interface RiskEngineLiveQuote {
  bid:         number;
  ask:         number;
  spread:      number;        // in points
  timestampMs: number;        // epoch ms of last tick
}

export interface RiskEngineDecision {
  decision:   string;  // ENTER_LONG | ENTER_SHORT
  suggestedSl: number | null;
  suggestedTp: number | null;
  // suggested_volume は informational のみ — Lot 計算に使用しない
}

export interface RiskEngineInput {
  trader:             RiskEngineTrader;
  profile:            RiskEngineProfile;
  accountSnapshot:    RiskEngineAccountSnapshot | null;  // null → DENIED
  symbolSpec:         RiskEngineSymbolSpec | null;       // null → DENIED
  liveQuote:          RiskEngineLiveQuote | null;        // null → DENIED
  decision:           RiskEngineDecision;
  openPositionCount:  number;   // OPEN + PENDING_OPEN ai_positions for this trader
  totalExposureLots:  number;   // sum of volume for OPEN + PENDING_OPEN ai_positions
  // Dry Run フラグ: true のとき Global Kill Switch (Check 2) をスキップする。
  // Dry Run は execution_commands を作成しないため Kill Switch 迂回ではない。
  skipGlobalKillSwitch?: boolean;
  /** Enforce the persisted AI Trader version profile (no permissive defaults). */
  enforceProfileLimits?: boolean;
  /** Manual approval is the only context allowed to execute MANUAL_APPROVAL traders. */
  manualApproval?: boolean;
  /** Require a positive authoritative margin_initial value. */
  requireMarginValidation?: boolean;
  positionCountAvailable?: boolean;
}

export interface RiskEngineResult {
  approved:      boolean;
  deniedReason?: string;
  lot:           number;        // calculated lot size (0 if denied)
  stopLoss:      number;
  takeProfit:    number;
  side:          "BUY" | "SELL";
  entryPrice:    number;        // live bid/ask at decision time
  expiresAt:     string;        // ISO8601 — command expiry (5 min)
  dailyReset:    boolean;
  // 計算過程の透明性（ログ・Dry Run 用）
  calc: {
    riskUsd:       number;
    slDistance:    number;
    ticksAtRisk:   number;
    lossPerLot:    number;
    rawLot:        number;
    normalizedLot: number;
    requiredMargin: number;
  };
}

// ── 定数 ──────────────────────────────────────────────────────────

// EA の ParseISO は UTC 文字列の時刻部をブローカー時刻（JST=UTC+9）として解釈する。
// 正しい 5 分有効期限にするため、ブローカーオフセット（9h）を加算する。

// ── ユーティリティ ────────────────────────────────────────────────

/** UTC ベースの日付文字列 "YYYY-MM-DD" */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** lot を volume_step に正規化する（Risk Limit を超えない方向 = 切り捨て）
 *
 *  Math.round ではなく Math.floor を使う。
 *  理由: 切り上げによって raw_lot > risk_limit を超えることを防ぐ。
 *  例: raw=0.037, step=0.01 → floor → 0.03 (NOT 0.04)
 *
 *  volumeMax へのクランプは許容（Lotを減らす方向なのでリスクは下がる）。
 *  volumeMin へのクランプは行わない（呼び出し元で DENIED にする）。
 */
export function normalizeLot(lot: number, spec: RiskEngineSymbolSpec): number {
  if (!Number.isFinite(lot)) return NaN;
  const { volumeMax, volumeStep } = spec;
  if (volumeStep <= 0) return Math.min(volumeMax, lot);
  // 切り捨て（Risk Limit を超えない方向）
  const precision = Math.max(0, Math.min(12, Math.ceil(-Math.log10(volumeStep))));
  const scale = 10 ** precision;
  const floored = Math.floor((lot * scale + Number.EPSILON) / (volumeStep * scale)) * volumeStep;
  // volumeMax は上限（Lot を減らすのでリスクは下がる）
  const clamped  = Math.min(volumeMax, floored);
  // floating point 精度
  return Number(clamped.toFixed(precision));
}

export function calculateRiskReward(
  side: "BUY" | "SELL",
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
): number | null {
  if (![entryPrice, stopLoss, takeProfit].every(Number.isFinite) || entryPrice <= 0 || stopLoss <= 0 || takeProfit <= 0) return null;
  const risk = side === "BUY" ? entryPrice - stopLoss : stopLoss - entryPrice;
  const reward = side === "BUY" ? takeProfit - entryPrice : entryPrice - takeProfit;
  if (!(risk > 0) || !(reward > 0)) return null;
  const rr = reward / risk;
  return Number.isFinite(rr) ? rr : null;
}

// ── Risk Engine メイン ─────────────────────────────────────────────

export async function runRiskEngine(
  input: RiskEngineInput,
  db:    SupabaseClient,
): Promise<RiskEngineResult> {

  const DENIED = (reason: string): RiskEngineResult => ({
    approved: false, deniedReason: reason,
    lot: 0, stopLoss: 0, takeProfit: 0, side: "BUY", entryPrice: 0,
    expiresAt: createCommandExpiryUtc(),
    dailyReset: false,
    calc: { riskUsd: 0, slDistance: 0, ticksAtRisk: 0, lossPerLot: 0, rawLot: 0, normalizedLot: 0, requiredMargin: 0 },
  });

  const { trader, profile, accountSnapshot, symbolSpec, liveQuote, decision, openPositionCount, totalExposureLots, skipGlobalKillSwitch, enforceProfileLimits = false, manualApproval = false, requireMarginValidation = enforceProfileLimits, positionCountAvailable = true } = input;

  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const nonNegative = (v: unknown): v is number => finite(v) && v >= 0;
  const positive = (v: unknown): v is number => finite(v) && v > 0;

  // Validate every numeric input before any comparison. NaN comparisons are
  // false in JavaScript and must never be allowed to reach APPROVED.
  if (![profile.max_daily_trades, profile.max_daily_loss_usd,
        profile.max_consecutive_losses, profile.max_total_exposure_lots,
        profile.account_data_max_age_seconds, profile.tick_data_max_age_seconds,
        profile.max_spread_points, profile.max_risk_per_trade,
        trader.daily_trade_count, trader.daily_loss_usd,
        trader.daily_consecutive_losses].every(nonNegative)) {
    return DENIED("numeric_invalid: profile/trader risk limits");
  }
  if (!positive(profile.max_risk_per_trade) || !positive(profile.max_total_exposure_lots)) {
    return DENIED("numeric_invalid: risk limits must be positive");
  }
  if (enforceProfileLimits) {
    if (!positive(profile.minimum_rr ?? NaN) || (profile.minimum_rr as number) > 10 || !Number.isInteger(profile.max_positions) || (profile.max_positions ?? 0) < 1 || (profile.max_positions as number) > 10) {
      return DENIED("invalid_profile_limits: minimum_rr/max_positions");
    }
  }

  // ── Numeric input guard (before any comparisons) ──────────────
  // All numeric inputs must be finite. NaN/Infinity/wrong-type = DENIED.
  if (accountSnapshot) {
    if (!Number.isFinite(accountSnapshot.equity) || !Number.isFinite(accountSnapshot.balance) ||
        !Number.isFinite(accountSnapshot.freeMargin) || !Number.isFinite(accountSnapshot.margin) ||
        !Number.isFinite(accountSnapshot.updatedAtMs)) {
      return DENIED("numeric_invalid: accountSnapshot contains non-finite value (NaN/Infinity)");
    }
  }
  if (symbolSpec) {
    if (!Number.isFinite(symbolSpec.tickValue) || !Number.isFinite(symbolSpec.tickSize) ||
        !Number.isFinite(symbolSpec.contractSize) || !Number.isFinite(symbolSpec.volumeMin) ||
        !Number.isFinite(symbolSpec.volumeStep) || !Number.isFinite(symbolSpec.volumeMax) ||
        !Number.isFinite(symbolSpec.digits) || !Number.isFinite(symbolSpec.marginInitial) ||
        !Number.isFinite(symbolSpec.maxSpreadAllowed) || !Number.isFinite(symbolSpec.stopsLevelPrice)) {
      return DENIED("numeric_invalid: symbolSpec contains non-finite value (NaN/Infinity)");
    }
    if (symbolSpec.tickSize <= 0 || symbolSpec.tickValue <= 0 || symbolSpec.volumeMin <= 0 ||
        symbolSpec.volumeMax < symbolSpec.volumeMin || symbolSpec.volumeStep <= 0 ||
        symbolSpec.digits < 0 || symbolSpec.marginInitial < 0 || symbolSpec.maxSpreadAllowed < 0 ||
        symbolSpec.stopsLevelPrice < 0) {
      return DENIED("numeric_invalid: symbolSpec contains invalid range");
    }
  }
  if (liveQuote) {
    if (!Number.isFinite(liveQuote.bid) || !Number.isFinite(liveQuote.ask) ||
        !Number.isFinite(liveQuote.spread) || !Number.isFinite(liveQuote.timestampMs) ||
        liveQuote.timestampMs <= 0) {
      return DENIED("numeric_invalid: liveQuote contains non-finite or zero timestampMs");
    }
  }
  if (decision.suggestedSl !== null && !Number.isFinite(decision.suggestedSl)) {
    return DENIED("numeric_invalid: suggestedSl is non-finite");
  }
  if (decision.suggestedTp !== null && !Number.isFinite(decision.suggestedTp)) {
    return DENIED("numeric_invalid: suggestedTp is non-finite");
  }
  if (decision.decision !== "ENTER_LONG" && decision.decision !== "ENTER_SHORT") {
    return DENIED("invalid_decision: only ENTER_LONG/ENTER_SHORT are executable");
  }
  if (!Number.isFinite(openPositionCount) || !Number.isFinite(totalExposureLots)) {
    return DENIED("numeric_invalid: openPositionCount or totalExposureLots is non-finite");
  }
  if (enforceProfileLimits && !positionCountAvailable) {
    return DENIED("position_count_unavailable: open position query failed");
  }

  // ── Check 1: Execution Mode ───────────────────────────────────
  // Valid mode for autonomous demo execution is "DEMO_AUTONOMOUS".
  // Note: old code used "AUTO" but DB schema stores "DEMO_AUTONOMOUS" (migration 025).
  if (trader.execution_mode === "ANALYSIS_ONLY") {
    return DENIED("invalid_execution_mode: ANALYSIS_ONLY は実行しない");
  }
  if (trader.execution_mode === "MANUAL_APPROVAL" && !manualApproval) {
    return DENIED("invalid_execution_mode: MANUAL_APPROVAL は明示承認が必要");
  }
  if (trader.execution_mode !== "DEMO_AUTONOMOUS" && trader.execution_mode !== "MANUAL_APPROVAL") {
    return DENIED(`invalid_execution_mode: ${trader.execution_mode}; DEMO_AUTONOMOUS or MANUAL_APPROVAL required`);
  }

  // ── Check 2: Global Kill Switch ───────────────────────────────
  // skipGlobalKillSwitch=true は Dry Run 専用。execution_commands を作らない。
  if (!skipGlobalKillSwitch) {
    try {
      const { data: gKill } = await db
        .from("system_settings")
        .select("value")
        .eq("key", "demo_execution_enabled")
        .single();
      if (!gKill || gKill.value !== "true") {
        return DENIED("global_kill_switch: demo_execution_enabled=false。管理者が明示的に true にするまで実行しない。");
      }
    } catch {
      return DENIED("global_kill_switch: system_settings 取得失敗。Fail Closed。");
    }
  }

  // ── Check 3: Trader Kill Switch ───────────────────────────────
  if (trader.kill_switch) {
    return DENIED(`trader_kill_switch: ${trader.kill_switch_reason ?? "kill_switch=true"}`);
  }

  // ── Check 4: Demo Account Guard — FAIL CLOSED ────────────────
  if (!accountSnapshot) {
    return DENIED("demo_account_guard: Account Snapshot なし。Fail Closed。MT5 に接続しているか確認してください。");
  }
  if (accountSnapshot.accountType !== "DEMO") {
    return DENIED(`demo_account_guard: account_type=${accountSnapshot.accountType}。DEMO 以外では自動実行しない。`);
  }

  // ── Check 5: Hedging Mode Guard ───────────────────────────────
  // Phase 3 は Hedging 専用（NETTING では別ポジション概念が異なる）
  if (accountSnapshot.accountMode !== "HEDGING") {
    return DENIED(`hedging_guard: account_mode=${accountSnapshot.accountMode}。Phase 3 は HEDGING モード専用。`);
  }

  // ── Check 6: Account Snapshot Freshness ──────────────────────
  const accountAgeSeconds = (Date.now() - accountSnapshot.updatedAtMs) / 1000;
  if (accountAgeSeconds > profile.account_data_max_age_seconds) {
    return DENIED(`account_stale: Account データが ${accountAgeSeconds.toFixed(0)}秒前（上限 ${profile.account_data_max_age_seconds}秒）。最新の Heartbeat を確認してください。`);
  }
  if (accountSnapshot.equity <= 0) {
    return DENIED("account_equity_zero: Equity が 0 以下。口座確認が必要。");
  }

  // ── Check 7: Symbol Specification ────────────────────────────
  if (!symbolSpec) {
    return DENIED("symbol_spec_missing: Symbol Specification が DB にありません。Bridge EA を再起動して symbol spec を送信してください。");
  }
  if (symbolSpec.tickValue <= 0) {
    return DENIED(`symbol_spec_invalid: tickValue=${symbolSpec.tickValue}。有効な Symbol Specification が必要です。`);
  }
  if (symbolSpec.tickSize <= 0) {
    return DENIED(`symbol_spec_invalid: tickSize=${symbolSpec.tickSize}。有効な Symbol Specification が必要です。`);
  }

  // ── Check 8: Daily Risk Limits ────────────────────────────────
  const todayStr = todayUTC();
  let dailyReset = false;
  let tradeCount        = trader.daily_trade_count;
  let lossUsd           = trader.daily_loss_usd;
  let consecutiveLosses = trader.daily_consecutive_losses;

  if (trader.daily_stats_date !== todayStr) {
    tradeCount = 0; lossUsd = 0; consecutiveLosses = 0;
    dailyReset = true;
  }

  if (tradeCount >= profile.max_daily_trades) {
    return DENIED(`daily_trade_limit: 本日 ${tradeCount}/${profile.max_daily_trades} 回到達`);
  }
  if (lossUsd >= profile.max_daily_loss_usd) {
    return DENIED(`daily_loss_limit: 本日損失 $${lossUsd.toFixed(2)}/$${profile.max_daily_loss_usd}`);
  }
  if (consecutiveLosses >= profile.max_consecutive_losses) {
    return DENIED(`consecutive_losses: 連続損失 ${consecutiveLosses}/${profile.max_consecutive_losses} 回`);
  }

  // ── Check 9: Profile position ceiling ────────────────────────
  if (enforceProfileLimits) {
    if (openPositionCount >= (profile.max_positions as number)) {
      return DENIED(`max_positions_reached: ${openPositionCount}/${profile.max_positions}`);
    }
  } else if (openPositionCount > 0) {
    // Legacy strategy callers retain their pre-existing duplicate guard.
    return DENIED(`duplicate_position: このトレーダーに既に ${openPositionCount} 件の OPEN/PENDING ポジションがある`);
  }

  // ── Check 10: Live Quote Freshness ───────────────────────────
  if (!liveQuote) {
    return DENIED("tick_missing: Live Quote が取得できません。Gateway/MT5 接続を確認してください。");
  }
  const tickAgeSeconds = (Date.now() - liveQuote.timestampMs) / 1000;
  if (tickAgeSeconds > profile.tick_data_max_age_seconds) {
    return DENIED(`tick_stale: 最新 Tick が ${tickAgeSeconds.toFixed(0)}秒前（上限 ${profile.tick_data_max_age_seconds}秒）`);
  }
  if (liveQuote.bid <= 0 || liveQuote.ask <= 0) {
    return DENIED("tick_invalid: Bid/Ask が 0 以下。Live Quote が無効です。");
  }

  // ── Check 11: Spread Guard ────────────────────────────────────
  const maxSpread = profile.max_spread_points > 0
    ? profile.max_spread_points
    : symbolSpec.maxSpreadAllowed;
  if (maxSpread > 0 && liveQuote.spread > maxSpread) {
    return DENIED(`spread_too_wide: Spread ${liveQuote.spread}pts > 上限 ${maxSpread}pts`);
  }

  // ── Check 12: Decision Expiry ─────────────────────────────────
  // （execute route 側でも確認するが二重チェック）

  // ── Lot 計算準備 ──────────────────────────────────────────────
  const side: "BUY" | "SELL" = decision.decision === "ENTER_LONG" ? "BUY" : "SELL";
  // Entry price: BUY は Ask、SELL は Bid
  const entryPrice = side === "BUY" ? liveQuote.ask : liveQuote.bid;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return DENIED("invalid_entry_price: entry must be finite and positive");
  }

  const sl = decision.suggestedSl;
  const tp = decision.suggestedTp;

  if (!sl || sl <= 0) {
    return DENIED("no_stop_loss: SL が未指定。リスク計算不能。Fail Closed。");
  }
  if (!tp || tp <= 0) {
    return DENIED("no_take_profit: TP が未指定。RR 計算不能。");
  }

  if (side === "BUY" && tp <= entryPrice) return DENIED("invalid_tp_direction: BUY TP must be above entry");
  if (side === "SELL" && tp >= entryPrice) return DENIED("invalid_tp_direction: SELL TP must be below entry");

  // SL の方向チェック
  if (side === "BUY" && sl >= entryPrice) {
    return DENIED(`sl_wrong_side: BUY なのに SL(${sl}) >= Entry(${entryPrice})`);
  }
  if (side === "SELL" && sl <= entryPrice) {
    return DENIED(`sl_wrong_side: SELL なのに SL(${sl}) <= Entry(${entryPrice})`);
  }

  const slDistance = Math.abs(entryPrice - sl);
  const rr = calculateRiskReward(side, entryPrice, sl, tp);
  if (enforceProfileLimits && (rr === null || rr < (profile.minimum_rr as number))) {
    return DENIED(`minimum_rr_not_met: rr=${rr ?? "invalid"} < minimum_rr=${profile.minimum_rr}`);
  }

  // ── Check 14: Stop Level Validation ──────────────────────────
  if (symbolSpec.stopsLevelPrice > 0 && slDistance < symbolSpec.stopsLevelPrice) {
    return DENIED(`stops_level: SL距離 ${slDistance.toFixed(symbolSpec.digits)}pts < Broker stops_level ${symbolSpec.stopsLevelPrice.toFixed(symbolSpec.digits)}`);
  }
  if (slDistance < symbolSpec.tickSize) {
    return DENIED(`sl_too_tight: SL距離 ${slDistance.toFixed(symbolSpec.digits)} < tick_size ${symbolSpec.tickSize}`);
  }

  // ── Check 13: Tick-Value Based Lot Calculation ────────────────
  // risk_money = equity × risk_percent / 100
  // ticks_at_risk = sl_distance / tick_size
  // loss_per_lot = ticks_at_risk × tick_value
  // raw_lot = risk_money / loss_per_lot
  const riskUsd    = accountSnapshot.equity * (profile.max_risk_per_trade / 100);
  const ticksAtRisk = slDistance / symbolSpec.tickSize;
  const lossPerLot  = ticksAtRisk * symbolSpec.tickValue;

  if (lossPerLot <= 0) {
    return DENIED(`lot_calc_failure: lossPerLot=${lossPerLot}。Symbol Specification の tickValue を確認してください。`);
  }

  const rawLot = riskUsd / lossPerLot;
  if (!Number.isFinite(riskUsd) || !Number.isFinite(slDistance) || !Number.isFinite(ticksAtRisk) ||
      !Number.isFinite(lossPerLot) || !Number.isFinite(rawLot) || rawLot <= 0) {
    return DENIED("numeric_invalid: risk calculation is non-finite");
  }

  // Check: raw_lot < volumeMin → DENIED（volumeMin へ切り上げるとリスク超過する）
  if (rawLot < symbolSpec.volumeMin) {
    return DENIED(
      `lot_below_min: raw_lot ${rawLot.toFixed(4)} < volumeMin ${symbolSpec.volumeMin}。` +
      `volumeMin へ切り上げると risk_limit を超えるため DENIED。` +
      `equity=$${accountSnapshot.equity.toFixed(0)}, risk=${profile.max_risk_per_trade}%, SL距離=${slDistance.toFixed(2)}`
    );
  }

  // 切り捨て正規化（Risk Limit を超えない方向）
  const normalizedLot = normalizeLot(rawLot, symbolSpec);
  if (!Number.isFinite(normalizedLot) || normalizedLot <= 0) {
    return DENIED("numeric_invalid: normalized lot is non-finite");
  }

  // 正規化後が volumeMin を下回った場合も DENIED（切り捨て後に 0 になるケース）
  if (normalizedLot < symbolSpec.volumeMin) {
    return DENIED(`lot_normalized_below_min: 正規化後 ${normalizedLot} < volumeMin ${symbolSpec.volumeMin}`);
  }

  // ── Check 15: Margin Check ────────────────────────────────────
  // 簡易 Margin 推算: (lot × contractSize × entryPrice) / leverage
  // または symbolSpec.marginInitial × lot（per lot margin）
  let requiredMargin = 0;
  if (requireMarginValidation && !(symbolSpec.marginInitial > 0) ) {
    return DENIED("margin_data_unavailable: margin_initial is missing or zero");
  }
  if (symbolSpec.marginInitial > 0) {
    requiredMargin = symbolSpec.marginInitial * normalizedLot;
  }
  if (requireMarginValidation && (!Number.isFinite(accountSnapshot.freeMargin) || accountSnapshot.freeMargin <= 0)) {
    return DENIED("margin_data_unavailable: free_margin is missing or invalid");
  }
  if (requiredMargin > 0 && requiredMargin > accountSnapshot.freeMargin * 0.8) {
    // 余裕として free_margin の 80% を上限とする
    return DENIED(`margin_insufficient: 必要 Margin ≈ $${requiredMargin.toFixed(2)} > free_margin×0.8 $${(accountSnapshot.freeMargin * 0.8).toFixed(2)}`);
  }

  // ── Check 16: Total Exposure ──────────────────────────────────
  const newTotalLots = totalExposureLots + normalizedLot;
  if (newTotalLots > profile.max_total_exposure_lots) {
    return DENIED(`exposure_limit: 追加後 ${newTotalLots.toFixed(2)} lot > 上限 ${profile.max_total_exposure_lots} lot`);
  }

  return {
    approved:   true,
    lot:        normalizedLot,
    stopLoss:   sl,
    takeProfit: tp,
    side,
    entryPrice,
    expiresAt:  createCommandExpiryUtc(),
    dailyReset,
    calc: {
      riskUsd,
      slDistance,
      ticksAtRisk,
      lossPerLot,
      rawLot,
      normalizedLot,
      requiredMargin,
    },
  };
}

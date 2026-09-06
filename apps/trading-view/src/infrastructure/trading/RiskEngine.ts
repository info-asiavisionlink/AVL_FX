// =================================================================
// RiskEngine — AVL AI と MT5 の間の独立した検証レイヤー
//
// AI が生成した TradeProposal を受け取り、
// 口座状態・設定・市場条件に対して全チェックを実行する。
//
// 出力: APPROVED | REJECTED | MODIFIED
// AI はこのレイヤーを迂回できない。
// =================================================================

import type {
  TradeProposal, RiskDecision, RiskChecks,
  AccountSnapshot, PositionSnapshot,
} from "@/domain/trading/MarketSnapshot";
import { calcLot, makeSymbolSpec } from "./PositionSizer";

export interface RiskSettings {
  riskPctPerTrade:  number;   // 例: 0.25
  maxDailyLossPct:  number;   // 例: 2.0
  maxDrawdownPct:   number;   // 例: 5.0
  maxPositions:     number;   // 例: 5
  maxPositionsPerSymbol: number; // 例: 2
  maxLotSize:       number;   // 例: 1.0
  minLotSize:       number;   // 例: 0.01
  maxSpreadPips:    number;   // 例: 3.0
  minRR:            number;   // 例: 1.2
  minExpectedValue: number;   // 例: 0
  newsBlackoutMinutes: number; // 例: 30
  cooldownSeconds:  number;   // 例: 60
  enableLiveTrading: boolean;
}

// Cooldown tracker（インメモリ、サーバー再起動でリセット）
const recentSignals = new Map<string, number>();  // key → last approved timestamp

export function buildDefaultRiskSettings(): RiskSettings {
  return {
    riskPctPerTrade:      0.25,
    maxDailyLossPct:      2.0,
    maxDrawdownPct:       5.0,
    maxPositions:         5,
    maxPositionsPerSymbol: 2,
    maxLotSize:           1.0,
    minLotSize:           0.01,
    maxSpreadPips:        3.0,
    minRR:                1.2,
    minExpectedValue:     0,
    newsBlackoutMinutes:  30,
    cooldownSeconds:      60,
    enableLiveTrading:    false,  // デフォルト: 常に false
  };
}

interface ValidateInput {
  proposal:   TradeProposal;
  account:    AccountSnapshot | null;
  positions:  PositionSnapshot[];
  spread:     number;   // pips
  settings:   RiskSettings;
  newsRisk:   "HIGH" | "MEDIUM" | "LOW";
  symbolSpec?: { contractSize?: number; tickValue?: number; tickSize?: number; digits?: number };
}

export function validateTradeProposal(input: ValidateInput): RiskDecision {
  const { proposal, account, positions, spread, settings, newsRisk, symbolSpec } = input;
  const ts = new Date().toISOString();
  const checks: RiskChecks = {
    spreadOk:          true,
    marginOk:          true,
    dailyLossOk:       true,
    positionLimitOk:   true,
    symbolLimitOk:     true,
    newsBlackoutOk:    true,
    slValid:           true,
    tpValid:           true,
    rrMinOk:           true,
    expectedValueOk:   true,
    lotValid:          true,
    duplicateSignalOk: true,
    cooldownOk:        true,
  };
  const modifications: string[] = [];
  const rejections:    string[] = [];

  // WAIT は Risk Engine をスキップ
  if (proposal.decision === "WAIT") {
    return {
      status: "APPROVED", proposal, lot: 0,
      riskAmount: 0, riskPct: 0,
      checks, rejectionReason: null, modifications: [],
      timestamp: ts,
    };
  }

  // ── 1. スプレッドチェック ──────────────────────────────────────
  if (spread > settings.maxSpreadPips) {
    checks.spreadOk = false;
    rejections.push(`Spread ${spread.toFixed(1)}p > limit ${settings.maxSpreadPips}p`);
  }

  // ── 2. ニュースブラックアウト ──────────────────────────────────
  if (newsRisk === "HIGH") {
    checks.newsBlackoutOk = false;
    rejections.push("HIGH impact news within 2 hours — blackout active");
  } else if (newsRisk === "MEDIUM" && settings.newsBlackoutMinutes >= 60) {
    checks.newsBlackoutOk = false;
    rejections.push("MEDIUM impact news within 1 hour");
  }

  // ── 3. SL / TP 有効性 ──────────────────────────────────────────
  const { entry, stop_loss: sl, take_profit: tp, decision } = proposal;
  if (decision === "BUY") {
    if (sl >= entry) {
      checks.slValid = false;
      rejections.push(`BUY: SL (${sl}) must be below entry (${entry})`);
    }
    if (tp <= entry) {
      checks.tpValid = false;
      rejections.push(`BUY: TP (${tp}) must be above entry (${entry})`);
    }
  } else {
    if (sl <= entry) {
      checks.slValid = false;
      rejections.push(`SELL: SL (${sl}) must be above entry (${entry})`);
    }
    if (tp >= entry) {
      checks.tpValid = false;
      rejections.push(`SELL: TP (${tp}) must be below entry (${entry})`);
    }
  }

  // ── 4. RR チェック ─────────────────────────────────────────────
  const rr = proposal.risk_reward;
  if (rr < settings.minRR) {
    checks.rrMinOk = false;
    rejections.push(`RR ${rr.toFixed(2)} < minimum ${settings.minRR}`);
  }

  // ── 5. Expected Value チェック ─────────────────────────────────
  if (proposal.expected_value < settings.minExpectedValue) {
    checks.expectedValueOk = false;
    rejections.push(`EV ${proposal.expected_value.toFixed(2)} < minimum ${settings.minExpectedValue}`);
  }

  // ── 6. 口座チェック ────────────────────────────────────────────
  if (account) {
    // 日次損失上限
    const dailyLossPct = account.drawdownPct;
    if (dailyLossPct >= settings.maxDailyLossPct) {
      checks.dailyLossOk = false;
      rejections.push(`Daily loss ${dailyLossPct.toFixed(2)}% >= limit ${settings.maxDailyLossPct}%`);
    }

    // 最大ドローダウン
    if (account.drawdownPct >= settings.maxDrawdownPct) {
      checks.marginOk = false;
      rejections.push(`Drawdown ${account.drawdownPct.toFixed(2)}% >= limit ${settings.maxDrawdownPct}%`);
    }

    // 証拠金余裕（freeMargin が balance の 20% 以上）
    if (account.freeMargin < account.balance * 0.2) {
      checks.marginOk = false;
      rejections.push(`Free margin ${account.freeMargin.toFixed(0)} < 20% of balance`);
    }
  }

  // ── 7. ポジション数上限 ────────────────────────────────────────
  if (positions.length >= settings.maxPositions) {
    checks.positionLimitOk = false;
    rejections.push(`Open positions ${positions.length} >= limit ${settings.maxPositions}`);
  }

  // ── 8. シンボルごとポジション上限 ─────────────────────────────
  const symPositions = positions.filter(p => p.symbol === proposal.symbol).length;
  if (symPositions >= settings.maxPositionsPerSymbol) {
    checks.symbolLimitOk = false;
    rejections.push(`${proposal.symbol} positions ${symPositions} >= limit ${settings.maxPositionsPerSymbol}`);
  }

  // ── 9. クールダウン ────────────────────────────────────────────
  const cooldownKey = `${proposal.symbol}_${proposal.decision}`;
  const lastTs = recentSignals.get(cooldownKey) ?? 0;
  if (Date.now() - lastTs < settings.cooldownSeconds * 1000) {
    checks.cooldownOk = false;
    const elapsed = Math.round((Date.now() - lastTs) / 1000);
    rejections.push(`Cooldown active: ${elapsed}s / ${settings.cooldownSeconds}s`);
  }

  // ── 10. 動的ロットサイジング ───────────────────────────────────
  let lot = settings.minLotSize;
  let riskAmount = 0;
  let riskPct    = 0;

  if (account && checks.slValid) {
    const spec = makeSymbolSpec({ ...symbolSpec, digits: proposal.symbol.length === 6 ? 5 : 2 });
    const sized = calcLot({
      equity:     account.equity,
      riskPct:    settings.riskPctPerTrade,
      entry,
      stopLoss:   sl,
      takeProfit: tp,
      spec,
    });
    lot        = Math.min(sized.lot, settings.maxLotSize);
    riskAmount = sized.riskAmount;
    riskPct    = sized.riskPct;

    // ロット有効性チェック
    if (lot < settings.minLotSize) {
      modifications.push(`Lot raised to minimum ${settings.minLotSize}`);
      lot = settings.minLotSize;
      checks.lotValid = false;
    }
    if (lot > settings.maxLotSize) {
      modifications.push(`Lot capped at maximum ${settings.maxLotSize}`);
      lot = settings.maxLotSize;
    }
  }

  // ── 判定 ───────────────────────────────────────────────────────
  const critical = ["spreadOk","marginOk","dailyLossOk","positionLimitOk",
                    "symbolLimitOk","newsBlackoutOk","slValid","cooldownOk"] as (keyof RiskChecks)[];
  const hasCriticalFail = critical.some(k => !checks[k]);

  if (hasCriticalFail) {
    return {
      status: "REJECTED", proposal, lot, riskAmount, riskPct,
      checks, rejectionReason: rejections.join(" | "),
      modifications, timestamp: ts,
    };
  }

  // TP/RR/EV の警告は MODIFIED 扱い
  const hasWarning = rejections.length > 0;
  const status = hasWarning ? "MODIFIED" : "APPROVED";

  // クールダウンを更新（APPROVED / MODIFIED のみ — REJECTED は上でリターン済み）
  recentSignals.set(cooldownKey, Date.now());

  return {
    status,
    proposal: { ...proposal, risk_reward: rr },
    lot, riskAmount, riskPct,
    checks,
    rejectionReason: hasWarning ? rejections.join(" | ") : null,
    modifications,
    timestamp: ts,
  };
}

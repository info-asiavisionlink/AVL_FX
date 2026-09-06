// =================================================================
// POST /api/ai/strategy/preview-backtest
//
// StrategySpec を直接受け取り、DB登録なしでバックテストを実行する。
// PreviewBacktest用: ユーザーが承認する前の事前検証に使用。
//
// フロー:
//   1. StrategySpec Zod バリデーション
//   2. UNSUPPORTED 条件チェック
//   3. runBacktestCore 実行（DB書き込みなし）
//   4. 方向別集計 (BUY/SELL breakdown)
//   5. { report, trades, directionBreakdown, warnings } を返す
//
// ⚠️ この API は strategy_registry に何も書き込まない。
//    正式登録は POST /api/strategies (previewBacktestData付き) で行う。
// =================================================================

import { NextRequest, NextResponse }   from "next/server";
import { StrategySpecSchema }           from "@/lib/strategySchema";
import { runBacktestCore, type TradeForPromotion } from "@/infrastructure/backtest/BacktestService";

export const runtime = "nodejs";
export const maxDuration = 60;  // Backtest はデータ量によって時間がかかる

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { spec?: unknown };

    if (!body.spec) {
      return NextResponse.json(
        { success: false, error: "spec が必要です" },
        { status: 400 }
      );
    }

    // 1. Zod バリデーション
    const validation = StrategySpecSchema.safeParse(body.spec);
    if (!validation.success) {
      const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      return NextResponse.json(
        { success: false, error: "Strategy Spec が無効です", details: issues },
        { status: 422 }
      );
    }
    const spec = validation.data;

    // 2. UNSUPPORTED 条件チェック
    const unsupportedConditions = spec.entry_conditions.conditions
      .filter(c => c.condition?.startsWith("UNSUPPORTED:"))
      .map(c => c.condition!.replace("UNSUPPORTED:", "").trim());

    if (unsupportedConditions.length > 0) {
      return NextResponse.json(
        {
          success:     false,
          error:       "バックテスト未対応の条件が含まれています",
          unsupported: unsupportedConditions,
        },
        { status: 422 }
      );
    }

    // 3. SL / TP 確認
    if (!spec.exit_conditions?.stop_loss) {
      return NextResponse.json(
        { success: false, error: "損切り条件が設定されていません" },
        { status: 422 }
      );
    }
    if (!spec.exit_conditions?.take_profit) {
      return NextResponse.json(
        { success: false, error: "利確条件が設定されていません" },
        { status: 422 }
      );
    }

    // 4. バックテスト実行（DB 書き込みなし）
    const coreResult = await runBacktestCore({ spec, period: "AVAILABLE" });

    // 5. 方向別集計
    const buyTrades  = coreResult.trades.filter(t => t.direction === "BUY");
    const sellTrades = coreResult.trades.filter(t => t.direction === "SELL");

    function dirStats(trades: typeof coreResult.trades) {
      const wins = trades.filter(t => t.result === "WIN").length;
      const pips = trades.reduce((s, t) => s + t.pips, 0);
      return {
        trades:  trades.length,
        wins,
        pips:    Math.round(pips * 10) / 10,
        winRate: trades.length > 0 ? Math.round(wins / trades.length * 1000) / 10 : 0,
      };
    }

    const directionBreakdown = {
      buy:  dirStats(buyTrades),
      sell: dirStats(sellTrades),
    };

    // 6. TradeForPromotion にマッピング（client → server 境界で使う plain object）
    const promotionTrades: TradeForPromotion[] = coreResult.trades.map(t => ({
      symbol:        t.symbol,
      timeframe:     t.timeframe,
      direction:     t.direction,
      entryTime:     t.entryTime,
      entryPrice:    t.entryPrice,
      exitTime:      t.exitTime,
      exitPrice:     t.exitPrice,
      sl:            t.sl,
      tp:            t.tp,
      lot:           t.lot,
      pips:          t.pips,
      result:        t.result,
      exitReason:    t.exitReason,
      durationMin:   t.durationMin,
      spreadPips:    t.spreadPips,
      slippagePips:  t.slippagePips,
      entryBarIdx:   t.entryBarIdx,
      exitBarIdx:    t.exitBarIdx,
    }));

    return NextResponse.json({
      success:            true,
      report:             coreResult.report,
      trades:             promotionTrades,
      barCount:           coreResult.barCount,
      directionBreakdown,
      warnings:           coreResult.warnings,
    });

  } catch (err) {
    console.error("[preview-backtest]", err);
    const msg = err instanceof Error ? err.message : "バックテストエラー";
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}

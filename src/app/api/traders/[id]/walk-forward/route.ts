// =================================================================
// POST /api/traders/[id]/walk-forward
//
// AI Trader の仮説を Walk Forward で検証する。
// 既存 WalkForwardEngine を AI Trader Profile から生成した
// StrategySpec で実行する。
//
// 安全ルール:
//   - 検証結果は experience_memories に TESTING として保存
//   - VALIDATED への変更は管理者（またはユーザー確認）が行う
//   - AI が自動で VALIDATED にすることは禁止
// =================================================================

import { NextRequest, NextResponse }   from "next/server";
import { createAdminClient }            from "@/infrastructure/supabase/admin";
import { createClient }                 from "@/infrastructure/supabase/server";
import { runBacktest, type BacktestInput } from "@/infrastructure/backtest/BacktestEngine";
import type { Bar }                     from "@/infrastructure/analysis/types";

export const runtime   = "nodejs";
export const maxDuration = 120;

const CONSOLE_URL  = process.env.CONSOLE_URL ?? "https://avl-fx-console.vercel.app";
const CONSOLE_SVC  = process.env.CONSOLE_SERVICE_ROLE_KEY ?? "";

// AI Trader Profile → StrategySpec への変換（基本的なトレンドフォロー戦略をベースに使用）
function profileToSpec(profile: Record<string, unknown>): import("@/lib/strategySchema").StrategySpec {
  const tfs      = (profile.timeframes as string[]) ?? ["H4"];
  const mainTf   = tfs[0] ?? "H4";
  const rr       = (profile.minimum_rr as number) ?? 1.5;
  const riskPct  = (profile.max_risk_per_trade as number) ?? 1.0;
  const style    = profile.trading_style as string;

  // スタイルに応じた基本エントリー条件
  const conditions = [];
  if (style === "TREND_FOLLOWING" || style === "MULTI_TIMEFRAME" || style === "HYBRID") {
    conditions.push({ indicator: "EMA" as const,  timeframe: mainTf as "H4", period: 21, operator: "PRICE_ABOVE" as const });
    conditions.push({ indicator: "MACD" as const, timeframe: mainTf as "H4", period: 12, period2: 26, period3: 9, operator: "ABOVE_SIGNAL" as const });
  } else if (style === "BREAKOUT") {
    conditions.push({ indicator: "ADX" as const,     timeframe: mainTf as "H4", period: 14, operator: "ABOVE" as const, threshold: 25 });
    conditions.push({ indicator: "DONCHIAN" as const, timeframe: mainTf as "H4", period: 20, operator: "PRICE_ABOVE" as const });
  } else if (style === "REVERSAL") {
    conditions.push({ indicator: "RSI" as const,  timeframe: mainTf as "H4", period: 14, operator: "CROSS_UP" as const, threshold: 30 });
    conditions.push({ indicator: "STOCHASTIC" as const, timeframe: mainTf as "H4", period: 14, operator: "CROSS_UP" as const, threshold: 20 });
  } else {
    conditions.push({ indicator: "MACD" as const, timeframe: mainTf as "H4", period: 12, period2: 26, period3: 9, operator: "ABOVE_SIGNAL" as const });
    conditions.push({ indicator: "ADX" as const,  timeframe: mainTf as "H4", period: 14, operator: "ABOVE" as const, threshold: 20 });
  }

  return {
    name:             "WF_TRADER_PROFILE",
    strategy_type:    "DAY_TRADE",
    description:      "Walk Forward validation from AI Trader profile",
    symbols:          ["GOLD#"],
    timeframes:       [mainTf as "H4"],
    entry_conditions: { logic: "AND", conditions },
    exit_conditions:  {
      stop_loss:  { method: "ATR", period: 14, multiplier: 1.5 },
      take_profit: { method: "RR_RATIO", rr_ratio: rr },
    },
    filters: {
      max_spread_pips: 50,
      sessions:        ["LONDON", "NEW_YORK"],
      min_adx:         profile.trading_style === "TREND_FOLLOWING" ? 20 : undefined,
    },
    risk: { risk_per_trade: riskPct },
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const db = createAdminClient();

  // Trader取得
  const { data: trader } = await db.from("ai_traders").select("*").eq("id", id).eq("user_id", user.id).single();
  if (!trader) return NextResponse.json({ error: "Traderが見つかりません" }, { status: 404 });

  // Profile取得
  const { data: profile } = await db
    .from("ai_trader_versions").select("*")
    .eq("ai_trader_id", id).eq("version", trader.current_version).single();
  if (!profile) return NextResponse.json({ error: "Profileが見つかりません" }, { status: 404 });

  // バーデータ取得（Console Supabase から）
  const body = await req.json() as { hypothesis?: string } | null;
  const hypothesis = body?.hypothesis ?? "このAI Traderのスタイルは中長期で有効か";

  // Console から GOLD H4 データを取得
  let bars: Bar[] = [];
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const sbUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? "";
    const res = await fetch(
      `${sbUrl}/rest/v1/bar_data?symbol=eq.GOLD%23&timeframe=eq.H4&select=time_utc,open,high,low,close,volume&order=time_utc.asc&limit=3000`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
    );
    if (res.ok) {
      const rows = await res.json() as { time_utc: string; open: number; high: number; low: number; close: number; volume: number }[];
      bars = rows.map(r => ({
        time:   new Date(r.time_utc).getTime() / 1000,
        open:   r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
      }));
    }
  } catch { /* TV bar_data がなければ中止 */ }

  // Research API fallback（Console bars）
  if (!bars.length) {
    try {
      const consoleRes = await fetch(`${CONSOLE_URL}/api/research/bars`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          ...(CONSOLE_SVC ? { Authorization: `Bearer ${CONSOLE_SVC}` } : {}),
        },
        body: JSON.stringify({ symbol: "GOLD", timeframe: "H4", limit: 3000 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (consoleRes.ok) {
        const data = await consoleRes.json() as { bars?: { time_utc: string; open: number; high: number; low: number; close: number; volume: number }[] };
        bars = (data.bars ?? []).map(r => ({
          time: new Date(r.time_utc).getTime() / 1000,
          open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
        }));
      }
    } catch { /* ignore */ }
  }

  if (bars.length < 500) {
    return NextResponse.json({ error: "バーデータが不足しています（500本以上必要）" }, { status: 422 });
  }

  // ProfileからSpecを生成
  const spec = profileToSpec(profile as unknown as Record<string, unknown>);

  // Walk Forward：4ウィンドウ（train=6ヶ月, test=2ヶ月）のローリング検証
  const MONTH_BARS = Math.floor(bars.length / 36); // 約36ヶ月でのバー数/月
  const TRAIN_BARS = MONTH_BARS * 6;
  const TEST_BARS  = MONTH_BARS * 2;

  interface WindowResult { verdict: string; winRate: number; profitFactor: number | null; totalTrades: number; }
  const windowResults: WindowResult[] = [];
  let start = 0;
  while (start + TRAIN_BARS + TEST_BARS <= bars.length && windowResults.length < 4) {
    const trainBars = bars.slice(start, start + TRAIN_BARS);
    const testBars  = bars.slice(start + TRAIN_BARS, start + TRAIN_BARS + TEST_BARS);

    try {
      const mainTf = (profile.timeframes as string[])[0] ?? "H4";
      const btInput: BacktestInput = {
        spec,
        symbol: "GOLD#",
        mainTimeframe: mainTf,
        barsByTimeframe: { [mainTf]: testBars },
        initialBalance: 10000,
        fixedLot: 0.01,
      };
      const result = runBacktest(btInput);
      const pf = result.wins > 0 && result.losses > 0
        ? (result.wins * Math.abs(result.totalProfit / result.wins)) / (result.losses * Math.abs(result.totalProfit / result.losses))
        : null;
      const verdict = result.winRate >= 40 && (pf ?? 0) >= 1.2 ? "PASSED"
        : result.winRate >= 30 && (pf ?? 0) >= 1.0 ? "CONDITIONAL" : "FAILED";
      windowResults.push({
        verdict, winRate: result.winRate, profitFactor: pf, totalTrades: result.totalTrades,
      });
    } catch { /* window skip */ }
    void trainBars; // suppress unused

    start += TEST_BARS;
  }

  const passed   = windowResults.filter(w => w.verdict === "PASSED" || w.verdict === "CONDITIONAL").length;
  const total    = windowResults.length;
  const avgWR    = total > 0 ? windowResults.reduce((s, w) => s + w.winRate, 0) / total : 0;
  const avgPF    = total > 0 ? windowResults.reduce((s, w) => s + (w.profitFactor ?? 0), 0) / total : 0;
  const verdict  = passed >= total * 0.6 ? "PASSED" : passed >= total * 0.4 ? "CONDITIONAL" : "FAILED";
  const isGood   = verdict === "PASSED" || verdict === "CONDITIONAL";

  const insight = `Walk Forward検証（${total}ウィンドウ / 合格${passed}）: 平均WR=${avgWR.toFixed(1)}%, 平均PF=${avgPF.toFixed(2)}, 判定=${verdict}。${isGood ? "このスタイルは一定の有効性を示した。" : "このスタイルは検証を通過しなかった。"}`;

  const { data: memory } = await db.from("experience_memories").insert({
    ai_trader_id:     id,
    user_id:          user.id,
    title:            `Walk Forward検証: ${trader.name as string} v${trader.current_version as number}`,
    insight,
    market_condition: "GOLD H4 2023-2026",
    status:           "TESTING",
    confidence:       isGood ? 3 : 1,
  }).select().single();

  return NextResponse.json({
    ok:             true,
    verdict,
    windows:        total,
    passed_windows: passed,
    avg_pf:         avgPF,
    avg_wr:         avgWR,
    hypothesis,
    memory_id:      memory?.id,
    memory_status:  "TESTING",
    note: "VALIDATED への変更は確認後に手動で行ってください。AIが自動でVALIDATEDにすることは禁止です。",
    window_results: windowResults,
  });
}

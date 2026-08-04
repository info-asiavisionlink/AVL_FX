// =================================================================
// POST /api/ai/agent-pipeline
// OpenAI Agents SDK — マルチエージェント分析パイプライン
//
// MarketAgent → AnalysisAgent → DecisionAgent
//
// MarketAgent:   市場データ取得・整理
// AnalysisAgent: テクニカル分析・シグナル検出
// DecisionAgent: 最終的な取引判断・提案生成
// =================================================================

import { NextRequest, NextResponse }       from "next/server";
import { Agent, tool, run }                from "@openai/agents";
import { z }                               from "zod";

export const runtime = "nodejs";

// エージェントが共有する市場コンテキスト（リクエストスコープ）
interface MarketCtx {
  symbol:     string;
  indicators: Record<string, { ema21: number; ema200: number; atr: number }>;
  spread:     number;
  bid:        number;
  ask:        number;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY 未設定" }, { status: 500 });

  const { symbol = "EURUSD", indicators = {}, spread = 0, bid = 0, ask = 0 } =
    await req.json() as Partial<MarketCtx>;

  const ctx: MarketCtx = { symbol, indicators, spread, bid, ask };

  // ─── ツール定義 ─────────────────────────────────────────────

  const getMarketSummaryTool = tool({
    name:        "get_market_summary",
    description: "現在の市場データ（価格・EMA・ATR・スプレッド）をまとめて取得する",
    parameters:  z.object({}),
    execute: async () => {
      const lines = [`Symbol: ${ctx.symbol}`, `Bid/Ask: ${ctx.bid.toFixed(5)} / ${ctx.ask.toFixed(5)}`, `Spread: ${ctx.spread.toFixed(1)} pips`];
      for (const [tf, v] of Object.entries(ctx.indicators)) {
        const dir = v.ema21 > v.ema200 ? "↑BULL" : "↓BEAR";
        lines.push(`${tf}: EMA21=${v.ema21.toFixed(5)} EMA200=${v.ema200.toFixed(5)} ATR=${v.atr.toFixed(5)} ${dir}`);
      }
      return lines.join("\n");
    },
  });

  const detectTrendAlignTool = tool({
    name:        "detect_trend_alignment",
    description: "H4・H1・M15 のトレンドが揃っているか検出する",
    parameters:  z.object({}),
    execute: async () => {
      const tfs   = ["H4", "H1", "M15"] as const;
      const dirs  = tfs.map(tf => {
        const v = ctx.indicators[tf];
        return v ? (v.ema21 > v.ema200 ? "up" : "down") : null;
      }).filter(Boolean);
      if (dirs.length < 3)           return "データ不足: トレンドアライン判定不可";
      if (dirs.every(d => d === dirs[0])) return `トレンドアライン: H4/H1/M15 が ${dirs[0] === "up" ? "上昇" : "下降"} 方向に揃っています`;
      return `トレンド不一致: H4=${dirs[0]} H1=${dirs[1]} M15=${dirs[2]}`;
    },
  });

  const calcEntryParamsTool = tool({
    name:        "calculate_entry_params",
    description: "エントリー価格・SL・TP・RR を計算する",
    parameters:  z.object({
      direction: z.enum(["BUY", "SELL"]),
      tf:        z.string().describe("基準時間足 例: H4"),
    }),
    execute: async ({ direction, tf }) => {
      const v = ctx.indicators[tf] ?? ctx.indicators["H4"] ?? ctx.indicators["H1"];
      if (!v) return "指標データなし";
      const entry = direction === "BUY" ? ctx.ask : ctx.bid;
      const atr   = v.atr;
      const sl    = direction === "BUY" ? entry - atr * 1.5 : entry + atr * 1.5;
      const tp    = direction === "BUY" ? entry + atr * 3.0 : entry - atr * 3.0;
      const rr    = "1:2";
      return JSON.stringify({ direction, entry: +entry.toFixed(5), sl: +sl.toFixed(5), tp: +tp.toFixed(5), rr, volume: 0.01, magic: 99999 });
    },
  });

  // ─── エージェント定義 ────────────────────────────────────────

  const decisionAgent = new Agent({
    name:         "DecisionAgent",
    model:        "gpt-4.1-mini",
    instructions: `あなたは FX 取引判断エージェントです。
AnalysisAgent からの分析結果をもとに最終的な取引判断を行います。

必ず以下の JSON 形式で出力してください:
{
  "decision": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "entry": 価格,
  "sl": SL価格,
  "tp": TP価格,
  "rr": "1:2",
  "volume": 0.01,
  "reason": "判断根拠（100文字以内）",
  "warnings": ["注意事項"]
}

判断基準:
- confidence 70以上でのみ BUY/SELL を推奨
- スプレッドが 5pips 以上なら HOLD
- トレンドアライン（H4/H1/M15 同方向）で confidence +20
- EMA クロスで confidence +15`,
    tools: [getMarketSummaryTool, calcEntryParamsTool],
  });

  const analysisAgent = new Agent({
    name:         "AnalysisAgent",
    model:        "gpt-4.1-mini",
    instructions: `あなたは FX テクニカル分析エージェントです。
市場データを分析して DecisionAgent に引き渡します。

分析項目:
1. EMA21/EMA200 のトレンド方向（各時間足）
2. トレンドアライン（H4/H1/M15 が同方向か）
3. ATR によるボラティリティ判定
4. スプレッド異常チェック
5. エントリー方向の仮説（BUY/SELL/HOLD）

分析完了後は DecisionAgent に引き渡してください。`,
    handoffs:    [decisionAgent],
    tools:       [getMarketSummaryTool, detectTrendAlignTool],
  });

  const marketAgent = new Agent({
    name:         "MarketAgent",
    model:        "gpt-4.1-mini",
    instructions: `あなたは市場データ収集エージェントです。
市場の現状を把握して AnalysisAgent に引き渡します。

手順:
1. get_market_summary で全市場データを取得
2. データを整理してサマリーをまとめる
3. AnalysisAgent に引き渡す`,
    handoffs:    [analysisAgent],
    tools:       [getMarketSummaryTool],
  });

  // ─── パイプライン実行 ────────────────────────────────────────

  try {
    const result = await run(marketAgent, `${symbol} の市場を分析して取引判断を行ってください。`, {
      maxTurns: 15,
    });

    // 最終出力を取得
    const output = result.finalOutput ?? "";

    // JSON 部分を抽出
    const jsonMatch = output.match(/\{[\s\S]*?"decision"[\s\S]*?\}/);
    let parsed: Record<string, unknown> | null = null;
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>; } catch { /* ignore */ }
    }

    return NextResponse.json({
      output,
      decision: parsed,
      symbol,
      runId:    result.lastAgent?.name ?? "unknown",
      ts:       Date.now(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agent-pipeline]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextRequest, NextResponse }       from "next/server";
import { Agent, tool, run }                from "@openai/agents";
import { z }                               from "zod";
import { getOpenAIClient, MODELS, KNOWLEDGE_STORE_ID } from "@/infrastructure/ai/openai-client";

export const runtime = "nodejs";

const GATEWAY = process.env.MT5_GATEWAY_URL ?? "http://127.0.0.1:8080";

async function gatewayFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      signal: AbortSignal.timeout(5000),
      headers: process.env.MT5_GATEWAY_SECRET ? { Authorization: `Bearer ${process.env.MT5_GATEWAY_SECRET}` } : {},
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY 未設定" }, { status: 500 });

  const { symbol = "EURUSD" } = await req.json() as { symbol?: string };
  const sym = symbol.toUpperCase().replace("/", "");

  const getLiveMarketData = tool({
    name: "get_live_market_data",
    description: "指定シンボルのライブ価格・インジケーター・バーデータをGatewayから取得",
    parameters: z.object({ symbol: z.string() }),
    execute: async ({ symbol: s }) => {
      const key = s.toUpperCase().replace("/", "");
      const [tick, indicators, barsH4, barsD1] = await Promise.all([
        gatewayFetch<{bid:number;ask:number;spread:number}>(`/tick/${key}`),
        gatewayFetch<{spread:number;timeframes:Record<string,unknown>}>(`/indicators/${key}`),
        gatewayFetch<unknown[]>(`/bars/${key}/H4?count=50`),
        gatewayFetch<unknown[]>(`/bars/${key}/D1?count=20`),
      ]);
      return JSON.stringify({ symbol: key, tick, indicators, barsH4Count: barsH4?.length ?? 0, barsD1Count: barsD1?.length ?? 0 });
    },
  });

  const getCorrelatedMarkets = tool({
    name: "get_correlated_markets",
    description: "相関する市場の現在価格を取得",
    parameters: z.object({ symbol: z.string() }),
    execute: async ({ symbol: s }) => {
      const key = s.toUpperCase().replace("/", "");
      const correlations: Record<string, string[]> = {
        EURUSD: ["GBPUSD", "USDJPY", "USDX-SEP26"],
        USDJPY: ["USDX-SEP26", "US30Cash", "JP225Cash"],
        GBPUSD: ["EURUSD", "USDX-SEP26"],
        XAUUSD: ["USDX-SEP26", "EURUSD", "SILVER"],
        GOLD:   ["USDX-SEP26", "EURUSD", "SILVER"],
      };
      const corrSyms = correlations[key] ?? ["USDX-SEP26"];
      const ticks = await Promise.all(corrSyms.map(cs =>
        gatewayFetch<{bid:number;ask:number}>(`/tick/${cs}`).then(t => ({ symbol: cs, ...(t ?? {bid:0,ask:0}) }))
      ));
      return JSON.stringify(ticks);
    },
  });

  const getFullAnalysis = tool({
    name: "get_full_analysis",
    description: "AVL FX分析エンジンの完全な多要素分析を実行",
    parameters: z.object({ symbol: z.string() }),
    execute: async ({ symbol: s }) => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/ai/analysis/full`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: s }),
        });
        if (!res.ok) return `Analysis failed: ${res.status}`;
        const data = await res.json() as {overall:{confidence:number;direction:string;tradeable:boolean};tradeSetup:unknown;aiSynthesis:string};
        return JSON.stringify({
          overall: data.overall,
          tradeSetup: data.tradeSetup,
          synthesis: data.aiSynthesis,
        });
      } catch (e) { return `Analysis error: ${String(e)}`; }
    },
  });

  const getEconomicEvents = tool({
    name: "get_economic_events",
    description: "今後24時間の高影響経済指標イベントを取得",
    parameters: z.object({}),
    execute: async () => {
      try {
        const { getUpcomingEvents } = await import("@/infrastructure/supabase/repository");
        const currencies = sym.length === 6 ? [sym.slice(0,3), sym.slice(3)] : ["USD"];
        const events = await getUpcomingEvents(currencies, 24);
        if (!events || events.length === 0) return "今後24時間に高影響イベントなし";
        return JSON.stringify(events.slice(0, 5).map(e => ({
          time: e.event_time, currency: e.currency, title: e.title,
          impact: e.impact === 3 ? "HIGH" : "MEDIUM", forecast: e.forecast,
        })));
      } catch { return "経済指標データ取得失敗"; }
    },
  });

  const proposeTradeDecision = tool({
    name: "propose_trade_decision",
    description: "最終的なトレード判断を構造化データとして提案（実際の注文は行わない）",
    parameters: z.object({
      decision: z.enum(["BUY", "SELL", "HOLD"]),
      confidence: z.number().min(0).max(100),
      entry: z.number(),
      sl: z.number(),
      tp1: z.number(),
      tp2: z.number(),
      rr: z.string(),
      volume: z.number().default(0.01),
      reason: z.string(),
      keyRisks: z.array(z.string()),
      requiresHumanApproval: z.boolean().default(true),
    }),
    execute: async (params) => {
      return JSON.stringify({ ...params, status: "proposed", requiresHumanApproval: true });
    },
  });

  const model = MODELS.chat;

  const decisionAgent = new Agent({
    name: "DecisionAgent",
    model,
    instructions: `あなたはAVL FX取引判断エージェントです。
AnalysisAgentからの詳細分析を受け取り、最終的なトレード判断を下します。

【絶対ルール】
- propose_trade_decision ツールを必ず呼び出して判断を記録すること
- confidence 70%未満の場合は必ず decision="HOLD" にすること
- スプレッドが3pips超の場合はHOLD
- 高影響経済指標の2時間以内はHOLD
- 自動発注は絶対禁止。requiresHumanApproval=true を常に設定
- 複数の根拠がある場合のみBUY/SELLを推奨

【判断に必要な情報】
1. ダウ理論によるトレンド方向
2. マルチタイムフレームの一致度
3. 直近サポート/レジスタンスレベル
4. 経済指標リスク
5. 相関市場の方向確認

判断後は日本語で簡潔に説明してください。`,
    tools: [proposeTradeDecision, getLiveMarketData],
  });

  const analysisAgent = new Agent({
    name: "AnalysisAgent",
    model,
    instructions: `あなたはAVL FXテクニカル分析エージェントです。
市場データを受け取り、多要素分析を実行してDecisionAgentに引き渡します。

【分析手順】
1. get_full_analysis で完全な多要素分析を実行
2. get_correlated_markets で相関市場を確認
3. get_economic_events で経済指標リスクを確認
4. 以下を判断してDecisionAgentに渡す:
   - ダウ理論のトレンド方向と信頼度
   - マルチTFアライメント
   - S/Rレベル（エントリー・SL・TP候補）
   - 相関確認
   - 経済指標リスクレベル
5. DecisionAgentにhandoffする

分析は必ず複数の根拠を組み合わせること。`,
    handoffs: [decisionAgent],
    tools: [getFullAnalysis, getCorrelatedMarkets, getEconomicEvents],
  });

  const marketAgent = new Agent({
    name: "MarketAgent",
    model,
    instructions: `あなたはAVL FX市場データ収集エージェントです。
${sym}の市場状況を収集しAnalysisAgentに引き渡します。

【手順】
1. get_live_market_data で${sym}のライブデータを取得
2. データを整理してサマリーを作成
3. AnalysisAgentにhandoffする

効率的に動作し、必要なデータを素早く収集すること。`,
    handoffs: [analysisAgent],
    tools: [getLiveMarketData],
  });

  try {
    const result = await run(marketAgent, `${sym}の完全な市場分析と取引判断を実行してください。`, {
      maxTurns: 20,
    });

    const output = result.finalOutput ?? "";

    let decision: Record<string, unknown> | null = null;

    const jsonMatches = output.match(/\{[\s\S]*?"decision"[\s\S]*?"confidence"[\s\S]*?\}/g);
    if (jsonMatches && jsonMatches.length > 0) {
      try {
        decision = JSON.parse(jsonMatches[jsonMatches.length - 1]) as Record<string, unknown>;
      } catch { /* ignore */ }
    }

    return NextResponse.json({
      output,
      decision,
      symbol: sym,
      runId: result.lastAgent?.name ?? "unknown",
      ts: Date.now(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agent-pipeline]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

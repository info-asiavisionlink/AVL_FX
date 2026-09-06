import { NextRequest, NextResponse }       from "next/server";
import { Agent, tool, run }                from "@openai/agents";
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

// Plain JSON schema for tool parameters (avoids Zod v3/v4 type conflict with @openai/agents)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const symbolSchema: any = { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emptySchema: any = { type: "object", properties: {}, required: [] };

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY 未設定" }, { status: 500 });

  const { symbol = "EURUSD" } = await req.json() as { symbol?: string };
  const sym = symbol.toUpperCase().replace("/", "");

  const getLiveMarketData = tool({
    name: "get_live_market_data",
    description: "指定シンボルのライブ価格・インジケーター・バーデータをGatewayから取得",
    parameters: symbolSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (input: any) => {
      const key = input.symbol.toUpperCase().replace("/", "");
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
    parameters: symbolSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (input: any) => {
      const key = input.symbol.toUpperCase().replace("/", "");
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
    parameters: symbolSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (input: any) => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/ai/analysis/full`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: input.symbol }),
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
    parameters: emptySchema,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: { type: "object", properties: {
        decision: { type: "string", enum: ["BUY", "SELL", "HOLD"] },
        confidence: { type: "number" }, entry: { type: "number" }, sl: { type: "number" },
        tp1: { type: "number" }, tp2: { type: "number" }, rr: { type: "string" },
        volume: { type: "number" }, reason: { type: "string" },
        keyRisks: { type: "array", items: { type: "string" } },
        requiresHumanApproval: { type: "boolean" },
      }, required: ["decision","confidence","entry","sl","tp1","tp2","rr","reason","keyRisks","requiresHumanApproval"],
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (params: any) => {
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
5. DecisionAgentにhandoffする`,
    tools: [getFullAnalysis, getCorrelatedMarkets, getEconomicEvents, getLiveMarketData],
    handoffs: [decisionAgent],
  });

  void getOpenAIClient(); // ensure configured
  const knowledgeStoreId = KNOWLEDGE_STORE_ID;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await run(analysisAgent, `シンボル: ${sym}\n\n上記シンボルの完全な市場分析を実行し、トレード判断を提案してください。`, {
      maxTurns: 20,
      ...(knowledgeStoreId ? { context: { knowledgeStoreId } } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = result.messages ?? result.state?.messages ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
    const content = Array.isArray(lastAssistant?.content)
      ? lastAssistant.content.map((c: {type?: string; text?: string}) => c.type === "text" ? c.text : "").join("")
      : String(lastAssistant?.content ?? "");

    // Find proposed trade from tool calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolOutputs = messages.filter((m: any) => m.role === "tool").map((m: any) => {
      try { return typeof m.content === "string" ? JSON.parse(m.content) : m.content; }
      catch { return null; }
    }).filter(Boolean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proposedTrade = toolOutputs.find((o: any) => o?.status === "proposed");

    return NextResponse.json({
      symbol: sym,
      analysis: content,
      proposedTrade: proposedTrade ?? null,
      requiresHumanApproval: true,
    });
  } catch (e) {
    console.error("Agent pipeline error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

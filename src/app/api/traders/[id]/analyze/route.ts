// =================================================================
// POST /api/traders/[id]/analyze
//
// AI Trader が現在の相場を分析し、シナリオと判断を生成する。
//
// フロー:
//   1. Gateway/Supabase から最新バーを取得
//   2. AI Trader の Profile + Knowledge を取得
//   3. AI に相場分析を依頼
//   4. シナリオを ai_trader_scenarios に保存
//   5. トレード判断（BUY/SELL/WAIT）を trade_decisions に保存
//
// 安全ルール:
//   - AI の判断は PENDING として保存（自動実行しない）
//   - ユーザーの承認なしに execution_command を発行しない
// =================================================================

import { NextRequest, NextResponse }    from "next/server";
import { createAdminClient }             from "@/infrastructure/supabase/admin";
import { createClient }                  from "@/infrastructure/supabase/server";
import { getOpenAIClient, MODELS }       from "@/infrastructure/ai/openai-client";
import { addMinutes }                    from "date-fns";

export const runtime   = "nodejs";
export const maxDuration = 60;

const GATEWAY_URL    = process.env.MT5_GATEWAY_URL    ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";
const CONSOLE_URL    = process.env.CONSOLE_URL         ?? "https://avl-fx-console.vercel.app";
const KNOWLEDGE_API_SECRET = process.env.KNOWLEDGE_API_SECRET ?? "";

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchRecentBars(connectionId: string, symbol: string, tf: string, count = 100): Promise<Bar[]> {
  if (!GATEWAY_URL) return [];
  try {
    const url = `${GATEWAY_URL}/connections/${connectionId}/bars/${encodeURIComponent(symbol)}/${tf}?count=${count}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    return (await res.json()) as Bar[];
  } catch { return []; }
}

async function fetchBarsFallback(symbol: string, tf: string, count = 100, supabaseUrl: string, svcKey: string): Promise<Bar[]> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/bar_data?symbol=eq.${encodeURIComponent(symbol)}&timeframe=eq.${tf}&select=time_utc,open,high,low,close,volume&order=time_utc.desc&limit=${count}`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
    );
    if (!res.ok) return [];
    const rows = await res.json() as { time_utc: string; open: number; high: number; low: number; close: number; volume: number }[];
    return rows.reverse().map(r => ({ time: new Date(r.time_utc).getTime() / 1000, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  } catch { return []; }
}

function summarizeBars(bars: Bar[], tf: string): string {
  if (!bars.length) return "データなし";
  const last  = bars[bars.length - 1];
  const prev  = bars[bars.length - 2] ?? last;
  const high  = Math.max(...bars.slice(-20).map(b => b.high));
  const low   = Math.min(...bars.slice(-20).map(b => b.low));
  const trend = bars.length > 20
    ? (bars[bars.length - 1].close > bars[bars.length - 20].close ? "上昇" : "下降")
    : "不明";
  return `${tf}: 現値=${last.close.toFixed(2)} 前足=${prev.close.toFixed(2)} 直近20本高値=${high.toFixed(2)} 安値=${low.toFixed(2)} トレンド=${trend}`;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  // Cron からの呼び出しも許可（x-cron-secret + x-user-id ヘッダー）
  const cronSecret = process.env.CRON_SECRET ?? "";
  const isCron = cronSecret && _req.headers.get("x-cron-secret") === cronSecret;
  const cronUserId = isCron ? (_req.headers.get("x-user-id") ?? "") : null;

  if (!user && !isCron) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const effectiveUserId = user?.id ?? cronUserId ?? "";
  const db = createAdminClient();

  // Trader取得（所有権確認）
  const { data: trader } = await db.from("ai_traders").select("*").eq("id", id).eq("user_id", effectiveUserId).single();
  if (!trader) return NextResponse.json({ error: "Traderが見つかりません" }, { status: 404 });

  // Current Profile取得
  const { data: profile } = await db
    .from("ai_trader_versions").select("*")
    .eq("ai_trader_id", id).eq("version", trader.current_version).single();
  if (!profile) return NextResponse.json({ error: "Profileが見つかりません" }, { status: 404 });

  // Knowledge取得（スナップショット）
  const { data: knowledgeLinks } = await db
    .from("ai_trader_knowledge").select("*").eq("ai_trader_version_id", profile.id);

  // Knowledge本文取得（Console API）
  let knowledgeTexts: string[] = [];
  if (knowledgeLinks && knowledgeLinks.length > 0) {
    try {
      const res = await fetch(`${CONSOLE_URL}/api/trading-knowledge?status=ACTIVE`, {
        headers: { "x-knowledge-api-secret": KNOWLEDGE_API_SECRET },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const data = await res.json() as { items?: { id: string; title: string; content: string }[] };
        const selected = new Set(knowledgeLinks.map((k: Record<string, unknown>) => k.knowledge_id as string));
        knowledgeTexts = (data.items ?? [])
          .filter(k => selected.has(k.id))
          .map(k => `【${k.title}】${k.content.slice(0, 800)}`);
      }
    } catch { /* Knowledge なくても分析は続行 */ }
  }

  // MT5接続確認
  const { data: conn } = await db
    .from("mt5_connections").select("id, last_heartbeat_at")
    .eq("user_id", effectiveUserId).order("created_at", { ascending: false }).limit(1).single();

  const mt5Online = conn && (Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime()) < 90_000;

  // バー取得（H4 + 主要TF）
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const sbUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? "";
  const symbol = trader.market === "GOLD" ? "GOLD#" : trader.market as string;
  const tfs    = (profile.timeframes as string[]).slice(0, 3);

  const barSummaries: string[] = [];
  for (const tf of tfs) {
    let bars: Bar[] = [];
    if (mt5Online) bars = await fetchRecentBars(conn.id, symbol, tf, 100);
    if (!bars.length) bars = await fetchBarsFallback(symbol, tf, 100, sbUrl, svcKey);
    if (bars.length) barSummaries.push(summarizeBars(bars, tf));
  }

  // 現在のシナリオ取得
  const { data: currentScenario } = await db
    .from("ai_trader_scenarios")
    .select("*").eq("ai_trader_id", id).eq("is_active", true)
    .order("created_at", { ascending: false }).limit(1).single();

  // 過去の経験を取得（VALIDATED のみ）
  const { data: memories } = await db
    .from("experience_memories")
    .select("title, insight").eq("ai_trader_id", id).eq("status", "VALIDATED").limit(5);

  // AI プロンプト構築
  const prompt = buildAnalysisPrompt(profile, barSummaries, knowledgeTexts, currentScenario, memories ?? []);

  const client = getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "現在の相場を分析して判断を出してください。" },
    ],
    max_completion_tokens: 1500,
    response_format: { type: "json_object" },
  });

  const rawText = completion.choices[0]?.message?.content ?? "{}";
  let analysis: AIAnalysis;
  try {
    analysis = JSON.parse(rawText) as AIAnalysis;
  } catch {
    return NextResponse.json({ error: "AI の応答が不正です" }, { status: 422 });
  }

  // シナリオ保存（既存をINACTIVE化）
  if (currentScenario) {
    await db.from("ai_trader_scenarios").update({ is_active: false }).eq("id", currentScenario.id);
  }

  const lastBar = barSummaries[0];
  const refPrice = lastBar ? parseFloat(lastBar.split("現値=")[1]?.split(" ")[0] ?? "0") || null : null;

  const { data: newScenario } = await db.from("ai_trader_scenarios").insert({
    ai_trader_id:     id,
    user_id:          effectiveUserId,
    is_active:        true,
    state:            analysis.decision === "WAIT" ? "WAITING" : "CONSIDERING",
    bias:             analysis.bias ?? "NEUTRAL",
    scenario_text:    analysis.scenario,
    watch_zone_low:   analysis.watch_zone?.low ?? null,
    watch_zone_high:  analysis.watch_zone?.high ?? null,
    invalidate_below: analysis.invalidate_below ?? null,
    invalidate_above: analysis.invalidate_above ?? null,
    recheck_triggers: analysis.recheck_triggers ?? [],
    market:           trader.market as string,
    reference_price:  refPrice,
    bar_time:         new Date().toISOString(),
    ai_model:         MODELS.chat,
    ai_reasoning:     analysis.reasoning,
  }).select().single();

  // トレード判断が BUY/SELL の場合、trade_decisions に保存（PENDING）
  let decision = null;
  if (analysis.decision === "BUY" || analysis.decision === "SELL") {
    const expiresAt = addMinutes(new Date(), 30); // 30分以内に承認しなければEXPIRED
    const { data: dec } = await db.from("trade_decisions").insert({
      ai_trader_id:         id,
      ai_trader_version_id: profile.id,
      user_id:              effectiveUserId,
      scenario_id:          newScenario?.id ?? null,
      decision:             analysis.decision,
      market:               trader.market as string,
      symbol:               symbol,
      reference_price:      refPrice,
      suggested_sl:         analysis.suggested_sl ?? null,
      suggested_tp:         analysis.suggested_tp ?? null,
      suggested_volume:     analysis.suggested_volume ?? null,
      reasoning:            analysis.reasoning,
      market_context:       { bar_summaries: barSummaries, analyzed_at: new Date().toISOString() },
      status:               "PENDING",
      expires_at:           expiresAt.toISOString(),
    }).select().single();
    decision = dec;
  }

  return NextResponse.json({
    ok:       true,
    scenario: newScenario,
    decision,
    analysis: {
      decision:   analysis.decision,
      bias:       analysis.bias,
      confidence: analysis.confidence,
      reasoning:  analysis.reasoning,
      scenario:   analysis.scenario,
    },
  });
}

// ── AI Analysis Output Schema ─────────────────────────────────────
interface AIAnalysis {
  decision:         "BUY" | "SELL" | "WAIT" | "EXIT";
  bias:             "LONG" | "SHORT" | "NEUTRAL";
  confidence:       number; // 1-5
  reasoning:        string;
  scenario:         string;
  watch_zone?:      { low: number; high: number };
  invalidate_below?: number;
  invalidate_above?: number;
  recheck_triggers: string[];
  suggested_sl?:    number;
  suggested_tp?:    number;
  suggested_volume?: number;
}

function buildAnalysisPrompt(
  profile: Record<string, unknown>,
  barSummaries: string[],
  knowledgeTexts: string[],
  currentScenario: Record<string, unknown> | null,
  memories: { title: string; insight: string }[]
): string {
  const personalityMap: Record<string, string> = {
    CONSERVATIVE: "非常に慎重。確信がなければWAITを選ぶ。",
    BALANCED:     "バランス重視。適切なセットアップを待つ。",
    AGGRESSIVE:   "積極的。早めのエントリーを好む。",
  };

  return `あなたは${profile.personality as string}な性格の${profile.trading_style as string}スタイルのFX AIトレーダーです。

## あなたのプロフィール
- 性格: ${personalityMap[profile.personality as string] ?? profile.personality}
- スタイル: ${profile.trading_style}
- リスク: ${profile.risk_profile}（最大${profile.max_risk_per_trade}%/トレード）
- エントリー慎重さ: ${profile.entry_patience}
- ニュース感度: ${profile.news_sensitivity}
- ボラティリティ: ${profile.volatility_preference}
- 最小RR: ${profile.minimum_rr}:1
- 行動指針: ${profile.instructions ?? "なし"}

## 現在の相場データ
${barSummaries.join("\n")}

## あなたが持つ知識
${knowledgeTexts.length > 0 ? knowledgeTexts.join("\n\n") : "（知識なし）"}

${currentScenario ? `## 前回のシナリオ\n状態: ${currentScenario.state}\nバイアス: ${currentScenario.bias}\n内容: ${currentScenario.scenario_text}` : ""}

${memories.length > 0 ? `## 過去の検証済み経験\n${memories.map(m => `- ${m.title}: ${m.insight}`).join("\n")}` : ""}

## 重要ルール
- 確信が低い場合は必ずWAITを選ぶ（特に${profile.entry_patience === "VERY_PATIENT" ? "このトレーダーは最高の設定以外は見送る" : ""}）
- SL/TPはpips単位ではなく実価格で指定（例：GOLDなら3420.50）
- 勝率を保証したり利益を約束してはいけない
- suggested_volume は 0.01〜0.1 ロット（小さく始める）

## 出力形式（JSON）
{
  "decision": "BUY" | "SELL" | "WAIT" | "EXIT",
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": 1〜5の整数,
  "reasoning": "判断の根拠（日本語）",
  "scenario": "現在の相場シナリオ説明（日本語）",
  "watch_zone": { "low": 数値, "high": 数値 } または null,
  "invalidate_below": 数値または null,
  "invalidate_above": 数値または null,
  "recheck_triggers": ["PRICE_ENTERS_ZONE", "M5_STRUCTURE_CHANGE", "VOLATILITY_SPIKE", "NEWS_EVENT"],
  "suggested_sl": 実価格（BUY/SELLのみ）,
  "suggested_tp": 実価格（BUY/SELLのみ）,
  "suggested_volume": ロット数（BUY/SELLのみ）
}`;
}

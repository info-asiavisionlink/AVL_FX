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
import { validateBarsForEntry }          from "@/lib/ai-trader/market-data-validator";
import { loadCustomerKnowledge, selectCustomerKnowledge, snapshotCustomerKnowledge, formatKnowledgeForPrompt, KnowledgeUnavailableError, type CustomerKnowledgeItem } from "@/lib/knowledge/customer-knowledge-loader";

export const runtime   = "nodejs";
export const maxDuration = 60;

const GATEWAY_URL    = process.env.MT5_GATEWAY_URL    ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "";
const CRON_SECRET    = process.env.CRON_SECRET ?? "";

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchRecentBars(connectionId: string, symbol: string, tf: string, count = 100): Promise<Bar[]> {
  if (!GATEWAY_URL) return [];
  try {
    const url = `${GATEWAY_URL}/connections/${connectionId}/bars/${encodeURIComponent(symbol)}/${tf}?count=${count}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, "x-connection-id": connectionId, "x-internal-service-auth": GATEWAY_SECRET }, signal: AbortSignal.timeout(8_000) });
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
  const isCron = CRON_SECRET && _req.headers.get("x-cron-secret") === CRON_SECRET;
  const cronUserId = isCron ? (_req.headers.get("x-user-id") ?? "") : null;

  if (!user && !isCron) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const effectiveUserId = user?.id ?? cronUserId ?? "";
  const db = createAdminClient();

  // Watcher から渡されたトリガー情報（Knowledge選択に使用）
  const reqBody = await _req.json().catch(() => ({})) as {
    trigger_type?: string;
    bar_time?:     number;
    current_price?: number;
    news_event?:   string | null;
  };

  // Trader取得（所有権確認） — execution_mode を含む
  const { data: trader } = await db.from("ai_traders").select("*, execution_mode").eq("id", id).eq("user_id", effectiveUserId).single();
  if (!trader) return NextResponse.json({ error: "Traderが見つかりません" }, { status: 404 });

  // Current Profile取得
  const { data: profile } = await db
    .from("ai_trader_versions").select("*")
    .eq("ai_trader_id", id).eq("version", trader.current_version).single();
  if (!profile) return NextResponse.json({ error: "Profileが見つかりません" }, { status: 404 });

  // Knowledge取得 — V2: Customer Supabase (no Console API call)
  let selectedKnowledge: CustomerKnowledgeItem[];
  try {
    const allKnowledge = await loadCustomerKnowledge(db, id, effectiveUserId);
    selectedKnowledge = selectCustomerKnowledge(allKnowledge, {
      market: trader.market as string,
      timeframe: ((profile.timeframes as string[] | null)?.[0] ?? "H1"),
      triggerType: reqBody.trigger_type ?? "MANUAL_REANALYSIS",
      limit: 8,
    });
    if (selectedKnowledge.length === 0) {
      await db.from("ai_analysis_logs").insert({
        trader_id: id, user_id: effectiveUserId, ai_trader_version_id: profile.id,
        trigger_type: reqBody.trigger_type ?? "MANUAL_REANALYSIS", analysis_type: "KNOWLEDGE",
        decision: "ERROR", error: "KNOWLEDGE_UNAVAILABLE",
        reasoning_summary: "必要な知識を取得できないため分析を見送りました。",
        market_context: { failure_type: "KNOWLEDGE_UNAVAILABLE" },
      });
      return NextResponse.json({ error: "KNOWLEDGE_UNAVAILABLE", code: "EMPTY_RESULT" }, { status: 503 });
    }
  } catch (error) {
    const code = error instanceof KnowledgeUnavailableError ? error.code : "SERVER_ERROR";
    await db.from("ai_analysis_logs").insert({
      trader_id: id, user_id: effectiveUserId, ai_trader_version_id: profile.id,
      trigger_type: reqBody.trigger_type ?? "MANUAL_REANALYSIS", analysis_type: "KNOWLEDGE",
      decision: "ERROR", error: "KNOWLEDGE_UNAVAILABLE",
      reasoning_summary: "必要な知識を取得できないため分析を見送りました。",
      market_context: { failure_type: code },
    });
    return NextResponse.json({ error: "KNOWLEDGE_UNAVAILABLE", code }, { status: 503 });
  }
  const knowledgeTexts = [formatKnowledgeForPrompt(selectedKnowledge)];
  const knowledgeSnapshot = snapshotCustomerKnowledge(selectedKnowledge);

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
  // P0-2: Track primary timeframe validity for entry context
  let primaryBarsValidForEntry = false;
  let primaryBarsInvalidReason = "PRIMARY_TF_NOT_EVALUATED";

  for (let tfIdx = 0; tfIdx < tfs.length; tfIdx++) {
    const tf = tfs[tfIdx]!;
    let bars: Bar[] = [];
    if (mt5Online) bars = await fetchRecentBars(conn.id, symbol, tf, 100);
    if (!bars.length) bars = await fetchBarsFallback(symbol, tf, 100, sbUrl, svcKey);
    if (bars.length) barSummaries.push(summarizeBars(bars, tf));

    // P0-2: Validate primary timeframe (first TF) for entry use
    if (tfIdx === 0) {
      const validation = validateBarsForEntry(bars as import("@/lib/ai-trader/market-data-validator").Bar[], tf, 5);
      primaryBarsValidForEntry = validation.valid;
      primaryBarsInvalidReason = validation.reason;
    }
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

  const client    = getOpenAIClient();
  const aiModel   = process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat;
  const aiStart   = Date.now();
  let rawText     = "{}";
  let aiError: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const completion = await client.chat.completions.create({
      model: aiModel,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "現在の相場を分析して判断を出してください。" },
      ],
      max_completion_tokens: 1500,
      response_format: { type: "json_object" },
    });
    rawText      = completion.choices[0]?.message?.content ?? "{}";
    inputTokens  = completion.usage?.prompt_tokens     ?? 0;
    outputTokens = completion.usage?.completion_tokens ?? 0;
  } catch (aiErr) {
    aiError = aiErr instanceof Error ? aiErr.message : String(aiErr);
  }

  const aiLatencyMs = Date.now() - aiStart;

  // AI呼び出しログ（テレメトリ）—— エラー有無に関わらず記録
  // decision/confidenceはこの時点ではまだ分からないので後でUPDATEする
  let analysisLogId: string | null = null;
  {
    const { data: logRow } = await db.from("ai_analysis_logs").insert({
      trader_id:    id,
      user_id:      effectiveUserId,
      trigger_type: reqBody.trigger_type ?? "MANUAL",
      decision:     null,
      confidence:   null,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      latency_ms:    aiLatencyMs,
      model:         aiModel,
      error:         aiError,
      market_context: { knowledge_snapshot: knowledgeSnapshot, knowledge_required: true },
      knowledge_snapshot: knowledgeSnapshot,
    }).select("id").single();
    analysisLogId = logRow?.id ?? null;
  }

  // Fail Safe: AI失敗 → watcher_stateをERRORに戻してNO TRADE
  if (aiError) {
    await db.from("ai_traders").update({ watcher_state: "ERROR" }).eq("id", id);
    return NextResponse.json({ error: "AI分析に失敗しました。NO TRADE。", detail: aiError }, { status: 503 });
  }

  let analysis: AIAnalysis;
  try {
    analysis = JSON.parse(rawText) as AIAnalysis;
    // 最低限のvalidation
    if (!analysis.decision || !analysis.bias) throw new Error("必須フィールドが欠けています");
  } catch (parseErr) {
    await db.from("ai_traders").update({ watcher_state: "ERROR" }).eq("id", id);
    return NextResponse.json({ error: "AI応答の解析失敗。NO TRADE。", raw: rawText.slice(0, 200) }, { status: 422 });
  }

  // シナリオ保存（既存をINACTIVE化）
  if (currentScenario) {
    await db.from("ai_trader_scenarios").update({ is_active: false }).eq("id", currentScenario.id);
  }

  const lastBar = barSummaries[0];
  const refPrice = lastBar ? parseFloat(lastBar.split("現値=")[1]?.split(" ")[0] ?? "0") || null : null;

  // 構造化トリガーを構築（v2が返ってきていればそれを使う、なければwatch_zoneから生成）
  const triggersV2: { type: string; low?: number; high?: number; value?: number }[] =
    analysis.recheck_triggers_v2 ??
    (() => {
      const ts: typeof triggersV2 = [];
      if (analysis.watch_zone?.low !== undefined && analysis.watch_zone?.high !== undefined) {
        ts.push({ type: "PRICE_ENTERS_ZONE", low: analysis.watch_zone.low, high: analysis.watch_zone.high });
      }
      if (analysis.invalidate_below !== undefined) {
        ts.push({ type: "PRICE_BELOW", value: analysis.invalidate_below });
      }
      if (analysis.invalidate_above !== undefined) {
        ts.push({ type: "PRICE_ABOVE", value: analysis.invalidate_above });
      }
      if ((analysis.recheck_triggers ?? []).includes("VOLATILITY_SPIKE")) {
        ts.push({ type: "VOLATILITY_SPIKE" });
      }
      return ts;
    })();

  // シナリオのstateをdecisionからマッピング
  const scenarioStateMap: Record<string, string> = {
    WAIT:             "WAITING",
    WATCH:            "WATCHING",
    LONG_SETUP:       "CONSIDERING",
    SHORT_SETUP:      "CONSIDERING",
    BUY:              "DECIDED",
    SELL:             "DECIDED",
    ENTER_LONG:       "DECIDED",
    ENTER_SHORT:      "DECIDED",
    EXIT:             "DECIDED",
    MANAGE_POSITION:  "WATCHING",
    INVALIDATE:       "INVALIDATED",
  };

  // LONG_SETUP / SHORT_SETUP: watch_zone を Layer 2 エントリーゾーンとしてセット
  // これにより M5クローズ時に価格がゾーンに入れば AI を呼ばず直接エントリー可能
  const isSetup = analysis.decision === "LONG_SETUP" || analysis.decision === "SHORT_SETUP";
  const entryZoneLow  = isSetup ? (analysis.watch_zone?.low  ?? null) : null;
  const entryZoneHigh = isSetup ? (analysis.watch_zone?.high ?? null) : null;
  const entrySide     = isSetup
    ? (analysis.decision === "LONG_SETUP" ? "LONG" : "SHORT")
    : null;

  const { data: newScenario } = await db.from("ai_trader_scenarios").insert({
    ai_trader_id:        id,
    user_id:             effectiveUserId,
    is_active:           true,
    state:               scenarioStateMap[analysis.decision] ?? "WATCHING",
    bias:                analysis.bias ?? "NEUTRAL",
    scenario_text:       analysis.scenario,
    watch_zone_low:      analysis.watch_zone?.low ?? null,
    watch_zone_high:     analysis.watch_zone?.high ?? null,
    invalidate_below:    analysis.invalidate_below ?? null,
    invalidate_above:    analysis.invalidate_above ?? null,
    recheck_triggers:    analysis.recheck_triggers ?? [],
    recheck_triggers_v2: triggersV2,
    market:              trader.market as string,
    reference_price:     refPrice,
    bar_time:            new Date().toISOString(),
    ai_model:            MODELS.chat,
    ai_reasoning:        analysis.reasoning,
    // Phase 2 schema additions
    market_view:         analysis.market_view        ?? null,
    risk_context:        analysis.risk_context        ?? null,
    reasoning_summary:   analysis.reasoning_summary   ?? null,
    trigger_type:        reqBody.trigger_type         ?? null,
    // Layer 2 直接エントリー用（LONG_SETUP/SHORT_SETUP のみ）
    entry_side:          entrySide,
    entry_price_low:     entryZoneLow,
    entry_price_high:    entryZoneHigh,
    suggested_sl:        analysis.suggested_sl  ?? null,
    suggested_tp:        analysis.suggested_tp  ?? null,
    suggested_volume:    analysis.suggested_volume ?? null,
  }).select().single();

  // ai_traders の watcher_state と last_analysis_at を更新
  await db.from("ai_traders").update({
    watcher_state:    "WATCHING",
    last_analysis_at: new Date().toISOString(),
  }).eq("id", id);

  // Telemetry: decision / confidence を事後更新
  if (analysisLogId) {
    void db.from("ai_analysis_logs").update({
      decision:   analysis.decision,
      confidence: analysis.confidence ?? null,
    }).eq("id", analysisLogId);
  }

  // P0-2: If market data is invalid for entry, override ENTER decisions to WAIT.
  // Fail Closed: do not create entry decisions with invalid market context.
  const ENTRY_DECISIONS = ["ENTER_LONG", "ENTER_SHORT", "BUY", "SELL", "LONG_SETUP", "SHORT_SETUP"];
  if (!primaryBarsValidForEntry && ENTRY_DECISIONS.includes(analysis.decision)) {
    console.warn(`[analyze] P0-2: Market data invalid for entry, overriding ${analysis.decision} → WAIT. reason=${primaryBarsInvalidReason}`);
    analysis.decision  = "WAIT";
    analysis.confidence = 1;
    analysis.reasoning = `NO_ENTRY: market data invalid (${primaryBarsInvalidReason})`;
  }

  // ENTER_LONG / ENTER_SHORT / BUY / SELL → trade_decisions に保存
  const isExecution = ["ENTER_LONG", "ENTER_SHORT", "BUY", "SELL"].includes(analysis.decision);
  let decision = null;
  if (isExecution) {
    // DEMO_AUTONOMOUS: 5分以内に自動実行するので短い有効期限
    // MANUAL_APPROVAL: 30分
    const expiryMinutes = (trader.execution_mode as string) === "DEMO_AUTONOMOUS" ? 5 : 30;
    const expiresAt = addMinutes(new Date(), expiryMinutes);

    // ENTER_LONG/SHORT を DB 保存用の decision 値にマッピング
    // （trade_decisions の CHECK に ENTER_LONG/SHORT を追加済み: 026 migration）
    const { data: dec } = await db.from("trade_decisions").insert({
      ai_trader_id:         id,
      ai_trader_version_id: profile.id,
      user_id:              effectiveUserId,
      scenario_id:          newScenario?.id ?? null,
      decision:             analysis.decision,
      market:               trader.market as string,
      symbol,
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

    // ── DEMO_AUTONOMOUS: 即時実行ディスパッチ ───────────
    // ENTER_LONG / ENTER_SHORT のみ（BUY/SELL は旧 API — 後方互換のため残す）
    const isAutoExecute =
      (trader.execution_mode as string) === "DEMO_AUTONOMOUS" &&
      (analysis.decision === "ENTER_LONG" || analysis.decision === "ENTER_SHORT") &&
      decision?.id && APP_URL;

    if (isAutoExecute) {
      // analyze route の外側で非同期実行（タイムアウトしても analyze は成功扱い）
      // Vercel の Edge では waitUntil 非対応なので fetch を投げっぱなし
      fetch(`${APP_URL}/api/traders/${id}/execute`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "x-cron-secret": CRON_SECRET,
          "x-user-id":     effectiveUserId,
        },
        body: JSON.stringify({
          decision_id:  decision!.id,
          trigger_type: reqBody.trigger_type ?? null,
        }),
        // タイムアウト 25 秒（analyze の maxDuration 60 秒より短く設定）
        signal: AbortSignal.timeout(25_000),
      }).catch(() => {
        // ディスパッチ失敗は無視（次の watcher サイクルでリカバリ可能）
      });
    }
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
interface RecheckTrigger {
  type:   string;   // PRICE_ENTERS_ZONE / PRICE_ABOVE / PRICE_BELOW / VOLATILITY_SPIKE / etc.
  low?:   number;
  high?:  number;
  value?: number;
}

interface MarketView {
  d1?:  string;  // "BULLISH" | "BEARISH" | "NEUTRAL" | "RANGING"
  h4?:  string;
  h1?:  string;
  m5?:  string;
}

interface AIAnalysis {
  decision:              "BUY" | "SELL" | "WAIT" | "EXIT" | "WATCH" | "LONG_SETUP" | "SHORT_SETUP"
                       | "ENTER_LONG" | "ENTER_SHORT" | "MANAGE_POSITION" | "INVALIDATE";
  bias:                  "LONG" | "SHORT" | "NEUTRAL";
  confidence:            number; // 1-5
  reasoning:             string;
  reasoning_summary:     string; // 1文要約
  scenario:              string;
  market_view?:          MarketView;          // 各TFの状態認識
  risk_context?:         string;              // リスク・懸念事項
  watch_zone?:           { low: number; high: number };
  invalidate_below?:     number;
  invalidate_above?:     number;
  recheck_triggers:      string[];
  recheck_triggers_v2?:  RecheckTrigger[];
  suggested_sl?:         number;
  suggested_tp?:         number;
  suggested_volume?:     number;
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

## あなたが持つトレード知識（${knowledgeTexts.length}件）
${knowledgeTexts.length > 0
  ? `以下の知識を判断基準として使用すること。特に【AI使用目的】に書かれたルールを最優先で適用する。\n\n---\n${knowledgeTexts.join("\n\n---\n")}`
  : "（知識が設定されていません。プロフィールの判断基準のみで分析してください）"}

${currentScenario ? `## 前回のシナリオ\n状態: ${currentScenario.state}\nバイアス: ${currentScenario.bias}\n内容: ${currentScenario.scenario_text}` : ""}

${memories.length > 0 ? `## 過去の検証済み経験\n${memories.map(m => `- ${m.title}: ${m.insight}`).join("\n")}` : ""}

## 重要ルール
- 確信が低い場合は必ずWAITを選ぶ（特に${profile.entry_patience === "VERY_PATIENT" ? "このトレーダーは最高の設定以外は見送る" : ""}）
- SL/TPはpips単位ではなく実価格で指定（例：GOLDなら3420.50）
- 勝率を保証したり利益を約束してはいけない
- suggested_volume は 0.01〜0.1 ロット（小さく始める）

## 決断タイプの定義
- WAIT          : 見送り（条件不満足）
- WATCH         : 監視継続（相場観あるが未確定）
- LONG_SETUP    : ロング候補を認識（まだエントリーしない）
- SHORT_SETUP   : ショート候補を認識（まだエントリーしない）
- ENTER_LONG    : ロングエントリー実行（確信度 4 以上 + SL/TP 必須）
- ENTER_SHORT   : ショートエントリー実行（確信度 4 以上 + SL/TP 必須）
- EXIT          : 既存ポジションのクローズ
- MANAGE_POSITION: SL/TP 修正のみ
- INVALIDATE    : シナリオ無効・リセット

## 出力形式（JSON）
{
  "decision": "ENTER_LONG" | "ENTER_SHORT" | "LONG_SETUP" | "SHORT_SETUP" | "WAIT" | "WATCH" | "EXIT" | "MANAGE_POSITION" | "INVALIDATE",
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": 1〜5の整数（ENTER_LONG/SHORT は必ず 4 以上）,
  "reasoning": "判断の根拠（日本語・2〜4文）",
  "reasoning_summary": "判断を1文で要約（日本語）",
  "scenario": "現在の相場シナリオ説明（日本語・具体的な価格帯を含む）",
  "market_view": {
    "d1": "BULLISH" | "BEARISH" | "NEUTRAL" | "RANGING",
    "h4": "BULLISH" | "BEARISH" | "BULLISH_PULLBACK" | "BEARISH_PULLBACK" | "NEUTRAL" | "RANGING",
    "h1": "BULLISH" | "BEARISH" | "NEUTRAL" | "RANGING",
    "m5": "BULLISH" | "BEARISH" | "NEUTRAL" | "CHOPPY"
  },
  "risk_context": "現在の主要リスク・懸念事項（1〜2文）",
  "watch_zone": { "low": 数値, "high": 数値 } または null（監視する価格帯）,
  "invalidate_below": 数値または null（これを下回ったら上昇シナリオ無効）,
  "invalidate_above": 数値または null（これを上回ったら下降シナリオ無効）,
  "recheck_triggers_v2": [
    { "type": "PRICE_ENTERS_ZONE", "low": 数値, "high": 数値 },
    { "type": "PRICE_BELOW", "value": 数値 },
    { "type": "PRICE_ABOVE", "value": 数値 },
    { "type": "VOLATILITY_SPIKE" },
    { "type": "BREAK_OF_STRUCTURE" },
    { "type": "M5_MOMENTUM_SHIFT" }
  ],
  "recheck_triggers": ["後方互換用・文字列配列"],
  "suggested_sl": 実価格（ENTER_LONG/SHORT/LONG_SETUP/SHORT_SETUPのみ必須）,
  "suggested_tp": 実価格（ENTER_LONG/SHORT/LONG_SETUP/SHORT_SETUPのみ必須）,
  "suggested_volume": ロット数（ENTER_LONG/SHORTのみ・0.01〜0.1）
}

## market_view の記入ルール
データが提供されたTFについてのみ記入する。データがないTFは省略する。
例: H4データのみあれば h4 だけ記入。D1バーがなければ d1 は省略。

## recheck_triggers_v2 のルール
- 必ず1つ以上のトリガーを返す（WAITの場合も監視条件を指定する）
- 使用可能なtype: PRICE_ENTERS_ZONE / PRICE_ABOVE / PRICE_BELOW / VOLATILITY_SPIKE
- 具体的な価格は現在の相場データから実際の値を使う（ハードコード禁止）
- 例: 押し目待ちなら { "type": "PRICE_ENTERS_ZONE", "low": [フィボ61.8%付近], "high": [フィボ50%付近] }`;
}

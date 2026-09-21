// =================================================================
// POST /api/cron/h1-strategy
// Vercel Cron: 0 * * * * (毎時0分)
//
// 【役割】H1バー確定時の AIトレーダー戦略セッション
//
// 固定の3層アーキテクチャ:
//   Layer 1 (本ルート): H1毎 — フルAI分析 → シナリオ確定
//   Layer 2 (m5-close): M5毎 — AI呼ばず価格チェック → エントリー
//   Layer 3 (manage-positions): M5毎 — ポジション毎AI判断 → 決済
//
// AI が読む情報:
//   1. AIトレーダーのプロフィール（トレードスタイル・自然言語指示）
//   2. Console 全知識 (ダウ理論・水平線・LINEトレード等)
//   3. テクニカル (H4/H1/M30 バーデータ)
//   4. ファンダメンタルズ (直近ニュース + 今後24h経済指標)
//   5. 前回シナリオ（継続判断）
//
// 出力:
//   - エントリー方向 (LONG/SHORT/NONE)
//   - エントリーゾーン (low〜high)
//   - SL / TP / ボリューム
//   - シナリオ文章
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";

export const runtime     = "nodejs";
export const dynamic     = "force-dynamic";
export const maxDuration = 120;

const CRON_SECRET          = process.env.CRON_SECRET          ?? "";
const GATEWAY_URL          = process.env.MT5_GATEWAY_URL      ?? "";
const GATEWAY_SECRET       = process.env.MT5_GATEWAY_SECRET   ?? "";
const CONSOLE_URL          = process.env.CONSOLE_URL          ?? "https://avl-fx-console.vercel.app";
const KNOWLEDGE_API_SECRET = process.env.KNOWLEDGE_API_SECRET ?? "";
const APP_URL              = process.env.NEXT_PUBLIC_APP_URL  ?? process.env.APP_URL ?? "";

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

// ── バーデータ取得 ────────────────────────────────────────────────
async function fetchBars(connId: string, symbol: string, tf: string, count = 100): Promise<Bar[]> {
  if (!GATEWAY_URL || !connId) return [];
  try {
    const r = await fetch(
      `${GATEWAY_URL}/connections/${connId}/bars/${encodeURIComponent(symbol)}/${tf}?count=${count}`,
      { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, signal: AbortSignal.timeout(6_000) }
    );
    return r.ok ? await r.json() as Bar[] : [];
  } catch { return []; }
}

async function fetchBarsFallback(symbol: string, tf: string, count = 100): Promise<Bar[]> {
  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? "";
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return [];
  try {
    const r = await fetch(
      `${url}/rest/v1/bar_data?symbol=eq.${encodeURIComponent(symbol)}&timeframe=eq.${tf}&select=time_utc,open,high,low,close,volume&order=time_utc.desc&limit=${count}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!r.ok) return [];
    const rows = await r.json() as { time_utc: string; open: number; high: number; low: number; close: number; volume: number }[];
    return rows.reverse().map(row => ({
      time: Math.floor(new Date(row.time_utc).getTime() / 1000),
      open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
    }));
  } catch { return []; }
}

function barAnalysis(bars: Bar[], tf: string): string {
  if (!bars.length) return `${tf}: データなし`;
  const last = bars[bars.length - 1];
  const n    = Math.min(20, bars.length);
  const slice = bars.slice(-n);
  const high  = Math.max(...slice.map(b => b.high));
  const low   = Math.min(...slice.map(b => b.low));
  const open20 = bars[Math.max(0, bars.length - n)].open;
  const trend  = last.close > open20 ? "上昇" : last.close < open20 ? "下降" : "横ばい";

  // スウィングハイ・ロー特定（直近5本の中の極値）
  const swings: string[] = [];
  for (let i = 2; i < Math.min(bars.length - 2, 10); i++) {
    const b = bars[bars.length - 1 - i];
    const prev2 = [bars[bars.length - 3 - i], bars[bars.length - i - 2]];
    const next2 = [bars[bars.length - i], bars[bars.length - i + 1]];
    if (prev2.every(p => p.high < b.high) && next2.every(p => p.high < b.high))
      swings.push(`スウィングHigh:${b.high.toFixed(2)}`);
    if (prev2.every(p => p.low > b.low) && next2.every(p => p.low > b.low))
      swings.push(`スウィングLow:${b.low.toFixed(2)}`);
  }

  return `${tf}: 現値=${last.close.toFixed(2)} | 直近${n}本 高値=${high.toFixed(2)} 安値=${low.toFixed(2)} | トレンド=${trend}${swings.length ? " | " + swings.slice(0, 2).join(" ") : ""}`;
}

// ── 経済指標取得 ─────────────────────────────────────────────────
async function fetchEconomicEvents(): Promise<string> {
  try {
    const r = await fetch(`${APP_URL}/api/market/economic-events?hours=24&currencies=USD,XAU,EUR,JPY`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return "経済指標データ取得失敗";
    const events = await r.json() as { time: string; currency: string; title: string; impact: string; forecast?: string; previous?: string; actual?: string }[];
    if (!events.length) return "今後24時間: 重要指標なし";
    return events
      .filter(e => e.impact === "HIGH" || e.impact === "MEDIUM")
      .slice(0, 8)
      .map(e => `[${e.impact}] ${new Date(e.time).toLocaleString("ja-JP")} ${e.currency} ${e.title}${e.forecast ? ` 予想:${e.forecast}` : ""}${e.actual ? ` 結果:${e.actual}` : ""}`)
      .join("\n") || "重要指標なし";
  } catch { return "経済指標取得エラー"; }
}

// ── ニュース取得 ─────────────────────────────────────────────────
async function fetchNews(symbol: string): Promise<string> {
  try {
    const r = await fetch(`${APP_URL}/api/market/news?symbol=${encodeURIComponent(symbol)}&limit=5`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return "ニュース取得失敗";
    const news = await r.json() as { title: string; excerpt?: string; publishedAt?: string }[];
    if (!news.length) return "関連ニュースなし";
    return news.map(n => `・${n.title}${n.excerpt ? "：" + n.excerpt.slice(0, 100) : ""}`).join("\n");
  } catch { return "ニュース取得エラー"; }
}

// ── Console全知識取得 ────────────────────────────────────────────
async function fetchAllKnowledge(): Promise<string> {
  if (!CONSOLE_URL || !KNOWLEDGE_API_SECRET) return "（知識DBへの接続設定なし）";
  try {
    const r = await fetch(`${CONSOLE_URL}/api/trading-knowledge?status=ACTIVE`, {
      headers: { "x-knowledge-api-secret": KNOWLEDGE_API_SECRET },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return "（知識DB取得失敗）";
    const data = await r.json() as {
      items?: { id: string; title: string; content: string; ai_usage?: string; summary?: string; category?: string }[]
    };
    const items = data.items ?? [];
    if (!items.length) return "（知識DBにデータなし）";

    // 重要度順: Market Structure > Price Action > Risk Management > その他
    const priority = ["Market Structure", "Price Action", "Risk Management", "Indicators", "Session"];
    const sorted = [...items].sort((a, b) => {
      const ai = priority.indexOf(a.category ?? "");
      const bi = priority.indexOf(b.category ?? "");
      return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999);
    });

    return sorted.slice(0, 12).map(k => {
      const parts = [`### ${k.title}${k.category ? ` [${k.category}]` : ""}`];
      if (k.ai_usage) parts.push(`→ ${k.ai_usage}`);
      if (k.summary)  parts.push(k.summary);
      parts.push(k.content.slice(0, 1500));
      return parts.join("\n");
    }).join("\n\n---\n\n");
  } catch { return "（知識DB接続エラー）"; }
}

// ── H1 戦略プロンプト構築 ────────────────────────────────────────
function buildStrategyPrompt(
  profile: Record<string, unknown>,
  barSummaries: string[],
  knowledge: string,
  economicEvents: string,
  news: string,
  prevScenario: Record<string, unknown> | null,
): string {
  return `あなたはFX AIトレーダーです。以下のプロフィールとルールに従って相場を分析し、1時間有効なトレードシナリオを構築してください。

## ━━ あなたのトレードプロフィール ━━
- スタイル: ${profile.trading_style ?? "スイング"}
- 性格: ${profile.personality ?? "BALANCED"}
- リスク: ${profile.risk_profile ?? "MODERATE"}（1トレード最大 ${profile.max_risk_per_trade ?? 1}%）
- 最小RR比: ${profile.minimum_rr ?? 2}:1
- エントリー基準: ${profile.entry_patience ?? "PATIENT"}
- ニュース対応: ${profile.news_sensitivity ?? "MEDIUM"}
${profile.instructions ? `\n## ━━ あなたの指示・哲学 ━━\n${profile.instructions}` : ""}

## ━━ トレードの基礎知識（必ず適用すること） ━━
${knowledge}

## ━━ テクニカル分析データ ━━
${barSummaries.join("\n")}

## ━━ ファンダメンタルズ ━━
### 今後24時間の重要経済指標
${economicEvents}

### 最新ニュース
${news}

${prevScenario ? `## ━━ 前回のシナリオ（1時間前） ━━
バイアス: ${prevScenario.bias}
エントリー方向: ${prevScenario.entry_side ?? "未設定"}
シナリオ: ${prevScenario.scenario_text}
前回エントリーゾーン: ${prevScenario.entry_price_low ?? "?"} 〜 ${prevScenario.entry_price_high ?? "?"}` : ""}

## ━━ 今すぐ行うタスク ━━
1. テクニカル + ファンダメンタルズを統合して相場を分析する
2. ダウ理論・水平線・LINEタッチ（価格反発ゾーン）を最重視する
3. 今後1時間の具体的なトレードシナリオを決定する
4. エントリーすべき価格帯（ゾーン）を指定する
5. SL・TPは現在の相場構造に基づいた現実的な価格で指定する

## ━━ 出力形式（JSON厳守） ━━
{
  "entry_side": "LONG" | "SHORT" | "NONE",
  "entry_price_low": 数値（エントリーゾーン下限）,
  "entry_price_high": 数値（エントリーゾーン上限）,
  "suggested_sl": 数値（損切り価格・現在価格から現実的な距離）,
  "suggested_tp": 数値（利確価格・最低RR ${profile.minimum_rr ?? 2}:1以上）,
  "suggested_volume": 0.01〜0.1（小さく始める）,
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "scenario": "シナリオの詳細説明（日本語・3〜5文・具体的価格帯を必ず含む）",
  "reasoning": "判断の根拠（ダウ理論・水平線・ファンダ等の適用を明記）",
  "key_levels": {
    "support": [価格1, 価格2],
    "resistance": [価格1, 価格2]
  },
  "fundamental_notes": "ファンダ的注意事項（指標・ニュースの影響）",
  "recheck_triggers_v2": [
    {"type": "PRICE_ENTERS_ZONE", "low": 数値, "high": 数値},
    {"type": "PRICE_ABOVE", "value": 数値},
    {"type": "PRICE_BELOW", "value": 数値}
  ],
  "watch_zone_low": 数値（entry_price_lowと同値）,
  "watch_zone_high": 数値（entry_price_highと同値）,
  "invalidate_below": 数値またはnull,
  "invalidate_above": 数値またはnull
}

重要: entry_side が NONE の場合はエントリーゾーン・SL・TPはnullでよい。
NONE を選ぶのは相場が不明瞭な場合のみ。`;
}

// ── メインハンドラ ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 認証
  const secret = req.headers.get("x-cron-secret") ?? req.headers.get("Authorization")?.replace("Bearer ", "");
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();

  // アクティブなAIトレーダーを全件取得
  const { data: traders } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version, execution_mode, kill_switch")
    .eq("status", "ACTIVE")
    .eq("kill_switch", false);

  if (!traders?.length) {
    return NextResponse.json({ ok: true, message: "アクティブなトレーダーなし", processed: 0 });
  }

  const results: { traderId: string; name: string; status: string; entry_side?: string }[] = [];

  for (const trader of traders) {
    try {
      // プロフィール取得
      const { data: profile } = await db
        .from("ai_trader_versions")
        .select("*")
        .eq("ai_trader_id", trader.id)
        .eq("version", trader.current_version)
        .single();
      if (!profile) { results.push({ traderId: trader.id, name: trader.name, status: "no_profile" }); continue; }

      // MT5接続確認
      const { data: conn } = await db
        .from("mt5_connections")
        .select("id, last_heartbeat_at")
        .eq("user_id", trader.user_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      const mt5Online = conn && (Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime()) < 90_000;

      // シンボル決定
      const symbol = trader.market === "GOLD" ? "GOLD#" : (trader.market as string);

      // バーデータ取得（H4/H1/M30）
      const timeframes = ["H4", "H1", "M30"];
      const barSummaries: string[] = [];
      for (const tf of timeframes) {
        let bars: Bar[] = [];
        if (mt5Online && conn) bars = await fetchBars(conn.id, symbol, tf, 100);
        if (!bars.length) bars = await fetchBarsFallback(symbol, tf, 100);
        if (bars.length) barSummaries.push(barAnalysis(bars, tf));
      }
      if (!barSummaries.length) {
        results.push({ traderId: trader.id, name: trader.name, status: "no_bar_data" });
        continue;
      }

      // 並列取得: 知識・経済指標・ニュース
      const [knowledge, economicEvents, news] = await Promise.all([
        fetchAllKnowledge(),
        fetchEconomicEvents(),
        fetchNews(symbol),
      ]);

      // 前回シナリオ
      const { data: prevScenario } = await db
        .from("ai_trader_scenarios")
        .select("bias, scenario_text, entry_side, entry_price_low, entry_price_high")
        .eq("ai_trader_id", trader.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      // AI 呼び出し
      const prompt = buildStrategyPrompt(
        profile as Record<string, unknown>,
        barSummaries,
        knowledge,
        economicEvents,
        news,
        prevScenario as Record<string, unknown> | null,
      );

      const client  = getOpenAIClient();
      const aiModel = process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat;

      const completion = await client.chat.completions.create({
        model: aiModel,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "現在の相場を総合分析し、今後1時間のトレードシナリオを構築してください。" },
        ],
        max_completion_tokens: 2000,
        response_format: { type: "json_object" },
      });

      const raw  = completion.choices[0]?.message?.content ?? "{}";
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }

      const entrySide = (parsed.entry_side as string) ?? "NONE";

      // 前回のアクティブシナリオを非アクティブ化
      await db
        .from("ai_trader_scenarios")
        .update({ is_active: false })
        .eq("ai_trader_id", trader.id)
        .eq("is_active", true);

      // 新シナリオ保存
      const barTime = Date.now();
      await db.from("ai_trader_scenarios").insert({
        ai_trader_id:        trader.id,
        user_id:             trader.user_id,
        is_active:           true,
        state:               entrySide === "NONE" ? "WATCHING" : "SETUP",
        bias:                (parsed.bias as string) ?? "NEUTRAL",
        scenario_text:       (parsed.scenario as string) ?? raw.slice(0, 500),
        // エントリーゾーン
        entry_side:          entrySide,
        entry_price_low:     (parsed.entry_price_low as number) ?? null,
        entry_price_high:    (parsed.entry_price_high as number) ?? null,
        suggested_sl:        (parsed.suggested_sl as number) ?? null,
        suggested_tp:        (parsed.suggested_tp as number) ?? null,
        suggested_volume:    (parsed.suggested_volume as number) ?? 0.01,
        // 互換フィールド
        watch_zone_low:      (parsed.watch_zone_low as number) ?? (parsed.entry_price_low as number) ?? null,
        watch_zone_high:     (parsed.watch_zone_high as number) ?? (parsed.entry_price_high as number) ?? null,
        invalidate_below:    (parsed.invalidate_below as number) ?? null,
        invalidate_above:    (parsed.invalidate_above as number) ?? null,
        recheck_triggers:    [],
        recheck_triggers_v2: (parsed.recheck_triggers_v2 as unknown[]) ?? [],
        key_levels:          (parsed.key_levels as Record<string, unknown>) ?? null,
        fundamental_notes:   (parsed.fundamental_notes as string) ?? null,
        market:              trader.market,
        reference_price:     barSummaries.length > 0
          ? parseFloat(barSummaries[0].split("現値=")[1]?.split(" ")[0] ?? "0")
          : null,
        bar_time:            new Date(barTime).toISOString(),
        h1_bar_time:         Math.floor(barTime / 1000),
        ai_model:            aiModel,
        ai_reasoning:        (parsed.reasoning as string) ?? null,
        trigger_type:        "H1_STRATEGY",
        m5_bar_time:         Math.floor(barTime / 1000),
        market_view:         null,
        risk_context:        (parsed.fundamental_notes as string) ?? null,
        reasoning_summary:   (parsed.scenario as string)?.slice(0, 200) ?? null,
      });

      results.push({ traderId: trader.id, name: trader.name, status: "ok", entry_side: entrySide });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ traderId: trader.id, name: trader.name, status: `error: ${msg.slice(0, 100)}` });
    }
  }

  return NextResponse.json({ ok: true, processed: traders.length, results });
}

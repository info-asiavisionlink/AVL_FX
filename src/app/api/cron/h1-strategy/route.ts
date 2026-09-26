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
import { type KnowledgeSnapshot } from "@/lib/knowledge/knowledge-client";
import { loadCustomerKnowledge, selectCustomerKnowledge, snapshotCustomerKnowledge, formatKnowledgeForPrompt, KnowledgeUnavailableError, type CustomerKnowledgeItem } from "@/lib/knowledge/customer-knowledge-loader";
import { isClosedBar } from "@/lib/ai-trader/core-runtime";
import { createProductionRuntimeService } from "@/lib/ai-trader/runtime-service";
import type { RuntimeService } from "@/lib/ai-trader/runtime-service";
import { handleManagePositions } from "@/lib/ai-trader/position-review-runtime";

export const runtime     = "nodejs";
export const dynamic     = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET          = process.env.CRON_SECRET          ?? "";
const GATEWAY_URL          = process.env.MT5_GATEWAY_URL      ?? "";
const GATEWAY_SECRET       = process.env.MT5_GATEWAY_SECRET   ?? "";
const APP_URL              = process.env.NEXT_PUBLIC_APP_URL  ?? process.env.APP_URL ?? "";

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number; }

export interface H1StrategyDependencies {
  db: ReturnType<typeof createAdminClient>;
  aiClientFactory: typeof getOpenAIClient;
  // V2: accepts traderId+userId so the loader can read from Customer Supabase.
  // Test mocks may declare fewer parameters — TypeScript allows this (callback compatibility).
  fetchKnowledge: (traderId: string, userId: string, market: string, timeframe?: string) => Promise<{ text: string; snapshot: KnowledgeSnapshot[] }>;
  fetchBars: (connId: string, symbol: string, tf: string, count?: number) => Promise<Bar[]>;
  fetchBarsFallback: (symbol: string, tf: string, count?: number) => Promise<Bar[]>;
  fetchEconomicEvents: () => Promise<string>;
  fetchNews: (symbol: string) => Promise<string>;
  now: () => Date;
  runtimeFactory: (db: ReturnType<typeof createAdminClient>) => RuntimeService;
}

export function createProductionH1StrategyDependencies(db: ReturnType<typeof createAdminClient>): H1StrategyDependencies {
  return {
    db,
    aiClientFactory: getOpenAIClient,
    fetchKnowledge: makeCustomerKnowledgeFetcher(db),
    fetchBars,
    fetchBarsFallback,
    fetchEconomicEvents,
    fetchNews,
    now: () => new Date(),
    runtimeFactory: (runtimeDb) => createProductionRuntimeService(runtimeDb, {
      ai: { entry: async () => ({ decision: "WAIT" }), position: async () => ({ decision: "HOLD" }) },
      risk: { entry: async () => ({ approved: false, reason: "H1 orchestration does not execute directly" }) },
      market: { validEntry: () => false, validPosition: () => false, validateHardSl: () => false, validateModifySl: () => false, validateModifyTp: () => false },
    }),
  };
}

function makeCustomerKnowledgeFetcher(
  db: ReturnType<typeof createAdminClient>,
): H1StrategyDependencies["fetchKnowledge"] {
  return async (traderId, userId, market, timeframe = "H1") => {
    const all = await loadCustomerKnowledge(db, traderId, userId);
    const selected = selectCustomerKnowledge(all, { market, timeframe, triggerType: "HOURLY_ANALYSIS", limit: 12 });
    if (selected.length === 0) throw new KnowledgeUnavailableError("EMPTY_RESULT");
    return {
      text:     formatKnowledgeForPrompt(selected, 1500),
      snapshot: snapshotCustomerKnowledge(selected),
    };
  };
}

export async function handleH1Strategy(
  input: Parameters<RuntimeService["hourlyAnalysis"]>[0],
  deps: H1StrategyDependencies,
) {
  return deps.runtimeFactory(deps.db).hourlyAnalysis(input);
}

// ── バーデータ取得 ────────────────────────────────────────────────
async function fetchBars(connId: string, symbol: string, tf: string, count = 100): Promise<Bar[]> {
  if (!GATEWAY_URL || !connId) return [];
  try {
    const r = await fetch(
      `${GATEWAY_URL}/connections/${connId}/bars/${encodeURIComponent(symbol)}/${tf}?count=${count}`,
      { headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, "x-connection-id": connId, "x-internal-service-auth": GATEWAY_SECRET }, signal: AbortSignal.timeout(6_000) }
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

  const last  = bars[bars.length - 1];
  const total = bars.length;

  // ── ダウ理論用: 直近スウィングハイ/ロー（上位5個ずつ）──────────
  const swingHighs: number[] = [];
  const swingLows:  number[] = [];
  for (let i = 2; i < total - 2; i++) {
    const b  = bars[i];
    const p1 = bars[i - 1], p2 = bars[i - 2];
    const n1 = bars[i + 1], n2 = bars[i + 2];
    if (b.high > p1.high && b.high > p2.high && b.high > n1.high && b.high > n2.high)
      swingHighs.push(b.high);
    if (b.low < p1.low && b.low < p2.low && b.low < n1.low && b.low < n2.low)
      swingLows.push(b.low);
  }
  const recentHighs = swingHighs.slice(-5).map(v => v.toFixed(2)).join(", ");
  const recentLows  = swingLows.slice(-5).map(v => v.toFixed(2)).join(", ");

  // ── ダウトレンド判定（直近3スウィングで高値・安値の切り上がり/下がり）──
  let dowTrend = "不明";
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hUp = swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
    const lUp = swingLows[swingLows.length - 1]   > swingLows[swingLows.length - 2];
    if (hUp && lUp)   dowTrend = "上昇（高値・安値ともに切り上げ）";
    else if (!hUp && !lUp) dowTrend = "下降（高値・安値ともに切り下げ）";
    else              dowTrend = "レンジ（高値・安値が交錯）";
  }

  // ── 直近20本・50本・100本の概況 ──────────────────────────────────
  const s20  = bars.slice(-Math.min(20,  total));
  const s50  = bars.slice(-Math.min(50,  total));
  const s100 = bars.slice(-Math.min(100, total));
  const high20  = Math.max(...s20.map(b => b.high));
  const low20   = Math.min(...s20.map(b => b.low));
  const high50  = Math.max(...s50.map(b => b.high));
  const low50   = Math.min(...s50.map(b => b.low));
  const high100 = Math.max(...s100.map(b => b.high));
  const low100  = Math.min(...s100.map(b => b.low));

  // ── EMA計算（21・50・200）────────────────────────────────────────
  function ema(data: Bar[], period: number): number {
    if (data.length < period) return 0;
    const k = 2 / (period + 1);
    let e = data.slice(0, period).reduce((s, b) => s + b.close, 0) / period;
    for (let i = period; i < data.length; i++) e = data[i].close * k + e * (1 - k);
    return e;
  }
  const ema21  = ema(bars, 21);
  const ema50  = ema(bars, 50);
  const ema200 = total >= 200 ? ema(bars, 200) : 0;

  // ── ATR(14) ──────────────────────────────────────────────────────
  const atrSlice = bars.slice(-15);
  const trs = atrSlice.slice(1).map((b, i) => Math.max(
    b.high - b.low,
    Math.abs(b.high - atrSlice[i].close),
    Math.abs(b.low  - atrSlice[i].close),
  ));
  const atr14 = trs.reduce((s, v) => s + v, 0) / trs.length;

  // ── ボリンジャーバンド(20, 2σ) ───────────────────────────────────
  const bbSlice  = bars.slice(-20);
  const bbMid    = bbSlice.reduce((s, b) => s + b.close, 0) / bbSlice.length;
  const bbStd    = Math.sqrt(bbSlice.reduce((s, b) => s + (b.close - bbMid) ** 2, 0) / bbSlice.length);
  const bbUpper  = bbMid + 2 * bbStd;
  const bbLower  = bbMid - 2 * bbStd;
  const bbWidth  = ((bbUpper - bbLower) / bbMid * 100).toFixed(2);

  // ── フィボナッチ（直近スウィング高/安から計算）───────────────────
  let fiboText = "";
  if (swingHighs.length && swingLows.length) {
    const sh = swingHighs[swingHighs.length - 1];
    const sl = swingLows[swingLows.length - 1];
    const range = sh - sl;
    fiboText = ` | Fibo[38.2%=${(sh - range * 0.382).toFixed(2)} 50%=${(sh - range * 0.5).toFixed(2)} 61.8%=${(sh - range * 0.618).toFixed(2)}]`;
  }

  return [
    `\n【${tf} — ${total}本取得】`,
    `現値=${last.close.toFixed(2)} | ATR14=${atr14.toFixed(2)}`,
    `ダウ理論トレンド: ${dowTrend}`,
    `  スウィングHigh(直近): ${recentHighs || "なし"}`,
    `  スウィングLow(直近):  ${recentLows  || "なし"}`,
    `レンジ: 20本[${low20.toFixed(2)}-${high20.toFixed(2)}] 50本[${low50.toFixed(2)}-${high50.toFixed(2)}] 100本[${low100.toFixed(2)}-${high100.toFixed(2)}]`,
    `EMA: 21=${ema21.toFixed(2)} 50=${ema50.toFixed(2)}${ema200 ? ` 200=${ema200.toFixed(2)}` : ""}`,
    `BB(20,2σ): Mid=${bbMid.toFixed(2)} Upper=${bbUpper.toFixed(2)} Lower=${bbLower.toFixed(2)} 幅=${bbWidth}%${fiboText}`,
  ].join("\n");
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

// ── V1 LEGACY (not used by V2 runtime) ──────────────────────────
// fetchAllKnowledge was the V1 Console API path. Replaced by makeCustomerKnowledgeFetcher.
// Retained here to avoid breaking any V1 Console admin paths that may import this module.
// Will be removed at Stage 9 (Customer Self-Contained Runtime Cutover).

// ── H1 戦略プロンプト構築 ────────────────────────────────────────
function buildStrategyPrompt(
  profile: Record<string, unknown>,
  barSummaries: string[],
  knowledge: string,
  economicEvents: string,
  news: string,
  prevScenario:  Record<string, unknown> | null,
  prev2Scenario: Record<string, unknown> | null,
): string {
  return `あなたはプロのFXトレーダーAIです。以下のデータを分析し、今後30〜60分以内に実行可能なトレードシナリオを必ず提案してください。

## ━━ あなたのトレードプロフィール ━━
- スタイル: ${profile.trading_style ?? "スイング"}
- 性格: ${profile.personality ?? "BALANCED"}
- リスク: ${profile.risk_profile ?? "MODERATE"}（1トレード最大 ${profile.max_risk_per_trade ?? 1}%）
- 最小RR比: ${profile.minimum_rr ?? 2}:1
- ニュース対応: ${profile.news_sensitivity ?? "MEDIUM"}
${profile.instructions ? `\n## ━━ あなたの固有ルール（最優先） ━━\n${profile.instructions}` : ""}

## ━━ トレードの基礎知識（必ず適用すること） ━━
${knowledge}

## ━━ テクニカル分析データ ━━
${barSummaries.join("\n")}

## ━━ ファンダメンタルズ ━━
### 今後24時間の重要経済指標
${economicEvents}

### 最新ニュース
${news}

${prev2Scenario ? `## ━━ 60分前のシナリオ ━━
バイアス: ${prev2Scenario.bias} | 方向: ${prev2Scenario.entry_side ?? "NONE"}
シナリオ: ${(prev2Scenario.scenario_text as string ?? "").slice(0, 150)}
30分後予想（当時）: ${prev2Scenario.next_30min_outlook ?? "未記録"}` : ""}

${prevScenario ? `## ━━ 前回シナリオ（30分前）と今回の比較 ━━
前回バイアス: ${prevScenario.bias} | 前回方向: ${prevScenario.entry_side ?? "NONE"}
前回エントリーゾーン: ${prevScenario.entry_price_low ?? "?"} 〜 ${prevScenario.entry_price_high ?? "?"}
前回シナリオ全文: ${prevScenario.scenario_text}
前回の30分後予想: ${prevScenario.next_30min_outlook ?? "未記録"}

★ 前回予想からの変化を必ず言及すること。例:「前回は上昇シナリオだったが、○○ラインを下抜けたため下降に転換」` : ""}

## ━━ 分析の手順（この順番で考えること） ━━
1. **トレンド方向を決める**: H4・H1の直近20本を見てトレンドを判定する（上昇・下降・レンジ）
2. **知識を適用する**: 上記トレード知識から該当するものを選び、タイトル名を明示して分析する（例：「ダウ理論より高値・安値が切り上がっているため上昇トレンド継続」「フィボナッチ61.8%押し目ゾーン到達」「一目均衡表で雲の上で三役好転」など）
3. **エントリーゾーンを探す**: 押し目・戻りの水平線・サポート・レジスタンスを特定する
4. **SL/TPを計算する**: スウィングハイ/ローの外側にSL、RR${profile.minimum_rr ?? 2}:1以上のTPを設定する
5. **NONEにすべき例外を確認する**: 下記の条件に1つでも当てはまる場合のみNONE

## ━━ NONEにする条件（例外・厳格に適用） ━━
以下のいずれかに該当する場合のみ entry_side = "NONE" とする:
- 30分以内に高インパクト経済指標がある（FOMCや雇用統計等）
- H4・H1の両方でトレンドが完全に逆方向（相反している）
- スプレッドが異常拡大中（通常の3倍以上）

**上記に該当しない場合は必ず LONG か SHORT を選ぶこと。**
迷ったとき・自信が低いときも、最もシナリオの可能性が高い方向を選ぶ。
「やや自信が低い」程度ではNONEにしない。エントリーゾーンを広めに取ることで対応する。

## ━━ エントリーゾーンの決め方 ━━
- 現在価格の近く（現在価格の±0.5〜1.5%以内）に設定する
- 押し目なら: 直近サポートの上下5〜15pips幅をゾーンにする
- ブレイクなら: ブレイクした水平線の上（LONG）または下（SHORT）5〜10pips
- ゾーン幅は最低5pips・最大30pipsにする（GOLD換算: 0.50〜3.00ドル幅）

## ━━ 出力形式（JSON厳守） ━━
{
  "entry_side": "LONG" | "SHORT" | "NONE",
  "entry_price_low": 数値（エントリーゾーン下限・NONEのときはnull）,
  "entry_price_high": 数値（エントリーゾーン上限・NONEのときはnull）,
  "suggested_sl": 数値（損切り価格・NONEのときはnull）,
  "suggested_tp": 数値（利確価格・RR${profile.minimum_rr ?? 2}:1以上・NONEのときはnull）,
  "suggested_volume": 0.01（固定）,
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "scenario": "シナリオ説明（日本語・5〜8文・現在価格・エントリーゾーン・SL・TPを必ず数値で書く。「○○（知識名）によれば〜」という形で適用した知識を2つ以上明示すること）",
  "reasoning": "根拠（適用した知識タイトルを【】で囲んで列挙し、各知識がどう判断に影響したかを具体的に記述。最低200文字）",
  "applied_knowledge": ["適用した知識タイトル1", "適用した知識タイトル2"],
  "scenario_change": "前回シナリオとの変化点（前回と同じ方向なら「前回から継続」、変わったなら「○○ラインを下抜けたため下降に転換」など1〜2文で必ず記述）",
  "next_30min_outlook": "今後30分で最も注目すべき価格水準・イベント・シナリオの分岐点を2〜3文で記述（次回分析時の比較材料になる）",
  "key_levels": {
    "support": [価格1, 価格2],
    "resistance": [価格1, 価格2]
  },
  "fundamental_notes": "ファンダ的注意事項（指標・ニュースの影響）",
  "recheck_triggers_v2": [
    {"type": "PRICE_ENTERS_ZONE", "low": entry_price_lowと同値, "high": entry_price_highと同値}
  ],
  "watch_zone_low": entry_price_lowと同値,
  "watch_zone_high": entry_price_highと同値,
  "invalidate_below": 数値またはnull（これを下抜けたらシナリオ無効）,
  "invalidate_above": 数値またはnull（これを上抜けたらシナリオ無効）
}`;
}

// ── メインハンドラ ─────────────────────────────────────────────
export async function handleH1StrategyRequest(
  req: NextRequest,
  injectedDeps?: H1StrategyDependencies,
) {
  // 認証
  const secret = req.headers.get("x-cron-secret") ?? req.headers.get("Authorization")?.replace("Bearer ", "");
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const h1Deps = injectedDeps ?? createProductionH1StrategyDependencies(createAdminClient());
  const db = h1Deps.db;

  // アクティブなAIトレーダーを全件取得
  const { data: traders } = await db
    .from("ai_traders")
    .select("id, user_id, name, market, current_version, execution_mode, kill_switch")
    .eq("status", "ACTIVE")
    .eq("kill_switch", false)
    .neq("execution_mode", "STOPPED");

  if (!traders?.length) {
    return NextResponse.json({ ok: true, message: "アクティブなトレーダーなし", processed: 0 });
  }

  const results: { traderId: string; name: string; status: string; entry_side?: string }[] = [];

  // Each trader owns an independent H1 analysis.  Traders sharing a market
  // must never share a profile, prompt, scenario, or version correlation.
  type TraderRow = typeof traders[number];
  const groups = traders.map((trader) => [trader] as TraderRow[]);

  for (const group of groups) {
    const primary = group[0];

    try {
      await h1Deps.runtimeFactory(h1Deps.db).transitionState(primary.id, ["FLAT", "ANALYZING", "WATCHING_ENTRY"], "ANALYZING");
      // プロフィール取得（代表のみ）
      const { data: profile } = await db
        .from("ai_trader_versions")
        .select("*")
        .eq("ai_trader_id", primary.id)
        .eq("version", primary.current_version)
        .single();
      if (!profile) {
        group.forEach(t => results.push({ traderId: t.id, name: t.name, status: "no_profile" }));
        continue;
      }

      // MT5接続確認（代表のユーザーのみ）
      const { data: conn } = await db
        .from("mt5_connections")
        .select("id, last_heartbeat_at")
        .eq("user_id", primary.user_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      const mt5Online = conn && (h1Deps.now().getTime() - new Date(conn.last_heartbeat_at ?? 0).getTime()) < 90_000;

      const positionSymbol = primary.market === "GOLD" ? "GOLD#" : (primary.market as string);
      const positionH1Bars = mt5Online && conn ? await h1Deps.fetchBars(conn.id, positionSymbol, "H1", 10) : [];
      const positionClosedH1 = positionH1Bars
        .filter((bar) => isClosedBar(Number(bar.time) * 1000, "H1"))
        .sort((a, b) => Number(b.time) - Number(a.time))[0];

      // A trader with an open/pending position enters POSITION_REVIEW on a
      // new H1 close. Never overwrite its position-management state with an
      // entry scenario.
      const { data: openPositions } = await db.from("ai_positions")
        .select("id")
        .eq("ai_trader_id", primary.id)
        .in("status", ["PENDING_OPEN", "OPEN"])
        .limit(1);
      if ((openPositions ?? []).length > 0) {
        if (!positionClosedH1) {
          results.push({ traderId: primary.id, name: primary.name, status: "no_closed_h1" });
          continue;
        }
        await handleManagePositions({ db, traderId: primary.id, userId: primary.user_id, barTime: Number(positionClosedH1.time), trigger: "H1_BAR_CLOSED" });
        results.push({ traderId: primary.id, name: primary.name, status: "position_review" });
        continue;
      }

      // シンボル決定
      const symbol = primary.market === "GOLD" ? "GOLD#" : (primary.market as string);

      // ── バーデータ取得（500本・全TF並列）────────────────────────
      // H4=500本(約3.5ヶ月), H1=500本(約3週間), M30=500本(約10日), M15=500本(約5日)
      const tfConfigs: { tf: string; count: number }[] = [
        { tf: "H4",  count: 500 },
        { tf: "H1",  count: 500 },
        { tf: "M30", count: 500 },
        { tf: "M15", count: 500 },
      ];
      const barSummaries: string[] = [];
      let latestClosedH1Ms = 0;
      await Promise.all(tfConfigs.map(async ({ tf, count }) => {
        try {
          let bars: Bar[] = [];
          if (mt5Online && conn) bars = await h1Deps.fetchBars(conn.id, symbol, tf, count);
          if (!bars.length) bars = await h1Deps.fetchBarsFallback(symbol, tf, count);
          if (tf === "H1") {
            const closed = bars
              .filter((bar) => isClosedBar(Number(bar.time) * 1000, "H1"))
              .sort((a, b) => Number(b.time) - Number(a.time))[0];
            latestClosedH1Ms = closed ? Number(closed.time) * 1000 : 0;
          }
          console.log(`[h1-strategy] ${tf}: ${bars.length}本取得 mt5Online=${mt5Online}`);
          if (bars.length) barSummaries.push(barAnalysis(bars, tf));
        } catch (barErr) {
          console.error(`[h1-strategy] ${tf} バーデータエラー:`, barErr);
        }
      }));
      // TF順に並び替え（H4→H1→M30→M15）
      const tfOrder = ["H4", "H1", "M30", "M15"];
      barSummaries.sort((a, b) => {
        const ai = tfOrder.findIndex(tf => a.includes(`【${tf}`));
        const bi = tfOrder.findIndex(tf => b.includes(`【${tf}`));
        return ai - bi;
      });

      console.log(`[h1-strategy] barSummaries count=${barSummaries.length}`);

      if (!barSummaries.length || latestClosedH1Ms <= 0) {
        group.forEach(t => results.push({ traderId: t.id, name: t.name, status: "no_bar_data" }));
        continue;
      }

      // 並列取得: 知識・経済指標・ニュース（1回だけ）
      const [knowledgeResult, economicEvents, news] = await Promise.all([
        h1Deps.fetchKnowledge(primary.id as string, primary.user_id as string, primary.market as string, "H1"),
        h1Deps.fetchEconomicEvents(),
        h1Deps.fetchNews(symbol),
      ]);
      const knowledge = knowledgeResult.text;
      const knowledgeSnapshot = knowledgeResult.snapshot;

      // 前回シナリオ（代表トレーダー・直近2件取得して比較に使う）
      const { data: prevScenarios } = await db
        .from("ai_trader_scenarios")
        .select("bias, scenario_text, entry_side, entry_price_low, entry_price_high, reasoning_summary, next_30min_outlook, created_at")
        .eq("ai_trader_id", primary.id)
        .eq("trigger_type", "H1_STRATEGY")
        .order("created_at", { ascending: false })
        .limit(2);
      const prevScenario  = prevScenarios?.[0] ?? null;
      const prev2Scenario = prevScenarios?.[1] ?? null;

      // ── AI 呼び出し（市場グループにつき1回のみ） ────────────────
      const prompt = buildStrategyPrompt(
        profile as Record<string, unknown>,
        barSummaries,
        knowledge,
        economicEvents,
        news,
        prevScenario  as Record<string, unknown> | null,
        prev2Scenario as Record<string, unknown> | null,
      );

      const client  = h1Deps.aiClientFactory();
      const aiModel = process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chat;

      console.log(`[h1-strategy] OpenAI呼び出し開始 model=${aiModel} promptLen=${prompt.length}`);
      let raw = "{}";
      try {
        const completion = await client.chat.completions.create({
          model: aiModel,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: "現在の相場を総合分析し、今後30〜60分のトレードシナリオを構築してください。" },
          ],
          max_completion_tokens: 2000,
          response_format: { type: "json_object" },
        });
        raw = completion.choices[0]?.message?.content ?? "{}";
        console.log(`[h1-strategy] OpenAI完了 tokens=${completion.usage?.total_tokens} rawLen=${raw.length}`);
      } catch (openaiErr) {
        const errMsg = openaiErr instanceof Error ? openaiErr.message : String(openaiErr);
        console.error(`[h1-strategy] OpenAI失敗: ${errMsg}`);
        // エラーでもシナリオレコードを作成してログに出す
        raw = JSON.stringify({ entry_side: "NONE", bias: "NEUTRAL", scenario: `[OpenAIエラー] ${errMsg.slice(0, 200)}`, reasoning: errMsg });
      }

      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }

      const entrySide = (parsed.entry_side as string) ?? "NONE";
      console.log(`[h1-strategy] AI判断: entry_side=${entrySide} bias=${parsed.bias}`);
      const barTime         = latestClosedH1Ms;
      const refPrice        = barSummaries.length > 0
        ? parseFloat(barSummaries[0].split("現値=")[1]?.split(/[\s|]/)[0] ?? "0")
        : null;

      const scenarioPayload = {
        is_active:           true,
        state:               entrySide === "NONE" ? "WATCHING" : "CONSIDERING",
        bias:                (parsed.bias as string) ?? "NEUTRAL",
        scenario_text:       (parsed.scenario as string) ?? raw.slice(0, 500),
        entry_side:          entrySide,
        entry_price_low:     (parsed.entry_price_low  as number) ?? null,
        entry_price_high:    (parsed.entry_price_high as number) ?? null,
        suggested_sl:        (parsed.suggested_sl     as number) ?? null,
        suggested_tp:        (parsed.suggested_tp     as number) ?? null,
        suggested_volume:    (parsed.suggested_volume as number) ?? 0.01,
        watch_zone_low:      (parsed.watch_zone_low   as number) ?? (parsed.entry_price_low  as number) ?? null,
        watch_zone_high:     (parsed.watch_zone_high  as number) ?? (parsed.entry_price_high as number) ?? null,
        invalidate_below:    (parsed.invalidate_below as number) ?? null,
        invalidate_above:    (parsed.invalidate_above as number) ?? null,
        recheck_triggers:    [],
        recheck_triggers_v2: (parsed.recheck_triggers_v2 as unknown[]) ?? [],
        key_levels:          (parsed.key_levels as Record<string, unknown>) ?? null,
        fundamental_notes:   (parsed.fundamental_notes as string) ?? null,
        market:              primary.market,
        reference_price:     refPrice,
        bar_time:            new Date(barTime).toISOString(),
        h1_bar_time:         Math.floor(barTime / 1000),
        ai_model:            aiModel,
        ai_reasoning:        (parsed.reasoning as string) ?? null,
        trigger_type:        "H1_STRATEGY",
        m5_bar_time:         Math.floor(barTime / 1000),
        market_view:         null,
        risk_context:        (parsed.fundamental_notes as string) ?? null,
        reasoning_summary:   (parsed.scenario_change as string)
                             ? `[変化] ${parsed.scenario_change as string}\n${(parsed.scenario as string ?? "").slice(0, 150)}`
                             : (parsed.scenario as string)?.slice(0, 200) ?? null,
        next_30min_outlook:  (parsed.next_30min_outlook as string) ?? null,
        applied_knowledge:   knowledgeSnapshot,
      };

      // Production cutover: Scenario creation and H1 logging are owned by
      // RuntimeService.hourlyAnalysis (which calls the atomic RPC).
      console.log(`[h1-strategy] Runtime hourly analysis trader=${primary.id}`);
      const runtimeScenario = await handleH1Strategy({
        userId: primary.user_id,
        traderId: primary.id,
        traderVersionId: profile.id,
        h1BarTime: Math.floor(latestClosedH1Ms / 1000),
        scenarioPayload,
        knowledgeSnapshot,
        decision: entrySide,
        reasoning: (parsed.reasoning as string) ?? null,
      }, h1Deps);
      results.push({ traderId: primary.id, name: primary.name, status: runtimeScenario ? "ok" : "h1_duplicate", entry_side: entrySide });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[h1-strategy] グループエラー:`, err);
      group.forEach(t => results.push({ traderId: t.id, name: t.name, status: `error: ${msg.slice(0, 100)}` }));
    }
  }

  return NextResponse.json({ ok: true, processed: traders.length, groups: groups.length, results });
}

export async function POST(req: NextRequest) {
  return handleH1StrategyRequest(req);
}

// Vercel Cron invokes this route with GET. Keep the POST implementation as
// the single execution path, but expose an explicit GET handler so the
// production route is emitted as a GET endpoint by the Next.js build.
export async function GET(req: NextRequest) {
  return POST(req);
}

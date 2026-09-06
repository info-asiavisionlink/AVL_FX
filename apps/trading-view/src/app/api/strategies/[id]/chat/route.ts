// =================================================================
// POST /api/strategies/[id]/chat
//
// Strategy専用AIチャット — バックテスト全データをコンテキストに持つ
// ユーザーが自然言語でこのEAについて何でも質問できる
//
// Context includes:
//   - Strategy spec (entry/exit/filters)
//   - Backtest stats (WR, pips, PF, DD, sessions)
//   - Monthly P&L breakdown
//   - Individual trades (top winners / losers + monthly samples)
//   - IS/OOS split analysis (computed from trade timestamps)
//   - Fact-check findings (same-bar rate, statistical CI)
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { getOpenAIClient, MODELS }    from "@/infrastructure/ai/openai-client";
import { conditionToJapanese }        from "@/lib/strategySchema";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// ── Wilson 信頼区間 ──────────────────────────────────────────────────
function wilsonCI(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const denom  = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - spread) * 100, Math.min(1, center + spread) * 100];
}

// ── 月次グルーピング ─────────────────────────────────────────────────
function monthlyStats(trades: DBTrade[]) {
  const map = new Map<string, { wins: number; losses: number; pips: number; count: number }>();
  for (const t of trades) {
    const d   = new Date(t.entry_time);
    const key = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`;
    const cur = map.get(key) ?? { wins: 0, losses: 0, pips: 0, count: 0 };
    cur.count++;
    cur.pips += t.pips;
    if (t.result === "WIN")  cur.wins++;
    if (t.result === "LOSS") cur.losses++;
    map.set(key, cur);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ── DB 型 ────────────────────────────────────────────────────────────
type DBTrade = {
  entry_time: string;
  exit_time:  string;
  direction:  "BUY" | "SELL";
  pips:       number;
  result:     "WIN" | "LOSS" | "BREAKEVEN" | "END_OF_DATA";
  exit_reason: "TP" | "SL" | "END_OF_DATA";
  session:    string;
  entry_price: number;
  exit_price:  number;
  entry_bar_idx: number;
  exit_bar_idx:  number;
};

type DBResult = {
  total_trades: number;
  wins:         number;
  losses:       number;
  win_rate:     number;
  total_pips:   number;
  avg_pips:     number;
  profit_factor: number | null;
  max_drawdown_pct: number;
  max_drawdown_pips: number;
  max_cons_wins:    number;
  max_cons_losses:  number;
  avg_duration_min: number;
  session_stats:    Record<string, unknown>;
  best_session:     string | null;
  worst_session:    string | null;
  verdict:          string;
  verdict_reason:   string;
  data_from:        string | null;
  data_to:          string | null;
  data_coverage_days: number;
  sample_size_warning?: boolean | null;
  min_recommended_trades?: number | null;
};

// ── コンテキスト構築 ──────────────────────────────────────────────────
async function buildStrategyContext(strategyId: string): Promise<string> {
  const db = createAdminClient();

  // 1. Strategy spec
  const { data: row } = await db
    .from("strategy_registry")
    .select("name, strategy_type, description, symbols, timeframes, entry_conditions, exit_conditions, filters, risk, created_at")
    .eq("id", strategyId)
    .single();
  if (!row) throw new Error("Strategy not found");

  // 2. Latest backtest job
  const { data: jobs } = await db
    .from("backtest_jobs")
    .select("id, status, created_at")
    .eq("strategy_id", strategyId)
    .eq("status", "COMPLETED")
    .order("created_at", { ascending: false })
    .limit(1);
  const jobId = jobs?.[0]?.id ?? null;

  // 3. Backtest result
  let result: DBResult | null = null;
  if (jobId) {
    const { data: r } = await db
      .from("backtest_results")
      .select("*")
      .eq("job_id", jobId)
      .single();
    result = r as DBResult | null;
  }

  // 4. Trades
  let trades: DBTrade[] = [];
  if (jobId) {
    const { data: t } = await db
      .from("backtest_trades")
      .select("entry_time,exit_time,direction,pips,result,exit_reason,session,entry_price,exit_price,entry_bar_idx,exit_bar_idx")
      .eq("job_id", jobId)
      .order("entry_time", { ascending: true });
    trades = (t ?? []) as DBTrade[];
  }

  // ── 文字列構築 ──────────────────────────────────────────────────────
  const ec  = row.entry_conditions as { logic: string; conditions: Record<string,unknown>[] };
  const exit = row.exit_conditions as Record<string,unknown> | null;
  const fil  = row.filters as Record<string,unknown> | null;

  const condLines = ec.conditions.map((c, i) =>
    `  ${i+1}. ${conditionToJapanese(c as Parameters<typeof conditionToJapanese>[0])}`
  ).join("\n");

  const slSpec  = exit?.stop_loss  as Record<string,unknown> | undefined;
  const tpSpec  = exit?.take_profit as Record<string,unknown> | undefined;
  const slText  = slSpec  ? `ATR×${slSpec.multiplier ?? 1.5}` : "未設定";
  const tpText  = tpSpec
    ? tpSpec.method === "RR_RATIO" ? `RR比 ${tpSpec.rr_ratio}` : `ATR×${tpSpec.multiplier}`
    : "未設定";

  const trendFilters = (fil?.trend_filters as Record<string,unknown>[] | undefined) ?? [];
  const tfText  = trendFilters.map(f => `${f.timeframe} ${f.indicator}(${f.period}) ${f.direction}`).join(", ") || "なし";
  const sessions = (fil?.sessions as string[] | undefined) ?? [];
  const spread   = fil?.max_spread_pips ?? "無制限";

  let ctx = `
=== EA 仕様 ===
名前: ${row.name}
種別: ${row.strategy_type}
シンボル: ${(row.symbols as string[]).join(", ")}
時間足: ${(row.timeframes as string[]).join(", ")}
登録日: ${new Date(row.created_at as string).toLocaleDateString("ja-JP")}
説明: ${row.description ?? "なし"}

エントリー条件 (${ec.logic}):
${condLines}

ストップロス: ${slText}
テイクプロフィット: ${tpText}
セッションフィルター: ${sessions.length ? sessions.join(", ") : "なし"}
トレンドフィルター: ${tfText}
最大スプレッド: ${spread}pips
リスク: ${(row.risk as Record<string,number>).risk_per_trade}%
`;

  if (result) {
    const pf = result.profit_factor === null ? "∞" : result.profit_factor.toFixed(2);
    ctx += `
=== バックテスト成績 ===
期間: ${result.data_from ? new Date(result.data_from).toLocaleDateString("ja-JP") : "?"} 〜 ${result.data_to ? new Date(result.data_to).toLocaleDateString("ja-JP") : "?"}（${result.data_coverage_days.toFixed(0)}日間）
判定: ${result.verdict === "PASSED" ? "合格" : result.verdict === "CONDITIONAL" ? "条件付き" : "不合格"} — ${result.verdict_reason}

総取引数: ${result.total_trades}
勝ち: ${result.wins}  負け: ${result.losses}
勝率: ${result.win_rate.toFixed(1)}%
合計PIPS: ${result.total_pips.toFixed(1)}
平均PIPS/トレード: ${result.avg_pips.toFixed(1)}
プロフィットファクター (PF): ${pf}
最大ドローダウン: ${result.max_drawdown_pct.toFixed(1)}% (${result.max_drawdown_pips.toFixed(0)}pips)
最大連勝/連敗: ${result.max_cons_wins}連勝 / ${result.max_cons_losses}連敗
平均保有時間: ${result.avg_duration_min.toFixed(0)}分

最良セッション: ${result.best_session ?? "N/A"}
最悪セッション: ${result.worst_session ?? "N/A"}
`;

    // Session breakdown
    const sessions2 = result.session_stats as Record<string,{tradeCount:number;wins:number;winRate:number;totalPips:number;profitFactor:number|null}>;
    if (Object.keys(sessions2).length) {
      ctx += "\nセッション別成績:\n";
      for (const [sess, s] of Object.entries(sessions2)) {
        const pf2 = s.profitFactor === null ? "∞" : (s.profitFactor as number).toFixed(2);
        ctx += `  ${sess}: ${s.tradeCount}件 WR=${(s.winRate as number).toFixed(0)}% Pips=${(s.totalPips as number).toFixed(0)} PF=${pf2}\n`;
      }
    }

    // IS/OOS from trades
    if (trades.length > 10) {
      const cutIdx = Math.floor(trades.length * 0.7);
      const isTrades  = trades.slice(0, cutIdx);
      const oosTrades = trades.slice(cutIdx);
      const isWins  = isTrades.filter(t => t.result === "WIN").length;
      const oosWins = oosTrades.filter(t => t.result === "WIN").length;
      const isPips  = isTrades.reduce((s,t) => s + t.pips, 0);
      const oosPips = oosTrades.reduce((s,t) => s + t.pips, 0);
      const isWR    = isTrades.length > 0 ? isWins / isTrades.length * 100 : 0;
      const oosWR   = oosTrades.length > 0 ? oosWins / oosTrades.length * 100 : 0;
      ctx += `
=== IS/OOS検証（70%/30%分割）===
IS（学習期間 前70%: ${isTrades.length}件）: WR=${isWR.toFixed(1)}% Pips=${isPips.toFixed(0)}
OOS（検証期間 後30%: ${oosTrades.length}件）: WR=${oosWR.toFixed(1)}% Pips=${oosPips.toFixed(0)}
評価: ${oosPips > 0 ? "OOSでもプラス → エッジが存在する可能性あり" : "OOSでマイナス → 過去データへの過剰適合の可能性"}
`;
    }

    // Same-bar exit rate
    const sameBar = trades.filter(t => t.entry_bar_idx === t.exit_bar_idx).length;
    const sameBarPct = trades.length > 0 ? sameBar / trades.length * 100 : 0;
    ctx += `
=== 品質指標 ===
同バー決済率: ${sameBarPct.toFixed(1)}% （20%以上は精度懸念）
統計信頼区間 (WR 95%CI): ${wilsonCI(result.wins, result.total_trades).map(v => v.toFixed(1)).join("〜")}%
サンプル数警告: ${result.sample_size_warning ? "あり（サンプル不足）" : "なし"}
`;

    // Monthly breakdown
    if (trades.length > 0) {
      const monthly = monthlyStats(trades);
      ctx += "\n=== 月次P&L ===\n";
      for (const [month, s] of monthly) {
        const wr = s.count > 0 ? s.wins / s.count * 100 : 0;
        const sign = s.pips >= 0 ? "+" : "";
        ctx += `  ${month}: ${s.count}件 WR=${wr.toFixed(0)}% ${sign}${s.pips.toFixed(0)}pips\n`;
      }
      const profitMonths = monthly.filter(([,s]) => s.pips > 0).length;
      ctx += `黒字月: ${profitMonths}/${monthly.length}ヶ月\n`;
    }

    // Top winners and losers
    if (trades.length > 0) {
      const sorted = [...trades].sort((a, b) => b.pips - a.pips);
      const top5 = sorted.slice(0, 5);
      const bot5 = sorted.slice(-5).reverse();
      ctx += "\n=== ベスト5トレード ===\n";
      for (const t of top5) {
        ctx += `  ${new Date(t.entry_time).toLocaleDateString("ja-JP")} ${t.direction} +${t.pips.toFixed(1)}pips [${t.exit_reason}] ${t.session}\n`;
      }
      ctx += "\n=== ワースト5トレード ===\n";
      for (const t of bot5) {
        ctx += `  ${new Date(t.entry_time).toLocaleDateString("ja-JP")} ${t.direction} ${t.pips.toFixed(1)}pips [${t.exit_reason}] ${t.session}\n`;
      }
    }
  } else {
    ctx += "\n（バックテストデータなし）\n";
  }

  return ctx;
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `あなたはFXトレードEA（Expert Advisor）の専門アナリストです。
ユーザーが特定のEA（自動売買戦略）について自然言語で質問します。
以下の戦略データを元に、正確・具体的・誠実に回答してください。

回答スタイル:
- 具体的な数値（pips、WR、PF等）を必ず引用する
- 「〜の可能性がある」「〜と考えられる」など確実でない場合は明示する
- ネガティブな事実（OOSで損失、ランダムより劣るなど）も隠さず伝える
- 月次データや個別トレードを使って具体的に説明する
- 日本語で回答する
- 200〜400文字程度の簡潔な回答を心がける（長い分析が必要なら適宜延長）`;

// ── POST handler ──────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: Params) {
  const { id: strategyId } = await params;

  try {
    const body = await req.json() as {
      message:  string;
      history?: { role: "user" | "assistant"; content: string }[];
    };

    if (!body.message?.trim()) {
      return NextResponse.json({ error: "メッセージが空です" }, { status: 400 });
    }

    // Build context
    const strategyCtx = await buildStrategyContext(strategyId);

    // Build messages
    const systemContent = `${SYSTEM_PROMPT}\n\n${strategyCtx}`;
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemContent },
    ];

    // Add history (last 10 turns to stay within context)
    const history = (body.history ?? []).slice(-10);
    for (const h of history) {
      messages.push({ role: h.role, content: h.content });
    }

    messages.push({ role: "user", content: body.message });

    // Call AI
    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model:       MODELS.chatFast,
      messages,
      temperature: 0.3,
      max_tokens:  800,
    });

    const answer = completion.choices[0]?.message?.content ?? "回答を生成できませんでした";

    return NextResponse.json({ answer });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[strategy/chat]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

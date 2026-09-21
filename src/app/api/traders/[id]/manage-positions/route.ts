// =================================================================
// POST /api/traders/[id]/manage-positions
//
// Layer 3: M5毎 — オープンポジション個別AI管理
//
// - オープン中の全 ai_positions を取得
// - 各ポジションについて AI が短い分析を行う
// - 決定: HOLD / CLOSE / MODIFY_SL / MODIFY_TP
// - 必要なら execution_command を発行
//
// AIへの入力（短く・安く）:
//   - ポジション詳細（エントリー価格・現在含み損益・SL・TP）
//   - 現在価格・現在のシナリオ
//   - トレーダーの決済ルール
// =================================================================

import { NextRequest, NextResponse }   from "next/server";
import { createAdminClient }            from "@/infrastructure/supabase/admin";
import { createClient }                 from "@/infrastructure/supabase/server";
import { getOpenAIClient, MODELS }      from "@/infrastructure/ai/openai-client";
import { randomUUID }                   from "crypto";

export const runtime     = "nodejs";
export const dynamic     = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET    = process.env.CRON_SECRET    ?? "";
const GATEWAY_URL    = process.env.MT5_GATEWAY_URL ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

async function getCurrentPrice(connId: string, symbol: string): Promise<number> {
  if (!GATEWAY_URL || !connId) return 0;
  try {
    const r = await fetch(
      `${GATEWAY_URL}/connections/${connId}/tick/${encodeURIComponent(symbol)}`,
      { headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, signal: AbortSignal.timeout(4_000) }
    );
    if (!r.ok) return 0;
    const t = await r.json() as { bid?: number; ask?: number };
    return ((t.bid ?? 0) + (t.ask ?? 0)) / 2 || (t.bid ?? 0);
  } catch { return 0; }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db     = createAdminClient();

  // 認証（Cron or ログインユーザー）
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = CRON_SECRET && cronSecret === CRON_SECRET;
  const cronUserId = isCron ? (req.headers.get("x-user-id") ?? "") : null;

  let userId = cronUserId ?? "";
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
    userId = user.id;
  }

  // トレーダー取得
  const { data: trader } = await db
    .from("ai_traders")
    .select("*, current_version")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (!trader) return NextResponse.json({ error: "Traderが見つかりません" }, { status: 404 });

  // プロフィール取得
  const { data: profile } = await db
    .from("ai_trader_versions")
    .select("instructions, personality, trading_style, risk_profile, minimum_rr, max_risk_per_trade")
    .eq("ai_trader_id", id)
    .eq("version", trader.current_version)
    .single();

  // 現在のシナリオ
  const { data: scenario } = await db
    .from("ai_trader_scenarios")
    .select("bias, scenario_text, entry_side, suggested_sl, suggested_tp, key_levels")
    .eq("ai_trader_id", id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  // オープンポジション取得
  const { data: positions } = await db
    .from("ai_positions")
    .select("*")
    .eq("ai_trader_id", id)
    .eq("status", "OPEN");

  if (!positions?.length) {
    return NextResponse.json({ ok: true, message: "オープンポジションなし", managed: 0 });
  }

  // MT5接続・現在価格
  const { data: conn } = await db
    .from("mt5_connections")
    .select("id, last_heartbeat_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  const symbol = trader.market === "GOLD" ? "GOLD#" : (trader.market as string);
  const mt5Online = conn && (Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime()) < 90_000;
  const currentPrice = mt5Online && conn ? await getCurrentPrice(conn.id, symbol) : 0;

  const client  = getOpenAIClient();
  const aiModel = process.env.OPENAI_MODEL_STRATEGY ?? MODELS.chatFast; // 安いモデルでOK
  const managed: { posId: string; decision: string; action?: string }[] = [];

  for (const pos of positions) {
    const unrealizedPips = pos.side === "BUY"
      ? currentPrice - (pos.entry_price ?? 0)
      : (pos.entry_price ?? 0) - currentPrice;
    const unrealizedUsd = unrealizedPips * 10 * (pos.volume ?? 0.01) * 100; // 概算

    const posPrompt = `あなたはFXトレーダー（${profile?.trading_style ?? "スイング"}スタイル）のポジション管理AIです。
${profile?.instructions ? `あなたのルール: ${profile.instructions.slice(0, 300)}` : ""}

## 現在のシナリオ
${scenario ? `バイアス: ${scenario.bias} | ${scenario.scenario_text?.slice(0, 200)}` : "シナリオなし"}

## 管理対象ポジション
- 方向: ${pos.side}
- エントリー価格: ${pos.entry_price}
- 現在価格: ${currentPrice > 0 ? currentPrice.toFixed(2) : "不明"}
- 含み損益: ${unrealizedPips > 0 ? "+" : ""}${unrealizedPips.toFixed(2)} pips（概算 $${unrealizedUsd.toFixed(0)}）
- 現在SL: ${pos.stop_loss ?? "未設定"}
- 現在TP: ${pos.take_profit ?? "未設定"}
- マジックナンバー: ${pos.magic_number}

## 判断してください
以下のJSONを返してください:
{
  "decision": "HOLD" | "CLOSE" | "MODIFY_SL" | "MODIFY_TP",
  "new_sl": 数値またはnull（MODIFY_SLの場合のみ・現在SLより有利な価格のみ許可）,
  "new_tp": 数値またはnull（MODIFY_TPの場合のみ）,
  "reasoning": "判断理由（1文）"
}

重要ルール:
- CLOSE は損切りラインを割った、またはシナリオが完全に崩れた場合のみ
- SL は損失方向に動かしてはいけない（トレーリングのみ許可）
- 含み益がある場合は損益分岐点へのSL移動を積極的に検討
- HOLDが最もデフォルト（迷ったらHOLD）`;

    try {
      const completion = await client.chat.completions.create({
        model: aiModel,
        messages: [
          { role: "system", content: posPrompt },
          { role: "user", content: "このポジションをどうすべきか判断してください。" },
        ],
        max_completion_tokens: 300,
        response_format: { type: "json_object" },
      });

      const raw    = completion.choices[0]?.message?.content ?? "{}";
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(raw); } catch { parsed = { decision: "HOLD" }; }

      const decision = (parsed.decision as string) ?? "HOLD";
      managed.push({ posId: pos.id, decision });

      if (decision === "HOLD") continue;

      // execution_command 発行
      if (decision === "CLOSE") {
        await db.from("execution_commands").insert({
          command_id:     randomUUID(),
          ai_trader_id:   id,
          ai_position_id: pos.id,
          user_id:        userId,
          connection_id:  conn?.id ?? null,
          action:         "CLOSE",
          symbol,
          magic_number:   pos.magic_number,
          position_ticket: pos.position_ticket,
          volume:         pos.volume,
          stop_loss:      null,
          take_profit:    null,
          expires_at:     new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          status:         "PENDING",
          metadata:       { source: "position_management", reasoning: (parsed.reasoning as string ?? "").slice(0, 200) },
        });
        managed[managed.length - 1].action = "command_issued";

      } else if (decision === "MODIFY_SL" && parsed.new_sl) {
        await db.from("execution_commands").insert({
          command_id:     randomUUID(),
          ai_trader_id:   id,
          ai_position_id: pos.id,
          user_id:        userId,
          connection_id:  conn?.id ?? null,
          action:         "MODIFY_SL",
          symbol,
          magic_number:   pos.magic_number,
          position_ticket: pos.position_ticket,
          stop_loss:      parsed.new_sl as number,
          take_profit:    null,
          volume:         pos.volume,
          expires_at:     new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          status:         "PENDING",
          metadata:       { source: "sl_adjustment", reasoning: (parsed.reasoning as string ?? "").slice(0, 200) },
        });
        managed[managed.length - 1].action = "command_issued";

      } else if (decision === "MODIFY_TP" && parsed.new_tp) {
        await db.from("execution_commands").insert({
          command_id:     randomUUID(),
          ai_trader_id:   id,
          ai_position_id: pos.id,
          user_id:        userId,
          connection_id:  conn?.id ?? null,
          action:         "MODIFY_TP",
          symbol,
          magic_number:   pos.magic_number,
          position_ticket: pos.position_ticket,
          stop_loss:      null,
          take_profit:    parsed.new_tp as number,
          volume:         pos.volume,
          expires_at:     new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          status:         "PENDING",
          metadata:       { source: "tp_adjustment", reasoning: (parsed.reasoning as string ?? "").slice(0, 200) },
        });
        managed[managed.length - 1].action = "command_issued";
      }
    } catch {
      managed.push({ posId: pos.id, decision: "HOLD", action: "error" });
    }
  }

  return NextResponse.json({ ok: true, managed: managed.length, results: managed });
}

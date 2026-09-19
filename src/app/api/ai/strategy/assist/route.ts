// POST /api/ai/strategy/assist
//
// EA Builder の AI アシスト機能
//
// action:
//   "generate"          — 自然言語テキストをゼロから生成
//   "refine"            — ユーザーの曖昧テキストを洗練
//   "suggest-metrics"   — PF/MDD/勝率/ペイオフ の推奨値を提案
//   "suggest-timeframes"— マルチタイムフレーム構成を提案

import { NextRequest, NextResponse } from "next/server";
import { getOpenAIClient, MODELS }   from "@/infrastructure/ai/openai-client";

export const runtime    = "nodejs";
export const maxDuration = 30;

const SYSTEM = `You are AVL FX Strategy Assistant specializing in GOLD# (XAU/USD) trading on XM Trading.
Always respond in Japanese. Be concise and practical. Output plain text, no markdown.`;

export async function POST(req: NextRequest) {
  try {
    const { action, text, timeframes } = await req.json() as {
      action:     string;
      text?:      string;
      timeframes?: string[];
    };

    const client = getOpenAIClient();

    // ── generate: ゼロから戦略テキストを生成 ─────────────────────
    if (action === "generate") {
      const prompt = `GOLD# のトレード戦略を1つ考えて、以下の形式で日本語テキストとして書いてください。
出力形式（自然言語で、箇条書きなし、150字以内）:
「GOLD#の[時間足]。[トレンドフィルター]。[エントリー条件]。[決済条件の一言]。」

条件:
- スイング・デイトレ・スキャルピングのどれか1つをランダムで選ぶ
- インジケーターはICHIMOKU/EMA/RSI/MACD/ADX/BBのどれかを使う
- BUYまたはSELL、または両方に対応
- リアルで使えそうな実践的な内容`;

      const res = await client.chat.completions.create({
        model:    MODELS.chat,
        messages: [
          { role: "system",  content: SYSTEM },
          { role: "user",    content: prompt },
        ],
        max_completion_tokens: 200,
      });
      return NextResponse.json({ result: res.choices[0]?.message?.content?.trim() ?? "" });
    }

    // ── refine: ユーザーテキストを洗練 ───────────────────────────
    if (action === "refine") {
      if (!text) return NextResponse.json({ error: "text が必要です" }, { status: 400 });

      const prompt = `以下のGOLD#トレード戦略の説明を、より明確で具体的な日本語テキストに書き直してください。
元のテキストの意図を維持しながら、インジケーター名・時間足・条件を明確にしてください。
出力は改行なし・150字以内の自然言語テキストのみ。

入力テキスト:
${text}`;

      const res = await client.chat.completions.create({
        model:    MODELS.chat,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user",   content: prompt },
        ],
        max_completion_tokens: 200,
      });
      return NextResponse.json({ result: res.choices[0]?.message?.content?.trim() ?? "" });
    }

    // ── suggest-metrics: 指標の推奨値を提案 ─────────────────────
    if (action === "suggest-metrics") {
      const strategyHint = text ? `戦略の概要: ${text}` : "GOLD# のデイトレ・スイング戦略";

      const prompt = `${strategyHint}

この戦略のバックテスト目標値として適切な値を JSON で提案してください。
出力: {"minPF": 数値, "maxMDD": 数値（%）, "minWR": 数値（%）, "minPayoff": 数値}
例: {"minPF": 1.3, "maxMDD": 20, "minWR": 50, "minPayoff": 1.2}`;

      const res = await client.chat.completions.create({
        model:    MODELS.chat,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user",   content: prompt },
        ],
        max_completion_tokens: 100,
        response_format: { type: "json_object" },
      });

      const raw = res.choices[0]?.message?.content ?? "{}";
      const data = JSON.parse(raw) as Record<string, number>;
      return NextResponse.json({
        minPF:     String(data.minPF     ?? "1.3"),
        maxMDD:    String(data.maxMDD    ?? "20"),
        minWR:     String(data.minWR     ?? "50"),
        minPayoff: String(data.minPayoff ?? "1.2"),
      });
    }

    // ── suggest-timeframes: マルチTF構成を提案 ──────────────────
    if (action === "suggest-timeframes") {
      const strategyHint = text ? `戦略: ${text}` : "GOLD# トレード戦略";

      const prompt = `${strategyHint}

この戦略に最適なマルチタイムフレーム分析構成を JSON で提案してください。
利用可能時間足: M1, M5, M15, M30, H1, H4, D1, W1
出力形式: {"timeframes": ["H4", "D1"], "descriptions": {"H4": "H4での分析説明", "D1": "D1での分析説明"}}

各説明は30字以内の日本語で。`;

      const res = await client.chat.completions.create({
        model:    MODELS.chat,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user",   content: prompt },
        ],
        max_completion_tokens: 200,
        response_format: { type: "json_object" },
      });

      const raw  = res.choices[0]?.message?.content ?? "{}";
      const data = JSON.parse(raw) as { timeframes?: string[]; descriptions?: Record<string,string> };
      return NextResponse.json({
        timeframes:   data.timeframes   ?? ["H4", "D1"],
        descriptions: data.descriptions ?? {},
      });
    }

    return NextResponse.json({ error: "不明な action です" }, { status: 400 });

  } catch (e) {
    console.error("[ai/strategy/assist]", e);
    return NextResponse.json({ error: "AI アシストに失敗しました" }, { status: 500 });
  }
}

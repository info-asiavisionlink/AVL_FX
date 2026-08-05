// =================================================================
// POST /api/ai/realtime-session
// OpenAI Realtime API 用クライアントシークレットを発行する
// SDK v6.49+:
//   client.realtime.clientSecrets.create({
//     session: { type:'realtime', model, instructions, audio:{ input:{...}, output:{voice} } }
//   })
// =================================================================

import { NextResponse }                    from "next/server";
import { getOpenAIClient, MODELS }         from "@/infrastructure/ai/openai-client";
import { buildMarketContext } from "@/infrastructure/ai/market-context";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { symbol = "EURUSD" } = await req.json().catch(() => ({})) as { symbol?: string };

    const client    = getOpenAIClient();
    const marketCtx = await buildMarketContext(symbol);
    const model     = (process.env.OPENAI_REALTIME_MODEL ?? MODELS.realtime) as
      "gpt-4o-realtime-preview" | "gpt-4o-mini-realtime-preview";

    const instructions = `あなたは AVL FX の専属 AI トレーディングアシスタント「AVL AI」です。
音声で自然に会話しながら FX 市場の分析・売買提案を行います。

## 役割
- EMA・ATR・Spread などリアルタイムデータをもとに市場を分析する
- 売買判断は根拠とともに簡潔に説明する
- エントリー・SL・TP・RR・確度を必ず提示する
- 注文前は必ずユーザーに確認を取る（「注文しますか？」と聞く）
- 日本語で話す。3文以内で簡潔に答える

## 現在の市場データ
${marketCtx}`;

    const secret = await client.realtime.clientSecrets.create({
      session: {
        type:         "realtime",
        model,
        instructions,
        audio: {
          output: { voice: "alloy" },
          input: {
            transcription: { model: "whisper-1" },
            turn_detection: {
              type:                "server_vad",
              threshold:           0.5,
              prefix_padding_ms:   300,
              silence_duration_ms: 700,
            },
          },
        },
      },
      expires_after: { anchor: "created_at", seconds: 600 },
    });

    return NextResponse.json({
      token:   secret.value,
      expires: secret.expires_at,
      model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[realtime-session]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

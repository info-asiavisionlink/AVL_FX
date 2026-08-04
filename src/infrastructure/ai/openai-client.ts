// =================================================================
// OpenAI クライアント — サーバーサイド専用
// =================================================================
// OPENAI_API_KEY は .env.local に保存（クライアントに露出しない）
// モデルは将来 Claude / Gemini へ切り替えられる設計

import OpenAI from "openai";

// シングルトン（サーバー側でのみ初期化）
let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY が設定されていません");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export const MODELS = {
  chat:     process.env.OPENAI_MODEL          ?? "gpt-4.1",
  realtime: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
} as const;

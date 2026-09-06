import OpenAI from "openai";

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
  chat:       process.env.OPENAI_MODEL          ?? "gpt-5.6-terra",
  chatFast:   process.env.OPENAI_MODEL_FAST     ?? "gpt-5.6-luna",
  realtime:   process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
  embedding:  "text-embedding-3-small",
  transcribe: "gpt-4o-transcribe",
} as const;

export const KNOWLEDGE_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID ?? "";

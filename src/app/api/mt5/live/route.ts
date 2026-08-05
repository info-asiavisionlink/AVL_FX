// =================================================================
// GET /api/mt5/live
// Gateway からシンボル・口座・インジケーターをまとめて取得
// ブラウザ → Vercel API → Gateway（CORS回避）
// =================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const GW = process.env.MT5_GATEWAY_URL ?? "http://127.0.0.1:8080";
const HEADERS: Record<string, string> = process.env.MT5_GATEWAY_SECRET
  ? { Authorization: `Bearer ${process.env.MT5_GATEWAY_SECRET}` }
  : {};

async function safeFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${GW}${path}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

export async function GET() {
  const [symbols, account, indicators] = await Promise.all([
    safeFetch<unknown[]>("/symbols"),
    safeFetch<unknown>("/account"),
    safeFetch<unknown[]>("/indicators"),
  ]);

  return NextResponse.json(
    { symbols: symbols ?? [], account: account ?? null, indicators: indicators ?? [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// =================================================================
// GET /api/mt5/live
// Gateway からシンボル・口座・インジケーターをまとめて取得
// ブラウザ → Vercel API → Gateway（CORS回避）
// =================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const GW =
  process.env.MT5_GATEWAY_URL ??
  process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ??
  "http://127.0.0.1:8080";
const HEADERS: Record<string, string> = process.env.MT5_GATEWAY_SECRET
  ? { Authorization: `Bearer ${process.env.MT5_GATEWAY_SECRET}` }
  : {};

async function safeFetch<T>(path: string): Promise<{ data: T | null; status: number | string }> {
  try {
    const res = await fetch(`${GW}${path}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { data: null, status: res.status };
    return { data: await res.json() as T, status: res.status };
  } catch (e) {
    return { data: null, status: String(e) };
  }
}

export async function GET() {
  const gwHost = GW.replace(/^https?:\/\//, "").split("/")[0];
  const [sym, acc, ind] = await Promise.all([
    safeFetch<unknown[]>("/symbols"),
    safeFetch<unknown>("/account"),
    safeFetch<unknown[]>("/indicators"),
  ]);

  return NextResponse.json(
    {
      symbols:    sym.data ?? [],
      account:    acc.data ?? null,
      indicators: ind.data ?? [],
      _debug: { gw: gwHost, sym: sym.status, acc: acc.status, ind: ind.status },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

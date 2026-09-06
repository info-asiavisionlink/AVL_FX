import { NextResponse } from "next/server";

const GW = process.env.MT5_GATEWAY_URL ?? process.env.NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL ?? "http://127.0.0.1:8080";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    const res = await fetch(`${GW}/tick/${symbol.toUpperCase()}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return NextResponse.json({ error: `Gateway ${res.status}` }, { status: res.status });
    return NextResponse.json(await res.json(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

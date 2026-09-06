import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get("symbol");
  const tf = searchParams.get("tf");
  const count = searchParams.get("count") ?? "100";

  if (!symbol || !tf) {
    return NextResponse.json({ error: "Missing symbol or tf" }, { status: 400 });
  }

  const gatewayUrl = process.env.MT5_GATEWAY_URL;
  if (!gatewayUrl) {
    return NextResponse.json([], { status: 200 });
  }

  try {
    const res = await fetch(
      `${gatewayUrl}/bars/${encodeURIComponent(symbol)}/${tf}?count=${count}`,
      {
        headers: { Authorization: `Bearer ${process.env.MT5_GATEWAY_SECRET ?? ""}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[mt5/bars/simple]", err);
    return NextResponse.json([], { status: 200 });
  }
}

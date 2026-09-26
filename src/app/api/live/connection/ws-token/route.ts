import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";

const TOKEN_TTL_SECONDS = 60;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function GET(req: NextRequest) {
  const secret = process.env.MT5_GATEWAY_SECRET ?? "";
  if (!secret) return NextResponse.json({ error: "Gateway unavailable" }, { status: 503 });

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const requested = req.nextUrl.searchParams.get("connection_id") ?? req.nextUrl.searchParams.get("connectionId");
  let query = supabase.from("mt5_connections").select("id").eq("user_id", user.id);
  if (requested) query = query.eq("id", requested);
  const { data: connection, error } = await query.order("created_at", { ascending: false }).limit(1).single();
  if (error) return NextResponse.json({ error: "Connection ownership unavailable" }, { status: 503 });
  if (!connection) return NextResponse.json({ error: "MT5 connection unavailable" }, { status: 404 });

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = JSON.stringify({ connectionId: connection.id, exp });
  const encoded = Buffer.from(payload).toString("base64url");
  return NextResponse.json({ connectionId: connection.id, accessToken: `${encoded}.${sign(encoded, secret)}`, expiresAt: exp });
}

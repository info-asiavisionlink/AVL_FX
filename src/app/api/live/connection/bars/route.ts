// =================================================================
// GET /api/live/connection/bars?symbol=XAUUSD&tf=H1&count=500
// User MT5 の過去バーを取得
//   1. Gateway（リアルタイム、EA接続中のみ）
//   2. Supabase bar_data（フォールバック）
// =================================================================
import { createServerClient } from "@supabase/ssr";
import { createClient }       from "@supabase/supabase-js";
import { cookies }            from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const GATEWAY_URL    = process.env.MT5_GATEWAY_URL ?? "";
const GATEWAY_SECRET = process.env.MT5_GATEWAY_SECRET ?? "";

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  const tf     = req.nextUrl.searchParams.get("tf")?.toUpperCase();
  const count  = Number(req.nextUrl.searchParams.get("count") ?? "500");

  if (!symbol || !tf) {
    return NextResponse.json({ error: "symbol / tf required" }, { status: 400 });
  }

  // ユーザーの接続情報を確認
  const { data: conn } = await supabase
    .from("mt5_connections")
    .select("id, last_heartbeat_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!conn) {
    return NextResponse.json({ error: "MT5未接続" }, { status: 404 });
  }

  const ageMs = Date.now() - new Date(conn.last_heartbeat_at ?? 0).getTime();
  const isOnline = ageMs < 120_000;

  // ── 1. Gateway（EA接続中かつリアルタイムデータあり）──────────────
  if (isOnline && GATEWAY_URL && GATEWAY_SECRET) {
    try {
      const r = await fetch(
        `${GATEWAY_URL}/bars/${encodeURIComponent(symbol)}/${tf}?count=${count}`,
        {
          headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
          signal: AbortSignal.timeout(6000),
        }
      );
      if (r.ok) {
        const bars = await r.json() as unknown[];
        if (Array.isArray(bars) && bars.length > 0) {
          return NextResponse.json(bars);
        }
      }
    } catch {
      // タイムアウト等: Supabase フォールバックへ
    }
  }

  // ── 2. Supabase bar_data フォールバック ────────────────────────────
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // time_utc を秒の unix タイムスタンプに変換して返す
  const { data: rows, error } = await admin
    .from("bar_data")
    .select("time_utc, open, high, low, close, volume")
    .eq("symbol", symbol)
    .eq("timeframe", tf)
    .order("time_utc", { ascending: false })
    .limit(count);

  if (error || !rows || rows.length === 0) {
    return NextResponse.json([], { status: 200 });
  }

  // Supabase の time_utc (ISO string) → 秒 unix に変換してチャートに渡す
  const bars = rows
    .reverse()
    .map((r) => ({
      time:   Math.floor(new Date(r.time_utc as string).getTime() / 1000),
      open:   r.open,
      high:   r.high,
      low:    r.low,
      close:  r.close,
      volume: r.volume,
    }));

  return NextResponse.json(bars);
}

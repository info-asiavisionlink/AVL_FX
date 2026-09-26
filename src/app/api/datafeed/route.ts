import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/infrastructure/supabase/server";

// =================================================================
// TradingView UDF Datafeed — Supabase bar_data を直接参照
// Gateway のメモリではなく Supabase の永続データを使う
// =================================================================

// TradingView resolution → DB timeframe
const RESOLUTION_MAP: Record<string, string> = {
  "1": "M1", "5": "M5", "15": "M15", "30": "M30",
  "60": "H1", "240": "H4", "D": "D1", "W": "W1", "M": "MN",
};

// XMブローカーのサーバータイムはUTC+3 → bar_dataのtime_utcはブローカー時刻で保存
// TradingViewはUTC秒で渡してくるので変換が必要
const BROKER_OFFSET_SEC = 3 * 3600; // UTC+3

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get("action");

  switch (action) {
    case "config":
      return NextResponse.json({
        supported_resolutions: ["1", "5", "15", "30", "60", "240", "D", "W"],
        supports_group_request: false,
        supports_marks: false,
        supports_search: true,
        supports_timescale_marks: false,
        exchanges: [{ value: "FOREX", name: "FOREX", desc: "" }],
      });

    case "symbol_info": {
      const sym = searchParams.get("symbol") ?? "EURUSD";
      const isJPY = sym.includes("JPY");
      const isMetal = sym.includes("GOLD") || sym.includes("SILVER") || sym.includes("XAU") || sym.includes("XAG");
      return NextResponse.json({
        symbol: sym,
        full_name: sym,
        description: sym,
        exchange: "FOREX",
        type: "forex",
        timezone: "Etc/UTC",
        pricescale: isJPY ? 1000 : isMetal ? 100 : 100000,
        has_intraday: true,
        has_no_volume: true,
        session: "24x7",
        minmov: 1,
      });
    }

    case "history":
      return await fetchHistory(searchParams);

    case "search_symbols": {
      const supabase = await createClient();
      const owned = await getOwnedConnection(supabase, searchParams.get("connection_id"));
      if (owned.error) return owned.error;
      const { data } = await supabase.from("bar_data")
        .select("symbol").eq("connection_id", owned.connectionId).limit(1000);
      const symbols = [...new Set((data ?? []).map(r => r.symbol))].sort();
      return NextResponse.json(
        symbols.map(s => ({
          symbol: s, full_name: s, description: s,
          exchange: "FOREX", type: "forex",
        }))
      );
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}

async function fetchHistory(params: URLSearchParams) {
  const symbol     = (params.get("symbol") ?? "EURUSD").toUpperCase();
  const resolution = params.get("resolution") ?? "60";
  const from       = Number(params.get("from") ?? 0);       // UTC seconds
  const to         = Number(params.get("to")   ?? Math.floor(Date.now() / 1000));

  const timeframe = RESOLUTION_MAP[resolution] ?? "H1";

  // ブローカー時刻に変換して Supabase をクエリ
  const fromBroker = new Date((from + BROKER_OFFSET_SEC) * 1000).toISOString();
  const toBroker   = new Date((to   + BROKER_OFFSET_SEC) * 1000).toISOString();

  try {
    const supabase = await createClient();
    const owned = await getOwnedConnection(supabase, params.get("connection_id"));
    if (owned.error) return owned.error;
    const { data, error } = await supabase
      .from("bar_data")
      .select("time_utc, open, high, low, close, volume")
      .eq("connection_id", owned.connectionId)
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
      .gte("time_utc", fromBroker)
      .lte("time_utc", toBroker)
      .order("time_utc", { ascending: true })
      .limit(5000);

    if (error || !data || data.length === 0) {
      // 範囲にデータがない場合は直近N本をフォールバックで返す
      const { data: recent } = await supabase
        .from("bar_data")
        .select("time_utc, open, high, low, close, volume")
        .eq("connection_id", owned.connectionId)
        .eq("symbol", symbol)
        .eq("timeframe", timeframe)
        .order("time_utc", { ascending: false })
        .limit(500);

      if (!recent || recent.length === 0) {
        return NextResponse.json({ s: "no_data" });
      }
      recent.reverse();
      return toUDF(recent);
    }

    return toUDF(data);
  } catch {
    return NextResponse.json({ s: "no_data" });
  }
}

async function getOwnedConnection(supabase: Awaited<ReturnType<typeof createClient>>, requested: string | null) {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  let query = supabase.from("mt5_connections").select("id").eq("user_id", user.id);
  if (requested) query = query.eq("id", requested);
  const { data: connection, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return { error: NextResponse.json({ error: "Connection ownership unavailable" }, { status: 503 }) } as const;
  if (!connection) return { error: NextResponse.json({ error: "Connection not found" }, { status: 404 }) } as const;
  return { userId: user.id, connectionId: connection.id } as const;
}

function toUDF(bars: { time_utc: string; open: number; high: number; low: number; close: number; volume: number }[]) {
  return NextResponse.json({
    s: "ok",
    // ブローカー時刻 → UTC秒 (UTC+3 を引く)
    t: bars.map(b => Math.floor(new Date(b.time_utc).getTime() / 1000) - BROKER_OFFSET_SEC),
    o: bars.map(b => b.open),
    h: bars.map(b => b.high),
    l: bars.map(b => b.low),
    c: bars.map(b => b.close),
    v: bars.map(b => b.volume ?? 0),
  });
}

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// GET /api/live/positions — Live Position一覧（OPENのみ）
// Source of Truth = MT5/Broker。このAPIはDBのMirrorを返す。
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

  const searchParams = req.nextUrl.searchParams;
  const strategyId   = searchParams.get("strategy_id");
  const connectionId = searchParams.get("connection_id");

  let query = supabase
    .from("live_positions")
    .select("*")
    .eq("user_id", user.id)
    .eq("status", "OPEN")
    .order("opened_at", { ascending: false });

  if (strategyId)   query = query.eq("strategy_id",   strategyId);
  if (connectionId) query = query.eq("connection_id", connectionId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    positions: data,
    note: "Source of Truth = MT5/Broker。このデータはMT5との定期同期によるMirrorです。",
  });
}

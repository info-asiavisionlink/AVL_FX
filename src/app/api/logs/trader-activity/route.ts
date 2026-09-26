// Canonical customer AI decision timeline.
// ai_analysis_logs is the primary source; related tables are correlation data.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { createClient } from "@/infrastructure/supabase/server";
import { dedupeTimeline, sanitizeTimelineLog, type TimelineLogRow } from "@/lib/ai-trader/timeline";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const requestedTrader = searchParams.get("trader_id");
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : 100;
  const db = createAdminClient();

  // Primary tenant boundary plus trader owner integrity check. The joined
  // owner is equivalent to `t.user_id === user.id` before serialization.
  if (requestedTrader) {
    const { data: ownedTrader, error: ownerError } = await db
      .from("ai_traders").select("id").eq("id", requestedTrader).eq("user_id", user.id).maybeSingle();
    if (ownerError) return NextResponse.json({ error: "ログの所有者確認に失敗しました" }, { status: 500 });
    if (!ownedTrader) return NextResponse.json({ error: "対象のTraderが見つかりません" }, { status: 404 });
  }

  let query = db.from("ai_analysis_logs")
    .select("id, user_id, trader_id, ai_trader_version_id, scenario_id, position_id, command_id, trigger_type, analysis_type, decision, market_timestamp, market_context, reasoning_summary, error, created_at, ai_traders(name, market, user_id)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (requestedTrader) query = query.eq("trader_id", requestedTrader);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "ログの取得に失敗しました" }, { status: 500 });
  const entries = dedupeTimeline(((data ?? []) as unknown as TimelineLogRow[])
    .map(sanitizeTimelineLog)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  return NextResponse.json({ ok: true, entries, items: entries, has_more: entries.length >= limit });
}

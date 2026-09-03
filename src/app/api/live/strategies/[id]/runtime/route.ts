import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// GET /api/live/strategies/[id]/runtime — Strategy Runtime State取得
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
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

  // Strategy所有権確認
  const { data: strategy, error: stratErr } = await supabase
    .from("strategy_registry")
    .select("id, name, status, enabled, magic_number")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (stratErr || !strategy) {
    return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
  }

  // Runtime State（存在しない場合はStopped状態を返す）
  const { data: runtimeState } = await supabase
    .from("strategy_runtime_state")
    .select("*")
    .eq("strategy_id", params.id)
    .single();

  return NextResponse.json({
    strategy: {
      id:           strategy.id,
      name:         strategy.name,
      status:       strategy.status,
      enabled:      strategy.enabled,
      magicNumber:  strategy.magic_number,
    },
    runtime: runtimeState ?? {
      strategyId:      params.id,
      connectionId:    null,
      runtimeStatus:   "STOPPED",
      startedAt:       null,
      stoppedAt:       null,
      lastEvaluatedAt: null,
      lastSignalAt:    null,
      lastBarTime:     null,
      lastError:       null,
      runtimeVersion:  1,
    },
  });
}

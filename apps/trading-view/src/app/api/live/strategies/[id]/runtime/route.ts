import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

// GET /api/live/strategies/[id]/runtime — Strategy Runtime State取得
export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  const { id } = await params;
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
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (stratErr || !strategy) {
    return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
  }

  // Runtime State（存在しない場合はStopped状態を返す）
  const { data: runtimeState } = await supabase
    .from("strategy_runtime_state")
    .select("*")
    .eq("strategy_id", id)
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
      strategyId:      id,
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

// POST /api/live/strategies/[id]/runtime — STOPPED/ERROR → RUNNING (起動)
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;

  // 1. Auth確認 (user session)
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

  // 2. Strategy所有権確認
  const { data: strategy, error: stratErr } = await supabase
    .from("strategy_registry")
    .select("id, name, enabled")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (stratErr || !strategy) {
    return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
  }

  // 3. User のアクティブMT5接続を確認（service_role でアクセス）
  const adminSupabase = createAdminClient();
  const { data: activeConnection, error: connErr } = await adminSupabase
    .from("mt5_connections")
    .select("id, last_heartbeat_at, status")
    .eq("user_id", user.id)
    .eq("status", "CONNECTED")
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .single();

  if (connErr || !activeConnection) {
    return NextResponse.json({ error: "MT5未接続: アクティブなMT5接続が見つかりません" }, { status: 409 });
  }

  // last_heartbeat_at が90秒以内であることを確認
  const heartbeatAge = Date.now() - new Date(activeConnection.last_heartbeat_at ?? 0).getTime();
  if (heartbeatAge > 90_000) {
    return NextResponse.json({ error: "MT5未接続: ハートビートがタイムアウトしています (90秒超過)" }, { status: 409 });
  }

  // 4. strategy_runtime_state をUPSERT (RUNNING)
  const now = new Date().toISOString();
  const { error: upsertErr } = await adminSupabase
    .from("strategy_runtime_state")
    .upsert({
      strategy_id:      id,
      runtime_status:   "RUNNING",
      connection_id:    activeConnection.id,
      started_at:       now,
      stopped_at:       null,
      last_error:       null,
      updated_at:       now,
    }, { onConflict: "strategy_id" });

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // 5. strategy_registry.enabled = true に更新
  const { error: enableErr } = await adminSupabase
    .from("strategy_registry")
    .update({ enabled: true, updated_at: now })
    .eq("id", id);

  if (enableErr) {
    return NextResponse.json({ error: enableErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok:            true,
    runtimeStatus: "RUNNING",
    connectionId:  activeConnection.id,
  });
}

// DELETE /api/live/strategies/[id]/runtime — RUNNING → STOPPED (停止)
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;

  // 1. Auth確認
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

  // 2. Strategy所有権確認
  const { data: strategy, error: stratErr } = await supabase
    .from("strategy_registry")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (stratErr || !strategy) {
    return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
  }

  const adminSupabase = createAdminClient();
  const now = new Date().toISOString();

  // 3. strategy_runtime_state UPSERT (STOPPED)
  const { error: upsertErr } = await adminSupabase
    .from("strategy_runtime_state")
    .upsert({
      strategy_id:    id,
      runtime_status: "STOPPED",
      stopped_at:     now,
      updated_at:     now,
    }, { onConflict: "strategy_id" });

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // 4. strategy_registry.enabled = false
  const { error: disableErr } = await adminSupabase
    .from("strategy_registry")
    .update({ enabled: false, updated_at: now })
    .eq("id", id);

  if (disableErr) {
    return NextResponse.json({ error: disableErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok:            true,
    runtimeStatus: "STOPPED",
  });
}

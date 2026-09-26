// =================================================================
// GET  /api/traders  → AI Trader 一覧（自分のもの）
// POST /api/traders  → AI Trader 新規作成
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { createClient }               from "@/infrastructure/supabase/server";
import {
  normalizeAndValidateBuilderSave,
  generateTraderPublicId,
  DEFAULT_DAY_TRADING_TIMEFRAME_PROFILE,
  type AITrader,
} from "@/lib/aiTraderSchema";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// GET — 一覧取得
// ---------------------------------------------------------------------------
export async function GET() {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

    const db = createAdminClient();
    const { data, error } = await db
      .from("ai_traders")
      .select(`
        *,
        current_profile:ai_trader_versions(*)
      `)
      .eq("user_id", user.id)
      .neq("status", "ARCHIVED")
      .order("created_at", { ascending: false });

    if (error) throw error;

    // current_profile を current_version と一致するものに絞る
    const traders = ((data ?? []) as unknown as AITrader[]).map(t => {
      const profiles = (t.current_profile as unknown as AITrader["current_profile"][]) ?? [];
      const profile  = (profiles as AITrader["current_profile"][]).find(p => p?.version === t.current_version) ?? profiles[0];
      return { ...t, current_profile: profile ?? null };
    });

    return NextResponse.json({ traders });
  } catch (err) {
    console.error("[GET /api/traders]", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — 新規作成
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

    const body = await req.json();
    let input;
    try {
      input = normalizeAndValidateBuilderSave(body);
    } catch (error) {
      return NextResponse.json(
        { error: "入力が無効です", details: error instanceof Error ? error.message : "validation_failed" },
        { status: 422 }
      );
    }

    // V2: knowledge is deployed via admin HUMAN GATE operation (customer_knowledge table).
    // knowledge_ids are no longer accepted at trader creation time.
    const db = createAdminClient();

    // Public ID（衝突チェック付き）
    let publicId = generateTraderPublicId();
    for (let i = 0; i < 5; i++) {
      const { data: exists } = await db
        .from("ai_traders").select("id").eq("public_id", publicId).maybeSingle();
      if (!exists) break;
      publicId = generateTraderPublicId();
    }

    // 1. ai_traders 作成
    const { data: trader, error: traderErr } = await db
      .from("ai_traders")
      .insert({
        user_id:         user.id,
        public_id:       publicId,
        name:            input.name,
        description:     input.description ?? null,
        market:          input.market,
        status:          "DRAFT",
        current_version: 1,
        // A newly built trader is never autonomous.  The DB CHECK accepts
        // this canonical safe mode and later approval is a separate action.
        execution_mode:  "ANALYSIS_ONLY",
      })
      .select()
      .single();

    if (traderErr) throw traderErr;

    // Supabase REST does not expose a transaction for these two inserts.
    // Compensate before returning on any later failure so the API never
    // reports success with a partial Builder save.
    const rollbackTrader = async () => {
      const { error } = await db.from("ai_traders").delete().eq("id", trader.id).eq("user_id", user.id);
      if (error) console.error("[POST /api/traders] rollback failed", error);
    };

    // 2. ai_trader_versions v1 作成
    const { data: version, error: versionErr } = await db
      .from("ai_trader_versions")
      .insert({
        ai_trader_id:          trader.id,
        version:               1,
        personality:           input.profile.personality,
        trading_style:         input.profile.trading_style,
        risk_profile:          input.profile.risk_profile,
        entry_patience:        input.profile.entry_patience,
        news_sensitivity:      input.profile.news_sensitivity,
        volatility_preference: input.profile.volatility_preference,
        timeframes:            input.profile.timeframes,
        minimum_rr:            input.profile.minimum_rr,
        max_risk_per_trade:    input.profile.max_risk_per_trade,
        max_positions:         input.profile.max_positions,
        instructions:          input.profile.instructions ?? null,
        model_config:          { model: "gpt-5.6-terra", phase: "1" },
        raw_prompt:            input.raw_prompt ?? null,
        strategy_id:           null, // Phase 1: 未使用
      })
      .select()
      .single();

    if (versionErr) {
      await rollbackTrader();
      throw versionErr;
    }

    // 3. Timeframe Profile (V2 Stage 5)
    const tfProfile = input.timeframe_profile ?? DEFAULT_DAY_TRADING_TIMEFRAME_PROFILE;
    const { error: tfErr } = await db.from("ai_trader_timeframe_profiles").insert({
      ai_trader_version_id:     version.id,
      timeframe_style:          tfProfile.timeframe_style,
      macro_context_timeframes: tfProfile.macro_context_timeframes,
      trend_context_timeframes: tfProfile.trend_context_timeframes,
      setup_timeframes:         tfProfile.setup_timeframes,
      entry_timeframes:         tfProfile.entry_timeframes,
      management_timeframes:    tfProfile.management_timeframes,
      monitor_interval_minutes: tfProfile.monitor_interval_minutes,
    });
    if (tfErr) {
      await rollbackTrader();
      throw tfErr;
    }

    return NextResponse.json(
      { trader: { ...trader, current_profile: version } },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/traders]", err);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}

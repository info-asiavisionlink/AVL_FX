// =================================================================
// POST /api/traders/import-by-id
//
// public_id を入力して他ユーザーのAI Traderをコピーする。
// セキュリティ: コピー元の user_id は露出しない。
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { createClient }               from "@/infrastructure/supabase/server";
import { generateTraderPublicId, normalizeAndValidateTimeframeProfile } from "@/lib/aiTraderSchema";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const body = await req.json() as { public_id?: string };
  const pid  = (body.public_id ?? "").trim().toUpperCase();

  if (!pid || pid.length < 16) {
    return NextResponse.json({ error: "正しいTrader IDを入力してください（16文字）" }, { status: 400 });
  }

  const db = createAdminClient();

  // コピー元Traderを取得（他人のIDでも可能）
  const { data: source, error } = await db
    .from("ai_traders")
    .select("*, current_profile:ai_trader_versions(*)")
    .eq("public_id", pid)
    .neq("status", "ARCHIVED")
    .single();

  if (error || !source) {
    return NextResponse.json({ error: "該当するAIトレーダーが見つかりません" }, { status: 404 });
  }

  // 自分のものを再インポートしてもOK（コピーとして保存）
  const profiles = (source.current_profile as Record<string, unknown>[]) ?? [];
  const profile  = profiles.find((p: Record<string, unknown>) => p.version === source.current_version) ?? profiles[0];

  if (!profile) {
    return NextResponse.json({ error: "Traderのプロフィールが見つかりません" }, { status: 404 });
  }

  // 新しい public_id を発行（コピー元と同じIDは使わない）
  let newPublicId = generateTraderPublicId();
  for (let i = 0; i < 5; i++) {
    const { data: ex } = await db.from("ai_traders").select("id").eq("public_id", newPublicId).maybeSingle();
    if (!ex) break;
    newPublicId = generateTraderPublicId();
  }

  // 新しいTraderとして保存（コピー元 user_id は引き継がない）
  const { data: newTrader, error: tErr } = await db
    .from("ai_traders")
    .insert({
      user_id:         user.id,
      public_id:       newPublicId,
      name:            `${source.name as string}（コピー）`,
      description:     source.description as string | null,
      market:          source.market as string,
      status:          "DRAFT",
      current_version: 1,
    })
    .select()
    .single();

  if (tErr) return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });

  // Compensate on any later failure so no trader is left without a runnable
  // version + timeframe profile (versions/profiles cascade on trader delete).
  const rollbackTrader = async () => {
    const { error } = await db.from("ai_traders").delete().eq("id", newTrader.id).eq("user_id", user.id);
    if (error) console.error("[POST /api/traders/import-by-id] rollback failed", error);
  };

  // バージョンをコピー
  const { data: newVersion, error: vErr } = await db
    .from("ai_trader_versions")
    .insert({
      ai_trader_id:          newTrader.id,
      version:               1,
      personality:           profile.personality,
      trading_style:         profile.trading_style,
      risk_profile:          profile.risk_profile,
      entry_patience:        profile.entry_patience,
      news_sensitivity:      profile.news_sensitivity,
      volatility_preference: profile.volatility_preference,
      timeframes:            profile.timeframes,
      minimum_rr:            profile.minimum_rr,
      max_risk_per_trade:    profile.max_risk_per_trade,
      max_positions:         profile.max_positions,
      instructions:          profile.instructions,
      model_config:          { imported_from: pid, original_version: profile.version },
      raw_prompt:            null,
    })
    .select()
    .single();

  if (vErr) {
    await rollbackTrader();
    return NextResponse.json({ error: "バージョンのコピーに失敗しました" }, { status: 500 });
  }

  // V2 Stage 5: copy the source version's timeframe profile.  The runtime
  // config loader fails closed without one, so a copy without it is useless.
  const { data: sourceTf, error: sourceTfErr } = await db
    .from("ai_trader_timeframe_profiles")
    .select("timeframe_style, macro_context_timeframes, trend_context_timeframes, setup_timeframes, entry_timeframes, management_timeframes, monitor_interval_minutes")
    .eq("ai_trader_version_id", profile.id as string)
    .maybeSingle();
  let tfProfile;
  try {
    if (sourceTfErr || !sourceTf) throw new Error("source timeframe profile missing");
    tfProfile = normalizeAndValidateTimeframeProfile(sourceTf);
  } catch {
    await rollbackTrader();
    return NextResponse.json({ error: "時間足プロファイルのコピーに失敗しました" }, { status: 500 });
  }
  const { error: tfErr } = await db.from("ai_trader_timeframe_profiles").insert({
    ai_trader_version_id: newVersion.id,
    ...tfProfile,
  });
  if (tfErr) {
    await rollbackTrader();
    return NextResponse.json({ error: "時間足プロファイルのコピーに失敗しました" }, { status: 500 });
  }

  // Knowledge もコピー（元バージョンのものを引き継ぎ）
  const { data: sourceKnowledge } = await db
    .from("ai_trader_knowledge")
    .select("*")
    .eq("ai_trader_version_id", profile.id as string);

  if (sourceKnowledge && sourceKnowledge.length > 0) {
    await db.from("ai_trader_knowledge").insert(
      sourceKnowledge.map((k: Record<string, unknown>) => ({
        ai_trader_version_id: newVersion.id,
        knowledge_id:         k.knowledge_id,
        knowledge_version:    k.knowledge_version,
        knowledge_title:      k.knowledge_title,
        knowledge_category:   k.knowledge_category,
      }))
    );
  }

  return NextResponse.json(
    { trader: { ...newTrader, current_profile: newVersion }, imported_from: pid },
    { status: 201 }
  );
}

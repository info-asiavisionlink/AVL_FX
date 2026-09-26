import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { createClient } from "@/infrastructure/supabase/server";
import { handleManagePositions } from "@/lib/ai-trader/position-review-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const CRON_SECRET = process.env.CRON_SECRET ?? "";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await req.json().catch(() => ({})) as { bar_time?: number; trigger?: string };
  const barTime = Number.isFinite(body.bar_time) && (body.bar_time as number) > 0 ? body.bar_time as number : Math.floor(Date.now() / 300_000) * 300_000;
  const cron = req.headers.get("x-cron-secret") === CRON_SECRET; let userId = cron ? (req.headers.get("x-user-id") ?? "") : "";
  if (!userId) { const c = await createClient(); const { data: { user } } = await c.auth.getUser(); if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 }); userId = user.id; }
  const result = await handleManagePositions({ db: createAdminClient(), traderId: id, userId, barTime, trigger: body.trigger ?? "POSITION_REVIEW" });
  return NextResponse.json(result.body, { status: result.status });
}

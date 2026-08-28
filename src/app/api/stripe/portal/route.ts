// POST /api/stripe/portal — カスタマーポータル（プラン管理・解約）
import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/infrastructure/supabase/server";
import { createAdminClient }         from "@/infrastructure/supabase/admin";
import { getStripe }                 from "@/lib/stripe/client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const sb   = await createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

    const db   = createAdminClient();
    const { data: sub } = await db
      .from("user_subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .single();

    if (!sub?.stripe_customer_id) {
      return NextResponse.json({ error: "Stripe顧客情報がありません" }, { status: 404 });
    }

    const origin  = req.headers.get("origin") ?? "https://avl-fx.vercel.app";
    const session = await getStripe().billingPortal.sessions.create({
      customer:   sub.stripe_customer_id,
      return_url: `${origin}/pricing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe/portal]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/stripe/checkout — Stripe Checkout セッション作成
import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/infrastructure/supabase/server";
import { getStripe }                 from "@/lib/stripe/client";
import { PLANS, type PlanId }        from "@/lib/plans";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { planId } = await req.json() as { planId?: PlanId };
    if (!planId || !PLANS[planId]) {
      return NextResponse.json({ error: "無効なプランです" }, { status: 400 });
    }

    const plan = PLANS[planId];
    if (!plan.stripePriceId) {
      return NextResponse.json({ error: "このプランは決済不要です" }, { status: 400 });
    }

    // ユーザー認証確認
    const sb   = await createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

    const stripe = getStripe();
    const origin = req.headers.get("origin") ?? "https://avl-fx.vercel.app";

    // 既存の Stripe Customer を取得 or 作成
    const { data: sub } = await sb
      .from("user_subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .single();

    let customerId = sub?.stripe_customer_id as string | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
    }

    // Checkout セッション作成
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 "subscription",
      payment_method_types: ["card"],
      line_items: [{
        price:    plan.stripePriceId,
        quantity: 1,
      }],
      success_url: `${origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/pricing`,
      metadata:    { user_id: user.id, plan_id: planId },
      subscription_data: {
        metadata: { user_id: user.id, plan_id: planId },
      },
      locale: "ja",
    });

    return NextResponse.json({ url: session.url });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe/checkout]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

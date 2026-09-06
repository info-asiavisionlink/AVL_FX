// POST /api/stripe/webhook — Stripe Webhook ハンドラー
// Stripe Dashboard で設定: https://dashboard.stripe.com/webhooks
// イベント: checkout.session.completed, customer.subscription.updated,
//           customer.subscription.deleted
import { NextRequest, NextResponse } from "next/server";
import { getStripe }                 from "@/lib/stripe/client";
import { createAdminClient }         from "@/infrastructure/supabase/admin";
import { PLANS, type PlanId }        from "@/lib/plans";
import Stripe from "stripe";

export const runtime = "nodejs";

// プランIDから最大EA数を取得
function getMaxEAs(planId: string): number {
  return (PLANS[planId as PlanId]?.maxConcurrentEAs) ?? 0;
}

// DB に サブスクリプション情報を upsert
async function upsertSubscription(params: {
  userId:               string;
  stripeCustomerId:     string;
  stripeSubscriptionId: string;
  planId:               string;
  status:               string;
  currentPeriodEnd:     number;
}) {
  const db = createAdminClient();
  const maxEAs = getMaxEAs(params.planId);
  await db.from("user_subscriptions").upsert({
    user_id:                params.userId,
    stripe_customer_id:     params.stripeCustomerId,
    stripe_subscription_id: params.stripeSubscriptionId,
    plan:                   params.planId,
    max_concurrent_eas:     maxEAs,
    status:                 params.status,
    current_period_end:     new Date(params.currentPeriodEnd * 1000).toISOString(),
    updated_at:             new Date().toISOString(),
  }, { onConflict: "user_id" });
}

export async function POST(req: NextRequest) {
  const body      = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";
  const secret    = process.env.STRIPE_WEBHOOK_SECRET ?? "";

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    console.error("[webhook] signature check failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const db = createAdminClient();

  try {
    switch (event.type) {
      // 決済完了
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription") break;
        const userId = session.metadata?.user_id;
        const planId = session.metadata?.plan_id;
        if (!userId || !planId) break;

        const sub = await getStripe().subscriptions.retrieve(session.subscription as string);
        await upsertSubscription({
          userId,
          stripeCustomerId:     session.customer as string,
          stripeSubscriptionId: sub.id,
          planId,
          status:               sub.status,
          currentPeriodEnd:     sub.items.data[0]?.current_period_end ?? 0,
        });
        break;
      }

      // サブスクリプション更新（プラン変更など）
      case "customer.subscription.updated": {
        const sub    = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        const planId = sub.metadata?.plan_id;
        if (!userId || !planId) {
          // metadata がなければ customer から user_id を検索
          const { data } = await db
            .from("user_subscriptions")
            .select("user_id, plan")
            .eq("stripe_subscription_id", sub.id)
            .single();
          if (!data) break;
          await upsertSubscription({
            userId:               data.user_id,
            stripeCustomerId:     sub.customer as string,
            stripeSubscriptionId: sub.id,
            planId:               data.plan,
            status:               sub.status,
            currentPeriodEnd:     sub.items.data[0]?.current_period_end ?? 0,
          });
        } else {
          await upsertSubscription({
            userId, stripeCustomerId: sub.customer as string,
            stripeSubscriptionId: sub.id, planId,
            status: sub.status, currentPeriodEnd: sub.items.data[0]?.current_period_end ?? 0,
          });
        }
        break;
      }

      // 解約
      case "customer.subscription.deleted": {
        const sub    = event.data.object as Stripe.Subscription;
        await db.from("user_subscriptions")
          .update({ plan: "free", max_concurrent_eas: 0, status: "canceled", updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", sub.id);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[webhook] handler error:", err);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

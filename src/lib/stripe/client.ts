import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY が設定されていません");
    _stripe = new Stripe(key, { apiVersion: "2026-08-26.dahlia" });
  }
  return _stripe;
}

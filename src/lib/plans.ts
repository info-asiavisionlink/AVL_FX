// =================================================================
// プラン定義 — AVL FX SaaS
// =================================================================

export const PLANS = {
  free: {
    id:               "free",
    name:             "フリー",
    priceJPY:         0,
    stripePriceId:    null,
    maxConcurrentEAs: 0,
    features: [
      "AIマーケット分析",
      "EA作成・バックテスト",
      "チャート・ニュース",
      "ポジション確認",
      "自動売買: 不可",
    ],
    color: "#475569",
    badge: null,
  },
  starter: {
    id:               "starter",
    name:             "スターター",
    priceJPY:         5_000,
    stripePriceId:    process.env.STRIPE_PRICE_STARTER ?? "",
    maxConcurrentEAs: 0,
    features: [
      "フリーの全機能",
      "高度なAI分析",
      "EA作成・バックテスト (無制限)",
      "月次レポート",
      "自動売買: 不可",
    ],
    color: "#00e5ff",
    badge: "人気",
  },
  pro: {
    id:               "pro",
    name:             "プロ",
    priceJPY:         50_000,
    stripePriceId:    process.env.STRIPE_PRICE_PRO ?? "",
    maxConcurrentEAs: 2,
    features: [
      "スターターの全機能",
      "同時EA起動: 2本",
      "リアルタイムアラート",
      "優先サポート",
      "自動売買: ◎",
    ],
    color: "#00ff88",
    badge: "おすすめ",
  },
  business: {
    id:               "business",
    name:             "ビジネス",
    priceJPY:         200_000,
    stripePriceId:    process.env.STRIPE_PRICE_BUSINESS ?? "",
    maxConcurrentEAs: 10,
    features: [
      "プロの全機能",
      "同時EA起動: 10本",
      "専任サポート",
      "カスタムインジケーター",
      "自動売買: ◎◎◎",
    ],
    color: "#a78bfa",
    badge: null,
  },
} as const;

export type PlanId = keyof typeof PLANS;

export function getPlanByMaxEAs(max: number): PlanId {
  if (max >= 10) return "business";
  if (max >= 2)  return "pro";
  if (max === 0) return "starter";
  return "free";
}

export function canActivateEA(planId: PlanId, currentActive: number): boolean {
  const plan = PLANS[planId];
  return currentActive < plan.maxConcurrentEAs;
}

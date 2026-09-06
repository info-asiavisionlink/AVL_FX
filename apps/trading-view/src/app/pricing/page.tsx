"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/infrastructure/supabase/client";
import { PLANS, type PlanId } from "@/lib/plans";
import Link from "next/link";

const NG    = "#00ff88";
const CYAN  = "#00e5ff";
const AMBER = "#fbbf24";
const RED   = "#ff4466";
const PURPLE= "#a78bfa";

function planColor(id: string): string {
  if (id === "pro")      return NG;
  if (id === "starter")  return CYAN;
  if (id === "business") return PURPLE;
  return "#475569";
}

export default function PricingPage() {
  const [currentPlan, setCurrentPlan] = useState<PlanId>("free");
  const [loading,     setLoading]     = useState<string | null>(null);
  const [userId,      setUserId]      = useState<string | null>(null);

  useEffect(() => {
    const sb = createClient();
    sb.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      // 現在のプランを取得
      sb.from("user_subscriptions").select("plan").eq("user_id", user.id).single()
        .then(({ data }) => { if (data?.plan) setCurrentPlan(data.plan as PlanId); });
    });
  }, []);

  async function handleCheckout(planId: PlanId) {
    if (!userId) { window.location.href = "/login"; return; }
    setLoading(planId);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const { url, error } = await res.json() as { url?: string; error?: string };
      if (error) { alert(error); return; }
      if (url) window.location.href = url;
    } finally {
      setLoading(null);
    }
  }

  async function handleManage() {
    setLoading("manage");
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const { url } = await res.json() as { url?: string };
      if (url) window.location.href = url;
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen py-16 px-4"
      style={{ background: "radial-gradient(ellipse at 20% 50%, rgba(0,15,35,1) 0%, #020408 100%)" }}>

      {/* ヘッダー */}
      <div className="text-center mb-12">
        <Link href="/" className="inline-block mb-6 text-[10px] font-mono tracking-widest" style={{ color: "#475569" }}>
          ← ダッシュボードに戻る
        </Link>
        <h1 className="text-3xl font-black tracking-[0.15em] mb-3" style={{ color: "#e2e8f0" }}>
          プランを選択
        </h1>
        <p className="text-[11px] font-mono" style={{ color: "#475569" }}>
          EAを作成・検証は全プラン無料 · 自動売買はPro以上
        </p>
      </div>

      {/* プランカード */}
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
        {(Object.values(PLANS) as typeof PLANS[PlanId][]).map(plan => {
          const col     = planColor(plan.id);
          const isCur   = currentPlan === plan.id;
          const isLoad  = loading === plan.id;

          return (
            <div key={plan.id} className="relative rounded-xl p-5 flex flex-col"
              style={{
                background: isCur ? `${col}08` : "rgba(255,255,255,0.02)",
                border: `1px solid ${isCur ? `${col}40` : "rgba(255,255,255,0.08)"}`,
                boxShadow: isCur ? `0 0 20px ${col}10` : "none",
              }}>

              {/* バッジ */}
              {plan.badge && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-[7px] font-black tracking-widest"
                  style={{ background: col, color: "#020408" }}>
                  {plan.badge}
                </div>
              )}

              {/* 現在のプランバッジ */}
              {isCur && (
                <div className="absolute top-3 right-3 px-2 py-0.5 rounded text-[7px] font-black"
                  style={{ background: `${col}20`, border: `1px solid ${col}40`, color: col }}>
                  現在のプラン
                </div>
              )}

              {/* プラン名・価格 */}
              <div className="mb-4">
                <p className="text-[9px] font-mono tracking-widest mb-1" style={{ color: col }}>{plan.name}</p>
                <div className="flex items-baseline gap-1">
                  {plan.priceJPY === 0 ? (
                    <span className="text-2xl font-black" style={{ color: "#e2e8f0" }}>無料</span>
                  ) : (
                    <>
                      <span className="text-2xl font-black" style={{ color: "#e2e8f0" }}>
                        ¥{plan.priceJPY.toLocaleString()}
                      </span>
                      <span className="text-[9px] font-mono" style={{ color: "#475569" }}>/月</span>
                    </>
                  )}
                </div>
                <p className="text-[9px] font-mono mt-1" style={{ color: "#334155" }}>
                  同時EA起動: {plan.maxConcurrentEAs === 0 ? "なし" : `${plan.maxConcurrentEAs}本`}
                </p>
              </div>

              {/* 機能一覧 */}
              <ul className="space-y-1.5 mb-6 flex-1">
                {plan.features.map((f, i) => {
                  const isLast = i === plan.features.length - 1;
                  const isPositive = !f.includes("不可");
                  return (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="text-[9px] mt-0.5 shrink-0"
                        style={{ color: isLast ? (isPositive ? NG : RED) : "#334155" }}>
                        {isPositive ? "✓" : "✗"}
                      </span>
                      <span className="text-[9px] font-mono leading-relaxed"
                        style={{ color: isLast ? (isPositive ? NG : "#64748b") : "#64748b" }}>
                        {f}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {/* ボタン */}
              {plan.id === "free" ? (
                <div className="h-9 flex items-center justify-center rounded text-[9px] font-mono"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", color: "#334155" }}>
                  {isCur ? "利用中" : "無料"}
                </div>
              ) : isCur ? (
                <button onClick={handleManage} disabled={!!loading}
                  className="h-9 w-full rounded text-[9px] font-mono font-bold tracking-widest transition-all"
                  style={{ background: `${col}10`, border: `1px solid ${col}30`, color: col }}>
                  プランを管理
                </button>
              ) : (
                <button onClick={() => handleCheckout(plan.id as PlanId)} disabled={!!loading}
                  className="h-9 w-full rounded text-[9px] font-mono font-bold tracking-widest transition-all"
                  style={{
                    background: isLoad ? "rgba(255,255,255,0.04)" : `${col}12`,
                    border: `1px solid ${isLoad ? "rgba(255,255,255,0.08)" : `${col}35`}`,
                    color: isLoad ? "#334155" : col,
                    opacity: !!loading && !isLoad ? 0.5 : 1,
                  }}>
                  {isLoad ? "◌ 処理中..." : "このプランにする"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* エンタープライズ */}
      <div className="max-w-5xl mx-auto">
        <div className="rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-4"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <div>
            <p className="text-[11px] font-black tracking-widest mb-1" style={{ color: "#94a3b8" }}>
              10本以上のEAを同時起動
            </p>
            <p className="text-[9px] font-mono" style={{ color: "#475569" }}>
              大規模運用・機関投資家向けのカスタムプランです。専任サポート付き。
            </p>
          </div>
          <a href="mailto:info@asiavision.link?subject=AVL FX エンタープライズ問い合わせ"
            className="shrink-0 px-6 py-2.5 rounded text-[9px] font-mono font-bold tracking-widest transition-all"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8" }}>
            お問い合わせ
          </a>
        </div>
      </div>

      {/* FAQ */}
      <div className="max-w-2xl mx-auto mt-12 space-y-3">
        <p className="text-[9px] font-black tracking-[0.25em] text-center mb-4" style={{ color: "#334155" }}>よくある質問</p>
        {[
          ["EA起動とは何ですか？", "MT5で実際に自動売買が動く状態にすることです。「起動」状態のEAが同時に動ける本数がプランによって異なります。EAの作成・追加・バックテストはどのプランでも自由に行えます。"],
          ["プランはいつでも変更できますか？", "はい。いつでもアップグレード・ダウングレードが可能です。変更は即時反映されます。"],
          ["支払い方法は？", "クレジットカード（VISA/Mastercard/AMEX）に対応しています。Stripeで安全に処理されます。"],
          ["解約はどうすればいいですか？", "マイページの「プランを管理」からいつでも解約できます。解約後も期間終了まで利用可能です。"],
        ].map(([q, a]) => (
          <div key={q} className="rounded-lg p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p className="text-[9px] font-black mb-1.5" style={{ color: "#94a3b8" }}>{q}</p>
            <p className="text-[8px] font-mono leading-relaxed" style={{ color: "#475569" }}>{a}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

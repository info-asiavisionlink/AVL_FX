"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const NG = "#00ff88";

export default function PricingSuccessPage() {
  const params  = useSearchParams();
  const session = params.get("session_id");
  const [done,  setDone]  = useState(false);

  useEffect(() => {
    // Webhookが処理されるまで少し待つ
    const t = setTimeout(() => setDone(true), 2000);
    return () => clearTimeout(t);
  }, [session]);

  return (
    <div className="min-h-screen flex items-center justify-center"
      style={{ background: "radial-gradient(ellipse at 20% 50%, rgba(0,15,35,1) 0%, #020408 100%)" }}>
      <div className="text-center space-y-6">
        <div className="text-6xl">🎉</div>
        <h1 className="text-2xl font-black tracking-[0.15em]" style={{ color: NG }}>
          お支払い完了
        </h1>
        <p className="text-[11px] font-mono" style={{ color: "#64748b" }}>
          プランが有効になりました。<br />
          ダッシュボードからEAの起動が可能です。
        </p>
        {done ? (
          <Link href="/ea"
            className="inline-block px-8 py-3 rounded-lg text-[10px] font-mono font-black tracking-widest"
            style={{ background: `${NG}12`, border: `1px solid ${NG}35`, color: NG }}>
            EAコマンドセンターへ →
          </Link>
        ) : (
          <p className="text-[9px] font-mono" style={{ color: "#334155" }}>◌ 処理中...</p>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/infrastructure/supabase/client";

const NG   = "#00ff88";
const CYAN = "#00e5ff";

function VerifyEmailContent() {
  const params = useSearchParams();
  const email  = params.get("email") ?? "";
  const [resent,   setResent]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  async function handleResend() {
    if (!email) return;
    setLoading(true); setError(""); setResent(false);
    const sb = createClient();
    const { error: err } = await sb.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${location.origin}/callback` },
    });
    if (err) { setError(err.message); } else { setResent(true); }
    setLoading(false);
  }

  return (
    <div className="w-full max-w-sm mx-auto p-4">
      {/* ロゴ */}
      <div className="text-center mb-8">
        <h1 className="text-2xl font-black tracking-[0.2em]" style={{ color: NG, textShadow: `0 0 20px ${NG}60` }}>
          AVL FX
        </h1>
        <p className="text-[10px] font-mono tracking-[0.3em] mt-1" style={{ color: "#334155" }}>
          AI TRADING OS
        </p>
      </div>

      <div className="rounded-xl p-8 text-center space-y-5"
        style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${NG}25` }}>

        {/* アイコン */}
        <div className="w-16 h-16 mx-auto rounded-full flex items-center justify-center"
          style={{ background: `${NG}10`, border: `1px solid ${NG}30` }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={NG} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
          </svg>
        </div>

        <div>
          <p className="text-[13px] font-black tracking-widest mb-2" style={{ color: NG }}>
            メールを確認してください
          </p>
          <p className="text-[9px] font-mono leading-relaxed" style={{ color: "#64748b" }}>
            {email ? (
              <><span style={{ color: "#94a3b8" }}>{email}</span> に確認メールを送りました。</>
            ) : (
              "ご登録のメールアドレスに確認メールを送りました。"
            )}
          </p>
        </div>

        {/* 手順 */}
        <div className="rounded-lg p-4 text-left space-y-3"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          {[
            ["1", "メールを開く", "受信トレイまたは迷惑メールフォルダをご確認ください"],
            ["2", "リンクをクリック", "「メールアドレスを確認する」ボタンをクリック"],
            ["3", "ログイン", "認証完了後、自動的にログインされます"],
          ].map(([num, title, desc]) => (
            <div key={num} className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ background: `${NG}15`, border: `1px solid ${NG}30` }}>
                <span className="text-[8px] font-black" style={{ color: NG }}>{num}</span>
              </div>
              <div>
                <p className="text-[9px] font-black" style={{ color: "#94a3b8" }}>{title}</p>
                <p className="text-[8px] font-mono mt-0.5" style={{ color: "#475569" }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* 再送信 */}
        <div className="space-y-2">
          {resent && (
            <p className="text-[8px] font-mono" style={{ color: NG }}>確認メールを再送しました ✓</p>
          )}
          {error && (
            <p className="text-[8px] font-mono" style={{ color: "#f87171" }}>{error}</p>
          )}
          {email && (
            <button onClick={handleResend} disabled={loading || resent}
              className="text-[8px] font-mono transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ color: CYAN }}>
              {loading ? "送信中..." : "メールが届かない場合は再送信"}
            </button>
          )}
        </div>

        <div className="pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          <Link href="/login" className="text-[9px] font-mono transition-opacity hover:opacity-80" style={{ color: "#475569" }}>
            ← ログインページへ戻る
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailContent />
    </Suspense>
  );
}

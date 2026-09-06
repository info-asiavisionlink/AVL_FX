"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/infrastructure/supabase/client";

const NG   = "#00ff88";
const CYAN = "#00e5ff";
const RED  = "#ff4466";

export default function ForgotPasswordPage() {
  const [email,   setEmail]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [done,    setDone]    = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    const sb = createClient();
    const { error: err } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth/callback?type=recovery`,
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setDone(true); setLoading(false);
  }

  if (done) {
    return (
      <div className="w-full max-w-sm mx-auto p-4">
        <div className="rounded-xl p-8 text-center space-y-4"
          style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${NG}30` }}>
          <p className="text-3xl">📧</p>
          <p className="text-[12px] font-black tracking-widest" style={{ color: NG }}>
            リセットリンクを送信しました
          </p>
          <p className="text-[9px] font-mono leading-relaxed" style={{ color: "#64748b" }}>
            {email} にパスワードリセット用のメールを送りました。
          </p>
          <Link href="/login" className="inline-block text-[9px] font-mono" style={{ color: CYAN }}>
            ログインページへ →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm mx-auto p-4">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-black tracking-[0.2em]" style={{ color: NG, textShadow: `0 0 20px ${NG}60` }}>AVL FX</h1>
      </div>
      <div className="rounded-xl p-6 space-y-5"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
        <p className="text-[11px] font-black tracking-[0.2em] text-center" style={{ color: "#94a3b8" }}>パスワードリセット</p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[8px] font-mono tracking-widest" style={{ color: "#475569" }}>登録済みメールアドレス</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" required
              className="w-full px-3 py-2 rounded-lg text-[10px] font-mono outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.10)", color: "#e2e8f0" }} />
          </div>
          {error && <p className="text-[9px] font-mono" style={{ color: RED }}>{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full py-2.5 rounded-lg text-[10px] font-mono font-black tracking-widest transition-all"
            style={{
              background: loading ? "rgba(255,255,255,0.04)" : "rgba(0,255,136,0.12)",
              border: `1px solid ${loading ? "rgba(255,255,255,0.08)" : "rgba(0,255,136,0.35)"}`,
              color: loading ? "#334155" : NG,
            }}>
            {loading ? "◌ 送信中..." : "リセットメールを送る"}
          </button>
        </form>
        <p className="text-center text-[9px] font-mono" style={{ color: "#475569" }}>
          <Link href="/login" className="transition-opacity hover:opacity-80" style={{ color: CYAN }}>← ログインに戻る</Link>
        </p>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/infrastructure/supabase/client";
import { useRouter } from "next/navigation";

const NG   = "#00ff88";
const CYAN = "#00e5ff";
const RED  = "#ff4466";

export default function LoginPage() {
  const router = useRouter();
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) { setError("メールアドレスとパスワードを入力してください"); return; }
    setLoading(true); setError("");
    const sb = createClient();
    const { error: err } = await sb.auth.signInWithPassword({ email, password });
    if (err) { setError(err.message === "Invalid login credentials" ? "メールアドレスまたはパスワードが間違っています" : err.message); setLoading(false); return; }
    router.push("/");
    router.refresh();
  }

  async function handleGoogleLogin() {
    setLoading(true); setError("");
    const sb = createClient();
    const { error: err } = await sb.auth.signInWithOAuth({
      provider: "google",
      options:  { redirectTo: `${location.origin}/callback?from=login` },
    });
    if (err) { setError(err.message); setLoading(false); }
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

      {/* カード */}
      <div className="rounded-xl p-6 space-y-5"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
        <p className="text-[11px] font-black tracking-[0.2em] text-center" style={{ color: "#94a3b8" }}>
          ログイン
        </p>

        {/* Googleログイン */}
        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 py-2.5 rounded-lg text-[10px] font-mono font-bold tracking-widest transition-all"
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#e2e8f0",
            opacity: loading ? 0.5 : 1,
          }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Google でログイン
        </button>

        {/* 区切り */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
          <span className="text-[8px] font-mono" style={{ color: "#334155" }}>または</span>
          <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
        </div>

        {/* メール/パスワード */}
        <form onSubmit={handleEmailLogin} className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[8px] font-mono tracking-widest" style={{ color: "#475569" }}>
              メールアドレス
            </label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" required autoComplete="email"
              className="w-full px-3 py-2 rounded-lg text-[10px] font-mono outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.10)", color: "#e2e8f0" }}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[8px] font-mono tracking-widest" style={{ color: "#475569" }}>
                パスワード
              </label>
              <Link href="/forgot-password" className="text-[8px] font-mono transition-opacity hover:opacity-80"
                style={{ color: CYAN }}>
                忘れた場合
              </Link>
            </div>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" required autoComplete="current-password"
              className="w-full px-3 py-2 rounded-lg text-[10px] font-mono outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.10)", color: "#e2e8f0" }}
            />
          </div>

          {error && (
            <p className="text-[9px] font-mono" style={{ color: RED }}>{error}</p>
          )}

          <button
            type="submit" disabled={loading}
            className="w-full py-2.5 rounded-lg text-[10px] font-mono font-black tracking-widest transition-all"
            style={{
              background: loading ? "rgba(255,255,255,0.04)" : `rgba(0,255,136,0.12)`,
              border: `1px solid ${loading ? "rgba(255,255,255,0.08)" : "rgba(0,255,136,0.35)"}`,
              color: loading ? "#334155" : NG,
              opacity: loading ? 0.6 : 1,
            }}>
            {loading ? "◌ ログイン中..." : "ログイン →"}
          </button>
        </form>

        {/* 新規登録リンク */}
        <p className="text-center text-[9px] font-mono" style={{ color: "#475569" }}>
          アカウントをお持ちでない方{" "}
          <Link href="/signup" className="transition-opacity hover:opacity-80" style={{ color: CYAN }}>
            新規登録
          </Link>
        </p>
      </div>
    </div>
  );
}

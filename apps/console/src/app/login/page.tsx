"use client";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail]   = useState("");
  const [pass,  setPass]    = useState("");
  const [error, setError]   = useState(params.get("error") === "unauthorized" ? "このアカウントはConsoleへのアクセス権がありません" : "");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    );
    const { error: err } = await sb.auth.signInWithPassword({ email, password: pass });
    if (err) { setError(err.message); setLoading(false); return; }
    window.location.href = "/dashboard";
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-primary)" }}>
      <div className="w-full max-w-sm p-8 rounded-xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}>
        <div className="text-center mb-8">
          <p className="text-xs tracking-[0.3em] mb-1" style={{ color: "var(--text-muted)" }}>AVLFX</p>
          <h1 className="text-xl font-black tracking-widest" style={{ color: "var(--accent-cyan)" }}>CONSOLE</h1>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>管理者専用システム</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs mb-1.5 tracking-widest" style={{ color: "var(--text-muted)" }}>メールアドレス</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }} />
          </div>
          <div>
            <label className="block text-xs mb-1.5 tracking-widest" style={{ color: "var(--text-muted)" }}>パスワード</label>
            <input type="password" value={pass} onChange={e => setPass(e.target.value)} required
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }} />
          </div>
          {error && <p className="text-xs" style={{ color: "var(--accent-red)" }}>{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full py-2.5 rounded-lg text-xs font-black tracking-widest"
            style={{ background: "rgba(0,229,255,0.12)", color: "var(--accent-cyan)", border: "1px solid rgba(0,229,255,0.3)", opacity: loading ? 0.6 : 1 }}>
            {loading ? "ログイン中..." : "ログイン →"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}

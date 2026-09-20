"use client";
export const dynamic = "force-dynamic";

import { useState } from "react";

const NG   = "#00ff88";
const CYAN = "#00e5ff";

type Status = "idle" | "sending" | "ok" | "error";

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [status, setStatus] = useState<Status>("idle");

  function set(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm(prev => ({ ...prev, [k]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setStatus(res.ok ? "ok" : "error");
    } catch {
      setStatus("error");
    }
  }

  const inputClass = "w-full px-4 py-3 rounded-lg text-[11px] font-mono outline-none transition-all";
  const inputStyle = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#e2e8f0",
  };

  return (
    <article>
      <div className="mb-8">
        <p className="text-[10px] font-mono mb-2" style={{ color: "#475569" }}>サポート</p>
        <h1 className="text-2xl font-black tracking-[0.15em]" style={{ color: "#e2e8f0" }}>お問い合わせ</h1>
      </div>

      <div className="grid md:grid-cols-3 gap-8">
        {/* フォーム */}
        <div className="md:col-span-2">
          {status === "ok" ? (
            <div className="p-8 rounded-xl text-center" style={{ background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.2)" }}>
              <p className="text-2xl mb-3">✓</p>
              <p className="text-[13px] font-black tracking-widest mb-2" style={{ color: NG }}>送信完了</p>
              <p className="text-[11px] font-mono" style={{ color: "#94a3b8" }}>
                お問い合わせありがとうございます。<br />
                通常1〜3営業日以内にご返信いたします。
              </p>
              <button className="mt-6 px-6 py-2 rounded-lg text-[10px] font-mono"
                style={{ background: "rgba(0,255,136,0.1)", color: NG, border: "1px solid rgba(0,255,136,0.3)" }}
                onClick={() => { setForm({ name: "", email: "", subject: "", message: "" }); setStatus("idle"); }}>
                別のお問い合わせをする
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[9px] font-mono font-bold mb-1.5 tracking-widest" style={{ color: "#64748b" }}>お名前 *</label>
                  <input required value={form.name} onChange={set("name")} placeholder="田中 太郎"
                    className={inputClass} style={inputStyle} />
                </div>
                <div>
                  <label className="block text-[9px] font-mono font-bold mb-1.5 tracking-widest" style={{ color: "#64748b" }}>メールアドレス *</label>
                  <input required type="email" value={form.email} onChange={set("email")} placeholder="you@example.com"
                    className={inputClass} style={inputStyle} />
                </div>
              </div>

              <div>
                <label className="block text-[9px] font-mono font-bold mb-1.5 tracking-widest" style={{ color: "#64748b" }}>お問い合わせ種別 *</label>
                <select required value={form.subject} onChange={set("subject")}
                  className={inputClass} style={inputStyle}>
                  <option value="">選択してください</option>
                  <option value="プラン・料金について">プラン・料金について</option>
                  <option value="決済・請求について">決済・請求について</option>
                  <option value="MT5連携について">MT5連携について</option>
                  <option value="バックテスト機能について">バックテスト機能について</option>
                  <option value="アカウントについて">アカウントについて</option>
                  <option value="技術的な問題">技術的な問題</option>
                  <option value="退会について">退会について</option>
                  <option value="その他">その他</option>
                </select>
              </div>

              <div>
                <label className="block text-[9px] font-mono font-bold mb-1.5 tracking-widest" style={{ color: "#64748b" }}>お問い合わせ内容 *</label>
                <textarea required value={form.message} onChange={set("message")}
                  rows={7} placeholder="詳しい内容をお書きください..."
                  className={`${inputClass} resize-none`} style={inputStyle} />
              </div>

              {status === "error" && (
                <p className="text-[10px] font-mono px-4 py-3 rounded-lg" style={{ color: "#f87171", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}>
                  送信に失敗しました。しばらく待ってから再度お試しいただくか、<a href="mailto:info@asiavision.link" style={{ color: CYAN }}>info@asiavision.link</a> へ直接メールをお送りください。
                </p>
              )}

              <button type="submit" disabled={status === "sending"}
                className="w-full py-3 rounded-lg text-[11px] font-black tracking-widest transition-all disabled:opacity-50"
                style={{ background: `rgba(0,255,136,0.12)`, color: NG, border: `1px solid rgba(0,255,136,0.3)` }}>
                {status === "sending" ? "送信中..." : "送信する"}
              </button>
            </form>
          )}
        </div>

        {/* サイドバー */}
        <div className="space-y-4">
          <div className="p-5 rounded-xl" style={{ background: "rgba(0,229,255,0.04)", border: "1px solid rgba(0,229,255,0.12)" }}>
            <p className="text-[9px] font-black tracking-widest mb-3" style={{ color: CYAN }}>メールでのお問い合わせ</p>
            <a href="mailto:info@asiavision.link" className="text-[10px] font-mono break-all" style={{ color: "#94a3b8" }}>
              info@asiavision.link
            </a>
          </div>

          <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p className="text-[9px] font-black tracking-widest mb-3" style={{ color: "#64748b" }}>対応時間</p>
            <p className="text-[10px] font-mono" style={{ color: "#94a3b8" }}>平日 10:00 〜 18:00</p>
            <p className="text-[9px] font-mono mt-1" style={{ color: "#475569" }}>土日祝は翌営業日対応</p>
          </div>

          <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p className="text-[9px] font-black tracking-widest mb-3" style={{ color: "#64748b" }}>よくある質問</p>
            <ul className="space-y-2">
              {[
                ["解約方法", "/dashboard"],
                ["プラン変更", "/dashboard"],
                ["MT5連携設定", "/dashboard"],
              ].map(([label, href]) => (
                <li key={label}>
                  <a href={href} className="text-[10px] font-mono flex items-center gap-1.5 hover:opacity-80 transition-opacity" style={{ color: CYAN }}>
                    <span>→</span>{label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="mt-12 pt-6 text-right" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-[9px] font-mono" style={{ color: "#334155" }}>制定日: 2026年9月1日</p>
      </div>
    </article>
  );
}

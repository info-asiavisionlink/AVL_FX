"use client";

import { useState, useCallback } from "react";
import { toast }                  from "sonner";
import {
  PERSONALITY_LABELS, TRADING_STYLE_LABELS, RISK_PROFILE_LABELS,
  ENTRY_PATIENCE_LABELS, NEWS_SENSITIVITY_LABELS, VOLATILITY_PREF_LABELS,
  type AITraderProfile, type AITrader,
} from "@/lib/aiTraderSchema";

const NG = "#f97316";

const TIMEFRAME_OPTIONS = ["M1","M5","M15","M30","H1","H4","D1","W1"];

// ── プロフィール項目の行表示 ──────────────────────────────────────
function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2"
      style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
      <span className="text-xs" style={{ color: "#64748b" }}>{label}</span>
      <span className="text-xs font-semibold" style={{ color: "#1a1a1a" }}>{value}</span>
    </div>
  );
}

// ── 入力共通スタイル ──────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "10px 14px", borderRadius: 10, fontSize: 13,
  border: "1px solid #e2e8f0", background: "#fff", color: "#1a1a1a",
  outline: "none", lineHeight: 1.6,
};

type Step = "input" | "generating" | "confirm" | "saving" | "saved";

interface Props {
  open: boolean; onClose: () => void; onSaved: (t: AITrader) => void;
}

export function AITraderBuilder({ open, onClose, onSaved }: Props) {
  const [step,         setStep]         = useState<Step>("input");
  const [description,  setDescription]  = useState("");
  const [name,         setName]         = useState("");
  const [traderDesc,   setTraderDesc]   = useState("");
  const [profile,      setProfile]      = useState<AITraderProfile | null>(null);
  const [reasoning,    setReasoning]    = useState("");
  const [error,        setError]        = useState("");

  const handleGenerate = useCallback(async () => {
    setError("");
    setStep("generating");

    // V2 Stage 5: the Builder does not read Console Knowledge.  Knowledge is
    // delivered to Customer Supabase as a package (Stage 4) and bound at runtime.
    try {
      const res = await fetch("/api/ai/trader/build", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, knowledge_list: [] }),
      });
      const data = await res.json() as {
        success: boolean; error?: string;
        name?: string; description?: string; reasoning?: string;
        profile?: AITraderProfile;
      };

      if (!data.success || !data.profile) {
        setError(data.error ?? "生成に失敗しました。再試行してください。");
        setStep("input");
        return;
      }

      setProfile(data.profile);
      setName(data.name ?? "AI Trader");
      setTraderDesc(data.description ?? "");
      setReasoning(data.reasoning ?? "");
      setStep("confirm");
    } catch {
      setError("通信エラーが発生しました。再試行してください。");
      setStep("input");
    }
  }, [description]);

  const handleSave = useCallback(async () => {
    if (!profile) return;
    setStep("saving");
    setError("");
    try {
      const res = await fetch("/api/traders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, description: traderDesc || undefined, market: "GOLD",
          profile, raw_prompt: description,
        }),
      });
      const data = await res.json() as { trader?: AITrader; error?: string };
      if (!res.ok || !data.trader) throw new Error(data.error ?? "保存に失敗しました");
      setStep("saved");
      toast.success(`AIトレーダー「${name}」を作成しました`);
      onSaved(data.trader);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
      setStep("confirm");
    }
  }, [profile, name, traderDesc, description, onSaved]);

  function handleClose() {
    setStep("input"); setDescription(""); setProfile(null);
    setError(""); onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-4 overflow-y-auto"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="w-full max-w-xl rounded-2xl flex flex-col"
        style={{ background: "#fff", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>

        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: "1px solid #f1f5f9" }}>
          <div>
            <h2 className="text-lg font-black" style={{ color: "#1a1a1a" }}>新しいAIトレーダーを作成</h2>
            <p className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
              どんなトレーダーにしたいかを自然言語で説明してください
            </p>
          </div>
          <button onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 transition-all"
            style={{ color: "#94a3b8", fontSize: 18 }}>✕</button>
        </div>

        <div className="p-6 flex flex-col gap-5">

          {/* STEP: input / generating */}
          {(step === "input" || step === "generating") && (
            <>
              {/* 例 */}
              <div className="rounded-xl p-4"
                style={{ background: "#fffbeb", border: "1px solid #fde68a" }}>
                <p className="text-[11px] font-bold mb-1.5" style={{ color: "#d97706" }}>💡 入力例</p>
                <p className="text-xs leading-relaxed" style={{ color: "#78716c" }}>
                  「GOLD専用。H4の大きな流れを重視して、H1でエントリーを考える。かなり慎重なトレーダーで、
                  トレンドフォロー中心。急激な動きは追わない。重要指標前後は慎重にする。
                  リスクリワードを重視し、長期的な安定性を優先する。」
                </p>
              </div>

              {/* テキスト入力 */}
              <div>
                <label className="block text-xs font-semibold mb-2" style={{ color: "#4a4a4a" }}>
                  どんなAIトレーダーにしたいですか？
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={6}
                  placeholder="自然言語でトレーダーの性格・スタイル・リスク観・分析方法を説明してください..."
                  style={{ ...inputStyle, resize: "vertical" }}
                  disabled={step === "generating"}
                />
                <p className="text-[10px] mt-1 text-right" style={{ color: "#94a3b8" }}>
                  {description.length} / 3000
                </p>
              </div>

              {error && (
                <div className="rounded-lg p-3" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
                  <p className="text-sm" style={{ color: "#dc2626" }}>{error}</p>
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={description.trim().length < 5 || step === "generating"}
                className="w-full py-3 rounded-xl text-sm font-bold text-white transition-all"
                style={{
                  background: step === "generating" ? "#94a3b8"
                    : description.trim().length < 5 ? "#cbd5e1"
                    : "linear-gradient(135deg, #f97316, #ea580c)",
                  boxShadow: step === "generating" || description.trim().length < 5 ? "none"
                    : "0 2px 8px rgba(249,115,22,0.3)",
                }}>
                {step === "generating" ? "🤖 AIが分析中..." : "🤖 AIトレーダーを生成する"}
              </button>

              {step === "generating" && (
                <div className="flex items-center justify-center gap-3 py-2">
                  <div className="w-4 h-4 border-2 rounded-full animate-spin"
                    style={{ borderColor: "rgba(249,115,22,0.2)", borderTopColor: NG }} />
                  <p className="text-sm" style={{ color: "#64748b" }}>性格・スタイル・リスク特性を分析中...</p>
                </div>
              )}
            </>
          )}

          {/* STEP: confirm / saving */}
          {(step === "confirm" || step === "saving") && profile && (
            <>
              {/* 名前・説明編集 */}
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1" style={{ color: "#4a4a4a" }}>トレーダー名</label>
                  <input value={name} onChange={e => setName(e.target.value)}
                    disabled={step === "saving"} style={inputStyle} />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1" style={{ color: "#4a4a4a" }}>説明</label>
                  <input value={traderDesc} onChange={e => setTraderDesc(e.target.value)}
                    disabled={step === "saving"} style={inputStyle} />
                </div>
              </div>

              {/* プロフィール */}
              <div className="rounded-xl p-4"
                style={{ background: "#f8f7f4", border: "1px solid rgba(0,0,0,0.06)" }}>
                <h3 className="text-sm font-bold mb-3" style={{ color: "#1a1a1a" }}>生成されたProfile</h3>
                <ProfileRow label="性格"              value={PERSONALITY_LABELS[profile.personality] ?? profile.personality} />
                <ProfileRow label="取引スタイル"      value={TRADING_STYLE_LABELS[profile.trading_style] ?? profile.trading_style} />
                <ProfileRow label="リスク傾向"        value={RISK_PROFILE_LABELS[profile.risk_profile] ?? profile.risk_profile} />
                <ProfileRow label="エントリーの慎重さ" value={ENTRY_PATIENCE_LABELS[profile.entry_patience] ?? profile.entry_patience} />
                <ProfileRow label="ニュースへの警戒度" value={NEWS_SENSITIVITY_LABELS[profile.news_sensitivity] ?? profile.news_sensitivity} />
                <ProfileRow label="ボラティリティ"    value={VOLATILITY_PREF_LABELS[profile.volatility_preference] ?? profile.volatility_preference} />
                <ProfileRow label="最小RR"            value={`${profile.minimum_rr}:1`} />
                <ProfileRow label="最大リスク/トレード" value={`${profile.max_risk_per_trade}%`} />
                <ProfileRow label="最大同時ポジション" value={`${profile.max_positions}本`} />
                <div className="py-2">
                  <span className="text-xs" style={{ color: "#64748b" }}>使用時間足</span>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {profile.timeframes.map(tf => (
                      <span key={tf} className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                        style={{ background: "#eff6ff", color: "#2563eb" }}>{tf}</span>
                    ))}
                  </div>
                </div>
                {profile.instructions && (
                  <div className="pt-2" style={{ borderTop: "1px solid rgba(0,0,0,0.05)" }}>
                    <span className="text-xs" style={{ color: "#64748b" }}>行動指針</span>
                    <p className="text-xs mt-1 leading-relaxed" style={{ color: "#4a4a4a" }}>
                      {profile.instructions}
                    </p>
                  </div>
                )}
              </div>

              {/* AIの判断理由 */}
              {reasoning && (
                <div className="rounded-xl p-3"
                  style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}>
                  <p className="text-[11px] font-bold mb-1" style={{ color: "#2563eb" }}>AIの判断理由</p>
                  <p className="text-xs leading-relaxed" style={{ color: "#475569" }}>{reasoning}</p>
                </div>
              )}

              {/* Knowledge — V2 Stage 5: bound at runtime from Customer Knowledge */}
              <div className="rounded-xl p-3"
                style={{ background: "#f8fafc", border: "1px dashed #e2e8f0" }}>
                <p className="text-xs font-semibold" style={{ color: "#4a4a4a" }}>分析知識</p>
                <p className="text-[11px] mt-1" style={{ color: "#94a3b8" }}>
                  分析知識はお客様環境に配信された Knowledge パッケージから実行時に自動で読み込まれます。
                </p>
              </div>

              {error && (
                <div className="rounded-lg p-3" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
                  <p className="text-sm" style={{ color: "#dc2626" }}>{error}</p>
                </div>
              )}

              <div className="flex gap-3 pt-2" style={{ borderTop: "1px solid #f1f5f9" }}>
                <button
                  onClick={() => setStep("input")}
                  disabled={step === "saving"}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-all"
                  style={{ color: "#64748b", borderColor: "#e2e8f0" }}>
                  再生成
                </button>
                <button
                  onClick={handleSave}
                  disabled={step === "saving" || !name.trim()}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all"
                  style={{
                    background: step === "saving" ? "#94a3b8" : "linear-gradient(135deg, #f97316, #ea580c)",
                    boxShadow: step === "saving" ? "none" : "0 2px 8px rgba(249,115,22,0.3)",
                  }}>
                  {step === "saving" ? "保存中..." : "AIトレーダーを保存する"}
                </button>
              </div>
            </>
          )}

          {/* STEP: saved */}
          {step === "saved" && (
            <div className="text-center py-8">
              <div className="text-5xl mb-4">🤖</div>
              <h3 className="text-lg font-bold mb-1.5" style={{ color: "#1a1a1a" }}>
                「{name}」を作成しました
              </h3>
              <p className="text-sm mb-6" style={{ color: "#64748b" }}>
                準備中（DRAFT）状態で保存されました
              </p>
              <button onClick={handleClose}
                className="px-8 py-3 rounded-xl text-sm font-bold text-white"
                style={{
                  background: "linear-gradient(135deg, #f97316, #ea580c)",
                  boxShadow:  "0 2px 8px rgba(249,115,22,0.3)",
                }}>
                閉じる
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

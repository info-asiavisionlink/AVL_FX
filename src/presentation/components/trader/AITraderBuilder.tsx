"use client";

// =================================================================
// AITraderBuilder v1
//
// 自然言語 → AI Trader Profile 生成 → Knowledge選択 → 保存
//
// フロー: input → generating → confirm → saved
// =================================================================

import { useState, useCallback } from "react";
import { toast }                  from "sonner";
import {
  PERSONALITY_LABELS, TRADING_STYLE_LABELS, RISK_PROFILE_LABELS,
  ENTRY_PATIENCE_LABELS, NEWS_SENSITIVITY_LABELS, VOLATILITY_PREF_LABELS,
  type AITraderProfile, type AITrader,
} from "@/lib/aiTraderSchema";

const NG      = "#f97316";
const NG_rgba = "rgba(249,115,22,";
const AMBER   = "#fbbf24";
const BLUE    = "#2563eb";
const GREEN   = "#4ade80";

const TIMEFRAME_OPTIONS = ["M1","M5","M15","M30","H1","H4","D1","W1"];

// ── Knowledge item from Console ──────────────────────────────────
interface KnowledgeItem {
  id:       string;
  title:    string;
  category: string;
  summary:  string | null;
  ai_usage: string | null;
  status:   string;
  version:  number;
}

// ── Profile card display ─────────────────────────────────────────
function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2"
      style={{ borderBottom: "1px solid rgba(249,115,22,0.1)" }}>
      <span className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>{label}</span>
      <span className="text-xs font-semibold text-white">{value}</span>
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────
interface Props {
  open:    boolean;
  onClose: () => void;
  onSaved: (t: AITrader) => void;
}

type Step = "input" | "generating" | "confirm" | "saving" | "saved";

export function AITraderBuilder({ open, onClose, onSaved }: Props) {
  const [step,         setStep]         = useState<Step>("input");
  const [description,  setDescription]  = useState("");
  const [name,         setName]         = useState("");
  const [traderDesc,   setTraderDesc]   = useState("");
  const [profile,      setProfile]      = useState<AITraderProfile | null>(null);
  const [reasoning,    setReasoning]    = useState("");
  const [error,        setError]        = useState("");

  // Knowledge
  const [knowledgeList, setKnowledgeList]   = useState<KnowledgeItem[]>([]);
  const [selectedKids,  setSelectedKids]    = useState<Set<string>>(new Set());
  const [knowledgeLoaded, setKnowledgeLoaded] = useState(false);

  // Load knowledge from Console (via TV proxy)
  const loadKnowledge = useCallback(async () => {
    if (knowledgeLoaded) return;
    try {
      const res  = await fetch("/api/knowledge");
      const data = await res.json() as { items?: KnowledgeItem[] };
      setKnowledgeList(data.items ?? []);
      setKnowledgeLoaded(true);
    } catch {
      setKnowledgeList([]);
      setKnowledgeLoaded(true);
    }
  }, [knowledgeLoaded]);

  // Generate profile from description
  const handleGenerate = useCallback(async () => {
    setError("");
    setStep("generating");

    // Load knowledge hints for AI
    let hints: { id: string; title: string; category: string }[] = [];
    try {
      const res  = await fetch("/api/knowledge");
      const data = await res.json() as { items?: KnowledgeItem[] };
      const items = data.items ?? [];
      setKnowledgeList(items);
      setKnowledgeLoaded(true);
      hints = items.map(k => ({ id: k.id, title: k.title, category: k.category }));
    } catch { /* knowledge unavailable */ }

    try {
      const res = await fetch("/api/ai/trader/build", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ description, knowledge_list: hints }),
      });
      const data = await res.json() as {
        success: boolean; error?: string;
        name?: string; description?: string; reasoning?: string;
        profile?: AITraderProfile; suggested_knowledge_ids?: string[];
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

      // AI推奨Knowledgeを自動選択
      const suggested = new Set(data.suggested_knowledge_ids ?? []);
      setSelectedKids(suggested);

      setStep("confirm");
    } catch {
      setError("通信エラーが発生しました。再試行してください。");
      setStep("input");
    }
  }, [description]);

  // Save trader
  const handleSave = useCallback(async () => {
    if (!profile) return;
    setStep("saving");
    setError("");

    try {
      const res = await fetch("/api/traders", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:          name,
          description:   traderDesc || undefined,
          market:        "GOLD",
          profile,
          knowledge_ids: Array.from(selectedKids),
          raw_prompt:    description,
        }),
      });
      const data = await res.json() as { trader?: AITrader; error?: string };

      if (!res.ok || !data.trader) {
        throw new Error(data.error ?? "保存に失敗しました");
      }

      setStep("saved");
      toast.success(`AIトレーダー「${name}」を作成しました`);
      onSaved(data.trader);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
      setStep("confirm");
    }
  }, [profile, name, traderDesc, description, selectedKids, onSaved]);

  function handleClose() {
    setStep("input");
    setDescription("");
    setProfile(null);
    setError("");
    setSelectedKids(new Set());
    onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-4 overflow-y-auto"
      style={{ background: "rgba(0,0,0,0.85)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="w-full max-w-2xl rounded-2xl flex flex-col"
        style={{
          background:   "#0d1117",
          border:       `1px solid ${NG_rgba}0.3)`,
          boxShadow:    `0 0 40px ${NG_rgba}0.1)`,
        }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5"
          style={{ borderBottom: `1px solid ${NG_rgba}0.15)` }}>
          <div>
            <h2 className="text-lg font-black text-white">新しいAIトレーダーを作成</h2>
            <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>
              どんなトレーダーを作りたいかを自然言語で説明してください
            </p>
          </div>
          <button onClick={handleClose} className="text-gray-500 hover:text-white text-xl transition-colors">✕</button>
        </div>

        <div className="p-6 flex flex-col gap-6">

          {/* STEP: input */}
          {(step === "input" || step === "generating") && (
            <>
              <div className="rounded-xl p-4"
                style={{ background: `${NG_rgba}0.05)`, border: `1px solid ${NG_rgba}0.15)` }}>
                <p className="text-xs mb-2" style={{ color: "#fbbf24" }}>💡 例</p>
                <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>
                  「GOLD専用。H4の大きな流れを重視して、H1でエントリーを考える。かなり慎重なトレーダーで、
                  トレンドフォロー中心。急激な動きは追わない。重要指標前後は慎重にする。
                  リスクリワードを重視し、長期的な安定性を重視する。」
                </p>
              </div>

              <div>
                <label className="block text-xs mb-2 font-semibold" style={{ color: "rgba(255,255,255,0.7)" }}>
                  どんなAIトレーダーにしたいですか？
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={6}
                  placeholder="自然言語でトレーダーの性格・スタイル・リスク観・分析方法を説明してください..."
                  className="w-full px-4 py-3 rounded-xl text-sm text-white resize-y"
                  style={{
                    background: "#1a1f2e",
                    border:     `1px solid ${NG_rgba}0.3)`,
                    outline:    "none",
                    lineHeight: "1.6",
                  }}
                  disabled={step === "generating"}
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>
                    {description.length}/3000
                  </span>
                </div>
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button
                onClick={handleGenerate}
                disabled={description.trim().length < 5 || step === "generating"}
                className="w-full py-3 rounded-xl text-sm font-bold text-white transition-all"
                style={{
                  background: step === "generating" ? "#374151" : NG,
                  opacity: description.trim().length < 5 ? 0.5 : 1,
                }}>
                {step === "generating" ? "AIが分析中..." : "🤖 AIトレーダーを生成する"}
              </button>

              {step === "generating" && (
                <div className="text-center py-4">
                  <div className="inline-flex items-center gap-3" style={{ color: "rgba(255,255,255,0.5)" }}>
                    <div className="w-5 h-5 border-2 border-t-orange-400 rounded-full animate-spin"
                      style={{ borderColor: `${NG_rgba}0.3)`, borderTopColor: NG }} />
                    <span className="text-sm">性格・スタイル・リスク特性を分析中...</span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* STEP: confirm */}
          {(step === "confirm" || step === "saving") && profile && (
            <>
              {/* Name & Description edit */}
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: "rgba(255,255,255,0.5)" }}>
                    トレーダー名
                  </label>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    disabled={step === "saving"}
                    className="w-full px-3 py-2 rounded-lg text-sm text-white font-bold"
                    style={{ background: "#1a1f2e", border: `1px solid ${NG_rgba}0.3)` }} />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: "rgba(255,255,255,0.5)" }}>
                    説明
                  </label>
                  <input
                    value={traderDesc}
                    onChange={e => setTraderDesc(e.target.value)}
                    disabled={step === "saving"}
                    className="w-full px-3 py-2 rounded-lg text-sm text-white"
                    style={{ background: "#1a1f2e", border: `1px solid ${NG_rgba}0.3)` }} />
                </div>
              </div>

              {/* Profile summary */}
              <div className="rounded-xl p-4"
                style={{ background: "#1a1f2e", border: `1px solid ${NG_rgba}0.15)` }}>
                <h3 className="text-sm font-bold text-white mb-3">生成されたProfile</h3>
                <ProfileRow label="性格"             value={PERSONALITY_LABELS[profile.personality] ?? profile.personality} />
                <ProfileRow label="取引スタイル"      value={TRADING_STYLE_LABELS[profile.trading_style] ?? profile.trading_style} />
                <ProfileRow label="リスク傾向"        value={RISK_PROFILE_LABELS[profile.risk_profile] ?? profile.risk_profile} />
                <ProfileRow label="エントリーの慎重さ" value={ENTRY_PATIENCE_LABELS[profile.entry_patience] ?? profile.entry_patience} />
                <ProfileRow label="ニュースへの警戒度" value={NEWS_SENSITIVITY_LABELS[profile.news_sensitivity] ?? profile.news_sensitivity} />
                <ProfileRow label="ボラティリティ"    value={VOLATILITY_PREF_LABELS[profile.volatility_preference] ?? profile.volatility_preference} />
                <ProfileRow label="最小RR"            value={`${profile.minimum_rr}:1`} />
                <ProfileRow label="最大リスク/トレード" value={`${profile.max_risk_per_trade}%`} />
                <ProfileRow label="最大同時ポジション" value={`${profile.max_positions}本`} />
                <div className="py-2">
                  <span className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>使用時間足</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {profile.timeframes.map(tf => (
                      <span key={tf} className="px-2 py-0.5 rounded text-xs font-medium"
                        style={{ background: `${NG_rgba}0.2)`, color: NG }}>{tf}</span>
                    ))}
                  </div>
                </div>
                {profile.instructions && (
                  <div className="py-2">
                    <span className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>行動指針</span>
                    <p className="text-xs mt-1 leading-relaxed" style={{ color: "rgba(255,255,255,0.7)" }}>
                      {profile.instructions}
                    </p>
                  </div>
                )}
              </div>

              {/* AIの判断理由 */}
              {reasoning && (
                <div className="rounded-xl p-4"
                  style={{ background: "rgba(37,99,235,0.1)", border: "1px solid rgba(37,99,235,0.2)" }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: "#60a5fa" }}>AIの判断理由</p>
                  <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.6)" }}>{reasoning}</p>
                </div>
              )}

              {/* Knowledge Selection */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-white">使用する分析知識</h3>
                  <button
                    onClick={loadKnowledge}
                    className="text-xs px-2 py-1 rounded"
                    style={{ color: NG, background: `${NG_rgba}0.1)` }}>
                    更新
                  </button>
                </div>
                {knowledgeList.length === 0 ? (
                  <div className="rounded-xl p-4 text-center"
                    style={{ border: "1px dashed rgba(100,116,139,0.3)" }}>
                    <p className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>
                      Knowledgeがまだ登録されていません
                    </p>
                    <p className="text-[10px] mt-1" style={{ color: "rgba(255,255,255,0.2)" }}>
                      Console → AIトレード知識 から登録できます
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {knowledgeList.map(k => (
                      <label key={k.id}
                        className="flex items-start gap-3 cursor-pointer p-3 rounded-lg transition-all"
                        style={{
                          background:   selectedKids.has(k.id) ? `${NG_rgba}0.1)` : "rgba(255,255,255,0.02)",
                          border:       `1px solid ${selectedKids.has(k.id) ? NG_rgba + "0.3)" : "rgba(100,116,139,0.15)"}`,
                        }}>
                        <input
                          type="checkbox"
                          checked={selectedKids.has(k.id)}
                          onChange={e => {
                            const next = new Set(selectedKids);
                            if (e.target.checked) next.add(k.id);
                            else next.delete(k.id);
                            setSelectedKids(next);
                          }}
                          className="mt-0.5 accent-orange-400" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">{k.title}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{ background: `${NG_rgba}0.1)`, color: NG }}>{k.category}</span>
                            <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>v{k.version}</span>
                          </div>
                          {k.ai_usage && (
                            <p className="text-[11px] mt-0.5" style={{ color: "#fbbf24" }}>🤖 {k.ai_usage}</p>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
                {selectedKids.size > 0 && (
                  <p className="text-[11px] mt-2" style={{ color: "rgba(255,255,255,0.4)" }}>
                    {selectedKids.size}件のKnowledgeを選択中
                  </p>
                )}
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setStep("input")}
                  disabled={step === "saving"}
                  className="flex-1 py-2.5 rounded-xl text-sm border font-medium transition-all"
                  style={{ borderColor: `${NG_rgba}0.3)`, color: "rgba(255,255,255,0.6)" }}>
                  再生成
                </button>
                <button
                  onClick={handleSave}
                  disabled={step === "saving" || !name.trim()}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all"
                  style={{ background: step === "saving" ? "#374151" : NG }}>
                  {step === "saving" ? "保存中..." : "AIトレーダーを保存する"}
                </button>
              </div>
            </>
          )}

          {/* STEP: saved */}
          {step === "saved" && (
            <div className="text-center py-8">
              <div className="text-5xl mb-4">🤖</div>
              <h3 className="text-lg font-bold text-white mb-2">
                AIトレーダー「{name}」を作成しました
              </h3>
              <p className="text-sm mb-6" style={{ color: "rgba(255,255,255,0.5)" }}>
                トレーダーはDRAFT状態で保存されました
              </p>
              <button
                onClick={handleClose}
                className="px-8 py-3 rounded-xl text-sm font-bold text-white"
                style={{ background: NG }}>
                閉じる
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { toast }                             from "sonner";
import { Bot, Zap, TrendingUp, Shield, Brain, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { AITraderBuilder }   from "./AITraderBuilder";
import { AITraderDetailModal } from "./AITraderDetailModal";
import {
  PERSONALITY_LABELS, TRADING_STYLE_LABELS, RISK_PROFILE_LABELS,
  WATCHER_STATE_LABELS,
  type AITrader,
} from "@/lib/aiTraderSchema";

const NG = "#f97316";

// ─────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────
const PERSONALITY_COLOR: Record<string, string> = {
  CONSERVATIVE: "#06b6d4",   // cyan
  BALANCED:     "#8b5cf6",   // violet
  AGGRESSIVE:   "#f97316",   // orange
};

const STYLE_ICON: Record<string, React.ReactNode> = {
  TREND_FOLLOWING: <TrendingUp  size={10} />,
  BREAKOUT:        <Zap         size={10} />,
  REVERSAL:        <RefreshCw   size={10} />,
  PRICE_ACTION:    <ChevronRight size={10} />,
  MULTI_TIMEFRAME: <Brain       size={10} />,
  HYBRID:          <Shield      size={10} />,
};

const RISK_DOT: Record<string, string> = {
  VERY_LOW: "#22c55e",
  LOW:      "#86efac",
  MEDIUM:   "#fb923c",
  HIGH:     "#f87171",
};

// ─────────────────────────────────────────────────────────────────
// TraderCard
// ─────────────────────────────────────────────────────────────────
function TraderCard({
  trader, idx, onDelete, onDetail,
}: {
  trader: AITrader; idx: number;
  onDelete: (id: string) => void;
  onDetail: (t: AITrader) => void;
}) {
  const profile    = trader.current_profile;
  const pColor     = PERSONALITY_COLOR[profile?.personality ?? ""] ?? "#06b6d4";
  const [busy, setBusy] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`「${trader.name}」を削除しますか？`)) return;
    setBusy(true);
    const res = await fetch(`/api/traders/${trader.id}`, { method: "DELETE" });
    if (res.ok) { toast.success("削除しました"); onDelete(trader.id); }
    else toast.error("削除に失敗しました");
    setBusy(false);
  }

  const isActive    = trader.status === "ACTIVE";
  const currentMode = trader.execution_mode ?? "STOPPED";

  async function handleModeChange(e: React.MouseEvent, next: "MANUAL_APPROVAL" | "ANALYSIS_ONLY" | "DEMO_AUTONOMOUS") {
    e.stopPropagation();
    if (next === currentMode) return;
    if (next === "DEMO_AUTONOMOUS" && !confirm(
      "デモ自動実行をONにします。\n本番口座では実行できません。\n\n続けますか？"
    )) return;
    setBusy(true);
    const res = await fetch(`/api/traders/${trader.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_mode: next }),
    });
    if (res.ok) {
      const labels: Record<string, string> = {
        MANUAL_APPROVAL: "承認実行モードに切り替えました",
        ANALYSIS_ONLY: "分析モードに切り替えました",
        STOPPED: "停止しました",
      };
      toast.success(labels[next]);
      window.location.reload();
    } else {
      toast.error("変更に失敗しました");
    }
    setBusy(false);
  }

  return (
    <div
      onClick={() => onDetail(trader)}
      className="relative overflow-hidden rounded-2xl cursor-pointer group transition-all duration-200"
      style={{
        background: "rgba(255,255,255,0.85)",
        border: `1px solid rgba(0,0,0,0.07)`,
        boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = `0 8px 32px rgba(0,0,0,0.12), 0 0 0 1px ${pColor}33`; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 2px 12px rgba(0,0,0,0.06)"; }}
    >
      {/* 上部カラーバー */}
      <div className="h-0.5 w-full" style={{ background: `linear-gradient(90deg, ${pColor}, transparent)` }} />

      {/* ウォッチャー状態インジケーター */}
      {isActive && (() => {
        const ws = (trader.watcher_state ?? "WATCHING") as keyof typeof WATCHER_STATE_LABELS;
        const wsInfo = WATCHER_STATE_LABELS[ws] ?? WATCHER_STATE_LABELS.WATCHING;
        return (
          <div className="absolute top-3 right-3 flex items-center gap-1">
            {wsInfo.pulse ? (
              <div className="relative w-1.5 h-1.5">
                <div className="absolute inset-0 rounded-full animate-ping opacity-70"
                  style={{ background: wsInfo.color }} />
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: wsInfo.color }} />
              </div>
            ) : (
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: wsInfo.color }} />
            )}
            <span className="text-[8px] font-mono" style={{ color: wsInfo.color }}>
              {wsInfo.label}
            </span>
          </div>
        );
      })()}

      <div className="p-4 flex flex-col gap-3">
        {/* ナンバー + 名前 */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: `${pColor}15`, border: `1px solid ${pColor}30` }}>
            <Bot size={16} style={{ color: pColor }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[9px] font-mono" style={{ color: "#94a3b8" }}>
                #{String(idx + 1).padStart(3, "0")}
              </span>
              <span className="text-[8px] px-1.5 py-0.5 rounded font-mono"
                style={{
                  background: isActive ? "#dcfce7" : "#f1f5f9",
                  color:      isActive ? "#16a34a" : "#64748b",
                }}>
                {isActive ? "稼働中" : "準備中"}
              </span>
            </div>
            <h3 className="text-sm font-bold leading-tight truncate" style={{ color: "#1a1a1a" }}>
              {trader.name}
            </h3>
          </div>
        </div>

        {/* プロフィールチップ */}
        {profile && (
          <div className="flex flex-wrap gap-1">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
              style={{ background: `${pColor}15`, color: pColor }}>
              {PERSONALITY_LABELS[profile.personality] ?? profile.personality}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]"
              style={{ background: "#f1f5f9", color: "#475569" }}>
              {STYLE_ICON[profile.trading_style]}
              {TRADING_STYLE_LABELS[profile.trading_style] ?? profile.trading_style}
            </span>
          </div>
        )}

        {/* 時間足 */}
        {profile && profile.timeframes.length > 0 && (
          <div className="flex gap-1">
            {profile.timeframes.map(tf => (
              <span key={tf} className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold"
                style={{ background: "#eff6ff", color: "#2563eb" }}>{tf}</span>
            ))}
          </div>
        )}

        {/* メトリクス */}
        {profile && (
          <div className="grid grid-cols-3 gap-1.5 pt-2"
            style={{ borderTop: "1px solid rgba(0,0,0,0.05)" }}>
            {[
              { label: "MIN RR",   value: `${profile.minimum_rr}:1` },
              { label: "MAX RISK", value: `${profile.max_risk_per_trade}%` },
              { label: "MAX POS",  value: `${profile.max_positions}` },
            ].map(m => (
              <div key={m.label} className="text-center">
                <p className="text-[7px] font-mono tracking-wider" style={{ color: "#94a3b8" }}>{m.label}</p>
                <p className="text-[11px] font-bold font-mono" style={{ color: "#1a1a1a" }}>{m.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* リスクドット + アクション */}
        <div className="flex items-center justify-between pt-1"
          style={{ borderTop: "1px solid rgba(0,0,0,0.05)" }}
          onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full"
              style={{ background: RISK_DOT[profile?.risk_profile ?? ""] ?? "#94a3b8" }} />
            <span className="text-[8px] font-mono" style={{ color: "#94a3b8" }}>
              {RISK_PROFILE_LABELS[profile?.risk_profile ?? ""] ?? "—"}
            </span>
          </div>
          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
            {/* 3択モードボタン */}
            <button
              onClick={e => handleModeChange(e, "MANUAL_APPROVAL")}
              disabled={busy}
              className="px-2.5 py-1 rounded-lg text-[9px] font-bold border transition-all flex items-center gap-1"
              style={{
                background:  currentMode === "MANUAL_APPROVAL" ? "#dcfce7" : "#f8fafc",
                color:       currentMode === "MANUAL_APPROVAL" ? "#16a34a" : "#94a3b8",
                borderColor: currentMode === "MANUAL_APPROVAL" ? "#86efac" : "#e2e8f0",
              }}>
              <span style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: currentMode === "MANUAL_APPROVAL" ? "#22c55e" : "#cbd5e1",
                boxShadow:  currentMode === "MANUAL_APPROVAL" ? "0 0 5px #22c55e" : "none",
              }} />
              承認実行
            </button>
            <button
              onClick={e => handleModeChange(e, "ANALYSIS_ONLY")}
              disabled={busy}
              className="px-2.5 py-1 rounded-lg text-[9px] font-bold border transition-all flex items-center gap-1"
              style={{
                background:  currentMode === "ANALYSIS_ONLY" ? "#dbeafe" : "#f8fafc",
                color:       currentMode === "ANALYSIS_ONLY" ? "#2563eb" : "#94a3b8",
                borderColor: currentMode === "ANALYSIS_ONLY" ? "#93c5fd" : "#e2e8f0",
              }}>
              <span style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: currentMode === "ANALYSIS_ONLY" ? "#3b82f6" : "#cbd5e1",
                boxShadow:  currentMode === "ANALYSIS_ONLY" ? "0 0 5px #3b82f6" : "none",
              }} />
              分析のみ
            </button>
            <button
              onClick={e => handleModeChange(e, "ANALYSIS_ONLY")}
              disabled={busy}
              className="px-2.5 py-1 rounded-lg text-[9px] font-bold border transition-all flex items-center gap-1"
              style={{
                background:  currentMode === "STOPPED" ? "#fee2e2" : "#f8fafc",
                color:       currentMode === "STOPPED" ? "#dc2626" : "#94a3b8",
                borderColor: currentMode === "STOPPED" ? "#fca5a5" : "#e2e8f0",
              }}>
              <span style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: currentMode === "STOPPED" ? "#ef4444" : "#cbd5e1",
                boxShadow:  currentMode === "STOPPED" ? "0 0 5px #ef4444" : "none",
              }} />
              停止
            </button>
            <button onClick={handleDelete} disabled={busy}
              className="px-2 py-0.5 rounded text-[8px] font-mono border ml-1"
              style={{ background: "#f8fafc", color: "#94a3b8", borderColor: "#e2e8f0" }}>
              削除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Empty State
// ─────────────────────────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center px-8">
      <div className="text-center max-w-md">
        {/* アイコングリッド */}
        <div className="grid grid-cols-3 gap-3 mb-8 max-w-[180px] mx-auto">
          {[
            { color: "#06b6d4", label: "慎重型" },
            { color: "#8b5cf6", label: "均衡型" },
            { color: "#f97316", label: "積極型" },
            { color: "#22c55e", label: "低リスク" },
            { color: "#6366f1", label: "分析型" },
            { color: "#ec4899", label: "複合型" },
          ].map((c, i) => (
            <div key={i} className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto"
              style={{
                background: `${c.color}12`,
                border: `1px solid ${c.color}30`,
              }}>
              <Bot size={20} style={{ color: c.color, opacity: 0.8 }} />
            </div>
          ))}
        </div>

        <h2 className="text-base font-black mb-2" style={{ color: "#1a1a1a" }}>
          AIトレーダーがいません
        </h2>
        <p className="text-xs leading-relaxed mb-2" style={{ color: "#64748b" }}>
          自然言語で「どんなトレーダーにしたいか」を入力するだけで、
          AIが性格・スタイル・リスク特性を分析して構造化します。
        </p>
        <p className="text-[10px] font-mono mb-6" style={{ color: "#94a3b8" }}>
          知識 × 性格 × 経験 → AI Trader
        </p>
        <button onClick={onAdd}
          className="px-7 py-3 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90"
          style={{
            background: "linear-gradient(135deg, #f97316, #ea580c)",
            boxShadow:  "0 4px 12px rgba(249,115,22,0.35)",
          }}>
          + 最初のAIトレーダーを作成
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
export function AITraderCommandCenter() {
  const [traders,      setTraders]      = useState<AITrader[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [builderOpen,  setBuilderOpen]  = useState(false);
  const [detailTrader, setDetailTrader] = useState<AITrader | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch("/api/traders");
      const data = await res.json() as { traders?: AITrader[] };
      if (res.ok) setTraders(data.traders ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-4 pt-12 md:pt-4 bg-[#f8f7f4]">

      {/* ─ ヘッダー ─ */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-3">
          {/* シアンアクセントライン */}
          <div className="w-0.5 h-5 rounded-full" style={{ background: "linear-gradient(180deg, #06b6d4, #2563eb)" }} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono tracking-widest" style={{ color: "#06b6d4" }}>
                AI TRADERS
              </span>
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: "#f0f9ff", color: "#0891b2", border: "1px solid #bae6fd" }}>
                {traders.length} 体
              </span>
            </div>
            <h1 className="text-base font-black" style={{ color: "#1a1a1a" }}>
              AIトレーダー
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading}
            className="p-1.5 rounded-lg border transition-all"
            style={{ border: "1px solid rgba(0,0,0,0.07)", color: "#94a3b8" }}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => setBuilderOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white transition-all hover:opacity-90"
            style={{
              background: "linear-gradient(135deg, #f97316, #ea580c)",
              boxShadow:  "0 2px 8px rgba(249,115,22,0.35)",
            }}>
            <Plus size={12} />
            AIトレーダーを追加
          </button>
        </div>
      </div>

      {/* ─ ステータスバー ─ */}
      {traders.length > 0 && (
        <div className="flex gap-4 mb-4 shrink-0">
          {[
            { label: "稼働中", value: traders.filter(t => t.status === "ACTIVE").length,   color: "#22c55e" },
            { label: "準備中", value: traders.filter(t => t.status === "DRAFT").length,    color: "#f97316" },
            { label: "合計",   value: traders.length,                                       color: "#06b6d4" },
          ].map(s => (
            <div key={s.label} className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
              <span className="text-[8px] font-mono" style={{ color: "#94a3b8" }}>{s.label}</span>
              <span className="text-[10px] font-bold font-mono" style={{ color: "#1a1a1a" }}>{s.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* ─ コンテンツ ─ */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 border border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-[10px] font-mono" style={{ color: "#94a3b8" }}>LOADING...</p>
          </div>
        </div>
      ) : traders.length === 0 ? (
        <EmptyState onAdd={() => setBuilderOpen(true)} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pb-4">
            {traders.map((t, i) => (
              <TraderCard key={t.id} trader={t} idx={i}
                onDelete={id => setTraders(prev => prev.filter(x => x.id !== id))}
                onDetail={setDetailTrader} />
            ))}

            {/* 追加カード */}
            <button
              onClick={() => setBuilderOpen(true)}
              className="rounded-2xl p-4 flex flex-col items-center justify-center gap-2 transition-all min-h-[160px]"
              style={{
                border:     "1px dashed rgba(249,115,22,0.3)",
                background: "rgba(249,115,22,0.03)",
                color:      NG,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(249,115,22,0.07)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(249,115,22,0.03)"; }}>
              <div className="w-8 h-8 rounded-full border border-orange-300/50 flex items-center justify-center">
                <Plus size={14} style={{ color: NG }} />
              </div>
              <span className="text-[10px] font-mono font-bold">ADD TRADER</span>
            </button>
          </div>
        </div>
      )}

      {/* ─ モーダル ─ */}
      <AITraderBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onSaved={t => { setTraders(prev => [t, ...prev]); setBuilderOpen(false); }}
      />
      <AITraderDetailModal
        trader={detailTrader}
        onClose={() => setDetailTrader(null)}
      />
    </div>
  );
}

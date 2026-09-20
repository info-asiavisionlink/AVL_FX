"use client";

import { useState, useEffect, useCallback } from "react";
import { toast }                             from "sonner";
import { AITraderBuilder }                   from "./AITraderBuilder";
import { AITraderDetailModal }               from "./AITraderDetailModal";
import {
  PERSONALITY_LABELS, TRADING_STYLE_LABELS, RISK_PROFILE_LABELS,
  type AITrader,
} from "@/lib/aiTraderSchema";

const NG = "#f97316";

// ── ステータスバッジ ──────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    DRAFT:    { bg: "#fff7ed", color: "#c2410c", label: "準備中" },
    ACTIVE:   { bg: "#f0fdf4", color: "#15803d", label: "稼働中" },
    ARCHIVED: { bg: "#f8fafc", color: "#64748b", label: "無効"   },
  };
  const s = map[status] ?? { bg: "#f8fafc", color: "#64748b", label: status };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}

// ── リスクバッジ ──────────────────────────────────────────────────
function RiskBadge({ risk }: { risk: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    VERY_LOW: { bg: "#f0fdf4", color: "#15803d" },
    LOW:      { bg: "#f0fdf4", color: "#16a34a" },
    MEDIUM:   { bg: "#fffbeb", color: "#d97706" },
    HIGH:     { bg: "#fef2f2", color: "#dc2626" },
  };
  const s = map[risk] ?? { bg: "#f8fafc", color: "#64748b" };
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ background: s.bg, color: s.color }}>
      {RISK_PROFILE_LABELS[risk] ?? risk}
    </span>
  );
}

// ── トレーダーカード ──────────────────────────────────────────────
function TraderCard({
  trader,
  onDelete,
  onDetail,
}: {
  trader:   AITrader;
  onDelete: (id: string) => void;
  onDetail: (t: AITrader) => void;
}) {
  const profile   = trader.current_profile;
  const [deleting,   setDeleting]   = useState(false);
  const [activating, setActivating] = useState(false);

  async function handleDelete() {
    if (!confirm(`「${trader.name}」を削除しますか？`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/traders/${trader.id}`, { method: "DELETE" });
      if (res.ok) { toast.success("削除しました"); onDelete(trader.id); }
      else toast.error("削除に失敗しました");
    } finally { setDeleting(false); }
  }

  async function handleToggleActive() {
    setActivating(true);
    const newStatus = trader.status === "ACTIVE" ? "DRAFT" : "ACTIVE";
    try {
      const res = await fetch(`/api/traders/${trader.id}/status`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        toast.success(newStatus === "ACTIVE" ? "有効化しました" : "準備中に戻しました");
        window.location.reload();
      } else toast.error("変更に失敗しました");
    } finally { setActivating(false); }
  }

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 cursor-pointer transition-all hover:shadow-md"
      style={{
        background:  "#fff",
        border:      "1px solid rgba(0,0,0,0.07)",
        boxShadow:   "0 2px 8px rgba(0,0,0,0.04)",
      }}
      onClick={() => onDetail(trader)}>

      {/* ヘッダー */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
            <StatusBadge status={trader.status} />
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
              style={{ background: "#eff6ff", color: "#2563eb" }}>{trader.market}</span>
            <span className="text-[10px]" style={{ color: "#94a3b8" }}>v{trader.current_version}</span>
          </div>
          <h3 className="text-base font-black truncate" style={{ color: "#1a1a1a" }}>{trader.name}</h3>
          {trader.description && (
            <p className="text-xs mt-0.5 line-clamp-2" style={{ color: "#64748b" }}>{trader.description}</p>
          )}
        </div>

        {/* アクションボタン（クリック伝播を止める）*/}
        <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={() => onDetail(trader)}
            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all"
            style={{ background: "#fff7ed", color: NG, borderColor: "#fed7aa" }}>
            詳細
          </button>
          <button onClick={handleToggleActive} disabled={activating}
            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all"
            style={{
              background:   trader.status === "ACTIVE" ? "#f8fafc" : "#f0fdf4",
              color:        trader.status === "ACTIVE" ? "#64748b" : "#15803d",
              borderColor:  trader.status === "ACTIVE" ? "#e2e8f0" : "#bbf7d0",
            }}>
            {activating ? "..." : trader.status === "ACTIVE" ? "停止" : "有効化"}
          </button>
          <button onClick={handleDelete} disabled={deleting}
            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all"
            style={{ background: "#fef2f2", color: "#dc2626", borderColor: "#fecaca" }}>
            {deleting ? "..." : "削除"}
          </button>
        </div>
      </div>

      {/* プロファイルチップ */}
      {profile && (
        <div className="flex flex-wrap gap-1.5">
          <span className="px-2.5 py-1 rounded-lg text-[11px] font-semibold"
            style={{ background: "#fff7ed", color: NG }}>
            {PERSONALITY_LABELS[profile.personality] ?? profile.personality}
          </span>
          <span className="px-2.5 py-1 rounded-lg text-[11px]"
            style={{ background: "#fffbeb", color: "#d97706" }}>
            {TRADING_STYLE_LABELS[profile.trading_style] ?? profile.trading_style}
          </span>
          <RiskBadge risk={profile.risk_profile} />
        </div>
      )}

      {/* 時間足 */}
      {profile && profile.timeframes.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px]" style={{ color: "#94a3b8" }}>使用時間足</span>
          <div className="flex gap-1">
            {profile.timeframes.map(tf => (
              <span key={tf} className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                style={{ background: "#eff6ff", color: "#2563eb" }}>{tf}</span>
            ))}
          </div>
        </div>
      )}

      {/* リスク数値 */}
      {profile && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "最小RR",         value: `${profile.minimum_rr}:1` },
            { label: "最大リスク",     value: `${profile.max_risk_per_trade}%` },
            { label: "最大ポジション", value: `${profile.max_positions}本` },
          ].map(m => (
            <div key={m.label} className="rounded-xl p-2 text-center"
              style={{ background: "#f8f7f4", border: "1px solid rgba(0,0,0,0.05)" }}>
              <p className="text-[9px] mb-0.5" style={{ color: "#94a3b8" }}>{m.label}</p>
              <p className="text-xs font-bold" style={{ color: "#1a1a1a" }}>{m.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Public ID */}
      <div className="flex items-center justify-between pt-2"
        style={{ borderTop: "1px solid rgba(0,0,0,0.05)" }}
        onClick={e => e.stopPropagation()}>
        <span className="text-[9px] font-mono" style={{ color: "#cbd5e1" }}>
          ID: {trader.public_id}
        </span>
        <button
          onClick={() => { void navigator.clipboard.writeText(trader.public_id); toast.success("IDをコピーしました"); }}
          className="text-[9px] px-1.5 py-0.5 rounded transition-all"
          style={{ color: NG, background: "#fff7ed" }}>
          コピー
        </button>
      </div>
    </div>
  );
}

// ── メインコンポーネント ──────────────────────────────────────────
export function AITraderCommandCenter() {
  const [traders,      setTraders]      = useState<AITrader[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [builderOpen,  setBuilderOpen]  = useState(false);
  const [detailTrader, setDetailTrader] = useState<AITrader | null>(null);

  const loadTraders = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch("/api/traders");
      const data = await res.json() as { traders?: AITrader[] };
      if (res.ok) setTraders(data.traders ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadTraders(); }, [loadTraders]);

  function handleDelete(id: string) { setTraders(prev => prev.filter(t => t.id !== id)); }
  function handleSaved(trader: AITrader) { setTraders(prev => [trader, ...prev]); setBuilderOpen(false); }

  return (
    <div className="flex flex-col h-full min-h-0 p-4 pt-12 md:pt-4 overflow-hidden">

      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-5 shrink-0">
        <div>
          <h1 className="text-xl font-black" style={{ color: NG }}>AIトレーダー</h1>
          <p className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
            知識・性格・分析方針を持つトレーダーを管理します
          </p>
        </div>
        <button
          onClick={() => setBuilderOpen(true)}
          className="px-4 py-2 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90"
          style={{
            background: "linear-gradient(135deg, #f97316, #ea580c)",
            boxShadow:  "0 2px 8px rgba(249,115,22,0.3)",
          }}>
          + AIトレーダーを追加
        </button>
      </div>

      {/* コンテンツ */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-3"
              style={{ borderColor: "rgba(249,115,22,0.2)", borderTopColor: NG }} />
            <p className="text-sm" style={{ color: "#94a3b8" }}>読み込み中...</p>
          </div>
        </div>
      ) : traders.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center py-12 px-8 rounded-2xl max-w-sm w-full"
            style={{ background: "#fff", border: "1px dashed rgba(249,115,22,0.3)" }}>
            <div className="text-5xl mb-4">🤖</div>
            <h2 className="text-base font-bold mb-1.5" style={{ color: "#1a1a1a" }}>
              AIトレーダーがまだいません
            </h2>
            <p className="text-xs mb-5 leading-relaxed" style={{ color: "#64748b" }}>
              どんなトレーダーにしたいかを<br/>自然言語で説明するだけで作成できます
            </p>
            <button
              onClick={() => setBuilderOpen(true)}
              className="px-6 py-2.5 rounded-xl text-sm font-bold text-white"
              style={{
                background: "linear-gradient(135deg, #f97316, #ea580c)",
                boxShadow:  "0 2px 8px rgba(249,115,22,0.3)",
              }}>
              最初のAIトレーダーを作成
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 overflow-y-auto pb-4">
          {traders.map(t => (
            <TraderCard key={t.id} trader={t} onDelete={handleDelete} onDetail={setDetailTrader} />
          ))}
        </div>
      )}

      {/* 作成モーダル */}
      <AITraderBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onSaved={handleSaved}
      />

      {/* 詳細モーダル */}
      <AITraderDetailModal
        trader={detailTrader}
        onClose={() => setDetailTrader(null)}
      />
    </div>
  );
}

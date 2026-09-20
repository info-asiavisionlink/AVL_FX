"use client";

// =================================================================
// AITraderCommandCenter v1
//
// AI Trader の一覧表示・管理・新規作成ボタン
// =================================================================

import { useState, useEffect, useCallback } from "react";
import { toast }                             from "sonner";
import { AITraderBuilder }                   from "./AITraderBuilder";
import { AITraderDetailModal }               from "./AITraderDetailModal";
import {
  PERSONALITY_LABELS, TRADING_STYLE_LABELS, RISK_PROFILE_LABELS,
  type AITrader,
} from "@/lib/aiTraderSchema";

const NG      = "#f97316";
const NG_rgba = "rgba(249,115,22,";
const AMBER   = "#fbbf24";
const GREEN   = "#4ade80";
const BLUE    = "#2563eb";
const RED     = "#ef4444";

// ── Status badge ─────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; label: string }> = {
    DRAFT:    { bg: "#d97706", label: "準備中" },
    ACTIVE:   { bg: "#16a34a", label: "稼働中" },
    ARCHIVED: { bg: "#64748b", label: "無効"   },
  };
  const { bg, label } = map[status] ?? { bg: "#64748b", label: status };
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-bold text-white"
      style={{ background: bg }}>
      {label}
    </span>
  );
}

// ── Risk badge ───────────────────────────────────────────────────
function RiskBadge({ risk }: { risk: string }) {
  const colors: Record<string, string> = {
    VERY_LOW: "#16a34a",
    LOW:      "#4ade80",
    MEDIUM:   AMBER,
    HIGH:     RED,
  };
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-bold"
      style={{ background: "rgba(0,0,0,0.3)", color: colors[risk] ?? "#94a3b8" }}>
      {RISK_PROFILE_LABELS[risk] ?? risk}
    </span>
  );
}

// ── Trader Card ──────────────────────────────────────────────────
function TraderCard({
  trader,
  onDelete,
  onDetail,
}: {
  trader: AITrader;
  onDelete: (id: string) => void;
  onDetail: (t: AITrader) => void;
}) {
  const profile = trader.current_profile;
  const [deleting,   setDeleting]   = useState(false);
  const [activating, setActivating] = useState(false);

  async function handleDelete() {
    if (!confirm(`「${trader.name}」を削除しますか？`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/traders/${trader.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("AIトレーダーを削除しました");
        onDelete(trader.id);
      } else {
        toast.error("削除に失敗しました");
      }
    } finally {
      setDeleting(false);
    }
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
        toast.success(newStatus === "ACTIVE" ? "AIトレーダーを有効化しました" : "DRAFTに戻しました");
        // Re-load page
        window.location.reload();
      } else {
        toast.error("変更に失敗しました");
      }
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="rounded-xl p-5 flex flex-col gap-4 relative overflow-hidden"
      style={{
        background: "#0d1117",
        border:     `1px solid ${NG_rgba}0.15)`,
      }}>
      {/* Background decoration */}
      <div className="absolute top-0 right-0 w-24 h-24 rounded-bl-full pointer-events-none"
        style={{ background: `${NG_rgba}0.03)` }} />

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <StatusBadge status={trader.status} />
            <span className="text-[10px] px-2 py-0.5 rounded font-medium"
              style={{ background: "rgba(37,99,235,0.2)", color: "#60a5fa" }}>
              {trader.market}
            </span>
            <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>
              v{trader.current_version}
            </span>
          </div>
          <h3 className="text-base font-black text-white truncate">{trader.name}</h3>
          {trader.description && (
            <p className="text-xs mt-1 line-clamp-2" style={{ color: "rgba(255,255,255,0.5)" }}>
              {trader.description}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => onDetail(trader)}
            className="text-xs px-2 py-1 rounded transition-all"
            style={{ background: `${NG_rgba}0.15)`, color: NG }}>詳細</button>
          <button onClick={handleToggleActive} disabled={activating}
            className="text-xs px-2 py-1 rounded transition-all"
            style={{
              background: trader.status === "ACTIVE" ? "rgba(100,116,139,0.2)" : "rgba(22,163,74,0.15)",
              color: trader.status === "ACTIVE" ? "#94a3b8" : "#4ade80",
            }}>
            {activating ? "..." : trader.status === "ACTIVE" ? "停止" : "有効化"}
          </button>
          <button onClick={handleDelete} disabled={deleting}
            className="text-xs px-2 py-1 rounded transition-all"
            style={{ background: "rgba(239,68,68,0.1)", color: "#f87171" }}>
            {deleting ? "..." : "削除"}
          </button>
        </div>
      </div>

      {/* Profile chips */}
      {profile && (
        <div className="flex flex-wrap gap-2">
          <span className="px-2.5 py-1 rounded-lg text-xs font-semibold"
            style={{ background: `${NG_rgba}0.15)`, color: NG }}>
            {PERSONALITY_LABELS[profile.personality] ?? profile.personality}
          </span>
          <span className="px-2.5 py-1 rounded-lg text-xs"
            style={{ background: "rgba(251,191,36,0.1)", color: AMBER }}>
            {TRADING_STYLE_LABELS[profile.trading_style] ?? profile.trading_style}
          </span>
          <RiskBadge risk={profile.risk_profile} />
        </div>
      )}

      {/* Timeframes */}
      {profile && profile.timeframes.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.35)" }}>使用時間足</span>
          <div className="flex gap-1">
            {profile.timeframes.map(tf => (
              <span key={tf} className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{ background: "rgba(37,99,235,0.15)", color: "#93c5fd" }}>{tf}</span>
            ))}
          </div>
        </div>
      )}

      {/* Risk metrics */}
      {profile && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "最小RR",     value: `${profile.minimum_rr}:1` },
            { label: "最大リスク", value: `${profile.max_risk_per_trade}%` },
            { label: "最大Pos",    value: `${profile.max_positions}本` },
          ].map(m => (
            <div key={m.label} className="rounded-lg p-2 text-center"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <p className="text-[9px] mb-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>{m.label}</p>
              <p className="text-xs font-bold text-white">{m.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Public ID */}
      <div className="flex items-center justify-between pt-1"
        style={{ borderTop: `1px solid ${NG_rgba}0.08)` }}>
        <span className="text-[9px] font-mono" style={{ color: "rgba(255,255,255,0.2)" }}>
          ID: {trader.public_id}
        </span>
        <button
          onClick={() => { void navigator.clipboard.writeText(trader.public_id); toast.success("IDをコピーしました"); }}
          className="text-[9px] px-1.5 py-0.5 rounded transition-all"
          style={{ color: "rgba(249,115,22,0.6)", background: `${NG_rgba}0.05)` }}>
          コピー
        </button>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
export function AITraderCommandCenter() {
  const [traders,     setTraders]     = useState<AITrader[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [detailTrader, setDetailTrader] = useState<AITrader | null>(null);

  const loadTraders = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch("/api/traders");
      const data = await res.json() as { traders?: AITrader[]; error?: string };
      if (res.ok) setTraders(data.traders ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadTraders(); }, [loadTraders]);

  function handleDelete(id: string) {
    setTraders(prev => prev.filter(t => t.id !== id));
  }

  function handleSaved(trader: AITrader) {
    setTraders(prev => [trader, ...prev]);
    setBuilderOpen(false);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-black" style={{ color: NG }}>AIトレーダー</h1>
          <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>
            知識・性格・分析方針を持つトレーダーを管理します
          </p>
        </div>
        <button
          onClick={() => setBuilderOpen(true)}
          className="px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:opacity-90"
          style={{ background: NG }}>
          + AIトレーダーを追加
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-t-orange-400 rounded-full animate-spin mx-auto mb-3"
              style={{ borderColor: `${NG_rgba}0.2)`, borderTopColor: NG }} />
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.3)" }}>読み込み中...</p>
          </div>
        </div>
      ) : traders.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center py-16 px-8 rounded-2xl max-w-md w-full"
            style={{ border: `1px dashed ${NG_rgba}0.2)` }}>
            <div className="text-6xl mb-5">🤖</div>
            <h2 className="text-lg font-bold text-white mb-2">
              AIトレーダーがまだいません
            </h2>
            <p className="text-sm mb-6" style={{ color: "rgba(255,255,255,0.4)" }}>
              どんなトレーダーにしたいかを自然言語で説明するだけで、<br/>
              AIが性格・スタイル・リスク特性を分析・構造化します
            </p>
            <button
              onClick={() => setBuilderOpen(true)}
              className="px-8 py-3 rounded-xl text-sm font-bold text-white"
              style={{ background: NG }}>
              最初のAIトレーダーを作成
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 overflow-y-auto">
          {traders.map(t => (
            <TraderCard key={t.id} trader={t} onDelete={handleDelete} onDetail={setDetailTrader} />
          ))}
        </div>
      )}

      {/* Builder Modal */}
      <AITraderBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onSaved={handleSaved}
      />

      {/* Detail Modal */}
      <AITraderDetailModal
        trader={detailTrader}
        onClose={() => setDetailTrader(null)}
      />
    </div>
  );
}

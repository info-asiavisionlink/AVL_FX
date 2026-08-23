"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { AIEABuilder } from "./AIEABuilder";
import { StrategyDetailModal } from "./StrategyDetailModal";
import { type StrategyRecord } from "@/lib/strategySchema";

// ── Color constants ──────────────────────────────────────────────────────────
const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";
const CYAN    = "#00e5ff";
const AMBER   = "#fbbf24";
const RED     = "#ff4466";

// ── Helpers ──────────────────────────────────────────────────────────────────
function strategyLabel(s: string): string {
  switch (s) {
    case "SCALPING":  return "スキャルピング";
    case "DAY_TRADE": return "デイトレード";
    case "SWING":     return "スイング";
    case "HEDGING":   return "ヘッジング";
    default:          return s;
  }
}

function pipsColor(pips: number): string {
  return pips >= 0 ? NG : RED;
}

// ── Strategy Card（実データ）────────────────────────────────────────────────
function StrategyDraftCard({
  strategy,
  onDelete,
  onDetail,
}: {
  strategy: StrategyRecord;
  onDelete: (id: string) => void;
  onDetail: (s: StrategyRecord) => void;
}) {
  const typeColor: Record<string, string> = {
    SCALPING:  CYAN,
    DAY_TRADE: AMBER,
    SWING:     NG,
  };
  const col = typeColor[strategy.strategy_type] ?? "#64748b";

  const [btData, setBtData] = useState<{
    verdict?:        "PASSED" | "CONDITIONAL" | "FAILED";
    totalPips?:      number;
    winRate?:        number;
    profitFactor?:   number | null;
    maxDrawdownPct?: number;
  } | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  const bts = strategy.backtest_status;

  useEffect(() => {
    if (bts === "NOT_TESTED") return;
    setBtLoading(true);
    fetch(`/api/strategies/${strategy.id}/backtest`)
      .then(r => r.json())
      .then((d: { status: string; result?: Record<string, unknown> }) => {
        if (d.status === "HAS_RESULT" && d.result) {
          setBtData({
            verdict:        d.result.verdict as "PASSED" | "CONDITIONAL" | "FAILED",
            totalPips:      Number(d.result.total_pips ?? 0),
            winRate:        Number(d.result.win_rate ?? 0),
            profitFactor:   d.result.profit_factor != null ? Number(d.result.profit_factor) : null,
            maxDrawdownPct: Number(d.result.max_drawdown_pct ?? 0),
          });
        }
      })
      .catch(() => {})
      .finally(() => setBtLoading(false));
  }, [strategy.id, bts]);

  const verdictColor =
    btData?.verdict === "PASSED"      ? NG    :
    btData?.verdict === "CONDITIONAL" ? AMBER :
    btData?.verdict === "FAILED"      ? RED   : "#334155";

  return (
    <div
      className="relative flex flex-col rounded-lg overflow-hidden"
      style={{
        background: "linear-gradient(135deg, rgba(4,8,18,0.95) 0%, rgba(2,4,10,0.98) 100%)",
        border:     `1px solid ${col}30`,
        boxShadow:  `0 0 20px ${col}08`,
      }}
    >
      {/* ── ヘッダー ── */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-mono font-black text-[13px] tracking-widest" style={{ color: "#e2e8f0" }}>
              {strategy.name}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[9px] font-mono tracking-widest" style={{ color: "#4b5563" }}>
                ○ 停止中
              </span>
              {strategy.magic_number && (
                <span className="text-[8px] font-mono" style={{ color: "#334155" }}>
                  #{strategy.magic_number}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span
              className="text-[8px] font-mono font-bold tracking-widest px-2 py-0.5 rounded"
              style={{ background: `${col}08`, border: `1px solid ${col}20`, color: col }}
            >
              {strategyLabel(strategy.strategy_type)}
            </span>
            <button
              onClick={() => onDelete(strategy.id)}
              className="text-[9px] leading-none opacity-20 hover:opacity-60 transition-opacity"
              style={{ color: RED }}
              title="削除"
            >
              ×
            </button>
          </div>
        </div>

        {/* Symbol / TF */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {strategy.symbols.map(s => (
            <span key={s} className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
              style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8", border: "1px solid rgba(255,255,255,0.08)" }}>
              {s}
            </span>
          ))}
          {strategy.timeframes.map(tf => (
            <span key={tf} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "rgba(255,255,255,0.04)", color: "#64748b", border: "1px solid rgba(255,255,255,0.06)" }}>
              {tf}
            </span>
          ))}
        </div>
      </div>

      <div className="mx-4 h-px" style={{ background: "rgba(255,255,255,0.05)" }} />

      {/* ── バックテスト ── */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[9px] font-mono font-semibold tracking-[0.18em]" style={{ color: "#475569" }}>
            バックテスト
          </p>
          {btData?.verdict && (
            <span
              className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded"
              style={{ color: verdictColor, background: `${verdictColor}15`, border: `1px solid ${verdictColor}30` }}
            >
              {btData.verdict === "PASSED" ? "合格" : btData.verdict === "CONDITIONAL" ? "条件付" : "不合格"}
            </span>
          )}
          {bts === "NOT_TESTED" && (
            <span className="text-[8px] font-mono" style={{ color: "#334155" }}>未検証</span>
          )}
        </div>

        {btData ? (
          <>
            {/* 合計PIPS */}
            <div className="mb-2 px-2 py-1.5 rounded"
              style={{
                background: `${pipsColor(btData.totalPips ?? 0)}08`,
                border:     `1px solid ${pipsColor(btData.totalPips ?? 0)}20`,
              }}>
              <p className="text-[7px] font-mono tracking-widest mb-0.5" style={{ color: "#334155" }}>
                合計 PIPS
              </p>
              <p className="text-[16px] font-mono font-black leading-none"
                style={{ color: pipsColor(btData.totalPips ?? 0) }}>
                {(btData.totalPips ?? 0) >= 0 ? "+" : ""}{(btData.totalPips ?? 0).toFixed(1)}
              </p>
            </div>

            {/* 統計グリッド */}
            <div className="grid grid-cols-3 gap-1">
              {[
                { label: "勝率",
                  value: `${(btData.winRate ?? 0).toFixed(0)}%`,
                  color: (btData.winRate ?? 0) >= 55 ? NG : (btData.winRate ?? 0) >= 50 ? AMBER : RED },
                { label: "PF",
                  value: btData.profitFactor != null ? btData.profitFactor.toFixed(2) : "∞",
                  color: (btData.profitFactor ?? 0) >= 1.2 ? NG : (btData.profitFactor ?? 0) >= 1 ? AMBER : RED },
                { label: "最大DD",
                  value: `${(btData.maxDrawdownPct ?? 0).toFixed(1)}%`,
                  color: (btData.maxDrawdownPct ?? 0) < 10 ? NG : (btData.maxDrawdownPct ?? 0) < 20 ? AMBER : RED },
              ].map(({ label, value, color }) => (
                <div key={label} className="px-1.5 py-1 rounded"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
                  <p className="text-[6px] font-mono tracking-widest" style={{ color: "#334155" }}>{label}</p>
                  <p className="text-[10px] font-mono font-bold mt-0.5" style={{ color }}>{value}</p>
                </div>
              ))}
            </div>
          </>
        ) : btLoading ? (
          <div className="flex items-center gap-2 py-2">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: CYAN, animation: "avl-blink 0.6s ease-in-out infinite" }} />
            <span className="text-[9px] font-mono" style={{ color: CYAN }}>読み込み中...</span>
          </div>
        ) : (
          <p className="text-[9px] font-mono" style={{ color: "#334155" }}>バックテスト未実施</p>
        )}
      </div>

      <div className="mx-4 h-px" style={{ background: "rgba(255,255,255,0.05)" }} />

      {/* ── ライブ運用成績 ── */}
      <div className="px-4 py-3">
        <p className="text-[9px] font-mono font-semibold tracking-[0.18em] mb-2" style={{ color: "#475569" }}>
          ライブ運用成績
        </p>
        <p className="text-[8px] font-mono" style={{ color: "#334155" }}>
          まだライブ取引はありません
        </p>
      </div>

      <div className="mx-4 h-px" style={{ background: "rgba(255,255,255,0.05)" }} />

      {/* ── CTA ── */}
      <div className="px-4 pb-4 pt-3 flex flex-col gap-2">
        {/* 起動: Live Trading 未実装のため disabled */}
        <button
          disabled
          className="w-full h-8 rounded font-mono font-black text-[10px] tracking-widest cursor-not-allowed"
          style={{
            background: "rgba(255,255,255,0.03)",
            border:     "1px solid rgba(255,255,255,0.07)",
            color:      "#334155",
          }}
          title="ライブトレード: 未実装 (STAGE 5 で実装予定)"
        >
          ▶ 起動（準備中）
        </button>
        <button
          className="w-full h-8 rounded font-mono font-black text-[10px] tracking-widest transition-opacity hover:opacity-70"
          style={{
            background: `${col}08`,
            border:     `1px solid ${col}20`,
            color:      col,
          }}
          onClick={() => onDetail(strategy)}
        >
          詳細 →
        </button>
      </div>
    </div>
  );
}

// ── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 py-20 gap-6">
      {/* アイコン */}
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{ background: `${NG_rgba}0.06)`, border: `1px solid ${NG_rgba}0.20)` }}
      >
        <span className="text-2xl" style={{ color: `${NG_rgba}0.60)` }}>⊕</span>
      </div>

      {/* メッセージ */}
      <div className="text-center space-y-2">
        <p className="text-[13px] font-black tracking-[0.12em]" style={{ color: "#e2e8f0" }}>
          EAがまだ登録されていません
        </p>
        <p className="text-[10px] font-mono leading-relaxed" style={{ color: "#334155" }}>
          右上の「+ EA 追加」からトレード条件を入力し、
        </p>
        <p className="text-[10px] font-mono" style={{ color: "#334155" }}>
          バックテストを確認してEAを追加してください。
        </p>
      </div>

      {/* CTA */}
      <button
        onClick={onAdd}
        className="flex items-center gap-2 h-9 px-5 rounded font-mono font-bold text-[11px] tracking-widest transition-all duration-200"
        style={{
          background: `${NG_rgba}0.10)`,
          border:     `1px solid ${NG_rgba}0.35)`,
          color:      NG,
          boxShadow:  `0 0 16px ${NG_rgba}0.12)`,
        }}
      >
        ＋ EA 追加
      </button>
    </div>
  );
}

// ── Main EACommandCenter ─────────────────────────────────────────────────────
export function EACommandCenter() {
  const [showBuilder,    setShowBuilder]    = useState(false);
  const [strategies,     setStrategies]     = useState<StrategyRecord[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [detailStrategy, setDetailStrategy] = useState<StrategyRecord | null>(null);

  // Strategy 一覧を取得
  const fetchStrategies = useCallback(async () => {
    try {
      const res  = await fetch("/api/strategies");
      const data = await res.json() as { strategies?: StrategyRecord[] };
      if (data.strategies) setStrategies(data.strategies);
    } catch {
      toast.error("データ取得エラー");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStrategies(); }, [fetchStrategies]);

  function handleAddEA() {
    setShowBuilder(true);
  }

  function handleStrategySaved(strategy: StrategyRecord) {
    setStrategies(prev => [strategy, ...prev]);
    setShowBuilder(false);
    toast.success("EAを追加しました");
  }

  async function handleDeleteStrategy(id: string) {
    try {
      await fetch(`/api/strategies/${id}`, { method: "DELETE" });
      setStrategies(prev => prev.filter(s => s.id !== id));
      toast.success("削除しました");
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  return (
    <div className="relative flex flex-col flex-1 h-full overflow-hidden font-mono"
      style={{ background: "#04060d" }}>

      <div className="absolute inset-0 avl-grid-bg opacity-[0.03] pointer-events-none" />

      <div className="relative flex flex-col flex-1 overflow-y-auto px-5 py-5 gap-5">

        {/* ── ヘッダー ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-black tracking-[0.18em] mb-1"
              style={{ color: "#f0f9ff", textShadow: "0 0 20px rgba(240,249,255,0.3)" }}>
              EA コマンドセンター
            </h1>
            <p className="text-[10px] tracking-[0.22em]" style={{ color: "#334155" }}>
              EAの作成・検証・稼働を管理
            </p>
          </div>

          <button
            onClick={handleAddEA}
            className="flex items-center gap-2 h-8 px-3 rounded text-[10px] font-mono font-bold tracking-widest transition-all duration-200 shrink-0"
            style={{
              background: `${NG_rgba}0.08)`,
              border:     `1px solid ${NG_rgba}0.30)`,
              color:      NG,
            }}
          >
            + EA 追加
          </button>
        </div>

        {/* ── 統計バー（実データ）── */}
        <div className="flex flex-wrap gap-3">
          {[
            { label: "EA 合計",  value: loading ? "…" : strategies.length,  color: "#94a3b8" },
            { label: "稼働中",   value: 0,                                   color: NG,       note: "ライブ未実装" },
            { label: "停止中",   value: loading ? "…" : strategies.length,  color: "#475569" },
          ].map(({ label, value, color, note }) => (
            <div key={label}
              className="flex items-center gap-2 px-3 py-1.5 rounded"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <span className="text-[8px] tracking-widest" style={{ color: "#334155" }}>{label}</span>
              <span className="text-[13px] font-black" style={{ color }}>{value}</span>
              {note && (
                <span className="text-[7px] font-mono" style={{ color: "#1e3a5f" }}>({note})</span>
              )}
            </div>
          ))}
        </div>

        {/* ── コンテンツ ── */}
        {loading ? (
          <div className="flex items-center justify-center flex-1 py-20">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full" style={{ background: NG, animation: "avl-blink 0.6s ease-in-out infinite" }} />
              <span className="text-[10px] font-mono tracking-widest" style={{ color: CYAN }}>読み込み中...</span>
            </div>
          </div>
        ) : strategies.length === 0 ? (
          <EmptyState onAdd={handleAddEA} />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <p className="text-[9px] font-black tracking-[0.22em]" style={{ color: NG }}>
                マイ戦略
              </p>
              <span
                className="text-[8px] px-1.5 py-0.5 rounded"
                style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}
              >
                {strategies.length}
              </span>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {strategies.map(s => (
                <StrategyDraftCard
                  key={s.id}
                  strategy={s}
                  onDelete={handleDeleteStrategy}
                  onDetail={setDetailStrategy}
                />
              ))}
            </div>
          </div>
        )}

      </div>

      {/* ── AI EA Builder モーダル ── */}
      <AIEABuilder
        open={showBuilder}
        onClose={() => setShowBuilder(false)}
        onSaved={handleStrategySaved}
      />

      {/* ── Strategy 詳細モーダル ── */}
      {detailStrategy && (
        <StrategyDetailModal
          strategy={detailStrategy}
          onClose={() => setDetailStrategy(null)}
        />
      )}
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { EAProfile, EAStatus } from "./types";
import { MOCK_EA_PROFILES, MOCK_AI_SELECTOR_SYMBOL } from "./mockData";
import { AIEABuilder } from "./AIEABuilder";
import { type StrategyRecord } from "@/lib/strategySchema";

// ── Color constants ──────────────────────────────────────────────────────────
const NG      = "#00ff88";
const NG_rgba = "rgba(0,255,136,";
const CYAN    = "#00e5ff";
const AMBER   = "#fbbf24";
const RED     = "#ff4466";

// ── Helpers ──────────────────────────────────────────────────────────────────
function statusColor(s: EAStatus): string {
  switch (s) {
    case "RUNNING":  return NG;
    case "STARTING": return CYAN;
    case "STOPPING": return AMBER;
    case "ERROR":    return RED;
    default:         return "#4b5563";
  }
}

function statusLabel(s: EAStatus): string {
  switch (s) {
    case "RUNNING":  return "● 稼働中";
    case "STARTING": return "◌ 起動中...";
    case "STOPPING": return "◌ 停止中...";
    case "ERROR":    return "✕ エラー";
    default:         return "○ 停止";
  }
}

function recColor(r: string): string {
  if (r === "RECOMMENDED")     return NG;
  if (r === "CAUTION")         return AMBER;
  if (r === "NOT_RECOMMENDED") return RED;
  return "#4b5563";
}

function recLabel(r: string): string {
  if (r === "RECOMMENDED")     return "推奨";
  if (r === "CAUTION")         return "注意";
  if (r === "NOT_RECOMMENDED") return "非推奨";
  return r;
}

function impactColor(impact: string): string {
  if (impact === "HIGH")   return RED;
  if (impact === "MEDIUM") return AMBER;
  return "#4b5563";
}

function impactLabel(impact: string): string {
  if (impact === "HIGH")   return "高";
  if (impact === "MEDIUM") return "中";
  return "低";
}

function pipsColor(pips: number): string {
  return pips >= 0 ? NG : RED;
}

function sessionLabel(s: string): string {
  if (s === "TOKYO")    return "東京";
  if (s === "LONDON")   return "ロンドン";
  if (s === "NEW_YORK") return "NY";
  return s;
}

// ── EACard ───────────────────────────────────────────────────────────────────
function EACard({
  profile,
  statusOverride,
  onStart,
  onStop,
}: {
  profile: EAProfile;
  statusOverride: EAStatus;
  onStart: () => void;
  onStop: () => void;
}) {
  const status    = statusOverride;
  const isRunning = status === "RUNNING";
  const isBusy    = status === "STARTING" || status === "STOPPING";
  const color     = statusColor(status);
  const rec       = profile.aiRecommendation;
  const perf      = profile.performance;

  const cardBorder = isRunning
    ? `1px solid ${NG_rgba}0.40)`
    : status === "ERROR"
    ? `1px solid rgba(255,68,102,0.35)`
    : "1px solid rgba(255,255,255,0.06)";

  const cardShadow = isRunning
    ? `0 0 24px ${NG_rgba}0.10), inset 0 0 40px ${NG_rgba}0.03)`
    : "none";

  return (
    <div
      className="relative flex flex-col rounded-lg overflow-hidden"
      style={{
        background: "linear-gradient(135deg, rgba(4,8,18,0.95) 0%, rgba(2,4,10,0.98) 100%)",
        border: cardBorder,
        boxShadow: cardShadow,
      }}
    >
      {/* Running glow strip at top */}
      {isRunning && (
        <div
          className="absolute top-0 left-0 right-0 h-px"
          style={{ background: `linear-gradient(to right, transparent, ${NG}, transparent)` }}
        />
      )}

      {/* ── Card Header ── */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-mono font-black text-base tracking-widest"
              style={{ color: isRunning ? NG : "#e2e8f0", letterSpacing: "0.12em" }}>
              {profile.name}
            </h3>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[10px] font-mono font-semibold tracking-widest"
                style={{ color }}>
                {status === "RUNNING" || status === "STARTING" || status === "STOPPING" ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        background: color,
                        boxShadow: `0 0 6px ${color}`,
                        animation: status !== "RUNNING" ? "avl-blink 0.6s ease-in-out infinite" : "avl-ring-expand 2s ease-out infinite",
                      }}
                    />
                    {statusLabel(status)}
                  </span>
                ) : statusLabel(status)}
              </span>
            </div>
          </div>

          {/* Strategy badge */}
          <div className="flex flex-col items-end gap-1">
            <span
              className="text-[9px] font-mono font-bold tracking-widest px-2 py-0.5 rounded"
              style={{
                background: "rgba(0,229,255,0.08)",
                border: "1px solid rgba(0,229,255,0.20)",
                color: CYAN,
              }}
            >
              {strategyLabel(profile.strategyType)}
            </span>
          </div>
        </div>

        {/* Symbols + Timeframes */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {profile.symbols.map((s) => (
            <span key={s} className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
              style={{ background: "rgba(255,255,255,0.06)", color: "#94a3b8", border: "1px solid rgba(255,255,255,0.08)" }}>
              {s}
            </span>
          ))}
          {profile.timeframes.map((tf) => (
            <span key={tf} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "rgba(255,255,255,0.04)", color: "#64748b", border: "1px solid rgba(255,255,255,0.06)" }}>
              {tf}
            </span>
          ))}
          <span className="text-[9px] font-mono ml-auto"
            style={{ color: "#334155" }}>
            #{profile.magicNumber}
          </span>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-4 h-px" style={{ background: "rgba(255,255,255,0.05)" }} />

      {/* ── AI Recommendation ── */}
      <div className="px-4 py-3">
        <p className="text-[9px] font-mono font-semibold tracking-[0.18em] mb-2"
          style={{ color: CYAN }}>
          AI 推奨判定
        </p>
        <div className="flex items-center justify-between mb-2">
          <span
            className="text-[10px] font-mono font-black tracking-widest px-2 py-0.5 rounded"
            style={{
              color: recColor(rec.recommendation),
              background: `${recColor(rec.recommendation)}14`,
              border: `1px solid ${recColor(rec.recommendation)}40`,
            }}
          >
            {recLabel(rec.recommendation)}
          </span>
          <span className="text-[10px] font-mono font-bold"
            style={{ color: recColor(rec.recommendation) }}>
            市場適合度 {rec.marketCompatibility}%
          </span>
        </div>

        {/* Compatibility bar */}
        <div className="relative h-1 rounded-full mb-2.5"
          style={{ background: "rgba(255,255,255,0.06)" }}>
          <div
            className="absolute top-0 left-0 h-full rounded-full transition-all duration-700"
            style={{
              width: `${rec.marketCompatibility}%`,
              background: `linear-gradient(to right, ${recColor(rec.recommendation)}80, ${recColor(rec.recommendation)})`,
              boxShadow: `0 0 6px ${recColor(rec.recommendation)}60`,
            }}
          />
        </div>

        {/* Reasons */}
        <ul className="space-y-1">
          {rec.reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className="text-[9px] shrink-0 mt-px"
                style={{ color: rec.recommendation === "NOT_RECOMMENDED" && i > 0 ? RED : rec.recommendation === "RECOMMENDED" ? NG : AMBER }}>
                {rec.recommendation === "NOT_RECOMMENDED" ? "✕" : "✓"}
              </span>
              <span className="text-[9px] font-mono leading-relaxed"
                style={{ color: "#64748b" }}>
                {r}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Divider */}
      <div className="mx-4 h-px" style={{ background: "rgba(255,255,255,0.05)" }} />

      {/* ── Performance ── */}
      <div className="px-4 py-3">
        <p className="text-[9px] font-mono font-semibold tracking-[0.18em] mb-2"
          style={{ color: "#475569" }}>
          パフォーマンス
        </p>

        {/* Total Pips — prominent */}
        <div className="mb-2.5 px-3 py-2 rounded"
          style={{
            background: `${pipsColor(perf.totalPips)}08`,
            border: `1px solid ${pipsColor(perf.totalPips)}20`,
          }}>
          <p className="text-[8px] font-mono tracking-widest mb-0.5"
            style={{ color: "#475569" }}>
            トータル PIPS
          </p>
          <p className="text-xl font-mono font-black leading-none"
            style={{
              color: pipsColor(perf.totalPips),
              textShadow: `0 0 12px ${pipsColor(perf.totalPips)}60`,
            }}>
            {perf.totalPips >= 0 ? "+" : ""}{perf.totalPips.toFixed(1)}
          </p>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { label: "総取引数",   value: perf.totalTrades.toString(),                                              color: "#94a3b8" },
            { label: "勝率",       value: `${perf.winRate.toFixed(1)}%`,                                            color: perf.winRate >= 55 ? NG : perf.winRate >= 50 ? AMBER : RED },
            { label: "PF",         value: perf.profitFactor.toFixed(2),                                             color: perf.profitFactor >= 1.2 ? NG : perf.profitFactor >= 1 ? AMBER : RED },
            { label: "平均PIPS",   value: `${perf.avgPips >= 0 ? "+" : ""}${perf.avgPips.toFixed(1)}`,             color: pipsColor(perf.avgPips) },
            { label: "最大DD",     value: `${perf.maxDrawdown.toFixed(1)}%`,                                        color: perf.maxDrawdown < 10 ? NG : perf.maxDrawdown < 15 ? AMBER : RED },
          ].map(({ label, value, color }) => (
            <div key={label} className="px-2 py-1.5 rounded"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <p className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>{label}</p>
              <p className="text-[11px] font-mono font-bold mt-0.5" style={{ color }}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="mx-4 h-px" style={{ background: "rgba(255,255,255,0.05)" }} />

      {/* ── Session Performance ── */}
      <div className="px-4 py-3">
        <p className="text-[9px] font-mono font-semibold tracking-[0.18em] mb-2"
          style={{ color: "#475569" }}>
          セッション別成績
        </p>
        <div className="space-y-1.5">
          {profile.sessionPerformance.map(({ session, winRate, pips }) => (
            <div key={session} className="flex items-center gap-2">
              <span className="text-[8px] font-mono w-16 shrink-0"
                style={{ color: "#475569" }}>
                {sessionLabel(session)}
              </span>
              <div className="flex-1 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
                <div className="h-full rounded-full"
                  style={{
                    width: `${winRate}%`,
                    background: `linear-gradient(to right, ${NG_rgba}0.4), ${NG})`,
                  }} />
              </div>
              <span className="text-[9px] font-mono w-10 text-right shrink-0"
                style={{ color: NG }}>
                {winRate.toFixed(0)}%
              </span>
              <span className="text-[9px] font-mono w-14 text-right shrink-0"
                style={{ color: pipsColor(pips) }}>
                {pips >= 0 ? "+" : ""}{pips.toFixed(1)}p
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Start / Stop button ── */}
      <div className="px-4 pb-4 pt-1">
        {status === "STOPPED" || status === "ERROR" ? (
          <button
            onClick={onStart}
            className="w-full h-9 rounded font-mono font-black text-[11px] tracking-widest transition-all duration-200"
            style={{
              background: `linear-gradient(135deg, ${NG_rgba}0.18) 0%, ${NG_rgba}0.10) 100%)`,
              border: `1px solid ${NG_rgba}0.45)`,
              color: NG,
              boxShadow: `0 0 12px ${NG_rgba}0.12)`,
            }}
          >
            ▶ 起動
          </button>
        ) : status === "RUNNING" ? (
          <button
            onClick={onStop}
            className="w-full h-9 rounded font-mono font-black text-[11px] tracking-widest transition-all duration-200"
            style={{
              background: "linear-gradient(135deg, rgba(255,68,102,0.18) 0%, rgba(255,68,102,0.10) 100%)",
              border: "1px solid rgba(255,68,102,0.45)",
              color: RED,
              boxShadow: "0 0 12px rgba(255,68,102,0.12)",
            }}
          >
            ■ 停止
          </button>
        ) : (
          <button
            disabled
            className="w-full h-9 rounded font-mono font-black text-[11px] tracking-widest cursor-not-allowed"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "#334155",
            }}
          >
            {status === "STARTING" ? "◌ 起動中..." : "◌ 停止中..."}
          </button>
        )}
      </div>
    </div>
  );
}

function strategyLabel(s: string): string {
  switch (s) {
    case "SCALPING":   return "スキャルピング";
    case "DAY_TRADE":  return "デイトレード";
    case "SWING":      return "スイング";
    case "HEDGING":    return "ヘッジング";
    default:           return s;
  }
}

// ── Strategy Draft Card ────────────────────────────────────────────────────
function StrategyDraftCard({ strategy, onDelete }: { strategy: StrategyRecord; onDelete: (id: string) => void }) {
  const typeColor: Record<string, string> = {
    SCALPING:  CYAN,
    DAY_TRADE: AMBER,
    SWING:     NG,
  };
  const col = typeColor[strategy.strategy_type] ?? "#64748b";

  return (
    <div
      className="relative flex flex-col gap-3 p-4 rounded"
      style={{
        background: "rgba(8,14,26,0.9)",
        border:     `1px solid ${col}25`,
        boxShadow:  `0 0 20px ${col}08`,
      }}
    >
      {/* DRAFT バッジ */}
      <div className="absolute top-3 right-3 flex gap-1.5 items-center">
        <span
          className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded"
          style={{ background: `${AMBER}12`, border: `1px solid ${AMBER}30`, color: AMBER }}
        >
          DRAFT
        </span>
        <button
          onClick={() => onDelete(strategy.id)}
          className="text-[9px] leading-none opacity-30 hover:opacity-70 transition-opacity"
          style={{ color: RED }}
          title="削除"
        >
          ×
        </button>
      </div>

      {/* 名前 + タイプ */}
      <div>
        <p className="text-[11px] font-black tracking-wider pr-16" style={{ color: "#f0f9ff" }}>
          {strategy.name}
        </p>
        <span
          className="text-[8px] font-black tracking-widest px-1.5 py-0.5 rounded inline-block mt-1"
          style={{ background: `${col}12`, border: `1px solid ${col}25`, color: col }}
        >
          {strategy.strategy_type}
        </span>
      </div>

      {/* シンボル / TF */}
      <div className="flex flex-col gap-0.5">
        <p className="text-[8px] tracking-widest" style={{ color: "#334155" }}>SYMBOL / TF</p>
        <p className="text-[10px]" style={{ color: "#64748b" }}>
          {strategy.symbols.join(", ")} &nbsp;/&nbsp; {strategy.timeframes.join(", ")}
        </p>
      </div>

      {/* バックテスト */}
      <div className="flex flex-col gap-0.5">
        <p className="text-[8px] tracking-widest" style={{ color: "#334155" }}>BACKTEST</p>
        <p className="text-[9px] font-black tracking-widest" style={{ color: "#475569" }}>
          NOT TESTED
        </p>
      </div>

      {/* Magic Number */}
      {strategy.magic_number && (
        <div className="flex flex-col gap-0.5">
          <p className="text-[8px] tracking-widest" style={{ color: "#334155" }}>MAGIC</p>
          <p className="text-[9px]" style={{ color: "#475569" }}>
            #{strategy.magic_number}
          </p>
        </div>
      )}

      {/* 詳細ボタン（Phase 2 で詳細画面へ） */}
      <button
        className="mt-auto text-[9px] font-black tracking-widest px-3 py-1.5 rounded transition-opacity hover:opacity-70"
        style={{ background: `${col}08`, border: `1px solid ${col}20`, color: col }}
        onClick={() => toast.info("Strategy 詳細 — Phase 2 で実装予定")}
      >
        詳細
      </button>
    </div>
  );
}

// ── Main EACommandCenter ─────────────────────────────────────────────────────
export function EACommandCenter() {
  const [statuses, setStatuses] = useState<Record<string, EAStatus>>(
    () => Object.fromEntries(MOCK_EA_PROFILES.map((p) => [p.id, p.status]))
  );
  const [showBuilder, setShowBuilder] = useState(false);
  const [strategies,  setStrategies]  = useState<StrategyRecord[]>([]);

  // Strategy 一覧を取得
  const fetchStrategies = useCallback(async () => {
    try {
      const res  = await fetch("/api/strategies");
      const data = await res.json() as { strategies?: StrategyRecord[] };
      if (data.strategies) setStrategies(data.strategies);
    } catch {
      // サイレント失敗（既存UIに影響なし）
    }
  }, []);

  useEffect(() => { fetchStrategies(); }, [fetchStrategies]);

  function handleStart(id: string) {
    setStatuses((prev) => ({ ...prev, [id]: "STARTING" }));
    setTimeout(() => setStatuses((prev) => ({ ...prev, [id]: "RUNNING" })), 2000);
  }

  function handleStop(id: string) {
    setStatuses((prev) => ({ ...prev, [id]: "STOPPING" }));
    setTimeout(() => setStatuses((prev) => ({ ...prev, [id]: "STOPPED" })), 1500);
  }

  function handleAddEA() {
    setShowBuilder(true);
  }

  function handleStrategySaved(strategy: StrategyRecord) {
    setStrategies(prev => [strategy, ...prev]);
    setShowBuilder(false);
  }

  async function handleDeleteStrategy(id: string) {
    try {
      await fetch(`/api/strategies/${id}`, { method: "DELETE" });
      setStrategies(prev => prev.filter(s => s.id !== id));
      toast.success("Strategy を削除しました");
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  const totalRunning     = Object.values(statuses).filter((s) => s === "RUNNING").length;
  const totalStopped     = Object.values(statuses).filter((s) => s === "STOPPED").length;
  const totalRecommended = MOCK_EA_PROFILES.filter((p) => p.aiRecommendation.recommendation === "RECOMMENDED").length;
  const totalNotRec      = MOCK_EA_PROFILES.filter((p) => p.aiRecommendation.recommendation === "NOT_RECOMMENDED").length;

  const selectorList = [...MOCK_EA_PROFILES]
    .sort((a, b) => b.aiRecommendation.marketCompatibility - a.aiRecommendation.marketCompatibility);

  const allLossPatterns = MOCK_EA_PROFILES.flatMap((p) =>
    p.lossPatterns.map((lp) => ({ ...lp, ea: p.name }))
  ).sort((a, b) => b.lossRate - a.lossRate).slice(0, 8);

  return (
    <div className="relative flex flex-col flex-1 h-full overflow-hidden font-mono"
      style={{ background: "#04060d" }}>

      <div className="absolute inset-0 avl-grid-bg opacity-[0.03] pointer-events-none" />

      <div className="relative flex flex-col flex-1 overflow-y-auto px-5 py-5 gap-5">

        {/* ── ヘッダー ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl font-black tracking-[0.18em]"
                style={{ color: "#f0f9ff", textShadow: "0 0 20px rgba(240,249,255,0.3)" }}>
                EA コマンドセンター
              </h1>
              <span
                className="text-[9px] font-mono font-black tracking-widest px-2 py-0.5 rounded"
                style={{
                  background: "rgba(251,191,36,0.12)",
                  border: "1px solid rgba(251,191,36,0.35)",
                  color: AMBER,
                }}
              >
                モック · デモ
              </span>
            </div>
            <p className="text-[10px] tracking-[0.22em]" style={{ color: "#334155" }}>
              エキスパートアドバイザー管理
            </p>
          </div>

          <button
            onClick={handleAddEA}
            className="flex items-center gap-2 h-8 px-3 rounded text-[10px] font-mono font-bold tracking-widest transition-all duration-200 shrink-0"
            style={{
              background: `${NG_rgba}0.08)`,
              border: `1px solid ${NG_rgba}0.30)`,
              color: NG,
            }}
          >
            + EA 追加
          </button>
        </div>

        {/* ── 統計バー ── */}
        <div className="flex flex-wrap gap-3">
          {[
            { label: "EA 合計",  value: MOCK_EA_PROFILES.length, color: "#94a3b8" },
            { label: "稼働中",   value: totalRunning,             color: NG        },
            { label: "停止中",   value: totalStopped,             color: "#475569" },
            { label: "AI 推奨",  value: totalRecommended,         color: NG        },
            { label: "非推奨",   value: totalNotRec,              color: RED       },
          ].map(({ label, value, color }) => (
            <div key={label}
              className="flex items-center gap-2 px-3 py-1.5 rounded"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <span className="text-[8px] tracking-widest" style={{ color: "#334155" }}>{label}</span>
              <span className="text-[13px] font-black" style={{ color }}>{value}</span>
            </div>
          ))}
        </div>

        {/* ── AI EA Builder で登録した Strategy（DRAFT）── */}
        {strategies.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <p className="text-[9px] font-black tracking-[0.22em]" style={{ color: NG }}>
                MY STRATEGIES
              </p>
              <span
                className="text-[8px] px-1.5 py-0.5 rounded"
                style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}
              >
                {strategies.length}
              </span>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
              {strategies.map(s => (
                <StrategyDraftCard
                  key={s.id}
                  strategy={s}
                  onDelete={handleDeleteStrategy}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── EA カードグリッド（モックサンプル）── */}
        <div className="flex flex-col gap-2">
          {strategies.length > 0 && (
            <p className="text-[9px] font-black tracking-[0.22em]" style={{ color: "#334155" }}>
              SAMPLE — デモデータ
            </p>
          )}
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
            {MOCK_EA_PROFILES.map((profile) => (
              <EACard
                key={profile.id}
                profile={profile}
                statusOverride={statuses[profile.id] ?? profile.status}
                onStart={() => handleStart(profile.id)}
                onStop={() => handleStop(profile.id)}
              />
            ))}
          </div>
        </div>

        {/* ── 下部パネル ── */}
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))" }}>

          {/* AI EA セレクター */}
          <div className="rounded-lg overflow-hidden"
            style={{
              background: "linear-gradient(135deg, rgba(4,8,18,0.95) 0%, rgba(2,4,10,0.98) 100%)",
              border: "1px solid rgba(0,229,255,0.12)",
            }}>
            <div className="px-4 py-3 border-b" style={{ borderColor: "rgba(0,229,255,0.10)" }}>
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black tracking-[0.2em]" style={{ color: CYAN }}>
                  AI EA セレクター
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-[8px] tracking-widest" style={{ color: "#334155" }}>シンボル</span>
                  <span className="text-[10px] font-black tracking-widest px-2 py-0.5 rounded"
                    style={{
                      background: "rgba(0,229,255,0.08)",
                      border: "1px solid rgba(0,229,255,0.20)",
                      color: CYAN,
                    }}>
                    {MOCK_AI_SELECTOR_SYMBOL}
                  </span>
                </div>
              </div>
              <p className="text-[8px] tracking-wider mt-1" style={{ color: "#1e3a5f" }}>
                AI 市場適合スコア順にランキング
              </p>
            </div>

            <div className="p-4 space-y-2">
              {selectorList.map((ea, rank) => {
                const status = statuses[ea.id] ?? ea.status;
                const rec    = ea.aiRecommendation;
                return (
                  <div key={ea.id}
                    className="flex items-center gap-3 px-3 py-2 rounded"
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.05)",
                    }}>
                    <span className="text-[9px] font-black w-5 text-center shrink-0"
                      style={{ color: rank === 0 ? NG : "#334155" }}>
                      #{rank + 1}
                    </span>

                    <span className="text-[10px] font-bold tracking-wider flex-1 truncate"
                      style={{ color: status === "RUNNING" ? NG : "#64748b" }}>
                      {ea.name}
                    </span>

                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{
                        background: statusColor(status),
                        boxShadow: status === "RUNNING" ? `0 0 5px ${NG}` : "none",
                      }}
                    />

                    <span className="text-[8px] font-bold tracking-wider px-1.5 py-0.5 rounded shrink-0"
                      style={{
                        color: recColor(rec.recommendation),
                        background: `${recColor(rec.recommendation)}10`,
                        border: `1px solid ${recColor(rec.recommendation)}30`,
                      }}>
                      {recLabel(rec.recommendation)}
                    </span>

                    <div className="flex items-center gap-1.5 w-16 shrink-0">
                      <div className="flex-1 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="h-full rounded-full"
                          style={{
                            width: `${rec.marketCompatibility}%`,
                            background: recColor(rec.recommendation),
                          }} />
                      </div>
                      <span className="text-[9px] font-bold w-7 text-right"
                        style={{ color: recColor(rec.recommendation) }}>
                        {rec.marketCompatibility}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 損失パターン */}
          <div className="rounded-lg overflow-hidden"
            style={{
              background: "linear-gradient(135deg, rgba(4,8,18,0.95) 0%, rgba(2,4,10,0.98) 100%)",
              border: "1px solid rgba(255,68,102,0.12)",
            }}>
            <div className="px-4 py-3 border-b" style={{ borderColor: "rgba(255,68,102,0.10)" }}>
              <p className="text-[10px] font-black tracking-[0.2em]" style={{ color: RED }}>
                損失パターン · モック分析
              </p>
              <p className="text-[8px] tracking-wider mt-1" style={{ color: "#3d1a22" }}>
                全EA戦略の集計 — 損失率順
              </p>
            </div>

            <div className="p-4 space-y-2.5">
              {allLossPatterns.map(({ name, lossRate, impact, ea }, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[9px] font-bold tracking-wider truncate"
                        style={{ color: "#94a3b8" }}>
                        {name}
                      </span>
                      <span className="text-[7px] font-mono shrink-0"
                        style={{ color: "#334155" }}>
                        [{ea}]
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span
                        className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded"
                        style={{
                          color: impactColor(impact),
                          background: `${impactColor(impact)}10`,
                          border: `1px solid ${impactColor(impact)}30`,
                        }}>
                        {impactLabel(impact)}
                      </span>
                      <span className="text-[10px] font-black w-8 text-right"
                        style={{ color: RED }}>
                        {lossRate}%
                      </span>
                    </div>
                  </div>

                  <div className="h-1 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(lossRate / 45) * 100}%`,
                        background: `linear-gradient(to right, rgba(255,68,102,0.4), ${RED})`,
                        boxShadow: lossRate > 30 ? `0 0 6px ${RED}50` : "none",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* ── AI EA Builder モーダル ── */}
      <AIEABuilder
        open={showBuilder}
        onClose={() => setShowBuilder(false)}
        onSaved={handleStrategySaved}
      />
    </div>
  );
}

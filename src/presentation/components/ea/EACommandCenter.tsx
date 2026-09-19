"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { AIEABuilder } from "./AIEABuilder";
import { StrategyDetailModal } from "./StrategyDetailModal";
import { type StrategyRecord } from "@/lib/strategySchema";
import { useUserMT5Connection } from "@/presentation/hooks/useUserMT5Connection";

type RuntimeStatus = "STOPPED" | "STARTING" | "RUNNING" | "PAUSED" | "ERROR";

// ── Color constants ──────────────────────────────────────────────────────────
const NG      = "#f97316";
const NG_rgba = "rgba(249,115,22,";
const CYAN    = "#2563eb";
const AMBER   = "#d97706";
const RED     = "#dc2626";

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
  onBtLoad,
}: {
  strategy: StrategyRecord;
  onDelete: (id: string) => void;
  onDetail: (s: StrategyRecord) => void;
  onBtLoad?: (id: string, stat: BtStat) => void;
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
  const [btLoading,      setBtLoading]      = useState(false);
  const [runtimeStatus,  setRuntimeStatus]  = useState<RuntimeStatus>("STOPPED");
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const { status: mt5 } = useUserMT5Connection(15_000);
  const bts = strategy.backtest_status;

  // Runtime状態を取得
  useEffect(() => {
    fetch(`/api/live/strategies/${strategy.id}/runtime`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { runtime?: { runtime_status?: string } } | null) => {
        if (d?.runtime?.runtime_status) {
          setRuntimeStatus(d.runtime.runtime_status as RuntimeStatus);
        }
      })
      .catch(() => {});
  }, [strategy.id]);

  const handleStart = async () => {
    if (!mt5.online) { toast.error("MT5を接続してください"); return; }
    setRuntimeLoading(true);
    try {
      const res = await fetch(`/api/live/strategies/${strategy.id}/runtime`, { method: "POST" });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (res.ok) {
        setRuntimeStatus("RUNNING");
        toast.success("EA起動しました");
      } else {
        toast.error(data.error ?? "起動失敗");
      }
    } catch { toast.error("エラーが発生しました"); }
    finally { setRuntimeLoading(false); }
  };

  const handleStop = async () => {
    setRuntimeLoading(true);
    try {
      const res = await fetch(`/api/live/strategies/${strategy.id}/runtime`, { method: "DELETE" });
      if (res.ok) {
        setRuntimeStatus("STOPPED");
        toast.success("EA停止しました");
      }
    } catch { toast.error("エラーが発生しました"); }
    finally { setRuntimeLoading(false); }
  };

  useEffect(() => {
    if (bts === "NOT_TESTED") return;
    setBtLoading(true);
    fetch(`/api/strategies/${strategy.id}/backtest`)
      .then(r => r.json())
      .then((d: { status: string; result?: Record<string, unknown> }) => {
        if (d.status === "HAS_RESULT" && d.result) {
          const wr  = Number(d.result.win_rate ?? 0);
          const pips = Number(d.result.total_pips ?? 0);
          const pf  = d.result.profit_factor != null ? Number(d.result.profit_factor) : null;
          const mdd = Number(d.result.max_drawdown_pct ?? 0);
          // ペイオフレシオ = PF × (1-WR) / WR
          const payoff = (pf != null && wr > 0 && wr < 100)
            ? pf * (1 - wr / 100) / (wr / 100)
            : null;
          setBtData({
            verdict:        d.result.verdict as "PASSED" | "CONDITIONAL" | "FAILED",
            totalPips:      pips,
            winRate:        wr,
            profitFactor:   pf,
            maxDrawdownPct: mdd,
          });
          // 親に btStats を報告
          onBtLoad?.(strategy.id, { winRate: wr, pips, pf, mdd, payoff });
        }
      })
      .catch(() => {})
      .finally(() => setBtLoading(false));
  }, [strategy.id, bts, onBtLoad]);

  const verdictColor =
    btData?.verdict === "PASSED"      ? NG    :
    btData?.verdict === "CONDITIONAL" ? AMBER :
    btData?.verdict === "FAILED"      ? RED   : "#9a9a9a";

  return (
    <div
      className="relative flex flex-col rounded-lg overflow-hidden"
      style={{
        background: "#fff",
        border:     `1px solid ${col}30`,
        boxShadow:  "0 2px 8px rgba(0,0,0,0.06)",
      }}
    >
      {/* ── ヘッダー ── */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-mono font-black text-[13px] tracking-widest" style={{ color: "#1a1a1a" }}>
              {strategy.name}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[9px] font-mono tracking-widest" style={{
                color: runtimeStatus === "RUNNING" ? NG : runtimeStatus === "ERROR" ? RED : "#4b5563"
              }}>
                {runtimeStatus === "RUNNING" ? "● 稼働中" : runtimeStatus === "ERROR" ? "⚠ エラー" : "○ 停止中"}
              </span>
              {strategy.magic_number && (
                <span className="text-[8px] font-mono" style={{ color: "#9a9a9a" }}>
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
              style={{ background: "rgba(0,0,0,0.04)", color: "#9a9a9a", border: "1px solid rgba(0,0,0,0.08)" }}>
              {s}
            </span>
          ))}
          {strategy.timeframes.map(tf => (
            <span key={tf} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "rgba(0,0,0,0.03)", color: "#64748b", border: "1px solid rgba(0,0,0,0.04)" }}>
              {tf}
            </span>
          ))}
        </div>
      </div>

      <div className="mx-4 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />

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
            <span className="text-[8px] font-mono" style={{ color: "#9a9a9a" }}>未検証</span>
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
              <p className="text-[7px] font-mono tracking-widest mb-0.5" style={{ color: "#9a9a9a" }}>
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
                  style={{ background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.06)" }}>
                  <p className="text-[6px] font-mono tracking-widest" style={{ color: "#9a9a9a" }}>{label}</p>
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
          <p className="text-[9px] font-mono" style={{ color: "#9a9a9a" }}>バックテスト未実施</p>
        )}
      </div>

      <div className="mx-4 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />

      {/* ── ライブ運用成績 ── */}
      <div className="px-4 py-3">
        <p className="text-[9px] font-mono font-semibold tracking-[0.18em] mb-2" style={{ color: "#475569" }}>
          ライブ運用成績
        </p>
        <p className="text-[8px] font-mono" style={{ color: "#9a9a9a" }}>
          まだライブ取引はありません
        </p>
      </div>

      <div className="mx-4 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />

      {/* ── 識別番号 ── */}
      {strategy.share_code && (
        <div className="px-4 py-2">
          <p className="text-[8px] font-mono tracking-widest mb-1" style={{ color: "#9a9a9a" }}>識別番号</p>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-black tracking-widest px-2 py-1 rounded flex-1 text-center"
              style={{ background: "rgba(249,115,22,0.06)", color: "#f97316", border: "1px solid rgba(249,115,22,0.18)", letterSpacing: "0.12em" }}>
              {strategy.share_code}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(strategy.share_code!);
                toast.success("識別番号をコピーしました");
              }}
              className="px-2 py-1 rounded text-[8px] font-bold transition-opacity hover:opacity-70 shrink-0"
              style={{ background: "rgba(249,115,22,0.10)", border: "1px solid rgba(249,115,22,0.25)", color: NG }}
              title="コピー"
            >
              コピー
            </button>
          </div>
        </div>
      )}

      <div className="mx-4 h-px" style={{ background: "rgba(0,0,0,0.06)" }} />

      {/* ── CTA ── */}
      <div className="px-4 pb-4 pt-3 flex flex-col gap-2">
        {runtimeStatus === "RUNNING" ? (
          <button
            onClick={handleStop}
            disabled={runtimeLoading}
            className="w-full h-8 rounded font-mono font-black text-[10px] tracking-widest transition-opacity hover:opacity-70"
            style={{ background: "rgba(255,68,102,0.12)", border: "1px solid rgba(255,68,102,0.3)", color: RED, opacity: runtimeLoading ? 0.5 : 1 }}
          >
            {runtimeLoading ? "停止中..." : "■ 停止"}
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={runtimeLoading || !mt5.online}
            className="w-full h-8 rounded font-mono font-black text-[10px] tracking-widest transition-opacity hover:opacity-70"
            style={{
              background: mt5.online ? "rgba(249,115,22,0.10)" : "rgba(0,0,0,0.02)",
              border:     mt5.online ? "1px solid rgba(249,115,22,0.30)" : "1px solid rgba(0,0,0,0.06)",
              color:      mt5.online ? NG : "#9a9a9a",
              opacity:    runtimeLoading ? 0.5 : 1,
              cursor:     mt5.online ? "pointer" : "not-allowed",
            }}
            title={mt5.online ? "EA起動" : "MT5を接続してください"}
          >
            {runtimeLoading ? "起動中..." : mt5.online ? "▶ 起動" : "▶ 起動（MT5未接続）"}
          </button>
        )}
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
        <p className="text-[13px] font-black tracking-[0.12em]" style={{ color: "#1a1a1a" }}>
          GOLD EA がまだ登録されていません
        </p>
        <p className="text-[10px] font-mono leading-relaxed" style={{ color: "#9a9a9a" }}>
          右上の「+ EA 追加」から GOLD のトレード条件を入力し、
        </p>
        <p className="text-[10px] font-mono" style={{ color: "#9a9a9a" }}>
          バックテストを確認して EA を追加してください。
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
// ── BtStats (親コンポーネントで一元管理) ──────────────────────────────────
interface BtStat {
  winRate: number;
  pips:    number;
  pf:      number | null;
  mdd:     number;       // maxDrawdownPct
  payoff:  number | null; // ペイオフレシオ
}

// ── FilterBar ─────────────────────────────────────────────────────────────────
interface Filters {
  search:     string;
  symbols:    string[];
  indicators: string[];
  direction:  "" | "BUY" | "SELL";
  stratType:  "" | "SCALPING" | "DAY_TRADE" | "SWING";
  minWR:      number;    // 0=無制限
  minPips:    number;    // 0=無制限
  minPF:      number;    // 0=無制限
  maxMDD:     number;    // 0=無制限
  minPayoff:  number;    // 0=無制限
}

const EMPTY_FILTERS: Filters = {
  search: "", symbols: [], indicators: [], direction: "", stratType: "",
  minWR: 0, minPips: 0, minPF: 0, maxMDD: 0, minPayoff: 0,
};

const INDICATOR_TAGS = ["ICHIMOKU", "EMA", "MACD", "RSI", "ADX", "AO", "BB", "ATR", "PSAR", "STOCH"];
const WR_OPTIONS     = [0, 40, 45, 50, 55, 60];
const PIPS_OPTIONS   = [0, 100, 500, 1000];
const PF_OPTIONS     = [0, 1.0, 1.2, 1.5, 2.0];
const MDD_OPTIONS    = [0, 10, 15, 20, 30];
const PAYOFF_OPTIONS = [0, 1.0, 1.2, 1.5, 2.0];

function FilterBar({
  strategies,
  btStats,
  filters,
  setFilters,
  filtered,
}: {
  strategies: StrategyRecord[];
  btStats:    Record<string, BtStat>;
  filters:    Filters;
  setFilters: (f: Filters) => void;
  filtered:   number;
}) {
  const allSymbols = [...new Set(strategies.flatMap(s => s.symbols as string[]))].sort();
  const hasFilters = filters.search || filters.symbols.length || filters.indicators.length
    || filters.direction || filters.stratType || filters.minWR || filters.minPips
    || filters.minPF || filters.maxMDD || filters.minPayoff;

  function toggleArr<T>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];
  }

  const Chip = ({ label, active, onClick, color = CYAN }: { label: string; active: boolean; onClick: () => void; color?: string }) => (
    <button onClick={onClick}
      className="px-2 py-1 rounded text-[8px] font-mono font-bold tracking-widest transition-all whitespace-nowrap"
      style={{
        background: active ? `${color}18` : "rgba(0,0,0,0.02)",
        border:     `1px solid ${active ? `${color}50` : "rgba(0,0,0,0.08)"}`,
        color:      active ? color : "#475569",
      }}>
      {label}
    </button>
  );

  return (
    <div className="space-y-2 p-3 rounded-lg" style={{ background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.04)" }}>
      {/* 検索バー + リセット */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px]" style={{ color: "#9a9a9a" }}>🔍</span>
          <input
            type="text"
            placeholder="EA名で検索..."
            value={filters.search}
            onChange={e => setFilters({ ...filters, search: e.target.value })}
            className="w-full pl-7 pr-3 py-1.5 rounded text-[9px] font-mono outline-none"
            style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.08)", color: "#1a1a1a" }}
          />
        </div>
        <span className="text-[8px] font-mono shrink-0" style={{ color: "#9a9a9a" }}>
          {filtered}/{strategies.length}件
        </span>
        {hasFilters && (
          <button onClick={() => setFilters(EMPTY_FILTERS)}
            className="px-2 py-1.5 rounded text-[8px] font-mono transition-all shrink-0"
            style={{ background: `${RED}12`, border: `1px solid ${RED}30`, color: RED }}>
            クリア
          </button>
        )}
      </div>

      {/* シンボルフィルター */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-[7px] font-mono tracking-widest shrink-0" style={{ color: "#9a9a9a" }}>シンボル</span>
        {allSymbols.map(sym => (
          <Chip key={sym} label={sym} active={filters.symbols.includes(sym)}
            onClick={() => setFilters({ ...filters, symbols: toggleArr(filters.symbols, sym) })} />
        ))}
      </div>

      {/* インジケーターフィルター */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-[7px] font-mono tracking-widest shrink-0" style={{ color: "#9a9a9a" }}>インジケーター</span>
        {INDICATOR_TAGS.map(ind => (
          <Chip key={ind} label={ind} active={filters.indicators.includes(ind)} color={NG}
            onClick={() => setFilters({ ...filters, indicators: toggleArr(filters.indicators, ind) })} />
        ))}
      </div>

      {/* 方向・種別 */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-[7px] font-mono tracking-widest shrink-0" style={{ color: "#9a9a9a" }}>方向</span>
        {(["BUY", "SELL"] as const).map(d => (
          <Chip key={d} label={d} color={d === "BUY" ? NG : RED}
            active={filters.direction === d}
            onClick={() => setFilters({ ...filters, direction: filters.direction === d ? "" : d })} />
        ))}
        <span className="text-[7px] font-mono tracking-widest ml-2 shrink-0" style={{ color: "#9a9a9a" }}>種別</span>
        {(["DAY_TRADE", "SWING", "SCALPING"] as const).map(t => (
          <Chip key={t} label={{ DAY_TRADE: "デイ", SWING: "スイング", SCALPING: "スキャル" }[t]}
            color={AMBER} active={filters.stratType === t}
            onClick={() => setFilters({ ...filters, stratType: filters.stratType === t ? "" : t })} />
        ))}
      </div>

      {/* 勝率・PIPS・PF・MDD・ペイオフ */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-[7px] font-mono tracking-widest shrink-0" style={{ color: "#9a9a9a" }}>勝率≥</span>
        {WR_OPTIONS.filter(v => v > 0).map(v => (
          <Chip key={v} label={`${v}%`} color={CYAN}
            active={filters.minWR === v}
            onClick={() => setFilters({ ...filters, minWR: filters.minWR === v ? 0 : v })} />
        ))}
        <span className="text-[7px] font-mono tracking-widest ml-2 shrink-0" style={{ color: "#9a9a9a" }}>PIPS≥</span>
        {PIPS_OPTIONS.filter(v => v > 0).map(v => (
          <Chip key={v} label={`+${v}`} color={NG}
            active={filters.minPips === v}
            onClick={() => setFilters({ ...filters, minPips: filters.minPips === v ? 0 : v })} />
        ))}
      </div>

      {/* PF・MDD・ペイオフレシオ */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-[7px] font-mono tracking-widest shrink-0" style={{ color: "#9a9a9a" }}>PF≥</span>
        {PF_OPTIONS.filter(v => v > 0).map(v => (
          <Chip key={v} label={String(v)} color={NG}
            active={filters.minPF === v}
            onClick={() => setFilters({ ...filters, minPF: filters.minPF === v ? 0 : v })} />
        ))}
        <span className="text-[7px] font-mono tracking-widest ml-2 shrink-0" style={{ color: "#9a9a9a" }}>MDD≤</span>
        {MDD_OPTIONS.filter(v => v > 0).map(v => (
          <Chip key={v} label={`${v}%`} color={AMBER}
            active={filters.maxMDD === v}
            onClick={() => setFilters({ ...filters, maxMDD: filters.maxMDD === v ? 0 : v })} />
        ))}
        <span className="text-[7px] font-mono tracking-widest ml-2 shrink-0" style={{ color: "#9a9a9a" }}>ペイオフ≥</span>
        {PAYOFF_OPTIONS.filter(v => v > 0).map(v => (
          <Chip key={v} label={String(v)} color={CYAN}
            active={filters.minPayoff === v}
            onClick={() => setFilters({ ...filters, minPayoff: filters.minPayoff === v ? 0 : v })} />
        ))}
      </div>
    </div>
  );
}

export function EACommandCenter() {
  const [showBuilder,    setShowBuilder]    = useState(false);
  const [strategies,     setStrategies]     = useState<StrategyRecord[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [detailStrategy, setDetailStrategy] = useState<StrategyRecord | null>(null);
  const [btStats,        setBtStats]        = useState<Record<string, BtStat>>({});
  const [filters,        setFilters]        = useState<Filters>(EMPTY_FILTERS);
  const [importCode,     setImportCode]     = useState("");
  const [importing,      setImporting]      = useState(false);

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

  async function handleImportByCode() {
    const code = importCode.trim();
    if (!/^\d{16}$/.test(code)) {
      toast.error("16桁の数字を入力してください");
      return;
    }
    setImporting(true);
    try {
      const res  = await fetch("/api/strategies/import-by-code", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code }),
      });
      const data = await res.json() as { strategy?: StrategyRecord; error?: string };
      if (!res.ok || !data.strategy) {
        toast.error(data.error ?? "インポートに失敗しました");
        return;
      }
      setStrategies(prev => [data.strategy!, ...prev]);
      setImportCode("");
      toast.success(`「${data.strategy.name}」をインポートしました`);
    } catch {
      toast.error("ネットワークエラーが発生しました");
    } finally {
      setImporting(false);
    }
  }

  const handleBtLoad = useCallback((id: string, stat: BtStat) => {
    setBtStats(prev => ({ ...prev, [id]: stat }));
  }, []);

  // ── フィルタリングロジック ────────────────────────────────────────
  const filteredStrategies = strategies.filter(s => {
    const { search, symbols, indicators, direction, stratType, minWR, minPips, minPF, maxMDD, minPayoff } = filters;

    // テキスト検索
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;

    // シンボル
    if (symbols.length > 0 && !symbols.some(sym => (s.symbols as string[]).includes(sym))) return false;

    // 種別
    if (stratType && s.strategy_type !== stratType) return false;

    // 方向（名前の末尾から判定）
    if (direction) {
      const nameUpper = s.name.toUpperCase();
      if (direction === "BUY"  && !nameUpper.endsWith("BUY"))  return false;
      if (direction === "SELL" && !nameUpper.endsWith("SELL")) return false;
    }

    // インジケーター
    if (indicators.length > 0) {
      const conds = ((s.entry_conditions as Record<string,unknown>)?.conditions as Record<string,unknown>[] | undefined) ?? [];
      const indNames = conds.map(c => String(c.indicator ?? "").toUpperCase());
      // インジケーター名またはEA名に含まれるか
      const passInd = indicators.some(ind =>
        indNames.some(n => n.includes(ind)) || s.name.toUpperCase().includes(ind)
      );
      if (!passInd) return false;
    }

    // btStats ベースフィルター
    const stat = btStats[s.id];
    if (minWR > 0    && stat && stat.winRate < minWR)                   return false;
    if (minPips > 0  && stat && stat.pips < minPips)                    return false;
    if (minPF > 0    && stat && (stat.pf ?? 0) < minPF)                 return false;
    if (maxMDD > 0   && stat && stat.mdd > maxMDD)                      return false;
    if (minPayoff > 0 && stat && (stat.payoff ?? 0) < minPayoff)        return false;

    return true;
  });

  return (
    <div className="relative flex flex-col flex-1 h-full overflow-hidden font-mono"
      style={{ background: "#f8f7f4" }}>

      <div className="absolute inset-0 avl-grid-bg opacity-[0.03] pointer-events-none" />

      <div className="relative flex flex-col flex-1 overflow-y-auto px-5 py-5 gap-5">

        {/* ── ヘッダー ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-black tracking-[0.18em] mb-1"
              style={{ color: "#f0f9ff", textShadow: "0 0 20px rgba(240,249,255,0.3)" }}>
              GOLD EA センター
            </h1>
            <p className="text-[10px] tracking-[0.22em]" style={{ color: "#9a9a9a" }}>
              GOLD#（XAU）専用 EA の作成・検証・稼働管理
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* 識別番号でインポート */}
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={importCode}
                onChange={e => setImportCode(e.target.value.replace(/\D/g, "").slice(0, 16))}
                placeholder="識別番号 16桁"
                maxLength={16}
                className="h-8 px-2 rounded font-mono text-[10px] tracking-widest outline-none"
                style={{
                  width: "130px",
                  background: "rgba(0,0,0,0.03)",
                  border: "1px solid rgba(0,0,0,0.10)",
                  color: "#1a1a1a",
                }}
                onKeyDown={e => e.key === "Enter" && handleImportByCode()}
              />
              <button
                onClick={handleImportByCode}
                disabled={importing || importCode.length !== 16}
                className="h-8 px-2 rounded text-[10px] font-mono font-bold tracking-widest transition-all duration-200"
                style={{
                  background: importCode.length === 16 ? "rgba(37,99,235,0.08)" : "rgba(0,0,0,0.03)",
                  border:     importCode.length === 16 ? "1px solid rgba(37,99,235,0.25)" : "1px solid rgba(0,0,0,0.08)",
                  color:      importCode.length === 16 ? CYAN : "#9a9a9a",
                  opacity:    importing ? 0.5 : 1,
                  cursor:     importCode.length === 16 && !importing ? "pointer" : "not-allowed",
                }}
              >
                {importing ? "取得中..." : "追加"}
              </button>
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
        </div>

        {/* ── 統計バー（実データ）── */}
        <div className="flex flex-wrap gap-3">
          {[
            { label: "EA 合計",  value: loading ? "…" : strategies.length,  color: "#9a9a9a" },
            { label: "稼働中",   value: 0,                                   color: NG,       note: "ライブ未実装" },
            { label: "停止中",   value: loading ? "…" : strategies.length,  color: "#475569" },
          ].map(({ label, value, color, note }) => (
            <div key={label}
              className="flex items-center gap-2 px-3 py-1.5 rounded"
              style={{ background: "rgba(0,0,0,0.02)", border: "1px solid rgba(0,0,0,0.04)" }}>
              <span className="text-[8px] tracking-widest" style={{ color: "#9a9a9a" }}>{label}</span>
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
          <div className="flex flex-col gap-3">
            {/* ── フィルターバー ── */}
            <FilterBar
              strategies={strategies}
              btStats={btStats}
              filters={filters}
              setFilters={setFilters}
              filtered={filteredStrategies.length}
            />

            <div className="flex items-center gap-2">
              <p className="text-[9px] font-black tracking-[0.22em]" style={{ color: NG }}>
                マイ戦略
              </p>
              <span
                className="text-[8px] px-1.5 py-0.5 rounded"
                style={{ background: `${NG_rgba}0.08)`, border: `1px solid ${NG_rgba}0.20)`, color: NG }}
              >
                {filteredStrategies.length}
                {filteredStrategies.length !== strategies.length && (
                  <span style={{ color: "#475569" }}>/{strategies.length}</span>
                )}
              </span>
            </div>

            {filteredStrategies.length === 0 ? (
              <div className="flex items-center justify-center py-16">
                <div className="text-center space-y-2">
                  <p className="text-[10px] font-mono" style={{ color: "#475569" }}>
                    条件に一致するEAが見つかりません
                  </p>
                  <button
                    onClick={() => setFilters(EMPTY_FILTERS)}
                    className="text-[9px] font-mono px-3 py-1.5 rounded"
                    style={{ background: "rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.08)", color: "#64748b" }}
                  >
                    フィルターをクリア
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                {filteredStrategies.map(s => (
                  <StrategyDraftCard
                    key={s.id}
                    strategy={s}
                    onDelete={handleDeleteStrategy}
                    onDetail={setDetailStrategy}
                    onBtLoad={handleBtLoad}
                  />
                ))}
              </div>
            )}
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

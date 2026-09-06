"use client";

// =================================================================
// StrategyDetailModal.tsx — Strategy 詳細画面 (Phase 2-E)
//
// Tabs: OVERVIEW | BACKTEST | TRADES
// Backtest: POST /api/backtest/run → result display
// Equity Curve: lightweight-charts line series
// =================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createChart, ColorType, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { type StrategyRecord } from "@/lib/strategySchema";
import {
  TAB_LABELS, VERDICT_LABELS, BACKTEST_STATUS_LABELS,
  STRATEGY_TYPE_LABELS, DIRECTION_LABELS, TRADE_RESULT_LABELS,
  EXIT_REASON_LABELS, SESSION_LABELS, WF_VERDICT_LABELS,
  PHASE_LABELS, labelOf,
} from "@/lib/ui-labels";

// ------------------------------------------------------------------
// Colors (aligned with EACommandCenter)
// ------------------------------------------------------------------
const NG    = "#00ff88";
const NG_r  = "rgba(0,255,136,";
const CYAN  = "#00e5ff";
const AMBER = "#fbbf24";
const RED   = "#ff4466";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface SessionStat {
  tradeCount:   number;
  wins:         number;
  losses:       number;
  winRate:      number;
  totalPips:    number;
  profitFactor: number | null;
}

interface DisplayResult {
  totalTrades:      number;
  wins:             number;
  losses:           number;
  winRate:          number;
  totalPips:        number;
  avgPips:          number;
  profitFactor:     number | null;
  maxDrawdown:      number;
  maxDrawdownPct:   number;
  maxDrawdownPips:  number;
  maxConsWins:      number;
  maxConsLosses:    number;
  avgDuration:      number;
  sessionStats:     Record<string, SessionStat>;
  bestSession:      string | null;
  worstSession:     string | null;
  verdict:          "PASSED" | "CONDITIONAL" | "FAILED";
  verdictReason:    string;
  sampleSizeWarning: boolean;
  dataCoverageDays: number;
  barCount:         number;
  periodLabel:      string;
  jobId:            string;
}

interface DBTrade {
  id:           string;
  entry_time:   string;
  exit_time:    string;
  direction:    "BUY" | "SELL";
  entry_price:  number;
  exit_price:   number;
  pips:         number;
  result:       "WIN" | "LOSS" | "BREAKEVEN" | "END_OF_DATA";
  exit_reason:  "TP" | "SL" | "END_OF_DATA";
  session:      string;
  spread_pips:  number;
  slippage_pips: number;
}

// ------------------------------------------------------------------
// Normalise API response (handles camelCase and snake_case)
// ------------------------------------------------------------------

function normaliseResult(d: Record<string, unknown>, jobId: string): DisplayResult {
  const n = (k1: string, k2: string) => Number(d[k1] ?? d[k2] ?? 0);
  const pf = (k1: string, k2: string): number | null => {
    const v = d[k1] ?? d[k2];
    return v === null || v === undefined ? null : v === null ? null : Number(v);
  };
  return {
    totalTrades:      n("totalTrades",      "total_trades"),
    wins:             Number(d.wins ?? 0),
    losses:           Number(d.losses ?? 0),
    winRate:          n("winRate",          "win_rate"),
    totalPips:        n("totalPips",        "total_pips"),
    avgPips:          n("avgPips",          "avg_pips"),
    profitFactor:     pf("profitFactor",    "profit_factor"),
    maxDrawdown:      n("maxDrawdown",      "max_drawdown"),
    maxDrawdownPct:   n("maxDrawdownPct",   "max_drawdown_pct"),
    maxDrawdownPips:  n("maxDrawdownPips",  "max_drawdown_pips"),
    maxConsWins:      n("maxConsecutiveWins",  "max_cons_wins"),
    maxConsLosses:    n("maxConsecutiveLosses","max_cons_losses"),
    avgDuration:      n("avgDurationMin",   "avg_duration_min"),
    sessionStats:     (d.sessionStats ?? d.session_stats ?? {}) as Record<string, SessionStat>,
    bestSession:      (d.bestSession ?? d.best_session ?? null) as string | null,
    worstSession:     (d.worstSession ?? d.worst_session ?? null) as string | null,
    verdict:          (d.verdict ?? "FAILED") as "PASSED" | "CONDITIONAL" | "FAILED",
    verdictReason:    String(d.verdictReason ?? d.verdict_reason ?? ""),
    sampleSizeWarning: Boolean(d.sampleSizeWarning ?? d.sample_size_warning ?? false),
    dataCoverageDays: n("dataCoverageDays", "data_coverage_days"),
    barCount:         n("barCount",         "bar_count_used"),
    periodLabel:      String(d.periodLabel ?? d.period_label ?? "AVAILABLE"),
    jobId,
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function verdictColor(v: "PASSED" | "CONDITIONAL" | "FAILED"): string {
  if (v === "PASSED")      return NG;
  if (v === "CONDITIONAL") return AMBER;
  return RED;
}

function pipsColor(p: number) { return p >= 0 ? NG : RED; }

function pfDisplay(pf: number | null): string {
  if (pf === null) return "∞";
  return pf.toFixed(2);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
}

// ------------------------------------------------------------------
// OverviewTab
// ------------------------------------------------------------------

function OverviewTab({ strategy }: { strategy: StrategyRecord }) {
  const ec  = strategy.entry_conditions as Record<string, unknown>;
  const conds = (ec?.conditions as unknown[]) ?? [];
  const filters = (strategy.filters as Record<string, unknown>) ?? {};
  const exit    = (strategy.exit_conditions as Record<string, unknown>) ?? {};
  const tf      = (filters.trend_filter as Record<string, unknown>) ?? null;

  const Row = ({ label, value, color }: { label: string; value: string; color?: string }) => (
    <div className="flex items-start gap-3 py-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <span className="text-[8px] font-mono tracking-widest w-28 shrink-0 mt-0.5" style={{ color: "#334155" }}>
        {label}
      </span>
      <span className="text-[10px] font-mono" style={{ color: color ?? "#94a3b8" }}>
        {value}
      </span>
    </div>
  );

  return (
    <div className="p-5 space-y-5 overflow-y-auto">
      {/* Basic info */}
      <section>
        <p className="text-[8px] font-black tracking-[0.25em] mb-2" style={{ color: CYAN }}>基本情報</p>
        <div className="px-3 py-1 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <Row label="シンボル"    value={strategy.symbols.join(", ")} />
          <Row label="時間足"     value={strategy.timeframes.join(", ")} />
          <Row label="種別"       value={labelOf(STRATEGY_TYPE_LABELS, strategy.strategy_type)} color={CYAN} />
          <Row label="リスク %"   value={`${(strategy.risk as Record<string,number>)?.risk_per_trade ?? 1}%`} />
        </div>
      </section>

      {/* Entry conditions */}
      <section>
        <p className="text-[8px] font-black tracking-[0.25em] mb-2" style={{ color: NG }}>
          エントリー条件 <span className="opacity-50 font-normal">— {String(ec?.logic ?? "AND")}</span>
        </p>
        <div className="space-y-1.5">
          {(conds as Record<string, unknown>[]).map((c, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 rounded"
              style={{ background: `${NG_r}0.04)`, border: `1px solid ${NG_r}0.10)` }}>
              <span className="text-[9px] font-mono font-bold w-28 shrink-0" style={{ color: NG }}>
                {String(c.indicator)} ({String(c.timeframe)})
              </span>
              <span className="text-[9px] font-mono" style={{ color: "#64748b" }}>
                {String(c.operator ?? "")}
                {c.threshold !== undefined ? ` ${c.threshold}` : ""}
                {c.period !== undefined ? ` (${c.period})` : ""}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Filters */}
      {Object.keys(filters).length > 0 && (
        <section>
          <p className="text-[8px] font-black tracking-[0.25em] mb-2" style={{ color: AMBER }}>フィルター</p>
          <div className="px-3 py-1 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
            {filters.max_spread_pips !== undefined && (
              <Row label="最大スプレッド" value={`${filters.max_spread_pips} pips`} />
            )}
            {filters.sessions !== undefined && (
              <Row label="セッション" value={(filters.sessions as string[]).map(s => labelOf(SESSION_LABELS, s)).join(", ")} />
            )}
            {tf && (
              <Row label="トレンドフィルター"
                value={`${String(tf.timeframe)} ${String(tf.indicator)} ${tf.period ? `(${tf.period})` : ""} ${String(tf.direction)}`}
                color={AMBER} />
            )}
            {filters.min_adx !== undefined && (
              <Row label="最小ADX" value={String(filters.min_adx)} />
            )}
          </div>
        </section>
      )}

      {/* Exit conditions */}
      {exit && Object.keys(exit).length > 0 && (
        <section>
          <p className="text-[8px] font-black tracking-[0.25em] mb-2" style={{ color: "#64748b" }}>決済条件</p>
          <div className="px-3 py-1 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
            {exit.stop_loss ? (() => {
              const sl = exit.stop_loss as Record<string, unknown>;
              const v  = `${String(sl.method)}${sl.multiplier ? ` ×${sl.multiplier}` : ""}${sl.pips ? ` ${sl.pips}pips` : ""}`;
              return <Row label="損切り (SL)" value={v} color={RED} />;
            })() : null}
            {exit.take_profit ? (() => {
              const tp = exit.take_profit as Record<string, unknown>;
              const v  = `${String(tp.method)}${tp.rr_ratio ? ` RR${tp.rr_ratio}` : ""}${tp.pips ? ` ${tp.pips}pips` : ""}`;
              return <Row label="利確 (TP)" value={v} color={NG} />;
            })() : null}
          </div>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// EquityCurve (lightweight-charts line series)
// ------------------------------------------------------------------

function EquityCurve({ trades }: { trades: DBTrade[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || trades.length === 0) return;

    const el = containerRef.current;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#334155",
        fontFamily: "monospace",
        fontSize: 9,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      width:    el.clientWidth,
      height:   160,
      timeScale: { visible: false },
      rightPriceScale: {
        borderVisible: false,
        textColor: "#475569",
      },
      crosshair: { mode: 1 },
      handleScroll: false,
      handleScale:  false,
    });
    chartRef.current = chart;

    const totalPips  = trades.reduce((s, t) => s + Number(t.pips), 0);
    const lineColor  = totalPips >= 0 ? NG : RED;
    const lineSeries = chart.addSeries(LineSeries, {
      color:            lineColor,
      lineWidth:        2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Cumulative pips: start from 0
    let cum = 0;
    const data: { time: UTCTimestamp; value: number }[] = [
      { time: 0 as UTCTimestamp, value: 0 },
    ];
    trades.forEach((t, i) => {
      cum += Number(t.pips);
      data.push({ time: (i + 1) as UTCTimestamp, value: Math.round(cum * 10) / 10 });
    });

    lineSeries.setData(data);
    chart.timeScale().fitContent();

    const resize = new ResizeObserver(() => {
      if (el) chart.applyOptions({ width: el.clientWidth });
    });
    resize.observe(el);

    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [trades]);

  if (trades.length === 0) return null;

  return (
    <div>
      <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: "#334155" }}>
        エクイティカーブ — 累積PIPS
      </p>
      <div ref={containerRef} className="w-full rounded overflow-hidden"
        style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }} />
    </div>
  );
}

// ------------------------------------------------------------------
// BacktestSummaryCard — 分析期間・全期間・月次内訳（ドロップダウン付き）
// ------------------------------------------------------------------

function fmtDateJP(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCFullYear()}/${mo}/${da} ${hh}:${mm}`;
}

function periodText(days: number): string {
  const years  = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  if (years > 0 && months > 0) return `${years}年${months}ヶ月`;
  if (years > 0)               return `${years}年`;
  if (months > 0)              return `${months}ヶ月`;
  return `${days}日`;
}

interface PeriodStats {
  wins:      number;
  losses:    number;
  total:     number;
  winRate:   number;
  totalPips: number;
  winPips:   number;
  lossPips:  number;
  pf:        number;
}

function calcStats(list: DBTrade[]): PeriodStats | null {
  if (!list.length) return null;
  const wins      = list.filter(t => t.result === "WIN").length;
  const losses    = list.filter(t => t.result === "LOSS").length;
  const total     = list.length;
  const totalPips = list.reduce((s, t) => s + t.pips, 0);
  const winRate   = total ? (wins / total) * 100 : 0;
  const winPips   = list.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
  const lossPips  = Math.abs(list.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
  const pf        = lossPips > 0 ? winPips / lossPips : winPips > 0 ? Infinity : 0;
  return { wins, losses, total, winRate, totalPips, winPips, lossPips, pf };
}

// 全期間の集計ブロック（大きく表示）
function WinLossBlock({ stats, label }: { stats: PeriodStats; label: string }) {
  const wrCol  = stats.winRate >= 50 ? NG : stats.winRate >= 33 ? AMBER : RED;
  const ppCol  = stats.totalPips >= 0 ? NG : RED;
  const pfCol  = stats.pf >= 1.3 ? NG : stats.pf >= 1 ? AMBER : RED;
  const pfDisp = stats.pf === Infinity ? "∞" : stats.pf.toFixed(2);

  return (
    <div className="rounded-lg p-4" style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.07)",
    }}>
      <p className="text-[8px] font-black tracking-[0.22em] mb-3" style={{ color: "#475569" }}>{label}</p>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 text-center">
          <p className="text-[32px] font-black leading-none" style={{ color: NG }}>{stats.wins}</p>
          <p className="text-[9px] font-mono mt-1" style={{ color: NG }}>勝ち</p>
        </div>
        <p className="text-[20px] font-black" style={{ color: "#1e293b" }}>vs</p>
        <div className="flex-1 text-center">
          <p className="text-[32px] font-black leading-none" style={{ color: RED }}>{stats.losses}</p>
          <p className="text-[9px] font-mono mt-1" style={{ color: RED }}>負け</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div className="text-center px-2 py-2 rounded" style={{ background: `${wrCol}10`, border: `1px solid ${wrCol}25` }}>
          <p className="text-[7px] font-mono tracking-widest mb-0.5" style={{ color: "#475569" }}>勝率</p>
          <p className="text-[20px] font-black leading-none" style={{ color: wrCol }}>{stats.winRate.toFixed(1)}%</p>
        </div>
        <div className="text-center px-2 py-2 rounded" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <p className="text-[7px] font-mono tracking-widest mb-0.5" style={{ color: "#475569" }}>プロフィットファクター</p>
          <p className="text-[20px] font-black leading-none" style={{ color: pfCol }}>{pfDisp}</p>
        </div>
      </div>
      <div className="rounded px-3 py-2.5" style={{ background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-[7px] font-black tracking-[0.2em] mb-2" style={{ color: "#334155" }}>PIPS 内訳</p>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono" style={{ color: NG }}>利益PIPS（勝ちトレード合計）</span>
            <span className="text-[11px] font-black font-mono" style={{ color: NG }}>+{stats.winPips.toFixed(1)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono" style={{ color: RED }}>損失PIPS（負けトレード合計）</span>
            <span className="text-[11px] font-black font-mono" style={{ color: RED }}>−{stats.lossPips.toFixed(1)}</span>
          </div>
          <div className="h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-black font-mono" style={{ color: ppCol }}>合計獲得PIPS</span>
            <span className="text-[15px] font-black font-mono" style={{ color: ppCol }}>
              {stats.totalPips >= 0 ? "+" : ""}{stats.totalPips.toFixed(1)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// 月次ドロップダウン行
function MonthlyRow({ monthKey, trades }: { monthKey: string; trades: DBTrade[] }) {
  const [open, setOpen] = useState(false);
  const stats = calcStats(trades);
  if (!stats) return null;

  const [year, mon] = monthKey.split("-");
  const label  = `${year}年${parseInt(mon)}月`;
  const ppCol  = stats.totalPips >= 0 ? NG : RED;
  const wrCol  = stats.winRate >= 50 ? NG : stats.winRate >= 33 ? AMBER : RED;
  const pfDisp = stats.pf === Infinity ? "∞" : stats.pf.toFixed(2);

  return (
    <div className="rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
      {/* ヘッダー行（クリックで展開） */}
      <button
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
        style={{ background: open ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)" }}
        onClick={() => setOpen(v => !v)}
      >
        {/* 展開矢印 */}
        <span className="text-[8px] font-mono shrink-0 transition-transform"
          style={{ color: "#475569", transform: open ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}>
          ▶
        </span>

        {/* 月ラベル */}
        <span className="text-[10px] font-black font-mono w-24 shrink-0" style={{ color: "#94a3b8" }}>
          {label}
        </span>

        {/* トレード数 */}
        <span className="text-[9px] font-mono shrink-0" style={{ color: "#475569" }}>
          {stats.total}件
        </span>

        {/* 勝/負 */}
        <span className="text-[9px] font-mono shrink-0" style={{ color: NG }}>{stats.wins}勝</span>
        <span className="text-[9px] font-mono shrink-0" style={{ color: RED }}>{stats.losses}負</span>

        {/* 勝率 */}
        <span className="text-[9px] font-mono font-bold shrink-0 w-12 text-right" style={{ color: wrCol }}>
          {stats.winRate.toFixed(0)}%
        </span>

        {/* PF */}
        <span className="text-[9px] font-mono shrink-0 w-10 text-right" style={{ color: "#64748b" }}>
          PF {pfDisp}
        </span>

        {/* 合計PIPS */}
        <span className="text-[10px] font-black font-mono ml-auto shrink-0" style={{ color: ppCol }}>
          {stats.totalPips >= 0 ? "+" : ""}{stats.totalPips.toFixed(1)}
        </span>
      </button>

      {/* ドロップダウン: 個別トレード */}
      {open && (
        <div style={{ background: "rgba(0,0,0,0.20)", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {/* テーブルヘッダー */}
          <div className="grid px-3 py-1.5" style={{
            gridTemplateColumns: "1fr 1fr 48px 48px 56px 44px",
            borderBottom: "1px solid rgba(255,255,255,0.04)"
          }}>
            {["エントリー", "決済", "方向", "結果", "PIPS", "理由"].map(h => (
              <span key={h} className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>{h}</span>
            ))}
          </div>
          {/* トレード行 */}
          {trades.map((t, i) => {
            const pips   = Number(t.pips);
            const ppC    = pips >= 0 ? NG : RED;
            const dirC   = t.direction === "BUY" ? NG : RED;
            const resC   = t.result === "WIN" ? NG : t.result === "LOSS" ? RED : AMBER;
            return (
              <div key={t.id ?? i}
                className="grid px-3 py-1.5 items-center"
                style={{
                  gridTemplateColumns: "1fr 1fr 48px 48px 56px 44px",
                  background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                  borderBottom: "1px solid rgba(255,255,255,0.03)",
                }}>
                {/* エントリー日時 */}
                <span className="text-[8px] font-mono" style={{ color: "#64748b" }}>
                  {fmtDateTime(t.entry_time)}
                </span>
                {/* 決済日時 */}
                <span className="text-[8px] font-mono" style={{ color: "#64748b" }}>
                  {fmtDateTime(t.exit_time)}
                </span>
                {/* 方向 */}
                <span className="text-[8px] font-mono font-bold" style={{ color: dirC }}>
                  {t.direction}
                </span>
                {/* 結果バッジ */}
                <span className="text-[7px] font-black px-1 py-0.5 rounded text-center"
                  style={{ background: `${resC}12`, border: `1px solid ${resC}30`, color: resC }}>
                  {t.result === "WIN" ? "勝" : t.result === "LOSS" ? "負" : "BE"}
                </span>
                {/* PIPS */}
                <span className="text-[9px] font-black font-mono text-right" style={{ color: ppC }}>
                  {pips >= 0 ? "+" : ""}{pips.toFixed(1)}
                </span>
                {/* 理由 */}
                <span className="text-[7px] font-mono" style={{ color: "#334155" }}>
                  {t.exit_reason}
                </span>
              </div>
            );
          })}
          {/* 月の小計 */}
          <div className="flex items-center justify-between px-3 py-2"
            style={{ borderTop: "1px solid rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.02)" }}>
            <span className="text-[8px] font-mono" style={{ color: "#475569" }}>
              月合計 {stats.wins}勝 {stats.losses}負 (WR {stats.winRate.toFixed(0)}%)
            </span>
            <span className="text-[10px] font-black font-mono" style={{ color: ppCol }}>
              {stats.totalPips >= 0 ? "+" : ""}{stats.totalPips.toFixed(1)} pips
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function BacktestSummaryCard({
  result,
  trades,
}: {
  result:  DisplayResult;
  trades:  DBTrade[];
}) {
  const times   = trades.map(t => new Date(t.entry_time).getTime());
  const minTime = trades.length ? Math.min(...times) : 0;
  const maxTime = trades.length ? Math.max(...times) : 0;

  // 全期間統計
  const allStats = calcStats(trades);

  // 月別グループ (YYYY-MM キーで降順)
  const monthMap = new Map<string, DBTrade[]>();
  for (const t of trades) {
    const d   = new Date(t.entry_time);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!monthMap.has(key)) monthMap.set(key, []);
    monthMap.get(key)!.push(t);
  }
  const monthKeys = [...monthMap.keys()].sort((a, b) => b.localeCompare(a)); // 新しい月が上

  return (
    <div className="space-y-4">

      {/* ── 分析データ期間 ───────────────────────────── */}
      <div className="px-4 py-3 rounded-lg"
        style={{ background: "rgba(0,229,255,0.04)", border: "1px solid rgba(0,229,255,0.15)" }}>
        <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: CYAN }}>
          分析データ期間
        </p>
        <p className="text-[13px] font-black font-mono" style={{ color: "#e2e8f0" }}>
          {trades.length
            ? `${fmtDateJP(minTime)} 〜 ${fmtDateJP(maxTime)}`
            : `${result.dataCoverageDays.toFixed(0)}日間のデータ`}
        </p>
        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
          <span className="text-[11px] font-black" style={{ color: CYAN }}>
            {periodText(result.dataCoverageDays)}分のデータ
          </span>
          <span className="text-[9px] font-mono" style={{ color: "#334155" }}>
            （{result.dataCoverageDays.toFixed(0)}日 / {result.barCount.toLocaleString()}本のバー）
          </span>
        </div>
      </div>

      {/* ── 全期間成績 ───────────────────────────────── */}
      {allStats && <WinLossBlock stats={allStats} label="全期間成績" />}

      {/* ── 月次内訳 ─────────────────────────────────── */}
      {monthKeys.length > 0 && (
        <div className="space-y-2">
          <p className="text-[8px] font-black tracking-[0.22em]" style={{ color: "#475569" }}>
            月次内訳 — クリックで詳細展開
          </p>
          {monthKeys.map(key => (
            <MonthlyRow key={key} monthKey={key} trades={monthMap.get(key)!} />
          ))}
        </div>
      )}

    </div>
  );
}

// ------------------------------------------------------------------
// ResultDisplay — statistics grid + verdict
// ------------------------------------------------------------------

function ResultDisplay({ r }: { r: DisplayResult }) {
  const pfNum = r.profitFactor ?? Infinity;
  const vc    = verdictColor(r.verdict);

  return (
    <div className="space-y-4">
      {/* Verdict banner */}
      <div className="px-4 py-3 rounded"
        style={{ background: `${vc}0a`, border: `1px solid ${vc}35` }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[8px] font-mono tracking-widest mb-1" style={{ color: "#475569" }}>判定</p>
            <p className="text-xl font-black tracking-widest" style={{ color: vc, textShadow: `0 0 16px ${vc}60` }}>
              {labelOf(VERDICT_LABELS, r.verdict)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[8px] font-mono tracking-widest mb-1" style={{ color: "#334155" }}>期間</p>
            <p className="text-[9px] font-mono" style={{ color: "#475569" }}>{r.periodLabel}</p>
          </div>
        </div>
        {r.verdictReason && (
          <p className="text-[9px] font-mono mt-2 leading-relaxed" style={{ color: "#64748b" }}>
            {r.verdictReason}
          </p>
        )}
      </div>

      {/* Sample size warning */}
      {r.sampleSizeWarning && (
        <div className="flex items-start gap-2 px-3 py-2 rounded"
          style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.25)" }}>
          <span style={{ color: AMBER }}>⚠</span>
          <div>
            <p className="text-[9px] font-black tracking-widest" style={{ color: AMBER }}>
              サンプル数不足
            </p>
            <p className="text-[8px] font-mono mt-0.5" style={{ color: "#64748b" }}>
              {r.totalTrades}件のみ。より多くの過去データで検証することを推奨します。
            </p>
          </div>
        </div>
      )}

      {/* Key metrics */}
      <div>
        <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: "#334155" }}>主要指標</p>

        {/* Total pips — large */}
        <div className="px-4 py-3 rounded mb-2"
          style={{
            background: `${pipsColor(r.totalPips)}08`,
            border: `1px solid ${pipsColor(r.totalPips)}25`,
          }}>
          <p className="text-[8px] font-mono tracking-widest mb-1" style={{ color: "#334155" }}>合計 PIPS</p>
          <p className="text-3xl font-black font-mono leading-none"
            style={{ color: pipsColor(r.totalPips), textShadow: `0 0 20px ${pipsColor(r.totalPips)}50` }}>
            {r.totalPips >= 0 ? "+" : ""}{r.totalPips.toFixed(1)}
          </p>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {[
            { label: "勝率",        value: `${r.winRate.toFixed(1)}%`,         color: r.winRate >= 55 ? NG : r.winRate >= 45 ? AMBER : RED },
            { label: "PF",         value: pfDisplay(r.profitFactor),            color: pfNum >= 1.3 ? NG : pfNum >= 1 ? AMBER : RED },
            { label: "取引数",     value: String(r.totalTrades),               color: "#94a3b8" },
            { label: "平均PIPS",   value: `${r.avgPips >= 0 ? "+" : ""}${r.avgPips.toFixed(1)}`, color: pipsColor(r.avgPips) },
            { label: "最大DD",     value: `${r.maxDrawdownPct.toFixed(1)}%`,   color: r.maxDrawdownPct < 10 ? NG : r.maxDrawdownPct < 20 ? AMBER : RED },
            { label: "DDのPIPS",   value: r.maxDrawdownPips.toFixed(1),        color: "#64748b" },
            { label: "勝ち",       value: String(r.wins),                       color: NG },
            { label: "負け",       value: String(r.losses),                    color: RED },
            { label: "平均時間",   value: `${r.avgDuration.toFixed(0)} min`,   color: "#64748b" },
          ].map(({ label, value, color }) => (
            <div key={label} className="px-2 py-2 rounded"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <p className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>{label}</p>
              <p className="text-[11px] font-mono font-bold mt-0.5" style={{ color }}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Data coverage */}
      <div className="flex gap-3 text-[8px] font-mono" style={{ color: "#334155" }}>
        <span>データ期間: {r.dataCoverageDays.toFixed(0)}日</span>
        <span>·</span>
        <span>バー数: {r.barCount.toLocaleString()}</span>
        <span>·</span>
        <span>連勝/連敗 {r.maxConsWins}/{r.maxConsLosses}</span>
      </div>

      {/* Session performance */}
      {Object.keys(r.sessionStats).length > 0 && (
        <div>
          <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: "#334155" }}>
            セッション別成績
          </p>
          <div className="space-y-1.5">
            {Object.entries(r.sessionStats).map(([sess, stat]) => {
              const isBest  = sess === r.bestSession;
              const isWorst = sess === r.worstSession;
              return (
                <div key={sess} className="flex items-center gap-3 px-3 py-2 rounded"
                  style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                  <div className="flex items-center gap-1.5 w-28 shrink-0">
                    <span className="text-[9px] font-mono font-bold" style={{ color: "#64748b" }}>{sess}</span>
                    {isBest  && <span className="text-[6px] font-black px-1 rounded" style={{ background: `${NG}15`, color: NG }}>BEST</span>}
                    {isWorst && <span className="text-[6px] font-black px-1 rounded" style={{ background: `${RED}15`, color: RED }}>WORST</span>}
                  </div>
                  <span className="text-[8px] font-mono w-14 shrink-0" style={{ color: "#475569" }}>
                    {stat.tradeCount} trades
                  </span>
                  <div className="flex-1 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
                    <div className="h-full rounded-full"
                      style={{
                        width: `${stat.winRate}%`,
                        background: `linear-gradient(to right, ${NG_r}0.4), ${NG})`,
                      }} />
                  </div>
                  <span className="text-[9px] font-mono w-10 text-right shrink-0"
                    style={{ color: stat.winRate >= 50 ? NG : RED }}>
                    {stat.winRate.toFixed(0)}%
                  </span>
                  <span className="text-[9px] font-mono w-16 text-right shrink-0"
                    style={{ color: pipsColor(stat.totalPips) }}>
                    {stat.totalPips >= 0 ? "+" : ""}{stat.totalPips.toFixed(1)}p
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// BacktestTab
// ------------------------------------------------------------------

const PERIODS = ["AVAILABLE", "1M", "3M", "6M", "1Y"] as const;
type Period = typeof PERIODS[number];

function BacktestTab({ strategyId, onJobIdChange }: {
  strategyId:    string;
  onJobIdChange: (id: string | null) => void;
}) {
  const [period,  setPeriod]  = useState<Period>("AVAILABLE");
  const [balance, setBalance] = useState("10000");
  const [state,   setState]   = useState<"idle" | "running" | "done" | "error">("idle");
  const [result,  setResult]  = useState<DisplayResult | null>(null);
  const [errMsg,  setErrMsg]  = useState("");
  const [trades,  setTrades]  = useState<DBTrade[]>([]);

  // Load existing result on mount
  useEffect(() => {
    fetch(`/api/strategies/${strategyId}/backtest`)
      .then(r => r.json())
      .then((data: { status: string; result?: Record<string, unknown>; latestJob?: Record<string, unknown> }) => {
        if (data.status === "HAS_RESULT" && data.result && data.latestJob) {
          const jobId = String(data.latestJob.id);
          setResult(normaliseResult(data.result, jobId));
          onJobIdChange(jobId);
          // Load trades
          fetch(`/api/backtest/job/${jobId}`)
            .then(r => r.json())
            .then((jd: { trades?: DBTrade[] }) => { if (jd.trades) setTrades(jd.trades); })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [strategyId, onJobIdChange]);

  const runBacktest = useCallback(async () => {
    const bal = parseInt(balance, 10);
    if (isNaN(bal) || bal <= 0) { setErrMsg("有効な Initial Balance を入力してください"); return; }

    setState("running");
    setErrMsg("");
    try {
      const res  = await fetch("/api/backtest/run", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ strategyId, period, initialBalance: bal }),
      });
      const data = await res.json() as {
        status:  string;
        jobId?:  string;
        result?: Record<string, unknown>;
        error?:  string;
      };

      if (data.status === "COMPLETED" && data.result && data.jobId) {
        const r = normaliseResult(data.result, data.jobId);
        setResult(r);
        onJobIdChange(data.jobId);
        // Load trades
        const jRes  = await fetch(`/api/backtest/job/${data.jobId}`);
        const jData = await jRes.json() as { trades?: DBTrade[] };
        if (jData.trades) setTrades(jData.trades);
        setState("done");
      } else {
        setErrMsg(data.error ?? "Backtest に失敗しました");
        setState("error");
      }
    } catch (err) {
      setErrMsg(String(err));
      setState("error");
    }
  }, [strategyId, period, balance, onJobIdChange]);

  return (
    <div className="p-5 space-y-5 overflow-y-auto">

      {/* Run panel */}
      <div className="p-4 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
        <p className="text-[8px] font-black tracking-[0.22em] mb-3" style={{ color: CYAN }}>
          バックテスト実行
        </p>

        {/* Period selector */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              disabled={state === "running"}
              className="px-3 py-1.5 rounded text-[9px] font-mono font-bold tracking-widest transition-all"
              style={{
                background:    p === period ? `${CYAN}15` : "rgba(255,255,255,0.03)",
                border:        `1px solid ${p === period ? `${CYAN}45` : "rgba(255,255,255,0.08)"}`,
                color:         p === period ? CYAN : "#475569",
                cursor:        state === "running" ? "not-allowed" : "pointer",
              }}>
              {p}
            </button>
          ))}
        </div>

        {/* Balance input */}
        <div className="flex items-center gap-3 mb-4">
          <span className="text-[8px] font-mono tracking-widest shrink-0" style={{ color: "#334155" }}>
            初期残高
          </span>
          <div className="relative flex-1 max-w-[160px]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-mono" style={{ color: "#475569" }}>$</span>
            <input
              type="number"
              value={balance}
              onChange={e => setBalance(e.target.value)}
              disabled={state === "running"}
              className="w-full pl-7 pr-3 py-1.5 rounded text-[10px] font-mono bg-transparent border outline-none"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "#94a3b8",
              }}
            />
          </div>
        </div>

        {/* Run button */}
        <button
          onClick={runBacktest}
          disabled={state === "running"}
          className="w-full h-10 rounded font-mono font-black text-[11px] tracking-widest transition-all duration-200"
          style={{
            background: state === "running"
              ? "rgba(255,255,255,0.04)"
              : `linear-gradient(135deg, ${NG_r}0.15) 0%, ${NG_r}0.08) 100%)`,
            border: `1px solid ${state === "running" ? "rgba(255,255,255,0.08)" : `${NG_r}0.40)`}`,
            color:  state === "running" ? "#334155" : NG,
            cursor: state === "running" ? "not-allowed" : "pointer",
          }}>
          {state === "running"
            ? "◌ バックテスト実行中..."
            : result ? "↺ 再実行" : "▶ バックテスト実行"}
        </button>

        {errMsg && (
          <p className="text-[9px] font-mono mt-2" style={{ color: RED }}>{errMsg}</p>
        )}
      </div>

      {/* Result */}
      {result && (
        <>
          {/* ① 判定バナー（PASSED / CONDITIONAL / FAILED） */}
          <div className="px-4 py-3 rounded"
            style={{ background: `${verdictColor(result.verdict)}0a`, border: `1px solid ${verdictColor(result.verdict)}35` }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[8px] font-mono tracking-widest mb-0.5" style={{ color: "#475569" }}>判定</p>
                <p className="text-2xl font-black tracking-widest"
                  style={{ color: verdictColor(result.verdict), textShadow: `0 0 16px ${verdictColor(result.verdict)}60` }}>
                  {labelOf(VERDICT_LABELS, result.verdict)}
                </p>
              </div>
              {result.verdictReason && (
                <p className="text-[9px] font-mono leading-relaxed max-w-[55%] text-right" style={{ color: "#64748b" }}>
                  {result.verdictReason}
                </p>
              )}
            </div>
            {result.sampleSizeWarning && (
              <p className="text-[9px] font-mono mt-2" style={{ color: AMBER }}>
                ⚠ サンプル数不足（{result.totalTrades}件）— より多くのデータで再検証を推奨
              </p>
            )}
          </div>

          {/* ② メインサマリー: 分析期間・全期間成績・直近3ヶ月 */}
          {trades.length > 0 && <BacktestSummaryCard result={result} trades={trades} />}

          {/* ③ エクイティカーブ */}
          {trades.length > 0 && <EquityCurve trades={trades} />}

          {/* ④ 詳細指標（PF・DD・セッション別等） */}
          <ResultDisplay r={result} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// TradesTab
// ------------------------------------------------------------------

type TradeFilter = "ALL" | "WIN" | "LOSS";
const PAGE_SIZE = 20;

function TradesTab({ jobId }: { jobId: string | null }) {
  const [trades,  setTrades]  = useState<DBTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter,  setFilter]  = useState<TradeFilter>("ALL");
  const [page,    setPage]    = useState(0);

  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    fetch(`/api/backtest/job/${jobId}`)
      .then(r => r.json())
      .then((d: { trades?: DBTrade[] }) => { if (d.trades) setTrades(d.trades); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [jobId]);

  const filtered = trades.filter(t => {
    if (filter === "WIN")  return t.result === "WIN";
    if (filter === "LOSS") return t.result === "LOSS";
    return true;
  });
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged      = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (!jobId) {
    return (
      <div className="p-5 flex items-center justify-center h-48">
        <p className="text-[9px] font-mono tracking-widest" style={{ color: "#334155" }}>
          Backtest を実行すると Trade 一覧が表示されます
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-5 flex items-center justify-center h-48">
        <p className="text-[9px] font-mono tracking-widest" style={{ color: "#334155" }}>
          ◌ 取引データ読み込み中...
        </p>
      </div>
    );
  }

  return (
    <div className="p-5 space-y-3 overflow-y-auto">
      {/* Filter + count */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1.5">
          {(["ALL", "WIN", "LOSS"] as TradeFilter[]).map(f => (
            <button key={f} onClick={() => { setFilter(f); setPage(0); }}
              className="px-2.5 py-1 rounded text-[8px] font-mono font-bold tracking-widest transition-all"
              style={{
                background: f === filter ? (f === "WIN" ? `${NG}18` : f === "LOSS" ? `${RED}18` : "rgba(255,255,255,0.07)") : "rgba(255,255,255,0.03)",
                border:     `1px solid ${f === filter ? (f === "WIN" ? `${NG}40` : f === "LOSS" ? `${RED}40` : "rgba(255,255,255,0.20)") : "rgba(255,255,255,0.06)"}`,
                color:      f === filter ? (f === "WIN" ? NG : f === "LOSS" ? RED : "#94a3b8") : "#475569",
              }}>
              {f}
            </button>
          ))}
        </div>
        <span className="text-[8px] font-mono" style={{ color: "#334155" }}>
          {filtered.length} 件
        </span>
      </div>

      {/* Table */}
      {paged.length === 0 ? (
        <p className="text-[9px] font-mono text-center py-8" style={{ color: "#334155" }}>取引データなし</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "separate", borderSpacing: "0 2px" }}>
            <thead>
              <tr>
                {["時刻", "方向", "エントリー", "決済", "PIPS", "結果", "セッション", "理由"].map(h => (
                  <th key={h} className="text-left px-2 pb-1.5 text-[7px] font-mono tracking-widest"
                    style={{ color: "#334155" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.map((t) => {
                const pips    = Number(t.pips);
                const rColor  = t.result === "WIN" ? NG : t.result === "LOSS" ? RED : AMBER;
                const dirCol  = t.direction === "BUY" ? NG : RED;
                return (
                  <tr key={t.id} style={{ background: "rgba(255,255,255,0.015)" }}>
                    <td className="px-2 py-1.5 text-[8px] font-mono rounded-l" style={{ color: "#64748b" }}>
                      {fmtTime(t.entry_time)}
                    </td>
                    <td className="px-2 py-1.5 text-[8px] font-mono font-bold" style={{ color: dirCol }}>
                      {t.direction}
                    </td>
                    <td className="px-2 py-1.5 text-[8px] font-mono" style={{ color: "#94a3b8" }}>
                      {Number(t.entry_price).toFixed(5)}
                    </td>
                    <td className="px-2 py-1.5 text-[8px] font-mono" style={{ color: "#94a3b8" }}>
                      {Number(t.exit_price).toFixed(5)}
                    </td>
                    <td className="px-2 py-1.5 text-[9px] font-mono font-bold" style={{ color: pipsColor(pips) }}>
                      {pips >= 0 ? "+" : ""}{pips.toFixed(1)}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="text-[7px] font-black tracking-widest px-1.5 py-0.5 rounded"
                        style={{ background: `${rColor}12`, border: `1px solid ${rColor}30`, color: rColor }}>
                        {t.result}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-[8px] font-mono" style={{ color: "#475569" }}>
                      {t.session ?? "–"}
                    </td>
                    <td className="px-2 py-1.5 text-[8px] font-mono rounded-r" style={{ color: "#334155" }}>
                      {t.exit_reason}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="px-2 py-1 rounded text-[8px] font-mono transition-opacity"
            style={{ color: "#475569", opacity: page === 0 ? 0.3 : 1 }}>
            ← 前
          </button>
          <span className="text-[8px] font-mono" style={{ color: "#334155" }}>
            {page + 1} / {totalPages}
          </span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
            className="px-2 py-1 rounded text-[8px] font-mono transition-opacity"
            style={{ color: "#475569", opacity: page === totalPages - 1 ? 0.3 : 1 }}>
            次 →
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// StrategyChatSection — EA専用AIチャット
// ------------------------------------------------------------------

interface ChatMessage { role: "user" | "assistant"; content: string }

const SUGGESTED = [
  "このEAの信頼性は？",
  "なぜOOSで損失になるの？",
  "どの月が一番稼いだ？",
  "最悪のトレードはどれ？",
  "ロンドンとNYどっちが強い？",
  "このEAの最大リスクは？",
];

function StrategyChatSection({ strategyId }: { strategyId: string }) {
  const [messages,  setMessages]  = useState<ChatMessage[]>([]);
  const [input,     setInput]     = useState("");
  const [loading,   setLoading]   = useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setLoading(true);

    try {
      const res  = await fetch(`/api/strategies/${strategyId}/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ message: text, history: messages }),
      });
      const data = await res.json() as { answer?: string; error?: string };
      const aiMsg: ChatMessage = {
        role:    "assistant",
        content: data.answer ?? data.error ?? "エラーが発生しました",
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: String(e) }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
      <p className="text-[8px] font-black tracking-[0.25em]" style={{ color: CYAN }}>
        ⬡ EA AIチャット — このEAについて何でも聞いてください
      </p>

      {/* 会話履歴 */}
      {messages.length > 0 && (
        <div
          ref={scrollRef}
          className="space-y-2 max-h-80 overflow-y-auto pr-1"
        >
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className="max-w-[80%] px-3 py-2 rounded-lg text-[9px] font-mono leading-relaxed"
                style={{
                  background: m.role === "user"
                    ? `rgba(0,229,255,0.12)`
                    : "rgba(255,255,255,0.04)",
                  border: `1px solid ${m.role === "user" ? "rgba(0,229,255,0.25)" : "rgba(255,255,255,0.08)"}`,
                  color: m.role === "user" ? CYAN : "#94a3b8",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.role === "assistant" && (
                  <span className="text-[7px] font-black tracking-widest block mb-1" style={{ color: "#475569" }}>
                    AI
                  </span>
                )}
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="px-3 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <span className="text-[9px] font-mono" style={{ color: "#334155" }}>◌ 考え中...</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* クイック質問 */}
      {messages.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED.map(q => (
            <button key={q} onClick={() => sendMessage(q)}
              className="px-2.5 py-1.5 rounded text-[8px] font-mono transition-all"
              style={{
                background: "rgba(0,229,255,0.05)",
                border: "1px solid rgba(0,229,255,0.20)",
                color: CYAN,
              }}>
              {q}
            </button>
          ))}
        </div>
      )}

      {/* 入力欄 */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
          placeholder="例: なぜ3月に損失が出たの？"
          disabled={loading}
          className="flex-1 px-3 py-2 rounded text-[9px] font-mono outline-none"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.10)",
            color: "#e2e8f0",
          }}
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={!input.trim() || loading}
          className="px-4 py-2 rounded text-[9px] font-mono font-black transition-all"
          style={{
            background: !input.trim() || loading ? "rgba(255,255,255,0.04)" : `rgba(0,229,255,0.15)`,
            border: `1px solid ${!input.trim() || loading ? "rgba(255,255,255,0.08)" : "rgba(0,229,255,0.40)"}`,
            color: !input.trim() || loading ? "#334155" : CYAN,
            cursor: !input.trim() || loading ? "not-allowed" : "pointer",
          }}>
          送信
        </button>
      </div>

      {messages.length > 0 && (
        <button
          onClick={() => setMessages([])}
          className="text-[7px] font-mono opacity-40 hover:opacity-70 transition-opacity"
          style={{ color: "#64748b" }}>
          会話をクリア
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// AnalysisTab — AI Analysis display
// ------------------------------------------------------------------

// Analysis API 型
interface FactItem       { statement: string; source: string; value?: string | number | null }
interface ObsItem        { observation: string; basis: string; confidence?: "HIGH" | "MEDIUM" | "LOW" }
interface HypItem        { hypothesis: string; rationale: string; confidence?: "HIGH" | "MEDIUM" | "LOW" }
interface SwItem         { point: string; detail?: string }
interface SessItem       { session: string; observation: string; recommendation?: string }
interface RiskAnalysis   { drawdown_assessment: string; sl_tp_assessment: string; consistency_assessment: string; overall: string }
interface RecItem        { action: string; rationale?: string; priority?: "HIGH" | "MEDIUM" | "LOW" }

interface AIAnalysis {
  summary:           string;
  facts:             FactItem[];
  observations:      ObsItem[];
  hypotheses:        HypItem[];
  weaknesses:        SwItem[];
  strengths:         SwItem[];
  session_analysis:  SessItem[];
  risk_analysis:     RiskAnalysis;
  recommendations:   RecItem[];
  confidence:        number;
  data_quality_note: string;
}

// Confidence color
function confColor(c: number): string {
  if (c >= 70) return NG;
  if (c >= 45) return AMBER;
  return RED;
}
function confBadgeColor(level?: "HIGH" | "MEDIUM" | "LOW"): string {
  if (level === "HIGH")   return NG;
  if (level === "MEDIUM") return AMBER;
  return "#64748b";
}
function priorityColor(p?: "HIGH" | "MEDIUM" | "LOW"): string {
  if (p === "HIGH")   return RED;
  if (p === "MEDIUM") return AMBER;
  return "#64748b";
}

const PURPLE = "#a78bfa";

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[8px] font-black tracking-[0.25em] mb-2" style={{ color }}>{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

// 事実レポートセクション（descriptionフィールドから表示）
function FactReportSection({ strategyId }: { strategyId: string }) {
  const [report, setReport] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/strategies/${strategyId}`)
      .then(r => r.json())
      .then((d: { strategy?: { description?: string | null } }) => {
        const desc = d.strategy?.description ?? null;
        if (desc && desc.includes("事実確認レポート")) setReport(desc);
      })
      .catch(() => {});
  }, [strategyId]);

  if (!report) return null;

  const lines = report.split("\n");
  const verdictLine = lines.find(l => l.includes("総合判定:")) ?? "";
  const verdictColor = verdictLine.includes("✅") ? NG : verdictLine.includes("⚠") ? AMBER : RED;

  return (
    <div className="p-4 rounded-lg" style={{ background: "rgba(0,229,255,0.03)", border: "1px solid rgba(0,229,255,0.12)" }}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[8px] font-black tracking-[0.25em]" style={{ color: CYAN }}>
          事実確認レポート
        </p>
        {verdictLine && (
          <span className="text-[8px] font-black px-2 py-0.5 rounded"
            style={{ background: `${verdictColor}15`, border: `1px solid ${verdictColor}35`, color: verdictColor }}>
            {verdictLine.replace("◆ 総合判定:", "").trim()}
          </span>
        )}
      </div>
      <pre className="text-[8px] font-mono leading-relaxed whitespace-pre-wrap"
        style={{ color: "#64748b" }}>
        {report.replace("【事実確認レポート】\n", "").replace(/登録日:.*\n/, "").trim()}
      </pre>
    </div>
  );
}

function AnalysisTab({ strategyId, hasBacktest }: { strategyId: string; hasBacktest: boolean }) {
  const [state,    setState]    = useState<"idle" | "loading" | "running" | "done" | "error">("loading");
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);
  const [errMsg,   setErrMsg]   = useState("");

  // Load existing analysis on mount
  useEffect(() => {
    fetch(`/api/strategies/${strategyId}/analyze`)
      .then(r => r.json())
      .then((d: { status: string; analysis?: AIAnalysis }) => {
        if (d.status === "HAS_ANALYSIS" && d.analysis) {
          setAnalysis(d.analysis);
          setState("done");
        } else {
          setState("idle");
        }
      })
      .catch(() => setState("idle"));
  }, [strategyId]);

  const runAnalysis = async () => {
    setState("running");
    setErrMsg("");
    try {
      const res  = await fetch(`/api/strategies/${strategyId}/analyze`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      const data = await res.json() as { analysis?: AIAnalysis; error?: string };
      if (!res.ok || !data.analysis) {
        setErrMsg(data.error ?? "Analysis failed");
        setState("error");
      } else {
        setAnalysis(data.analysis);
        setState("done");
      }
    } catch (err) {
      setErrMsg(String(err));
      setState("error");
    }
  };

  if (state === "loading") {
    return (
      <div className="p-5 flex items-center justify-center h-48">
        <p className="text-[9px] font-mono tracking-widest" style={{ color: "#334155" }}>◌ Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-5 space-y-5 overflow-y-auto">

      {/* ── 事実確認レポート（最優先表示） ─────────── */}
      <FactReportSection strategyId={strategyId} />

      {/* ── EA AIチャット（メイン機能） ──────────── */}
      <StrategyChatSection strategyId={strategyId} />

      {/* ── 詳細AI分析（オプション） ─────────────── */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "16px" }}>
        <p className="text-[8px] font-black tracking-[0.25em] mb-3" style={{ color: "#334155" }}>
          詳細AI分析（オプション）
        </p>

      {/* Run / Re-run button */}
      {hasBacktest && (
        <div className="flex items-center gap-3">
          <button
            onClick={runAnalysis}
            disabled={state === "running"}
            className="px-5 py-2.5 rounded font-mono font-black text-[10px] tracking-widest transition-all"
            style={{
              background: state === "running"
                ? "rgba(255,255,255,0.04)"
                : `linear-gradient(135deg, rgba(167,139,250,0.15) 0%, rgba(167,139,250,0.07) 100%)`,
              border:  `1px solid ${state === "running" ? "rgba(255,255,255,0.08)" : "rgba(167,139,250,0.40)"}`,
              color:   state === "running" ? "#334155" : PURPLE,
              cursor:  state === "running" ? "not-allowed" : "pointer",
            }}>
            {state === "running"
              ? "◌ AI分析中..."
              : analysis ? "↺ AI再分析" : "⬡ AIで分析する"}
          </button>
          {errMsg && <p className="text-[9px] font-mono" style={{ color: RED }}>{errMsg}</p>}
        </div>
      )}

      {!hasBacktest && !analysis && (
        <div className="flex items-center justify-center h-32">
          <p className="text-[9px] font-mono tracking-widest" style={{ color: "#334155" }}>
            バックテストを実行してからAI分析が使用できます。
          </p>
        </div>
      )}

      {/* Analysis display */}
      {analysis && (
        <div className="space-y-5">

          {/* Summary + Confidence */}
          <div className="px-4 py-3 rounded"
            style={{ background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.20)" }}>
            <div className="flex items-start justify-between gap-4 mb-2">
              <p className="text-[8px] font-black tracking-[0.25em]" style={{ color: PURPLE }}>AI ANALYSIS</p>
              <div className="flex items-center gap-2 shrink-0">
                <p className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>信頼度</p>
                <p className="text-sm font-black font-mono" style={{ color: confColor(analysis.confidence) }}>
                  {analysis.confidence}
                </p>
              </div>
            </div>
            <p className="text-[10px] font-mono leading-relaxed" style={{ color: "#94a3b8" }}>
              {analysis.summary}
            </p>
            {analysis.data_quality_note && (
              <p className="text-[8px] font-mono mt-2 leading-relaxed" style={{ color: "#475569" }}>
                ⚠ {analysis.data_quality_note}
              </p>
            )}
          </div>

          {/* FACTS */}
          {analysis.facts.length > 0 && (
            <Section title="ファクト — バックテストデータから確認済み" color={CYAN}>
              {analysis.facts.map((f, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 rounded"
                  style={{ background: `${CYAN}06`, border: `1px solid ${CYAN}15` }}>
                  <span className="text-[8px] font-black mt-0.5 shrink-0" style={{ color: CYAN }}>F</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-mono leading-relaxed" style={{ color: "#94a3b8" }}>{f.statement}</p>
                    {f.value !== undefined && f.value !== null && (
                      <span className="text-[7px] font-black px-1.5 py-0.5 rounded mt-1 inline-block"
                        style={{ background: `${CYAN}12`, border: `1px solid ${CYAN}25`, color: CYAN }}>
                        {String(f.value)}
                      </span>
                    )}
                  </div>
                  <span className="text-[7px] font-mono shrink-0 mt-0.5" style={{ color: "#334155" }}>
                    {f.source}
                  </span>
                </div>
              ))}
            </Section>
          )}

          {/* OBSERVATIONS */}
          {analysis.observations.length > 0 && (
            <Section title="観察 — 推測されたパターン" color={AMBER}>
              {analysis.observations.map((o, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 rounded"
                  style={{ background: `${AMBER}06`, border: `1px solid ${AMBER}15` }}>
                  <span className="text-[8px] font-black mt-0.5 shrink-0" style={{ color: AMBER }}>O</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-mono leading-relaxed" style={{ color: "#94a3b8" }}>{o.observation}</p>
                    <p className="text-[8px] font-mono mt-1 leading-relaxed" style={{ color: "#475569" }}>
                      根拠: {o.basis}
                    </p>
                  </div>
                  {o.confidence && (
                    <span className="text-[7px] font-black px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                      style={{ background: `${confBadgeColor(o.confidence)}12`, border: `1px solid ${confBadgeColor(o.confidence)}30`, color: confBadgeColor(o.confidence) }}>
                      {o.confidence}
                    </span>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* HYPOTHESES — clearly labeled as speculative */}
          {analysis.hypotheses.length > 0 && (
            <Section title="仮説 — 考えられる要因（未確認）" color={PURPLE}>
              <div className="px-3 py-1.5 rounded mb-2"
                style={{ background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.20)" }}>
                <p className="text-[7px] font-mono" style={{ color: PURPLE }}>
                  ⚠ 以下は未確認の仮説です。確立された事実ではなく、考えられる要因を示しています。
                </p>
              </div>
              {analysis.hypotheses.map((h, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 rounded"
                  style={{ background: "rgba(167,139,250,0.04)", border: "1px solid rgba(167,139,250,0.12)" }}>
                  <span className="text-[8px] font-black mt-0.5 shrink-0" style={{ color: PURPLE }}>H</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-mono leading-relaxed italic" style={{ color: "#a78bfa" }}>
                      {h.hypothesis}
                    </p>
                    <p className="text-[8px] font-mono mt-1 leading-relaxed" style={{ color: "#475569" }}>
                      {h.rationale}
                    </p>
                  </div>
                  {h.confidence && (
                    <span className="text-[7px] font-black px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                      style={{ background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.25)", color: PURPLE }}>
                      {h.confidence}
                    </span>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* STRENGTHS */}
          {analysis.strengths.length > 0 && (
            <Section title="強み" color={NG}>
              {analysis.strengths.map((s, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 rounded"
                  style={{ background: `${NG_r}0.04)`, border: `1px solid ${NG_r}0.12)` }}>
                  <span className="text-[8px] font-black mt-0.5 shrink-0" style={{ color: NG }}>+</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-mono font-bold" style={{ color: "#94a3b8" }}>{s.point}</p>
                    {s.detail && <p className="text-[8px] font-mono mt-0.5" style={{ color: "#475569" }}>{s.detail}</p>}
                  </div>
                </div>
              ))}
            </Section>
          )}

          {/* WEAKNESSES */}
          {analysis.weaknesses.length > 0 && (
            <Section title="弱み" color={RED}>
              {analysis.weaknesses.map((w, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 rounded"
                  style={{ background: `${RED}06`, border: `1px solid ${RED}18` }}>
                  <span className="text-[8px] font-black mt-0.5 shrink-0" style={{ color: RED }}>−</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-mono font-bold" style={{ color: "#94a3b8" }}>{w.point}</p>
                    {w.detail && <p className="text-[8px] font-mono mt-0.5" style={{ color: "#475569" }}>{w.detail}</p>}
                  </div>
                </div>
              ))}
            </Section>
          )}

          {/* SESSION ANALYSIS */}
          {analysis.session_analysis.length > 0 && (
            <Section title="セッション分析" color="#64748b">
              {analysis.session_analysis.map((s, i) => (
                <div key={i} className="px-3 py-2 rounded"
                  style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[8px] font-black tracking-widest" style={{ color: "#64748b" }}>{s.session}</span>
                  </div>
                  <p className="text-[9px] font-mono leading-relaxed" style={{ color: "#94a3b8" }}>{s.observation}</p>
                  {s.recommendation && (
                    <p className="text-[8px] font-mono mt-1 leading-relaxed" style={{ color: CYAN }}>
                      → {s.recommendation}
                    </p>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* RISK ANALYSIS */}
          <Section title="リスク分析" color={AMBER}>
            <div className="px-3 py-3 rounded space-y-2"
              style={{ background: `${AMBER}06`, border: `1px solid ${AMBER}18` }}>
              {([
                ["DRAWDOWN",    analysis.risk_analysis.drawdown_assessment],
                ["SL / TP",     analysis.risk_analysis.sl_tp_assessment],
                ["CONSISTENCY", analysis.risk_analysis.consistency_assessment],
                ["OVERALL",     analysis.risk_analysis.overall],
              ] as [string, string][]).map(([label, text]) => (
                <div key={label}>
                  <p className="text-[7px] font-black tracking-widest mb-0.5" style={{ color: "#334155" }}>{label}</p>
                  <p className="text-[9px] font-mono leading-relaxed" style={{ color: "#94a3b8" }}>{text}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* RECOMMENDATIONS */}
          {analysis.recommendations.length > 0 && (
            <Section title="推奨事項" color={CYAN}>
              {analysis.recommendations.map((r, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2 rounded"
                  style={{ background: `${CYAN}05`, border: `1px solid ${CYAN}15` }}>
                  <span className="text-[7px] font-black px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                    style={{
                      background: `${priorityColor(r.priority)}12`,
                      border:     `1px solid ${priorityColor(r.priority)}30`,
                      color:      priorityColor(r.priority),
                    }}>
                    {r.priority ?? "LOW"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] font-mono font-bold" style={{ color: "#94a3b8" }}>{r.action}</p>
                    {r.rationale && (
                      <p className="text-[8px] font-mono mt-0.5" style={{ color: "#475569" }}>{r.rationale}</p>
                    )}
                  </div>
                </div>
              ))}
            </Section>
          )}

        </div>
      )}

      {/* AI IMPROVEMENT PROPOSAL section (shown after analysis is loaded) */}
      {analysis && (
        <ImprovementSection
          strategyId={strategyId}
          analysisId={(analysis as AIAnalysis & { id?: string }).id ?? ""}
          requiresMoreData={analysis.confidence < 50}
        />
      )}

      </div> {/* end 詳細AI分析 */}

    </div>
  );
}

// ------------------------------------------------------------------
// ImprovementSection — AI Improvement Proposal
// ------------------------------------------------------------------

interface ChangeItem {
  field:      string;
  type:       "modify" | "add";
  from:       unknown;
  to:         unknown;
  reason:     string;
  confidence: number;
  fact_basis: string;
}
interface ExpectedEffects {
  hypothesis:     string;
  metric_targets: Record<string, string | undefined>;
}
interface AIImprovement {
  id?:               string;
  changes:           ChangeItem[];
  expected_effects:  ExpectedEffects;
  risks:             string[];
  proposed_spec?:    unknown;
  confidence:        number;
  requires_more_data: boolean;
  status?:           "PROPOSED" | "APPLIED" | "REJECTED";
}

function ImprovementSection({ strategyId, analysisId, requiresMoreData }: {
  strategyId:      string;
  analysisId:      string;
  requiresMoreData: boolean;
}) {
  const [state,       setState]       = useState<"idle" | "loading" | "generating" | "done" | "error" | "rejected">("loading");
  const [improvement, setImprovement] = useState<AIImprovement | null>(null);
  const [errMsg,      setErrMsg]      = useState("");
  const [improvId,    setImprovId]    = useState<string | null>(null);

  // Load existing proposal on mount
  useEffect(() => {
    fetch(`/api/strategies/${strategyId}/improve`)
      .then(r => r.json())
      .then((d: { status: string; improvement?: AIImprovement }) => {
        if (d.status === "HAS_PROPOSAL" && d.improvement) {
          setImprovement(d.improvement);
          setImprovId(d.improvement.id ?? null);
          setState("done");
        } else {
          setState("idle");
        }
      })
      .catch(() => setState("idle"));
  }, [strategyId]);

  const generate = async () => {
    if (!analysisId) { setErrMsg("No analysis ID — run analysis first."); setState("error"); return; }
    setState("generating");
    setErrMsg("");
    try {
      const res  = await fetch(`/api/strategies/${strategyId}/improve`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ analysisId }),
      });
      const data = await res.json() as { improvementId?: string; improvement?: AIImprovement; error?: string };
      if (!res.ok || !data.improvement) {
        setErrMsg(data.error ?? "Generation failed");
        setState("error");
      } else {
        setImprovement(data.improvement);
        setImprovId(data.improvementId ?? null);
        setState("done");
      }
    } catch (err) {
      setErrMsg(String(err));
      setState("error");
    }
  };

  const reject = async () => {
    if (!improvId) return;
    try {
      await fetch(`/api/strategies/${strategyId}/improve`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ improvementId: improvId, status: "REJECTED" }),
      });
      setState("rejected");
      setImprovement(null);
    } catch { /* ignore */ }
  };

  if (state === "loading") return null;

  return (
    <div className="space-y-4 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>

      {/* Header + Generate button */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[8px] font-black tracking-[0.25em]" style={{ color: PURPLE }}>
          AI IMPROVEMENT PROPOSAL
        </p>
        <button
          onClick={generate}
          disabled={state === "generating"}
          className="px-4 py-2 rounded font-mono font-black text-[9px] tracking-widest transition-all shrink-0"
          style={{
            background: state === "generating"
              ? "rgba(255,255,255,0.04)"
              : "rgba(167,139,250,0.10)",
            border:  `1px solid ${state === "generating" ? "rgba(255,255,255,0.08)" : "rgba(167,139,250,0.35)"}`,
            color:   state === "generating" ? "#334155" : PURPLE,
            cursor:  state === "generating" ? "not-allowed" : "pointer",
          }}>
          {state === "generating"
            ? "◌ 生成中..."
            : improvement ? "↺ 再生成" : "⬡ 改善提案を生成"}
        </button>
      </div>

      {errMsg && (
        <p className="text-[9px] font-mono" style={{ color: RED }}>{errMsg}</p>
      )}

      {state === "rejected" && (
        <p className="text-[9px] font-mono" style={{ color: "#475569" }}>
          提案を却下しました。新しい提案を生成してください。
        </p>
      )}

      {/* Proposal display */}
      {improvement && state === "done" && (
        <div className="space-y-4">

          {/* Requires more data warning */}
          {(improvement.requires_more_data || requiresMoreData) && (
            <div className="flex items-start gap-2 px-3 py-2 rounded"
              style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.25)" }}>
              <span style={{ color: AMBER }}>⚠</span>
              <div>
                <p className="text-[8px] font-black tracking-widest" style={{ color: AMBER }}>
                  サンプル数不足
                </p>
                <p className="text-[8px] font-mono mt-0.5" style={{ color: "#64748b" }}>
                  統計的根拠が弱い状態です。これらの変更はあくまで仮説であり、改善が保証されるものではありません。
                </p>
              </div>
            </div>
          )}

          {/* Proposed Changes */}
          <div>
            <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: PURPLE }}>
              提案された変更 ({improvement.changes.length}件)
            </p>
            <div className="space-y-2">
              {improvement.changes.map((c, i) => (
                <div key={i} className="px-3 py-3 rounded"
                  style={{ background: "rgba(167,139,250,0.05)", border: "1px solid rgba(167,139,250,0.15)" }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="text-[8px] font-black font-mono tracking-widest" style={{ color: PURPLE }}>
                      {c.type === "add" ? "＋ ADD CONDITION" : `~ ${c.field}`}
                    </span>
                    <span className="text-[7px] font-black px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.25)", color: PURPLE }}>
                      {Math.round(c.confidence * 100)}%
                    </span>
                  </div>
                  {c.type === "modify" && (
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[9px] font-mono font-bold" style={{ color: RED }}>
                        {JSON.stringify(c.from)}
                      </span>
                      <span className="text-[8px]" style={{ color: "#334155" }}>→</span>
                      <span className="text-[9px] font-mono font-bold" style={{ color: NG }}>
                        {JSON.stringify(c.to)}
                      </span>
                    </div>
                  )}
                  {c.type === "add" && (
                    <p className="text-[8px] font-mono mb-1.5" style={{ color: "#94a3b8" }}>
                      {JSON.stringify(c.to)}
                    </p>
                  )}
                  <p className="text-[8px] font-mono leading-relaxed" style={{ color: "#64748b" }}>
                    {c.reason}
                  </p>
                  <p className="text-[7px] font-mono mt-1" style={{ color: "#334155" }}>
                    Basis: {c.fact_basis}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Expected Effects */}
          <div className="px-3 py-3 rounded"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: "#64748b" }}>
              期待される効果（仮説）
            </p>
            <p className="text-[9px] font-mono leading-relaxed italic mb-2" style={{ color: "#94a3b8" }}>
              {improvement.expected_effects.hypothesis}
            </p>
            {Object.entries(improvement.expected_effects.metric_targets).map(([k, v]) =>
              v ? (
                <div key={k} className="flex items-start gap-2">
                  <span className="text-[7px] font-mono tracking-widest w-24 shrink-0 mt-0.5"
                    style={{ color: "#334155" }}>
                    {k.toUpperCase()}
                  </span>
                  <span className="text-[8px] font-mono" style={{ color: "#64748b" }}>{v}</span>
                </div>
              ) : null
            )}
          </div>

          {/* Risks */}
          {improvement.risks.length > 0 && (
            <div>
              <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: RED }}>RISKS</p>
              <div className="space-y-1">
                {improvement.risks.map((r, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-[8px] shrink-0 mt-0.5" style={{ color: RED }}>•</span>
                    <p className="text-[8px] font-mono" style={{ color: "#64748b" }}>{r}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Confidence */}
          <div className="flex items-center gap-3">
            <p className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>
              提案の信頼度
            </p>
            <div className="flex-1 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div className="h-full rounded-full"
                style={{ width: `${improvement.confidence}%`, background: PURPLE }} />
            </div>
            <span className="text-[9px] font-mono font-bold shrink-0" style={{ color: PURPLE }}>
              {improvement.confidence}
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1">
            {/* APPLY: disabled in Phase 3-B */}
            <div className="relative flex-1">
              <button
                disabled
                className="w-full h-9 rounded font-mono font-black text-[9px] tracking-widest cursor-not-allowed"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border:     "1px solid rgba(255,255,255,0.06)",
                  color:      "#334155",
                }}>
                適用 & バックテスト
              </button>
              <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[6px] font-black px-1 rounded whitespace-nowrap"
                style={{ background: "#1e1b4b", color: PURPLE, border: "1px solid rgba(167,139,250,0.30)" }}>
                PHASE 3-C
              </span>
            </div>

            <button
              onClick={reject}
              className="px-4 h-9 rounded font-mono text-[9px] tracking-widest transition-all"
              style={{
                background: "rgba(255,68,102,0.06)",
                border:     "1px solid rgba(255,68,102,0.20)",
                color:      RED,
              }}>
              REJECT
            </button>
          </div>

        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// CrossPhaseInterpretationSection — Phase 4-D AI Interpretation
// ANALYSISタブ内。全フェーズ Optional (Graceful Degradation)。
// STRICTLY READ-ONLY: strategy_phase4d_interpretations のみ書き込む
// Confidence はコードで決定論的に計算。将来予測・パラメータ推奨禁止。
// ------------------------------------------------------------------

const P4D_COLOR   = "#38bdf8";
const P4D_COLOR_r = "rgba(56,189,248,";

type P4DPhase = "BACKTEST_ANALYSIS" | "OPTIMIZATION" | "WALK_FORWARD" | "MONTE_CARLO";
type SynthType = "CONVERGENCE" | "DIVERGENCE" | "UNCERTAINTY";
type RiskDim   = "SEQUENCE_RISK" | "OOS_GENERALIZATION" | "DRAWDOWN_RISK" | "SAMPLE_QUALITY" | "PARAMETER_STABILITY";

interface P4DPhaseObs {
  phase:           P4DPhase;
  observation:     string;
  supporting_data: string;
}
interface P4DCrossSynthesis {
  type:             SynthType;
  observation:      string;
  phases_involved:  P4DPhase[];
}
interface P4DRiskDimension {
  dimension:   RiskDim;
  assessment:  string;
  data_source: string;
}
interface P4DInterpretation {
  id?:                     string;
  available_phases?:       P4DPhase[];
  confidence?:             number;
  overall_assessment?:     string;
  phase_observations?:     P4DPhaseObs[];
  cross_phase_synthesis?:  P4DCrossSynthesis[];
  risk_dimensions?:        P4DRiskDimension[];
  limitations?:            string[];
  data_completeness_note?: string;
  integrity_violations?:   string[];
  // camelCase (from POST response)
  availablePhases?:        P4DPhase[];
  overallAssessment?:      string;
  phaseObservations?:      P4DPhaseObs[];
  crossPhaseSynthesis?:    P4DCrossSynthesis[];
  riskDimensions?:         P4DRiskDimension[];
  dataCompletenessNote?:   string;
  integrityViolations?:    number;
}

function normaliseP4D(d: P4DInterpretation): P4DInterpretation {
  return {
    id:                    d.id,
    available_phases:      d.available_phases ?? d.availablePhases ?? [],
    confidence:            d.confidence,
    overall_assessment:    d.overall_assessment ?? d.overallAssessment ?? "",
    phase_observations:    d.phase_observations ?? d.phaseObservations ?? [],
    cross_phase_synthesis: d.cross_phase_synthesis ?? d.crossPhaseSynthesis ?? [],
    risk_dimensions:       d.risk_dimensions ?? d.riskDimensions ?? [],
    limitations:           d.limitations ?? [],
    data_completeness_note: d.data_completeness_note ?? d.dataCompletenessNote ?? "",
    integrity_violations:  d.integrity_violations ?? [],
  };
}

const ALL_PHASES: P4DPhase[] = ["BACKTEST_ANALYSIS", "OPTIMIZATION", "WALK_FORWARD", "MONTE_CARLO"];
const SYNTH_COLORS: Record<SynthType, string> = {
  CONVERGENCE: NG,
  DIVERGENCE:  AMBER,
  UNCERTAINTY: "#64748b",
};
const RISK_LABELS: Record<RiskDim, string> = {
  SEQUENCE_RISK:       "Sequence Risk",
  OOS_GENERALIZATION:  "OOS Generalization",
  DRAWDOWN_RISK:       "Drawdown Risk",
  SAMPLE_QUALITY:      "Sample Quality",
  PARAMETER_STABILITY: "Parameter Stability",
};

function CrossPhaseInterpretationSection({ strategyId }: { strategyId: string }) {
  const [state,  setState]  = useState<"loading" | "idle" | "running" | "done" | "error">("loading");
  const [result, setResult] = useState<P4DInterpretation | null>(null);
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    fetch(`/api/strategies/${strategyId}/interpret`)
      .then(r => r.json())
      .then((d: { status: string; interpretation?: P4DInterpretation }) => {
        if (d.status === "HAS_INTERPRETATION" && d.interpretation) {
          setResult(normaliseP4D(d.interpretation));
          setState("done");
        } else {
          setState("idle");
        }
      })
      .catch(() => setState("idle"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  const run = async () => {
    setState("running");
    setErrMsg("");
    try {
      const res  = await fetch(`/api/strategies/${strategyId}/interpret`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      const data = await res.json() as P4DInterpretation & { error?: string };
      if (!res.ok || data.error) {
        setErrMsg(String(data.error ?? "Interpretation failed"));
        setState("error");
      } else {
        setResult(normaliseP4D(data));
        setState("done");
      }
    } catch (e) {
      setErrMsg(String(e));
      setState("error");
    }
  };

  if (state === "loading") return null;

  const r = result;
  const avail = r?.available_phases ?? [];

  return (
    <div className="mt-4 p-4 rounded" style={{ background: `${P4D_COLOR_r}0.04)`, border: `1px solid ${P4D_COLOR_r}0.15)` }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 rounded-full" style={{ background: P4D_COLOR }} />
          <span className="text-[10px] font-black tracking-widest" style={{ color: P4D_COLOR }}>
            CROSS-PHASE INTERPRETATION
          </span>
          {r?.integrity_violations && r.integrity_violations.length > 0 && (
            <span className="text-[7px] font-mono px-1.5 py-0.5 rounded" style={{ background: `${AMBER}15`, color: AMBER }}>
              {r.integrity_violations.length} 整合性警告
            </span>
          )}
        </div>
        {r?.confidence !== undefined && (
          <span className="text-[9px] font-black font-mono" style={{ color: confColor(r.confidence) }}>
            {r.confidence}% 信頼度
          </span>
        )}
      </div>

      <p className="text-[7px] font-mono mb-3" style={{ color: "#475569" }}>
        全検証フェーズのAI統合分析。予測エンジンではありません。売買シグナルではありません。
      </p>

      {/* Phase indicators */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {ALL_PHASES.map(ph => {
          const active = avail.includes(ph) || (state === "idle" && !r);
          const isActive = r ? avail.includes(ph) : false;
          return (
            <span key={ph} className="text-[7px] font-black tracking-wider px-1.5 py-0.5 rounded"
              style={{
                background: isActive ? `${P4D_COLOR}15` : "rgba(255,255,255,0.03)",
                border:     `1px solid ${isActive ? P4D_COLOR + "40" : "rgba(255,255,255,0.06)"}`,
                color:      isActive ? P4D_COLOR : "#334155",
              }}>
              {PHASE_LABELS[ph]}
              <span className="ml-1">{isActive ? "✓" : "–"}</span>
            </span>
          );
        })}
      </div>

      {/* Run button */}
      <button
        onClick={run}
        disabled={state === "running"}
        className="text-[9px] font-black tracking-widest px-3 py-1.5 rounded transition-opacity"
        style={{
          background: `${P4D_COLOR_r}0.12)`,
          border:     `1px solid ${P4D_COLOR_r}0.35)`,
          color:      P4D_COLOR,
          opacity:    state === "running" ? 0.5 : 1,
        }}>
        {state === "running" ? "◌ 解釈中..." : state === "done" ? "↺ 再解釈" : "▶ 解釈実行"}
      </button>

      {errMsg && (
        <p className="mt-2 text-[8px] font-mono" style={{ color: RED }}>{errMsg}</p>
      )}

      {/* Results */}
      {state === "done" && r && (
        <div className="mt-4 space-y-4">
          {/* Overall Assessment */}
          {r.overall_assessment && (
            <div>
              <p className="text-[8px] font-black tracking-widest mb-1" style={{ color: "#64748b" }}>総合評価</p>
              <p className="text-[9px] font-mono leading-relaxed" style={{ color: "#94a3b8" }}>{r.overall_assessment}</p>
            </div>
          )}

          {/* Phase Observations */}
          {r.phase_observations && r.phase_observations.length > 0 && (
            <div>
              <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>フェーズ別観察</p>
              <div className="space-y-2">
                {r.phase_observations.map((obs, i) => (
                  <div key={i} className="p-2 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[7px] font-black tracking-wider" style={{ color: P4D_COLOR }}>
                        {PHASE_LABELS[obs.phase] ?? obs.phase}
                      </span>
                    </div>
                    <p className="text-[8px] font-mono" style={{ color: "#94a3b8" }}>{obs.observation}</p>
                    <p className="text-[7px] font-mono mt-0.5" style={{ color: "#475569" }}>{obs.supporting_data}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cross-Phase Synthesis */}
          {r.cross_phase_synthesis && r.cross_phase_synthesis.length > 0 && (
            <div>
              <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>クロスフェーズ統合</p>
              <div className="space-y-2">
                {r.cross_phase_synthesis.map((syn, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-[7px] font-black tracking-widest mt-0.5 shrink-0"
                      style={{ color: SYNTH_COLORS[syn.type] ?? "#64748b" }}>
                      {syn.type}
                    </span>
                    <p className="text-[8px] font-mono" style={{ color: "#94a3b8" }}>{syn.observation}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Risk Dimensions */}
          {r.risk_dimensions && r.risk_dimensions.length > 0 && (
            <div>
              <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>リスク分析</p>
              <div className="space-y-1.5">
                {r.risk_dimensions.map((rd, i) => (
                  <div key={i} className="p-2 rounded" style={{ background: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.04)" }}>
                    <p className="text-[7px] font-black tracking-widest mb-0.5" style={{ color: AMBER }}>
                      {RISK_LABELS[rd.dimension] ?? rd.dimension}
                    </p>
                    <p className="text-[8px] font-mono" style={{ color: "#94a3b8" }}>{rd.assessment}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Limitations */}
          {r.limitations && r.limitations.length > 0 && (
            <div>
              <p className="text-[8px] font-black tracking-widest mb-1" style={{ color: "#64748b" }}>制限事項</p>
              <div className="space-y-1">
                {r.limitations.map((lim, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className="text-[7px] shrink-0 mt-0.5" style={{ color: "#334155" }}>•</span>
                    <p className="text-[7px] font-mono" style={{ color: "#475569" }}>{lim}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          {r.data_completeness_note && (
            <p className="text-[7px] font-mono" style={{ color: "#1e293b" }}>
              {r.data_completeness_note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// OptimizeTab — Parameter Optimization (Phase 4-A)
// ------------------------------------------------------------------

const GOLD = "#f59e0b";
const GOLD_r = "rgba(245,158,11,";

interface OptimizableParam {
  field:         string;
  label:         string;
  currentValue:  number;
  defaultMin:    number;
  defaultMax:    number;
  defaultStep:   number;
  paramType:     "integer" | "float";
}

interface ParamRangeState {
  field:     string;
  min:       string;
  max:       string;
  step:      string;
  paramType: "integer" | "float";
  enabled:   boolean;
}

interface OACandidate {
  rank:               number;
  param_set:          Record<string, number>;
  is_total_trades:    number;
  is_win_rate:        number;
  is_profit_factor:   number | null;
  is_total_pips:      number;
  is_max_dd_pct:      number;
  oos_total_trades:   number;
  oos_win_rate:       number;
  oos_profit_factor:  number | null;
  oos_total_pips:     number;
  oos_max_dd_pct:     number;
  stability_score:    number;
  degradation_ratio:  number | null;
  sample_status:      "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT";
  adopted:            boolean;
}

interface OAJob {
  id:                 string;
  status:             string;
  total_combinations: number | null;
  in_sample_bars:     number | null;
  out_sample_bars:    number | null;
  in_sample_ratio:    number;
  out_sample_from:    string | null;
  summary:            {
    stableZoneCount: number;
    robustCount:     number;
  } | null;
  created_at:         string;
  error_message:      string | null;
}

function detectOptimizableParams(strategy: StrategyRecord): OptimizableParam[] {
  const ec = strategy.entry_conditions as {
    conditions: Array<{ indicator: string; threshold?: number; period?: number }>
  };
  const exit = strategy.exit_conditions as {
    stop_loss?: { multiplier?: number; pips?: number };
    take_profit?: { rr_ratio?: number; pips?: number };
  } | null;
  const filters = strategy.filters as { max_spread_pips?: number; min_adx?: number } | null;

  const params: OptimizableParam[] = [];

  (ec.conditions ?? []).forEach((c, i) => {
    if (c.threshold !== undefined) {
      const v = c.threshold;
      const step = ["RSI", "STOCHASTIC", "ADX"].includes(c.indicator) ? 5 : 1;
      params.push({
        field:        `entry_conditions.conditions[${i}].threshold`,
        label:        `${c.indicator}[${i}] threshold (cur: ${v})`,
        currentValue: v,
        defaultMin:   Math.max(1, Math.round(v - 10)),
        defaultMax:   Math.round(v + 10),
        defaultStep:  step,
        paramType:    "integer",
      });
    }
    if (c.period !== undefined) {
      const v = c.period;
      params.push({
        field:        `entry_conditions.conditions[${i}].period`,
        label:        `${c.indicator}[${i}] period (cur: ${v})`,
        currentValue: v,
        defaultMin:   Math.max(2, Math.floor(v * 0.6)),
        defaultMax:   Math.ceil(v * 1.6),
        defaultStep:  1,
        paramType:    "integer",
      });
    }
  });

  if (exit?.stop_loss?.multiplier !== undefined) {
    const v = exit.stop_loss.multiplier;
    params.push({
      field: "exit_conditions.stop_loss.multiplier",
      label: `SL multiplier (cur: ${v})`,
      currentValue: v, defaultMin: 0.5, defaultMax: 3.0, defaultStep: 0.25, paramType: "float",
    });
  }
  if (exit?.take_profit?.rr_ratio !== undefined) {
    const v = exit.take_profit.rr_ratio;
    params.push({
      field: "exit_conditions.take_profit.rr_ratio",
      label: `TP R:R ratio (cur: ${v})`,
      currentValue: v, defaultMin: 1.0, defaultMax: 3.0, defaultStep: 0.2, paramType: "float",
    });
  }
  if (exit?.stop_loss?.pips !== undefined) {
    const v = exit.stop_loss.pips;
    params.push({
      field: "exit_conditions.stop_loss.pips",
      label: `SL pips (cur: ${v})`,
      currentValue: v, defaultMin: Math.max(5, v - 20), defaultMax: v + 30, defaultStep: 5, paramType: "integer",
    });
  }
  if (exit?.take_profit?.pips !== undefined) {
    const v = exit.take_profit.pips;
    params.push({
      field: "exit_conditions.take_profit.pips",
      label: `TP pips (cur: ${v})`,
      currentValue: v, defaultMin: Math.max(10, v - 30), defaultMax: v + 50, defaultStep: 10, paramType: "integer",
    });
  }
  if (filters?.min_adx !== undefined) {
    const v = filters.min_adx;
    params.push({
      field: "filters.min_adx",
      label: `Min ADX (cur: ${v})`,
      currentValue: v, defaultMin: 15, defaultMax: 40, defaultStep: 5, paramType: "integer",
    });
  }
  if (filters?.max_spread_pips !== undefined) {
    const v = filters.max_spread_pips;
    params.push({
      field: "filters.max_spread_pips",
      label: `Max spread pips (cur: ${v})`,
      currentValue: v, defaultMin: 1.0, defaultMax: 5.0, defaultStep: 0.5, paramType: "float",
    });
  }

  return params;
}

function countCombos(ranges: ParamRangeState[]): number {
  const enabled = ranges.filter(r => r.enabled);
  if (enabled.length === 0) return 0;
  return enabled.reduce((acc, r) => {
    const min  = parseFloat(r.min);
    const max  = parseFloat(r.max);
    const step = parseFloat(r.step);
    if (!isFinite(min) || !isFinite(max) || !isFinite(step) || step <= 0 || min >= max) return acc;
    return acc * (Math.floor((max - min) / step) + 1);
  }, 1);
}

function pfStr(pf: number | null): string {
  return pf === null ? "∞" : pf.toFixed(2);
}

function sampleBadge(status: "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT"): { label: string; color: string } {
  if (status === "NORMAL")       return { label: "OK",       color: NG };
  if (status === "LOW_SAMPLE")   return { label: "LOW",      color: AMBER };
  return                                { label: "INSUF",    color: RED };
}

function OptimizeTab({ strategy }: { strategy: StrategyRecord }) {
  const [detectedParams, setDetectedParams] = useState<OptimizableParam[]>([]);
  const [ranges,         setRanges]         = useState<ParamRangeState[]>([]);
  const [inSampleRatio,  setInSampleRatio]  = useState("0.8");
  const [state,          setState]          = useState<"idle" | "running" | "done" | "error">("idle");
  const [jobData,        setJobData]        = useState<OAJob | null>(null);
  const [candidates,     setCandidates]     = useState<OACandidate[]>([]);
  const [errMsg,         setErrMsg]         = useState("");
  const [applying,       setApplying]       = useState<number | null>(null);
  const [applyMsg,       setApplyMsg]       = useState("");

  // Detect params and load existing job on mount
  useEffect(() => {
    const params = detectOptimizableParams(strategy);
    setDetectedParams(params);
    setRanges(params.map(p => ({
      field:     p.field,
      min:       String(p.defaultMin),
      max:       String(p.defaultMax),
      step:      String(p.defaultStep),
      paramType: p.paramType,
      enabled:   false,
    })));

    fetch(`/api/strategies/${strategy.id}/optimize`)
      .then(r => r.json())
      .then((d: { status: string; job?: OAJob; candidates?: OACandidate[] }) => {
        if (d.status === "HAS_RESULT" && d.job && d.candidates) {
          setJobData(d.job);
          setCandidates(d.candidates);
          setState("done");
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id]);

  const comboCount = React.useMemo(() => countCombos(ranges), [ranges]);

  const toggleRange = (idx: number) => {
    setRanges(prev => prev.map((r, i) => i === idx ? { ...r, enabled: !r.enabled } : r));
  };

  const updateRange = (idx: number, key: keyof ParamRangeState, val: string) => {
    setRanges(prev => prev.map((r, i) => i === idx ? { ...r, [key]: val } : r));
  };

  const run = async () => {
    const enabled = ranges.filter(r => r.enabled);
    if (enabled.length === 0) { setErrMsg("Optimize 対象の Parameter を1つ以上選択してください"); return; }
    const ratio = parseFloat(inSampleRatio);
    if (!isFinite(ratio) || ratio <= 0 || ratio >= 1) { setErrMsg("In-Sample Ratio は 0〜1 の間で指定してください"); return; }
    if (comboCount === 0) { setErrMsg("有効な Parameter Range を設定してください"); return; }
    if (comboCount > 5000) { setErrMsg(`組み合わせ数が多すぎます (${comboCount})。Step を大きくするか Range を狭めてください`); return; }

    setState("running");
    setErrMsg("");
    setApplyMsg("");

    try {
      const parameterRanges = enabled.map(r => ({
        field:     r.field,
        min:       parseFloat(r.min),
        max:       parseFloat(r.max),
        step:      parseFloat(r.step),
        paramType: r.paramType,
      }));

      const res  = await fetch(`/api/strategies/${strategy.id}/optimize`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ parameterRanges, inSampleRatio: ratio }),
      });
      const data = await res.json() as {
        jobId?: string;
        candidates?: OACandidate[];
        summary?: OAJob["summary"];
        totalCombinations?: number;
        inSampleBars?: number;
        outSampleBars?: number;
        cutoffTime?: number;
        error?: string;
      };

      if (!res.ok || data.error) {
        setErrMsg(data.error ?? "Optimization failed");
        setState("error");
      } else {
        setJobData({
          id: data.jobId ?? "",
          status: "COMPLETED",
          total_combinations: data.totalCombinations ?? null,
          in_sample_bars: data.inSampleBars ?? null,
          out_sample_bars: data.outSampleBars ?? null,
          in_sample_ratio: ratio,
          out_sample_from: data.cutoffTime ? new Date(data.cutoffTime).toISOString() : null,
          summary: data.summary ?? null,
          created_at: new Date().toISOString(),
          error_message: null,
        });
        setCandidates(data.candidates ?? []);
        setState("done");
      }
    } catch (err) {
      setErrMsg(String(err));
      setState("error");
    }
  };

  const apply = async (rank: number) => {
    if (!jobData?.id) return;
    setApplying(rank);
    setApplyMsg("");
    try {
      const res  = await fetch(`/api/strategies/${strategy.id}/optimize/${jobData.id}/apply`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ candidateRank: rank }),
      });
      const data = await res.json() as {
        versionNumber?: number;
        backtestJobId?: string;
        error?: string;
      };

      if (!res.ok || data.error) {
        setApplyMsg(`APPLY 失敗: ${data.error ?? "error"}`);
      } else {
        setApplyMsg(`v${data.versionNumber} として適用しました。Backtest Job: ${data.backtestJobId ?? "—"}`);
        setCandidates(prev => prev.map(c => c.rank === rank ? { ...c, adopted: true } : c));
      }
    } catch (err) {
      setApplyMsg(String(err));
    } finally {
      setApplying(null);
    }
  };

  const noParams = detectedParams.length === 0;

  return (
    <div className="p-5 space-y-5 overflow-y-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-[8px] font-black tracking-[0.25em]" style={{ color: GOLD }}>
          パラメーター最適化
        </p>
        <span className="text-[7px] font-mono px-2 py-0.5 rounded"
          style={{ background: `${GOLD_r}0.08)`, border: `1px solid ${GOLD_r}0.20)`, color: GOLD }}>
          グリッドサーチ · 決定論的
        </span>
      </div>

      {noParams && (
        <div className="flex items-center justify-center h-24">
          <p className="text-[9px] font-mono text-center" style={{ color: "#334155" }}>
            このStrategyには最適化可能な数値Parameterがありません。
          </p>
        </div>
      )}

      {!noParams && (
        <>
          {/* Parameter selection */}
          <div className="space-y-2">
            <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>
              パラメーター選択
            </p>
            {ranges.map((r, idx) => {
              const label = detectedParams[idx]?.label ?? r.field;
              return (
                <div key={r.field} className="rounded overflow-hidden"
                  style={{ border: `1px solid ${r.enabled ? `${GOLD_r}0.25)` : "rgba(255,255,255,0.06)"}`, background: r.enabled ? `${GOLD_r}0.03)` : "rgba(255,255,255,0.01)" }}>
                  {/* Toggle row */}
                  <div
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer"
                    onClick={() => toggleRange(idx)}>
                    <div className="w-4 h-4 rounded shrink-0 flex items-center justify-center"
                      style={{ background: r.enabled ? GOLD : "rgba(255,255,255,0.06)", border: `1px solid ${r.enabled ? GOLD : "rgba(255,255,255,0.12)"}` }}>
                      {r.enabled && <span className="text-[8px] font-black" style={{ color: "#000" }}>✓</span>}
                    </div>
                    <span className="text-[8px] font-mono" style={{ color: r.enabled ? "#94a3b8" : "#475569" }}>
                      {label}
                    </span>
                  </div>

                  {/* Range inputs */}
                  {r.enabled && (
                    <div className="flex items-center gap-2 px-3 pb-2">
                      {(["min", "max", "step"] as const).map(key => (
                        <div key={key} className="flex items-center gap-1">
                          <span className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>{key.toUpperCase()}</span>
                          <input
                            type="number"
                            value={r[key] as string}
                            onChange={e => updateRange(idx, key, e.target.value)}
                            className="w-16 px-1.5 py-1 rounded text-[9px] font-mono text-right outline-none"
                            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8" }}
                            step={r.paramType === "float" ? "0.01" : "1"}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Settings row */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[8px] font-mono tracking-widest" style={{ color: "#334155" }}>サンプル内比率</span>
              <input
                type="number" value={inSampleRatio} onChange={e => setInSampleRatio(e.target.value)}
                min="0.5" max="0.95" step="0.05"
                className="w-16 px-1.5 py-1 rounded text-[9px] font-mono text-right outline-none"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8" }}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[7px] font-mono" style={{ color: "#334155" }}>組み合わせ数</span>
              <span className="text-[10px] font-black font-mono"
                style={{ color: comboCount > 5000 ? RED : comboCount > 1000 ? AMBER : NG }}>
                {comboCount.toLocaleString()}
              </span>
              {comboCount > 5000 && <span className="text-[7px]" style={{ color: RED }}>MAX 5000</span>}
            </div>
          </div>

          {/* Run button */}
          <button
            onClick={run}
            disabled={state === "running" || comboCount === 0 || comboCount > 5000}
            className="w-full h-10 rounded font-mono font-black text-[11px] tracking-widest transition-all"
            style={{
              background: state === "running"
                ? "rgba(255,255,255,0.03)"
                : `linear-gradient(135deg, ${GOLD_r}0.15) 0%, ${GOLD_r}0.07) 100%)`,
              border:  `1px solid ${state === "running" ? "rgba(255,255,255,0.06)" : `${GOLD_r}0.35)`}`,
              color:   state === "running" ? "#334155" : GOLD,
              cursor:  (state === "running" || comboCount === 0) ? "not-allowed" : "pointer",
            }}>
            {state === "running" ? "◌ 最適化中..." : state === "done" ? "↺ 再実行" : "▶ 最適化実行"}
          </button>

          {errMsg && (
            <p className="text-[9px] font-mono" style={{ color: RED }}>{errMsg}</p>
          )}
        </>
      )}

      {/* Results */}
      {state === "done" && candidates.length > 0 && (
        <div className="space-y-3">
          {/* Summary bar */}
          {jobData?.summary && (
            <div className="flex gap-4 px-3 py-2 rounded"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div>
                <p className="text-[7px] font-mono" style={{ color: "#334155" }}>TOTAL</p>
                <p className="text-[10px] font-black font-mono" style={{ color: "#64748b" }}>
                  {(jobData.total_combinations ?? 0).toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-[7px] font-mono" style={{ color: "#334155" }}>安定ゾーン</p>
                <p className="text-[10px] font-black font-mono" style={{ color: GOLD }}>
                  {jobData.summary.stableZoneCount}
                </p>
              </div>
              <div>
                <p className="text-[7px] font-mono" style={{ color: "#334155" }}>ROBUST</p>
                <p className="text-[10px] font-black font-mono" style={{ color: NG }}>
                  {jobData.summary.robustCount}
                </p>
              </div>
              <div className="ml-auto text-right">
                <p className="text-[7px] font-mono" style={{ color: "#334155" }}>ISバー数</p>
                <p className="text-[9px] font-mono" style={{ color: "#475569" }}>
                  {(jobData.in_sample_bars ?? 0).toLocaleString()} / {((jobData.in_sample_bars ?? 0) + (jobData.out_sample_bars ?? 0)).toLocaleString()}
                </p>
              </div>
            </div>
          )}

          <p className="text-[8px] font-black tracking-[0.22em]" style={{ color: GOLD }}>
            上位候補
          </p>

          {applyMsg && (
            <div className="px-3 py-2 rounded text-[9px] font-mono"
              style={{ background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.20)", color: NG }}>
              {applyMsg}
            </div>
          )}

          {/* Column headers */}
          <div className="grid text-[7px] font-mono tracking-widest px-3"
            style={{ gridTemplateColumns: "40px 1fr 80px 80px 50px 70px", color: "#1e293b" }}>
            <span>順位</span>
            <span>パラメーター</span>
            <span className="text-center">IS指標</span>
            <span className="text-center">OOS指標</span>
            <span className="text-center">安定性</span>
            <span className="text-right">操作</span>
          </div>

          {/* Candidate rows */}
          <div className="space-y-1.5">
            {candidates.map(c => {
              const badge   = sampleBadge(c.sample_status);
              const isApply = applying === c.rank;
              const oosPips = c.oos_total_pips;
              const oosPFn  = c.oos_profit_factor;
              const stab    = c.stability_score;
              const stabCol = stab >= 0.6 ? NG : stab >= 0.4 ? AMBER : RED;
              const oosCol  = oosPips > 0 ? NG : RED;
              const degradStr = c.degradation_ratio !== null
                ? `${(c.degradation_ratio * 100).toFixed(0)}%`
                : "—";

              return (
                <div key={c.rank} className="rounded overflow-hidden"
                  style={{ background: c.adopted ? "rgba(0,255,136,0.04)" : "rgba(255,255,255,0.02)", border: `1px solid ${c.adopted ? "rgba(0,255,136,0.20)" : "rgba(255,255,255,0.06)"}` }}>
                  {/* Main row */}
                  <div className="grid items-center gap-2 px-3 py-2"
                    style={{ gridTemplateColumns: "40px 1fr 80px 80px 50px 70px" }}>
                    {/* Rank */}
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] font-black font-mono" style={{ color: c.rank <= 3 ? GOLD : "#475569" }}>
                        #{c.rank}
                      </span>
                    </div>

                    {/* Params */}
                    <div className="min-w-0">
                      {Object.entries(c.param_set).map(([field, val]) => {
                        const short = field
                          .replace(/^entry_conditions\.conditions\[(\d+)\]\./, "[$1].")
                          .replace(/^exit_conditions\./, "exit.")
                          .replace(/^filters\./, "f.");
                        return (
                          <span key={field} className="inline-block text-[7px] font-mono mr-1.5"
                            style={{ color: "#64748b" }}>
                            {short}={val}
                          </span>
                        );
                      })}
                    </div>

                    {/* IS metrics */}
                    <div className="text-center">
                      <p className="text-[8px] font-mono font-bold" style={{ color: c.is_total_pips > 0 ? "#64748b" : "#334155" }}>
                        {c.is_total_pips >= 0 ? "+" : ""}{c.is_total_pips.toFixed(1)}p
                      </p>
                      <p className="text-[7px] font-mono" style={{ color: "#334155" }}>
                        PF {pfStr(c.is_profit_factor)} · {c.is_total_trades}T
                      </p>
                    </div>

                    {/* OOS metrics */}
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        <p className="text-[8px] font-mono font-bold" style={{ color: oosCol }}>
                          {oosPips >= 0 ? "+" : ""}{oosPips.toFixed(1)}p
                        </p>
                        <span className="text-[6px] font-black px-1 rounded"
                          style={{ background: `${badge.color}12`, color: badge.color }}>
                          {badge.label}
                        </span>
                      </div>
                      <p className="text-[7px] font-mono" style={{ color: "#334155" }}>
                        PF {pfStr(oosPFn)} · {c.oos_total_trades}T · {degradStr}
                      </p>
                    </div>

                    {/* Stability */}
                    <div className="text-center">
                      <p className="text-[9px] font-black font-mono" style={{ color: stabCol }}>
                        {(stab * 100).toFixed(0)}%
                      </p>
                      <div className="h-1 rounded-full mt-0.5" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="h-full rounded-full" style={{ width: `${stab * 100}%`, background: stabCol }} />
                      </div>
                    </div>

                    {/* Action */}
                    <div className="text-right">
                      {c.adopted ? (
                        <span className="text-[7px] font-black" style={{ color: NG }}>適用済み</span>
                      ) : c.sample_status === "INSUFFICIENT" ? (
                        <span className="text-[7px] font-mono" style={{ color: "#334155" }}>OOS不足</span>
                      ) : (
                        <button
                          onClick={() => apply(c.rank)}
                          disabled={isApply || applying !== null}
                          className="px-2 py-1 rounded text-[7px] font-black tracking-widest transition-all"
                          style={{
                            background: isApply ? "rgba(255,255,255,0.03)" : `${GOLD_r}0.10)`,
                            border:     `1px solid ${isApply ? "rgba(255,255,255,0.06)" : `${GOLD_r}0.30)`}`,
                            color:      isApply ? "#334155" : GOLD,
                            cursor:     isApply || applying !== null ? "not-allowed" : "pointer",
                          }}>
                          {isApply ? "..." : "適用"}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Insufficient warning */}
                  {c.sample_status === "INSUFFICIENT" && (
                    <div className="px-3 pb-2 text-[7px] font-mono" style={{ color: RED }}>
                      ⚠ OOS {c.oos_total_trades}件 — データ不足（最低15件必要）。適用不可。
                    </div>
                  )}
                  {c.sample_status === "LOW_SAMPLE" && (
                    <div className="px-3 pb-2 text-[7px] font-mono" style={{ color: AMBER }}>
                      ⚠ OOS {c.oos_total_trades} trades — LOW SAMPLE (30 recommended). 統計的信頼性が低い。
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[7px] font-mono" style={{ color: "#1e293b" }}>
            上位{candidates.length}件 / 全{(jobData?.total_combinations ?? candidates.length).toLocaleString()}候補 · IS = サンプル内 · OOS = サンプル外 · 劣化率 = OOS/IS PIPS比
          </p>
        </div>
      )}

      {/* Walk Forward Validation Section */}
      {ranges.some(r => r.enabled) && (
        <WalkForwardSection
          strategyId={strategy.id}
          enabledRanges={ranges.filter(r => r.enabled).map(r => ({
            field: r.field, min: parseFloat(r.min), max: parseFloat(r.max),
            step: parseFloat(r.step), paramType: r.paramType,
          }))}
        />
      )}

      {/* Monte Carlo Simulation Section (Phase 4-C) */}
      <MonteCarloSection strategyId={strategy.id} />

    </div>
  );
}

// ------------------------------------------------------------------
// WalkForwardSection — Walk Forward Validation (Phase 4-B)
// OPTIMIZEタブ内のセクション。APPLYボタンは含まない (User Approval必須)
// ------------------------------------------------------------------

const WF_BLUE = "#38bdf8";
const WF_BLUE_r = "rgba(56,189,248,";

interface WFWindowRow {
  windowIndex:    number;
  trainFrom:      number;
  trainTo:        number;
  testFrom:       number;
  testTo:         number;
  bestParamSet:   Record<string, number>;
  testMetrics:    { totalTrades: number; winRate: number; profitFactor: number | null; totalPips: number; maxDrawdownPct: number };
  sampleStatus:   "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT";
  trainOOSStatus: "NORMAL" | "LOW_SAMPLE" | "INSUFFICIENT";
  windowPassed:   boolean;
  skipped:        boolean;
}

interface WFResult {
  verdict:             "ROBUST" | "CONDITIONAL" | "OVERFIT" | "INCONCLUSIVE";
  consistencyScore:    number | null;
  parameterStability:  Record<string, number>;
  recommendedParams:   Record<string, number> | null;
  recommendedParamFreq: Record<string, Array<{ value: number; windowCount: number }>>;
  totalWindowCount:    number;
  validWindowCount:    number;
  normalWindowCount:   number;
  positiveWindowCount: number;
  skippedWindowCount:  number;
  windows:             WFWindowRow[];
}

function verdictColorWF(v: WFResult["verdict"]): string {
  if (v === "ROBUST") return NG;
  if (v === "CONDITIONAL") return AMBER;
  if (v === "OVERFIT") return RED;
  return "#64748b";
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function WalkForwardSection({
  strategyId,
  enabledRanges,
}: {
  strategyId:    string;
  enabledRanges: Array<{ field: string; min: number; max: number; step: number; paramType: "integer" | "float" }>;
}) {
  const [trainMonths,  setTrainMonths]  = useState("3");
  const [testMonths,   setTestMonths]   = useState("1");
  const [stepMonths,   setStepMonths]   = useState("1");
  const [state,        setState]        = useState<"idle" | "running" | "done" | "error">("idle");
  const [result,       setResult]       = useState<WFResult | null>(null);
  const [errMsg,       setErrMsg]       = useState("");
  const [showWindows,  setShowWindows]  = useState(false);
  const [latestJobId,  setLatestJobId]  = useState<string | null>(null);

  // Load existing WF job on mount
  useEffect(() => {
    fetch(`/api/strategies/${strategyId}/walk-forward`)
      .then(r => r.json())
      .then((d: { status: string; job?: WFResult & { id: string } }) => {
        if (d.status === "HAS_RESULT" && d.job) {
          setResult(d.job as unknown as WFResult);
          setLatestJobId((d.job as unknown as { id?: string }).id ?? null);
          setState("done");
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  const run = async () => {
    const tm = parseInt(trainMonths, 10);
    const te = parseInt(testMonths, 10);
    const sm = parseInt(stepMonths, 10);
    if (!Number.isInteger(tm) || tm < 1 || tm > 24) { setErrMsg("trainMonths: 1〜24の整数"); return; }
    if (!Number.isInteger(te) || te < 1 || te > 12) { setErrMsg("testMonths: 1〜12の整数"); return; }
    if (!Number.isInteger(sm) || sm < 1 || sm > 12) { setErrMsg("stepMonths: 1〜12の整数"); return; }

    setState("running");
    setErrMsg("");

    try {
      const res  = await fetch(`/api/strategies/${strategyId}/walk-forward`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          parameterRanges: enabledRanges,
          trainMonths: tm, testMonths: te, stepMonths: sm,
        }),
      });
      const data = await res.json() as (WFResult & { jobId?: string; error?: string });

      if (!res.ok || data.error) {
        setErrMsg(data.error ?? "Walk Forward failed");
        setState("error");
      } else {
        setResult(data);
        setLatestJobId(data.jobId ?? null);
        setState("done");
      }
    } catch (err) {
      setErrMsg(String(err));
      setState("error");
    }
  };

  return (
    <div className="pt-5 space-y-4" style={{ borderTop: `1px solid ${WF_BLUE_r}0.15)` }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-[8px] font-black tracking-[0.25em]" style={{ color: WF_BLUE }}>
          ウォークフォワード検証
        </p>
        <span className="text-[7px] font-mono px-2 py-0.5 rounded"
          style={{ background: `${WF_BLUE_r}0.08)`, border: `1px solid ${WF_BLUE_r}0.20)`, color: WF_BLUE }}>
          PHASE 4-B
        </span>
      </div>

      {/* Config */}
      <div className="flex items-center gap-4 flex-wrap">
        {([
          ["Train", trainMonths, setTrainMonths, "1-24 months"],
          ["Test",  testMonths,  setTestMonths,  "1-12 months"],
          ["Step",  stepMonths,  setStepMonths,  "1-12 months"],
        ] as [string, string, React.Dispatch<React.SetStateAction<string>>, string][]).map(([label, val, setter, hint]) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>{label.toUpperCase()}</span>
            <input
              type="number" value={val}
              onChange={e => setter(e.target.value)}
              min={1} max={label === "Train" ? 24 : 12} step={1}
              title={hint}
              className="w-12 px-1.5 py-1 rounded text-[9px] font-mono text-right outline-none"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: "#94a3b8" }}
            />
            <span className="text-[7px] font-mono" style={{ color: "#334155" }}>M</span>
          </div>
        ))}
      </div>

      <button
        onClick={run}
        disabled={state === "running"}
        className="w-full h-9 rounded font-mono font-black text-[10px] tracking-widest transition-all"
        style={{
          background: state === "running"
            ? "rgba(255,255,255,0.03)"
            : `linear-gradient(135deg, ${WF_BLUE_r}0.12) 0%, ${WF_BLUE_r}0.06) 100%)`,
          border:  `1px solid ${state === "running" ? "rgba(255,255,255,0.06)" : `${WF_BLUE_r}0.35)`}`,
          color:   state === "running" ? "#334155" : WF_BLUE,
          cursor:  state === "running" ? "not-allowed" : "pointer",
        }}>
        {state === "running" ? "◌ 実行中..." : state === "done" ? "↺ 再実行" : "▶ ウォークフォワード実行"}
      </button>

      {errMsg && <p className="text-[9px] font-mono" style={{ color: RED }}>{errMsg}</p>}

      {/* Results */}
      {state === "done" && result && (
        <div className="space-y-3">
          {/* Verdict */}
          <div className="px-4 py-3 rounded"
            style={{ background: `${verdictColorWF(result.verdict)}08`, border: `1px solid ${verdictColorWF(result.verdict)}30` }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[7px] font-mono tracking-widest mb-1" style={{ color: "#334155" }}>判定</p>
                <p className="text-lg font-black tracking-widest" style={{ color: verdictColorWF(result.verdict) }}>
                  {result.verdict}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[7px] font-mono tracking-widest mb-1" style={{ color: "#334155" }}>一貫性スコア</p>
                <p className="text-base font-black font-mono" style={{ color: result.consistencyScore === null ? "#334155" : result.consistencyScore >= 0.7 ? NG : result.consistencyScore >= 0.5 ? AMBER : RED }}>
                  {result.consistencyScore === null ? "N/A" : (result.consistencyScore * 100).toFixed(0) + "%"}
                </p>
              </div>
            </div>

            {/* Consistency bar */}
            {result.consistencyScore !== null && (
              <div className="mt-2">
                <div className="h-1.5 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <div className="h-full rounded-full transition-all"
                    style={{
                      width: `${result.consistencyScore * 100}%`,
                      background: result.consistencyScore >= 0.7 ? NG : result.consistencyScore >= 0.5 ? AMBER : RED,
                    }} />
                </div>
              </div>
            )}
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { label: "ウィンドウ数", val: String(result.totalWindowCount) },
              { label: "有効",        val: String(result.validWindowCount) },
              { label: "プラス",      val: String(result.positiveWindowCount) },
              { label: "スキップ",    val: String(result.skippedWindowCount),
                color: result.skippedWindowCount > 0 ? AMBER : "#334155" },
            ].map(({ label, val, color }) => (
              <div key={label} className="px-2 py-2 rounded"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <p className="text-[7px] font-mono tracking-widest" style={{ color: "#334155" }}>{label}</p>
                <p className="text-[11px] font-black font-mono mt-0.5" style={{ color: color ?? "#94a3b8" }}>{val}</p>
              </div>
            ))}
          </div>

          {/* Parameter Stability */}
          {Object.keys(result.parameterStability).length > 0 && (
            <div>
              <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>
                パラメーター安定性
              </p>
              <div className="space-y-1.5">
                {Object.entries(result.parameterStability).map(([field, stab]) => {
                  const short = field
                    .replace(/^entry_conditions\.conditions\[(\d+)\]\./, "[$1].")
                    .replace(/^exit_conditions\./, "exit.")
                    .replace(/^filters\./, "f.");
                  const stabCol = stab >= 0.7 ? NG : stab >= 0.5 ? AMBER : RED;
                  return (
                    <div key={field} className="flex items-center gap-2">
                      <span className="text-[7px] font-mono w-24 shrink-0" style={{ color: "#475569" }}>{short}</span>
                      <div className="flex-1 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="h-full rounded-full" style={{ width: `${stab*100}%`, background: stabCol }} />
                      </div>
                      <span className="text-[8px] font-mono shrink-0" style={{ color: stabCol }}>
                        {(stab*100).toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recommended Params */}
          {result.recommendedParams && (
            <div className="px-3 py-3 rounded"
              style={{ background: `${WF_BLUE_r}0.04)`, border: `1px solid ${WF_BLUE_r}0.15)` }}>
              <p className="text-[7px] font-black tracking-widest mb-1.5" style={{ color: WF_BLUE }}>
                推奨パラメーター
              </p>
              <p className="text-[7px] font-mono mb-2" style={{ color: "#475569" }}>
                各フィールドの最頻値 — この組み合わせが各ウィンドウで最良とは限りません。
              </p>
              <div className="space-y-1">
                {Object.entries(result.recommendedParams).map(([field, val]) => {
                  const short = field
                    .replace(/^entry_conditions\.conditions\[(\d+)\]\./, "[$1].")
                    .replace(/^exit_conditions\./, "exit.")
                    .replace(/^filters\./, "f.");
                  const freq = result.recommendedParamFreq?.[field] ?? [];
                  const topFreq = freq[0];
                  return (
                    <div key={field} className="flex items-center gap-2">
                      <span className="text-[7px] font-mono" style={{ color: "#475569" }}>{short}</span>
                      <span className="text-[9px] font-black font-mono" style={{ color: WF_BLUE }}>{val}</span>
                      {topFreq && (
                        <span className="text-[7px] font-mono" style={{ color: "#334155" }}>
                          ({topFreq.value === val ? topFreq.windowCount : (freq.find(f=>f.value===val)?.windowCount ?? 0)}/{result.validWindowCount}W)
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Window Details (collapsible) */}
          {result.windows.length > 0 && (
            <div>
              <button
                onClick={() => setShowWindows(v => !v)}
                className="text-[8px] font-mono tracking-widest transition-opacity hover:opacity-70"
                style={{ color: "#475569" }}>
                {showWindows ? "▲ ウィンドウを隠す" : `▼ ${result.windows.length}件のウィンドウを表示`}
              </button>

              {showWindows && (
                <div className="mt-2 space-y-1.5">
                  {result.windows.map((w, i) => {
                    const passed = w.windowPassed;
                    const col    = w.skipped ? "#334155" : passed ? NG : RED;
                    const params = Object.entries(w.bestParamSet)
                      .map(([f, v]) => {
                        const s = f.replace(/^entry_conditions\.conditions\[(\d+)\]\./, "[$1].")
                          .replace(/^exit_conditions\./, "exit.").replace(/^filters\./, "f.");
                        return `${s}=${v}`;
                      }).join(" ");

                    return (
                      <div key={i} className="px-3 py-2 rounded"
                        style={{ background: `${col}06`, border: `1px solid ${col}18` }}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[7px] font-black font-mono w-5" style={{ color: col }}>W{w.windowIndex}</span>
                            <span className="text-[7px] font-mono" style={{ color: "#334155" }}>
                              {fmtDate(w.trainFrom)}…{fmtDate(w.trainTo)} | TEST:{fmtDate(w.testFrom)}…{fmtDate(w.testTo)}
                            </span>
                          </div>
                          <span className="text-[7px] font-black" style={{ color: col }}>
                            {w.skipped ? "スキップ" : passed ? "合格" : "不合格"}
                          </span>
                        </div>
                        {!w.skipped && (
                          <div className="flex gap-3 mt-1 text-[7px] font-mono" style={{ color: "#475569" }}>
                            <span>{params}</span>
                            <span>TEST: {w.testMetrics.totalPips >= 0 ? "+" : ""}{w.testMetrics.totalPips.toFixed(1)}p</span>
                            <span>PF {pfStr(w.testMetrics.profitFactor)}</span>
                            <span>{w.testMetrics.totalTrades}T</span>
                            <span className="text-[7px]" style={{ color: w.sampleStatus === "NORMAL" ? NG : w.sampleStatus === "LOW_SAMPLE" ? AMBER : RED }}>
                              {w.sampleStatus}
                            </span>
                          </div>
                        )}
                        {w.skipped && (
                          <p className="text-[7px] font-mono mt-1" style={{ color: "#334155" }}>
                            学習データ不足のためスキップ
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <p className="text-[7px] font-mono" style={{ color: "#1e293b" }}>
            WF判定: 堅牢(≥0.7+安定) / 条件付(≥0.5) / 過学習(&lt;0.5) / 判定不能(データ不足)
            · 自動適用無効: 推奨パラメーターの適用はPhase 4-AのAPPLYを使用してください。
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// MonteCarloSection — Monte Carlo Simulation (Phase 4-C)
// OPTIMIZEタブ内のセクション。AI非依存の純粋統計計算。
// Probability of Drawdown Threshold = P(DD ≥ X%) — "Ruin" とは表示しない
// ------------------------------------------------------------------

const MC_VIOLET   = "#a78bfa";
const MC_VIOLET_r = "rgba(167,139,250,";

interface MCPercentileSet {
  p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number;
}
interface MCPFPercentileSet {
  p5: number | null; p10: number | null; p25: number | null; p50: number | null;
  p75: number | null; p90: number | null; p95: number | null;
}
interface MCDistributions {
  finalPips:            MCPercentileSet;
  maxDrawdownPct:       MCPercentileSet;
  profitFactor:         MCPFPercentileSet;
  maxConsecutiveLosses: MCPercentileSet;
}
interface MCOriginalMetrics {
  finalPips:            number;
  finalProfit:          number;
  maxDrawdownPct:       number;
  maxConsecutiveLosses: number;
  profitFactor:         number | null;
  winRate:              number;
}
interface MCResult {
  id?:                              string;
  iterations:                       number;
  seed:                             number;
  tradeCount:                       number;
  drawdownThresholdPct:             number;
  originalMetrics:                  MCOriginalMetrics;
  distributions:                    MCDistributions;
  probabilityOfLoss:                number;
  probabilityOfDrawdownThreshold:   number;
  originalPercentileRank:           number;
  executionMs?:                     number;
  // DB camelCase / snake_case compat
  original_final_pips?:             number;
  original_max_dd_pct?:             number;
  original_profit_factor?:          number | null;
  original_win_rate?:               number;
  original_max_cons_losses?:        number;
  drawdown_threshold_pct?:          number;
  probability_of_loss?:             number;
  probability_of_drawdown_threshold?: number;
  original_percentile_rank?:        number;
  trade_count?:                     number;
  execution_ms?:                    number;
}

function normaliseMCResult(d: Record<string, unknown>): MCResult {
  const n = (k1: string, k2: string): number =>
    Number(d[k1] ?? d[k2] ?? 0);
  const pf = (k1: string, k2: string): number | null => {
    const v = d[k1] ?? d[k2];
    return (v === null || v === undefined) ? null : Number(v);
  };

  const orig: MCOriginalMetrics = {
    finalPips:            n("originalFinalPips", "original_final_pips"),
    finalProfit:          n("originalFinalProfit", "original_final_profit"),
    maxDrawdownPct:       n("originalMaxDdPct", "original_max_dd_pct"),
    maxConsecutiveLosses: Number(d["originalMaxConsLosses"] ?? d["original_max_cons_losses"] ?? 0),
    profitFactor:         pf("originalProfitFactor", "original_profit_factor"),
    winRate:              n("originalWinRate", "original_win_rate"),
  };

  // normalise nested originalMetrics object if present
  if (d["originalMetrics"] && typeof d["originalMetrics"] === "object") {
    const om = d["originalMetrics"] as Record<string, unknown>;
    orig.finalPips            = Number(om["finalPips"]            ?? orig.finalPips);
    orig.finalProfit          = Number(om["finalProfit"]          ?? orig.finalProfit);
    orig.maxDrawdownPct       = Number(om["maxDrawdownPct"]       ?? orig.maxDrawdownPct);
    orig.maxConsecutiveLosses = Number(om["maxConsecutiveLosses"] ?? orig.maxConsecutiveLosses);
    orig.winRate              = Number(om["winRate"]              ?? orig.winRate);
    const pfv = om["profitFactor"];
    orig.profitFactor = (pfv === null || pfv === undefined) ? null : Number(pfv);
  }

  const dist = (d["distributions"] ?? {}) as MCDistributions;

  return {
    id:                             String(d["resultId"] ?? d["id"] ?? ""),
    iterations:                     Number(d["iterations"]  ?? 1000),
    seed:                           Number(d["seed"]        ?? 0),
    tradeCount:                     Number(d["tradeCount"]  ?? d["trade_count"] ?? 0),
    drawdownThresholdPct:           n("drawdownThresholdPct", "drawdown_threshold_pct") || 20,
    originalMetrics:                orig,
    distributions:                  dist,
    probabilityOfLoss:              n("probabilityOfLoss",                "probability_of_loss"),
    probabilityOfDrawdownThreshold: n("probabilityOfDrawdownThreshold",   "probability_of_drawdown_threshold"),
    originalPercentileRank:         n("originalPercentileRank",           "original_percentile_rank"),
    executionMs:                    Number(d["executionMs"] ?? d["execution_ms"] ?? 0),
  };
}

function fmtPF(pf: number | null): string {
  return pf === null ? "∞" : pf.toFixed(2);
}
function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function MonteCarloSection({ strategyId }: { strategyId: string }) {
  const [iterations,    setIterations]    = useState("1000");
  const [ddThreshold,   setDdThreshold]   = useState("20");
  const [seedInput,     setSeedInput]     = useState("");
  const [state,         setState]         = useState<"idle" | "running" | "done" | "error">("idle");
  const [result,        setResult]        = useState<MCResult | null>(null);
  const [errMsg,        setErrMsg]        = useState("");

  // Load existing result on mount
  useEffect(() => {
    fetch(`/api/strategies/${strategyId}/monte-carlo`)
      .then(r => r.json())
      .then((d: { status: string; result?: Record<string, unknown> }) => {
        if (d.status === "HAS_RESULT" && d.result) {
          setResult(normaliseMCResult(d.result));
          setState("done");
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  const run = async () => {
    const iters = parseInt(iterations, 10);
    if (!Number.isFinite(iters) || iters < 100 || iters > 50000) {
      setErrMsg("Iterations must be between 100 and 50,000");
      return;
    }
    const thresh = parseFloat(ddThreshold);
    if (!Number.isFinite(thresh) || thresh <= 0 || thresh > 100) {
      setErrMsg("DD Threshold must be between 0 and 100 (%)");
      return;
    }
    const seedVal = seedInput.trim() ? parseInt(seedInput.trim(), 10) : undefined;
    if (seedInput.trim() && (!Number.isInteger(seedVal) || seedVal! < 0)) {
      setErrMsg("Seed must be a non-negative integer");
      return;
    }

    setState("running");
    setErrMsg("");

    try {
      const body: Record<string, unknown> = {
        iterations: iters,
        drawdownThresholdPct: thresh,
      };
      if (seedVal !== undefined) body.seed = seedVal;

      const res  = await fetch(`/api/strategies/${strategyId}/monte-carlo`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await res.json() as Record<string, unknown>;

      if (!res.ok || data.error) {
        setErrMsg(String(data.error ?? "Monte Carlo failed"));
        setState("error");
      } else {
        setResult(normaliseMCResult(data));
        setState("done");
      }
    } catch (e) {
      setErrMsg(String(e));
      setState("error");
    }
  };

  const pset = result?.distributions?.finalPips;
  const ddset = result?.distributions?.maxDrawdownPct;

  return (
    <div className="mt-4 p-4 rounded" style={{ background: `${MC_VIOLET_r}0.04)`, border: `1px solid ${MC_VIOLET_r}0.15)` }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 rounded-full" style={{ background: MC_VIOLET }} />
          <span className="text-[10px] font-black tracking-widest" style={{ color: MC_VIOLET }}>
            モンテカルロ シミュレーション
          </span>
        </div>
        {result && (
          <span className="text-[8px] font-mono" style={{ color: "#475569" }}>
            {result.tradeCount} trades × {result.iterations.toLocaleString()} sims · {result.executionMs ?? 0}ms
          </span>
        )}
      </div>

      <p className="text-[7px] font-mono mb-3" style={{ color: "#475569" }}>
        取引順序の入れ替えシミュレーション結果分布を表示します。
        統計的信頼区間ではありません。
      </p>

      {/* Settings */}
      <div className="flex flex-wrap gap-3 mb-3">
        <div className="flex flex-col gap-1">
          <span className="text-[7px] font-mono" style={{ color: "#64748b" }}>試行回数</span>
          <input
            type="number" min={100} max={50000} value={iterations}
            onChange={e => setIterations(e.target.value)}
            disabled={state === "running"}
            className="w-20 text-[9px] font-mono px-2 py-1 rounded"
            style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)", color: "#f0f9ff", outline: "none" }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[7px] font-mono" style={{ color: "#64748b" }}>DD閾値 (%)</span>
          <input
            type="number" min={1} max={100} step={1} value={ddThreshold}
            onChange={e => setDdThreshold(e.target.value)}
            disabled={state === "running"}
            className="w-16 text-[9px] font-mono px-2 py-1 rounded"
            style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)", color: "#f0f9ff", outline: "none" }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[7px] font-mono" style={{ color: "#64748b" }}>シード（任意）</span>
          <input
            type="text" placeholder="auto" value={seedInput}
            onChange={e => setSeedInput(e.target.value)}
            disabled={state === "running"}
            className="w-20 text-[9px] font-mono px-2 py-1 rounded"
            style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)", color: "#f0f9ff", outline: "none" }}
          />
        </div>
      </div>

      {/* Run button */}
      <button
        onClick={run}
        disabled={state === "running"}
        className="text-[9px] font-black tracking-widest px-3 py-1.5 rounded transition-opacity"
        style={{
          background: `${MC_VIOLET_r}0.15)`,
          border:     `1px solid ${MC_VIOLET_r}0.4)`,
          color:      MC_VIOLET,
          opacity:    state === "running" ? 0.5 : 1,
        }}>
        {state === "running" ? "◌ 実行中..." : state === "done" ? "↺ 再実行" : "▶ モンテカルロ実行"}
      </button>

      {errMsg && (
        <p className="mt-2 text-[8px] font-mono" style={{ color: RED }}>{errMsg}</p>
      )}

      {/* Results */}
      {state === "done" && result && (
        <div className="mt-4 space-y-4">

          {/* Original Backtest */}
          <div>
            <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>元のバックテスト</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                { label: "合計PIPS",    value: `${result.originalMetrics.finalPips > 0 ? "+" : ""}${result.originalMetrics.finalPips.toFixed(1)}` },
                { label: "最大DD",     value: `${result.originalMetrics.maxDrawdownPct.toFixed(1)}%` },
                { label: "勝率",       value: `${result.originalMetrics.winRate.toFixed(1)}%` },
                { label: "PF",         value: fmtPF(result.originalMetrics.profitFactor) },
                { label: "最大連敗",   value: String(result.originalMetrics.maxConsecutiveLosses) },
                { label: "シード",     value: result.seed.toString() },
              ].map(({ label, value }) => (
                <div key={label} className="p-2 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                  <p className="text-[7px] font-mono mb-0.5" style={{ color: "#475569" }}>{label}</p>
                  <p className="text-[10px] font-black font-mono" style={{ color: "#f0f9ff" }}>{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Simulation Percentiles */}
          <div>
            <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>
              シミュレーションパーセンタイル
            </p>
            <div className="overflow-x-auto">
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 3px" }}>
                <thead>
                  <tr>
                    {["", "P5", "P25", "P50", "P75", "P95"].map(h => (
                      <th key={h} className="text-[7px] font-black text-right pr-3 pb-1" style={{ color: "#475569" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* Final Pips row */}
                  {pset && (
                    <tr>
                      <td className="text-[7px] font-mono pr-3 py-1" style={{ color: "#64748b" }}>合計PIPS</td>
                      {([pset.p5, pset.p25, pset.p50, pset.p75, pset.p95] as number[]).map((v, i) => {
                        const col = v < 0 ? RED : v > 0 ? NG : "#94a3b8";
                        return (
                          <td key={i} className="text-right pr-3 py-1">
                            <span className="text-[9px] font-black font-mono" style={{ color: col }}>
                              {v >= 0 ? "+" : ""}{v.toFixed(1)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  )}
                  {/* Max DD row */}
                  {ddset && (
                    <tr>
                      <td className="text-[7px] font-mono pr-3 py-1" style={{ color: "#64748b" }}>最大DD %</td>
                      {([ddset.p5, ddset.p25, ddset.p50, ddset.p75, ddset.p95] as number[]).map((v, i) => {
                        const thresh = result.drawdownThresholdPct;
                        const col = v >= thresh ? RED : v >= thresh * 0.7 ? AMBER : "#94a3b8";
                        return (
                          <td key={i} className="text-right pr-3 py-1">
                            <span className="text-[9px] font-black font-mono" style={{ color: col }}>
                              {v.toFixed(1)}%
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Key Probabilities */}
          <div>
            <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>主要確率</p>
            <div className="flex flex-wrap gap-3">
              <div className="p-2 rounded flex-1" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", minWidth: 140 }}>
                <p className="text-[7px] font-mono mb-0.5" style={{ color: "#475569" }}>損失確率（合計PIPS&lt;0）</p>
                <p className="text-[13px] font-black font-mono" style={{ color: result.probabilityOfLoss > 0.3 ? RED : result.probabilityOfLoss > 0.15 ? AMBER : NG }}>
                  {fmtPct(result.probabilityOfLoss)}
                </p>
              </div>
              <div className="p-2 rounded flex-1" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", minWidth: 140 }}>
                <p className="text-[7px] font-mono mb-0.5" style={{ color: "#475569" }}>DD超過確率（DD≥{result.drawdownThresholdPct}%）</p>
                <p className="text-[13px] font-black font-mono" style={{ color: result.probabilityOfDrawdownThreshold > 0.2 ? RED : result.probabilityOfDrawdownThreshold > 0.1 ? AMBER : NG }}>
                  {fmtPct(result.probabilityOfDrawdownThreshold)}
                </p>
              </div>
            </div>
          </div>

          {/* Original Position */}
          <div>
            <p className="text-[8px] font-black tracking-widest mb-2" style={{ color: "#64748b" }}>元の順序の位置</p>
            <div className="p-2 rounded inline-flex items-center gap-2" style={{ background: `${MC_VIOLET_r}0.08)`, border: `1px solid ${MC_VIOLET_r}0.2)` }}>
              <span className="text-[9px] font-mono" style={{ color: "#94a3b8" }}>元の順序:</span>
              <span className="text-[13px] font-black font-mono" style={{ color: MC_VIOLET }}>
                P{Math.round(result.originalPercentileRank)}
              </span>
              <span className="text-[7px] font-mono" style={{ color: "#475569" }}>
                ({result.originalPercentileRank.toFixed(1)}パーセンタイル / {result.iterations.toLocaleString()}シミュレーション中)
              </span>
            </div>
          </div>

          {/* Footer */}
          <p className="text-[7px] font-mono" style={{ color: "#1e293b" }}>
            手法: 取引順序シャッフル · シード: {result.seed} · シミュレーション数: {result.iterations.toLocaleString()}
            · パーセンタイルはシミュレーション統計であり、信頼区間ではありません。
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// VersionsTab — Version History + Comparison
// ------------------------------------------------------------------

interface VersionBacktest {
  total_trades?:      number;
  win_rate?:          number;
  total_pips?:        number;
  profit_factor?:     number | null;
  max_drawdown_pct?:  number;
  verdict?:           "PASSED" | "CONDITIONAL" | "FAILED";
  sample_size_warning?: boolean;
}

interface VersionListItem {
  id:             string;
  version:        number;
  created_by:     "user" | "ai_improvement";
  parent_version: number | null;
  change_summary: string | null;
  created_at:     string;
  isActive:       boolean;
  backtest:       VersionBacktest | null;
}

interface VersionDetail {
  id:             string;
  version:        number;
  spec_snapshot:  Record<string, unknown>;
  created_by:     "user" | "ai_improvement";
  parent_version: number | null;
  change_summary: string | null;
  created_at:     string;
  backtest:       VersionBacktest | null;
  improvement:    null | Record<string, unknown>;
}

interface CompItem { metric: string; before: unknown; after: unknown; delta: number | null; note: string }
interface Comparison {
  verdict:      "IMPROVED" | "CONDITIONAL" | "REGRESSION" | "INCONCLUSIVE";
  improvements: CompItem[];
  regressions:  CompItem[];
  warnings:     string[];
  summary:      string;
}

function verdictColor2(v: "IMPROVED" | "CONDITIONAL" | "REGRESSION" | "INCONCLUSIVE" | "PASSED" | "FAILED"): string {
  if (v === "IMPROVED" || v === "PASSED") return NG;
  if (v === "CONDITIONAL") return AMBER;
  return RED;
}

function VersionsTab({ strategyId, onApplyDone }: {
  strategyId:   string;
  onApplyDone?: () => void;
}) {
  const [versions,     setVersions]     = useState<VersionListItem[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [selectedVer,  setSelectedVer]  = useState<number | null>(null);
  const [detail,       setDetail]       = useState<VersionDetail | null>(null);
  const [comparison,   setComparison]   = useState<Comparison | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring,    setRestoring]    = useState(false);
  const [restoreErr,   setRestoreErr]   = useState("");

  const loadVersions = () => {
    setLoading(true);
    fetch(`/api/strategies/${strategyId}/versions`)
      .then(r => r.json())
      .then((d: { versions?: VersionListItem[] }) => {
        setVersions(d.versions ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(loadVersions, [strategyId]);

  const selectVersion = (v: number) => {
    if (selectedVer === v) { setSelectedVer(null); setDetail(null); return; }
    setSelectedVer(v);
    setDetailLoading(true);
    fetch(`/api/strategies/${strategyId}/versions/${v}`)
      .then(r => r.json())
      .then((d: { version?: VersionDetail; comparison?: Comparison | null }) => {
        setDetail(d.version ?? null);
        setComparison(d.comparison ?? null);
        setDetailLoading(false);
      })
      .catch(() => setDetailLoading(false));
  };

  const restore = async (toVersion: number) => {
    setRestoring(true);
    setRestoreErr("");
    try {
      const r = await fetch(`/api/strategies/${strategyId}/versions/${toVersion}/restore`, {
        method: "POST",
      });
      const d = await r.json() as { newVersionNumber?: number; error?: string };
      if (!r.ok) { setRestoreErr(d.error ?? "Restore failed"); }
      else {
        loadVersions();
        setSelectedVer(null);
        setDetail(null);
        onApplyDone?.();
      }
    } catch (e) {
      setRestoreErr(String(e));
    } finally {
      setRestoring(false);
    }
  };

  if (loading) {
    return (
      <div className="p-5 flex items-center justify-center h-48">
        <p className="text-[9px] font-mono tracking-widest" style={{ color: "#334155" }}>◌ バージョン読み込み中...</p>
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="p-5 flex items-center justify-center h-48">
        <p className="text-[9px] font-mono tracking-widest" style={{ color: "#334155" }}>
          バージョンがありません。バックテストを実行して適用するとバージョンが作成されます。
        </p>
      </div>
    );
  }

  return (
    <div className="p-5 space-y-3 overflow-y-auto">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[8px] font-black tracking-[0.25em]" style={{ color: PURPLE }}>
          バージョン履歴 ({versions.length}件)
        </p>
        {restoreErr && <p className="text-[8px] font-mono" style={{ color: RED }}>{restoreErr}</p>}
      </div>

      {versions.map(v => {
        const isSelected = selectedVer === v.version;
        const vcol = v.backtest?.verdict
          ? verdictColor2(v.backtest.verdict)
          : "#334155";

        return (
          <div key={v.id}>
            {/* Version card */}
            <div
              onClick={() => selectVersion(v.version)}
              className="px-4 py-3 rounded cursor-pointer transition-all"
              style={{
                background: isSelected ? "rgba(167,139,250,0.06)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${isSelected ? "rgba(167,139,250,0.30)" : "rgba(255,255,255,0.06)"}`,
              }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-black font-mono" style={{ color: PURPLE }}>
                    v{v.version}
                  </span>
                  {v.isActive && (
                    <span className="text-[6px] font-black px-1.5 py-0.5 rounded"
                      style={{ background: `${NG}15`, border: `1px solid ${NG}30`, color: NG }}>
                      有効
                    </span>
                  )}
                  <span className="text-[7px] font-mono px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(255,255,255,0.05)", color: "#475569" }}>
                    {v.created_by === "ai_improvement" ? "AI" : "USER"}
                  </span>
                </div>
                {v.backtest && (
                  <div className="flex items-center gap-2">
                    <span className="text-[7px] font-black px-1.5 py-0.5 rounded"
                      style={{ background: `${vcol}12`, border: `1px solid ${vcol}25`, color: vcol }}>
                      {v.backtest.verdict}
                    </span>
                    <span className="text-[8px] font-mono" style={{ color: vcol }}>
                      {(v.backtest.total_pips ?? 0) >= 0 ? "+" : ""}
                      {(v.backtest.total_pips ?? 0).toFixed(1)}p
                    </span>
                  </div>
                )}
              </div>

              {v.change_summary && (
                <p className="text-[8px] font-mono mt-1.5 leading-relaxed" style={{ color: "#475569" }}>
                  {v.change_summary}
                </p>
              )}

              {v.backtest && (
                <div className="flex gap-3 mt-1.5 text-[7px] font-mono" style={{ color: "#334155" }}>
                  <span>WR {(v.backtest.win_rate ?? 0).toFixed(1)}%</span>
                  <span>PF {v.backtest.profit_factor !== null && v.backtest.profit_factor !== undefined
                    ? v.backtest.profit_factor.toFixed(2) : "∞"}</span>
                  <span>DD {(v.backtest.max_drawdown_pct ?? 0).toFixed(1)}%</span>
                  {v.backtest.sample_size_warning && <span style={{ color: AMBER }}>⚠ 少</span>}
                </div>
              )}

              <p className="text-[7px] font-mono mt-1" style={{ color: "#1e293b" }}>
                {new Date(v.created_at).toLocaleString("ja-JP", { timeZone: "UTC" })} UTC
              </p>
            </div>

            {/* Expanded detail */}
            {isSelected && (
              <div className="mt-1 mx-1 px-4 py-4 rounded space-y-4"
                style={{ background: "rgba(167,139,250,0.03)", border: "1px solid rgba(167,139,250,0.12)" }}>

                {detailLoading && (
                  <p className="text-[9px] font-mono" style={{ color: "#334155" }}>◌ Loading...</p>
                )}

                {/* Comparison */}
                {comparison && !detailLoading && (
                  <div>
                    <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: PURPLE }}>
                      v{v.parent_version} → v{v.version} 比較
                    </p>
                    <div className="px-3 py-2 rounded mb-2"
                      style={{ background: `${verdictColor2(comparison.verdict)}08`, border: `1px solid ${verdictColor2(comparison.verdict)}20` }}>
                      <span className="text-[8px] font-black" style={{ color: verdictColor2(comparison.verdict) }}>
                        {comparison.verdict}
                      </span>
                      <p className="text-[8px] font-mono mt-1" style={{ color: "#64748b" }}>
                        {comparison.summary}
                      </p>
                    </div>
                    {comparison.improvements.length > 0 && (
                      <div className="space-y-0.5 mb-1">
                        {comparison.improvements.map((imp, i) => (
                          <div key={i} className="flex items-center gap-2 text-[8px] font-mono">
                            <span style={{ color: NG }}>↑</span>
                            <span style={{ color: "#475569" }}>{imp.metric}</span>
                            <span style={{ color: "#334155" }}>{String(imp.before)} → {String(imp.after)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {comparison.regressions.length > 0 && (
                      <div className="space-y-0.5 mb-1">
                        {comparison.regressions.map((reg, i) => (
                          <div key={i} className="flex items-center gap-2 text-[8px] font-mono">
                            <span style={{ color: RED }}>↓</span>
                            <span style={{ color: "#475569" }}>{reg.metric}</span>
                            <span style={{ color: "#334155" }}>{String(reg.before)} → {String(reg.after)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {comparison.warnings.map((w, i) => (
                      <p key={i} className="text-[7px] font-mono mt-1" style={{ color: AMBER }}>
                        ⚠ {w}
                      </p>
                    ))}
                  </div>
                )}

                {/* Spec highlight */}
                {detail && !detailLoading && (
                  <div>
                    <p className="text-[8px] font-black tracking-[0.22em] mb-2" style={{ color: "#64748b" }}>
                      仕様スナップショット
                    </p>
                    <div className="text-[7px] font-mono space-y-0.5" style={{ color: "#334155" }}>
                      {(() => {
                        const ec = detail.spec_snapshot.entry_conditions as Record<string, unknown> | null;
                        const conds = (ec?.conditions as unknown[]) ?? [];
                        return conds.map((c, i) => {
                          const cc = c as Record<string, unknown>;
                          return (
                            <div key={i}>
                              [{i}] {String(cc.indicator)} {String(cc.timeframe)}
                              {cc.threshold !== undefined ? ` thr=${cc.threshold}` : ""}
                              {cc.period !== undefined ? ` p=${cc.period}` : ""}
                              {cc.operator !== undefined ? ` ${String(cc.operator)}` : ""}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}

                {/* Rollback button (non-active versions only) */}
                {!v.isActive && (
                  <button
                    onClick={() => restore(v.version)}
                    disabled={restoring}
                    className="px-3 py-1.5 rounded text-[8px] font-mono font-black tracking-widest transition-all"
                    style={{
                      background: restoring ? "rgba(255,255,255,0.03)" : "rgba(100,116,139,0.10)",
                      border:     "1px solid rgba(100,116,139,0.25)",
                      color:      restoring ? "#334155" : "#64748b",
                      cursor:     restoring ? "not-allowed" : "pointer",
                    }}>
                    {restoring ? "◌ 復元中..." : `↩ v${v.version}に戻す`}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------
// Main: StrategyDetailModal
// ------------------------------------------------------------------

type Tab = "OVERVIEW" | "BACKTEST" | "TRADES" | "ANALYSIS" | "VERSIONS" | "OPTIMIZE";

export function StrategyDetailModal({
  strategy,
  onClose,
}: {
  strategy: StrategyRecord;
  onClose:  () => void;
}) {
  const [tab,         setTab]         = useState<Tab>("OVERVIEW");
  const [latestJobId, setLatestJobId] = useState<string | null>(null);
  const [hasBacktest, setHasBacktest] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const typeColor: Record<string, string> = {
    SCALPING: CYAN, DAY_TRADE: AMBER, SWING: NG,
  };
  const col = typeColor[strategy.strategy_type] ?? "#64748b";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(2,4,10,0.88)", backdropFilter: "blur(8px)" }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="relative z-10 flex flex-col w-full max-w-3xl rounded-lg overflow-hidden"
        style={{
          background: "linear-gradient(135deg, rgba(4,8,18,0.98) 0%, rgba(2,4,10,0.99) 100%)",
          border:     `1px solid ${col}30`,
          boxShadow:  `0 0 60px rgba(0,0,0,0.8), 0 0 30px ${col}08`,
          maxHeight:  "90vh",
        }}
      >
        {/* Top accent line */}
        <div className="h-px" style={{ background: `linear-gradient(to right, transparent, ${col}, transparent)` }} />

        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-3 shrink-0">
          <div>
            <h2 className="text-base font-black tracking-widest" style={{ color: "#f0f9ff" }}>
              {strategy.name}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[8px] font-black tracking-widest px-1.5 py-0.5 rounded"
                style={{ background: `${col}12`, border: `1px solid ${col}25`, color: col }}>
                {strategy.strategy_type}
              </span>
              <span className="text-[8px] font-mono" style={{ color: "#334155" }}>
                {strategy.symbols.join(", ")} · {strategy.timeframes.join(", ")}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[14px] leading-none hover:opacity-70 transition-opacity mt-1"
            style={{ color: "#475569" }}>
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 px-5 shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          {(["OVERVIEW", "BACKTEST", "TRADES", "ANALYSIS", "VERSIONS", "OPTIMIZE"] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-4 py-2 text-[9px] font-black tracking-widest transition-all"
              style={{
                color:        tab === t ? col : "#334155",
                borderBottom: tab === t ? `2px solid ${col}` : "2px solid transparent",
                marginBottom: "-1px",
              }}>
              {labelOf(TAB_LABELS, t)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {tab === "OVERVIEW" && <OverviewTab strategy={strategy} />}
          {tab === "BACKTEST" && (
            <BacktestTab
              strategyId={strategy.id}
              onJobIdChange={id => { setLatestJobId(id); if (id) setHasBacktest(true); }}
            />
          )}
          {tab === "TRADES"   && <TradesTab jobId={latestJobId} />}
          {tab === "ANALYSIS" && (
            <AnalysisTab strategyId={strategy.id} hasBacktest={hasBacktest || strategy.backtest_status !== "NOT_TESTED"} />
          )}
          {tab === "VERSIONS" && (
            <VersionsTab
              strategyId={strategy.id}
              onApplyDone={() => setHasBacktest(true)}
            />
          )}
          {tab === "OPTIMIZE" && <OptimizeTab strategy={strategy} />}
        </div>
      </div>
    </div>
  );
}

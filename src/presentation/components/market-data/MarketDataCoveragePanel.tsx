"use client";

// =================================================================
// Data Phase C/D — Market Data Coverage Panel
//
// Read-only UI showing per-symbol/TF data coverage and sync job
// status. No job creation, no engine changes.
// Polls every 30 seconds and supports manual refresh.
//
// Phase D additions:
//   - Integrity badge per Symbol/TF row (HEALTHY/WARNING/CRITICAL)
//   - RUN GAP AUDIT button (calls /api/market-data/gaps on demand only)
//   - Gap Detail section with filter controls
// =================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Database, CheckCircle2, Activity, AlertTriangle, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getReadiness,
  getCoveragePercent,
  getReadinessNote,
  isValidRange,
  countFullReady,
  countActiveJobs,
  type MarketDataReadiness,
} from "@/infrastructure/market-data/marketDataReadiness";
import type {
  GapCandidate,
  GapSummary,
  IntegrityStatus,
} from "@/infrastructure/market-data/marketDataGapDetection";

// ------------------------------------------------------------------
// Types mirrored from API response shapes
// ------------------------------------------------------------------

interface CombinedStat {
  symbol:             string;
  timeframe:          string;
  supabase_bars:      number | null;
  supabase_from:      string | null;
  supabase_to:        string | null;
  supabase_span_days: number | null;
  status:             string;
}

interface StatusResponse {
  summary: {
    total_symbol_tf:     number;
    total_supabase_bars: number;
  };
  symbols: Record<string, CombinedStat>;
}

interface SyncJob {
  id:              string;
  symbol:          string;
  timeframe:       string;
  mode:            string;
  status:          string;
  progress_pct:    number;
  received_bars:   number;
  sent_bars:       number;
  failed_batches:  number;
  created_at:      string;
  updated_at:      string | null;
  error_message:   string | null;
  isStale:         boolean;
  resumable:       boolean;
  ageSeconds:      number;
  lastCheckpoint:  string | null;
}

interface JobsResponse {
  jobs: SyncJob[];
}

// Phase D — Gap Audit types (mirror of API response)
interface GapAuditResult {
  symbol:    string;
  timeframe: string;
  barCount:  number;
  from:      string | null;
  to:        string | null;
  auditedAt: string;
  summary:   GapSummary;
  gaps:      GapCandidate[];
}

// Key: "SYMBOL:TF"
type AuditMap = Map<string, GapAuditResult>;

// Canonical timeframe display order
const TF_ORDER = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"] as const;

const POLL_INTERVAL_MS = 30_000;

// ------------------------------------------------------------------
// Readiness badge config
// ------------------------------------------------------------------

const READINESS_BADGE: Record<MarketDataReadiness, { label: string; cls: string }> = {
  NOT_READY:           { label: "NOT READY",  cls: "text-gray-500 border-gray-700   bg-gray-900/30"  },
  MONTE_CARLO_READY:   { label: "MC READY",   cls: "text-blue-400  border-blue-700   bg-blue-900/20"  },
  OPTIMIZATION_READY:  { label: "OPT READY",  cls: "text-violet-400 border-violet-700 bg-violet-900/20"},
  WALK_FORWARD_READY:  { label: "WF READY",   cls: "text-amber-400 border-amber-700  bg-amber-900/20" },
  FULL_READY:          { label: "FULL READY", cls: "text-green-400  border-green-700  bg-green-900/20" },
};

const JOB_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  PENDING:   { label: "PENDING",   cls: "text-yellow-400 border-yellow-700 bg-yellow-900/20" },
  RUNNING:   { label: "RUNNING",   cls: "text-blue-400   border-blue-700   bg-blue-900/20"   },
  COMPLETED: { label: "COMPLETED", cls: "text-green-400  border-green-700  bg-green-900/20"  },
  FAILED:    { label: "FAILED",    cls: "text-red-400    border-red-700    bg-red-900/20"    },
  PAUSED:    { label: "PAUSED",    cls: "text-gray-400   border-gray-700   bg-gray-900/20"   },
};

// Phase D — integrity status badge config
const INTEGRITY_BADGE: Record<IntegrityStatus, { label: string; cls: string }> = {
  HEALTHY:  { label: "HEALTHY",  cls: "text-green-400  border-green-700  bg-green-900/20"  },
  WARNING:  { label: "WARNING",  cls: "text-amber-400  border-amber-700  bg-amber-900/20"  },
  CRITICAL: { label: "CRITICAL", cls: "text-red-400    border-red-700    bg-red-900/20"    },
  NO_DATA:  { label: "NO DATA",  cls: "text-gray-500   border-gray-700   bg-gray-900/20"   },
};

// Phase D/E — gap type badge
const GAP_CLASS_BADGE: Record<string, { label: string; cls: string }> = {
  NORMAL:         { label: "NORMAL",      cls: "text-gray-500   border-gray-800   bg-gray-900/20"    },
  WEEKEND:        { label: "WEEKEND",     cls: "text-blue-400   border-blue-800   bg-blue-900/20"    },
  HOLIDAY_CLOSED: { label: "HOLIDAY",     cls: "text-purple-400 border-purple-800 bg-purple-900/20"  },
  MARKET_CLOSED:  { label: "MKT CLOSED", cls: "text-violet-400 border-violet-800 bg-violet-900/20"  },
  SUSPECTED_GAP:  { label: "SUSPECTED",  cls: "text-red-400    border-red-800    bg-red-900/20"     },
};

const GAP_SEVERITY_CLS: Record<string, string> = {
  INFO:     "text-gray-500",
  WARNING:  "text-amber-400",
  CRITICAL: "text-red-400",
};

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "2-digit", month: "short", day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch {
    return "—";
  }
}

function fmtAgo(seconds: number): string {
  if (seconds < 60)  return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

function SummaryCard({
  label, value, sub, accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "green" | "blue" | "amber";
}) {
  const accentCls =
    accent === "green" ? "border-green-700/30 bg-green-900/10" :
    accent === "blue"  ? "border-blue-700/30  bg-blue-900/10"  :
    accent === "amber" ? "border-amber-700/30 bg-amber-900/10" :
    "border-[#0d1520] bg-[#060a12]";

  const valueCls =
    accent === "green" ? "text-green-400" :
    accent === "blue"  ? "text-blue-400"  :
    accent === "amber" ? "text-amber-400" :
    "text-gray-200";

  return (
    <div className={cn("border p-3 min-w-0", accentCls)}>
      <p className="text-[8px] font-mono tracking-widest text-gray-600 mb-1">{label}</p>
      <p className={cn("text-lg font-mono font-bold leading-none", valueCls)}>{value}</p>
      {sub && <p className="text-[8px] text-gray-700 font-mono mt-1">{sub}</p>}
    </div>
  );
}

function ReadinessBadge({ readiness }: { readiness: MarketDataReadiness }) {
  const { label, cls } = READINESS_BADGE[readiness];
  return (
    <span className={cn("inline-block text-[7.5px] font-mono font-semibold tracking-wider px-1.5 py-0.5 border", cls)}>
      {label}
    </span>
  );
}

function CoverageBar({ pct }: { pct: number }) {
  const barCls =
    pct >= 100 ? "bg-green-500" :
    pct >= 49  ? "bg-amber-500" :
    pct >= 16  ? "bg-blue-500"  :
    "bg-gray-600";

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <div className="flex-1 h-1 bg-[#0d1520] overflow-hidden min-w-[40px]">
        <div
          className={cn("h-full transition-all duration-500", barCls)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="text-[8px] font-mono text-gray-600 w-9 text-right shrink-0">
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// Symbol card — renders one symbol with all its TF rows
function SymbolCard({
  symbol,
  stats,
  auditMap,
  onRunAudit,
  auditLoading,
}: {
  symbol:       string;
  stats:        CombinedStat[];
  auditMap:     AuditMap;
  onRunAudit:   (symbol: string, timeframe: string) => void;
  auditLoading: string | null; // "SYMBOL:TF" currently loading
}) {
  const tfMap = new Map(stats.map(s => [s.timeframe, s]));
  const anyHealthy = stats.some(s => s.status === "HEALTHY" || s.status === "SUPABASE_ONLY");

  return (
    <div className="border border-[#0d1520] bg-[#060a12]">
      {/* Symbol header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#0d1520]">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-bold text-gray-200 tracking-wider">{symbol}</span>
          <span className={cn(
            "text-[7px] font-mono px-1.5 py-0.5 border",
            anyHealthy
              ? "text-green-400 border-green-800 bg-green-900/20"
              : "text-gray-600 border-gray-800 bg-gray-900/20"
          )}>
            {anyHealthy ? "DATA AVAILABLE" : "NO DATA"}
          </span>
        </div>
      </div>

      {/* TF table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[8px] font-mono">
          <thead>
            <tr className="border-b border-[#0d1520]">
              <th className="text-left px-3 py-1.5 text-gray-700 tracking-wider w-10">TF</th>
              <th className="text-right px-2 py-1.5 text-gray-700 tracking-wider">BARS</th>
              <th className="text-left px-2 py-1.5 text-gray-700 tracking-wider min-w-[100px]">COVERAGE</th>
              <th className="text-left px-2 py-1.5 text-gray-700 tracking-wider">DATA RANGE</th>
              <th className="text-right px-2 py-1.5 text-gray-700 tracking-wider">INTEGRITY</th>
              <th className="text-right px-3 py-1.5 text-gray-700 tracking-wider">READINESS</th>
            </tr>
          </thead>
          <tbody>
            {TF_ORDER.map(tf => {
              const stat = tfMap.get(tf);
              const hasData = stat && isValidRange(stat.supabase_from, stat.supabase_to);
              const spanDays = stat?.supabase_span_days ?? 0;
              const pct      = hasData ? getCoveragePercent(spanDays) : 0;
              const readiness = hasData ? getReadiness(spanDays) : "NOT_READY";
              const note      = hasData ? getReadinessNote(readiness, spanDays) : null;

              const auditKey    = `${symbol}:${tf}`;
              const auditResult = auditMap.get(auditKey) ?? null;
              const isLoading   = auditLoading === auditKey;
              const integrityStatus: IntegrityStatus = auditResult
                ? auditResult.summary.integrityStatus
                : (hasData ? "HEALTHY" : "NO_DATA");
              const intBadge = INTEGRITY_BADGE[integrityStatus];

              return (
                <tr key={tf} className="border-b border-[#080e18] last:border-0 hover:bg-[#080e18]/50 transition-colors">
                  <td className="px-3 py-2 text-cyan-500/70 font-semibold">{tf}</td>
                  <td className="px-2 py-2 text-right text-gray-400">
                    {hasData ? (stat.supabase_bars ?? 0).toLocaleString() : <span className="text-gray-700">—</span>}
                  </td>
                  <td className="px-2 py-2">
                    {hasData
                      ? <CoverageBar pct={pct} />
                      : <span className="text-gray-700">NO DATA</span>
                    }
                  </td>
                  <td className="px-2 py-2 text-gray-600">
                    {hasData
                      ? `${formatDate(stat.supabase_from)} → ${formatDate(stat.supabase_to)}`
                      : <span className="text-gray-800">—</span>
                    }
                  </td>
                  {/* Phase D — Integrity cell */}
                  <td className="px-2 py-2 text-right">
                    {hasData ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <span className={cn(
                          "inline-block text-[7px] font-mono px-1.5 py-0.5 border",
                          intBadge.cls,
                        )}>
                          {isLoading ? "..." : intBadge.label}
                        </span>
                        {auditResult && (
                          <span className="text-[6px] text-gray-700">
                            {formatTime(auditResult.auditedAt)}
                          </span>
                        )}
                        {!auditResult && (
                          <button
                            onClick={() => onRunAudit(symbol, tf)}
                            disabled={isLoading}
                            className={cn(
                              "text-[6px] font-mono px-1 py-0.5 border transition-all",
                              isLoading
                                ? "border-gray-800 text-gray-700 cursor-not-allowed"
                                : "border-cyan-900 text-cyan-600 hover:border-cyan-700 hover:text-cyan-400",
                            )}
                          >
                            {isLoading ? "..." : "AUDIT"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-700 text-[7px]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {hasData ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <ReadinessBadge readiness={readiness} />
                        {readiness !== "FULL_READY" && note && (
                          <span className="text-[6.5px] text-amber-600/70 max-w-[140px] text-right leading-tight">
                            {note}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-700 text-[7px]">NO DATA</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Sync job row
function SyncJobRow({ job }: { job: SyncJob }) {
  const badge = JOB_STATUS_BADGE[job.status] ?? JOB_STATUS_BADGE["PAUSED"];

  return (
    <div className="border border-[#0d1520] bg-[#060a12] p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] font-mono font-bold text-gray-300">{job.symbol}</span>
        <span className="text-[8px] font-mono text-cyan-500/60">{job.timeframe}</span>
        <span className="text-[8px] font-mono text-gray-600">{job.mode}</span>
        <span className={cn("text-[7.5px] font-mono px-1.5 py-0.5 border ml-auto shrink-0", badge.cls)}>
          {badge.label}
        </span>
      </div>

      {job.status === "RUNNING" && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 bg-[#0d1520]">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${job.progress_pct}%` }}
              />
            </div>
            <span className="text-[8px] font-mono text-blue-400 w-8 text-right">{job.progress_pct}%</span>
          </div>
          <p className="text-[7.5px] font-mono text-gray-600">
            recv: {job.received_bars.toLocaleString()} · sent: {job.sent_bars.toLocaleString()} · failed: {job.failed_batches}
          </p>
        </div>
      )}

      {job.isStale && (
        <div className="flex items-start gap-1.5 border border-amber-800/40 bg-amber-900/10 px-2 py-1.5">
          <AlertTriangle size={10} className="text-amber-500 mt-0.5 shrink-0" />
          <div className="text-[7.5px] font-mono text-amber-500/80 leading-relaxed">
            STALE JOB — Last update: {fmtAgo(job.ageSeconds)}
            {job.lastCheckpoint && ` · Resume checkpoint: ${formatDate(job.lastCheckpoint)}`}
            {" · Auto-recovery enabled"}
          </div>
        </div>
      )}

      {job.status === "FAILED" && job.error_message && (
        <p className="text-[7.5px] font-mono text-red-500/70 border border-red-900/30 bg-red-900/10 px-2 py-1">
          {job.error_message}
        </p>
      )}

      <p className="text-[7px] font-mono text-gray-800">
        Created: {formatDate(job.created_at)}
        {job.updated_at && ` · Updated: ${formatDate(job.updated_at)}`}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------
// Phase D — Gap Detail Section
// ------------------------------------------------------------------

type GapFilter = "SUSPECTED_GAP" | "ALL" | "WEEKEND" | "HOLIDAY_CLOSED" | "MARKET_CLOSED";

function GapDetailSection({
  auditMap,
  onRunAuditAll,
  auditLoading,
  hasData,
}: {
  auditMap:      AuditMap;
  onRunAuditAll: () => void;
  auditLoading:  string | null;
  hasData:       boolean;
}) {
  const [filter, setFilter] = useState<GapFilter>("SUSPECTED_GAP");

  const allAudits = [...auditMap.values()];
  if (allAudits.length === 0 && !hasData) return null;

  // Aggregate suspicious gaps across all audited symbol/TFs
  const totalSuspected = allAudits.reduce((s, a) => s + a.summary.suspectedGaps, 0);
  const totalCritical  = allAudits.reduce((s, a) => s + a.summary.criticalCount, 0);
  const totalMissing   = allAudits.reduce((s, a) => s + (a.summary.unexpectedMissingBars ?? a.summary.missingBars), 0);
  const totalHoliday   = allAudits.reduce((s, a) => s + (a.summary.holidayClosures ?? 0), 0);
  const totalWeekend   = allAudits.reduce((s, a) => s + (a.summary.weekendClosures ?? 0), 0);

  const isAuditRunning = auditLoading !== null;

  return (
    <div className="border border-[#0d1520] bg-[#060a12] space-y-3 shrink-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-4 flex-wrap">
        <ShieldCheck size={11} className="text-cyan-500/60" />
        <span className="text-[8px] font-mono text-cyan-500/60 tracking-wider">GAP DETECTION / INTEGRITY AUDIT</span>

        <div className="ml-auto flex items-center gap-2">
          {allAudits.length > 0 && (
            <span className="text-[7px] font-mono text-gray-700">
              {allAudits.length} audited
            </span>
          )}
          <button
            onClick={onRunAuditAll}
            disabled={isAuditRunning || !hasData}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-[8px] font-mono border transition-all",
              isAuditRunning || !hasData
                ? "border-gray-800 text-gray-700 cursor-not-allowed"
                : "border-cyan-800/60 text-cyan-500 hover:border-cyan-600 hover:bg-cyan-900/10",
            )}
          >
            <RefreshCw size={9} className={isAuditRunning ? "animate-spin" : ""} />
            RUN GAP AUDIT
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {allAudits.length > 0 && (
        <div className="px-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="border border-[#0d1520] bg-[#04060d] p-2">
            <p className="text-[7px] font-mono text-gray-700 mb-0.5">UNEXPECTED GAPS</p>
            <p className={cn("text-sm font-mono font-bold", totalSuspected > 0 ? "text-amber-400" : "text-green-400")}>
              {totalSuspected}
            </p>
          </div>
          <div className="border border-[#0d1520] bg-[#04060d] p-2">
            <p className="text-[7px] font-mono text-gray-700 mb-0.5">CRITICAL GAPS</p>
            <p className={cn("text-sm font-mono font-bold", totalCritical > 0 ? "text-red-400" : "text-green-400")}>
              {totalCritical}
            </p>
          </div>
          <div className="border border-[#0d1520] bg-[#04060d] p-2">
            <p className="text-[7px] font-mono text-gray-700 mb-0.5">UNEXPECTED MISSING</p>
            <p className={cn("text-sm font-mono font-bold", totalMissing > 0 ? "text-red-400" : "text-green-400")}>
              {totalMissing}
            </p>
          </div>
          <div className="border border-[#0d1520] bg-[#04060d] p-2">
            <p className="text-[7px] font-mono text-gray-700 mb-0.5">EXPECTED CLOSURES</p>
            <p className="text-sm font-mono font-bold text-gray-400">
              {totalWeekend + totalHoliday}
            </p>
            <p className="text-[6px] font-mono text-gray-700 mt-0.5">
              {totalWeekend}W / {totalHoliday}H
            </p>
          </div>
        </div>
      )}

      {/* Bottleneck warning */}
      {totalSuspected > 0 && (
        <div className="mx-4 flex items-start gap-1.5 border border-amber-800/40 bg-amber-900/10 px-2 py-1.5">
          <AlertTriangle size={10} className="text-amber-500 mt-0.5 shrink-0" />
          <span className="text-[7.5px] font-mono text-amber-500/80">
            {totalSuspected} unexpected gap{totalSuspected !== 1 ? "s" : ""} detected
            {totalMissing > 0 ? ` · ${totalMissing} unexpected missing bars` : ""}.
            {totalCritical > 0 ? ` ${totalCritical} CRITICAL.` : ""}
            {totalHoliday > 0 ? ` (${totalHoliday} holiday closure${totalHoliday !== 1 ? "s" : ""} correctly classified)` : ""}
            {" "}Backtest accuracy may be affected. Consider running a BACKFILL sync.
          </span>
        </div>
      )}

      {allAudits.length === 0 ? (
        <div className="px-4 pb-4">
          <p className="text-[8px] font-mono text-gray-700">
            No audit results yet. Click RUN GAP AUDIT to analyse data integrity.
          </p>
        </div>
      ) : (
        <div className="px-4 pb-4 space-y-3">
          {/* Filter controls */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[7px] font-mono text-gray-700">SHOW:</span>
            {(["SUSPECTED_GAP", "ALL", "WEEKEND", "HOLIDAY_CLOSED", "MARKET_CLOSED"] as GapFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "text-[7px] font-mono px-1.5 py-0.5 border transition-all",
                  filter === f
                    ? "border-cyan-700 text-cyan-400 bg-cyan-900/20"
                    : "border-[#0d1520] text-gray-600 hover:border-gray-700 hover:text-gray-500",
                )}
              >
                {f === "SUSPECTED_GAP" ? "SUSPECTED" : f === "ALL" ? "ALL GAPS" : f === "HOLIDAY_CLOSED" ? "HOLIDAY" : f.replace("_", " ")}
              </button>
            ))}
          </div>

          {/* Gap tables per symbol/TF */}
          {allAudits.map(audit => {
            const displayGaps = filter === "ALL"
              ? audit.gaps.filter(() => true)
              : filter === "SUSPECTED_GAP"
              ? audit.gaps.filter(g => g.classification === "SUSPECTED_GAP")
              : audit.gaps.filter(g => g.classification === filter);

            // For WEEKEND/HOLIDAY_CLOSED/MARKET_CLOSED, re-fetch all=1 would be needed.
            // Currently gaps array from API defaults to SUSPECTED only,
            // so show a hint when filtering for other types.
            const needsAllData = (filter === "WEEKEND" || filter === "HOLIDAY_CLOSED" || filter === "MARKET_CLOSED") && displayGaps.length === 0;
            const intBadge = INTEGRITY_BADGE[audit.summary.integrityStatus];

            return (
              <div key={`${audit.symbol}:${audit.timeframe}`} className="border border-[#0d1520]">
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#0d1520] bg-[#04060d]">
                  <span className="text-[8px] font-mono font-bold text-gray-300">{audit.symbol}</span>
                  <span className="text-[7px] font-mono text-cyan-500/60">{audit.timeframe}</span>
                  <span className={cn("text-[7px] font-mono px-1 py-0.5 border ml-1", intBadge.cls)}>
                    {intBadge.label}
                  </span>
                  <span className="text-[6.5px] font-mono text-gray-700 ml-auto">
                    {audit.barCount.toLocaleString()} bars · audited {formatTime(audit.auditedAt)}
                  </span>
                </div>

                {needsAllData ? (
                  <div className="px-3 py-2">
                    <p className="text-[7px] font-mono text-gray-700">
                      Re-run audit with &quot;all=1&quot; query to view {filter === "HOLIDAY_CLOSED" ? "holiday" : filter.replace("_", " ").toLowerCase()} gaps.
                    </p>
                  </div>
                ) : displayGaps.length === 0 ? (
                  <div className="px-3 py-2">
                    <p className="text-[7px] font-mono text-gray-600">No {filter === "SUSPECTED_GAP" ? "suspected" : filter === "HOLIDAY_CLOSED" ? "holiday" : filter.toLowerCase()} gaps found.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[7.5px] font-mono">
                      <thead>
                        <tr className="border-b border-[#0d1520]">
                          <th className="text-left px-3 py-1 text-gray-700">START (UTC)</th>
                          <th className="text-left px-2 py-1 text-gray-700">END (UTC)</th>
                          <th className="text-right px-2 py-1 text-gray-700">DURATION</th>
                          <th className="text-right px-2 py-1 text-gray-700">MISSING</th>
                          <th className="text-left px-2 py-1 text-gray-700">TYPE</th>
                          <th className="text-left px-2 py-1 text-gray-700">REASON</th>
                          <th className="text-right px-3 py-1 text-gray-700">SEVERITY</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayGaps.map((g, i) => {
                          const classBadge = GAP_CLASS_BADGE[g.classification] ?? GAP_CLASS_BADGE["SUSPECTED_GAP"]!;
                          const sevCls = GAP_SEVERITY_CLS[g.severity] ?? "text-gray-500";
                          const unexpectedMissing = (g as { unexpectedMissingBars?: number }).unexpectedMissingBars ?? g.missingBars;
                          return (
                            <tr key={i} className="border-b border-[#080e18] last:border-0">
                              <td className="px-3 py-1.5 text-gray-500">{formatDate(g.from)} {formatTime(g.from)}</td>
                              <td className="px-2 py-1.5 text-gray-500">{formatDate(g.to)} {formatTime(g.to)}</td>
                              <td className="px-2 py-1.5 text-right text-gray-500">{fmtDuration(g.durationSeconds)}</td>
                              <td className="px-2 py-1.5 text-right text-gray-400">{unexpectedMissing}</td>
                              <td className="px-2 py-1.5">
                                <span className={cn("inline-block text-[6.5px] px-1 py-0.5 border", classBadge.cls)}>
                                  {classBadge.label}
                                </span>
                              </td>
                              <td className="px-2 py-1.5 text-gray-700">
                                {(g as { holidayName?: string | null }).holidayName ?? "—"}
                              </td>
                              <td className={cn("px-3 py-1.5 text-right font-semibold", sevCls)}>
                                {g.severity}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Main component
// ------------------------------------------------------------------

export function MarketDataCoveragePanel() {
  const [statusData,  setStatusData]  = useState<StatusResponse | null>(null);
  const [jobsData,    setJobsData]    = useState<JobsResponse | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Phase D — Gap Audit state (NOT included in 30s polling)
  const [auditMap,     setAuditMap]     = useState<AuditMap>(new Map());
  const [auditLoading, setAuditLoading] = useState<string | null>(null);
  const [auditError,   setAuditError]   = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, jobsRes] = await Promise.all([
        fetch("/api/market-data/status"),
        fetch("/api/market-data/history-sync"),
      ]);

      if (!statusRes.ok) throw new Error(`Status API: HTTP ${statusRes.status}`);
      if (!jobsRes.ok)   throw new Error(`Jobs API: HTTP ${jobsRes.status}`);

      const [sData, jData] = await Promise.all([
        statusRes.json() as Promise<StatusResponse>,
        jobsRes.json()   as Promise<JobsResponse>,
      ]);

      setStatusData(sData);
      setJobsData(jData);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Phase D — run gap audit for a single symbol/TF on demand
  const runAudit = useCallback(async (symbol: string, timeframe: string) => {
    const key = `${symbol}:${timeframe}`;
    setAuditLoading(key);
    setAuditError(null);
    try {
      const res = await fetch(`/api/market-data/gaps?symbol=${symbol}&timeframe=${timeframe}`);
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as GapAuditResult;
      setAuditMap(prev => {
        const next = new Map(prev);
        next.set(key, data);
        return next;
      });
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Audit failed");
    } finally {
      setAuditLoading(null);
    }
  }, []);

  // Phase D — run gap audit for ALL available symbol/TF entries sequentially
  const runAuditAll = useCallback(async () => {
    if (!statusData?.symbols) return;
    const entries = Object.values(statusData.symbols).filter(
      s => s.supabase_bars !== null && (s.supabase_bars ?? 0) > 0,
    );
    for (const entry of entries) {
      await runAudit(entry.symbol, entry.timeframe);
    }
  }, [statusData, runAudit]);

  useEffect(() => {
    void fetchAll();
    timerRef.current = setInterval(() => { void fetchAll(); }, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchAll]);

  // Group combined stats by symbol
  const symbolGroups = (() => {
    if (!statusData?.symbols) return new Map<string, CombinedStat[]>();
    const map = new Map<string, CombinedStat[]>();
    for (const stat of Object.values(statusData.symbols)) {
      const arr = map.get(stat.symbol) ?? [];
      arr.push(stat);
      map.set(stat.symbol, arr);
    }
    return map;
  })();

  // Summary numbers
  const allStats = statusData ? Object.values(statusData.symbols) : [];
  const supabaseEntries = allStats
    .filter(s => s.supabase_span_days !== null)
    .map(s => ({ spanDays: s.supabase_span_days ?? 0 }));

  const totalBars   = statusData?.summary.total_supabase_bars ?? 0;
  const fullCount   = countFullReady(supabaseEntries);
  const activeCount = countActiveJobs(jobsData?.jobs ?? []);
  const recentJobs  = (jobsData?.jobs ?? []).slice(0, 10);

  return (
    <div className="flex flex-col flex-1 overflow-y-auto bg-[#04060d] p-4 pt-12 md:pt-4 space-y-4">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 shrink-0 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-0.5 h-4 bg-cyan-500/60" />
          <span className="text-[9px] text-cyan-500/70 font-mono tracking-widest">MARKET DATA COVERAGE</span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {lastRefresh && (
            <span className="text-[7.5px] font-mono text-gray-700">
              Last refreshed: {formatTime(lastRefresh.toISOString())}
            </span>
          )}
          <button
            onClick={() => { void fetchAll(); }}
            disabled={loading}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-[8px] font-mono border transition-all",
              loading
                ? "border-gray-800 text-gray-700 cursor-not-allowed"
                : "border-cyan-800/60 text-cyan-500 hover:border-cyan-600 hover:bg-cyan-900/10"
            )}
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
            REFRESH
          </button>
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 border border-red-800/40 bg-red-900/10 px-3 py-2">
          <AlertTriangle size={12} className="text-red-500 shrink-0" />
          <span className="text-[8px] font-mono text-red-400">{error}</span>
        </div>
      )}

      {/* ── Summary cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 shrink-0">
        <SummaryCard
          label="TOTAL SYMBOLS"
          value={symbolGroups.size}
          sub={`${statusData?.summary.total_symbol_tf ?? 0} symbol/TF entries`}
        />
        <SummaryCard
          label="TOTAL BARS"
          value={totalBars.toLocaleString()}
          sub="in Supabase bar_data"
          accent="blue"
        />
        <SummaryCard
          label="FULL READY"
          value={fullCount}
          sub="365+ days coverage"
          accent="green"
        />
        <SummaryCard
          label="ACTIVE SYNC JOBS"
          value={activeCount}
          sub="PENDING + RUNNING"
          accent={activeCount > 0 ? "amber" : undefined}
        />
      </div>

      {/* ── Symbol cards ─────────────────────────────────────────── */}
      {loading && !statusData ? (
        <div className="flex items-center gap-2 text-[8px] font-mono text-gray-700 py-8">
          <RefreshCw size={10} className="animate-spin" />
          Loading coverage data...
        </div>
      ) : symbolGroups.size === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8">
          <Database size={24} className="text-gray-800" />
          <p className="text-[9px] font-mono text-gray-700">No market data found in Supabase.</p>
          <p className="text-[8px] font-mono text-gray-800">Run a History Sync via the MT5 EA to populate data.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {[...symbolGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([symbol, stats]) => (
            <SymbolCard
              key={symbol}
              symbol={symbol}
              stats={stats}
              auditMap={auditMap}
              onRunAudit={(sym, tf) => { void runAudit(sym, tf); }}
              auditLoading={auditLoading}
            />
          ))}
        </div>
      )}

      {/* ── Phase D — Gap Audit error banner ────────────────────── */}
      {auditError && (
        <div className="flex items-center gap-2 border border-red-800/40 bg-red-900/10 px-3 py-2">
          <AlertTriangle size={12} className="text-red-500 shrink-0" />
          <span className="text-[8px] font-mono text-red-400">Audit error: {auditError}</span>
        </div>
      )}

      {/* ── Phase D — Gap Detail Section ──────────────────────────── */}
      <GapDetailSection
        auditMap={auditMap}
        onRunAuditAll={() => { void runAuditAll(); }}
        auditLoading={auditLoading}
        hasData={symbolGroups.size > 0}
      />

      {/* ── Phase 4 Readiness explanation ────────────────────────── */}
      <div className="border border-[#0d1520] bg-[#060a12] p-4 space-y-3 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 size={11} className="text-cyan-500/60" />
          <span className="text-[8px] font-mono text-cyan-500/60 tracking-wider">PHASE 4 DATA READINESS GUIDE</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          {([
            { r: "NOT_READY",           days: "< 60 days",     desc: "Insufficient data for any Phase 4 analysis."            },
            { r: "MONTE_CARLO_READY",   days: "60–89 days",    desc: "Monte Carlo simulation available (min 60 days)."        },
            { r: "OPTIMIZATION_READY",  days: "90–179 days",   desc: "Parameter optimization runs are unlocked."              },
            { r: "WALK_FORWARD_READY",  days: "180–364 days",  desc: "Walk-Forward validation with out-of-sample splits."     },
            { r: "FULL_READY",          days: "365+ days",     desc: "All Phase 4 modes available: MC, OPT, WF, AI analysis." },
          ] as const).map(({ r, days, desc }) => {
            const { label, cls } = READINESS_BADGE[r as MarketDataReadiness];
            return (
              <div key={r} className="space-y-1">
                <span className={cn("inline-block text-[7px] font-mono px-1.5 py-0.5 border", cls)}>
                  {label}
                </span>
                <p className="text-[7.5px] font-mono text-gray-600">{days}</p>
                <p className="text-[7px] font-mono text-gray-700 leading-relaxed">{desc}</p>
              </div>
            );
          })}
        </div>

        <p className="text-[7px] font-mono text-gray-800 border-t border-[#0d1520] pt-2 mt-2">
          Coverage-based readiness only. Actual Phase 4 readiness depends on strategy trade count.
        </p>
      </div>

      {/* ── Recent Sync Jobs ─────────────────────────────────────── */}
      <div className="space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <Activity size={10} className="text-cyan-500/60" />
          <span className="text-[8px] font-mono text-cyan-500/60 tracking-wider">RECENT DATA SYNC</span>
          {recentJobs.length > 0 && (
            <span className="text-[7px] font-mono text-gray-800 ml-1">({recentJobs.length} most recent)</span>
          )}
        </div>

        {recentJobs.length === 0 ? (
          <div className="border border-[#0d1520] bg-[#060a12] px-3 py-4 text-center">
            <p className="text-[8px] font-mono text-gray-700">No sync jobs found.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recentJobs.map(job => <SyncJobRow key={job.id} job={job} />)}
          </div>
        )}
      </div>

    </div>
  );
}

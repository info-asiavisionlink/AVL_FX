// =================================================================
// Data Phase G — Market Data Production Health Model
//
// Pure functions and type definitions for production health monitoring.
// No I/O, no side effects, deterministic output.
//
// Design:
//   - Reuses marketSchedule.ts (getAssetClass, getHolidayRules) for
//     market-closed detection.
//   - HEALTH_THRESHOLDS are named constants, not magic numbers.
//   - getTimeframeStatus() never returns STALE during market closure.
// =================================================================

import { getAssetClass, getHolidayRules } from "./marketSchedule";

// ------------------------------------------------------------------
// Status types
// ------------------------------------------------------------------

export type GatewayStatus = "ONLINE" | "OFFLINE" | "DEGRADED" | "UNKNOWN";
export type EaStatus      = "ONLINE" | "STALE"  | "OFFLINE"  | "UNKNOWN";
export type TimeframeStatus = "LIVE" | "STALE" | "MARKET_CLOSED" | "NO_DATA" | "UNKNOWN";
export type SyncStatus    = "IDLE" | "PENDING" | "RUNNING" | "STALE" | "FAILED" | "UNKNOWN";
export type IntegrityHealth = "HEALTHY" | "WARNING" | "CRITICAL" | "UNKNOWN";
export type OverallHealth   = "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
export type MarketStatus    = "OPEN" | "CLOSED" | "WEEKEND" | "HOLIDAY" | "UNKNOWN";

// ------------------------------------------------------------------
// Thresholds
// ------------------------------------------------------------------

export const HEALTH_THRESHOLDS = {
  /** heartbeat が 2分来ない → STALE */
  EA_STALE_SECONDS: 120,
  /** heartbeat が 10分来ない → OFFLINE */
  EA_OFFLINE_SECONDS: 600,
  /** TF の 3倍以上遅れ → STALE (M5 なら 15分) */
  BAR_STALE_MULTIPLIER: 3,
  /** 30分超は常に STALE (市場 OPEN 時) */
  BAR_STALE_MAX_SECONDS: 1800,
} as const;

// TF string → seconds (same map as EA)
const TF_SECONDS: Record<string, number> = {
  M1:  60,
  M5:  300,
  M15: 900,
  M30: 1800,
  H1:  3600,
  H4:  14400,
  D1:  86400,
  W1:  604800,
};

// ------------------------------------------------------------------
// Interfaces
// ------------------------------------------------------------------

export interface TimeframeHealth {
  timeframe:           string;
  status:              TimeframeStatus;
  latestConfirmedBar:  string | null;
  lagSeconds:          number | null;
  marketStatus:        MarketStatus;
}

export interface EaHealth {
  status:   EaStatus;
  lastSeen: string | null;
  symbol:   string | null;
}

export interface SyncHealth {
  status:         SyncStatus;
  activeJobCount: number;
  lastJobStatus:  string | null;
}

export interface SymbolIntegrity {
  status:         IntegrityHealth;
  suspectedGaps:  number;
  lastAudit:      string | null;
}

export interface SymbolHealth {
  symbol:     string;
  ea:         EaHealth;
  timeframes: TimeframeHealth[];
  sync:       SyncHealth;
  integrity:  SymbolIntegrity;
}

export interface ProductionHealth {
  overall:     OverallHealth;
  gateway:     { status: GatewayStatus; uptime?: number };
  symbols:     SymbolHealth[];
  generatedAt: string;
}

// ------------------------------------------------------------------
// Market status (weekend / holiday detection)
// ------------------------------------------------------------------

/**
 * Determines market status for a given symbol at a given instant.
 *
 * - Saturday or Sunday UTC → WEEKEND
 * - Within a known holiday window (per marketSchedule.ts) → HOLIDAY
 * - Unknown symbol → UNKNOWN (safe side: treat as potentially open)
 * - Otherwise → OPEN
 *
 * Note: This function checks whether *now* is within a holiday window.
 * It uses the same holiday rules as marketSchedule.getHolidayContext(),
 * but applies them to a point-in-time (nowISO) rather than a gap range.
 */
export function getMarketStatus(symbol: string, nowISO?: string): MarketStatus {
  const assetClass = getAssetClass(symbol);
  if (assetClass === "UNKNOWN") return "UNKNOWN";

  const now = nowISO ? new Date(nowISO) : new Date();
  if (isNaN(now.getTime())) return "UNKNOWN";

  // Weekend check (UTC day-of-week: 0=Sun, 6=Sat)
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return "WEEKEND";

  // Holiday check: is "now" within a holiday closure window?
  // We use the holiday calendar rules and check whether the current moment
  // falls within [holidayDate - windowBeforeDays, holidayDate + windowAfterDays].
  // This is a point-in-time check, not a gap-range check.
  const rules = getHolidayRules(symbol);
  if (rules.length > 0) {
    const nowMs = now.getTime();
    const year  = now.getUTCFullYear();

    for (const rule of rules) {
      // Check this year and adjacent years (for New Year year-boundary)
      for (const y of [year - 1, year, year + 1]) {
        const holidayMs    = Date.UTC(y, rule.month - 1, rule.day);
        const windowStartMs = holidayMs - rule.windowBeforeDays  * 86400 * 1000;
        const windowEndMs   = holidayMs + rule.windowAfterDays   * 86400 * 1000;

        if (nowMs >= windowStartMs && nowMs <= windowEndMs) {
          return "HOLIDAY";
        }
      }
    }
  }

  return "OPEN";
}

// ------------------------------------------------------------------
// EA Status
// ------------------------------------------------------------------

/**
 * Determines EA health status based on last heartbeat timestamp.
 *
 * null lastHeartbeatISO → UNKNOWN (Gateway just restarted or never connected)
 * lag <= EA_STALE_SECONDS      → ONLINE
 * lag <= EA_OFFLINE_SECONDS    → STALE
 * lag >  EA_OFFLINE_SECONDS    → OFFLINE
 */
export function getEaStatus(lastHeartbeatISO: string | null, nowISO?: string): EaStatus {
  if (!lastHeartbeatISO) return "UNKNOWN";

  const lastMs = new Date(lastHeartbeatISO).getTime();
  if (isNaN(lastMs)) return "UNKNOWN";

  const nowMs   = nowISO ? new Date(nowISO).getTime() : Date.now();
  const lagSec  = (nowMs - lastMs) / 1000;

  if (lagSec <= HEALTH_THRESHOLDS.EA_STALE_SECONDS)   return "ONLINE";
  if (lagSec <= HEALTH_THRESHOLDS.EA_OFFLINE_SECONDS) return "STALE";
  return "OFFLINE";
}

// ------------------------------------------------------------------
// Timeframe freshness
// ------------------------------------------------------------------

/**
 * Determines the health status for a single timeframe's bar data.
 *
 * Logic:
 *   1. newestBarISO is null → NO_DATA
 *   2. Get market status for the symbol
 *   3. Market CLOSED / WEEKEND / HOLIDAY → MARKET_CLOSED (no false positives)
 *   4. Market UNKNOWN → still check staleness (safe: don't hide real stale)
 *   5. Market OPEN:
 *      lagSec > BAR_STALE_MAX_SECONDS → STALE
 *      lagSec > tfSec * BAR_STALE_MULTIPLIER → STALE
 *      else → LIVE
 */
export function getTimeframeStatus(
  newestBarISO:  string | null,
  timeframe:     string,
  symbol:        string,
  nowISO?:       string,
): TimeframeStatus {
  if (!newestBarISO) return "NO_DATA";

  const lastMs = new Date(newestBarISO).getTime();
  if (isNaN(lastMs)) return "UNKNOWN";

  const nowMs   = nowISO ? new Date(nowISO).getTime() : Date.now();
  const lagSec  = (nowMs - lastMs) / 1000;

  const marketStatus = getMarketStatus(symbol, nowISO);

  // During known market closures, suppress false STALE signals
  if (marketStatus === "WEEKEND" || marketStatus === "HOLIDAY" || marketStatus === "CLOSED") {
    return "MARKET_CLOSED";
  }

  // Market OPEN (or UNKNOWN — don't suppress stale detection for unknown symbols)
  const tfSec = TF_SECONDS[timeframe.toUpperCase()] ?? 0;

  if (lagSec > HEALTH_THRESHOLDS.BAR_STALE_MAX_SECONDS) return "STALE";
  if (tfSec > 0 && lagSec > tfSec * HEALTH_THRESHOLDS.BAR_STALE_MULTIPLIER) return "STALE";

  return "LIVE";
}

// ------------------------------------------------------------------
// Overall health
// ------------------------------------------------------------------

/**
 * Computes overall system health from gateway status + all symbol health.
 *
 * Priority: CRITICAL > DEGRADED > HEALTHY
 *   - Gateway OFFLINE → CRITICAL
 *   - Any symbol EA OFFLINE → CRITICAL
 *   - Any TF STALE (market open) → DEGRADED
 *   - Any EA STALE → DEGRADED
 *   - Gateway DEGRADED → DEGRADED
 *   - All LIVE → HEALTHY
 *   - Empty symbols → UNKNOWN
 */
export function getOverallHealth(
  gatewayStatus:    GatewayStatus,
  symbolHealthList: SymbolHealth[],
): OverallHealth {
  if (gatewayStatus === "OFFLINE") return "CRITICAL";
  if (symbolHealthList.length === 0) return "UNKNOWN";

  let hasDegraded = false;

  if (gatewayStatus === "DEGRADED") hasDegraded = true;

  for (const sym of symbolHealthList) {
    // EA offline → CRITICAL
    if (sym.ea.status === "OFFLINE") return "CRITICAL";

    // EA stale → DEGRADED
    if (sym.ea.status === "STALE") hasDegraded = true;

    // Any TF stale → DEGRADED
    for (const tf of sym.timeframes) {
      if (tf.status === "STALE") hasDegraded = true;
    }

    // Sync FAILED → DEGRADED
    if (sym.sync.status === "FAILED") hasDegraded = true;

    // Integrity CRITICAL → CRITICAL
    if (sym.integrity.status === "CRITICAL") return "CRITICAL";

    // Integrity WARNING → DEGRADED
    if (sym.integrity.status === "WARNING") hasDegraded = true;
  }

  return hasDegraded ? "DEGRADED" : "HEALTHY";
}

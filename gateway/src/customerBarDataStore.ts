// =================================================================
// customerBarDataStore.ts — V2 Customer Market Data Persistence
//
// Responsibility:
//   - Idempotent upsert of OHLC bars to customer_bar_data table
//   - Gap detection: last persisted bar per connection+symbol+timeframe
//   - Data validation (open=0, high<low, future timestamp)
//   - Symbol canonicalization (broker_symbol → canonical_symbol)
//
// Safety: SUPABASE_URL / SUPABASE_SERVICE_KEY not set → disabled (no crash)
// V1 bar_data table is NOT touched by this module.
// =================================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { WebSocket as WS } from "ws";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export type BarSource = "bridge_realtime" | "bridge_backfill" | "bridge_recovery";

export const SUPPORTED_TIMEFRAMES = new Set([
  "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1",
]);

export interface BarIngestionInput {
  connection_id: string;
  user_id: string;
  broker_symbol: string;
  canonical_symbol: string;
  timeframe: string;
  time_utc: string;   // ISO 8601 UTC timestamp (bar open time)
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume?: number;
  spread?: number;
  source: BarSource;
  is_confirmed?: boolean;
  broker?: string;
  broker_server?: string;
}

export interface BarValidationError {
  index: number;
  reason: string;
}

export interface UpsertResult {
  accepted: number;
  rejected: number;
  errors: BarValidationError[];
  db_error?: string;
}

export interface LastBarResult {
  time_utc: string | null;
  error?: string;  // present only on query failure, to distinguish from empty history
}

// ----------------------------------------------------------------
// Symbol canonicalization
// Matches the existing pattern in gateway/src/index.ts (/bridge/symbol-spec)
// GOLD# → GOLD, XAUUSD → GOLD, GOLD → GOLD
// ----------------------------------------------------------------

export function canonicalizeSymbol(brokerSymbol: string): string {
  // Uppercase first so aliases apply consistently regardless of input case
  return brokerSymbol
    .toUpperCase()
    .replace("#", "")
    .replace("XAU", "GOLD")
    .replace(/^GOLD.*USD$/, "GOLD")  // catch GOLDUSD edge case after XAU→GOLD
    .replace(/USD$/, "")
    .replace(/[-_].*/, "");
}

// ----------------------------------------------------------------
// Bar validation
// ----------------------------------------------------------------

export function validateBar(
  bar: Pick<BarIngestionInput, "open" | "high" | "low" | "close" | "time_utc" | "timeframe">,
  nowMs?: number,
): string | null {
  const now = nowMs ?? Date.now();

  if (typeof bar.open !== "number" || !Number.isFinite(bar.open) || bar.open <= 0) return "open must be a finite number > 0";
  if (typeof bar.close !== "number" || !Number.isFinite(bar.close) || bar.close <= 0) return "close must be a finite number > 0";
  if (typeof bar.high !== "number" || !Number.isFinite(bar.high) || bar.high <= 0) return "high must be a finite number > 0";
  if (typeof bar.low !== "number" || !Number.isFinite(bar.low) || bar.low <= 0) return "low must be a finite number > 0";
  if (bar.high < bar.low) return "high must be >= low";
  if (bar.high < bar.open) return "high must be >= open";
  if (bar.high < bar.close) return "high must be >= close";
  if (bar.low > bar.open) return "low must be <= open";
  if (bar.low > bar.close) return "low must be <= close";

  const barTime = new Date(bar.time_utc).getTime();
  if (isNaN(barTime)) return "time_utc is not a valid ISO timestamp";
  // Allow up to 60s clock skew
  if (barTime > now + 60_000) return "time_utc is in the future";

  if (!SUPPORTED_TIMEFRAMES.has(bar.timeframe)) {
    return `timeframe '${bar.timeframe}' is not supported`;
  }

  return null;
}

// ----------------------------------------------------------------
// Supabase client (lazy init)
// ----------------------------------------------------------------

let _client: SupabaseClient | null = null;
let _initialized = false;
let _enabled = false;

function getClient(): SupabaseClient | null {
  if (_initialized) return _enabled ? _client : null;
  _initialized = true;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("[customerBarData] SUPABASE_URL/KEY not set — customer_bar_data disabled");
    return null;
  }

  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WS as any },
  });
  _enabled = true;
  console.log("[customerBarData] Supabase ready — customer_bar_data persistence enabled");
  return _client;
}

export function isEnabled(): boolean {
  getClient();
  return _enabled;
}

// ----------------------------------------------------------------
// Upsert bars (idempotent)
// ----------------------------------------------------------------

const UPSERT_BATCH_SIZE = 500;

export async function upsertCustomerBars(bars: BarIngestionInput[]): Promise<UpsertResult> {
  const result: UpsertResult = { accepted: 0, rejected: 0, errors: [] };

  const valid: BarIngestionInput[] = [];
  for (let i = 0; i < bars.length; i++) {
    const err = validateBar(bars[i]);
    if (err) {
      result.rejected++;
      result.errors.push({ index: i, reason: err });
    } else {
      valid.push(bars[i]);
    }
  }

  if (valid.length === 0) return result;

  const client = getClient();
  if (!client) {
    result.db_error = "customer_bar_data store disabled (SUPABASE_URL/KEY not set)";
    return result;
  }

  // Deduplicate by canonical key before upsert.
  // PostgreSQL ON CONFLICT UPDATE rejects two rows targeting the same key in one statement.
  const dedupMap = new Map<string, BarIngestionInput>();
  for (const b of valid) {
    const key = `${b.connection_id}|${b.canonical_symbol}|${b.timeframe}|${b.time_utc}`;
    dedupMap.set(key, b); // last bar for same key wins
  }
  const deduped = [...dedupMap.values()];

  const rows = deduped.map((b) => ({
    user_id:          b.user_id,
    connection_id:    b.connection_id,
    canonical_symbol: b.canonical_symbol,
    broker_symbol:    b.broker_symbol,
    broker:           b.broker ?? null,
    broker_server:    b.broker_server ?? null,
    timeframe:        b.timeframe,
    time_utc:         b.time_utc,
    open:             b.open,
    high:             b.high,
    low:              b.low,
    close:            b.close,
    tick_volume:      b.tick_volume ?? null,
    spread:           b.spread ?? null,
    source:           b.source,
    is_confirmed:     b.is_confirmed ?? true,
    updated_at:       new Date().toISOString(),
  }));

  // Conflict resolution strategy:
  //   realtime source  → ignoreDuplicates: false (allow updating forming bars with same timestamp)
  //   recovery/backfill → ignoreDuplicates: true  (never overwrite higher-quality realtime data)
  const allRealtime = deduped.every((b) => b.source === "bridge_realtime");
  const ignoreDups  = !allRealtime; // recovery/backfill: skip on conflict

  // Batch upsert
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await client
      .from("customer_bar_data")
      .upsert(batch, {
        onConflict:       "connection_id,canonical_symbol,timeframe,time_utc",
        ignoreDuplicates: ignoreDups,
      });

    if (error) {
      console.error("[customerBarData] upsert error:", error.message);
      result.db_error = error.message;
      return result;
    }
    result.accepted += batch.length;
  }

  return result;
}

// ----------------------------------------------------------------
// Count bars in a time range (completeness verification)
// ----------------------------------------------------------------

export async function countCustomerBarsInRange(
  connectionId:    string,
  canonicalSymbol: string,
  timeframe:       string,
  fromUtc:         string,
  toUtc:           string,
): Promise<{ count: number; error?: string }> {
  const client = getClient();
  if (!client) return { count: 0, error: "store disabled" };

  const { count, error } = await client
    .from("customer_bar_data")
    .select("*", { count: "exact", head: true })
    .eq("connection_id",    connectionId)
    .eq("canonical_symbol", canonicalSymbol)
    .eq("timeframe",        timeframe)
    .gte("time_utc",        fromUtc)
    .lte("time_utc",        toUtc);

  if (error) {
    console.error("[customerBarData] countBarsInRange error:", error.message);
    return { count: 0, error: error.message };
  }
  return { count: count ?? 0 };
}

// ----------------------------------------------------------------
// BackfillSummary type and logger
// ----------------------------------------------------------------

export interface BackfillSummary {
  connection_id:    string;
  user_id:          string;
  canonical_symbol: string;
  timeframe:        string;
  from_utc?:        string;
  to_utc?:          string;
  bars_sent:        number;
  bars_accepted:    number;
  bars_verified?:   number;
  gap_remaining:    boolean;
  source:           "bridge_recovery" | "bridge_backfill";
}

export async function logCustomerBackfill(summary: BackfillSummary): Promise<{ error?: string }> {
  const client = getClient();
  if (!client) return {};  // non-fatal: logging is fire-and-forget

  const { error } = await client
    .from("customer_backfill_logs")
    .insert({
      connection_id:    summary.connection_id,
      user_id:          summary.user_id,
      canonical_symbol: summary.canonical_symbol,
      timeframe:        summary.timeframe,
      from_utc:         summary.from_utc ?? null,
      to_utc:           summary.to_utc ?? null,
      bars_sent:        summary.bars_sent,
      bars_accepted:    summary.bars_accepted,
      bars_verified:    summary.bars_verified ?? null,
      gap_remaining:    summary.gap_remaining,
      source:           summary.source,
    });

  if (error) {
    console.warn("[customerBarData] backfill log failed:", error.message);
    return { error: error.message };
  }
  return {};
}

// ----------------------------------------------------------------
// Get last persisted bar time (gap detection)
// ----------------------------------------------------------------

export async function getLastCustomerBar(
  connectionId: string,
  canonicalSymbol: string,
  timeframe: string,
): Promise<LastBarResult> {
  const client = getClient();
  if (!client) return { time_utc: null };

  const { data, error } = await client
    .from("customer_bar_data")
    .select("time_utc")
    .eq("connection_id", connectionId)
    .eq("canonical_symbol", canonicalSymbol)
    .eq("timeframe", timeframe)
    .order("time_utc", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[customerBarData] last-bar query error:", error.message);
    return { time_utc: null, error: error.message };
  }

  return { time_utc: data?.time_utc ?? null };
}

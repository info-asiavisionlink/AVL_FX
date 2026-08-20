// =================================================================
// GET /api/market-data/health
//
// Data Phase G — Production Health API
//
// Lightweight design:
//   - 3 queries total: get_bar_data_status() RPC + sync jobs + Gateway /health
//   - No full table scan (uses existing RPC with GROUP BY)
//   - Safe to include in 30-second polling cycle
//
// Response: ProductionHealth (see marketDataHealth.ts)
// =================================================================

import { NextResponse }      from "next/server";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import {
  getEaStatus,
  getTimeframeStatus,
  getOverallHealth,
  getMarketStatus,
  type GatewayStatus,
  type EaStatus,
  type SyncStatus,
  type IntegrityHealth,
  type SymbolHealth,
  type TimeframeHealth,
  type EaHealth,
  type SyncHealth,
  type SymbolIntegrity,
  type ProductionHealth,
} from "@/infrastructure/market-data/marketDataHealth";

export const runtime = "nodejs";

// Timeframes tracked per symbol (matches EA's g_TfList)
const TRACKED_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"] as const;

// ------------------------------------------------------------------
// Gateway health fetch
// ------------------------------------------------------------------

interface GatewayHealthResponse {
  status:      string;
  uptime:      number;
  eaConnected: boolean;
  heartbeats?: Record<string, string>; // symbol → ISO (Phase G addition)
  ea?:         { symbol?: string } | null;
}

async function fetchGatewayHealth(gw: string, secret?: string): Promise<{
  status:     GatewayStatus;
  uptime?:    number;
  heartbeats: Record<string, string>;
  raw:        GatewayHealthResponse | null;
}> {
  try {
    const headers: Record<string, string> = {};
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    const res = await fetch(`${gw}/health`, {
      headers,
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) {
      return { status: "DEGRADED", heartbeats: {}, raw: null };
    }
    const data = await res.json() as GatewayHealthResponse;
    const gwStatus: GatewayStatus = data.status === "ok" ? "ONLINE" : "DEGRADED";
    return {
      status:     gwStatus,
      uptime:     data.uptime,
      heartbeats: data.heartbeats ?? {},
      raw:        data,
    };
  } catch {
    return { status: "OFFLINE", heartbeats: {}, raw: null };
  }
}

// ------------------------------------------------------------------
// Supabase bar_data status (newest bar per symbol/TF)
// ------------------------------------------------------------------

interface BarDataStatusRow {
  symbol:     string;
  timeframe:  string;
  bar_count:  number;
  oldest_bar: string;
  newest_bar: string;
  span_days:  number;
}

async function fetchBarDataStatus(db: ReturnType<typeof createAdminClient>): Promise<{
  rows: BarDataStatusRow[];
  error: string | null;
}> {
  try {
    const { data, error } = await db.rpc("get_bar_data_status");
    if (error) return { rows: [], error: error.message };
    return { rows: (data ?? []) as BarDataStatusRow[], error: null };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : "RPC error" };
  }
}

// ------------------------------------------------------------------
// Sync jobs status
// ------------------------------------------------------------------

interface SyncJobRow {
  symbol:    string;
  timeframe: string;
  status:    string;
  updated_at: string | null;
}

async function fetchSyncJobs(db: ReturnType<typeof createAdminClient>): Promise<SyncJobRow[]> {
  try {
    const { data } = await db
      .from("market_data_sync_jobs")
      .select("symbol, timeframe, status, updated_at")
      .in("status", ["PENDING", "RUNNING", "FAILED"])
      .order("created_at", { ascending: false })
      .limit(50);
    return (data ?? []) as SyncJobRow[];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------
// Build SyncHealth for a symbol
// ------------------------------------------------------------------

const SYNC_STALE_MS = 5 * 60 * 1000; // 5 minutes (matches Migration 015)

function buildSyncHealth(symbol: string, jobs: SyncJobRow[]): SyncHealth {
  const symJobs = jobs.filter(j => j.symbol.toUpperCase() === symbol.toUpperCase());

  if (symJobs.length === 0) {
    return { status: "IDLE", activeJobCount: 0, lastJobStatus: null };
  }

  const activeJobs = symJobs.filter(j => j.status === "PENDING" || j.status === "RUNNING");
  const failedJobs = symJobs.filter(j => j.status === "FAILED");

  // Check for stale RUNNING jobs
  const staleRunning = activeJobs.filter(j => {
    if (j.status !== "RUNNING" || !j.updated_at) return false;
    return Date.now() - new Date(j.updated_at).getTime() > SYNC_STALE_MS;
  });

  let syncStatus: SyncStatus = "IDLE";
  if (staleRunning.length > 0)   syncStatus = "STALE";
  else if (failedJobs.length > 0) syncStatus = "FAILED";
  else if (activeJobs.some(j => j.status === "RUNNING")) syncStatus = "RUNNING";
  else if (activeJobs.some(j => j.status === "PENDING")) syncStatus = "PENDING";

  const lastJobStatus = symJobs[0]?.status ?? null;

  return {
    status:         syncStatus,
    activeJobCount: activeJobs.length,
    lastJobStatus,
  };
}

// ------------------------------------------------------------------
// Build per-symbol SymbolHealth
// ------------------------------------------------------------------

function buildSymbolHealth(
  symbol:     string,
  barRows:    BarDataStatusRow[],
  syncJobs:   SyncJobRow[],
  heartbeats: Record<string, string>,
  nowISO:     string,
): SymbolHealth {
  // EA health
  const lastHeartbeatISO = heartbeats[symbol.toUpperCase()] ?? null;
  const eaStatus: EaStatus = getEaStatus(lastHeartbeatISO, nowISO);
  const ea: EaHealth = {
    status:   eaStatus,
    lastSeen: lastHeartbeatISO,
    symbol,
  };

  // Timeframe health (build for all tracked TFs)
  const barByTF = new Map<string, BarDataStatusRow>();
  for (const row of barRows) {
    if (row.symbol.toUpperCase() === symbol.toUpperCase()) {
      barByTF.set(row.timeframe.toUpperCase(), row);
    }
  }

  const timeframes: TimeframeHealth[] = TRACKED_TIMEFRAMES.map(tf => {
    const row = barByTF.get(tf) ?? null;
    const newestBarISO = row?.newest_bar ?? null;
    const status = getTimeframeStatus(newestBarISO, tf, symbol, nowISO);
    const marketStatus = getMarketStatus(symbol, nowISO);

    let lagSeconds: number | null = null;
    if (newestBarISO) {
      const lagMs = new Date(nowISO).getTime() - new Date(newestBarISO).getTime();
      lagSeconds = Math.floor(lagMs / 1000);
    }

    return {
      timeframe:          tf,
      status,
      latestConfirmedBar: newestBarISO,
      lagSeconds,
      marketStatus,
    };
  });

  // Sync health
  const sync = buildSyncHealth(symbol, syncJobs);

  // Integrity health (lightweight: use suspectedGaps count from bar coverage)
  // Full gap audit is manual-only (Gap Audit button in UI) — not run here.
  const integrity: SymbolIntegrity = {
    status:        "UNKNOWN" as IntegrityHealth,
    suspectedGaps: 0,
    lastAudit:     null,
  };

  return { symbol, ea, timeframes, sync, integrity };
}

// ------------------------------------------------------------------
// Derive distinct symbols from bar data + heartbeats
// ------------------------------------------------------------------

function getTrackedSymbols(barRows: BarDataStatusRow[], heartbeats: Record<string, string>): string[] {
  const set = new Set<string>();
  for (const row of barRows) set.add(row.symbol.toUpperCase());
  for (const sym of Object.keys(heartbeats)) set.add(sym.toUpperCase());
  return [...set].sort();
}

// ------------------------------------------------------------------
// GET handler
// ------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const gw     = process.env.MT5_GATEWAY_URL    ?? "http://127.0.0.1:8080";
  const secret = process.env.MT5_GATEWAY_SECRET ?? undefined;

  const nowISO = new Date().toISOString();
  const db     = createAdminClient();

  // 3 parallel queries: Gateway + bar status + sync jobs
  const [gwResult, barResult, syncJobs] = await Promise.all([
    fetchGatewayHealth(gw, secret),
    fetchBarDataStatus(db),
    fetchSyncJobs(db),
  ]);

  const symbols = getTrackedSymbols(barResult.rows, gwResult.heartbeats);

  const symbolHealthList: SymbolHealth[] = symbols.map(sym =>
    buildSymbolHealth(sym, barResult.rows, syncJobs, gwResult.heartbeats, nowISO),
  );

  const overall = getOverallHealth(gwResult.status, symbolHealthList);

  const health: ProductionHealth = {
    overall,
    gateway: {
      status: gwResult.status,
      uptime: gwResult.raw?.uptime,
    },
    symbols:     symbolHealthList,
    generatedAt: nowISO,
  };

  return NextResponse.json(health);
}

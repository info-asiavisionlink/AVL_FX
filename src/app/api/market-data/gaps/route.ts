// =================================================================
// GET /api/market-data/gaps?symbol=EURUSD&timeframe=M5
//
// Data Phase D — Gap Detection / Market Data Integrity Audit
//
// This endpoint is intentionally NOT included in the 30-second
// polling cycle. It is called only on explicit user request from
// the Coverage UI (RUN GAP AUDIT button).
//
// It fetches all bars for the requested symbol/timeframe, runs
// the pure gap detection algorithm, and returns the full audit
// result including per-gap details and an overall integrity status.
// =================================================================

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }          from "@/infrastructure/supabase/admin";
import { fetchAllBars }               from "@/infrastructure/market-data/fetchAllBars";
import {
  detectGapCandidates,
  summarizeGaps,
  type GapCandidate,
  type GapSummary,
} from "@/infrastructure/market-data/marketDataGapDetection";

export const runtime = "nodejs";

// Supported timeframes — must match bar_data contents
const SUPPORTED_TIMEFRAMES = new Set([
  "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1",
]);

interface GapsResponse {
  symbol:     string;
  timeframe:  string;
  barCount:   number;
  from:       string | null;
  to:         string | null;
  auditedAt:  string;
  summary:    GapSummary;
  gaps:       GapCandidate[];
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const symbol    = searchParams.get("symbol")?.toUpperCase() ?? "";
  const timeframe = searchParams.get("timeframe")?.toUpperCase() ?? "";
  const showAll   = searchParams.get("all") === "1"; // default: SUSPECTED_GAP only

  // ── Validation ────────────────────────────────────────────────

  if (!symbol) {
    return NextResponse.json(
      { error: "symbol query parameter is required" },
      { status: 400 },
    );
  }

  if (!timeframe) {
    return NextResponse.json(
      { error: "timeframe query parameter is required" },
      { status: 400 },
    );
  }

  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) {
    return NextResponse.json(
      {
        error: `timeframe must be one of: ${[...SUPPORTED_TIMEFRAMES].join(", ")}`,
      },
      { status: 400 },
    );
  }

  // ── Fetch all bars (paginated) ────────────────────────────────

  const db = createAdminClient();

  let bars: Array<{ time_utc: string }>;
  try {
    bars = await fetchAllBars(db, symbol, timeframe);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown fetch error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // ── Audit ─────────────────────────────────────────────────────

  const allGaps = detectGapCandidates(bars, timeframe);
  const summary = summarizeGaps(allGaps);

  // Filter: by default return only SUSPECTED_GAP for UI efficiency.
  // Caller can pass ?all=1 to receive all gap types.
  const responseGaps = showAll
    ? allGaps
    : allGaps.filter(g => g.classification === "SUSPECTED_GAP");

  const from = bars.length > 0 ? bars[0]!.time_utc    : null;
  const to   = bars.length > 0 ? bars[bars.length - 1]!.time_utc : null;

  const body: GapsResponse = {
    symbol,
    timeframe,
    barCount:  bars.length,
    from,
    to,
    auditedAt: new Date().toISOString(),
    summary,
    gaps:      responseGaps,
  };

  return NextResponse.json(body);
}

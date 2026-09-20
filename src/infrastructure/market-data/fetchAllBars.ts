// =================================================================
// fetchAllBars — Paginated bar_data fetch utility
//
// Supabase enforces a 1000-row limit per request. This function
// uses offset-based pagination to collect all bars for a given
// symbol/timeframe in a single call, ordered ASC for gap detection.
// =================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE_SIZE = 1000;

/**
 * Fetches all bars for the given symbol and timeframe from bar_data,
 * handling Supabase's 1000-row limit via offset-based pagination.
 *
 * Returns rows ordered by time_utc ASC, as required by detectGapCandidates.
 */
export async function fetchAllBars(
  supabase: SupabaseClient,
  symbol: string,
  timeframe: string,
): Promise<Array<{ time_utc: string }>> {
  const allRows: Array<{ time_utc: string }> = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("bar_data")
      .select("time_utc")
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
      .order("time_utc", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(
        `fetchAllBars failed (${symbol} ${timeframe} offset=${offset}): ${error.message}`,
      );
    }

    const rows = (data as Array<{ time_utc: string }>) ?? [];
    if (rows.length === 0) break;

    allRows.push(...rows);

    // If fewer rows than PAGE_SIZE were returned, we have reached the end
    if (rows.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
  }

  return allRows;
}

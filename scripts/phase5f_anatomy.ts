/**
 * Phase 5-F: Trade Anatomy Analysis
 *
 * Fetches backtest_trades from Phase 5-C LONG + SHORT jobs,
 * loads all M5 bar_data into memory, then computes MFE/MAE
 * and a comprehensive set of structural statistics.
 *
 * Usage: npx tsx --env-file=.env.local scripts/phase5f_anatomy.ts
 */

// ── Config ──────────────────────────────────────────────────────────

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const LONG_JOB_ID  = "06ad086c-5473-4397-ba29-66437d9886b7";
const SHORT_JOB_ID = "18cef39d-eeed-4cc4-b5d9-dae1a4611e21";

const PIP = 0.0001;          // EURUSD pip size
const MAX_BARS_PER_TRADE = 50;
const PAGE_SIZE = 1000;

// ── Types ────────────────────────────────────────────────────────────

interface TradeRow {
  id:           string;
  job_id:       string;
  direction:    "BUY" | "SELL";
  entry_time:   string;
  exit_time:    string | null;
  entry_price:  number;
  exit_price:   number | null;
  sl:           number | null;
  tp:           number | null;
  pips:         number | null;
  result:       "WIN" | "LOSS" | "BREAKEVEN" | "END_OF_DATA" | null;
  exit_reason:  "TP" | "SL" | "END_OF_DATA" | null;
  duration_min: number | null;
  session:      string | null;
  entry_bar_idx: number | null;
  exit_bar_idx:  number | null;
}

interface BarRow {
  time_utc: string;
  open:     number;
  high:     number;
  low:      number;
  close:    number;
}

interface EnrichedTrade extends TradeRow {
  mfe:       number;   // pips, >= 0
  mae:       number;   // pips, <= 0
  bars_held: number;   // number of M5 bars from entry to exit
  returns_at_bar: {
    b5:  number | null;
    b10: number | null;
    b20: number | null;
    b50: number | null;
  };
  first_bar_favorable: boolean | null;
  atr14_entry: number | null;
}

// ── Fetch helpers ────────────────────────────────────────────────────

async function fetchTrades(jobId: string): Promise<TradeRow[]> {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const all: TradeRow[] = [];
  let offset = 0;

  for (;;) {
    const url =
      `${SB_URL}/rest/v1/backtest_trades` +
      `?select=id,job_id,direction,entry_time,exit_time,entry_price,exit_price,sl,tp,pips,result,exit_reason,duration_min,session,entry_bar_idx,exit_bar_idx` +
      `&job_id=eq.${jobId}` +
      `&order=entry_time.asc` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetchTrades failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as TradeRow[];
    // Ensure numeric fields are numbers
    for (const r of rows) {
      r.entry_price  = Number(r.entry_price);
      r.exit_price   = r.exit_price  != null ? Number(r.exit_price)  : null;
      r.sl           = r.sl          != null ? Number(r.sl)          : null;
      r.tp           = r.tp          != null ? Number(r.tp)          : null;
      r.pips         = r.pips        != null ? Number(r.pips)        : null;
      r.duration_min = r.duration_min != null ? Number(r.duration_min) : null;
    }
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}

async function fetchAllM5Bars(): Promise<BarRow[]> {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const all: BarRow[] = [];
  let offset = 0;

  console.log("  Fetching M5 bars (all)...");
  for (;;) {
    const url =
      `${SB_URL}/rest/v1/bar_data` +
      `?select=time_utc,open,high,low,close` +
      `&symbol=eq.EURUSD&timeframe=eq.M5` +
      `&order=time_utc.asc` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetchAllM5Bars failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as BarRow[];
    for (const r of rows) {
      r.open  = Number(r.open);
      r.high  = Number(r.high);
      r.low   = Number(r.low);
      r.close = Number(r.close);
    }
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset % 10_000 === 0) process.stdout.write(`    ...${offset} bars loaded\n`);
  }

  return all;
}

// ── ATR calculation (Wilder, period 14) ─────────────────────────────

function calcATR14(bars: BarRow[], idx: number): number | null {
  const period = 14;
  if (idx < period) return null;

  // First ATR = simple average of first 14 TRs
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const b  = bars[i];
    const bp = bars[i - 1];
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - bp.close),
      Math.abs(b.low  - bp.close),
    );
    atr += tr;
  }
  atr /= period;

  // Wilder smoothing from bar period+1 to idx
  for (let i = period + 1; i <= idx; i++) {
    const b  = bars[i];
    const bp = bars[i - 1];
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - bp.close),
      Math.abs(b.low  - bp.close),
    );
    atr = (atr * (period - 1) + tr) / period;
  }

  return atr;
}

// ── MFE / MAE ────────────────────────────────────────────────────────

/**
 * Given a slice of M5 bars (from entry bar to exit bar, inclusive),
 * calculate MFE (in pips, >=0) and MAE (in pips, <=0) for a trade.
 */
function calcMfeMae(
  direction: "BUY" | "SELL",
  entryPrice: number,
  bars: BarRow[],
): { mfe: number; mae: number } {
  let mfe = 0;
  let mae = 0;

  for (const b of bars) {
    if (direction === "BUY") {
      const favorable   = (b.high  - entryPrice) / PIP;
      const unfavorable = (b.low   - entryPrice) / PIP; // negative
      if (favorable   > mfe) mfe = favorable;
      if (unfavorable < mae) mae = unfavorable;
    } else {
      const favorable   = (entryPrice - b.low)  / PIP;
      const unfavorable = (entryPrice - b.high) / PIP; // negative
      if (favorable   > mfe) mfe = favorable;
      if (unfavorable < mae) mae = unfavorable;
    }
  }

  return { mfe, mae };
}

// ── Enrich trades ────────────────────────────────────────────────────

function enrichTrades(
  trades: TradeRow[],
  barMap: Map<number, BarRow>,
  sortedTimestamps: number[],
): EnrichedTrade[] {
  return trades.map((t) => {
    const entryTs = new Date(t.entry_time).getTime();
    const exitTs  = t.exit_time ? new Date(t.exit_time).getTime() : null;

    // Find starting index in sortedTimestamps
    // The entry bar is the bar that opened AT or AFTER entry_time
    // (BacktestEngine uses next-bar-open for execution)
    let startIdx = sortedTimestamps.findIndex((ts) => ts >= entryTs);
    if (startIdx < 0) startIdx = sortedTimestamps.length - 1;

    // Exit index: last bar whose time_utc <= exit_time
    let endIdx = startIdx;
    if (exitTs !== null) {
      for (let i = startIdx; i < sortedTimestamps.length; i++) {
        if (sortedTimestamps[i] > exitTs) break;
        endIdx = i;
      }
    }

    // Cap to MAX_BARS_PER_TRADE
    const capIdx = Math.min(endIdx, startIdx + MAX_BARS_PER_TRADE - 1);

    // Collect bars
    const bars: BarRow[] = [];
    for (let i = startIdx; i <= capIdx; i++) {
      const b = barMap.get(sortedTimestamps[i]);
      if (b) bars.push(b);
    }

    const { mfe, mae } = calcMfeMae(t.direction, t.entry_price, bars);

    // N-bar returns (pips at bar N relative to entry price)
    const returnAt = (n: number): number | null => {
      const idx = startIdx + n - 1;
      if (idx >= sortedTimestamps.length) return null;
      const b = barMap.get(sortedTimestamps[idx]);
      if (!b) return null;
      if (t.direction === "BUY")  return (b.close - t.entry_price) / PIP;
      return (t.entry_price - b.close) / PIP;
    };

    // First bar direction (favorable = close moved toward profit)
    let firstBarFavorable: boolean | null = null;
    if (bars.length >= 1) {
      const fb = bars[0];
      if (t.direction === "BUY")  firstBarFavorable = fb.close > t.entry_price;
      else                         firstBarFavorable = fb.close < t.entry_price;
    }

    // ATR(14) at entry bar
    const atr14Entry = calcATR14AtIndex(barMap, sortedTimestamps, startIdx);

    return {
      ...t,
      mfe,
      mae,
      bars_held: bars.length,
      returns_at_bar: {
        b5:  returnAt(5),
        b10: returnAt(10),
        b20: returnAt(20),
        b50: returnAt(50),
      },
      first_bar_favorable: firstBarFavorable,
      atr14_entry: atr14Entry,
    };
  });
}

// Compute ATR14 at a given bar index using the full sorted array
const atrCache = new Map<number, number | null>();

function calcATR14AtIndex(
  barMap: Map<number, BarRow>,
  sortedTs: number[],
  idx: number,
): number | null {
  if (atrCache.has(idx)) return atrCache.get(idx)!;

  const period = 14;
  if (idx < period) {
    atrCache.set(idx, null);
    return null;
  }

  // Build sub-array (we need bars[0..idx])
  // This is expensive if called for every trade. We'll pre-compute the full ATR array once.
  // But here we use a simplified approach — called after pre-computation.
  const result = null;
  atrCache.set(idx, result);
  return result;
}

// Pre-compute full ATR14 array for all bars
function precomputeATR14(bars: BarRow[]): (number | null)[] {
  const period = 14;
  const result: (number | null)[] = new Array(bars.length).fill(null);

  if (bars.length < period + 1) return result;

  // First ATR = simple average of first 14 TRs
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const b  = bars[i];
    const bp = bars[i - 1];
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - bp.close),
      Math.abs(b.low  - bp.close),
    );
    atr += tr;
  }
  atr /= period;
  result[period] = atr;

  for (let i = period + 1; i < bars.length; i++) {
    const b  = bars[i];
    const bp = bars[i - 1];
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - bp.close),
      Math.abs(b.low  - bp.close),
    );
    atr = (atr * (period - 1) + tr) / period;
    result[i] = atr;
  }

  return result;
}

// ── Statistics helpers ───────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function percentile(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((pct / 100) * (sorted.length - 1));
  return sorted[idx];
}

function pctOf(count: number, total: number): string {
  if (total === 0) return "0.0%";
  return ((count / total) * 100).toFixed(1) + "%";
}

function f2(n: number): string {
  return n.toFixed(2);
}

// ── Session parsing ──────────────────────────────────────────────────

function getSessionLabel(utcHour: number): string {
  // LONDON:   07:00–16:00 UTC
  // NEW_YORK: 12:00–21:00 UTC
  // OVERLAP:  12:00–16:00 UTC
  const inLondon   = utcHour >= 7  && utcHour < 16;
  const inNewYork  = utcHour >= 12 && utcHour < 21;
  if (inLondon && inNewYork) return "OVERLAP";
  if (inLondon)  return "LONDON";
  if (inNewYork) return "NEW_YORK";
  return "OFF";
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          PHASE 5-F: TRADE ANATOMY ANALYSIS                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // STEP 1: Fetch trades
  console.log("\n[STEP 1] Fetching backtest_trades...");
  const [longTrades, shortTrades] = await Promise.all([
    fetchTrades(LONG_JOB_ID),
    fetchTrades(SHORT_JOB_ID),
  ]);
  console.log(`  LONG  trades: ${longTrades.length}`);
  console.log(`  SHORT trades: ${shortTrades.length}`);
  const allTradesRaw = [...longTrades, ...shortTrades];
  console.log(`  TOTAL trades: ${allTradesRaw.length}`);

  // STEP 2: Fetch all M5 bars into memory
  console.log("\n[STEP 2] Loading M5 bar data into memory...");
  const m5Bars = await fetchAllM5Bars();
  console.log(`  Total M5 bars: ${m5Bars.length}`);

  // Build sorted timestamp array + map
  const sortedTimestamps: number[] = m5Bars.map((b) => new Date(b.time_utc).getTime());
  const barMap = new Map<number, BarRow>();
  for (let i = 0; i < m5Bars.length; i++) {
    barMap.set(sortedTimestamps[i], m5Bars[i]);
  }

  // Pre-compute ATR14 for all bars
  console.log("  Pre-computing ATR14...");
  const atr14Array = precomputeATR14(m5Bars);
  // Override the calcATR14AtIndex lookup to use pre-computed array
  // We'll pass atr14Array to enrichment directly

  // STEP 3: Enrich trades with MFE/MAE
  console.log("\n[STEP 3] Computing MFE/MAE for all trades...");

  function enrichTradesFull(trades: TradeRow[]): EnrichedTrade[] {
    return trades.map((t) => {
      const entryTs = new Date(t.entry_time).getTime();
      const exitTs  = t.exit_time ? new Date(t.exit_time).getTime() : null;

      // Binary search for start index
      let lo = 0;
      let hi = sortedTimestamps.length - 1;
      let startIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTimestamps[mid] < entryTs) {
          lo = mid + 1;
        } else {
          startIdx = mid;
          hi = mid - 1;
        }
      }
      if (startIdx < 0) startIdx = sortedTimestamps.length - 1;

      // End index = last bar whose timestamp <= exitTs
      let endIdx = startIdx;
      if (exitTs !== null) {
        let lo2 = startIdx;
        let hi2 = sortedTimestamps.length - 1;
        while (lo2 <= hi2) {
          const mid = (lo2 + hi2) >> 1;
          if (sortedTimestamps[mid] <= exitTs) {
            endIdx = mid;
            lo2 = mid + 1;
          } else {
            hi2 = mid - 1;
          }
        }
      }

      const capIdx = Math.min(endIdx, startIdx + MAX_BARS_PER_TRADE - 1);

      // Collect bars
      const bars: BarRow[] = [];
      for (let i = startIdx; i <= capIdx; i++) {
        const b = barMap.get(sortedTimestamps[i]);
        if (b) bars.push(b);
      }

      const { mfe, mae } = calcMfeMae(t.direction, t.entry_price, bars);

      // N-bar returns
      const returnAt = (n: number): number | null => {
        const barIdx = startIdx + n - 1;
        if (barIdx >= sortedTimestamps.length) return null;
        const b = barMap.get(sortedTimestamps[barIdx]);
        if (!b) return null;
        if (t.direction === "BUY")  return (b.close - t.entry_price) / PIP;
        return (t.entry_price - b.close) / PIP;
      };

      // First bar direction
      let firstBarFavorable: boolean | null = null;
      if (bars.length >= 1) {
        const fb = bars[0];
        if (t.direction === "BUY")  firstBarFavorable = fb.close > t.entry_price;
        else                         firstBarFavorable = fb.close < t.entry_price;
      }

      // ATR14 at entry bar (pre-computed)
      const atr14Entry = startIdx < atr14Array.length ? atr14Array[startIdx] : null;

      return {
        ...t,
        mfe,
        mae,
        bars_held: bars.length,
        returns_at_bar: {
          b5:  returnAt(5),
          b10: returnAt(10),
          b20: returnAt(20),
          b50: returnAt(50),
        },
        first_bar_favorable: firstBarFavorable,
        atr14_entry: atr14Entry,
      };
    });
  }

  const allTrades = enrichTradesFull(allTradesRaw);
  const longEnriched  = allTrades.filter((t) => t.job_id === LONG_JOB_ID);
  const shortEnriched = allTrades.filter((t) => t.job_id === SHORT_JOB_ID);

  console.log(`  Enriched: ${allTrades.length} trades`);

  // ── ANALYSIS ────────────────────────────────────────────────────────

  const wins   = allTrades.filter((t) => t.result === "WIN");
  const losses = allTrades.filter((t) => t.result === "LOSS");
  const total  = allTrades.length;

  const allMFE  = allTrades.map((t) => t.mfe);
  const allMAE  = allTrades.map((t) => t.mae);
  const winMFE  = wins.map((t) => t.mfe);
  const winMAE  = wins.map((t) => t.mae);
  const lossMFE = losses.map((t) => t.mfe);
  const lossMAE = losses.map((t) => t.mae);

  // ── 3.1 MFE/MAE Basic Stats ─────────────────────────────────────────

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              PHASE 5-F FINAL REPORT: TRADE ANATOMY           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  console.log("\n─── 1. Data Source ─────────────────────────────────────────────");
  console.log(`Strategy:    Phase 5-C EURUSD Multi-TF EMA21 Pullback v2 (LONG + SHORT)`);
  console.log(`LONG  job:   ${LONG_JOB_ID}`);
  console.log(`SHORT job:   ${SHORT_JOB_ID}`);
  console.log(`M5 bars:     ${m5Bars.length}`);

  console.log("\n─── 2. Total Trades Analyzed ───────────────────────────────────");
  console.log(`LONG:        ${longEnriched.length}`);
  console.log(`SHORT:       ${shortEnriched.length}`);
  console.log(`TOTAL:       ${total}`);
  console.log(`WINS:        ${wins.length} (${pctOf(wins.length, total)})`);
  console.log(`LOSSES:      ${losses.length} (${pctOf(losses.length, total)})`);

  console.log("\n─── 3. MFE/MAE Basic Statistics (pips) ─────────────────────────");
  console.log(`\n[ALL TRADES: N=${total}]`);
  console.log(`  MFE median:  ${f2(median(allMFE))} pips`);
  console.log(`  MFE mean:    ${f2(mean(allMFE))} pips`);
  console.log(`  MFE p25:     ${f2(percentile(allMFE, 25))} pips`);
  console.log(`  MFE p75:     ${f2(percentile(allMFE, 75))} pips`);
  console.log(`  MFE p90:     ${f2(percentile(allMFE, 90))} pips`);
  console.log(`  MAE median:  ${f2(median(allMAE))} pips`);
  console.log(`  MAE mean:    ${f2(mean(allMAE))} pips`);
  console.log(`  MAE p25:     ${f2(percentile(allMAE, 25))} pips  (25th = less negative)`);
  console.log(`  MAE p75:     ${f2(percentile(allMAE, 75))} pips  (75th = more negative)`);
  console.log(`  MAE p90:     ${f2(percentile(allMAE, 90))} pips  (90th = most negative)`);

  console.log(`\n[WINNING TRADES: N=${wins.length}]`);
  console.log(`  MFE median:  ${f2(median(winMFE))} pips`);
  console.log(`  MAE median:  ${f2(median(winMAE))} pips`);

  console.log(`\n[LOSING TRADES: N=${losses.length}]`);
  console.log(`  MFE median:  ${f2(median(lossMFE))} pips`);
  console.log(`  MAE median:  ${f2(median(lossMAE))} pips`);

  // ── 3.2 Pip Milestone Rates ─────────────────────────────────────────

  console.log("\n─── 4. Pip Milestone Achievement Rates ──────────────────────────");
  const mfeMilestones = [5, 10, 15, 20];
  const maeMilestones = [5, 10, 15, 20];

  for (const m of mfeMilestones) {
    const cnt = allTrades.filter((t) => t.mfe >= m).length;
    console.log(`  MFE >= +${m} pips:  ${pctOf(cnt, total)} (${cnt}/${total})`);
  }
  for (const m of maeMilestones) {
    const cnt = allTrades.filter((t) => t.mae <= -m).length;
    console.log(`  MAE <= -${m} pips:  ${pctOf(cnt, total)} (${cnt}/${total})`);
  }

  // ── 3.3 First Bar Direction ─────────────────────────────────────────

  console.log("\n─── 5. First Bar Direction (Favorable = moved toward profit) ───");
  const fbFav    = allTrades.filter((t) => t.first_bar_favorable === true).length;
  const fbUnfav  = allTrades.filter((t) => t.first_bar_favorable === false).length;
  const fbTotal  = fbFav + fbUnfav;
  console.log(`  ALL   favorable: ${pctOf(fbFav, fbTotal)} (${fbFav}/${fbTotal})`);

  const longFav  = longEnriched.filter((t) => t.first_bar_favorable === true).length;
  const longFbT  = longEnriched.filter((t) => t.first_bar_favorable !== null).length;
  const shortFav = shortEnriched.filter((t) => t.first_bar_favorable === true).length;
  const shortFbT = shortEnriched.filter((t) => t.first_bar_favorable !== null).length;
  console.log(`  LONG  favorable: ${pctOf(longFav, longFbT)}`);
  console.log(`  SHORT favorable: ${pctOf(shortFav, shortFbT)}`);

  // ── 3.4 LONG vs SHORT ───────────────────────────────────────────────

  console.log("\n─── 6. LONG vs SHORT Detailed Comparison ───────────────────────");
  const longWins   = longEnriched.filter((t) => t.result === "WIN");
  const shortWins  = shortEnriched.filter((t) => t.result === "WIN");
  const longWR     = longEnriched.length > 0 ? (longWins.length / longEnriched.length) * 100 : 0;
  const shortWR    = shortEnriched.length > 0 ? (shortWins.length / shortEnriched.length) * 100 : 0;
  const longMFE10  = longEnriched.filter((t) => t.mfe >= 10).length;
  const shortMFE10 = shortEnriched.filter((t) => t.mfe >= 10).length;
  const longMAE10  = longEnriched.filter((t) => t.mae <= -10).length;
  const shortMAE10 = shortEnriched.filter((t) => t.mae <= -10).length;
  const longFB     = longEnriched.filter((t) => t.first_bar_favorable === true).length;
  const shortFB    = shortEnriched.filter((t) => t.first_bar_favorable === true).length;
  const longFBT    = longEnriched.filter((t) => t.first_bar_favorable !== null).length;
  const shortFBT   = shortEnriched.filter((t) => t.first_bar_favorable !== null).length;

  const longAvgDurBars  = mean(longEnriched.map((t) => t.bars_held));
  const shortAvgDurBars = mean(shortEnriched.map((t) => t.bars_held));

  // Avg pips to TP (trades that hit TP)
  const longTP  = longEnriched.filter((t) => t.exit_reason === "TP");
  const shortTP = shortEnriched.filter((t) => t.exit_reason === "TP");
  const longAvgTPpips  = mean(longTP.map((t) => t.pips ?? 0));
  const shortAvgTPpips = mean(shortTP.map((t) => t.pips ?? 0));

  const pad = (s: string) => s.padEnd(22);
  const col = (s: string) => String(s).padEnd(15);

  console.log(`${pad("Metric")} ${col("LONG")} SHORT`);
  console.log("─".repeat(55));
  console.log(`${pad("Trades")} ${col(String(longEnriched.length))} ${shortEnriched.length}`);
  console.log(`${pad("WR")} ${col(longWR.toFixed(1) + "%")} ${shortWR.toFixed(1)}%`);
  console.log(`${pad("MFE median")} ${col(f2(median(longEnriched.map((t) => t.mfe))) + " pips")} ${f2(median(shortEnriched.map((t) => t.mfe)))} pips`);
  console.log(`${pad("MAE median")} ${col(f2(median(longEnriched.map((t) => t.mae))) + " pips")} ${f2(median(shortEnriched.map((t) => t.mae)))} pips`);
  console.log(`${pad("MFE>=10 pips %")} ${col(pctOf(longMFE10, longEnriched.length))} ${pctOf(shortMFE10, shortEnriched.length)}`);
  console.log(`${pad("MAE<=-10 pips %")} ${col(pctOf(longMAE10, longEnriched.length))} ${pctOf(shortMAE10, shortEnriched.length)}`);
  console.log(`${pad("First bar fav %")} ${col(pctOf(longFB, longFBT))} ${pctOf(shortFB, shortFBT)}`);
  console.log(`${pad("Avg pips to TP")} ${col(f2(longAvgTPpips) + " pips")} ${f2(shortAvgTPpips)} pips`);
  console.log(`${pad("Avg bars held")} ${col(f2(longAvgDurBars) + " bars")} ${f2(shortAvgDurBars)} bars`);

  // ── 3.5 Session Analysis ────────────────────────────────────────────

  console.log("\n─── 7. Session Analysis ─────────────────────────────────────────");
  const sessionNames = ["LONDON", "NEW_YORK", "OVERLAP", "OFF"];

  function getSessionFromTrade(t: EnrichedTrade): string {
    if (t.session) return t.session;
    const h = new Date(t.entry_time).getUTCHours();
    return getSessionLabel(h);
  }

  for (const sess of sessionNames) {
    const st = allTrades.filter((t) => getSessionFromTrade(t) === sess);
    if (st.length === 0) continue;
    const stWins = st.filter((t) => t.result === "WIN");
    const stWR   = st.length > 0 ? (stWins.length / st.length) * 100 : 0;
    const stMFE  = median(st.map((t) => t.mfe));
    const stMAE  = median(st.map((t) => t.mae));
    const stMFE10 = st.filter((t) => t.mfe >= 10).length;
    console.log(`  ${sess.padEnd(12)}: N=${st.length.toString().padEnd(4)} WR=${stWR.toFixed(1).padEnd(5)}% MFE_med=${f2(stMFE).padEnd(7)} MAE_med=${f2(stMAE).padEnd(8)} MFE>=10=${pctOf(stMFE10, st.length)}`);
  }

  // ── 3.6 Day-of-Week Analysis ────────────────────────────────────────

  console.log("\n─── 8. Day-of-Week Analysis (UTC) ──────────────────────────────");
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (let d = 0; d <= 6; d++) {
    const dt = allTrades.filter((t) => new Date(t.entry_time).getUTCDay() === d);
    if (dt.length === 0) continue;
    const dtWins = dt.filter((t) => t.result === "WIN");
    const dtWR   = dt.length > 0 ? (dtWins.length / dt.length) * 100 : 0;
    const dtPips = dt.reduce((s, t) => s + (t.pips ?? 0), 0);
    const dtMFE  = median(dt.map((t) => t.mfe));
    console.log(`  ${dowNames[d]}: N=${dt.length.toString().padEnd(4)} WR=${dtWR.toFixed(1).padEnd(5)}% MFE_med=${f2(dtMFE).padEnd(7)} Total pips=${dtPips.toFixed(1)}`);
  }

  // ── 3.7 ATR Volatility Groups ───────────────────────────────────────

  console.log("\n─── 9. Volatility Analysis (ATR14) ─────────────────────────────");
  const tradesWithATR = allTrades.filter((t) => t.atr14_entry !== null);
  const atrVals = tradesWithATR.map((t) => t.atr14_entry as number).sort((a, b) => a - b);

  if (atrVals.length >= 3) {
    const atrP33 = atrVals[Math.floor(atrVals.length / 3)];
    const atrP66 = atrVals[Math.floor((atrVals.length * 2) / 3)];

    const groups = [
      { label: "Low Vol  (ATR < p33)", trades: tradesWithATR.filter((t) => (t.atr14_entry as number) < atrP33) },
      { label: "Mid Vol  (p33-p66)",   trades: tradesWithATR.filter((t) => (t.atr14_entry as number) >= atrP33 && (t.atr14_entry as number) < atrP66) },
      { label: "High Vol (ATR >= p66)", trades: tradesWithATR.filter((t) => (t.atr14_entry as number) >= atrP66) },
    ];

    console.log(`  ATR p33 = ${(atrP33 / PIP).toFixed(1)} pips, ATR p66 = ${(atrP66 / PIP).toFixed(1)} pips`);
    for (const g of groups) {
      const gWins = g.trades.filter((t) => t.result === "WIN");
      const gWR   = g.trades.length > 0 ? (gWins.length / g.trades.length) * 100 : 0;
      const gMFE  = median(g.trades.map((t) => t.mfe));
      const gMAE  = median(g.trades.map((t) => t.mae));
      console.log(`  ${g.label.padEnd(25)}: N=${g.trades.length.toString().padEnd(4)} WR=${gWR.toFixed(1).padEnd(5)}% MFE_med=${f2(gMFE).padEnd(7)} MAE_med=${f2(gMAE)}`);
    }
  } else {
    console.log("  Insufficient ATR data.");
  }

  // ── 3.8 N-Bar Return Distribution ──────────────────────────────────

  console.log("\n─── 10. N-Bar Return Distribution ───────────────────────────────");
  const nBarDefs: Array<{ label: string; key: keyof EnrichedTrade["returns_at_bar"] }> = [
    { label: "Bar 5",  key: "b5"  },
    { label: "Bar 10", key: "b10" },
    { label: "Bar 20", key: "b20" },
    { label: "Bar 50", key: "b50" },
  ];

  for (const nd of nBarDefs) {
    const vals = allTrades
      .map((t) => t.returns_at_bar[nd.key])
      .filter((v): v is number => v !== null);
    if (vals.length === 0) continue;
    const posCount = vals.filter((v) => v > 0).length;
    console.log(`  ${nd.label.padEnd(8)}: N=${vals.length.toString().padEnd(4)} median=${f2(median(vals)).padEnd(8)} positive=${pctOf(posCount, vals.length)}`);
  }

  // ── 3.9 SL/TP Appropriateness ───────────────────────────────────────

  console.log("\n─── 11. SL/TP Appropriateness Analysis ─────────────────────────");
  // For each trade with SL and TP set:
  //   slDist = abs(entry_price - sl)  (in pips)
  //   tpDist = abs(tp - entry_price)  (in pips)
  //   MFE reached TP distance (would have hit TP based on MFE alone)
  //   MFE < slDist/2 (barely moved)

  const tradesWithSLTP = allTrades.filter((t) => t.sl !== null && t.tp !== null);
  console.log(`  Trades with SL+TP:     ${tradesWithSLTP.length}`);

  const mfeReachedTP = tradesWithSLTP.filter((t) => {
    const tpDist = Math.abs((t.tp as number) - t.entry_price) / PIP;
    return t.mfe >= tpDist;
  });
  const mfeNeverHalfSL = tradesWithSLTP.filter((t) => {
    const slDist = Math.abs(t.entry_price - (t.sl as number)) / PIP;
    return t.mfe < slDist / 2;
  });

  console.log(`  MFE reached TP dist:   ${pctOf(mfeReachedTP.length, tradesWithSLTP.length)} (${mfeReachedTP.length}/${tradesWithSLTP.length})`);
  console.log(`  MFE < SL/2 (barely moved): ${pctOf(mfeNeverHalfSL.length, tradesWithSLTP.length)} (${mfeNeverHalfSL.length}/${tradesWithSLTP.length})`);

  // Trades where MFE reached TP but still lost (i.e. exit_reason=SL)
  const reachedTPButLost = mfeReachedTP.filter((t) => t.exit_reason === "SL");
  console.log(`  Reached TP distance but hit SL: ${pctOf(reachedTPButLost.length, tradesWithSLTP.length)}`);

  // ── 3.10 Losing Trade Anatomy ───────────────────────────────────────

  console.log("\n─── 12. Losing Trade Anatomy ────────────────────────────────────");
  const slTrades = allTrades.filter((t) => t.exit_reason === "SL");
  console.log(`  Total SL hits: ${slTrades.length}`);

  const almostWon = slTrades.filter((t) => t.mfe >= 5);
  const neverMoved = slTrades.filter((t) => t.mfe < 2);

  console.log(`  "Almost won" (MFE >= +5 pips before SL): ${pctOf(almostWon.length, slTrades.length)} (${almostWon.length}/${slTrades.length})`);
  console.log(`  "Never moved" (MFE < +2 pips):            ${pctOf(neverMoved.length, slTrades.length)} (${neverMoved.length}/${slTrades.length})`);

  // SL within first 3 bars
  const slWithin3Bars = slTrades.filter((t) => t.bars_held <= 3);
  console.log(`  SL within first 3 bars:                   ${pctOf(slWithin3Bars.length, slTrades.length)} (${slWithin3Bars.length}/${slTrades.length})`);

  // Additional: "Gave back" — MFE >= 10 but still SL
  const gaveBack = slTrades.filter((t) => t.mfe >= 10);
  console.log(`  "Gave back" (MFE >= +10 but SL):          ${pctOf(gaveBack.length, slTrades.length)} (${gaveBack.length}/${slTrades.length})`);

  // ── Key Structural Findings ─────────────────────────────────────────

  const mfeMed   = median(allMFE);
  const maeMed   = median(allMAE);
  const mfe10Pct = (allTrades.filter((t) => t.mfe >= 10).length / total) * 100;
  const mae10Pct = (allTrades.filter((t) => t.mae <= -10).length / total) * 100;
  const fbFavPct = fbTotal > 0 ? (fbFav / fbTotal) * 100 : 0;

  console.log("\n─── 13. Key Structural Findings ─────────────────────────────────");
  console.log(`  MFE median (all):          ${f2(mfeMed)} pips`);
  console.log(`  MAE median (all):          ${f2(maeMed)} pips`);
  console.log(`  MFE >= +10 pips rate:      ${mfe10Pct.toFixed(1)}%`);
  console.log(`  MAE <= -10 pips rate:      ${mae10Pct.toFixed(1)}%`);
  console.log(`  First bar favorable:       ${fbFavPct.toFixed(1)}%`);
  console.log(`  Overall WR:                ${pctOf(wins.length, total)}`);

  // ── Hypothesis Verdict ──────────────────────────────────────────────

  console.log("\n─── 14. Hypothesis Verdict ──────────────────────────────────────");

  let verdict: string;
  let verdictDetail: string;

  if (mfeMed >= 10 && maeMed > -10) {
    verdict = "PARTIALLY SUPPORTED";
    verdictDetail = "MFE median >= +10 pips AND MAE median > -10 pips suggests edge exists but SL/TP design may be suboptimal.";
  } else if (mfe10Pct >= 40) {
    verdict = "PARTIALLY SUPPORTED";
    verdictDetail = `${mfe10Pct.toFixed(1)}% of trades reach +10 pips MFE — entry timing has some edge. SL too tight or TP too far.`;
  } else if (mfeMed < 5 && maeMed < -8) {
    verdict = "REJECTED";
    verdictDetail = "MFE median < +5 pips and MAE median < -8 pips. Entries reverse immediately — fundamental hypothesis weakness.";
  } else {
    verdict = "WEAK";
    verdictDetail = "Mixed signals. MFE and MAE do not clearly support or refute the EMA21 pullback entry hypothesis.";
  }

  console.log(`  VERDICT: ${verdict}`);
  console.log(`  Detail:  ${verdictDetail}`);

  // Day-of-week best
  let bestDowWR = -1;
  let bestDowLabel = "";
  for (let d = 1; d <= 5; d++) {
    const dt = allTrades.filter((t) => new Date(t.entry_time).getUTCDay() === d);
    if (dt.length < 10) continue;
    const dtWins = dt.filter((t) => t.result === "WIN");
    const dtWR   = (dtWins.length / dt.length) * 100;
    if (dtWR > bestDowWR) { bestDowWR = dtWR; bestDowLabel = dowNames[d]; }
  }

  // Session with best WR
  let bestSessWR = -1;
  let bestSessLabel = "";
  for (const sess of sessionNames) {
    const st = allTrades.filter((t) => getSessionFromTrade(t) === sess);
    if (st.length < 10) continue;
    const stWR = (st.filter((t) => t.result === "WIN").length / st.length) * 100;
    if (stWR > bestSessWR) { bestSessWR = stWR; bestSessLabel = sess; }
  }

  // ── Phase 5-G Recommendation ────────────────────────────────────────

  console.log("\n─── 15. Phase 5-G Recommendation ───────────────────────────────");

  let rec5G: string;
  if (mfe10Pct >= 40 && mae10Pct > mfe10Pct) {
    rec5G = "Phase 5-G: SL/TP Optimization — widen SL (ATR×2.0) and/or narrow TP (RR=1.5) to capture more trades that show MFE >= 10 pips before reversing.";
  } else if (mfeMed < 5) {
    rec5G = "Phase 5-G: Hypothesis Revision — EMA21 pullback alone lacks directional edge. Add momentum confirmation (e.g. RSI direction filter, MACD alignment) BEFORE considering SL/TP changes.";
  } else if (bestSessLabel && bestSessWR - (wins.length / total * 100) > 5) {
    rec5G = `Phase 5-G: Session/Time Filter — ${bestSessLabel} shows highest WR (${bestSessWR.toFixed(1)}%). Restrict entries to ${bestSessLabel} only and re-backtest.`;
  } else {
    rec5G = "Phase 5-G: Mixed signal — recommend testing both (A) wider SL and (B) session filter independently using Phase 5-D/E approach, compare Profit Factor improvement.";
  }

  console.log(`  ${rec5G}`);

  // ── Summary ─────────────────────────────────────────────────────────

  console.log("\n─── 16. Changed Files ───────────────────────────────────────────");
  console.log("  None (analysis only — no engine changes)");

  console.log("\n─── 17. New Files ───────────────────────────────────────────────");
  console.log("  scripts/phase5f_anatomy.ts");

  console.log("\n─── 18. TypeScript ──────────────────────────────────────────────");
  console.log("  (Run: npx tsc --noEmit)");

  console.log("\n─── 19. Regression ──────────────────────────────────────────────");
  console.log("  (Run: npx tsx src/infrastructure/backtest/__tests__/phase5e.test.ts)");
  console.log("  (Run: npx tsx src/infrastructure/backtest/__tests__/evaluator.test.ts)");

  // ── Final Summary Block ──────────────────────────────────────────────

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                   PHASE 5-F: COMPLETE                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`MFE MEDIAN (ALL):        ${f2(mfeMed)} pips`);
  console.log(`MAE MEDIAN (ALL):        ${f2(maeMed)} pips`);
  console.log(`MFE >= +10 PIPS RATE:    ${mfe10Pct.toFixed(1)}%`);
  console.log(`MAE <= -10 PIPS RATE:    ${mae10Pct.toFixed(1)}%`);
  console.log(`FIRST BAR FAVORABLE:     ${fbFavPct.toFixed(1)}%`);
  console.log(`OVERALL WIN RATE:        ${pctOf(wins.length, total)}`);
  console.log(`ENTRY HYPOTHESIS:        ${verdict}`);
  console.log(`CONCLUSION: ${verdictDetail}`);
  console.log(`NEXT PHASE: ${rec5G.replace("Phase 5-G: ", "")}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

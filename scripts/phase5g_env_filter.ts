/**
 * Phase 5-G: Environment Filter Verification
 *
 * Phase 5-C の 2,290 trades を ATR/Session/曜日でフィルタリングして統計を比較する。
 * EMA21 プルバック仮説の「最後の救済検証」。
 *
 * Usage: npx tsx --env-file=.env.local scripts/phase5g_env_filter.ts
 */

// Make this file a proper ES module to avoid global-scope conflicts with other scripts
export {};

// ── Config ──────────────────────────────────────────────────────────

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const LONG_JOB_ID  = "06ad086c-5473-4397-ba29-66437d9886b7";
const SHORT_JOB_ID = "18cef39d-eeed-4cc4-b5d9-dae1a4611e21";

const PIP            = 0.0001;   // EURUSD pip size
const MAX_BARS_PER_TRADE = 50;
const PAGE_SIZE      = 1000;
const ATR_HIGH_THRESHOLD_PIPS = 3.7;  // Phase 5-F p66 value
const ATR_HIGH_THRESHOLD = ATR_HIGH_THRESHOLD_PIPS * PIP;

// IS/OOS split ratio
const IS_RATIO = 0.6;

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
  mfe:         number;   // pips, >= 0
  mae:         number;   // pips, <= 0
  bars_held:   number;
  atr14_entry: number | null;  // raw (not in pips)
  session_calc: string;        // computed from entry_time UTC
  dow:          number;        // 0=Mon .. 4=Fri (UTC)
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

// ── ATR14 pre-computation (Wilder smoothing) ─────────────────────────

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

// ── MFE / MAE ────────────────────────────────────────────────────────

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
      const unfavorable = (b.low   - entryPrice) / PIP;
      if (favorable   > mfe) mfe = favorable;
      if (unfavorable < mae) mae = unfavorable;
    } else {
      const favorable   = (entryPrice - b.low)  / PIP;
      const unfavorable = (entryPrice - b.high) / PIP;
      if (favorable   > mfe) mfe = favorable;
      if (unfavorable < mae) mae = unfavorable;
    }
  }

  return { mfe, mae };
}

// ── Session from UTC hour ─────────────────────────────────────────────

function getSessionLabel(utcHour: number): string {
  const inLondon  = utcHour >= 7  && utcHour < 16;
  const inNewYork = utcHour >= 12 && utcHour < 21;
  if (inLondon && inNewYork) return "OVERLAP";
  if (inLondon)  return "LONDON";
  if (inNewYork) return "NEW_YORK";
  return "OFF";
}

// UTC day-of-week where 0=Sunday, ..., 6=Saturday
// We want Mon=0 ... Fri=4 for simpler logic
function utcDowMon0(date: Date): number {
  const d = date.getUTCDay(); // 0=Sun
  return (d + 6) % 7;         // Mon=0 ... Sun=6
}

// ── Enrich trades ────────────────────────────────────────────────────

function enrichTrades(
  trades: TradeRow[],
  barMap: Map<number, BarRow>,
  sortedTimestamps: number[],
  atr14Array: (number | null)[],
): EnrichedTrade[] {
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

    // ATR14 at entry bar
    const atr14Entry = startIdx < atr14Array.length ? atr14Array[startIdx] : null;

    // Session and day of week from entry_time
    const entryDate   = new Date(t.entry_time);
    const utcHour     = entryDate.getUTCHours();
    const sessionCalc = getSessionLabel(utcHour);
    const dow         = utcDowMon0(entryDate); // 0=Mon ... 6=Sun

    return {
      ...t,
      mfe,
      mae,
      bars_held: bars.length,
      atr14_entry: atr14Entry,
      session_calc: sessionCalc,
      dow,
    };
  });
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

function f2(n: number): string { return n.toFixed(2); }
function f3(n: number): string { return n.toFixed(3); }

function pf(trades: EnrichedTrade[]): number {
  const winPips  = trades.filter((t) => t.result === "WIN").reduce((s, t) => s + (t.pips ?? 0), 0);
  const lossPips = Math.abs(trades.filter((t) => t.result === "LOSS").reduce((s, t) => s + (t.pips ?? 0), 0));
  if (lossPips === 0) return winPips > 0 ? 999 : 1;
  return winPips / lossPips;
}

function wr(trades: EnrichedTrade[]): number {
  if (trades.length === 0) return 0;
  return (trades.filter((t) => t.result === "WIN").length / trades.length) * 100;
}

function totalPips(trades: EnrichedTrade[]): number {
  return trades.reduce((s, t) => s + (t.pips ?? 0), 0);
}

function pipsPerTrade(trades: EnrichedTrade[]): number {
  if (trades.length === 0) return 0;
  return totalPips(trades) / trades.length;
}

function maxDDEst(trades: EnrichedTrade[]): number {
  // Cumulative pips curve, find max drawdown
  let peak = 0;
  let cum   = 0;
  let dd    = 0;
  for (const t of trades) {
    cum += t.pips ?? 0;
    if (cum > peak) peak = cum;
    const drawdown = peak - cum;
    if (drawdown > dd) dd = drawdown;
  }
  return dd;
}

interface PatternStats {
  label:       string;
  trades:      EnrichedTrade[];
  longTrades:  EnrichedTrade[];
  shortTrades: EnrichedTrade[];
}

function printPatternStats(ps: PatternStats): void {
  const { label, trades, longTrades, shortTrades } = ps;
  const n     = trades.length;
  const nL    = longTrades.length;
  const nS    = shortTrades.length;
  const lowSample = n < 100 ? " [LOW SAMPLE]" : "";

  const pfAll   = pf(trades);
  const pfL     = pf(longTrades);
  const pfS     = pf(shortTrades);
  const wrAll   = wr(trades);
  const wrL     = wr(longTrades);
  const wrS     = wr(shortTrades);
  const totPips = totalPips(trades);
  const ppt     = pipsPerTrade(trades);
  const mfeMed  = median(trades.map((t) => t.mfe));
  const maeMed  = median(trades.map((t) => t.mae));
  const mfe10   = trades.length > 0 ? (trades.filter((t) => t.mfe >= 10).length / n * 100) : 0;
  const ddEst   = maxDDEst(trades);

  console.log(`\n┌─ ${label}${lowSample}`);
  console.log(`│  Trades:       ${n} (LONG: ${nL}, SHORT: ${nS})`);
  console.log(`│  WR:           ${f2(wrAll)}%  (LONG: ${f2(wrL)}%, SHORT: ${f2(wrS)}%)`);
  console.log(`│  Total Pips:   ${f2(totPips)}`);
  console.log(`│  PF:           ${f3(pfAll)}  (LONG: ${f3(pfL)}, SHORT: ${f3(pfS)})`);
  console.log(`│  Pips/Trade:   ${f2(ppt)}`);
  console.log(`│  MFE median:   ${f2(mfeMed)} pips`);
  console.log(`│  MAE median:   ${f2(maeMed)} pips`);
  console.log(`│  MFE>=10 %:    ${f2(mfe10)}%`);
  console.log(`│  Max DD est:   ${f2(ddEst)} pips`);
  console.log(`└${"─".repeat(60)}`);
}

interface OOSResult {
  isTrades:   EnrichedTrade[];
  oosTrades:  EnrichedTrade[];
  isSplitDate: string;
}

function splitISOS(trades: EnrichedTrade[]): OOSResult {
  // Sort by entry_time
  const sorted = [...trades].sort((a, b) =>
    new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime(),
  );
  const splitIdx = Math.floor(sorted.length * IS_RATIO);
  const isTrades  = sorted.slice(0, splitIdx);
  const oosTrades = sorted.slice(splitIdx);
  const isSplitDate = oosTrades.length > 0 ? oosTrades[0].entry_time : "N/A";
  return { isTrades, oosTrades, isSplitDate };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       PHASE 5-G: ENVIRONMENT FILTER VERIFICATION             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // STEP 1: Fetch trades
  console.log("\n[STEP 1] Fetching backtest_trades from Phase 5-C jobs...");
  const [longTrades, shortTrades] = await Promise.all([
    fetchTrades(LONG_JOB_ID),
    fetchTrades(SHORT_JOB_ID),
  ]);
  console.log(`  LONG  trades: ${longTrades.length}`);
  console.log(`  SHORT trades: ${shortTrades.length}`);
  const allTradesRaw = [...longTrades, ...shortTrades];
  console.log(`  TOTAL trades: ${allTradesRaw.length}`);

  // STEP 2: Fetch all M5 bars
  console.log("\n[STEP 2] Loading M5 bar data into memory...");
  const m5Bars = await fetchAllM5Bars();
  console.log(`  Total M5 bars: ${m5Bars.length}`);

  const sortedTimestamps: number[] = m5Bars.map((b) => new Date(b.time_utc).getTime());
  const barMap = new Map<number, BarRow>();
  for (let i = 0; i < m5Bars.length; i++) {
    barMap.set(sortedTimestamps[i], m5Bars[i]);
  }

  // Pre-compute ATR14 for all bars
  console.log("  Pre-computing ATR14 for all bars...");
  const atr14Array = precomputeATR14(m5Bars);

  // STEP 3: Enrich trades
  console.log("\n[STEP 3] Enriching trades (MFE/MAE/ATR/Session/DoW)...");
  const allTrades = enrichTrades(allTradesRaw, barMap, sortedTimestamps, atr14Array);
  console.log(`  Enriched: ${allTrades.length} trades`);

  // ── ATR threshold report
  const tradesWithATR = allTrades.filter((t) => t.atr14_entry !== null);
  const atrPips = tradesWithATR.map((t) => (t.atr14_entry as number) / PIP).sort((a, b) => a - b);
  const p33 = atrPips[Math.floor(atrPips.length / 3)];
  const p66 = atrPips[Math.floor((atrPips.length * 2) / 3)];
  console.log(`  ATR p33: ${f2(p33)} pips, ATR p66: ${f2(p66)} pips (threshold used: ${ATR_HIGH_THRESHOLD_PIPS} pips)`);

  // ── STEP 4: Build 7 filter patterns ──────────────────────────────────

  console.log("\n[STEP 4] Computing 7 filter patterns...");

  // Helper predicates
  const isHighATR = (t: EnrichedTrade) =>
    t.atr14_entry !== null && t.atr14_entry > ATR_HIGH_THRESHOLD;

  const isNY = (t: EnrichedTrade) =>
    t.session_calc === "NEW_YORK" || t.session_calc === "OVERLAP";

  const isOverlap = (t: EnrichedTrade) => t.session_calc === "OVERLAP";

  const isTueOrThu = (t: EnrichedTrade) => t.dow === 1 || t.dow === 3; // Mon=0

  const isFriday = (t: EnrichedTrade) => t.dow === 4;

  // Pattern definitions
  const patterns: PatternStats[] = [
    {
      label:  "Pattern 0: Baseline (5-C 全体)",
      trades: allTrades,
      longTrades:  allTrades.filter((t) => t.job_id === LONG_JOB_ID),
      shortTrades: allTrades.filter((t) => t.job_id === SHORT_JOB_ID),
    },
    {
      label:  "Pattern 1: High ATR のみ (ATR > 3.7 pips)",
      trades: allTrades.filter(isHighATR),
      longTrades:  allTrades.filter((t) => t.job_id === LONG_JOB_ID && isHighATR(t)),
      shortTrades: allTrades.filter((t) => t.job_id === SHORT_JOB_ID && isHighATR(t)),
    },
    {
      label:  "Pattern 2: NY セッションのみ (12:00-21:00 UTC)",
      trades: allTrades.filter(isNY),
      longTrades:  allTrades.filter((t) => t.job_id === LONG_JOB_ID && isNY(t)),
      shortTrades: allTrades.filter((t) => t.job_id === SHORT_JOB_ID && isNY(t)),
    },
    {
      label:  "Pattern 3: High ATR × NY",
      trades: allTrades.filter((t) => isHighATR(t) && isNY(t)),
      longTrades:  allTrades.filter((t) => t.job_id === LONG_JOB_ID && isHighATR(t) && isNY(t)),
      shortTrades: allTrades.filter((t) => t.job_id === SHORT_JOB_ID && isHighATR(t) && isNY(t)),
    },
    {
      label:  "Pattern 4: High ATR × NY × Tue/Thu",
      trades: allTrades.filter((t) => isHighATR(t) && isNY(t) && isTueOrThu(t)),
      longTrades:  allTrades.filter((t) => t.job_id === LONG_JOB_ID && isHighATR(t) && isNY(t) && isTueOrThu(t)),
      shortTrades: allTrades.filter((t) => t.job_id === SHORT_JOB_ID && isHighATR(t) && isNY(t) && isTueOrThu(t)),
    },
    {
      label:  "Pattern 5: High ATR × NY + 金曜除外",
      trades: allTrades.filter((t) => isHighATR(t) && isNY(t) && !isFriday(t)),
      longTrades:  allTrades.filter((t) => t.job_id === LONG_JOB_ID && isHighATR(t) && isNY(t) && !isFriday(t)),
      shortTrades: allTrades.filter((t) => t.job_id === SHORT_JOB_ID && isHighATR(t) && isNY(t) && !isFriday(t)),
    },
    {
      label:  "Pattern 6: High ATR × NY + OVERLAP除外 (16:00-21:00 UTC のみ)",
      trades: allTrades.filter((t) => isHighATR(t) && isNY(t) && !isOverlap(t)),
      longTrades:  allTrades.filter((t) => t.job_id === LONG_JOB_ID && isHighATR(t) && isNY(t) && !isOverlap(t)),
      shortTrades: allTrades.filter((t) => t.job_id === SHORT_JOB_ID && isHighATR(t) && isNY(t) && !isOverlap(t)),
    },
  ];

  // ── STEP 5: Print pattern comparison ─────────────────────────────────

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║         PHASE 5-G FINAL REPORT: ENV FILTER VERIFICATION      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  console.log("\n─── 1. Data Source & Method ─────────────────────────────────────");
  console.log(`Strategy:     Phase 5-C EURUSD Multi-TF EMA21 Pullback v2`);
  console.log(`LONG job:     ${LONG_JOB_ID}`);
  console.log(`SHORT job:    ${SHORT_JOB_ID}`);
  console.log(`Total trades: ${allTrades.length}`);
  console.log(`M5 bars:      ${m5Bars.length}`);

  console.log("\n─── 2. ATR Threshold Definition ─────────────────────────────────");
  console.log(`ATR(14) p33: ${f2(p33)} pips`);
  console.log(`ATR(14) p66: ${f2(p66)} pips`);
  console.log(`High ATR threshold (p66 from Phase 5-F): ${ATR_HIGH_THRESHOLD_PIPS} pips`);
  console.log(`Trades with ATR data: ${tradesWithATR.length}`);

  console.log("\n─── 3. Session Definition ───────────────────────────────────────");
  console.log(`LONDON:   07:00-16:00 UTC`);
  console.log(`NEW_YORK: 12:00-21:00 UTC`);
  console.log(`OVERLAP:  12:00-16:00 UTC (London × NY 重複)`);
  console.log(`OFF:      その他`);
  console.log(`NY判定 (Pattern 2+): NEW_YORK + OVERLAP (12:00-21:00 UTC 全体)`);

  // Session distribution
  console.log("\n  Session distribution:");
  for (const sess of ["LONDON", "OVERLAP", "NEW_YORK", "OFF"]) {
    const cnt = allTrades.filter((t) => t.session_calc === sess).length;
    console.log(`    ${sess.padEnd(10)}: ${cnt} trades`);
  }

  // DoW distribution
  const dowNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  console.log("\n  Day-of-week distribution (UTC):");
  for (let d = 0; d <= 6; d++) {
    const cnt = allTrades.filter((t) => t.dow === d).length;
    if (cnt > 0) console.log(`    ${dowNames[d]}: ${cnt} trades`);
  }

  console.log("\n─── 4. Pattern Comparison Table (7 patterns) ────────────────────");

  for (const ps of patterns) {
    printPatternStats(ps);
  }

  // ── STEP 6: Summary comparison table ─────────────────────────────────

  console.log("\n─── 5. Best Pattern Identified ──────────────────────────────────");

  // Find best by PF (among patterns with >= 50 trades)
  let bestPattern: PatternStats | null = null;
  let bestPF = -1;

  for (const ps of patterns) {
    if (ps.trades.length < 50) continue;
    const pfVal = pf(ps.trades);
    if (pfVal > bestPF) {
      bestPF = pfVal;
      bestPattern = ps;
    }
  }

  if (!bestPattern) {
    console.log("  No pattern with >= 50 trades found!");
    process.exit(1);
  }

  console.log(`  Best Pattern: ${bestPattern.label}`);
  console.log(`  Trades:       ${bestPattern.trades.length}`);
  console.log(`  PF:           ${f3(bestPF)}`);
  console.log(`  WR:           ${f2(wr(bestPattern.trades))}%`);
  console.log(`  Total Pips:   ${f2(totalPips(bestPattern.trades))}`);

  // ── STEP 7: OOS Check on Best Pattern ────────────────────────────────

  console.log("\n─── 6. OOS Verification of Best Pattern ─────────────────────────");

  const { isTrades, oosTrades, isSplitDate } = splitISOS(bestPattern.trades);

  const isPF  = pf(isTrades);
  const oosPF = pf(oosTrades);
  const isWR  = wr(isTrades);
  const oosWR = wr(oosTrades);
  const isTot = totalPips(isTrades);
  const oosTot = totalPips(oosTrades);
  const isMID = isTrades.length > 0 ? isTrades[0].entry_time.substring(0, 10) : "N/A";
  const oosEND = oosTrades.length > 0 ? oosTrades[oosTrades.length - 1].entry_time.substring(0, 10) : "N/A";

  const oosRatio = isPF > 0 ? oosPF / isPF : 0;
  const oosVerdict = oosRatio >= 0.7 ? "PASSES OOS CHECK" : "FAILS OOS CHECK";

  console.log(`  IS  period:   ${isMID} → ${isSplitDate.substring(0, 10)} (N=${isTrades.length})`);
  console.log(`  OOS period:   ${isSplitDate.substring(0, 10)} → ${oosEND} (N=${oosTrades.length})`);
  console.log(`  IS  PF:       ${f3(isPF)}`);
  console.log(`  OOS PF:       ${f3(oosPF)}`);
  console.log(`  OOS/IS ratio: ${f3(oosRatio)} (threshold: 0.70)`);
  console.log(`  IS  WR:       ${f2(isWR)}%`);
  console.log(`  OOS WR:       ${f2(oosWR)}%`);
  console.log(`  IS  Total Pips:  ${f2(isTot)}`);
  console.log(`  OOS Total Pips:  ${f2(oosTot)}`);
  console.log(`  OOS VERDICT:  ${oosVerdict}`);

  // Also check Pattern 3 (High ATR × NY) as reference if it's not bestPattern
  const p3 = patterns[3]; // Pattern 3
  if (p3 !== bestPattern && p3.trades.length >= 50) {
    console.log(`\n  [Reference: Pattern 3 OOS — High ATR × NY]`);
    const { isTrades: i3, oosTrades: o3, isSplitDate: split3 } = splitISOS(p3.trades);
    const isPF3 = pf(i3);
    const oosPF3 = pf(o3);
    const ratio3 = isPF3 > 0 ? oosPF3 / isPF3 : 0;
    console.log(`    IS  PF: ${f3(isPF3)}, OOS PF: ${f3(oosPF3)}, ratio: ${f3(ratio3)} → ${ratio3 >= 0.7 ? "PASSES" : "FAILS"}`);
    console.log(`    IS  N: ${i3.length}, OOS N: ${o3.length}`);
  }

  // ── STEP 8: LONG vs SHORT in Best Pattern ────────────────────────────

  console.log("\n─── 7. LONG vs SHORT in Best Pattern ────────────────────────────");

  const bp = bestPattern;
  const bpL  = bp.longTrades;
  const bpS  = bp.shortTrades;

  console.log(`\n  ${"Metric".padEnd(20)} ${"LONG".padEnd(15)} SHORT`);
  console.log("  " + "─".repeat(55));
  console.log(`  ${"Trades".padEnd(20)} ${String(bpL.length).padEnd(15)} ${bpS.length}`);
  console.log(`  ${"WR".padEnd(20)} ${(f2(wr(bpL)) + "%").padEnd(15)} ${f2(wr(bpS))}%`);
  console.log(`  ${"PF".padEnd(20)} ${f3(pf(bpL)).padEnd(15)} ${f3(pf(bpS))}`);
  console.log(`  ${"Total Pips".padEnd(20)} ${f2(totalPips(bpL)).padEnd(15)} ${f2(totalPips(bpS))}`);
  console.log(`  ${"Pips/Trade".padEnd(20)} ${f2(pipsPerTrade(bpL)).padEnd(15)} ${f2(pipsPerTrade(bpS))}`);
  console.log(`  ${"MFE median".padEnd(20)} ${(f2(median(bpL.map((t) => t.mfe))) + " pips").padEnd(15)} ${f2(median(bpS.map((t) => t.mfe)))} pips`);
  console.log(`  ${"MAE median".padEnd(20)} ${(f2(median(bpL.map((t) => t.mae))) + " pips").padEnd(15)} ${f2(median(bpS.map((t) => t.mae)))} pips`);

  // ── STEP 9: Sample size analysis ─────────────────────────────────────

  console.log("\n─── 8. Sample Size Analysis ─────────────────────────────────────");
  console.log(`  ${"Pattern".padEnd(45)} ${"N".padEnd(7)} ${"PF".padEnd(8)} Flag`);
  console.log("  " + "─".repeat(75));
  for (const ps of patterns) {
    const n   = ps.trades.length;
    const pfVal = pf(ps.trades);
    const flag = n < 50 ? "VERY LOW" : n < 100 ? "LOW SAMPLE" : n < 200 ? "MODERATE" : "OK";
    const shortLabel = ps.label.substring(0, 44).padEnd(44);
    console.log(`  ${shortLabel} ${String(n).padEnd(7)} ${f3(pfVal).padEnd(8)} ${flag}`);
  }

  // ── STEP 10: EMA21 Hypothesis Final Verdict ───────────────────────────

  console.log("\n─── 9. EMA21 Hypothesis Final Verdict ───────────────────────────");

  const allPFs = patterns.map((ps) => ({ label: ps.label, n: ps.trades.length, pfVal: pf(ps.trades) }));

  // Interpretation criteria
  let hypothesisStatus: string;
  let verdictDetail: string;

  const bestN   = bestPattern.trades.length;
  const oosPFn  = oosPF;

  if (bestN >= 150 && bestPF >= 1.2 && oosPFn >= 1.0) {
    hypothesisStatus = "CONTINUES — STRONG EDGE";
    verdictDetail = `Trades >= 150, PF >= 1.2, OOS PF >= 1.0. Proceed to Phase 5-H with ${bestPattern.label}.`;
  } else if (bestN >= 100 && bestPF >= 1.0 && oosPFn >= 0.9) {
    hypothesisStatus = "CONTINUES — EDGE";
    verdictDetail = `Trades >= 100, PF >= 1.0, OOS PF >= 0.9. Proceed to Phase 5-H with ${bestPattern.label}.`;
  } else if (bestN >= 50 && bestPF >= 1.0) {
    hypothesisStatus = "WEAK EDGE — MARGINAL";
    verdictDetail = `Trades >= 50, PF >= 1.0 but OOS unstable (ratio: ${f3(oosRatio)}). Verify with larger sample.`;
  } else if (bestPF < 1.0) {
    hypothesisStatus = "TERMINATED — NO EDGE";
    verdictDetail = `Best PF ${f3(bestPF)} < 1.0 across all patterns. EMA21 pullback hypothesis has no identifiable edge.`;
  } else {
    hypothesisStatus = "OVERFITTING RISK";
    verdictDetail = `Trades < 50 or PF spiky with tiny sample. Overfitting suspected. EMA21 hypothesis effectively terminated.`;
  }

  // Check if any pattern with N>=50 has PF >= 1.0
  const anyEdge = allPFs.some((p) => p.n >= 50 && p.pfVal >= 1.0);

  if (!anyEdge) {
    hypothesisStatus = "TERMINATED — NO EDGE";
    verdictDetail = `No pattern (N>=50) achieved PF >= 1.0. EMA21 pullback hypothesis is terminated.`;
  }

  console.log(`  Status: ${hypothesisStatus}`);
  console.log(`  Detail: ${verdictDetail}`);

  // All patterns summary
  console.log("\n  Pattern PF Summary:");
  for (const { label, n, pfVal } of allPFs) {
    const edgeLabel = pfVal >= 1.2 ? "STRONG" : pfVal >= 1.0 ? "EDGE" : "NO EDGE";
    const nl = n < 50 ? " [LOW SAMPLE]" : "";
    console.log(`    ${label.padEnd(50)} PF=${f3(pfVal)} N=${n}${nl} → ${edgeLabel}`);
  }

  // ── STEP 11: Summary Block ────────────────────────────────────────────

  console.log("\n─── 10. Changed Files ───────────────────────────────────────────");
  console.log("  None (analysis only — no engine changes)");

  console.log("\n─── 11. New Files ───────────────────────────────────────────────");
  console.log("  scripts/phase5g_env_filter.ts");

  console.log("\n─── 12. TypeScript ──────────────────────────────────────────────");
  console.log("  (Run: npx tsc --noEmit)");

  console.log("\n─── 13. Regression ──────────────────────────────────────────────");
  console.log("  (Run: npx tsx src/infrastructure/backtest/__tests__/phase5e.test.ts)");
  console.log("  (Run: npx tsx src/infrastructure/backtest/__tests__/evaluator.test.ts)");

  // Determine next phase recommendation
  let nextPhase: string;
  if (hypothesisStatus.includes("CONTINUES")) {
    nextPhase = `Phase 5-H — ${bestPattern.label} フィルター付き仮説の正式バックテスト`;
  } else {
    nextPhase = "Phase 6-A — 新仮説検討 (EMA21 以外のエッジ探索、例: Breakout / Momentum / Mean-Reversion)";
  }

  const emaConclusion = hypothesisStatus.startsWith("CONTINUES") ? "CONTINUES" : "TERMINATED";

  // ── Final Summary Box ─────────────────────────────────────────────────

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║            PHASE 5-G: COMPLETE                               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`BEST PATTERN:        ${bestPattern.label}`);
  console.log(`BEST PATTERN TRADES: ${bestPattern.trades.length}`);
  console.log(`BEST PATTERN PF:     ${f3(bestPF)}`);
  console.log(`OOS PF:              ${f3(oosPF)}`);
  console.log(`OOS VERDICT:         ${oosVerdict}`);
  console.log(`EMA21 HYPOTHESIS:    ${emaConclusion}`);
  console.log(`NEXT PHASE:          ${nextPhase}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

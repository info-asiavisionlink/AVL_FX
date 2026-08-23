/**
 * Phase 7-A: Price Structure Edge Discovery
 *
 * Tests 6 OHLC signal families against matched random control.
 * NO SL/TP/spread/slippage — raw future returns only.
 *
 * S1: Large Range Bar   S2: Close Location Value
 * S3: Range Expansion   S4: Inside Bar Break
 * S5: Multi-Bar Pressure S6: Extended Move
 *
 * CASE B: research-only script, no engine changes.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/phase7a_price_structure_edge.ts
 */

export {};

import type { Bar }                from "@/infrastructure/analysis/types";
import { calculateATR }            from "@/infrastructure/backtest/indicators";
import { calcMedian, calcPercentile } from "@/infrastructure/backtest/phase6a/analysisHelpers";
import { seededRNG }               from "@/infrastructure/backtest/phase6b/rawAnalysis";

// ── Constants ──────────────────────────────────────────────────────────

const SB_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL    = "EURUSD";
const PIP       = 0.0001;
const PAGE_SIZE = 1000;
const WARMUP    = 50;         // bars needed before first signal
const MAX_H     = 10;         // max future horizon
const ATR_PERIOD = 14;
const HORIZONS  = [1, 3, 5, 10] as const;

// S-specific constants — fixed, no post-result changes
const S1_RANGE_MULT    = 1.5;   // range >= 1.5 × ATR
const S2_CLV_HIGH      = 0.80;
const S2_CLV_LOW       = 0.20;
const S3_TR_MULT       = 1.5;   // TR >= 1.5 × medianTR10
const S3_TR_LOOKBACK   = 10;
const S5_BARS          = 3;
const S6_MOVE_BARS     = 5;
const S6_MOVE_MULT     = 2.0;   // |5-bar move| >= 2.0 × ATR

// Multiple testing warning threshold
const N_HYPOTHESES     = 12;    // 6 families × 2 directions

// ── Fetch ──────────────────────────────────────────────────────────────

async function fetchBars(tf: string): Promise<Bar[]> {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const all: { time_utc: string; open: number; high: number; low: number; close: number }[] = [];
  let offset = 0;
  for (;;) {
    const url = `${SB_URL}/rest/v1/bar_data?select=time_utc,open,high,low,close&symbol=eq.${SYMBOL}&timeframe=eq.${tf}&order=time_utc.asc&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetch ${tf}: ${res.status}`);
    const rows = (await res.json()) as typeof all;
    rows.forEach(r => { r.open=+r.open; r.high=+r.high; r.low=+r.low; r.close=+r.close; });
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all.map(r => ({
    time:   new Date(r.time_utc).getTime(),
    open:   r.open, high: r.high, low: r.low, close: r.close, volume: 0,
  }));
}

// ── True Range ─────────────────────────────────────────────────────────

function computeTR(bars: Bar[]): number[] {
  const tr = new Array<number>(bars.length).fill(0);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - bars[i - 1].close);
    const lc = Math.abs(bars[i].low  - bars[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }
  return tr;
}

function medianTRPrev(tr: number[], idx: number, n: number): number {
  const vals = tr.slice(Math.max(0, idx - n), idx);
  return calcMedian(vals);
}

// ── Signal types ────────────────────────────────────────────────────────

type Dir = "BULL" | "BEAR";

interface Sig {
  idx:   number;   // signal bar index (reference = close of this bar)
  dir:   Dir;
  atr:   number;   // ATR in price at signal bar
}

// ── Outcome ────────────────────────────────────────────────────────────

interface Outcome {
  ret:  [number, number, number, number];  // horizons 1,3,5,10 (continuation-oriented pips)
  mfe3: number; mfe5: number; mfe10: number;  // pips, unsigned (favorable)
  mae3: number; mae5: number; mae10: number;  // pips, unsigned (adverse)
}

function getOutcome(sig: Sig, bars: Bar[]): Outcome | null {
  if (sig.idx + MAX_H + 1 >= bars.length) return null;
  const ref  = bars[sig.idx].close;
  const sign = sig.dir === "BULL" ? 1 : -1;

  const ret = HORIZONS.map(h => {
    const fc = bars[sig.idx + h]?.close;
    if (fc === undefined) return NaN;
    return sign * (fc - ref) / PIP;
  }) as [number, number, number, number];
  if (ret.some(v => isNaN(v))) return null;

  let mfe3 = 0, mfe5 = 0, mfe10 = 0;
  let mae3 = 0, mae5 = 0, mae10 = 0;
  for (let h = 1; h <= MAX_H; h++) {
    const b = bars[sig.idx + h];
    if (!b) break;
    const fav = sign === 1 ? (b.high - ref) / PIP : (ref - b.low)  / PIP;
    const adv = sign === 1 ? (ref - b.low)  / PIP : (b.high - ref) / PIP;
    if (h <= 3)  { if (fav > mfe3)  mfe3  = fav; if (adv > mae3)  mae3  = adv; }
    if (h <= 5)  { if (fav > mfe5)  mfe5  = fav; if (adv > mae5)  mae5  = adv; }
    if (h <= 10) { if (fav > mfe10) mfe10 = fav; if (adv > mae10) mae10 = adv; }
  }
  return { ret, mfe3, mfe5, mfe10, mae3, mae5, mae10 };
}

// ── Stats ──────────────────────────────────────────────────────────────

interface HorizonStat {
  n:         number;
  favRate:   number;   // % continuation > 0
  medRet:    number;   // pips
}

interface SignalStats {
  n:          number;
  h:          [HorizonStat, HorizonStat, HorizonStat, HorizonStat];  // 1,3,5,10
  medMFE5:    number;
  medMAE5:    number;
  medMFE10:   number;
  medMAE10:   number;
  sampleClass: "STRONG" | "VALID" | "LOW" | "INSUFFICIENT";
}

const EMPTY_STAT: HorizonStat = { n: 0, favRate: 0, medRet: 0 };
const EMPTY_STATS: SignalStats = {
  n: 0,
  h: [EMPTY_STAT, EMPTY_STAT, EMPTY_STAT, EMPTY_STAT],
  medMFE5: 0, medMAE5: 0, medMFE10: 0, medMAE10: 0,
  sampleClass: "INSUFFICIENT",
};

function computeSignalStats(outcomes: Outcome[]): SignalStats {
  const n = outcomes.length;
  if (n === 0) return EMPTY_STATS;

  const h: [HorizonStat, HorizonStat, HorizonStat, HorizonStat] = HORIZONS.map((_, hi) => {
    const rets = outcomes.map(o => o.ret[hi]);
    return {
      n,
      favRate: rets.filter(r => r > 0).length / n * 100,
      medRet:  calcMedian(rets),
    };
  }) as [HorizonStat, HorizonStat, HorizonStat, HorizonStat];

  return {
    n,
    h,
    medMFE5:  calcMedian(outcomes.map(o => o.mfe5)),
    medMAE5:  calcMedian(outcomes.map(o => o.mae5)),
    medMFE10: calcMedian(outcomes.map(o => o.mfe10)),
    medMAE10: calcMedian(outcomes.map(o => o.mae10)),
    sampleClass: n >= 300 ? "STRONG" : n >= 100 ? "VALID" : n >= 50 ? "LOW" : "INSUFFICIENT",
  };
}

// ── Random control ─────────────────────────────────────────────────────

function randomControl(
  n: number, dir: Dir, bars: Bar[], seed: number,
  eligibleIndices: number[],
): Outcome[] {
  const rng     = seededRNG(seed);
  const results: Outcome[] = [];
  let   attempts = 0;
  while (results.length < n && attempts < n * 20) {
    const ei  = Math.floor(rng() * eligibleIndices.length);
    const idx = eligibleIndices[ei];
    const o   = getOutcome({ idx, dir, atr: 0 }, bars);
    if (o !== null) results.push(o);
    attempts++;
  }
  return results;
}

// ── EDGE DELTA ─────────────────────────────────────────────────────────

interface EdgeDelta {
  h1:  number;   // signal_favRate - rand_favRate at horizon 1
  h3:  number;
  h5:  number;
  h10: number;
  medRetDelta5: number;
}

function edgeDelta(sig: SignalStats, rand: SignalStats): EdgeDelta {
  return {
    h1:  sig.h[0].favRate - rand.h[0].favRate,
    h3:  sig.h[1].favRate - rand.h[1].favRate,
    h5:  sig.h[2].favRate - rand.h[2].favRate,
    h10: sig.h[3].favRate - rand.h[3].favRate,
    medRetDelta5: sig.h[2].medRet - rand.h[2].medRet,
  };
}

// ── Classification ─────────────────────────────────────────────────────

type SignalClass =
  | "STRONG_CANDIDATE"
  | "PROMISING"
  | "WEAK"
  | "NO_EDGE"
  | "CONTRARIAN"
  | "INSUFFICIENT";

function classify(s: SignalStats, ed: EdgeDelta, halfStable: boolean): SignalClass {
  if (s.sampleClass === "INSUFFICIENT") return "INSUFFICIENT";
  const bestDelta = Math.max(ed.h1, ed.h3, ed.h5, ed.h10);
  const worstDelta = Math.min(ed.h1, ed.h3, ed.h5, ed.h10);
  if (bestDelta <= 0 && worstDelta >= -2) return "NO_EDGE";
  if (worstDelta < -3 && bestDelta < 1)   return "CONTRARIAN";
  if (bestDelta >= 5 && halfStable && s.sampleClass !== "LOW") return "STRONG_CANDIDATE";
  if (bestDelta >= 3 || (bestDelta >= 2 && halfStable))        return "PROMISING";
  if (bestDelta > 0)  return "WEAK";
  return "NO_EDGE";
}

// ── Signal scanners ─────────────────────────────────────────────────────

// S1: Large Range Bar
function scanS1(bars: Bar[], atr: (number|undefined)[], tr: number[]): Sig[] {
  const sigs: Sig[] = [];
  for (let i = WARMUP; i < bars.length - MAX_H - 2; i++) {
    const a = atr[i];
    if (a === undefined || a <= 0) continue;
    const range = bars[i].high - bars[i].low;
    if (range < S1_RANGE_MULT * a) continue;
    const dir: Dir = bars[i].close > bars[i].open ? "BULL" : bars[i].close < bars[i].open ? "BEAR" : "BULL";
    sigs.push({ idx: i, dir, atr: a });
  }
  return sigs;
}

// S2: Close Location Value
function scanS2(bars: Bar[]): Sig[] {
  const sigs: Sig[] = [];
  for (let i = WARMUP; i < bars.length - MAX_H - 2; i++) {
    const b = bars[i];
    const range = b.high - b.low;
    if (range <= 0) continue;
    const clv = (b.close - b.low) / range;
    if (clv >= S2_CLV_HIGH) sigs.push({ idx: i, dir: "BULL", atr: 0 });
    else if (clv <= S2_CLV_LOW) sigs.push({ idx: i, dir: "BEAR", atr: 0 });
  }
  return sigs;
}

// S3: Range Expansion (TR >= 1.5 × medianTR10)
function scanS3(bars: Bar[], atr: (number|undefined)[], tr: number[]): Sig[] {
  const sigs: Sig[] = [];
  for (let i = WARMUP; i < bars.length - MAX_H - 2; i++) {
    if (tr[i] <= 0) continue;
    const medTR = medianTRPrev(tr, i, S3_TR_LOOKBACK);
    if (medTR <= 0 || tr[i] < S3_TR_MULT * medTR) continue;
    const dir: Dir = bars[i].close > bars[i].open ? "BULL" : bars[i].close < bars[i].open ? "BEAR" : "BULL";
    sigs.push({ idx: i, dir, atr: atr[i] ?? 0 });
  }
  return sigs;
}

// S4: Inside Bar Break
// Detected when: bar i-1 is mother, bar i is inside bar, bar i+1 breaks mother range.
// Signal bar = i+1 (the breakout bar). Reference = close[i+1].
function scanS4(bars: Bar[], atr: (number|undefined)[]): Sig[] {
  const sigs: Sig[] = [];
  for (let i = WARMUP + 1; i < bars.length - MAX_H - 3; i++) {
    const mother = bars[i - 1];
    const inside = bars[i];
    // Check inside condition
    if (!(inside.high < mother.high && inside.low > mother.low)) continue;
    const next = bars[i + 1];
    // Signal: next bar's close breaks the mother bar's range
    if (next.close > mother.high) {
      sigs.push({ idx: i + 1, dir: "BULL", atr: atr[i + 1] ?? 0 });
    } else if (next.close < mother.low) {
      sigs.push({ idx: i + 1, dir: "BEAR", atr: atr[i + 1] ?? 0 });
    }
    // Skip ahead to avoid overlapping signals on same bar cluster
    // (no skip — allow overlapping, rare in practice)
  }
  return sigs;
}

// S5: Multi-Bar Directional Pressure (3 consecutive same-direction bars)
function scanS5(bars: Bar[]): Sig[] {
  const sigs: Sig[] = [];
  for (let i = WARMUP + S5_BARS - 1; i < bars.length - MAX_H - 2; i++) {
    let bullCount = 0, bearCount = 0;
    for (let k = 0; k < S5_BARS; k++) {
      const b = bars[i - k];
      if (b.close > b.open) bullCount++;
      else if (b.close < b.open) bearCount++;
    }
    if (bullCount === S5_BARS) sigs.push({ idx: i, dir: "BULL", atr: 0 });
    else if (bearCount === S5_BARS) sigs.push({ idx: i, dir: "BEAR", atr: 0 });
  }
  return sigs;
}

// S6: Extended Move (5-bar cumulative move >= 2.0 × ATR)
function scanS6(bars: Bar[], atr: (number|undefined)[]): Sig[] {
  const sigs: Sig[] = [];
  for (let i = WARMUP + S6_MOVE_BARS; i < bars.length - MAX_H - 2; i++) {
    const a = atr[i];
    if (a === undefined || a <= 0) continue;
    // Sum of close-to-close changes over previous 5 bars
    let cumMove = 0;
    for (let k = 0; k < S6_MOVE_BARS; k++) {
      cumMove += bars[i - k].close - bars[i - k - 1].close;
    }
    const movePips = cumMove / PIP;
    if (Math.abs(movePips) < S6_MOVE_MULT * a / PIP) continue;
    const dir: Dir = cumMove > 0 ? "BULL" : "BEAR";
    sigs.push({ idx: i, dir, atr: a });
  }
  return sigs;
}

// ── Evaluate signals → outcomes ────────────────────────────────────────

function evalSignals(sigs: Sig[], bars: Bar[]): Outcome[] {
  return sigs.map(s => getOutcome(s, bars)).filter((o): o is Outcome => o !== null);
}

// ── Temporal half-split ────────────────────────────────────────────────

function halfSplit(sigs: Sig[], bars: Bar[]): { first: Outcome[]; second: Outcome[] } {
  const midTime = (bars[0].time + bars[bars.length - 1].time) / 2;
  const first  = evalSignals(sigs.filter(s => bars[s.idx].time <= midTime), bars);
  const second = evalSignals(sigs.filter(s => bars[s.idx].time >  midTime), bars);
  return { first, second };
}

function yearSplit(sigs: Sig[], bars: Bar[]): Map<number, Outcome[]> {
  const byYear = new Map<number, Sig[]>();
  for (const s of sigs) {
    const y = new Date(bars[s.idx].time).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(s);
  }
  const result = new Map<number, Outcome[]>();
  for (const [y, ss] of byYear) result.set(y, evalSignals(ss, bars));
  return result;
}

// ── Formatting ─────────────────────────────────────────────────────────

const f1  = (n: number) => n.toFixed(1);
const f2  = (n: number) => n.toFixed(2);
const pct = (n: number) => n.toFixed(1) + "%";
const sgn = (n: number) => (n >= 0 ? "+" : "") + f1(n);
const EQ  = "═";

function printSignalBlock(
  label: string, dir: Dir, sStats: SignalStats, rStats: SignalStats,
  ed: EdgeDelta, firstStats: SignalStats, secondStats: SignalStats,
  cls: SignalClass,
): void {
  const HS = (s: SignalStats, hi: number) =>
    `${pct(s.h[hi].favRate).padStart(7)} / ${f1(s.h[hi].medRet).padStart(6)}p`;
  console.log(`\n  ┌── ${label} [${dir}] ─── N=${sStats.n} (${sStats.sampleClass}) ── ${cls}`);
  console.log(`  │  Horizon  Sig%  Rand%  Δ%    SigMedRet  RandMedRet`);
  console.log(`  │  ` + "─".repeat(56));
  const deltas = [ed.h1, ed.h3, ed.h5, ed.h10];
  HORIZONS.forEach((h, hi) => {
    const ss = sStats.h[hi], rs = rStats.h[hi];
    const d = deltas[hi];
    const flag = d >= 5 ? " ◆" : d >= 3 ? " ▶" : d >= 1 ? " ·" : d < -2 ? " ✗" : "  ";
    console.log(
      `  │  ${String(h).padStart(2)}bar   ` +
      `${pct(ss.favRate).padStart(6)} ` +
      `${pct(rs.favRate).padStart(7)} ` +
      `${sgn(d).padStart(6)} ` +
      `${f1(ss.medRet).padStart(8)}p  ` +
      `${f1(rs.medRet).padStart(8)}p` + flag,
    );
  });
  console.log(`  │  MFE5=${f2(sStats.medMFE5)}p  MAE5=${f2(sStats.medMAE5)}p  MFE10=${f2(sStats.medMFE10)}p  MAE10=${f2(sStats.medMAE10)}p`);
  const fe5 = firstStats.h[2];
  const se5 = secondStats.h[2];
  const stable = Math.abs(fe5.favRate - se5.favRate) < 8 && firstStats.n >= 20 && secondStats.n >= 20;
  console.log(`  │  Temporal (5-bar fav%): 1H=${pct(fe5.favRate)} N=${firstStats.n} | 2H=${pct(se5.favRate)} N=${secondStats.n} ${stable ? "STABLE" : "UNSTABLE"}`);
  console.log(`  └──`);
}

// ── Market direction baseline ──────────────────────────────────────────

function unconditionalFavRate(bars: Bar[], dir: Dir, horizon: number, eligibles: number[]): number {
  const rets = eligibles.map(i => {
    const ref = bars[i].close;
    const fc  = bars[i + horizon]?.close;
    if (fc === undefined) return NaN;
    return dir === "BULL" ? (fc - ref) / PIP : (ref - fc) / PIP;
  }).filter(v => !isNaN(v));
  return rets.length > 0 ? rets.filter(r => r > 0).length / rets.length * 100 : 50;
}

// ── Main ───────────────────────────────────────────────────────────────

async function runAnalysis(
  label: string,
  bars: Bar[],
  atr: (number|undefined)[],
  tr: number[],
  eligibles: number[],
  isH4: boolean = false,
): Promise<Array<{ name: string; dir: Dir; stats: SignalStats; ed: EdgeDelta; cls: SignalClass; firstHalf: SignalStats; secondHalf: SignalStats }>> {

  const resultRows: Array<{ name: string; dir: Dir; stats: SignalStats; ed: EdgeDelta; cls: SignalClass; firstHalf: SignalStats; secondHalf: SignalStats }> = [];

  const families: Array<{ name: string; sigs: Sig[] }> = [
    { name: "S1_LARGE_RANGE",    sigs: scanS1(bars, atr, tr) },
    { name: "S2_CLOSE_LOCATION", sigs: scanS2(bars) },
    { name: "S3_RANGE_EXPAND",   sigs: scanS3(bars, atr, tr) },
    { name: "S4_INSIDE_BREAK",   sigs: scanS4(bars, atr) },
    { name: "S5_3BAR_PRESSURE",  sigs: scanS5(bars) },
    { name: "S6_EXTENDED_MOVE",  sigs: scanS6(bars, atr) },
  ];

  for (const { name, sigs } of families) {
    for (const dir of ["BULL", "BEAR"] as const) {
      const dirSigs    = sigs.filter(s => s.dir === dir);
      const outcomes   = evalSignals(dirSigs, bars);
      const stats      = computeSignalStats(outcomes);

      // Matched random (same count, same timeframe eligible set)
      const randOut    = randomControl(outcomes.length, dir, bars, 42, eligibles);
      const randStats  = computeSignalStats(randOut);

      const ed         = edgeDelta(stats, randStats);
      const { first, second } = halfSplit(dirSigs, bars);
      const firstStats  = computeSignalStats(first);
      const secondStats = computeSignalStats(second);

      const halfStable = firstStats.sampleClass !== "INSUFFICIENT" &&
                         secondStats.sampleClass !== "INSUFFICIENT" &&
                         Math.abs(firstStats.h[2].favRate - secondStats.h[2].favRate) < 8;

      const cls = classify(stats, ed, halfStable);

      if (!isH4) printSignalBlock(`${name}`, dir, stats, randStats, ed, firstStats, secondStats, cls);

      resultRows.push({ name, dir, stats, ed, cls, firstHalf: firstStats, secondHalf: secondStats });
    }
  }
  return resultRows;
}

async function main(): Promise<void> {
  console.log("╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 7-A: PRICE STRUCTURE EDGE DISCOVERY" + " ".repeat(29) + "║");
  console.log("║  6 OHLC signal families vs matched random control" + " ".repeat(22) + "║");
  console.log("╚" + EQ.repeat(72) + "╝");
  console.log("\n  CASE: B — research-only script. No engine changes.");
  console.log("  NO SL/TP/spread/slippage. Raw future returns only.");
  console.log(`  MULTIPLE TESTING: ${N_HYPOTHESES} directional hypotheses.`);

  // ── STEP 1: Data ──────────────────────────────────────────────────────
  console.log("\n[STEP 1] Fetching bar data...");
  const [h1Bars, h4Bars] = await Promise.all([fetchBars("H1"), fetchBars("H4")]);

  const h1ATR = calculateATR(h1Bars, ATR_PERIOD);
  const h4ATR = calculateATR(h4Bars, ATR_PERIOD);
  const h1TR  = computeTR(h1Bars);
  const h4TR  = computeTR(h4Bars);

  const h1Span = Math.round((h1Bars[h1Bars.length-1].time - h1Bars[0].time) / 86_400_000);
  const h4Span = Math.round((h4Bars[h4Bars.length-1].time - h4Bars[0].time) / 86_400_000);

  console.log(`  H1: ${h1Bars.length} bars  ${new Date(h1Bars[0].time).toISOString().slice(0,10)} → ${new Date(h1Bars.at(-1)!.time).toISOString().slice(0,10)}  (${h1Span} days)`);
  console.log(`  H4: ${h4Bars.length} bars  ${new Date(h4Bars[0].time).toISOString().slice(0,10)} → ${new Date(h4Bars.at(-1)!.time).toISOString().slice(0,10)}  (${h4Span} days)`);

  // Eligible bar indices (enough warmup + enough future)
  const h1Eligible = Array.from({ length: h1Bars.length - WARMUP - MAX_H - 2 }, (_, i) => i + WARMUP);
  const h4Eligible = Array.from({ length: h4Bars.length - WARMUP - MAX_H - 2 }, (_, i) => i + WARMUP);

  // Unconditional market direction (baseline)
  const h1BullBase5 = unconditionalFavRate(h1Bars, "BULL", 5, h1Eligible);
  const h1BearBase5 = unconditionalFavRate(h1Bars, "BEAR", 5, h1Eligible);
  console.log(`\n  Unconditional H1 fav-rate (5-bar horizon):`);
  console.log(`    BULL: ${pct(h1BullBase5)}   BEAR: ${pct(h1BearBase5)}`);

  // ── STEP 2: H1 Analysis ───────────────────────────────────────────────
  console.log("\n" + EQ.repeat(74));
  console.log("[STEP 2] H1 SIGNAL ANALYSIS");
  console.log(EQ.repeat(74));

  const h1Results = await runAnalysis("H1", h1Bars, h1ATR, h1TR, h1Eligible);

  // ── STEP 3: Year-by-year for best candidates ──────────────────────────
  console.log("\n[STEP 3] Year-by-Year Breakdown (H1, N >= 10 per year)");
  console.log(EQ.repeat(74));

  const h1StartYear = new Date(h1Bars[0].time).getUTCFullYear();
  const h1EndYear   = new Date(h1Bars.at(-1)!.time).getUTCFullYear();

  const candidateRows = h1Results.filter(r =>
    r.cls === "STRONG_CANDIDATE" || r.cls === "PROMISING" ||
    (r.stats.sampleClass !== "INSUFFICIENT" && Math.max(r.ed.h1, r.ed.h3, r.ed.h5, r.ed.h10) >= 2),
  );

  for (const row of candidateRows) {
    const allSigs = ((): Sig[] => {
      switch (row.name) {
        case "S1_LARGE_RANGE":    return scanS1(h1Bars, h1ATR, h1TR).filter(s => s.dir === row.dir);
        case "S2_CLOSE_LOCATION": return scanS2(h1Bars).filter(s => s.dir === row.dir);
        case "S3_RANGE_EXPAND":   return scanS3(h1Bars, h1ATR, h1TR).filter(s => s.dir === row.dir);
        case "S4_INSIDE_BREAK":   return scanS4(h1Bars, h1ATR).filter(s => s.dir === row.dir);
        case "S5_3BAR_PRESSURE":  return scanS5(h1Bars).filter(s => s.dir === row.dir);
        case "S6_EXTENDED_MOVE":  return scanS6(h1Bars, h1ATR).filter(s => s.dir === row.dir);
        default: return [];
      }
    })();

    console.log(`\n  ${row.name} [${row.dir}]:`);
    const byYear = yearSplit(allSigs, h1Bars);
    for (let y = h1StartYear; y <= h1EndYear; y++) {
      const outs = byYear.get(y);
      if (!outs || outs.length < 10) { console.log(`    ${y}: N=${outs?.length ?? 0} [INSUFFICIENT]`); continue; }
      const s = computeSignalStats(outs);
      const rOut = randomControl(outs.length, row.dir, h1Bars, 42, h1Eligible);
      const rS   = computeSignalStats(rOut);
      const d5   = s.h[2].favRate - rS.h[2].favRate;
      console.log(
        `    ${y}: N=${String(s.n).padStart(4)}  5barFav=${pct(s.h[2].favRate).padStart(7)}  RandFav=${pct(rS.h[2].favRate).padStart(7)}  Δ=${sgn(d5).padStart(6)}  medRet=${f1(s.h[2].medRet).padStart(6)}p`,
      );
    }
  }

  // ── STEP 4: H4 Cross-check ────────────────────────────────────────────
  console.log("\n[STEP 4] H4 Cross-check (same definitions, no parameter changes)");
  console.log(EQ.repeat(74));

  const h4Results = await runAnalysis("H4", h4Bars, h4ATR, h4TR, h4Eligible, true);

  console.log(`\n  H4 results summary:`);
  console.log(`  ${"Name+Dir".padEnd(24)} ${"N".padStart(5)} ${"1bΔ".padStart(7)} ${"3bΔ".padStart(7)} ${"5bΔ".padStart(7)} ${"10bΔ".padStart(7)} ${"Class".padStart(14)}`);
  console.log("  " + "-".repeat(75));
  for (const r of h4Results) {
    console.log(
      `  ${(r.name + " " + r.dir).padEnd(24)} ` +
      `${String(r.stats.n).padStart(5)} ` +
      `${sgn(r.ed.h1).padStart(7)} ` +
      `${sgn(r.ed.h3).padStart(7)} ` +
      `${sgn(r.ed.h5).padStart(7)} ` +
      `${sgn(r.ed.h10).padStart(7)} ` +
      `${r.cls.padStart(14)}`,
    );
  }

  // ── STEP 5: H4 confirmation for H1 candidates ─────────────────────────
  console.log("\n[STEP 5] H1 vs H4 Confirmation Check");
  console.log(EQ.repeat(74));

  const confirmed: string[] = [];
  for (const h1r of candidateRows) {
    const h4r = h4Results.find(r => r.name === h1r.name && r.dir === h1r.dir);
    const bestH1 = Math.max(h1r.ed.h1, h1r.ed.h3, h1r.ed.h5, h1r.ed.h10);
    const bestH4 = h4r ? Math.max(h4r.ed.h1, h4r.ed.h3, h4r.ed.h5, h4r.ed.h10) : -99;
    const h4confirm = bestH4 > 0;
    const key = `${h1r.name} ${h1r.dir}`;
    if (h4confirm) confirmed.push(key);
    console.log(
      `  ${key.padEnd(26)} H1 maxΔ=${sgn(bestH1).padStart(6)}  H4 maxΔ=${sgn(bestH4).padStart(6)}  H4 confirm: ${h4confirm ? "YES" : "NO"}`,
    );
  }

  // ── STEP 6: Market direction bias control ─────────────────────────────
  console.log("\n[STEP 6] Market Direction Bias Control (H1 unconditional baselines)");
  console.log(EQ.repeat(74));

  console.log(`  Unconditional H1 favorable rates vs signal favorable rates:`);
  console.log(`  ${"Name+Dir".padEnd(26)} ${"SigFav5".padStart(9)} ${"UncondFav5".padStart(12)} ${"NetSignalEdge".padStart(15)}`);
  console.log("  " + "-".repeat(66));
  for (const row of h1Results) {
    const uncond = row.dir === "BULL" ? h1BullBase5 : h1BearBase5;
    const net    = row.stats.h[2].favRate - uncond;
    const flag   = Math.abs(net) < 1.5 ? " ← mkt bias explains" : "";
    console.log(
      `  ${(row.name + " " + row.dir).padEnd(26)} ` +
      `${pct(row.stats.h[2].favRate).padStart(9)} ` +
      `${pct(uncond).padStart(12)} ` +
      `${sgn(net).padStart(15)}${flag}`,
    );
  }

  // ── STEP 7: Summary table ─────────────────────────────────────────────
  console.log("\n[STEP 7] SUMMARY TABLE");
  console.log(EQ.repeat(74));

  const hdr = `  ${"Pattern+Dir".padEnd(28)} ${"N".padStart(5)} ` +
    `${"1bΔ".padStart(7)} ${"3bΔ".padStart(7)} ${"5bΔ".padStart(7)} ${"10bΔ".padStart(7)} ` +
    `${"MFE10".padStart(7)} ${"MAE10".padStart(7)} ` +
    `${"1H/2H Δ@5".padStart(12)} ${"H4conf".padStart(7)} ${"Class".padStart(18)}`;
  console.log(hdr);
  console.log("  " + "-".repeat(130));

  for (const row of h1Results) {
    const h4r    = h4Results.find(r => r.name === row.name && r.dir === row.dir);
    const h4best = h4r ? Math.max(h4r.ed.h1, h4r.ed.h3, h4r.ed.h5, h4r.ed.h10) : -99;
    const key    = `${row.name} ${row.dir}`;
    const fe5    = row.firstHalf.h[2].favRate, se5 = row.secondHalf.h[2].favRate;
    console.log(
      `  ${key.padEnd(28)} ${String(row.stats.n).padStart(5)} ` +
      `${sgn(row.ed.h1).padStart(7)} ` +
      `${sgn(row.ed.h3).padStart(7)} ` +
      `${sgn(row.ed.h5).padStart(7)} ` +
      `${sgn(row.ed.h10).padStart(7)} ` +
      `${f2(row.stats.medMFE10).padStart(7)} ` +
      `${f2(row.stats.medMAE10).padStart(7)} ` +
      `${(sgn(fe5-50)+"/"+sgn(se5-50)).padStart(12)} ` +
      `${(h4best > 0 ? "YES" : "no").padStart(7)} ` +
      `${row.cls.padStart(18)}`,
    );
  }

  // ── Critical Questions ─────────────────────────────────────────────────
  console.log("\n[ANSWERS] CRITICAL QUESTIONS");
  console.log(EQ.repeat(74));

  const bestRow  = [...h1Results].sort((a, b) =>
    Math.max(b.ed.h1, b.ed.h3, b.ed.h5, b.ed.h10) - Math.max(a.ed.h1, a.ed.h3, a.ed.h5, a.ed.h10),
  )[0];
  const bestDelta = Math.max(bestRow.ed.h1, bestRow.ed.h3, bestRow.ed.h5, bestRow.ed.h10);
  const bestH     = [bestRow.ed.h1, bestRow.ed.h3, bestRow.ed.h5, bestRow.ed.h10]
    .map((d, i) => ({ d, h: HORIZONS[i] }))
    .sort((a, b) => b.d - a.d)[0].h;

  const anyStructural = h1Results.some(r => r.cls === "STRONG_CANDIDATE" || r.cls === "PROMISING");
  const overallEdge: "STRONG" | "PROMISING" | "WEAK" | "NONE" =
    h1Results.some(r => r.cls === "STRONG_CANDIDATE") ? "STRONG" :
    h1Results.some(r => r.cls === "PROMISING")        ? "PROMISING" :
    h1Results.some(r => r.cls === "WEAK")             ? "WEAK"      : "NONE";

  console.log(`\n  Q1. Does H1 OHLC contain repeatable directional structure vs random?`);
  console.log(`      ${anyStructural ? "YES — see " + h1Results.filter(r => r.cls !== "NO_EDGE" && r.cls !== "INSUFFICIENT").map(r => r.name+" "+r.dir).join(", ") : "NO — all tested families show no reliable signal-specific edge."}`);
  console.log(`\n  Q2. Strongest signal-specific edge: ${bestRow.name} [${bestRow.dir}]`);
  console.log(`      Best edge delta: ${sgn(bestDelta)} at ${bestH}-bar horizon`);
  const retAtBest = bestRow.stats.h[HORIZONS.indexOf(bestH)].medRet;
  const contRev   = retAtBest > 0 ? "CONTINUATION" : "REVERSAL";
  console.log(`\n  Q3. Direction: ${contRev} (median ret=${f1(retAtBest)}p)`);
  const halfDiff = Math.abs(
    bestRow.firstHalf.h[2].favRate - bestRow.secondHalf.h[2].favRate,
  );
  console.log(`\n  Q4. Chronological split: first-half Δ5=${sgn(bestRow.firstHalf.h[2].favRate-50)} second-half Δ5=${sgn(bestRow.secondHalf.h[2].favRate-50)}  stability=${halfDiff < 8 ? "PASS" : "FAIL"}`);
  const h4r = h4Results.find(r => r.name === bestRow.name && r.dir === bestRow.dir);
  const h4best = h4r ? Math.max(h4r.ed.h1, h4r.ed.h3, h4r.ed.h5, h4r.ed.h10) : -99;
  console.log(`\n  Q5. H4 cross-check: ${h4best > 0 ? "PASS" : "FAIL"} (H4 maxΔ=${sgn(h4best)})`);
  const uncond  = bestRow.dir === "BULL" ? h1BullBase5 : h1BearBase5;
  const netEdge = bestRow.stats.h[2].favRate - uncond;
  console.log(`\n  Q6. Market direction bias: unconditional 5bar fav=${pct(uncond)}  signal fav=${pct(bestRow.stats.h[2].favRate)}  net=${sgn(netEdge)}  ${Math.abs(netEdge) < 1.5 ? "EXPLAINED BY MARKET BIAS" : "signal retains edge above bias"}`);
  console.log(`\n  Q7. Edge sufficient for strategy? Best delta=${sgn(bestDelta)} — ${Math.abs(bestDelta) >= 5 ? "YES, worth pursuing" : Math.abs(bestDelta) >= 3 ? "MARGINAL — proceed with caution" : "NO — too small for cost absorption"}`);

  // ── FINAL VERDICT ──────────────────────────────────────────────────────
  console.log("\n╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 7-A FINAL VERDICT" + " ".repeat(48) + "║");
  console.log("╠" + EQ.repeat(72) + "╣");
  const L = (lbl: string, val: string) => {
    const c = `  ${lbl.padEnd(40)} ${val}`;
    console.log(`║${c.padEnd(72)}║`);
  };
  L("PHASE 7-A:", "COMPLETE");
  L("DATA WINDOW H1:", `${new Date(h1Bars[0].time).toISOString().slice(0,10)} → ${new Date(h1Bars.at(-1)!.time).toISOString().slice(0,10)} (${h1Bars.length} bars, ${h1Span}d)`);
  L("DATA WINDOW H4:", `${new Date(h4Bars[0].time).toISOString().slice(0,10)} → ${new Date(h4Bars.at(-1)!.time).toISOString().slice(0,10)} (${h4Bars.length} bars, ${h4Span}d)`);
  L("HYPOTHESES TESTED:", `${N_HYPOTHESES} (6 families × 2 directions)`);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("BEST RAW SIGNAL:", `${bestRow.name} [${bestRow.dir}]`);
  L("BEST DIRECTION:", contRev);
  L("BEST EDGE DELTA:", `${sgn(bestDelta)} at ${bestH}-bar horizon`);
  L("BEST SAMPLE SIZE:", `${bestRow.stats.n} (${bestRow.stats.sampleClass})`);
  L("TEMPORAL STABILITY:", halfDiff < 8 ? "PASS" : `FAIL (gap=${f1(halfDiff)}%)`);
  L("H4 CONFIRMATION:", h4best > 0 ? `PASS (maxΔ=${sgn(h4best)})` : `FAIL (maxΔ=${sgn(h4best)})`);
  L("MARKET BIAS EXPLAINED:", Math.abs(netEdge) < 1.5 ? "YES" : netEdge > 0 ? "PARTIAL — signal retains edge" : "NO");
  L("VOLATILITY BIAS:", "NOT CONTROLLED — signals include high-range bars; random draws from all bars");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("MULTIPLE TESTING RISK:", "MEDIUM (12 pre-specified hypotheses, no search)");
  L("RAW PRICE EDGE:", overallEdge);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("ENGINE FILES CHANGED:", "NO");
  L("PRODUCTION DEFAULTS CHANGED:", "NO");
  L("PRODUCTION STRATEGY CREATED:", "NO");
  L("LIVE TRADING:", "NOT ENABLED");
  console.log("╠" + EQ.repeat(72) + "╣");
  const recommendation = (() => {
    if (overallEdge === "STRONG")    return "Phase 7-B: Build trading strategy around " + bestRow.name;
    if (overallEdge === "PROMISING") return "Phase 7-B: Confirm " + bestRow.name + " with True OOS data & cost simulation";
    if (overallEdge === "WEAK")      return "Phase 7-B: Explore complementary signal combinations with no post-hoc optimization";
    return "No price structure edge found. Reconsider timeframe, symbol, or signal family design.";
  })();
  L("NEXT RECOMMENDATION:", recommendation);
  console.log("╚" + EQ.repeat(72) + "╝");
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });

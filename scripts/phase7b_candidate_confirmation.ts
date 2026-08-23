/**
 * Phase 7-B: Candidate Edge Confirmation
 * S4_INSIDE_BREAK_BULL vs S6_EXTENDED_MOVE_BULL
 *
 * Full bias-controlled, bootstrap-validated, long-history confirmation.
 * Signal definitions FROZEN from Phase 7-A. No threshold changes.
 *
 * CASE B: research-only. No engine changes.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/phase7b_candidate_confirmation.ts
 */

export {};

import type { Bar }    from "@/infrastructure/analysis/types";
import { calculateATR } from "@/infrastructure/backtest/indicators";
import {
  calcMedian, calcPercentile, classifyATRRegime,
} from "@/infrastructure/backtest/phase6a/analysisHelpers";
import { seededRNG }   from "@/infrastructure/backtest/phase6b/rawAnalysis";

// ── Constants ──────────────────────────────────────────────────────────

const SB_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SYMBOL    = "EURUSD";
const PIP       = 0.0001;
const PAGE_SIZE = 1000;
const WARMUP    = 50;
const MAX_H     = 10;
const ATR_PERIOD = 14;
const S6_MOVE_BARS = 5;
const S6_MOVE_MULT = 2.0;
const N_BOOT    = 5000;
const N_RAND_RESAMPLES = 1000;
const BLOCK_H1  = 20;   // signal observations per block (H1)
const BLOCK_H4  = 5;    // signal observations per block (H4)

// DISCOVERY_SELECTED_HORIZON — chosen in Phase 7-A, not independently confirmed
const S4_PRIMARY_H = 5;
const S6_PRIMARY_H = 10;
const PATH_HORIZONS = [1, 2, 3, 4, 5, 10] as const;
const REPORT_H      = [1, 3, 5, 10]        as const;

// Sample thresholds
const VALID_N = 100, LOW_N = 50;

// ── Types ──────────────────────────────────────────────────────────────

type Dir    = "BULL" | "BEAR";
type ATRBand = "LOW" | "MID" | "HIGH";

interface Sig7B {
  idx:     number;
  dir:     Dir;
  atr:     number;
  atrBand: ATRBand;
  hour:    number;  // UTC hour of day
}

interface PathOutcome {
  // continuation-oriented pips at each horizon
  rets:  { [h: number]: number };
  mfe5:  number;
  mae5:  number;
  mfe10: number;
  mae10: number;
}

interface BootResult {
  ci95lo: number;
  ci95hi: number;
  pEdgePos: number;   // P(bootstrap_fav > rand_mean)
  bootMean: number;
}

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
    time: new Date(r.time_utc).getTime(),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: 0,
  }));
}

// ── ATR bucketing ──────────────────────────────────────────────────────

function assignBands(
  sigs: Omit<Sig7B, "atrBand">[], atrBounds: { p33: number; p66: number },
): Sig7B[] {
  return sigs.map(s => ({
    ...s,
    atrBand: (s.atr < atrBounds.p33 ? "LOW" : s.atr < atrBounds.p66 ? "MID" : "HIGH") as ATRBand,
  }));
}

// ── EXACT frozen signal scanners (from Phase 7-A) ──────────────────────

function scanS4(bars: Bar[], atr: (number|undefined)[]): Omit<Sig7B, "atrBand">[] {
  const sigs: Omit<Sig7B, "atrBand">[] = [];
  for (let i = WARMUP + 1; i < bars.length - MAX_H - 3; i++) {
    const mother = bars[i - 1];
    const inside = bars[i];
    if (!(inside.high < mother.high && inside.low > mother.low)) continue;
    const next = bars[i + 1];
    const a = atr[i + 1] ?? 0;
    const hour = new Date(next.time).getUTCHours();
    if (next.close > mother.high)
      sigs.push({ idx: i + 1, dir: "BULL", atr: a, hour });
    else if (next.close < mother.low)
      sigs.push({ idx: i + 1, dir: "BEAR", atr: a, hour });
  }
  return sigs;
}

function scanS6(bars: Bar[], atr: (number|undefined)[]): Omit<Sig7B, "atrBand">[] {
  const sigs: Omit<Sig7B, "atrBand">[] = [];
  for (let i = WARMUP + S6_MOVE_BARS; i < bars.length - MAX_H - 2; i++) {
    const a = atr[i];
    if (a === undefined || a <= 0) continue;
    let cumMove = 0;
    for (let k = 0; k < S6_MOVE_BARS; k++)
      cumMove += bars[i - k].close - bars[i - k - 1].close;
    const movePips = cumMove / PIP;
    if (Math.abs(movePips) < S6_MOVE_MULT * a / PIP) continue;
    const dir: Dir = cumMove > 0 ? "BULL" : "BEAR";
    const hour = new Date(bars[i].time).getUTCHours();
    sigs.push({ idx: i, dir, atr: a, hour });
  }
  return sigs;
}

// ── Path outcome ───────────────────────────────────────────────────────

function getPath(sig: Sig7B, bars: Bar[]): PathOutcome | null {
  if (sig.idx + MAX_H + 1 >= bars.length) return null;
  const ref  = bars[sig.idx].close;
  const sign = sig.dir === "BULL" ? 1 : -1;

  const rets: { [h: number]: number } = {};
  for (const h of PATH_HORIZONS) {
    const fc = bars[sig.idx + h]?.close;
    if (fc === undefined) return null;
    rets[h] = sign * (fc - ref) / PIP;
  }

  let mfe5 = 0, mae5 = 0, mfe10 = 0, mae10 = 0;
  for (let h = 1; h <= MAX_H; h++) {
    const b = bars[sig.idx + h];
    if (!b) break;
    const fav = sign === 1 ? (b.high - ref) / PIP : (ref - b.low)  / PIP;
    const adv = sign === 1 ? (ref - b.low)  / PIP : (b.high - ref) / PIP;
    if (h <= 5)  { if (fav > mfe5)  mfe5  = fav; if (adv > mae5)  mae5  = adv; }
    if (h <= 10) { if (fav > mfe10) mfe10 = fav; if (adv > mae10) mae10 = adv; }
  }
  return { rets, mfe5, mae5, mfe10, mae10 };
}

// ── Eligible bar pools per ATR band ───────────────────────────────────

function buildBandPools(
  bars: Bar[], atr: (number|undefined)[], bounds: { p33: number; p66: number },
): Record<ATRBand, number[]> {
  const pools: Record<ATRBand, number[]> = { LOW: [], MID: [], HIGH: [] };
  for (let i = WARMUP; i < bars.length - MAX_H - 2; i++) {
    const a = atr[i];
    if (a === undefined) continue;
    const band: ATRBand = a < bounds.p33 ? "LOW" : a < bounds.p66 ? "MID" : "HIGH";
    pools[band].push(i);
  }
  return pools;
}

function drawVolMatchedPath(
  sig: Sig7B, pools: Record<ATRBand, number[]>, bars: Bar[], rng: () => number,
): PathOutcome | null {
  const pool = pools[sig.atrBand];
  if (pool.length === 0) return null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const idx = pool[Math.floor(rng() * pool.length)];
    const p = getPath({ ...sig, idx }, bars);
    if (p !== null) return p;
  }
  return null;
}

// ── Vol-matched random: N_RAND_RESAMPLES draws ─────────────────────────

interface RandDist {
  mean: number; med: number; p5: number; p95: number;
  sigRank: number;  // percentile rank of real signal among resamples
}

function volMatchedRandDist(
  sigs: Sig7B[], bars: Bar[], dir: Dir,
  pools: Record<ATRBand, number[]>,
  sigFavRate: number,  // real signal's favorable rate at primary horizon
  primaryH: number,
): RandDist {
  const rng     = seededRNG(42);
  const randFavRates: number[] = [];

  for (let resample = 0; resample < N_RAND_RESAMPLES; resample++) {
    const paths: PathOutcome[] = [];
    for (const sig of sigs) {
      const p = drawVolMatchedPath(sig, pools, bars, rng);
      if (p !== null) paths.push(p);
    }
    const fav = paths.filter(p => p.rets[primaryH] > 0).length;
    randFavRates.push(fav / Math.max(paths.length, 1) * 100);
  }

  const sorted = [...randFavRates].sort((a, b) => a - b);
  const mean = randFavRates.reduce((s, v) => s + v, 0) / randFavRates.length;
  const rank = sorted.filter(v => v <= sigFavRate).length / sorted.length * 100;
  return {
    mean,
    med:     calcMedian(randFavRates),
    p5:      calcPercentile(randFavRates, 5),
    p95:     calcPercentile(randFavRates, 95),
    sigRank: rank,
  };
}

// ── Hour-matched random ────────────────────────────────────────────────

function hourMatchedPaths(
  sigs: Sig7B[], bars: Bar[], dir: Dir,
  atrBounds: { p33: number; p66: number },
  atr: (number|undefined)[], seed: number,
): PathOutcome[] {
  // Build hour+band pools
  const hourBandPools: Map<string, number[]> = new Map();
  for (let i = WARMUP; i < bars.length - MAX_H - 2; i++) {
    const a = atr[i];
    if (a === undefined) continue;
    const band: ATRBand = a < atrBounds.p33 ? "LOW" : a < atrBounds.p66 ? "MID" : "HIGH";
    const hour = new Date(bars[i].time).getUTCHours();
    const key  = `${hour}_${band}`;
    if (!hourBandPools.has(key)) hourBandPools.set(key, []);
    hourBandPools.get(key)!.push(i);
  }

  const rng     = seededRNG(seed);
  const results: PathOutcome[] = [];

  for (const sig of sigs) {
    const key  = `${sig.hour}_${sig.atrBand}`;
    const pool = hourBandPools.get(key) ?? [];
    if (pool.length === 0) continue;
    for (let attempt = 0; attempt < 20; attempt++) {
      const idx = pool[Math.floor(rng() * pool.length)];
      const p = getPath({ ...sig, idx }, bars);
      if (p !== null) { results.push(p); break; }
    }
  }
  return results;
}

// ── IID bootstrap ──────────────────────────────────────────────────────

function iidBootstrap(
  favArr: boolean[],  // true = favorable at primary horizon
  randMean: number,
  seed: number,
): BootResult {
  const rng   = seededRNG(seed);
  const N     = favArr.length;
  const stats: number[] = [];
  let   pEdge = 0;

  for (let iter = 0; iter < N_BOOT; iter++) {
    let hits = 0;
    for (let j = 0; j < N; j++) {
      if (favArr[Math.floor(rng() * N)]) hits++;
    }
    const fav = hits / N * 100;
    stats.push(fav);
    if (fav > randMean) pEdge++;
  }
  stats.sort((a, b) => a - b);
  return {
    ci95lo:   calcPercentile(stats, 2.5),
    ci95hi:   calcPercentile(stats, 97.5),
    pEdgePos: pEdge / N_BOOT,
    bootMean: stats.reduce((s, v) => s + v, 0) / N_BOOT,
  };
}

// ── Block bootstrap ────────────────────────────────────────────────────

function blockBootstrap(
  sigs: Sig7B[], favArr: boolean[],
  blockSize: number, randMean: number, seed: number,
): BootResult {
  // Group into consecutive blocks of blockSize signal observations
  const nBlocks = Math.ceil(favArr.length / blockSize);
  const blocks: boolean[][] = [];
  for (let b = 0; b < nBlocks; b++) {
    blocks.push(favArr.slice(b * blockSize, (b + 1) * blockSize));
  }

  const rng   = seededRNG(seed);
  const N     = favArr.length;
  const stats: number[] = [];
  let   pEdge = 0;

  for (let iter = 0; iter < N_BOOT; iter++) {
    const drawn: boolean[] = [];
    while (drawn.length < N) {
      const b = blocks[Math.floor(rng() * blocks.length)];
      drawn.push(...b);
    }
    const sample = drawn.slice(0, N);
    const fav    = sample.filter(Boolean).length / N * 100;
    stats.push(fav);
    if (fav > randMean) pEdge++;
  }
  stats.sort((a, b) => a - b);
  return {
    ci95lo:   calcPercentile(stats, 2.5),
    ci95hi:   calcPercentile(stats, 97.5),
    pEdgePos: pEdge / N_BOOT,
    bootMean: stats.reduce((s, v) => s + v, 0) / N_BOOT,
  };
}

// ── Clustering analysis ────────────────────────────────────────────────

interface ClusterInfo {
  rawN:      number;
  eventN:    number;
  medGap:    number;
  p25Gap:    number;
  p75Gap:    number;
  pct5bar:   number;  // % signals within 5 bars of the previous one
}

function clusterAnalysis(sigs: Sig7B[]): ClusterInfo {
  if (sigs.length < 2) return { rawN: sigs.length, eventN: sigs.length, medGap: 0, p25Gap: 0, p75Gap: 0, pct5bar: 0 };

  const gaps: number[] = [];
  let within5 = 0;
  for (let i = 1; i < sigs.length; i++) {
    const gap = sigs[i].idx - sigs[i - 1].idx;
    gaps.push(gap);
    if (gap <= 5) within5++;
  }

  // Group events: signals within 5 bars of the previous form one event
  let events = 1;
  for (const g of gaps) if (g > 5) events++;

  return {
    rawN:    sigs.length,
    eventN:  events,
    medGap:  calcMedian(gaps),
    p25Gap:  calcPercentile(gaps, 25),
    p75Gap:  calcPercentile(gaps, 75),
    pct5bar: within5 / gaps.length * 100,
  };
}

// ── Temporal window ────────────────────────────────────────────────────

interface WindowStat {
  label:   string;
  n:       number;
  favRate: number;   // at primary horizon
  medRet:  number;
  class:   string;
}

function windowStat(
  label: string, sigs: Sig7B[], paths: Map<number, PathOutcome | null>,
  startMs: number, endMs: number, primaryH: number,
): WindowStat {
  const w = sigs.filter(s => {
    // We can't access bars directly here, so we check via the path map
    return true; // filter done below
  });
  // Actually filter by stored time — we'll pass bars time via sig.idx mapped to a time
  return {
    label, n: 0, favRate: 0, medRet: 0, class: "N/A",
  };
}

// Simpler approach: pass bars directly
function computeWindowStats(
  label: string, sigs: Sig7B[], paths: PathOutcome[],
  sigBarTimes: number[],   // bars[sig.idx].time for each sig (parallel array)
  startMs: number, endMs: number, primaryH: number,
): WindowStat {
  const indices = sigs.map((_, i) => i).filter(i => sigBarTimes[i] >= startMs && sigBarTimes[i] <= endMs);
  const n = indices.length;
  if (n === 0) return { label, n: 0, favRate: 0, medRet: 0, class: "INSUFFICIENT" };
  const favCount  = indices.filter(i => paths[i].rets[primaryH] > 0).length;
  const medRet    = calcMedian(indices.map(i => paths[i].rets[primaryH]));
  const cls       = n >= VALID_N ? "VALID" : n >= LOW_N ? "LOW_SAMPLE" : "INSUFFICIENT";
  return { label, n, favRate: favCount / n * 100, medRet, class: cls };
}

// ── Formatting ─────────────────────────────────────────────────────────

const f1  = (n: number) => n.toFixed(1);
const f2  = (n: number) => n.toFixed(2);
const f3  = (n: number) => n.toFixed(3);
const pct = (n: number) => n.toFixed(1) + "%";
const sgn = (n: number) => (n >= 0 ? "+" : "") + f1(n);
const EQ  = "═";

// ── Main analysis block ────────────────────────────────────────────────

interface CandidateReport {
  name:        string;
  tf:          string;
  primaryH:    number;
  sigs:        Sig7B[];
  paths:       PathOutcome[];
  cluster:     ClusterInfo;
  sigFavPrimary: number;
  randDist:    RandDist;
  iidBoot:     BootResult;
  blockBoot:   BootResult;
  hourExplained: boolean;
  classification: string;
}

async function analyzeCandidate(
  name: string, tf: string, primaryH: number,
  allSigs: Sig7B[], bars: Bar[], atr: (number|undefined)[],
  atrBounds: { p33: number; p66: number },
  blockSize: number,
): Promise<CandidateReport> {

  // Filter to BULL only for S4/S6
  const sigs  = allSigs.filter(s => s.dir === "BULL");
  const paths = sigs.map(s => getPath(s, bars)).filter((p): p is PathOutcome => p !== null);

  // Trim sigs to match non-null paths
  const validSigs: Sig7B[] = [];
  const validPaths: PathOutcome[] = [];
  sigs.forEach((s, i) => {
    const p = getPath(s, bars);
    if (p !== null) { validSigs.push(s); validPaths.push(p); }
  });

  console.log(`  ${name} [${tf}]: N=${validSigs.length} BULL signals`);

  // ── Favorable rate at primary horizon ──
  const favPrimary = validPaths.filter(p => p.rets[primaryH] > 0).length / validPaths.length * 100;

  // ── Clustering ──
  const cluster = clusterAnalysis(validSigs);
  console.log(`    Clustering: rawN=${cluster.rawN} eventN=${cluster.eventN} medGap=${f1(cluster.medGap)}bars ${pct(cluster.pct5bar)} within 5bars`);

  // ── Vol-matched random distribution ──
  const pools    = buildBandPools(bars, atr, atrBounds);
  const randDist = volMatchedRandDist(validSigs, bars, "BULL", pools, favPrimary, primaryH);
  console.log(`    RandDist: mean=${pct(randDist.mean)} P5=${pct(randDist.p5)} P95=${pct(randDist.p95)}  sigRank=${pct(randDist.sigRank)}`);

  // ── Hour distribution ──
  const hourCounts = new Map<number, number>();
  for (const s of validSigs) hourCounts.set(s.hour, (hourCounts.get(s.hour) ?? 0) + 1);
  const topHours = [...hourCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`    Hour concentration: top hours = ${topHours.map(([h, n]) => `${h}UTC(${n})`).join(", ")}`);

  // Hour-matched random
  const hourPaths = hourMatchedPaths(validSigs, bars, "BULL", atrBounds, atr, 43);
  const hourFavRate = hourPaths.filter(p => p.rets[primaryH] > 0).length / Math.max(hourPaths.length, 1) * 100;
  const hourExplained = Math.abs(favPrimary - hourFavRate) < 1.5;
  console.log(`    Hour-matched rand fav@${primaryH}bar: ${pct(hourFavRate)} (vs signal ${pct(favPrimary)}) → ${hourExplained ? "TIME_STRUCTURE_EXPLAINED" : "hour-matching doesn't explain edge"}`);

  // ── Bootstraps ──
  const favArr  = validPaths.map(p => p.rets[primaryH] > 0);
  const iidBoot = iidBootstrap(favArr, randDist.mean, 100);
  const blkBoot = blockBootstrap(validSigs, favArr, blockSize, randDist.mean, 200);
  console.log(`    IID boot 95%CI: [${pct(iidBoot.ci95lo)}, ${pct(iidBoot.ci95hi)}]  P(edge>0)=${f2(iidBoot.pEdgePos)}`);
  console.log(`    BLK boot 95%CI: [${pct(blkBoot.ci95lo)}, ${pct(blkBoot.ci95hi)}]  P(edge>0)=${f2(blkBoot.pEdgePos)}`);

  // ── Classification ──
  const edgeDelta = favPrimary - randDist.mean;
  const iidPass   = iidBoot.pEdgePos >= 0.80;
  const blkPass   = blkBoot.pEdgePos >= 0.80;
  const randRank  = randDist.sigRank;
  const sampleOk  = cluster.eventN >= LOW_N;

  const classification = (() => {
    if (!sampleOk) return "INCONCLUSIVE_LOW_SAMPLE";
    if (edgeDelta <= 0) return "NO_EDGE";
    if (hourExplained) return "TIME_STRUCTURE_EXPLAINED";
    if (edgeDelta < 2) return "NO_EDGE";
    if (!blkPass && !iidPass) return "NO_EDGE";
    if (edgeDelta >= 3 && blkPass && randRank >= 75) return "PROMISING_UNCONFIRMED";
    if (edgeDelta >= 2 && iidPass) return "PROMISING_UNCONFIRMED";
    return "TEMPORALLY_UNSTABLE";
  })();

  return {
    name, tf, primaryH, sigs: validSigs, paths: validPaths,
    cluster, sigFavPrimary: favPrimary, randDist,
    iidBoot, blockBoot: blkBoot, hourExplained, classification,
  };
}

// ── Print path table ───────────────────────────────────────────────────

function printPathTable(
  label: string, sigs: Sig7B[], paths: PathOutcome[],
  randPaths: PathOutcome[],
): void {
  console.log(`\n  ${label} — Path Analysis (bar-by-bar):`);
  console.log(`  ${"Horizon".padEnd(9)} ${"SigFav%".padStart(9)} ${"RandFav%".padStart(10)} ${"Δ%".padStart(7)} ${"SigMed".padStart(8)} ${"RandMed".padStart(9)} ${"MFE".padStart(7)} ${"MAE".padStart(7)}`);
  console.log("  " + "-".repeat(68));

  for (const h of PATH_HORIZONS) {
    const sr = paths.map(p => p.rets[h]);
    const rr = randPaths.map(p => p.rets[h]);
    const sFav = sr.filter(v => v > 0).length / sr.length * 100;
    const rFav = rr.filter(v => v > 0).length / Math.max(rr.length, 1) * 100;
    const sMed = calcMedian(sr);
    const rMed = calcMedian(rr);
    const mfe  = h <= 5  ? calcMedian(paths.map(p => p.mfe5))  : calcMedian(paths.map(p => p.mfe10));
    const mae  = h <= 5  ? calcMedian(paths.map(p => p.mae5))  : calcMedian(paths.map(p => p.mae10));
    const flag = sFav - rFav >= 4 ? " ◆" : sFav - rFav >= 2 ? " ▶" : sFav - rFav <= -3 ? " ✗" : "  ";
    console.log(
      `  ${("+" + h + " bar").padEnd(9)} ` +
      `${pct(sFav).padStart(9)} ${pct(rFav).padStart(10)} ` +
      `${sgn(sFav - rFav).padStart(7)} ` +
      `${f1(sMed).padStart(8)}p ${f1(rMed).padStart(8)}p ` +
      `${f1(mfe).padStart(7)} ${f1(mae).padStart(7)}` + flag,
    );
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 7-B: CANDIDATE EDGE CONFIRMATION" + " ".repeat(33) + "║");
  console.log("║  S4_INSIDE_BREAK_BULL  vs  S6_EXTENDED_MOVE_BULL" + " ".repeat(23) + "║");
  console.log("╚" + EQ.repeat(72) + "╝");
  console.log("\n  CASE: B — research-only. Signal definitions FROZEN from Phase 7-A.");
  console.log("  SELECTION_BIAS_PRESENT: YES (candidates chosen after Phase 7-A results)");
  console.log(`  Bootstrap: IID seed=100, Block seed=200, ${N_BOOT} iterations each`);
  console.log(`  Random resamples: ${N_RAND_RESAMPLES} × vol-matched (seed=42)`);

  // ── STEP 1: Data ──────────────────────────────────────────────────────
  console.log("\n[STEP 1] Fetching bar data & data audit...");
  const [h1Bars, h4Bars] = await Promise.all([fetchBars("H1"), fetchBars("H4")]);
  const h1ATR = calculateATR(h1Bars, ATR_PERIOD);
  const h4ATR = calculateATR(h4Bars, ATR_PERIOD);

  const h1Span = Math.round((h1Bars.at(-1)!.time - h1Bars[0].time) / 86_400_000);
  const h4Span = Math.round((h4Bars.at(-1)!.time - h4Bars[0].time) / 86_400_000);
  console.log(`  H1: ${h1Bars.length} bars  ${new Date(h1Bars[0].time).toISOString().slice(0,10)} → ${new Date(h1Bars.at(-1)!.time).toISOString().slice(0,10)}  (${h1Span}d) — DISCOVERY DATA`);
  console.log(`  H4: ${h4Bars.length} bars  ${new Date(h4Bars[0].time).toISOString().slice(0,10)} → ${new Date(h4Bars.at(-1)!.time).toISOString().slice(0,10)}  (${h4Span}d) — LONG-HISTORY`);
  console.log(`  TRUE_UNSEEN_CONFIRMATION: NO (Phase 7-A already checked H4 cross-check)`);

  // ── STEP 2: ATR boundaries ────────────────────────────────────────────
  console.log("\n[STEP 2] ATR band classification...");
  const s4H1Raw  = scanS4(h1Bars, h1ATR);
  const s6H1Raw  = scanS6(h1Bars, h1ATR);
  const s4H4Raw  = scanS4(h4Bars, h4ATR);
  const s6H4Raw  = scanS6(h4Bars, h4ATR);

  const s4H1BullATRs = s4H1Raw.filter(s => s.dir === "BULL").map(s => s.atr);
  const s6H1BullATRs = s6H1Raw.filter(s => s.dir === "BULL").map(s => s.atr);
  const s4H4BullATRs = s4H4Raw.filter(s => s.dir === "BULL").map(s => s.atr);
  const s6H4BullATRs = s6H4Raw.filter(s => s.dir === "BULL").map(s => s.atr);

  const s4H1Bounds = classifyATRRegime(s4H1BullATRs.map(v => v || undefined));
  const s6H1Bounds = classifyATRRegime(s6H1BullATRs.map(v => v || undefined));
  const s4H4Bounds = classifyATRRegime(s4H4BullATRs.map(v => v || undefined));
  const s6H4Bounds = classifyATRRegime(s6H4BullATRs.map(v => v || undefined));

  const s4H1Sigs = assignBands(s4H1Raw, s4H1Bounds);
  const s6H1Sigs = assignBands(s6H1Raw, s6H1Bounds);
  const s4H4Sigs = assignBands(s4H4Raw, s4H4Bounds);
  const s6H4Sigs = assignBands(s6H4Raw, s6H4Bounds);

  console.log(`  S4 H1 ATR bounds: P33=${f3(s4H1Bounds.p33/PIP)}p P66=${f3(s4H1Bounds.p66/PIP)}p`);
  console.log(`  S6 H1 ATR bounds: P33=${f3(s6H1Bounds.p33/PIP)}p P66=${f3(s6H1Bounds.p66/PIP)}p`);
  console.log(`  S4 H4 ATR bounds: P33=${f3(s4H4Bounds.p33/PIP)}p P66=${f3(s4H4Bounds.p66/PIP)}p`);
  console.log(`  S6 H4 ATR bounds: P33=${f3(s6H4Bounds.p33/PIP)}p P66=${f3(s6H4Bounds.p66/PIP)}p`);

  // ── STEP 3: S4 H1 analysis ────────────────────────────────────────────
  console.log("\n" + EQ.repeat(74));
  console.log("[STEP 3] S4_INSIDE_BREAK BULL — H1 (DISCOVERY DATA)");
  console.log(EQ.repeat(74));
  const s4H1Report = await analyzeCandidate(
    "S4_INSIDE_BREAK", "H1", S4_PRIMARY_H,
    s4H1Sigs, h1Bars, h1ATR, s4H1Bounds, BLOCK_H1,
  );

  // S4 H1 path table
  const s4H1BullSigs = s4H1Sigs.filter(s => s.dir === "BULL");
  const s4H1BullPaths = s4H1BullSigs.map(s => getPath(s, h1Bars)).filter((p): p is PathOutcome => p !== null);
  const validS4H1 = s4H1BullSigs.filter((_, i) => getPath(s4H1BullSigs[i], h1Bars) !== null);
  const s4H1RandPaths: PathOutcome[] = [];
  {
    const pools = buildBandPools(h1Bars, h1ATR, s4H1Bounds);
    const rng   = seededRNG(42);
    for (const sig of validS4H1) {
      const p = drawVolMatchedPath(sig, pools, h1Bars, rng);
      if (p) s4H1RandPaths.push(p);
    }
  }
  printPathTable("S4 BULL H1", validS4H1, s4H1BullPaths, s4H1RandPaths);

  // ── S4 H1 temporal windows ──
  console.log(`\n  S4 H1 Temporal Windows:`);
  const s4H1Times = validS4H1.map(s => h1Bars[s.idx].time);
  const h1T0 = h1Bars[0].time, h1TN = h1Bars.at(-1)!.time;
  const h1Mid = (h1T0 + h1TN) / 2;
  const DAY   = 86_400_000;

  const s4H1Periods = [
    { label: "FIRST_HALF",  s: h1T0, e: h1Mid },
    { label: "SECOND_HALF", s: h1Mid, e: h1TN },
    { label: "2025", s: new Date("2025-01-01Z").getTime(), e: new Date("2025-12-31T23:59Z").getTime() },
    { label: "2026", s: new Date("2026-01-01Z").getTime(), e: h1TN },
  ];

  console.log(`  ${"Period".padEnd(14)} ${"N".padStart(5)} ${"Fav%".padStart(8)} ${"medRet".padStart(9)} ${"Class".padStart(14)}`);
  console.log("  " + "-".repeat(55));
  for (const p of s4H1Periods) {
    const idxs = validS4H1.map((_, i) => i).filter(i => s4H1Times[i] >= p.s && s4H1Times[i] <= p.e);
    const n = idxs.length;
    if (n < 5) { console.log(`  ${p.label.padEnd(14)} ${String(n).padStart(5)}  [INSUFFICIENT]`); continue; }
    const fav = idxs.filter(i => s4H1BullPaths[i].rets[S4_PRIMARY_H] > 0).length / n * 100;
    const med = calcMedian(idxs.map(i => s4H1BullPaths[i].rets[S4_PRIMARY_H]));
    const cls = n >= VALID_N ? "VALID" : n >= LOW_N ? "LOW_SAMPLE" : "INSUFFICIENT";
    console.log(`  ${p.label.padEnd(14)} ${String(n).padStart(5)} ${pct(fav).padStart(8)} ${f1(med).padStart(8)}p ${cls.padStart(14)}`);
  }

  // ── STEP 4: S4 H4 analysis ────────────────────────────────────────────
  console.log("\n" + EQ.repeat(74));
  console.log("[STEP 4] S4_INSIDE_BREAK BULL — H4 (LONG-HISTORY 2020-2026)");
  console.log(EQ.repeat(74));
  const s4H4Report = await analyzeCandidate(
    "S4_INSIDE_BREAK", "H4", S4_PRIMARY_H,
    s4H4Sigs, h4Bars, h4ATR, s4H4Bounds, BLOCK_H4,
  );

  const s4H4BullSigs = s4H4Sigs.filter(s => s.dir === "BULL");
  const s4H4BullPaths = s4H4BullSigs.map(s => getPath(s, h4Bars)).filter((p): p is PathOutcome => p !== null);
  const validS4H4 = s4H4BullSigs.filter((_, i) => getPath(s4H4BullSigs[i], h4Bars) !== null);
  const s4H4RandPaths: PathOutcome[] = [];
  {
    const pools = buildBandPools(h4Bars, h4ATR, s4H4Bounds);
    const rng   = seededRNG(42);
    for (const sig of validS4H4) {
      const p = drawVolMatchedPath(sig, pools, h4Bars, rng);
      if (p) s4H4RandPaths.push(p);
    }
  }
  printPathTable("S4 BULL H4", validS4H4, s4H4BullPaths, s4H4RandPaths);

  // S4 H4 yearly
  console.log(`\n  S4 H4 Yearly Windows:`);
  const s4H4Times = validS4H4.map(s => h4Bars[s.idx].time);
  const h4T0 = h4Bars[0].time, h4TN = h4Bars.at(-1)!.time;
  const h4Mid = (h4T0 + h4TN) / 2;

  const s4H4Years: Array<{ label: string; s: number; e: number }> = [
    { label: "FIRST_HALF",  s: h4T0, e: h4Mid },
    { label: "SECOND_HALF", s: h4Mid, e: h4TN },
  ];
  const startY = new Date(h4T0).getUTCFullYear();
  const endY   = new Date(h4TN).getUTCFullYear();
  for (let y = startY; y <= endY; y++) {
    s4H4Years.push({ label: String(y), s: new Date(`${y}-01-01Z`).getTime(), e: new Date(`${y}-12-31T23:59Z`).getTime() });
  }

  console.log(`  ${"Period".padEnd(14)} ${"N".padStart(5)} ${"Fav%".padStart(8)} ${"medRet".padStart(9)} ${"Class".padStart(14)}`);
  console.log("  " + "-".repeat(55));
  for (const p of s4H4Years) {
    const idxs = validS4H4.map((_, i) => i).filter(i => s4H4Times[i] >= p.s && s4H4Times[i] <= p.e);
    const n = idxs.length;
    if (n < 5) { console.log(`  ${p.label.padEnd(14)} ${String(n).padStart(5)}  [INSUFFICIENT]`); continue; }
    const fav = idxs.filter(i => s4H4BullPaths[i].rets[S4_PRIMARY_H] > 0).length / n * 100;
    const med = calcMedian(idxs.map(i => s4H4BullPaths[i].rets[S4_PRIMARY_H]));
    const cls = n >= VALID_N ? "VALID" : n >= LOW_N ? "LOW_SAMPLE" : "INSUFFICIENT";
    console.log(`  ${p.label.padEnd(14)} ${String(n).padStart(5)} ${pct(fav).padStart(8)} ${f1(med).padStart(8)}p ${cls.padStart(14)}`);
  }

  // ── STEP 5: S6 H1 analysis ────────────────────────────────────────────
  console.log("\n" + EQ.repeat(74));
  console.log("[STEP 5] S6_EXTENDED_MOVE BULL — H1 (DISCOVERY DATA)");
  console.log("[STEP 5] Market bias falsification: S6 BULL vs vol-matched random LONG");
  console.log(EQ.repeat(74));
  const s6H1Report = await analyzeCandidate(
    "S6_EXTENDED_MOVE", "H1", S6_PRIMARY_H,
    s6H1Sigs, h1Bars, h1ATR, s6H1Bounds, BLOCK_H1,
  );

  const s6H1BullSigs = s6H1Sigs.filter(s => s.dir === "BULL");
  const s6H1BullPaths = s6H1BullSigs.map(s => getPath(s, h1Bars)).filter((p): p is PathOutcome => p !== null);
  const validS6H1 = s6H1BullSigs.filter((_, i) => getPath(s6H1BullSigs[i], h1Bars) !== null);
  const s6H1RandPaths: PathOutcome[] = [];
  {
    const pools = buildBandPools(h1Bars, h1ATR, s6H1Bounds);
    const rng   = seededRNG(42);
    for (const sig of validS6H1) {
      const p = drawVolMatchedPath(sig, pools, h1Bars, rng);
      if (p) s6H1RandPaths.push(p);
    }
  }
  printPathTable("S6 BULL H1", validS6H1, s6H1BullPaths, s6H1RandPaths);

  // S6 market bias: compare signal vs uncond LONG (same ATR bucket)
  const s6H1Pools = buildBandPools(h1Bars, h1ATR, s6H1Bounds);
  const allLongRandPaths: PathOutcome[] = [];
  {
    const rng = seededRNG(42);
    for (const sig of validS6H1) {
      const pool = s6H1Pools[sig.atrBand];
      if (pool.length === 0) continue;
      const idx = pool[Math.floor(rng() * pool.length)];
      const p = getPath({ ...sig, idx, dir: "BULL" }, h1Bars);
      if (p) allLongRandPaths.push(p);
    }
  }
  const allLongFav10 = allLongRandPaths.filter(p => p.rets[10] > 0).length / Math.max(allLongRandPaths.length, 1) * 100;
  const s6BiasDelta  = (s6H1Report.sigFavPrimary - allLongFav10);
  console.log(`\n  S6 Market Bias Falsification:`);
  console.log(`    S6 BULL signal 10-bar fav: ${pct(s6H1Report.sigFavPrimary)}`);
  console.log(`    Vol-matched random LONG 10-bar fav: ${pct(allLongFav10)}`);
  console.log(`    Signal-specific edge above random LONG: ${sgn(s6BiasDelta)}`);
  const s6MarketBias = Math.abs(s6BiasDelta) < 2.0 ? "MARKET_BIAS_ONLY" : s6BiasDelta > 0 ? "PARTIAL — retains signal edge" : "UNDERPERFORMS_RANDOM";
  console.log(`    Verdict: ${s6MarketBias}`);

  // S6 H1 temporal
  console.log(`\n  S6 H1 Temporal Windows:`);
  const s6H1Times = validS6H1.map(s => h1Bars[s.idx].time);
  const s6H1Periods = [
    { label: "FIRST_HALF",  s: h1T0, e: h1Mid },
    { label: "SECOND_HALF", s: h1Mid, e: h1TN },
    { label: "2025", s: new Date("2025-01-01Z").getTime(), e: new Date("2025-12-31T23:59Z").getTime() },
    { label: "2026", s: new Date("2026-01-01Z").getTime(), e: h1TN },
  ];
  console.log(`  ${"Period".padEnd(14)} ${"N".padStart(5)} ${"Fav%".padStart(8)} ${"medRet".padStart(9)} ${"Class".padStart(14)}`);
  console.log("  " + "-".repeat(55));
  for (const p of s6H1Periods) {
    const idxs = validS6H1.map((_, i) => i).filter(i => s6H1Times[i] >= p.s && s6H1Times[i] <= p.e);
    const n = idxs.length;
    if (n < 5) { console.log(`  ${p.label.padEnd(14)} ${String(n).padStart(5)}  [INSUFFICIENT]`); continue; }
    const fav = idxs.filter(i => s6H1BullPaths[i].rets[S6_PRIMARY_H] > 0).length / n * 100;
    const med = calcMedian(idxs.map(i => s6H1BullPaths[i].rets[S6_PRIMARY_H]));
    const cls = n >= VALID_N ? "VALID" : n >= LOW_N ? "LOW_SAMPLE" : "INSUFFICIENT";
    console.log(`  ${p.label.padEnd(14)} ${String(n).padStart(5)} ${pct(fav).padStart(8)} ${f1(med).padStart(8)}p ${cls.padStart(14)}`);
  }

  // ── STEP 6: S6 H4 analysis ────────────────────────────────────────────
  console.log("\n" + EQ.repeat(74));
  console.log("[STEP 6] S6_EXTENDED_MOVE BULL — H4 (LONG-HISTORY 2020-2026)");
  console.log(EQ.repeat(74));
  const s6H4Report = await analyzeCandidate(
    "S6_EXTENDED_MOVE", "H4", S6_PRIMARY_H,
    s6H4Sigs, h4Bars, h4ATR, s6H4Bounds, BLOCK_H4,
  );

  // ── STEP 7: Summary table ──────────────────────────────────────────────
  console.log("\n[STEP 7] SUMMARY TABLE");
  console.log(EQ.repeat(74));

  const summaryRows = [s4H1Report, s4H4Report, s6H1Report, s6H4Report];
  console.log(`\n  ${"Candidate+TF".padEnd(26)} ${"RawN".padStart(6)} ${"EvtN".padStart(6)} ${"PrmH".padStart(5)} ${"SigFav".padStart(8)} ${"RandMn".padStart(8)} ${"SigSpEdge".padStart(11)} ${"RndPrctl".padStart(10)} ${"P(e>0)IID".padStart(11)} ${"P(e>0)BLK".padStart(11)} ${"Class".padStart(26)}`);
  console.log("  " + "-".repeat(145));
  for (const r of summaryRows) {
    const ssEdge = r.sigFavPrimary - r.randDist.mean;
    console.log(
      `  ${(r.name + " " + r.tf).padEnd(26)} ` +
      `${String(r.cluster.rawN).padStart(6)} ` +
      `${String(r.cluster.eventN).padStart(6)} ` +
      `${String(r.primaryH).padStart(5)} ` +
      `${pct(r.sigFavPrimary).padStart(8)} ` +
      `${pct(r.randDist.mean).padStart(8)} ` +
      `${sgn(ssEdge).padStart(11)} ` +
      `${pct(r.randDist.sigRank).padStart(10)} ` +
      `${f2(r.iidBoot.pEdgePos).padStart(11)} ` +
      `${f2(r.blockBoot.pEdgePos).padStart(11)} ` +
      `${r.classification.padStart(26)}`,
    );
  }

  // ── H1/H4 confirmation ──
  console.log(`\n  H1/H4 Directional Confirmation:`);
  const s4H1Edge = s4H1Report.sigFavPrimary - s4H1Report.randDist.mean;
  const s4H4Edge = s4H4Report.sigFavPrimary - s4H4Report.randDist.mean;
  const s6H1Edge = s6H1Report.sigFavPrimary - s6H1Report.randDist.mean;
  const s6H4Edge = s6H4Report.sigFavPrimary - s6H4Report.randDist.mean;
  const s4Confirmed = s4H1Edge > 0 && s4H4Edge > 0;
  const s6Confirmed = s6H1Edge > 0 && s6H4Edge > 0;
  console.log(`    S4: H1 edge=${sgn(s4H1Edge)} H4 edge=${sgn(s4H4Edge)} → ${s4Confirmed ? "BOTH POSITIVE (H1+H4 support)" : "NOT CONFIRMED"}`);
  console.log(`    S6: H1 edge=${sgn(s6H1Edge)} H4 edge=${sgn(s6H4Edge)} → ${s6Confirmed ? "BOTH POSITIVE (H1+H4 support)" : "NOT CONFIRMED"}`);

  // ── STEP 8: Final classification ──────────────────────────────────────
  console.log("\n[STEP 8] Final Classification");
  console.log(EQ.repeat(74));

  // S4 path structure
  const s4PathMed = PATH_HORIZONS.map(h => calcMedian(s4H1BullPaths.map(p => p.rets[h])));
  const s4PathRandMed = PATH_HORIZONS.map(h => calcMedian(s4H1RandPaths.map(p => p.rets[h])));
  const s4Pullback = s4PathMed[0] < 0;  // +1bar negative
  const s4Recovery = s4PathMed[3] > 0;  // +5bar positive
  const s4PathStructure = s4Pullback && s4Recovery ? "PULLBACK_THEN_CONTINUATION"
    : !s4Pullback && s4Recovery                    ? "IMMEDIATE_CONTINUATION"
    : s4PathMed.every(v => v < 0)                  ? "REVERSAL"
    : "NONE";
  console.log(`  S4 Path structure: ${s4PathStructure}`);
  console.log(`    Med returns: ${PATH_HORIZONS.map((h, i) => `+${h}=${f1(s4PathMed[i])}p`).join("  ")}`);
  console.log(`    Rand  rets:  ${PATH_HORIZONS.map((h, i) => `+${h}=${f1(s4PathRandMed[i])}p`).join("  ")}`);

  console.log(`\n  Temporal stability:`);
  const s4H1FirIdx  = validS4H1.map((_, i) => i).filter(i => h1Bars[validS4H1[i].idx].time <= h1Mid);
  const s4H1SecIdx  = validS4H1.map((_, i) => i).filter(i => h1Bars[validS4H1[i].idx].time > h1Mid);
  const s4FirFav    = s4H1FirIdx.filter(i => s4H1BullPaths[i]?.rets[S4_PRIMARY_H] > 0).length / Math.max(s4H1FirIdx.length, 1) * 100;
  const s4SecFav    = s4H1SecIdx.filter(i => s4H1BullPaths[i]?.rets[S4_PRIMARY_H] > 0).length / Math.max(s4H1SecIdx.length, 1) * 100;
  const s4Stable    = Math.abs(s4FirFav - s4SecFav) < 8 && s4H1FirIdx.length >= LOW_N;
  console.log(`    S4 H1: first-half ${pct(s4FirFav)} (N=${s4H1FirIdx.length}) / second-half ${pct(s4SecFav)} (N=${s4H1SecIdx.length}) → ${s4Stable ? "STABLE" : "UNSTABLE"}`);

  const s6H1FirIdx  = validS6H1.map((_, i) => i).filter(i => h1Bars[validS6H1[i].idx].time <= h1Mid);
  const s6H1SecIdx  = validS6H1.map((_, i) => i).filter(i => h1Bars[validS6H1[i].idx].time > h1Mid);
  const s6FirFav    = s6H1FirIdx.filter(i => s6H1BullPaths[i]?.rets[S6_PRIMARY_H] > 0).length / Math.max(s6H1FirIdx.length, 1) * 100;
  const s6SecFav    = s6H1SecIdx.filter(i => s6H1BullPaths[i]?.rets[S6_PRIMARY_H] > 0).length / Math.max(s6H1SecIdx.length, 1) * 100;
  const s6Stable    = Math.abs(s6FirFav - s6SecFav) < 8 && s6H1FirIdx.length >= LOW_N;
  console.log(`    S6 H1: first-half ${pct(s6FirFav)} (N=${s6H1FirIdx.length}) / second-half ${pct(s6SecFav)} (N=${s6H1SecIdx.length}) → ${s6Stable ? "STABLE" : "UNSTABLE"}`);

  // ── FINAL REPORT ──────────────────────────────────────────────────────
  const s4FinalClass = (() => {
    const ed = s4H1Report.sigFavPrimary - s4H1Report.randDist.mean;
    if (ed <= 0) return "NO_EDGE";
    if (s4H1Report.hourExplained) return "TIME_STRUCTURE_EXPLAINED";
    if (!s4Confirmed) return "NO_EDGE";
    if (s4H1Report.blockBoot.pEdgePos >= 0.80 && s4Stable) return "PROMISING_UNCONFIRMED";
    if (ed > 0 && s4Confirmed) return "TEMPORALLY_UNSTABLE";
    return "NO_EDGE";
  })();

  const s6FinalClass = s6MarketBias === "MARKET_BIAS_ONLY" ? "MARKET_BIAS_ONLY"
    : s6H1Report.blockBoot.pEdgePos >= 0.80 && s6Confirmed ? "PROMISING_UNCONFIRMED"
    : "NO_EDGE";

  const bestSurviving = s4FinalClass === "PROMISING_UNCONFIRMED" ? "S4"
    : s6FinalClass === "PROMISING_UNCONFIRMED" ? "S6"
    : "NONE";

  console.log("\n╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 7-B FINAL REPORT" + " ".repeat(49) + "║");
  console.log("╠" + EQ.repeat(72) + "╣");
  const L = (lbl: string, val: string) => {
    const c = `  ${lbl.padEnd(38)} ${val}`;
    console.log(`║${c.padEnd(72)}║`);
  };
  L("PHASE 7-B:", "COMPLETE");
  L("TRUE UNSEEN CONFIRMATION:", "NO — Phase 7-A already used H4 data");
  L("SELECTION_BIAS_PRESENT:", "YES — candidates chosen post Phase 7-A");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("PRIMARY CANDIDATE:", "S4_INSIDE_BREAK_BULL");
  L("S4 PRIMARY HORIZON:", `${S4_PRIMARY_H}-bar (DISCOVERY_SELECTED_HORIZON)`);
  L("S4 H1 — Signal Fav%:", `${pct(s4H1Report.sigFavPrimary)} (N=${s4H1Report.cluster.rawN})`);
  L("S4 H1 — RandMean Fav%:", pct(s4H1Report.randDist.mean));
  L("S4 H1 — Signal-Specific Edge:", sgn(s4H1Report.sigFavPrimary - s4H1Report.randDist.mean));
  L("S4 H1 — Rand Percentile:", pct(s4H1Report.randDist.sigRank));
  L("S4 H1 — IID Boot 95%CI:", `[${pct(s4H1Report.iidBoot.ci95lo)}, ${pct(s4H1Report.iidBoot.ci95hi)}]`);
  L("S4 H1 — Block Boot 95%CI:", `[${pct(s4H1Report.blockBoot.ci95lo)}, ${pct(s4H1Report.blockBoot.ci95hi)}]`);
  L("S4 H1 — P(edge>0) IID:", f2(s4H1Report.iidBoot.pEdgePos));
  L("S4 H1 — P(edge>0) Block:", f2(s4H1Report.blockBoot.pEdgePos));
  L("S4 H4 — Signal-Specific Edge:", sgn(s4H4Report.sigFavPrimary - s4H4Report.randDist.mean));
  L("S4 H4 — P(edge>0) Block:", f2(s4H4Report.blockBoot.pEdgePos));
  L("S4 H1/H4 Confirmation:", s4Confirmed ? "PASS (both positive)" : "FAIL");
  L("S4 Block Bootstrap:", s4H1Report.blockBoot.pEdgePos >= 0.80 ? "PASS" : "FAIL");
  L("S4 Temporal Stability:", s4Stable ? "PASS" : "FAIL (2025/2026 diverge)");
  L("S4 Path Structure:", s4PathStructure);
  L("S4 CLASSIFICATION:", s4FinalClass);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("SECONDARY CANDIDATE:", "S6_EXTENDED_MOVE_BULL");
  L("S6 PRIMARY HORIZON:", `${S6_PRIMARY_H}-bar (DISCOVERY_SELECTED_HORIZON)`);
  L("S6 H1 — Signal-Specific Edge:", sgn(s6H1Report.sigFavPrimary - s6H1Report.randDist.mean));
  L("S6 H4 — Signal-Specific Edge:", sgn(s6H4Report.sigFavPrimary - s6H4Report.randDist.mean));
  L("S6 Market Bias:", s6MarketBias);
  L("S6 H1/H4 Confirmation:", s6Confirmed ? "PASS" : "FAIL");
  L("S6 Block Bootstrap H1:", f2(s6H1Report.blockBoot.pEdgePos));
  L("S6 Temporal Stability:", s6Stable ? "PASS" : "FAIL");
  L("S6 CLASSIFICATION:", s6FinalClass);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("BEST SURVIVING RAW EDGE:", bestSurviving);
  L("RAW EDGE READY FOR STRATEGY:", bestSurviving !== "NONE" ? "CONDITIONAL — see next" : "NO");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("ENGINE FILES CHANGED:", "NO");
  L("PRODUCTION DEFAULTS CHANGED:", "NO");
  L("PRODUCTION STRATEGY CREATED:", "NO");
  L("LIVE TRADING:", "NOT ENABLED");
  console.log("╠" + EQ.repeat(72) + "╣");
  const next = bestSurviving === "S4"
    ? "Phase 7-C: S4 Economic Translation — convert raw edge to fixed entry/exit hypothesis"
    : bestSurviving === "S6"
    ? "S6 requires additional unseen data confirmation before strategy design"
    : "Both candidates fail. Phase 7 price-pattern family TERMINATED. Design fundamentally different research family.";
  L("NEXT:", next);
  console.log("╚" + EQ.repeat(72) + "╝");
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });

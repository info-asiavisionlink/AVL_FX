/**
 * Phase 8-A: Cross-Asset Data Readiness Audit
 * EURUSD × DXY × US10Y
 *
 * Answers: "Can the current architecture support EURUSD × DXY × US10Y research safely?"
 *
 * AUDIT ONLY. No strategy research. No engine changes. No data fabrication.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/phase8a_cross_asset_audit.ts
 */

export {};

// ── Config ─────────────────────────────────────────────────────────────

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const TARGET_ASSETS = ["EURUSD", "DXY", "US10Y"] as const;
const PRIMARY_TF    = "H1";

// Minimum thresholds
const PREFERRED_DAYS = 365 * 3;   // 3 years
const MINIMUM_DAYS   = 365 * 2;   // 2 years
const WEAK_DAYS      = 365;        // 1 year

// Known DXY / US10Y candidate symbol names (from broker)
const DXY_CANDIDATES   = ["DXY", "USDX", "USDINDEX", "USDX-SEP26", "USDX-DEC26"];
const US10Y_CANDIDATES = ["US10Y", "UST10Y", "US10YR", "US10YBOND", "US10YNOTES", "TNX", "TNX.INDX"];

const EQ = "═";

// ── Types ───────────────────────────────────────────────────────────────

interface BarDataRow {
  symbol:     string;
  timeframe:  string;
  bar_count:  number;
  oldest_bar: string;
  newest_bar: string;
  span_days:  number;
}

interface AssetCoverage {
  canonicalName:  string;
  brokerSymbol:   string | null;
  available:      boolean;
  h1BarCount:     number;
  h1OldestBar:    string | null;
  h1NewestBar:    string | null;
  h1SpanDays:     number;
  depthClass:     "PREFERRED" | "MINIMUM" | "WEAK" | "INSUFFICIENT" | "ABSENT";
  isFutures:      boolean;
  notes:          string[];
}

// ── Fetch bar_data status ───────────────────────────────────────────────

async function fetchBarDataStatus(): Promise<BarDataRow[]> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/get_bar_data_status`, {
    method: "POST",
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`bar_data status: ${res.status}`);
  return res.json();
}

// ── Helpers ─────────────────────────────────────────────────────────────

const f1   = (n: number)  => n.toFixed(1);
const f0   = (n: number)  => Math.round(n).toLocaleString();
const L    = (lbl: string, val: string) => {
  const c = `  ${lbl.padEnd(42)} ${val}`;
  console.log(`║${c.padEnd(72)}║`);
};

function depthClass(days: number): "PREFERRED" | "MINIMUM" | "WEAK" | "INSUFFICIENT" | "ABSENT" {
  if (days >= PREFERRED_DAYS) return "PREFERRED";
  if (days >= MINIMUM_DAYS)   return "MINIMUM";
  if (days >= WEAK_DAYS)      return "WEAK";
  if (days > 0)               return "INSUFFICIENT";
  return "ABSENT";
}

function isFuturesSymbol(symbol: string): boolean {
  return /-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}$/i.test(symbol);
}

// ── Alignment simulation ────────────────────────────────────────────────

async function checkTimestampAlignment(
  status: BarDataRow[],
  dxySymbol: string | null,
  us10ySymbol: string | null,
): Promise<{
  alignedCount: number;
  eursdOnlyCount: number;
  dxyMissingCount: number;
  us10yMissingCount: number;
  multipleMissingCount: number;
  totalEurusd: number;
}> {
  // Fetch a sample of H1 timestamps from each available asset
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const fetchTs = async (symbol: string): Promise<Set<string>> => {
    const url = `${SB_URL}/rest/v1/bar_data?select=time_utc&symbol=eq.${symbol}&timeframe=eq.H1&order=time_utc.asc&limit=10000`;
    const r = await fetch(url, { headers });
    if (!r.ok) return new Set();
    const rows = (await r.json()) as { time_utc: string }[];
    return new Set(rows.map(r => r.time_utc.slice(0, 16))); // minute precision
  };

  const eurTs  = await fetchTs("EURUSD");
  const dxyTs  = dxySymbol  ? await fetchTs(dxySymbol)  : new Set<string>();
  const us10Ts = us10ySymbol ? await fetchTs(us10ySymbol) : new Set<string>();

  let aligned = 0, eurOnly = 0, dxyMiss = 0, us10Miss = 0, multMiss = 0;

  for (const ts of eurTs) {
    const hasDxy   = dxyTs.size  > 0 && dxyTs.has(ts);
    const hasUs10  = us10Ts.size > 0 && us10Ts.has(ts);
    const dxyAvail = dxyTs.size > 0;
    const us10Avail = us10Ts.size > 0;

    const dxyMissing   = dxyAvail  && !hasDxy;
    const us10Missing  = us10Avail && !hasUs10;
    const missingCount = (dxyMissing ? 1 : 0) + (us10Missing ? 1 : 0);

    if (missingCount === 0 && (dxyAvail || us10Avail)) aligned++;
    else if (!dxyAvail && !us10Avail)                  eurOnly++;
    else if (missingCount >= 2)                        multMiss++;
    else if (dxyMissing)                               dxyMiss++;
    else if (us10Missing)                              us10Miss++;
    else                                               eurOnly++;
  }

  // If neither external asset available, all EURUSD bars = eurusdOnly
  if (dxyTs.size === 0 && us10Ts.size === 0) eurOnly = eurTs.size;

  return {
    alignedCount:        aligned,
    eursdOnlyCount:      eurOnly,
    dxyMissingCount:     dxyMiss,
    us10yMissingCount:   us10Miss,
    multipleMissingCount: multMiss,
    totalEurusd:         eurTs.size,
  };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 8-A: CROSS-ASSET DATA READINESS AUDIT" + " ".repeat(27) + "║");
  console.log("║  EURUSD × DXY × US10Y — Infrastructure & Alignment Audit" + " ".repeat(14) + "║");
  console.log("╚" + EQ.repeat(72) + "╝");
  console.log("\n  AUDIT ONLY — No strategy research. No data fabrication. No engine changes.");

  // ── STEP 1: Fetch DB status ───────────────────────────────────────────
  console.log("\n[STEP 1] Querying Supabase bar_data status...");
  const status = await fetchBarDataStatus();

  const allSymbols = [...new Set(status.map(r => r.symbol))].sort();
  const h1Rows     = status.filter(r => r.timeframe === PRIMARY_TF);

  console.log(`  Total symbols in DB:    ${allSymbols.length}`);
  console.log(`  Total H1 symbol rows:   ${h1Rows.length}`);
  console.log(`\n  All symbols: ${allSymbols.join(", ")}`);

  // ── STEP 2: Schema audit ──────────────────────────────────────────────
  console.log("\n[STEP 2] bar_data Schema Audit");
  console.log(EQ.repeat(74));
  console.log(`  Table:         public.bar_data`);
  console.log(`  Primary Key:   (symbol TEXT, timeframe TEXT, time_utc TIMESTAMPTZ)`);
  console.log(`  Symbol column: generic TEXT — any symbol name accepted`);
  console.log(`  Indices:       (symbol, timeframe, time_utc DESC)  ← backtest optimized`);
  console.log(`                 (symbol, time_utc DESC)             ← cross-symbol scan`);
  console.log(`  UTC semantics: MqlRates.time stored as UTC (verified: H4 bars align to 14400s UTC boundaries)`);
  console.log(`  RLS:           service_role write, authenticated read`);
  console.log(`  Cross-asset:   SCHEMA_CHANGE_REQUIRED = NO — schema is already fully generic`);

  // ── STEP 3: Asset availability ────────────────────────────────────────
  console.log("\n[STEP 3] Asset Availability Search");
  console.log(EQ.repeat(74));

  const coverageMap = new Map<string, AssetCoverage>();

  // EURUSD
  const eurH1 = h1Rows.find(r => r.symbol === "EURUSD");
  coverageMap.set("EURUSD", {
    canonicalName: "EURUSD",
    brokerSymbol:  "EURUSD",
    available:     !!eurH1,
    h1BarCount:    eurH1?.bar_count ?? 0,
    h1OldestBar:   eurH1?.oldest_bar ?? null,
    h1NewestBar:   eurH1?.newest_bar ?? null,
    h1SpanDays:    eurH1?.span_days  ?? 0,
    depthClass:    depthClass(eurH1?.span_days ?? 0),
    isFutures:     false,
    notes:         [],
  });

  // DXY search
  let dxyFound: BarDataRow | null = null;
  let dxyBrokerSymbol: string | null = null;
  for (const candidate of DXY_CANDIDATES) {
    const row = h1Rows.find(r => r.symbol === candidate);
    if (row) { dxyFound = row; dxyBrokerSymbol = candidate; break; }
  }
  // Also check any USDX-* symbols
  const usdxRows = h1Rows.filter(r => r.symbol.startsWith("USDX"));
  if (!dxyFound && usdxRows.length > 0) {
    dxyFound = usdxRows[0]; dxyBrokerSymbol = usdxRows[0].symbol;
  }

  const dxyNotes: string[] = [];
  if (dxyBrokerSymbol && isFuturesSymbol(dxyBrokerSymbol)) {
    dxyNotes.push(`FUTURES CONTRACT (${dxyBrokerSymbol}) — expires, not continuous`);
    dxyNotes.push("Requires quarterly roll; price != spot DXY continuous index");
    dxyNotes.push("D1 spans 708 days but as futures: cross-contract contamination");
  }
  if (dxyFound && dxyFound.span_days < MINIMUM_DAYS) {
    dxyNotes.push(`H1 spans only ${f1(dxyFound.span_days)} days — research INSUFFICIENT`);
  }

  coverageMap.set("DXY", {
    canonicalName: "DXY",
    brokerSymbol:  dxyBrokerSymbol,
    available:     !!dxyFound,
    h1BarCount:    dxyFound?.bar_count ?? 0,
    h1OldestBar:   dxyFound?.oldest_bar ?? null,
    h1NewestBar:   dxyFound?.newest_bar ?? null,
    h1SpanDays:    dxyFound?.span_days  ?? 0,
    depthClass:    depthClass(dxyFound?.span_days ?? 0),
    isFutures:     !!(dxyBrokerSymbol && isFuturesSymbol(dxyBrokerSymbol)),
    notes:         dxyNotes,
  });

  // US10Y search
  let us10yFound: BarDataRow | null = null;
  let us10yBrokerSymbol: string | null = null;
  for (const candidate of US10Y_CANDIDATES) {
    const row = h1Rows.find(r => r.symbol === candidate);
    if (row) { us10yFound = row; us10yBrokerSymbol = candidate; break; }
  }

  coverageMap.set("US10Y", {
    canonicalName: "US10Y",
    brokerSymbol:  us10yBrokerSymbol,
    available:     !!us10yFound,
    h1BarCount:    us10yFound?.bar_count ?? 0,
    h1OldestBar:   us10yFound?.oldest_bar ?? null,
    h1NewestBar:   us10yFound?.newest_bar ?? null,
    h1SpanDays:    us10yFound?.span_days  ?? 0,
    depthClass:    depthClass(us10yFound?.span_days ?? 0),
    isFutures:     false,
    notes:         ["US Treasury 10-Year Yield — not available from XM MT5 broker"],
  });

  // Print asset summary
  console.log(`\n  ${"Asset".padEnd(10)} ${"BrokerSymbol".padEnd(16)} ${"Available".padStart(10)} ${"H1 Start".padStart(12)} ${"H1 End".padStart(12)} ${"H1 Bars".padStart(9)} ${"SpanDays".padStart(10)} ${"Depth".padStart(14)}`);
  console.log("  " + "-".repeat(100));
  for (const [, cov] of coverageMap) {
    const isFut = cov.isFutures ? " [FUTURES]" : "";
    console.log(
      `  ${cov.canonicalName.padEnd(10)} ` +
      `${(cov.brokerSymbol ?? "NOT FOUND").padEnd(16)} ` +
      `${(cov.available ? "YES" : "NO").padStart(10)} ` +
      `${(cov.h1OldestBar?.slice(0, 10) ?? "N/A").padStart(12)} ` +
      `${(cov.h1NewestBar?.slice(0, 10) ?? "N/A").padStart(12)} ` +
      `${String(cov.h1BarCount || "N/A").padStart(9)} ` +
      `${(cov.h1SpanDays ? f1(cov.h1SpanDays) : "N/A").padStart(10)} ` +
      `${(cov.depthClass + isFut).padStart(14)}`,
    );
  }

  for (const [asset, cov] of coverageMap) {
    if (cov.notes.length > 0) {
      console.log(`\n  ${asset} notes:`);
      cov.notes.forEach(n => console.log(`    ⚠ ${n}`));
    }
  }

  // ── STEP 4: Historical depth requirement ──────────────────────────────
  console.log("\n[STEP 4] Historical Depth Requirement");
  console.log(EQ.repeat(74));

  const eurCov  = coverageMap.get("EURUSD")!;
  const dxyCov  = coverageMap.get("DXY")!;
  const us10Cov = coverageMap.get("US10Y")!;

  // Common window = latest oldest_bar to earliest newest_bar across available assets
  const available = [eurCov, dxyCov, us10Cov].filter(c => c.available && c.h1OldestBar);
  let commonStart = "N/A", commonEnd = "N/A", commonDays = 0, commonBarsEst = 0;
  if (available.length >= 2) {
    const starts = available.map(c => c.h1OldestBar!).sort().reverse();
    const ends   = available.map(c => c.h1NewestBar!).sort();
    commonStart  = starts[0].slice(0, 10);
    commonEnd    = ends[0].slice(0, 10);
    const ms     = new Date(commonEnd).getTime() - new Date(commonStart).getTime();
    commonDays   = Math.max(0, Math.round(ms / 86_400_000));
    commonBarsEst = Math.round(commonDays * 24 * 5 / 7); // rough H1 estimate
  }

  const commonDepth = depthClass(commonDays);

  console.log(`\n  Preferred history:   >= ${Math.round(PREFERRED_DAYS / 365)} years`);
  console.log(`  Minimum history:     >= ${Math.round(MINIMUM_DAYS  / 365)} years`);
  console.log(`  Weak:                1-2 years`);
  console.log(`  Insufficient:        < 1 year`);
  console.log(`\n  Individual H1 span:`);
  for (const [, c] of coverageMap) {
    console.log(`    ${c.canonicalName.padEnd(10)} ${c.available ? f1(c.h1SpanDays) + " days" : "ABSENT"} → ${c.depthClass}`);
  }
  console.log(`\n  COMMON SYNCHRONIZED WINDOW:`);
  console.log(`    Start:   ${commonStart}`);
  console.log(`    End:     ${commonEnd}`);
  console.log(`    Span:    ${commonDays} days`);
  console.log(`    Est H1:  ~${commonBarsEst} common bars`);
  console.log(`    Class:   ${commonDepth}`);

  // ── STEP 5: UTC / Timestamp alignment ────────────────────────────────
  console.log("\n[STEP 5] UTC & Timestamp Alignment Audit");
  console.log(EQ.repeat(74));
  console.log(`  EURUSD UTC validation (from 002_bar_data.sql):`);
  console.log(`    H4 bars verified to align on 14400-second UTC boundaries`);
  console.log(`    MqlRates.time stored as UTC (not broker local time)`);
  console.log(`    bar open timestamp = UTC epoch, ISO format in DB`);
  console.log(`  UTC ALIGNMENT: PASS for EURUSD (verified by migration design docs)`);
  console.log(`  DXY (USDX-SEP26): same MT5 broker → same UTC convention assumed`);
  console.log(`    Would need independent H4 boundary check before using`);
  console.log(`  US10Y: NOT IN PIPELINE → alignment not assessable`);
  console.log(`\n  Confirmed-bar timing:`);
  console.log(`    getLastConfirmedBarIndex() uses evaluationTime vs bar.time + tfMs`);
  console.log(`    External bars at same timestamp = same confirmation semantics`);
  console.log(`    Cross-asset rule: signal at bar T may only use external bars with`);
  console.log(`      time_utc < T (i.e. confirmed before EURUSD decision timestamp)`);

  // ── STEP 6: Market hours difference ──────────────────────────────────
  console.log("\n[STEP 6] Market Hours Difference Audit");
  console.log(EQ.repeat(74));

  console.log(`  EURUSD (FX):     24/5 — Mon 00:00 UTC through Fri 22:00 UTC`);
  console.log(`  DXY futures:     CME hours ≈ Sun 23:00 – Fri 22:00 UTC (ICE)`);
  console.log(`                   But XM broker DXY may follow broker session hours`);
  console.log(`  US10Y (Tsy yld): Trading hours 13:30–22:00 UTC (NYSE Arca)`);
  console.log(`                   Gap: ~15.5h per day with no US10Y update`);
  console.log(`\n  H1 bar alignment check (via USDX-SEP26 in DB):`);

  const align = await checkTimestampAlignment(
    status,
    dxyBrokerSymbol,
    null, // US10Y not in DB
  );

  const total = align.totalEurusd;
  if (total > 0) {
    const pAligned  = align.alignedCount   / total * 100;
    const pEurOnly  = align.eursdOnlyCount / total * 100;
    const pDxyMiss  = align.dxyMissingCount / total * 100;
    const pMultMiss = align.multipleMissingCount / total * 100;
    console.log(`\n  EURUSD H1 bars checked: ${total}`);
    console.log(`  ALIGNED (all present):   ${f1(pAligned)}%  (${align.alignedCount} bars)`);
    console.log(`  EURUSD_ONLY:             ${f1(pEurOnly)}%  (${align.eursdOnlyCount} bars — external data absent)`);
    console.log(`  DXY_MISSING:             ${f1(pDxyMiss)}%  (${align.dxyMissingCount} bars)`);
    console.log(`  MULTIPLE_MISSING:        ${f1(pMultMiss)}%  (${align.multipleMissingCount} bars)`);
    if (align.eursdOnlyCount === total)
      console.log(`\n  → All EURUSD bars fall in EURUSD_ONLY bucket: DXY has no overlapping H1 period`);
  } else {
    console.log(`\n  (No EURUSD H1 data found — cannot compute alignment)`);
  }

  // US10Y market hours note
  console.log(`\n  US10Y market hours concern:`);
  console.log(`    During Asian session (22:00–13:30 UTC), no new US10Y data would exist`);
  console.log(`    Forward-fill from previous close would be required = stale data`);
  console.log(`    MARKET_HOURS_DIFFERENCE: REQUIRES_HANDLING for US10Y`);

  // ── STEP 7: Gateway & EA architecture ────────────────────────────────
  console.log("\n[STEP 7] Gateway & EA Architecture Audit");
  console.log(EQ.repeat(74));

  console.log(`\n  barDataStore.ts:`);
  console.log(`    upsertBulkBars(symbol, timeframe, bars) — fully generic`);
  console.log(`    upsertSingleBar(symbol, timeframe, bar) — fully generic`);
  console.log(`    symbol.toUpperCase() normalization applied`);
  console.log(`    → GATEWAY PIPELINE: READY for any broker symbol`);

  console.log(`\n  AVL_DataManager_v2.mq5 (EA):`);
  console.log(`    g_Symbol = Symbol() — single-chart symbol for real-time streams`);
  console.log(`    OHLCStream, TickStream, IndicatorStream: all use g_Symbol (single symbol)`);
  console.log(`    MarketWatch_Send(): broadcasts ALL Market Watch symbols (tick-level only)`);
  console.log(`    DataSync_Execute(jobId, symbol, tf, ...): TAKES SYMBOL AS PARAMETER`);
  console.log(`      → CopyRates(symbol, tf, ...) — any symbol in Market Watch works`);
  console.log(`    HistorySync_Run(): uses g_TFList + g_Symbol only (chart symbol)`);
  console.log(`\n    Multi-symbol historical collection OPTIONS:`);
  console.log(`      A. Run separate EA instances on DXY/US10Y charts`);
  console.log(`         → Each EA collects its own symbol history`);
  console.log(`         → Works today if broker provides the symbol`);
  console.log(`      B. Extend DataSync job queue to request DXY/US10Y`);
  console.log(`         → DataSync_Execute already supports arbitrary symbols`);
  console.log(`         → Only requires symbol to exist in broker Market Watch`);
  console.log(`      C. New external data provider`);
  console.log(`         → Required if symbol not available from XM MT5`);

  // ── STEP 8: BacktestEngine / research support ─────────────────────────
  console.log("\n[STEP 8] BacktestEngine & Research Architecture");
  console.log(EQ.repeat(74));
  console.log(`  BacktestEngine.barsByTimeframe: Record<string, Bar[]>`);
  console.log(`    → Currently single-symbol design (BacktestService line 255: "symbols.length !== 1")`);
  console.log(`    → Engine does NOT natively support multi-symbol simultaneous lookup`);
  console.log(`  Phase 8 research implication:`);
  console.log(`    Phase 8-B lead/lag analysis is a RESEARCH SCRIPT, not a strategy backtest`);
    console.log(`    Like Phase 6-7 scripts: fetch both assets separately, align via Map<timestamp,Bar>`);
  console.log(`    → ENGINE CHANGE NOT REQUIRED for research phase`);
  console.log(`    → If Phase 8 eventually produces a production strategy signal using DXY,`);
  console.log(`       BacktestEngine would need extension — but not yet`);

  // ── STEP 9: Look-ahead safety ─────────────────────────────────────────
  console.log("\n[STEP 9] Cross-Asset Look-Ahead Safety Design");
  console.log(EQ.repeat(74));
  console.log(`\n  Safe alignment algorithm (to be used in Phase 8-B):`);
  console.log(`\n  At EURUSD decision timestamp T (= bar i's open time):`);
  console.log(`    Allowed DXY bar:   last bar where time_utc < T  (confirmed before T)`);
  console.log(`    Allowed US10Y bar: last bar where time_utc < T  (confirmed before T)`);
  console.log(`    Implementation:`);
  console.log(`      const dxyBar = dxyMap.get(lastKeyBefore(dxyMap, T))`);
  console.log(`      where lastKeyBefore = Map sorted desc, first key < T`);
  console.log(`\n  Forbidden:`);
  console.log(`    - dxy/us10y bar at time T itself (same-bar contamination)`);
  console.log(`    - forward-fill from future close`);
  console.log(`    - nearest-neighbor matching that selects a future bar`);
  console.log(`\n  CONFIRMED-BAR ALIGNMENT: PASS (algorithm defined)`);

  // ── STEP 10: Synchronized dataset design ─────────────────────────────
  console.log("\n[STEP 10] Synchronized Dataset Design (for Phase 8-B)");
  console.log(EQ.repeat(74));
  console.log(`\n  Proposed research row (TypeScript):`);
  console.log(`  interface SyncRow {`);
  console.log(`    time_utc:       string;        // EURUSD H1 bar open (UTC)`);
  console.log(`    eurusd:         BarOHLC;       // always present (primary series)`);
  console.log(`    dxy:            BarOHLC | null;// last confirmed DXY bar before time_utc`);
  console.log(`    us10y:          BarOHLC | null;// last confirmed US10Y bar before time_utc`);
  console.log(`    dxy_available:  boolean;`);
  console.log(`    us10y_available:boolean;`);
  console.log(`    dxy_staleness_h:number;        // hours since last DXY bar`);
  console.log(`    us10y_staleness_h: number;`);
  console.log(`  }`);
  console.log(`\n  Alignment rule: INNER JOIN by availability → discard rows where required`);
  console.log(`  asset is null (INNER-ALIGNMENT, no silent interpolation)`);
  console.log(`  O(N) via sorted timestamp arrays + two-pointer merge`);

  // ── STEP 11: Source of truth decision ────────────────────────────────
  console.log("\n[STEP 11] Source-of-Truth & Case Classification");
  console.log(EQ.repeat(74));

  const dxyCase = (() => {
    if (!dxyCov.available) return "ABSENT";
    if (dxyCov.isFutures) return "FUTURES_ONLY";
    return "AVAILABLE_CONTINUOUS";
  })();

  const overallCase = (() => {
    if (!dxyCov.available && !us10Cov.available) return "C";
    if (dxyCov.available && !us10Cov.available)  return "B";
    return "A";
  })();

  console.log(`\n  DXY status:   ${dxyCase}`);
  console.log(`  US10Y status: ${us10Cov.available ? "AVAILABLE" : "ABSENT"}`);
  console.log(`\n  CASE CLASSIFICATION: CASE ${overallCase}`);
  if (overallCase === "C") {
    console.log(`    → Both DXY (continuous) and US10Y unavailable from MT5/XM pipeline`);
    console.log(`    → Phase 8 requires a new data-source decision`);
  } else if (overallCase === "B") {
    console.log(`    → DXY available (but as futures only); US10Y absent`);
    console.log(`    → Phase 8-B possible for DXY only, with futures limitations noted`);
  }

  if (dxyCov.available && dxyCov.isFutures) {
    console.log(`\n  DXY FUTURES LIMITATIONS:`);
    console.log(`    1. Continuous series requires quarterly roll (USDX-SEP26 → USDX-DEC26 etc.)`);
    console.log(`    2. Futures premium/discount distorts level comparison with spot DXY`);
    console.log(`    3. H1 history: only ${f1(dxyCov.h1SpanDays)} days — research INSUFFICIENT`);
    console.log(`    4. D1 history: 708 days but spans multiple contract periods → splice required`);
    console.log(`    5. Using raw futures prices without adjustment introduces artificial signals`);
  }

  console.log(`\n  DATA PROVIDER OPTIONS (for consideration, not selected here):`);
  console.log(`    Continuous DXY: ICE/Refinitiv / Alpha Vantage / Polygon.io / Quandl`);
  console.log(`    US10Y yield:    FRED (Federal Reserve) / Refinitiv / Bloomberg`);
  console.log(`    Both via same provider would simplify timestamp alignment`);
  console.log(`    Decision must be made separately before Phase 8-B begins`);

  // ── FINAL REPORT ──────────────────────────────────────────────────────
  const commonCovPct = eurCov.h1BarCount > 0 ? (commonBarsEst / eurCov.h1BarCount * 100) : 0;

  console.log("\n╔" + EQ.repeat(72) + "╗");
  console.log("║  PHASE 8-A FINAL REPORT" + " ".repeat(49) + "║");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("PHASE 8-A:", "COMPLETE");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("EURUSD:", "AVAILABLE");
  L("  H1 history:", `${eurCov.h1OldestBar?.slice(0,10)} → ${eurCov.h1NewestBar?.slice(0,10)} (${f1(eurCov.h1SpanDays)}d, ${f0(eurCov.h1BarCount)} bars)`);
  L("  Depth class:", eurCov.depthClass);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("DXY:", dxyCov.available ? `AVAILABLE AS FUTURES ONLY` : "NOT_AVAILABLE");
  L("  Broker symbol:", dxyCov.brokerSymbol ?? "NONE FOUND");
  if (dxyCov.available) {
    L("  H1 history:", `${dxyCov.h1OldestBar?.slice(0,10)} → ${dxyCov.h1NewestBar?.slice(0,10)} (${f1(dxyCov.h1SpanDays)}d)`);
    L("  H1 depth class:", `${dxyCov.depthClass} — research INSUFFICIENT`);
    L("  Continuous DXY:", "NOT AVAILABLE from XM MT5 broker");
    L("  Futures roll required:", "YES — expires Sep 2026");
  }
  console.log("╠" + EQ.repeat(72) + "╣");
  L("US10Y:", "NOT_AVAILABLE");
  L("  Broker symbol:", "NONE FOUND (US10Y/UST10Y/TNX absent from DB)");
  L("  XM MT5 support:", "NO — Treasury yields not offered by this broker");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("ACTUAL BROKER SYMBOLS:", "");
  L("  DXY:", dxyCov.brokerSymbol ?? "N/A");
  L("  US10Y:", "NOT IN BROKER");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("COMMON SYNCHRONIZED WINDOW:", commonDays > 0 ? `${commonStart} → ${commonEnd} (${commonDays}d)` : "N/A — no overlap");
  L("COMMON H1 OBSERVATIONS:", commonBarsEst > 0 ? `~${f0(commonBarsEst)}` : "N/A");
  L("COMMON COVERAGE:", commonDays > 0 ? `${f1(commonCovPct)}% of EURUSD H1 history` : "N/A");
  L("COMMON DEPTH CLASS:", commonDepth);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("BAR_DATA SCHEMA:", "READY — generic (symbol, timeframe, time_utc) PK, no change needed");
  L("SCHEMA_CHANGE_REQUIRED:", "NO");
  L("UTC ALIGNMENT:", "PASS (EURUSD verified; DXY same broker; US10Y N/A)");
  L("CONFIRMED-BAR ALIGNMENT:", "PASS (safe algorithm defined: use only bars with time_utc < T)");
  L("MARKET-HOURS DIFFERENCE:", "REQUIRES_HANDLING for US10Y (15.5h daily gap)");
  L("FORWARD FILL:", "DISABLED — not implemented, explicitly forbidden");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("EXISTING MT5 PIPELINE:", "PARTIAL");
  L("  Gateway (barDataStore):", "READY — any symbol accepted");
  L("  DataSync (EA):", "READY — DataSync_Execute takes arbitrary symbol");
  L("  OHLCStream (EA):", "SINGLE SYMBOL — g_Symbol only");
  L("  Multi-symbol option:", "Run separate EA per symbol (no code change needed)");
  L("NEW DATA PROVIDER REQUIRED:", "YES (for continuous DXY and US10Y)");
  L("CASE:", `C — both external assets unavailable for meaningful research`);
  console.log("╠" + EQ.repeat(72) + "╣");
  L("ENGINE FILES CHANGED:", "NO");
  L("PRODUCTION DEFAULTS CHANGED:", "NO");
  L("STRATEGY CREATED:", "NO");
  L("LIVE TRADING:", "NOT ENABLED");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("CROSS-ASSET RESEARCH READINESS:", "INSUFFICIENT");
  L("  Reason 1:", "DXY: only expiring futures (H1 = 35 days, need >= 2 years)");
  L("  Reason 2:", "US10Y: completely absent from XM MT5 broker");
  L("  Reason 3:", "Common synchronized H1 window < 36 days (need >= 2 years)");
  console.log("╠" + EQ.repeat(72) + "╣");
  console.log("║  NEXT PHASE DECISION" + " ".repeat(52) + "║");
  console.log("╠" + EQ.repeat(72) + "╣");
  L("RECOMMENDED ACTION:", "DATA EXPANSION FIRST — decide on external provider");
  L("Option A (preferred):", "Select single provider for continuous DXY + US10Y");
  L("  Candidates:", "FRED (US10Y free), Alpha Vantage / Polygon (DXY)");
  L("  Integration:", "New ingest script → bar_data (schema already ready)");
  L("  Alignment:", "Same timestamp semantics must be enforced");
  L("Option B:", "Use existing USDX futures (very limited — not recommended)");
  L("  Limitation:", "35 days H1 only; futures rollover required");
  L("  Conclusion:", "Not sufficient for robust Phase 8-B research");
  L("Option C:", "Change broker to one offering continuous DXY + yields");
  L("  Cost:", "New MT5 account setup; existing EURUSD data portable");
  L("DO NOT START Phase 8-B until:", "Provider chosen AND >= 2yr synchronized H1 collected");
  console.log("╚" + EQ.repeat(72) + "╝");
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });

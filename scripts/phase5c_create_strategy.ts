// scripts/phase5c_create_strategy.ts
// Phase 5-C: Multi-TF EMA21 Pullback — LONG + SHORT symmetric strategy
//
// Creates TWO separate strategy_registry entries (v2 LONG, v2 SHORT)
// registered as the Phase 5-C implementation.
//
// Usage: npx tsx --env-file=.env.local scripts/phase5c_create_strategy.ts

export {};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };

  console.log("=== Phase 5-C Strategy Creation ===\n");

  // Check existing strategies
  for (const name of [
    "EURUSD Multi-TF EMA21 Pullback v2 LONG",
    "EURUSD Multi-TF EMA21 Pullback v2 SHORT",
  ]) {
    const checkRes = await fetch(
      `${url}/rest/v1/strategy_registry?name=eq.${encodeURIComponent(name)}&select=id,name,backtest_status`,
      { headers }
    );
    const existing = await checkRes.json() as Array<{ id: string; name: string; backtest_status: string }>;
    if (existing.length > 0) {
      console.log(`Already exists: "${name}" (id=${existing[0].id})`);
    }
  }

  // Get current max magic number
  const mnRes = await fetch(
    `${url}/rest/v1/strategy_registry?select=magic_number&order=magic_number.desc&limit=1`,
    { headers }
  );
  const mnData = await mnRes.json() as Array<{ magic_number: number }>;
  let magicNumber = (mnData[0]?.magic_number ?? 20000) + 1;

  // ── LONG Spec ──────────────────────────────────────────────────────

  const longSpec = {
    name:            "EURUSD Multi-TF EMA21 Pullback v2 LONG",
    strategy_type:   "DAY_TRADE",
    description:     "Phase 5-C LONG: EURUSD M5 EMA21 Pullback — H4+H1 BULLISH trend filter. Symmetric counterpart to v2 SHORT. Change: Add SHORT strategy v2 as symmetric pair.",
    symbols:         ["EURUSD"],
    timeframes:      ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_ABOVE", threshold: 0 },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
      take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
    },
    filters: {
      sessions:        ["LONDON", "NEW_YORK"],
      max_spread_pips: 2.0,
      trend_filters: [
        { timeframe: "H4", indicator: "EMA", period: 21, direction: "BULLISH" },
        { timeframe: "H1", indicator: "EMA", period: 21, direction: "BULLISH" },
      ],
    },
    risk: { risk_per_trade: 0.01 },
  };

  // ── SHORT Spec ─────────────────────────────────────────────────────

  const shortSpec = {
    name:            "EURUSD Multi-TF EMA21 Pullback v2 SHORT",
    strategy_type:   "DAY_TRADE",
    description:     "Phase 5-C SHORT: EURUSD M5 EMA21 Pullback — H4+H1 BEARISH trend filter. Mirror of v2 LONG. Change: Add symmetric SHORT logic for bearish H1/H4 trend conditions.",
    symbols:         ["EURUSD"],
    timeframes:      ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "NEAR_EMA",    threshold: 3 },
        { indicator: "EMA", timeframe: "M5", period: 21, operator: "PRICE_BELOW", threshold: 0 },
      ],
    },
    exit_conditions: {
      stop_loss:   { method: "ATR", period: 14, multiplier: 1.5 },
      take_profit: { method: "RR_RATIO", rr_ratio: 2.0 },
    },
    filters: {
      sessions:        ["LONDON", "NEW_YORK"],
      max_spread_pips: 2.0,
      trend_filters: [
        { timeframe: "H4", indicator: "EMA", period: 21, direction: "BEARISH" },
        { timeframe: "H1", indicator: "EMA", period: 21, direction: "BEARISH" },
      ],
    },
    risk: { risk_per_trade: 0.01 },
  };

  const results: Array<{ name: string; id: string; magic: number }> = [];

  for (const spec of [longSpec, shortSpec]) {
    // Check if already exists
    const checkRes = await fetch(
      `${url}/rest/v1/strategy_registry?name=eq.${encodeURIComponent(spec.name)}&select=id,name`,
      { headers }
    );
    const existing = await checkRes.json() as Array<{ id: string; name: string }>;
    if (existing.length > 0) {
      console.log(`\nSkipping (already exists): "${spec.name}" id=${existing[0].id}`);
      results.push({ name: spec.name, id: existing[0].id, magic: -1 });
      continue;
    }

    const insertRes = await fetch(`${url}/rest/v1/strategy_registry`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name:             spec.name,
        strategy_type:    spec.strategy_type,
        description:      spec.description,
        symbols:          spec.symbols,
        timeframes:       spec.timeframes,
        entry_conditions: spec.entry_conditions,
        exit_conditions:  spec.exit_conditions,
        filters:          spec.filters,
        risk:             spec.risk,
        magic_number:     magicNumber,
        enabled:          false,
        status:           "DRAFT",
        backtest_status:  "NOT_TESTED",
        raw_prompt:       null,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error(`\nInsert failed for "${spec.name}": ${insertRes.status} — ${errText}`);
      continue;
    }

    const saved = await insertRes.json() as Array<{ id: string; magic_number: number }> | { id: string; magic_number: number };
    const record = Array.isArray(saved) ? saved[0] : saved;
    console.log(`\nCreated: "${spec.name}"`);
    console.log(`  id=${record.id}`);
    console.log(`  magic_number=${record.magic_number}`);
    results.push({ name: spec.name, id: record.id, magic: record.magic_number });
    magicNumber++;
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`  ${r.name}`);
    console.log(`    id=${r.id}`);
  }

  // Output IDs for use in backtest script
  const longId  = results.find(r => r.name.includes("LONG"))?.id;
  const shortId = results.find(r => r.name.includes("SHORT"))?.id;
  console.log(`\nLONG  strategy ID: ${longId}`);
  console.log(`SHORT strategy ID: ${shortId}`);
}

main().catch(console.error);

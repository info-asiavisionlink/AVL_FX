// scripts/phase5b_create_strategy.ts
// Usage: npx tsx --env-file=.env.local scripts/phase5b_create_strategy.ts

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

  // Check if this strategy already exists
  const checkRes = await fetch(
    `${url}/rest/v1/strategy_registry?name=eq.EURUSD+Multi-TF+EMA21+Pullback+v1&select=id,name,backtest_status`,
    { headers }
  );
  const existing = await checkRes.json();
  console.log("Existing match:", JSON.stringify(existing));

  if (existing.length > 0) {
    console.log(`Strategy already exists: id=${existing[0].id}, bt_status=${existing[0].backtest_status}`);
    console.log("Using existing strategy.");
    return;
  }

  // Build spec — LONG only (BULLISH trend filters → direction=BUY)
  const spec = {
    name: "EURUSD Multi-TF EMA21 Pullback v1",
    strategy_type: "DAY_TRADE",
    description: "Phase 5-B: EURUSD M5 EMA21 Pullback with H4+H1 Trend Filter - LONG only",
    symbols: ["EURUSD"],
    timeframes: ["M5", "H1", "H4"],
    entry_conditions: {
      logic: "AND",
      conditions: [
        {
          indicator: "EMA",
          timeframe: "M5",
          period: 21,
          operator: "NEAR_EMA",
          threshold: 3,
        },
        {
          indicator: "EMA",
          timeframe: "M5",
          period: 21,
          operator: "PRICE_ABOVE",
          threshold: 0,
        },
      ],
    },
    exit_conditions: {
      stop_loss: {
        method: "ATR",
        period: 14,
        multiplier: 1.5,
      },
      take_profit: {
        method: "RR_RATIO",
        rr_ratio: 2.0,
      },
    },
    filters: {
      sessions: ["LONDON", "NEW_YORK"],
      max_spread_pips: 2.0,
      trend_filters: [
        {
          timeframe: "H4",
          indicator: "EMA",
          period: 21,
          direction: "BULLISH",
        },
        {
          timeframe: "H1",
          indicator: "EMA",
          period: 21,
          direction: "BULLISH",
        },
      ],
    },
    risk: {
      risk_per_trade: 0.01,
    },
  };

  // Get current max magic number
  const mnRes = await fetch(
    `${url}/rest/v1/strategy_registry?select=magic_number&order=magic_number.desc&limit=1`,
    { headers }
  );
  const mnData = await mnRes.json();
  const magicNumber = (mnData[0]?.magic_number ?? 20000) + 1;

  // Insert
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
    console.error(`Insert failed: ${insertRes.status} — ${errText}`);
    return;
  }

  const saved = await insertRes.json();
  const strategy = Array.isArray(saved) ? saved[0] : saved;
  console.log("Strategy created successfully:");
  console.log(`  id=${strategy.id}`);
  console.log(`  name="${strategy.name}"`);
  console.log(`  type=${strategy.strategy_type}`);
  console.log(`  magic_number=${strategy.magic_number}`);
  console.log(`  status=${strategy.status}`);
  console.log(`  backtest_status=${strategy.backtest_status}`);
}
main().catch(console.error);

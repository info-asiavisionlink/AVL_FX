# AVL-FX — Unified MT5 Bridge EA

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Overview

### 1-1. V1 Current State

V1 has two EA roles:
- `AVL_FX_Bridge.ex5` — market data bridge (OHLC/tick → Gateway)
- `AVL_ExecutionBridge.ex5` — execution bridge (BUY/SELL/MODIFY/CLOSE)

Both must be installed on the customer's MT5. Two separate EA processes with overlapping connection logic.

### 1-2. TARGET State

One EA installed per customer MT5:

```
AVL_FX_Bridge.ex5  (unified — working name; confirm against V1 naming convention)
```

Internal module separation is maintained. Combining into one file does **not** mean mixing responsibilities. The execution module remains logically isolated from market data modules.

---

## 2. Unified Bridge Module Structure

```
AVL_FX_Bridge
│
├── Connection Module
│     ├── Gateway URL configuration
│     ├── Authentication (signed connection token)
│     ├── WebSocket / HTTP connection management
│     ├── Reconnect with exponential backoff
│     ├── Heartbeat to Gateway
│     └── Connection status reporting
│
├── Market Data Module
│     ├── OnTick() → bid, ask, spread, timestamp
│     ├── OnBarClose(timeframe) → OHLC bar (all configured timeframes)
│     ├── Current forming bar state
│     ├── Broker symbol → canonical symbol mapping
│     └── Send to Gateway: POST /market-data/tick, /market-data/bars
│
├── Historical Data Module
│     ├── CopyRates() for backfill on reconnect
│     ├── Last persisted bar query (GET /market-data/last-bar)
│     ├── Batch upload of missing bars
│     ├── Idempotent retry on batch failure
│     └── Progress tracking per symbol/timeframe
│
├── Symbol Specification Module
│     ├── SymbolInfoDouble() — tick_size, tick_value, contract_size, digits
│     ├── SymbolInfoInteger() — stops_level, volume_min, volume_max, volume_step
│     ├── Broker symbol name
│     ├── Send on connect + periodic refresh
│     └── POST /symbol-spec
│
├── Account Module
│     ├── AccountInfoDouble() — balance, equity, free_margin, margin
│     ├── AccountInfoString() — account_name, currency, server
│     ├── AccountInfoInteger() — account_type (REAL/DEMO), trade_mode (HEDGING/NETTING)
│     ├── Broker server UTC offset (for UTC normalization)
│     ├── Send on heartbeat (configurable interval, default 10s)
│     └── POST /heartbeat/account
│
├── Position Module
│     ├── PositionsTotal() / PositionSelect() snapshot
│     ├── Position ticket, symbol, type, volume, open price, SL, TP, profit
│     ├── Send on position change events
│     └── POST /positions/snapshot
│
├── Deal / History Module
│     ├── HistoryDealsSelect() for recent deals
│     ├── Deal ticket, order ticket, symbol, type, entry, volume, price
│     ├── Profit, commission, swap
│     ├── Send on new deal detected
│     └── POST /deals
│
└── Execution Module
      ├── OrderSend() — BUY / SELL
      ├── OrderClose() / PositionClose()
      ├── OrderModify() — SL / TP modification
      ├── Command reception: GET /execution/pending-commands
      ├── Command validation (see Section 4)
      ├── Fill confirmation: POST /execution/fill-result
      ├── Close confirmation: POST /execution/close-result
      └── Error reporting: POST /execution/error
```

---

## 3. Module Independence Requirements

### 3-1. Market Data ≠ Execution

```
Market Data Module:
  - READ-ONLY operations on MT5
  - No order placement
  - No position modification
  - Sends data to Gateway passively

Execution Module:
  - WRITE operations on MT5 (order placement, modification, close)
  - Only activated by authenticated command from Gateway
  - Independent authentication check on every command
  - Does not share state with Market Data Module
  - Failure of Market Data Module does NOT cause Execution to fail open
```

### 3-2. Safety Invariant

```
Market Data failure → Execution continues independently
  (Execution safety does NOT depend on Market Data being healthy)

Execution failure → Market Data continues independently
  (Chart/Analysis does NOT stop if Execution has an error)

Connection failure → Both modules pause; both retry on reconnect
```

---

## 4. Execution Safety (Unchanged from V1)

The Unified Bridge preserves all execution safety from V1 Stages 1–7. Moving to one EA file does not weaken any safety check.

### 4-1. Command Reception and Validation

```
Bridge polls Gateway for pending execution commands
  → GET /execution/pending-commands

Per command validation (EA-side, independent of server):
  1. command_id present and unique (deduplication)
  2. connection_token_hash matches this EA's connection
  3. expires_at > current_time (command not expired)
  4. symbol matches configured broker_symbol
  5. direction valid (BUY or SELL)
  6. volume within broker limits (volume_min ≤ vol ≤ volume_max, volume_step aligned)
  7. sl_price in favorable direction (BUY: sl < entry; SELL: sl > entry)
  8. sl_distance ≥ stops_level (broker minimum SL distance)
  9. account_type validation (DEMO check if demo_execution_only)
  10. account_mode (HEDGING vs NETTING compatibility)
```

### 4-2. Canonical Execution Path (Unchanged)

```
AI Trader
    ↓
Risk Engine (server-side)
    ↓
Owner Approval (if MANUAL_APPROVAL mode)
    ↓
execution_commands table (Gateway polls)
    ↓
Customer Gateway
    ↓
Unified Bridge Execution Module
    ↓ (validation passes)
MT5 OrderSend()
    ↓
Broker fill
    ↓
Bridge: POST /execution/fill-result
    ↓
Gateway: update execution_commands, ai_positions
```

### 4-3. Safety Properties Maintained

| Property | Status |
|----------|--------|
| Customer/connection isolation | ✅ Maintained |
| Authenticated command | ✅ Maintained |
| Command expiry | ✅ Maintained |
| Idempotency | ✅ Maintained |
| Duplicate prevention | ✅ Maintained |
| Broker symbol validation | ✅ Maintained |
| Account validation | ✅ Maintained |
| DEMO/LIVE guard | ✅ Maintained |
| Risk Engine gate | ✅ Maintained |
| Manual Approval mode | ✅ Maintained |
| Hard broker SL | ✅ Maintained |
| Favorable SL direction | ✅ Maintained |
| Broker-confirmed FILLED | ✅ Maintained |
| Broker-confirmed CLOSE | ✅ Maintained |
| Position reconciliation | ✅ Maintained |
| Fail closed | ✅ Maintained |

---

## 5. Connection and Authentication

```
Connection token:
  Each customer has a connection_token_hash in mt5_connections table
  Bridge uses this token to authenticate to Gateway
  Token is NOT stored in plaintext in EA (passed at EA startup parameter)

Heartbeat:
  Bridge sends heartbeat every N seconds (configurable, default 10s)
  Heartbeat includes: connection_id, account snapshot, timestamp
  Gateway: mark connection as alive

Reconnect:
  Exponential backoff: 5s, 10s, 20s, 40s, max 60s
  On reconnect:
    1. Re-authenticate
    2. Send full symbol specification
    3. Send account snapshot
    4. Request last persisted bar → start backfill if needed (Historical Data Module)
    5. Resume realtime bar transmission
```

---

## 6. Configuration

Bridge EA is configured via MT5 Expert Advisor input parameters:

```
input string GatewayURL      = "https://customer-gateway.up.railway.app";
input string ConnectionToken = "";   // Set at EA startup, never hardcoded
input string BrokerSymbol    = "";   // MT5 symbol (e.g., "GOLD#")
input string CanonicalSymbol = "GOLD"; // Canonical name
input bool   EnableExecution = true;  // Can disable Execution Module
input int    HeartbeatIntervalSeconds = 10;
input int    BackfillBatchSize = 500;
input string TimeframesCSV   = "M5,H1"; // Which TFs to stream (e.g., "M1,M5,H1,H4,D1")
```

No customer-visible execution decisions are made in EA configuration.  
No API keys or secrets are hardcoded in the EA source file.

---

## 7. Error Handling

```
Market Data send failure:
  → Log error
  → Retry on next tick/bar
  → Do not crash EA

Execution command validation failure:
  → POST /execution/error with reason
  → Do not attempt to execute invalid command
  → Log locally

MT5 order failure (rejected by broker):
  → POST /execution/fill-result with error
  → Do not retry automatically (server decides retry policy)
  → Log error details

Gateway unreachable:
  → Queue latest account/position snapshots in memory (limited)
  → Reconnect with backoff
  → On reconnect: backfill historical bars, send queued snapshots
  → Do not accumulate unbounded queue

Memory management:
  → Limit in-memory tick/bar buffer to configurable maximum
  → Do not crash on buffer overflow: drop oldest if needed, log dropped count
```

---

## 8. EA Deployment Notes

> Implementation notes for V2 implementation team

1. Verify MT5 EA single file constraint: one `.mq5` file can use `#include` for module files. Use `#include "modules/MarketDataModule.mqh"` pattern for module separation within one compiled EA.

2. Test EA on all supported broker platforms (XM, Titan FX, FXGT) before production deployment.

3. EA must handle broker server timezone differences correctly (see `CUSTOMER_MARKET_DATA_ARCHITECTURE.md` Section 7).

4. Connection token must be provided at EA startup via input parameter, not hardcoded or in `#property` annotations.

5. EA update procedure: deploy new EA file, customer stops old EA and starts new EA — no migration needed since state is in Supabase, not EA.

---

## 9. V1 → Unified Bridge Migration

### 9-1. CURRENT V1 EA setup (per customer)

```
AVL_FX_Bridge.ex5       — sends bars to /bridge/bars (also sends ticks, account data)
AVL_ExecutionBridge.ex5 — polls /execution/commands, sends fills/closes
```

### 9-2. TARGET (per customer)

```
AVL_FX_Bridge.ex5 (unified V2) — all modules in one EA
```

### 9-3. Migration Approach

```
Stage 1: Implement unified EA with all modules
Stage 2: Deploy on test customer system alongside V1 EAs (parallel operation)
Stage 3: Verify all modules function correctly
Stage 4: Switch customer to unified EA (stop V1 EAs, start unified EA)
Stage 5: Retire V1 EA files from new customer deployments

Rollback: Customer can revert to V1 EAs if unified EA has issues
  (V1 EA customer gateway API endpoints remain compatible during transition)
```

---

## 10. Relationship to V1

V1's `AVL_FX_Bridge.ex5` already sends market data to `/bridge/bars`.  
V1's `AVL_ExecutionBridge.ex5` handles execution.

The Unified Bridge consolidates these into one EA with cleaner module separation.  
The unified EA does NOT require any changes to:
- Customer Gateway API contract (same endpoints, extended for new modules)
- Customer Supabase schema (additive: new `customer_bar_data` table)
- Risk Engine (unchanged)
- Trading View runtime (reads from Supabase, not EA directly)

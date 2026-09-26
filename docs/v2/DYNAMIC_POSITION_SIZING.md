# AVL-FX V2 — Dynamic Position Sizing

**Document type:** V2 Planned Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Overview

V1 Risk Engine already implements tick-value based lot calculation (check #13 in `risk-engine.ts`).  
V2 adds **user-configurable `risk_per_trade_percent`** to that existing foundation.

V1 state: lot calculation uses `profile.max_risk_per_trade` field but it may be hardcoded or admin-set.  
V2 state: customer sets `risk_per_trade_percent` in their AI Trader Risk Profile via Trading View UI.

---

## 2. Source of Truth Hierarchy

```
Equity:             mt5_connections.equity
                    (updated by Customer Bridge EA heartbeat)
                    NEVER from central market data

Execution Price:    Customer MT5 ASK (BUY) or BID (SELL)
                    (from Customer Bridge EA live quote)
                    NEVER from central market data

Symbol Spec:        symbol_specs table
                    (populated by Customer Bridge EA on connect/refresh)
                    Connection-specific: volume_min, volume_max, volume_step,
                    tick_size, tick_value, contract_size

Risk %:             ai_trader_versions.risk_per_trade_percent
                    (set by customer in AI Trader Profile)

SL Distance:        From trade decision (analysis-phase)
                    Translated to customer-executable price before calculation
                    (see V2_ARCHITECTURE.md Section 3-2 Price Translation)

Final Gate:         Bridge EA safety validation
                    Cannot be bypassed by server-side calculation errors
```

---

## 3. Lot Calculation Formula

### 3-1. Core Formula

```
risk_amount     = equity × (risk_per_trade_percent / 100)

sl_distance     = abs(executable_entry_price - executable_sl_price)

tick_count      = sl_distance / tick_size

loss_per_lot    = tick_count × tick_value

raw_volume      = risk_amount / loss_per_lot

safe_volume     = floor(raw_volume / volume_step) × volume_step

final_volume    = clamp(safe_volume, volume_min, volume_max)
```

### 3-2. Example — GOLD (XAUUSD)

Inputs:
```
equity               = ¥100,000 (JPY account)
risk_per_trade_%     = 1.0%
risk_amount          = ¥1,000

executable_entry     = 4292.60  (customer ASK)
executable_sl        = 4287.60  (translated from reference SL)
sl_distance          = 5.00

tick_size            = 0.01     (GOLD typically)
tick_value           = 0.XX JPY per lot per tick (from customer broker symbol_specs)
tick_count           = 5.00 / 0.01 = 500

loss_per_lot         = 500 × tick_value

raw_volume           = ¥1,000 / loss_per_lot

safe_volume          = floor(raw_volume / volume_step) × volume_step
                       (always round DOWN — protect customer)

final_volume         = clamp(safe_volume, 0.01, 50.0)
                       (clamp to broker limits)
```

**Important:** `tick_value` varies by broker, account currency, and current exchange rate. Do NOT hardcode it. Always use `symbol_specs.tick_value` from the customer's Bridge EA data.

### 3-3. BUY vs SELL Price Selection

```
BUY order:   use customer MT5 ASK as execution reference price
SELL order:  use customer MT5 BID as execution reference price

Rationale:
  BUY is executed at ASK (what you pay to buy)
  SELL is executed at BID (what you receive to sell)
  SL distance is measured from actual fill price, not mid
```

---

## 4. Double Validation Architecture

### 4-1. Server-side Risk Engine (primary)

Location: `src/lib/ai-trader/risk-engine.ts` (extended in V2)

V2 additions to existing checks:
```
[New Check A] Read risk_per_trade_percent from ai_trader_versions
[New Check B] Calculate risk_amount = equity × risk_per_trade_percent
[New Check C] Perform lot calculation (formula above)
[New Check D] Apply system hard caps (see Section 5)
[New Check E] Validate translated SL/TP prices (see V2_ARCHITECTURE.md 3-2)
[New Check F] Final volume must be > 0 (if 0, DENIED — risk too small for min lot)
```

Existing checks (V1) are preserved unchanged.

### 4-2. Bridge EA Final Safety Validation

Location: Customer Bridge EA (MT5 Expert Advisor)

EA performs independent validation before placing the MT5 order:
```
- Volume within broker symbol limits (volume_min, volume_max, volume_step)
- SL distance ≥ broker stops_level
- Price not older than EA freshness threshold
- Account equity sufficient (EA-side check)
- Magic number matches EA configuration
```

If server sends an invalid volume, the EA rejects it. EA is the last safety gate.

**This is a critical safety invariant:** The EA must be capable of rejecting server commands independently. This provides defense-in-depth against server-side calculation bugs.

---

## 5. Hard Caps (System-Level Safety)

These are NOT customer-configurable. They are system constants enforced by Risk Engine regardless of user risk % setting.

```
SYSTEM_MAX_RISK_PERCENT         e.g., 5% (specific value to be decided at V2 implementation)
SYSTEM_MAX_VOLUME_PER_TRADE     e.g., 10.0 lots
SYSTEM_MAX_TOTAL_EXPOSURE_LOTS  e.g., 20.0 lots across all positions
SYSTEM_MAX_CONCURRENT_POSITIONS e.g., 3 positions
```

Hard caps are stored in server-side configuration (environment variables or system_settings table), not in customer AI Trader profile.

Customer can set risk_per_trade_percent up to their configured limit, which cannot exceed SYSTEM_MAX_RISK_PERCENT.

---

## 6. Risk Profile Schema (V2 Extension)

Proposed addition to `ai_trader_versions` table or a new `ai_trader_risk_profiles` table:

```sql
-- Option A: Extend ai_trader_versions (additive columns)
ALTER TABLE ai_trader_versions ADD COLUMN IF NOT EXISTS
  risk_per_trade_percent NUMERIC(5,2) DEFAULT 1.0
    CHECK (risk_per_trade_percent > 0 AND risk_per_trade_percent <= 5.0);

-- Option B: New table (cleaner separation, more flexible)
CREATE TABLE ai_trader_risk_profiles (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_trader_version_id      UUID NOT NULL REFERENCES ai_trader_versions(id),

  risk_per_trade_percent    NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  minimum_rr                NUMERIC(4,2) NOT NULL DEFAULT 1.5,
  max_positions             INTEGER NOT NULL DEFAULT 1,
  execution_policy          TEXT NOT NULL DEFAULT 'MANUAL_APPROVAL'
                            CHECK (execution_policy IN ('MANUAL_APPROVAL', 'AUTONOMOUS')),

  -- Hard cap overrides (per trader, within system limits)
  max_daily_risk_percent    NUMERIC(5,2),
  max_consecutive_losses    INTEGER,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Decision between Option A and Option B: to be made at V2 implementation based on migration complexity.

V1 already has `max_risk_per_trade` in the profile. V2 renames/extends this to `risk_per_trade_percent` with user-configurable UI.

---

## 7. Trading View UI — Risk Profile Settings

Proposed UI location: AI Trader → Settings → Risk Profile

```
Risk Profile

Risk per Trade
[  1.00  ] %
Equity at risk per trade. Maximum: 5.00%

Current Account Equity: ¥100,000 (from MT5 connection)
Maximum Risk Amount: ¥1,000.00

Minimum Risk/Reward Ratio
[  1.5  ] : 1
Minimum R:R required to enter. Trades below this threshold are skipped.

Maximum Open Positions
[  1  ]
Maximum simultaneous open positions for this trader.

Execution Policy
( ) MANUAL_APPROVAL — Receive notification, approve in app
(•) AUTONOMOUS      — Auto-execute (DEMO accounts only)
```

---

## 8. Price Translation Validation

Before lot calculation, the Risk Engine must perform price translation:

```typescript
// Pseudocode — not implementation
function translateAndValidate(
  referenceEntry: number,   // from AI analysis (central market data)
  referenceSl:    number,   // from AI analysis
  referenceTp:    number,   // from AI analysis
  customerAsk:    number,   // from Customer MT5 (for BUY)
  direction:      'BUY' | 'SELL'
): TranslatedPrices {

  const execPrice = direction === 'BUY' ? customerAsk : customerBid;
  const delta = execPrice - referenceEntry;

  // Preserve SL/TP distance from entry (not absolute price)
  const slDistance = referenceEntry - referenceSl;  // for BUY
  const tpDistance = referenceTp - referenceEntry;

  const translatedSl = execPrice - slDistance;
  const translatedTp = execPrice + tpDistance;

  const actualRR = tpDistance / slDistance;  // re-verify after translation

  return { execPrice, translatedSl, translatedTp, actualRR, delta };
}
```

If `actualRR < minimum_rr` after translation, DENIED.  
If `slDistance ≤ 0`, DENIED.  
If price delta exceeds configured slippage tolerance, DENIED (configurable per trader profile).

---

## 9. Existing V1 Foundation (No Change Required)

The following V1 components already implement the infrastructure V2 builds on:

| Component | Location | V1 Status |
|-----------|----------|-----------|
| `symbol_specs` table | `027_phase35_safety_gate.sql` | IMPLEMENTED |
| `mt5_connections.equity/balance` | `027_phase35_safety_gate.sql` | IMPLEMENTED |
| Tick-value lot calculation | `risk-engine.ts` check #13 | IMPLEMENTED |
| Account freshness enforcement | `risk-engine.ts` check #6 | IMPLEMENTED |
| Symbol spec required for execution | `risk-engine.ts` check #7 | IMPLEMENTED |
| Bridge EA symbol spec reporting | Bridge EA | IMPLEMENTED |
| EA final safety validation | Bridge EA | IMPLEMENTED |

V2 only needs to add:
1. `risk_per_trade_percent` field to AI Trader profile (schema extension)
2. Trading View UI for customer to set risk %
3. Risk Engine reads new field instead of (or in addition to) existing `max_risk_per_trade`
4. Price translation step before lot calculation

---

## 10. Failure Cases

| Condition | Result |
|-----------|--------|
| equity = 0 or null | DENIED — cannot calculate risk amount |
| symbol_specs missing | DENIED — cannot calculate tick-value lot |
| risk_per_trade_percent = 0 | DENIED — zero risk produces zero lot |
| calculated volume < volume_min | DENIED — risk too small for broker minimum (notify customer) |
| calculated volume > volume_max | Apply volume_max (customer gets less risk than configured) |
| equity stale (> account_max_age_seconds) | DENIED — stale account data |
| price delta > slippage_tolerance | DENIED — price moved too much since analysis |
| translated SL invalid (broker stops_level violation) | DENIED |
| minimum_rr not met after translation | DENIED |

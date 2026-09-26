# AVL-FX — POST-V1 Target Requirements

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE — V1 Stage 10-C SUSPENDED / SUPERSEDED; V2 implementation ready to start  
**Created:** 2026-09-26  
**Revised:** 2026-09-26 — Architecture redesign to Customer Self-Contained  
**Master V2 index:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

> V1 production must reach "Production Complete" before POST-V1 implementation begins.  
> This document describes *what to build*, not *current V1 state*.  
> For current V1 state, see: `docs/AVLFX要件定義・基本設計書.md`

---

## 1. Architecture Principle Change

### 1-1. OLD V2 Plan (SUPERSEDED)

The original V2 plan included a "Central Market Data Architecture" (V2-03) where:
- AVL operates a central MT5
- Central Market Data Service distributes OHLC to all customer Trading Views
- Customer Trading View depends on AVL central prices for AI analysis

**This central architecture has been superseded.** See: [CENTRAL_MARKET_DATA.md](./CENTRAL_MARKET_DATA.md) (deprecated).

### 1-2. NEW TARGET: Customer Self-Contained Architecture

**Each Customer system is self-contained.**

```
Customer Self-Contained System:
  Customer MT5 (any MT5 broker)
      ↓
  Unified Bridge EA
      ↓
  Customer Gateway (Railway)
      ↓
  Customer Supabase
      ↓
  Customer Trading View (Vercel)
      ↓
  AI Trader (reads from Customer Supabase)
```

Customer AI Trader does NOT call AVL Console at runtime for market data or knowledge.

---

## 2. POST-V1 Feature Scope

| ID | Feature | Supersedes |
|----|---------|-----------|
| P1-01 | Customer Market Data Persistence | V2-03 (Central Market Data) — SUPERSEDED |
| P1-02 | Unified MT5 Bridge EA | (new — consolidates V1 two-EA architecture) |
| P1-03 | Customer Knowledge Localization | V2-05 (partial — runtime dependency removed) |
| P1-04 | Dynamic Position Sizing | V2-02 (unchanged in principle) |
| P1-05 | AI Trader Style / Multi-Timeframe Profile | V2-04 (unchanged) |
| P1-06 | Customer AI Trader Builder / Configuration | V2-05 (role realigned: Customer System is canonical owner) |
| P1-07 | AVL AI LINE Notification Infrastructure | V2-01 (unchanged) |
| P1-08 | Console Business/Infrastructure Redesign | (new — Console role change) |
| P1-09 | AVL Development Orchestrator | V2-06 (unchanged) |

---

## 3. V1 Foundation (Preserved)

The following V1 components are confirmed implemented and must be preserved:

**Risk Engine (`src/lib/ai-trader/risk-engine.ts`)**
- Tick-value based lot calculation (check #13)
- Account snapshot freshness enforcement
- `symbol_specs` table (V1 existing)
- `mt5_connections.equity/balance` as source of truth

**V1 AI Trader Schema (preserved, extended in POST-V1)**
- `ai_traders`, `ai_trader_versions`, `ai_trader_knowledge` tables
- `ai_analysis_logs.knowledge_snapshot` for audit trail
- Lifecycle: WAIT → WATCH → ENTER → FILLED → HOLD → CLOSE

**V1 Architecture Boundaries (must not change)**
- Console Supabase ≠ Customer Trading View Supabase (stays separated)
- Console Gateway (data collection) ≠ Customer Gateway (execution)
- Customer MT5 is authoritative for execution

---

## 4. P1-01 — Customer Market Data Persistence

### 4-1. Concept

Customer MT5 is the canonical market data source for that customer. OHLC bars sent by the Unified Bridge EA are persisted to Customer Supabase and used for charts, indicators, and AI analysis.

### 4-2. Requirements

**FR-MKT-01**: Customer Supabase `customer_bar_data` table stores OHLC bars from Customer MT5.  
**FR-MKT-02**: Bars are identified by `(connection_id, canonical_symbol, timeframe, time_utc)` — unique constraint.  
**FR-MKT-03**: Bar ingestion is idempotent — duplicate bars do not cause errors.  
**FR-MKT-04**: Chart, indicators, and AI Trader all read from the same `customer_bar_data` source.  
**FR-MKT-05**: Realtime forming bar comes from WebSocket (not stored until bar close confirmed).  
**FR-MKT-06**: Historical backfill runs automatically on Bridge EA reconnect.  
**FR-MKT-07**: Data completeness is verified before AI analysis runs. Gaps cause fail-closed, not silent degradation.

See: [CUSTOMER_MARKET_DATA_ARCHITECTURE.md](./CUSTOMER_MARKET_DATA_ARCHITECTURE.md)

---

## 5. P1-02 — Unified MT5 Bridge EA

### 5-1. Concept

One EA per customer MT5 (vs V1's two separate EAs). Internal module separation maintained.

### 5-2. Requirements

**FR-BRIDGE-01**: Single `AVL_FX_Bridge.ex5` installed per customer MT5.  
**FR-BRIDGE-02**: Market Data Module and Execution Module are logically separated within the EA.  
**FR-BRIDGE-03**: All V1 Execution Safety properties are preserved (see Section 9).  
**FR-BRIDGE-04**: Bridge sends bars for all configured timeframes on each bar close.  
**FR-BRIDGE-05**: Bridge performs historical backfill on reconnect (compares Supabase last bar vs MT5 history).  
**FR-BRIDGE-06**: Bridge sends symbol specifications on connect and on periodic refresh.  
**FR-BRIDGE-07**: Bridge sends account snapshot (equity, balance, margin) on heartbeat.  
**FR-BRIDGE-08**: Execution Module failure does NOT affect Market Data Module operation.

See: [UNIFIED_MT5_BRIDGE.md](./UNIFIED_MT5_BRIDGE.md)

---

## 6. P1-03 — Customer Knowledge Localization

### 6-1. Concept

AI Trader does not call Console at runtime for knowledge. Knowledge is deployed to Customer Supabase at AI Trader provisioning time.

### 6-2. Requirements

**FR-KNW-01**: `customer_knowledge` table in Customer Supabase stores knowledge content.  
**FR-KNW-02**: Knowledge Package is created at AI Trader provisioning time, not at analysis runtime.  
**FR-KNW-03**: AI Trader reads knowledge from `customer_knowledge` (local), not from Console API.  
**FR-KNW-04**: Each knowledge item in the package stores: content hash, source provenance, installed_at.  
**FR-KNW-05**: `ai_analysis_logs.knowledge_snapshot` references `customer_knowledge.id`.  
**FR-KNW-06**: Customer system remains operational when Console is unavailable.  
**FR-KNW-07**: Chain-of-thought is NOT stored (V1 policy maintained).

See: [CUSTOMER_KNOWLEDGE_ARCHITECTURE.md](./CUSTOMER_KNOWLEDGE_ARCHITECTURE.md)

---

## 7. P1-04 — Dynamic Position Sizing

### 7-1. Concept (Unchanged in principle)

Customer sets `risk_per_trade_percent` in AI Trader Risk Profile. Risk Engine calculates lot from equity and SL distance using Customer MT5 symbol specifications.

### 7-2. Requirements (Source of Truth)

```
Equity:           Customer MT5 (mt5_connections.equity from Bridge heartbeat)
Execution price:  Customer MT5 ASK (BUY) / BID (SELL) from Bridge
Symbol specs:     Customer MT5 (symbol_specs table from Bridge)
Risk %:           ai_trader_versions.risk_per_trade_percent (customer-configured)
SL distance:      From trade decision (customer broker price-referenced)
```

No central market data involvement. Customer MT5 is the sole price authority.

See: [DYNAMIC_POSITION_SIZING.md](./DYNAMIC_POSITION_SIZING.md)

---

## 8. P1-05 — AI Trader Style / Multi-Timeframe Profile

Requirements unchanged from original V2-04. See: [AI_TRADER_PROFILE.md](./AI_TRADER_PROFILE.md)

Key: Timeframe profiles define which timeframes the AI Trader runtime operates on. These must match available timeframes in `customer_bar_data`.

---

## 9. P1-06 — Customer AI Trader Builder / Configuration

### 9-1. Canonical Architecture

**AI Trader configuration, Knowledge, Profile, and Runtime all live in Customer System (Customer Supabase).**

The Console provides an **admin/provisioning UI only** — it does NOT run AI Trader logic.  
At runtime, the Customer AI Trader does NOT call Console API for any trading-related data.

See: [AI_TRADER_BUILDER.md](./AI_TRADER_BUILDER.md)

### 9-2. What the Builder Creates

```
Builder Output (deployed to Customer Supabase):
  ai_traders record
  ai_trader_versions record
  ai_trader_timeframe_profiles record
  ai_trader_risk_profiles record
  customer_knowledge records (Knowledge Package)
  notification_preferences defaults
```

After delivery, the customer's system runs fully independently.

### 9-3. Customer Self-Modification Scope

Customers can modify within defined limits (via Trading View settings):
- `risk_per_trade_percent` (within system hard caps)
- Notification preferences (ON/OFF per type)
- Execution policy display (MANUAL_APPROVAL is always available)
- Trader activation/deactivation (ACTIVE/ARCHIVED status)

Customers cannot modify (requires AVL admin via Builder):
- Timeframe profile
- Knowledge package selection
- Strategy configuration
- Indicator configuration

See: [AI_TRADER_BUILDER.md](./AI_TRADER_BUILDER.md)

---

## 10. P1-07 — LINE Notification Infrastructure

LINE architecture unchanged. Console routes notifications but does NOT generate trading analysis.

```
Customer Trading View → Notification Event → Console Notification Service
→ customer_line_links lookup → LINE Messaging API → Customer LINE
```

See: [LINE_NOTIFICATION_ARCHITECTURE.md](./LINE_NOTIFICATION_ARCHITECTURE.md)

---

## 11. P1-08 — Console Business/Infrastructure Redesign

Console is redesigned from "Market/Research Console" to "AVL Business & Infrastructure Console".

Console TARGET responsibilities:
- Customer, Contract, Sales, Revenue management
- Deployment, hosting metadata management
- System health monitoring (heartbeat reception)
- LINE Notification routing
- EA Registry (administrative)
- Audit logs, deployment logs
- AI Trader Builder (provisioning tool)
- Knowledge editorial (for package creation)

Console REMOVES from runtime dependencies:
- Central market data collection and distribution
- Real-time Knowledge API for customer AI Traders

See: [AVL_CONSOLE_TARGET.md](./AVL_CONSOLE_TARGET.md)

---

## 12. Execution Safety Requirements (Preserved from V1)

All execution safety from V1 Stages 1–7 is preserved:

```
✓ Customer/connection isolation
✓ Authenticated execution commands
✓ Command expiry
✓ Idempotency
✓ Duplicate prevention
✓ Broker symbol validation
✓ Account validation (DEMO/LIVE)
✓ Risk Engine gate
✓ Manual Approval mode
✓ Hard broker SL
✓ Favorable SL direction check
✓ Broker-confirmed FILLED required
✓ Broker-confirmed CLOSE required
✓ Position reconciliation
✓ Fail closed on any safety check failure
```

AI Trader does NOT directly command MT5. Canonical path:
```
AI Trader → Risk Engine → Owner Approval → execution_commands → Gateway → Bridge → MT5
```

---

## 13. Broker Independence

Target: any MT5-compatible broker supported.

```
Supported brokers (examples):
  XM (broker_symbol: GOLD#)
  Titan FX (broker_symbol: XAUUSD)
  FXGT (broker_symbol: GOLD)

Normalization:
  broker_symbol → canonical_symbol (GOLD) via symbol_specs mapping
  All internal references use canonical_symbol
  Execution commands use broker_symbol (from symbol_specs)
```

---

## 14. Customer Data Ownership

Each customer's data (market data, trade history, knowledge, AI analysis) belongs entirely to that customer's system:

```
Customer A Supabase:
  customer_bar_data (Customer A's MT5 bars)
  ai_traders, ai_positions, execution_commands (Customer A's trading)
  customer_knowledge (Customer A's AI knowledge)

Customer B Supabase:
  customer_bar_data (Customer B's MT5 bars — completely separate)
  ...

Customer systems are transferable:
  Customer GitHub + Vercel + Railway + Supabase can be transferred to customer ownership.
  All data remains with the customer's system.
```

---

## 15. Non-Functional Requirements

### 15-1. Self-Containment

Customer Trading View must operate without AVL Console during normal trading runtime.  
AVL Console is needed only for: provisioning, deployment, knowledge updates, monitoring.

### 15-2. Failure Isolation

LINE failure → no effect on trading safety.  
Console unavailable → no effect on customer AI Trader runtime (TARGET state).  
Bridge offline → execution blocked (not just degraded), chart uses last data.  
Gateway offline → execution blocked, reconnect triggers backfill.

### 15-3. Data Completeness

AI analysis must verify historical data completeness before running.  
Gaps in `customer_bar_data` → analysis fail closed, not silent degradation.

---

## 16. Stage 11 — AVL FX Website (Future Commercial Layer)

> **Stage 11 is NOT a completion blocker for Stage 10.**  
> V2 Stage 10 Final E2E PASS = Trading System Production Qualification.  
> Stage 11 begins AFTER Stage 10 is complete.

### 16-1. Stage 11 Scope Summary

Stage 11 adds the customer-facing commercial layer:

| Feature | Stage 11 |
|---------|---------|
| AVL FX Website (public) | ✅ New |
| Customer Application Form | ✅ New |
| Contract Workflow + E-Signature | ✅ New |
| Stripe Initial Payment | ✅ New |
| Stripe Recurring Billing | ✅ New |
| Console Order Intake | ✅ New |
| White Label Branding | ✅ New |
| Customer System Provisioning (automated) | ✅ New |
| Delivery Workflow + Secure Tokens | ✅ New |
| MT5 Connection Verification (server-side) | ✅ New |
| Managed Service Activation | ✅ New |
| Console Website CMS | ✅ New |
| LINE Business Notifications | ✅ New (extends V2 Stage 8) |

### 16-2. Three-System Architecture (Stage 11+)

```
CURRENT / V1 / V2 Stage 1-10:
  AVL FX Trading View  (Customer trading system)
  AVL FX Console       (AVL internal management)

V2 Stage 11+:
  AVL FX Trading View  (unchanged)
  AVL FX Console       (extended with CMS, Onboarding, Billing)
  AVL FX Website       (new — public acquisition + application entry)
```

### 16-3. Stage 11 Related Documents

```
docs/v2/AVL_FX_WEBSITE_ARCHITECTURE.md       — Website infrastructure + 3-system diagram
docs/v2/CUSTOMER_ONBOARDING_AND_DELIVERY.md  — Full customer journey + MT5 verification
docs/v2/WEBSITE_CMS_ARCHITECTURE.md          — CMS design (Console → Website content)
docs/v2/WHITE_LABEL_BRANDING.md              — White label configuration per customer
docs/v2/CONTRACT_AND_PAYMENT_ARCHITECTURE.md — Contract, e-signature, Stripe architecture
```

---

## 17. Compliance Boundary

```
COMPLIANCE REVIEW REQUIRED:
  This document describes technical architecture only.
  The regulatory implications of this service model under Japanese financial regulations
  (金融商品取引法 and related regulations) and other applicable jurisdictions must be
  confirmed by qualified legal/compliance specialists.
  
  This document does not claim that any specific service structure avoids or requires
  regulatory registration. Any commercial operation must undergo appropriate legal review.
```

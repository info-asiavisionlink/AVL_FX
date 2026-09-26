# AVL-FX — Customer AI Trader Builder / Configuration

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Revised:** 2026-09-26 — Architecture realignment: Customer System is canonical owner of AI Trader configuration  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

> **CANONICAL OWNERSHIP (confirmed final)**
>
> | Concern | Canonical Owner | Storage |
> |---------|----------------|---------|
> | AI Trader name, market, style | **Customer Trading System** | Customer Supabase |
> | Timeframe profile | **Customer Trading System** | Customer Supabase |
> | Risk profile (risk %, min RR, max positions) | **Customer Trading System** | Customer Supabase |
> | Knowledge selection / snapshot | **Customer Trading System** | Customer Supabase |
> | Execution mode, notification settings | **Customer Trading System** | Customer Supabase |
> | AI Trader Runtime | **Customer Trading System** | Customer Supabase → Runtime |
> | Template catalog / release history | Console (admin metadata) | Console Supabase |
> | Delivery / provisioning log | Console (admin metadata) | Console Supabase |
>
> **Console is an admin/provisioning tool. Console does NOT own AI Trader configuration or runtime.**  
> **Customer Trading View UI creates, configures, and stores AI Traders in Customer Supabase.**

---

## 1. Concept

### 1-1. Canonical Architecture: Customer System Owns AI Trader Configuration

**AI Trader configuration, Knowledge, Profile, and Runtime all live in Customer System.**

```
Customer Trading System (Customer Supabase):
  ai_traders
  ai_trader_versions
  ai_trader_timeframe_profiles
  ai_trader_risk_profiles
  ai_trader_notification_profiles
  customer_knowledge
  (all AI Trader runtime data)

AVL Console:
  Provisioning/Admin tool ONLY
  Does NOT run AI Trader runtime
  Does NOT make trading decisions
  Does NOT hold Customer AI Trader runtime data
```

### 1-2. Console Role: Provisioning / Admin Tool

The Console **AI Trader Builder** is an AVL admin tool that:

- Allows AVL admin to configure AI Trader parameters in Console UI
- Compiles a complete configuration package (including Knowledge Package)
- **Deploys the package to Customer Supabase** at provisioning time
- Has NO runtime role after deployment

After delivery:
- Customer AI Trader runtime reads ALL configuration from Customer Supabase (local)
- Customer AI Trader runtime does NOT call Console API during trading
- Console can update configuration via re-deployment (admin operation), not runtime injection

**Goal:** A new AI Trader is configured in Console, deployed to the customer's system. The customer system then operates independently.

### 1-3. What Changed from Earlier Design

| Aspect | Earlier (superseded) | Current (confirmed) |
|--------|---------------------|---------------------|
| AI Trader Knowledge at runtime | Console API fetch | Customer Supabase local read |
| AI Trader Profile storage | Console-managed | Customer Supabase |
| AI Trader Builder | Console-side feature | Console provisioning tool (admin only) |
| Runtime dependency | Console required | Zero runtime Console dependency |
| Configuration canonical home | Console | Customer System |

See: [CUSTOMER_KNOWLEDGE_ARCHITECTURE.md](./CUSTOMER_KNOWLEDGE_ARCHITECTURE.md)

---

## 2. AI Trader Package Model

An AI Trader in V2 is a complete configuration package stored in the database:

```
AI Trader Package
├── Identity
│     name, description, market, public_id, status
│
├── Timeframe Profile (V2 new)
│     timeframe_style: SCALPING | DAY_TRADING | SWING
│     macro_context_timeframes[]
│     trend_context_timeframes[]
│     setup_timeframes[]
│     entry_timeframes[]
│     management_timeframes[]
│     monitor_interval_minutes
│
├── Trading Configuration (extends V1)
│     trading_style: TREND_FOLLOWING | BREAKOUT | REVERSAL | PRICE_ACTION | ...
│     personality: CONSERVATIVE | BALANCED | AGGRESSIVE
│     entry_patience: VERY_PATIENT | PATIENT | NORMAL | AGGRESSIVE
│     news_sensitivity: HIGH | MEDIUM | LOW
│
├── Knowledge Profile (V2 enhanced)
│     knowledge_by_category: { category: boolean }
│     selected_knowledge_ids: UUID[]
│     (mapped to ai_trader_knowledge table)
│
├── Risk Profile (V2 new)
│     risk_per_trade_percent
│     minimum_rr
│     max_positions
│     max_daily_risk_percent (optional)
│
├── Execution Policy
│     execution_mode: MANUAL_APPROVAL | AUTONOMOUS
│     (AUTONOMOUS: DEMO only — enforced by Risk Engine)
│
├── Notification Policy
│     per-type ON/OFF for each NotificationEventType
│     (maps to notification_preferences defaults)
│
└── Runtime Schedule
      monitor_interval_minutes (from Timeframe Profile)
      active_sessions: [] (optional: trading hours restriction)
```

---

## 3. Console Builder UI Design

### 3-1. Page Layout

```
Console → AI Traders → [New AI Trader]

┌─────────────────────────────────────────────────────────────┐
│  AI Trader Builder                              [Save Draft] │
│                                                [Activate]    │
├─────────────────────────────────────────────────────────────┤
│  Step 1: Identity                                           │
│  Step 2: Trading Style                                      │
│  Step 3: Timeframe Profile                                  │
│  Step 4: Knowledge Selection                                │
│  Step 5: Risk Profile                                       │
│  Step 6: Execution & Notifications                          │
│  Step 7: Review & Confirm                                   │
└─────────────────────────────────────────────────────────────┘
```

### 3-2. Step 1 — Identity

```
Name           [GOLD Day Trader                          ]
Description    [AI trader for GOLD intraday opportunities]
Market         [GOLD ▼]  (GOLD, USDJPY, EURUSD, ...)
Status         [DRAFT] → manual activation to ACTIVE
```

### 3-3. Step 2 — Trading Style

```
Timeframe Style  (determines WHEN)
  (•) DAY_TRADING  — Intraday, H1/M5 typical
  ( ) SCALPING     — Short-term, M5/M1
  ( ) SWING        — Multi-day, D1/H4

Trading Style  (determines HOW to identify entries)
  (•) TREND_FOLLOWING
  ( ) BREAKOUT
  ( ) REVERSAL
  ( ) PRICE_ACTION
  ( ) MULTI_TIMEFRAME
  ( ) HYBRID

Personality
  ( ) CONSERVATIVE
  (•) BALANCED
  ( ) AGGRESSIVE

Entry Patience
  ( ) VERY_PATIENT
  (•) PATIENT
  ( ) NORMAL
  ( ) AGGRESSIVE

News Sensitivity
  ( ) HIGH
  (•) MEDIUM
  ( ) LOW
```

### 3-4. Step 3 — Timeframe Profile

```
Timeframe Profile

[Load defaults from style]  ← auto-fills from Step 2 selection

Macro Context    [MN] [W1] [D1] [H4] [H1] [M15] [M5] [M1]
                  □    □    □   ☑   □    □    □    □

Trend Context    □    □    □   ☑   ☑    □    □    □
                                (H4, H1)

Setup            □    □    □    □   □   ☑   ☑    □
                                        (M15, M5)

Entry            □    □    □    □   □    □   ☑    □
                                            (M5)

Management       □    □    □    □   □   ☑    □    □
                                       (M15)

Monitor Interval [ 5 ] minutes
```

### 3-5. Step 4 — Knowledge Selection

Reads from Console `trading_knowledge` table (ACTIVE records only) for package compilation.  
Selected items are compiled into a **Knowledge Package** deployed to Customer Supabase (not fetched at runtime).  
See: [CUSTOMER_KNOWLEDGE_ARCHITECTURE.md](./CUSTOMER_KNOWLEDGE_ARCHITECTURE.md)

```
Knowledge Sources

Category Filter:
  ☑ Market Structure      → [show items]
  ☑ Trend Analysis        → [show items]
  ☑ Price Action          → [show items]
  ☑ Indicators            → [show items]
  ☐ Risk Management       → [show items]
  ☑ Session               → [show items]
  ☑ News & Events         → [show items]
  ☐ Psychology            → [show items]
  ☐ General               → [show items]

Market Filter:
  [GOLD ▼]  (filter knowledge items by relevant market)

Individual Selection:
  Within each expanded category, show individual knowledge items:
  ☑ [EMA Strategy for GOLD] (version 3) — Market: GOLD, TF: H1,M5
  ☑ [RSI Divergence Signals] (version 2) — Market: GOLD, TF: H4
  ☐ [Fundamentals Overview] (version 1) — Market: ALL

Selected: 12 items across 5 categories
```

### 3-6. Step 5 — Risk Profile

```
Risk Profile

Risk per Trade
[ 1.00 ] %
(Maximum: 5.00% — system cap enforced by Risk Engine)

Minimum Risk/Reward Ratio
[ 2.0 ] : 1

Maximum Open Positions
[ 1 ]

Maximum Daily Risk %  (optional override)
[ 3.00 ] %  (leaves empty to use system default)
```

### 3-7. Step 6 — Execution & Notifications

```
Execution Policy
(•) MANUAL_APPROVAL  — Customer approves each entry in Trading View
( ) AUTONOMOUS       — Auto-execute (DEMO accounts only)

Default Notification Policy
  ☑ H1 Scenario Updated
  ☑ AI Analysis Changed
  ☑ Entry Watch Started
  ☑ Entry Candidate
  ☑ Owner Approval Required
  ☑ Order Filled
  ☐ Position Updated
  ☑ SL Modified
  ☑ TP Modified
  ☑ Position Closed
  ☐ Trade Review Ready
  ☑ System Warning

(Customer can override these defaults in Trading View settings)
```

### 3-8. Step 7 — Review

Full summary of all configurations before save.  
Shows: profile completeness check, knowledge count, timeframe validation.  
Warnings: empty knowledge selection, conflicting timeframes, etc.

---

## 4. Knowledge Selection Architecture

### 4-1. Existing V1 Knowledge Taxonomy

From `src/lib/knowledgeSchema.ts` (confirmed existing):

```typescript
KNOWLEDGE_CATEGORIES = [
  "Market Structure",
  "Trend Analysis",
  "Price Action",
  "Indicators",
  "Risk Management",
  "Session",
  "News & Events",
  "Psychology",
  "General",
]

KNOWLEDGE_MARKETS = [
  "GOLD", "USDJPY", "EURUSD", "GBPUSD", "AUDUSD",
  "EURJPY", "GBPJPY", "SILVER", "US30", "US500",
]

KNOWLEDGE_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]
```

**V2 Knowledge selection uses the actual existing taxonomy above.** No hypothetical categories.

### 4-2. Knowledge Profile Storage

```
At AI Trader creation:
  Selected knowledge IDs → ai_trader_knowledge table (V1 existing)
  { ai_trader_version_id, knowledge_id, knowledge_version }

At analysis time:
  selectKnowledgeForTrader() (V1 existing function) reads ai_trader_knowledge
  + filters by market, timeframe, category priority
  → ai_analysis_logs.knowledge_snapshot records exact knowledge used
```

### 4-3. Knowledge Snapshot for Auditability

V1 already stores `knowledge_snapshot` in `ai_analysis_logs`:
```json
{
  "id": "...",
  "version": 3,
  "title": "EMA Strategy for GOLD",
  "category": "Indicators"
}
```

V2 enhances: snapshot also records `timeframe_profile_version` and `risk_profile_version` used.

Query: "Which knowledge did this trader use for this decision?" → audit `ai_analysis_logs.knowledge_snapshot`.

**Chain-of-thought is NOT stored** (V1 policy, preserved in V2).

---

## 5. Console Builder API Design

> **These endpoints are on the Console server (admin-only provisioning).  
> They are NOT Customer Trading View runtime endpoints.  
> Customer AI Trader reads from Customer Supabase after deployment — no Console API call at runtime.**

```
POST   /api/traders                          Create new AI Trader + first version (Console admin)
PUT    /api/traders/{id}/versions            Create new version (settings change)
GET    /api/traders/{id}                     Get trader with current version
GET    /api/traders/{id}/versions            List all versions
POST   /api/traders/{id}/activate           DRAFT → ACTIVE
POST   /api/traders/{id}/archive            ACTIVE → ARCHIVED

POST   /api/traders/{id}/knowledge          Set knowledge selection for version
GET    /api/traders/{id}/knowledge          Get current knowledge selection

POST   /api/traders/{id}/timeframe-profile  Set timeframe profile for version
POST   /api/traders/{id}/risk-profile       Set risk profile for version
POST   /api/traders/{id}/notification-policy Set notification defaults

POST   /api/traders/{id}/deploy             Compile + deploy to Customer Supabase
                                             (creates Knowledge Package, deploys all profiles)
GET    /api/traders/{id}/deploy-status      Check deployment status
```

All endpoints: admin-only (isAdmin check). Console middleware enforced.

The `/deploy` endpoint triggers compilation of the Knowledge Package and deployment of all profile data to the Customer's Supabase project.  
After `/deploy` completes, Customer AI Trader runtime operates independently (no Console dependency).

**Runtime boundary: Customer Trading View NEVER calls these Console endpoints during trading.**

---

## 6. Customer Trading View Integration

### 6-1. How Customers Use Configured Traders (POST-V1)

Customer Trading View reads ALL configuration from **Customer Supabase** (no Console call at runtime):
1. `ai_traders` + `ai_trader_versions` (existing V1 tables)
2. `ai_trader_timeframe_profiles` (new table — deployed by Builder)
3. `customer_knowledge` (new table — Knowledge Package deployed by Builder)
4. `ai_trader_risk_profiles` (new table — deployed by Builder)

The Customer Trading View server reads the full profile on startup or trader activation. No Console API call during analysis or execution.

### 6-2. Customer Customization Scope (POST-V1)

Customers can modify in Trading View Settings:
- `risk_per_trade_percent` (within hard caps)
- Notification preferences (ON/OFF per type)
- Execution policy display (MANUAL_APPROVAL always available)

Customers cannot modify (requires AVL admin via Console Builder):
- Timeframe profile
- Knowledge package selection and content
- Strategy configuration
- Indicator configuration
- Trading style

### 6-3. What "CURRENT V1" Customers Experience

CURRENT V1 customers call Console `/api/trading-knowledge` at runtime.  
This behavior is preserved during migration (fallback in selectKnowledgeForTrader).  
Migration to customer_knowledge local read happens during M5 (Knowledge Localization stage).  
The customer does not need to change anything — migration is transparent.

---

## 7. Relationship to V1

V1 `ai_trader_versions` already has:
- `personality`, `trading_style`, `risk_profile`, `entry_patience`, `news_sensitivity`

V2 extends with new tables (does not modify `ai_trader_versions`):
- `ai_trader_timeframe_profiles` — replaces hardcoded H1/M5
- `ai_trader_risk_profiles` — adds `risk_per_trade_percent`, `minimum_rr`
- `ai_trader_notification_profiles` — notification defaults per trader

V1 `ai_trader_knowledge` (existing) already links traders to knowledge items.  
V2 adds Console UI to manage this relationship without direct DB access.

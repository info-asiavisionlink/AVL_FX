# AVL-FX — AVL Console Target Architecture

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Console Role Change

### 1-1. CURRENT V1 Console Role

```
CURRENT (V1):
  - Customer Management
  - Contract Management
  - Historical Market Data (GOLD OHLC bar_data)
  - Research / Backtest API
  - Knowledge Management (trading_knowledge)
  - Strategy Registry
  - Gateway Data Collection
  - EA Registry
  - Monitoring / Health
```

### 1-2. TARGET Console Role

```
TARGET (POST-V1):
  AVL Business & Infrastructure Console
  
  KEEPS:
  - Customer Management
  - Contract Management
  - Sales / Revenue Tracking
  - Billing / Payment Status
  - Deployment Management
  - System Health Monitoring
  - Customer Infrastructure Metadata
  - EA Registry (as administrative registry, not runtime dependency)
  - Monitoring / Heartbeat reception
  - LINE Notification Service (central routing)
  - Audit Logs
  - Support / Maintenance history

  REMOVES (as runtime dependencies):
  - Central GOLD/OHLC Market Data collection
  - Central Market Data Service
  - Customer Trading View market data distribution
  - Runtime Knowledge API (real-time fetch during trading)
  - Research API as required runtime dependency

  MOVES TO CUSTOMER SYSTEM:
  - AI Knowledge (localized to Customer Supabase)
  - AI Trader Builder output (delivered to Customer system)
  - Market Data (Customer MT5 → Customer Gateway → Customer Supabase)
```

The Console becomes an **infrastructure and business management tool**, not a market data or AI Knowledge provider.

---

## 2. TARGET Console Dashboard

### 2-1. Customer Management

```
Customers
├── Customer List
│     ├── customer_name
│     ├── contract_type
│     ├── monthly_fee
│     ├── payment_status (CURRENT / OVERDUE / PENDING)
│     ├── active / inactive
│     └── contract_start / contract_end
│
├── Customer Detail
│     ├── Contact information
│     ├── Contract terms
│     ├── Billing history
│     └── Deployment records
```

### 2-2. System Management

```
Systems (per customer)
├── Trading View
│     ├── Vercel project name
│     ├── Vercel deployment URL
│     ├── deployment_status (DEPLOYED / NEEDS_UPDATE / ERROR)
│     └── last_deployed_at
│
├── Gateway
│     ├── Railway project / service name
│     ├── Railway deployment URL
│     ├── gateway_status (ONLINE / OFFLINE / DEGRADED)
│     └── last_heartbeat_at
│
├── Supabase
│     ├── Project name / reference
│     ├── region
│     └── storage_usage (if available via Supabase API)
│
├── MT5 Bridge
│     ├── bridge_status (ONLINE / OFFLINE / RECONNECTING)
│     ├── last_heartbeat_at
│     ├── connected_broker
│     └── account_mode
│
└── Domain
      ├── domain_name
      ├── dns_status
      └── ssl_status
```

### 2-3. Runtime Health

```
Health Overview (per customer system)
├── system_status: HEALTHY / DEGRADED / OFFLINE
├── gateway_last_heartbeat
├── bridge_last_heartbeat
├── mt5_connection_status
├── supabase_connectivity (ping result)
└── last_incident
```

**Note:** Health status is infrastructure monitoring only. Console does NOT receive market prices, trade decisions, or position data from customer systems for analysis purposes.

### 2-4. LINE Notification Management

```
LINE
├── Customer LINE link status (linked / unlinked)
├── Last notification sent
├── Notification delivery log
├── Delivery failure report
└── LINE official account status
```

### 2-5. Business Dashboard

```
Business Overview
├── Monthly Recurring Revenue (MRR)
│     ├── by contract type
│     └── by status (active / churn)
│
├── Revenue by Category
│     ├── System Development
│     ├── System Sales
│     ├── Monthly System Management
│     └── Other
│
├── Active Systems
├── Pending Deployments
├── Overdue Payments
└── Recent Contracts
```

### 2-6. Deployment Management

```
Deployments
├── Deployment history (git SHA, timestamp, deployer, result)
├── Pending deployment tasks
├── Migration history
├── Environment change log
└── Rollback history
```

---

## 3. What Console Does NOT Do (TARGET)

```
Console DOES NOT:
  ✗ Collect or store customer market prices (OHLC, ticks)
  ✗ Distribute GOLD prices to customer Trading Views
  ✗ Run AI analysis on customer behalf
  ✗ Store customer trade positions for AI purposes
  ✗ Provide real-time Knowledge API that customer AI Trader calls during trading
  ✗ Access customer MT5 account data (except what customer sends as health heartbeat)
  ✗ Execute trades on behalf of customers
  ✗ Mediate market data between customers
  ✗ Act as central trading infrastructure for customers

These functions belong to each Customer's own system.
```

---

## 4. Knowledge Architecture in TARGET Console

### 4-1. CURRENT V1 Knowledge Flow

```
CURRENT:
  Console trading_knowledge → Console /api/trading-knowledge
  → Customer Trading View /api/knowledge proxy
  → AI Trader runtime analysis (real-time fetch)
```

### 4-2. TARGET Knowledge Flow

```
TARGET:
  Console Knowledge Editor (optional AVL tool)
  → Knowledge Package created
  → Knowledge Package exported / deployed to Customer Supabase
  → Customer AI Trader reads from local Customer Supabase
  → No runtime dependency on Console Knowledge API
```

Console retains `trading_knowledge` table as an **editorial/authoring tool** for AVL to manage knowledge content. However, at runtime, the AI Trader does not call Console. Knowledge is localized to the customer's system at deployment time.

See: [CUSTOMER_KNOWLEDGE_ARCHITECTURE.md](./CUSTOMER_KNOWLEDGE_ARCHITECTURE.md)

---

## 5. EA Registry (Retained in Console)

The Console `ea_registry` table is retained as an administrative registry:
- Records EA versions deployed to customers
- Contains share codes for customer deployment
- Is NOT a runtime dependency (customers do not query this during trading)

EA update workflow:
```
AVL builds new EA version
→ Register in ea_registry (Console)
→ Deploy to customer's MT5 (operational task, tracked in deployment log)
→ Customer validates on test account
→ Production deployment
```

---

## 6. V1 Legacy Market-Data Infrastructure (NOT PART OF V2 TARGET RUNTIME)

### 6-1. CURRENT V1 (Historical Record)

V1 Console held:
- `bar_data` table (Console Supabase) — historical OHLC
- `AVL_Console_DataManager.ex5` — MT5 EA for market data collection
- Research API (`/api/research/bars`) — served bar data to Customer Trading View backtest
- Console Gateway — received ticks/bars from DataManager EA

### 6-2. V2 TARGET

**None of the above are part of V2 Customer Trading System runtime.**

```
V2 CONFIRMED:
  Console does NOT collect market prices, OHLC, or ticks for Customer AI Trader
  Console DataManager EA is V1 LEGACY — NOT V2 TARGET
  Console bar_data table is V1 LEGACY — NOT used by V2 Customer Trading System
  Console Research API is V1 LEGACY — NOT a V2 Customer Trading System runtime dependency

V2 Customer Trading System:
  Source of Truth = Customer MT5
  Customer MT5 → Unified Bridge → Customer Gateway → Customer Supabase (customer_bar_data)
  All historical data, chart data, and AI analysis uses customer_bar_data

Decommission plan:
  Console DataManager EA: decommission separately (operational decision, not V2 stage requirement)
  Console Research API: retain as read-only V1 legacy; remove after customer_bar_data verified sufficient
  Console bar_data: retain as historical archive; no longer written to by V2 architecture
  
Physical removal of V1 legacy code/tables: separate operational approval, not in V2 Stage plan
```

---

## 7. LINE Notification Service (Stays in Console)

The LINE Notification Service remains in Console because:
1. Console holds AVL's LINE Channel Access Token (AVL-owned)
2. Notification routing is AVL infrastructure (not customer-specific)
3. Customer Trading View does not need to hold LINE credentials

```
LINE flow in TARGET:
  Customer Trading View (any) → POST /notification-event → AVL Notification API
  AVL Notification API (Console) → customer_id lookup → line_user_id → LINE Messaging API
```

Console is the LINE routing hub, but does NOT generate trading decisions. It routes events from customer systems.

See: [LINE_NOTIFICATION_ARCHITECTURE.md](./LINE_NOTIFICATION_ARCHITECTURE.md)

---

## 8. Monthly Management Service Architecture

### 8-1. Service Components (TARGET)

```
Monthly System Management (infrastructure):
  ├── Vercel hosting and management
  ├── Railway Gateway hosting and management
  ├── Supabase database hosting and management
  ├── System monitoring and alerting
  ├── Security updates
  ├── Backup management
  ├── EA update deployment support
  ├── LINE notification infrastructure
  └── Deployment support

Note: "management" means infrastructure operations.
      AVL does not make trading decisions on behalf of customers.
      Customer's AI Trader runs on Customer's system using Customer's MT5.
```

### 8-2. Compliance Boundary Note

```
COMPLIANCE BOUNDARY (for documentation, not legal advice):

  System Development:         AVL designs and builds customer trading systems
  System Delivery:            Customer receives their own Vercel/Railway/Supabase/MT5 system
  Infrastructure Management:  AVL manages hosting, updates, monitoring (infrastructure only)
  AI Trader:                  Runs on customer's own system, using customer's own MT5/broker
  Trading Decisions:          AI Trader generates decisions on customer's system
  Execution:                  Customer approves (MANUAL mode) or DEMO autonomous (customer system)
  Data Ownership:             Market data, trade history belong to customer's system

  COMPLIANCE REVIEW REQUIRED:
    The above architecture is intended to describe technical responsibilities only.
    Whether this service structure is subject to financial services regulations in Japan
    (including the Financial Instruments and Exchange Act / 金融商品取引法) or other
    jurisdictions must be confirmed by a qualified legal/compliance specialist with
    knowledge of Japanese financial regulations.

    This document does NOT claim or guarantee that any specific regulatory registration
    is or is not required. AVL must obtain appropriate legal review before commercial
    operation of this service.
```

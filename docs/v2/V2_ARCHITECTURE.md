# AVL-FX — POST-V1 Target Architecture

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE — V1 Stage 10-C SUSPENDED; V2 implementation starts now  
**Created:** 2026-09-26  
**Revised:** 2026-09-26 — Customer Self-Contained Architecture  

---

## 1. Architecture Principle

> **Customer Self-Contained Architecture**
>
> Each Customer's system is self-contained.  
> Customer AI Trader does NOT depend on AVL Console at runtime for market data or knowledge.  
> Customer MT5 is the canonical market data and execution price source for that Customer.

---

## 2. Diagram A — AVL-FX Full System (TARGET)

```mermaid
graph TB
    subgraph AVL_CONSOLE["AVL Console — Business & Infrastructure Management"]
        CON_UI["Console UI\n(Customer Mgmt, Provisioning Tool,\nKnowledge Editor, Deployment)"]
        CON_DB["Console Supabase\n(customers, contracts, ea_registry,\ntrading_knowledge editorial)"]
        CON_NOTIF["Notification Service\n(LINE routing)"]
        LINE["LINE AVL AI\n(Official Account)"]

        CON_UI --- CON_DB
        CON_NOTIF --> LINE
    end

    subgraph CUST_A["Customer A System (XM Broker)"]
        A_MT5["Customer A MT5\n(XM, GOLD#)"]
        A_EA["Unified Bridge EA\nMarket Data + Execution"]
        A_GW["Customer A Gateway\n(Railway)"]
        A_DB["Customer A Supabase\ncustomer_bar_data\ncustomer_knowledge\nai_traders\npositions"]
        A_TV["Customer A Trading View\n(Vercel)\nChart + AI Trader + Approval"]
        A_LINE["Customer A LINE"]

        A_MT5 -->|OHLC bars, tick, account, specs| A_EA
        A_EA -->|bar persistence, heartbeat| A_GW
        A_GW -->|idempotent upsert| A_DB
        A_DB -->|historical bars + knowledge| A_TV
        A_GW -->|realtime WebSocket| A_TV
        A_TV -->|approval + risk engine| A_GW
        A_GW -->|execution command| A_EA
        A_EA -->|OrderSend| A_MT5
    end

    subgraph CUST_B["Customer B System (Titan FX Broker)"]
        B_MT5["Customer B MT5\n(TitanFX, XAUUSD)"]
        B_EA["Unified Bridge EA"]
        B_GW["Customer B Gateway"]
        B_DB["Customer B Supabase"]
        B_TV["Customer B Trading View"]
        B_LINE["Customer B LINE"]

        B_MT5 --> B_EA --> B_GW --> B_DB --> B_TV
        B_TV --> B_GW --> B_EA --> B_MT5
    end

    CON_UI -->|deploy AI Trader config + Knowledge Package| A_DB
    CON_UI -->|deploy AI Trader config + Knowledge Package| B_DB
    CON_UI -->|infrastructure monitoring| A_GW
    CON_UI -->|infrastructure monitoring| B_GW

    A_TV -->|notification event| CON_NOTIF
    B_TV -->|notification event| CON_NOTIF
    CON_NOTIF --> A_LINE
    CON_NOTIF --> B_LINE
```

---

## 3. Diagram B — Customer Market Data Lifecycle (TARGET)

```mermaid
flowchart TD
    MT5["Customer MT5\n(broker: e.g., XM)"]
    EA_MKT["Unified Bridge EA\nMarket Data Module"]
    EA_HIST["Unified Bridge EA\nHistorical Data Module"]
    GW["Customer Gateway"]
    VAL["Gateway Validation\n- bar identity\n- timestamp normalization\n- symbol canonicalization"]
    DB["Customer Supabase\ncustomer_bar_data"]
    TV["Customer Trading View\nAPI Server"]
    CHART["Chart\n(historical bars)"]
    IND["Indicators\n(EMA, RSI, etc.)"]
    AI["AI Trader Runtime\n(reads from Customer Supabase)"]
    RT["Realtime current bar\n(WebSocket — not stored until close)"]

    MT5 -->|OnBarClose: OHLC per timeframe| EA_MKT
    MT5 -->|OnTick: bid, ask, spread| EA_MKT
    EA_MKT -->|POST /market-data/bars| GW
    GW --> VAL
    VAL -->|idempotent upsert| DB
    DB --> TV
    TV --> CHART
    TV --> IND
    DB --> AI

    MT5 -->|CopyRates on reconnect| EA_HIST
    EA_HIST -->|batch backfill| GW

    EA_MKT -->|WebSocket tick/forming bar| RT
    RT --> CHART
```

---

## 4. Diagram C — Historical Recovery on Reconnect

```mermaid
flowchart TD
    A["Bridge EA reconnects"] --> B["GET /market-data/last-bar\n{connection_id, symbol, timeframe}"]
    B --> C["Gateway: SELECT MAX(time_utc) FROM customer_bar_data"]
    C --> D{"Gap detected?"}
    D -->|No gap| E["Realtime mode\nbar close events"]
    D -->|Gap exists| F["Compute missing range\nlast_bar+1 → latest closed bar"]
    F --> G["MT5 CopyRates\nbatch ≤ 500 bars"]
    G --> H["POST /market-data/backfill\nsource=bridge_recovery"]
    H --> I["Gateway: idempotent upsert\nON CONFLICT DO NOTHING/UPDATE"]
    I --> J{"More gaps?"}
    J -->|Yes| G
    J -->|No| K["Log backfill summary\ngaps_filled, bars_inserted"]
    K --> E
```

---

## 5. Diagram D — Execution Path (Unchanged from V1)

```mermaid
flowchart TD
    AI["AI Trader\n(Customer Trading View Server)"]
    RISK["Risk Engine\n- equity check\n- symbol spec check\n- lot calculation\n- daily limits"]
    APPR["Owner Approval\n(MANUAL_APPROVAL mode)"]
    CMD["execution_commands table\n(Customer Supabase)"]
    GW["Customer Gateway"]
    EA_EX["Unified Bridge EA\nExecution Module\n(EA-side final validation)"]
    MT5["Customer MT5"]
    BROKER["Broker\n(fill)"]
    FILL["Fill confirmation\nPOST /execution/fill-result"]
    POS["ai_positions updated\nto OPEN"]

    AI -->|decision: ENTER_LONG/SHORT| RISK
    RISK -->|APPROVED + lot + translated SL/TP| APPR
    APPR -->|approved| CMD
    CMD --> GW
    GW --> EA_EX
    EA_EX -->|EA validation passes| MT5
    MT5 --> BROKER
    BROKER -->|OrderSend result| MT5
    MT5 --> FILL
    FILL --> GW
    GW --> POS
```

---

## 6. Diagram E — LINE Notification Flow

```mermaid
flowchart TD
    TV["Customer Trading View\n(any customer)"]
    EVT["Notification Event\n{event_type, customer_id, payload}"]
    NOTIF["AVL Notification Service\n(Console server-side)"]
    MAP["customer_line_links\nlookup + preference check\ndeduplication"]
    LINE_API["LINE Messaging API"]
    LINE["Customer LINE App"]
    DEEP["Deep link → Trading View\n(authenticated)"]

    TV -->|POST /notification-event| EVT
    EVT --> NOTIF
    NOTIF --> MAP
    MAP -->|line_user_id resolved| LINE_API
    LINE_API --> LINE
    LINE -->|tap notification| DEEP
    DEEP --> TV

    note1["LINE failure:\n→ delivery logged FAILED\n→ trading safety UNAFFECTED"]
```

---

## 7. Component Responsibilities

### 7-1. AVL Console (TARGET)

| Responsibility | Status |
|---------------|--------|
| Customer / Contract / Revenue management | ✅ Retained |
| Deployment / infrastructure metadata | ✅ Retained |
| System health monitoring (heartbeat reception) | ✅ Retained |
| LINE Notification routing | ✅ Retained |
| AI Trader Builder (provisioning tool) | ✅ Retained (role clarified) |
| Knowledge editorial (for package creation) | ✅ Retained |
| EA Registry (administrative) | ✅ Retained |
| Central GOLD OHLC collection | ❌ REMOVED from TARGET |
| Real-time Knowledge API for customer AI Trader | ❌ REMOVED from TARGET |
| Customer market data distribution | ❌ REMOVED from TARGET |

### 7-2. Customer Unified Bridge EA

| Module | Responsibility |
|--------|---------------|
| Connection Module | Auth, reconnect, heartbeat |
| Market Data Module | OnTick, OnBarClose → Gateway |
| Historical Data Module | CopyRates, backfill on reconnect |
| Symbol Specification Module | MT5 symbol specs → Gateway |
| Account Module | equity, balance, margin → Gateway heartbeat |
| Position Module | position snapshot → Gateway |
| Deal/History Module | deal notifications → Gateway |
| Execution Module | command reception, OrderSend, fill confirmation |

### 7-3. Customer Gateway

| Responsibility | Notes |
|---------------|-------|
| Market data persistence | Validates + upserts to customer_bar_data |
| Last bar query | GET /market-data/last-bar for backfill coordination |
| Execution command management | GET /execution/pending-commands for Bridge |
| Fill/close result reception | POST /execution/fill-result → ai_positions |
| WebSocket server | Realtime chart data to Trading View |
| Heartbeat reception | Account + Bridge health data |
| Symbol spec reception | Updates symbol_specs table |
| Health reporting | To Console monitoring |

### 7-4. Customer Trading View

| Responsibility | Notes |
|---------------|-------|
| Chart | From customer_bar_data + WebSocket |
| Indicators | From customer_bar_data (same source as Chart) |
| AI Trader Runtime | Reads customer_bar_data + customer_knowledge |
| Risk Engine | Server-side, pre-execution validation |
| Manual Approval UI | Customer approves/rejects entries |
| LINE settings | Link/unlink, preferences |
| Notification event emission | To Console Notification Service |

---

## 8. CURRENT V1 vs TARGET POST-V1

### 8-1. Market Data

| Aspect | CURRENT V1 | TARGET POST-V1 |
|--------|-----------|----------------|
| AI analysis price source | Console bar_data (via Research API) | Customer Supabase customer_bar_data |
| Chart price source | Console bar_data + Customer Bridge realtime | Customer Supabase + Customer MT5 WebSocket |
| Market data persistence | Console Supabase (AVL-owned) | Customer Supabase (Customer-owned) |
| Broker price used | Console broker (XM central) | Customer's own broker |
| Customer independence | Depends on Console market data | Self-contained |

### 8-2. Knowledge

| Aspect | CURRENT V1 | TARGET POST-V1 |
|--------|-----------|----------------|
| Knowledge storage | Console Supabase | Console (authoring) + Customer Supabase (runtime) |
| Runtime knowledge access | Console API fetch at analysis time | Customer Supabase local read |
| Console dependency at runtime | YES | NO (zero runtime dependency) |
| Knowledge audit | knowledge_snapshot in ai_analysis_logs | Same, referencing customer_knowledge |

### 8-3. EA Architecture

| Aspect | CURRENT V1 | TARGET POST-V1 |
|--------|-----------|----------------|
| EA count per customer | 2 (Bridge + ExecutionBridge) | 1 (Unified Bridge) |
| Market data EA | AVL_FX_Bridge.ex5 | Unified Bridge Market Data Module |
| Execution EA | AVL_ExecutionBridge.ex5 | Unified Bridge Execution Module |
| Execution safety | Full V1 safety | Same safety, maintained |

### 8-4. Console Role

| Aspect | CURRENT V1 | TARGET POST-V1 |
|--------|-----------|----------------|
| Market data role | Collects + distributes | None (removed) |
| Knowledge role | Runtime provider | Editorial/authoring + package deployer |
| AI Trader role | N/A (V1) | Provisioning builder |
| Business role | Limited | Primary dashboard |

---

## 8. V2 Stage 11+ Future Architecture (Three-System)

> This section describes the Stage 11+ target. It does NOT affect Stage 1-10 Trading System completion.  
> V2 Stage 10 Final E2E PASS is required before Stage 11 begins.

```mermaid
graph TB
    subgraph WEB11["AVL FX Website (Stage 11+)"]
        WEB_UI["Public Website\n(Marketing, Application Form,\nContract, Payment)"]
        WEB_API["Website Server\n(Application, Stripe, Delivery)"]
        WEB_DB["Website Supabase\n(applications, contracts, payments)"]
        STRIPE["Stripe"]
        WEB_API --> WEB_DB
        WEB_API --> STRIPE
    end

    subgraph CON11["AVL FX Console (extended Stage 11)"]
        CON_CMS["Website CMS\n(Hero, Features, FAQ, Legal)"]
        CON_CRM["CRM\n(Customers, Contracts,\nBilling, Orders)"]
        CON_PROV["Provisioning\n(White Label, Knowledge Package,\nAI Trader Builder)"]
        CON_DB["Console Supabase\n(customers, CMS content,\ntrading_knowledge)"]
        CON_NOTIF["Notification Service\n(LINE routing)"]
    end

    subgraph TV_CUST["Customer Trading View (Stage 1-10 unchanged)"]
        TV_AI["AI Trader\n(Customer Self-Contained)"]
        TV_DB["Customer Supabase\n(customer_bar_data,\ncustomer_knowledge, branding)"]
        TV_GW["Customer Gateway"]
        TV_EA["Unified Bridge EA"]
        TV_MT5["Customer MT5\n(Source of Truth)"]
        TV_AI --- TV_DB
        TV_GW --> TV_EA --> TV_MT5
    end

    WEB_UI -->|Application| WEB_API
    WEB_API -->|New order| CON_CRM
    CON_PROV -->|Deploy config + knowledge| TV_DB
    CON_PROV -->|Setup gateway| TV_GW
    CON_CMS -->|CMS content API| WEB_UI
    TV_AI -->|Notification event| CON_NOTIF
    CON_NOTIF --> LINE_LINE["LINE AVL AI → Customer LINE"]
    WEB_API -->|MT5 verification| TV_GW
```

**Stage 11 adds Website and expands Console. Trading View (Stage 1-10) is unchanged.**

---

## 9. Related Documents

| Document | Content | Status |
|---------|---------|--------|
| [V2_REQUIREMENTS.md](./V2_REQUIREMENTS.md) | Full POST-V1 requirements | Updated |
| [V2_FINAL_E2E_GATE.md](./V2_FINAL_E2E_GATE.md) | Final production gate (migrated from V1 Stage 10-C) | New |
| [CUSTOMER_MARKET_DATA_ARCHITECTURE.md](./CUSTOMER_MARKET_DATA_ARCHITECTURE.md) | Customer bar data schema, backfill, retention | New |
| [UNIFIED_MT5_BRIDGE.md](./UNIFIED_MT5_BRIDGE.md) | Unified Bridge EA module design | New |
| [CUSTOMER_KNOWLEDGE_ARCHITECTURE.md](./CUSTOMER_KNOWLEDGE_ARCHITECTURE.md) | Knowledge localization, package model | New |
| [AVL_CONSOLE_TARGET.md](./AVL_CONSOLE_TARGET.md) | Console Business/Infrastructure role | New |
| [LINE_NOTIFICATION_ARCHITECTURE.md](./LINE_NOTIFICATION_ARCHITECTURE.md) | LINE linking, routing, security | Unchanged |
| [DYNAMIC_POSITION_SIZING.md](./DYNAMIC_POSITION_SIZING.md) | Lot calculation, Risk Engine | Minor update |
| [AI_TRADER_PROFILE.md](./AI_TRADER_PROFILE.md) | Trading styles, timeframe roles | Unchanged |
| [AI_TRADER_BUILDER.md](./AI_TRADER_BUILDER.md) | Console provisioning tool | Minor update |
| [V2_SECURITY_AND_FAILURE_SEMANTICS.md](./V2_SECURITY_AND_FAILURE_SEMANTICS.md) | Security, failure isolation | Updated |
| [V2_IMPLEMENTATION_ROADMAP.md](./V2_IMPLEMENTATION_ROADMAP.md) | Migration stages, order | Updated |
| [AVL_DEVELOPMENT_ORCHESTRATOR.md](./AVL_DEVELOPMENT_ORCHESTRATOR.md) | Claude+Codex automation | Unchanged |
| [CENTRAL_MARKET_DATA.md](./CENTRAL_MARKET_DATA.md) | Old central market data plan | **DEPRECATED** |
| **Stage 11 Documents** | | |
| [AVL_FX_WEBSITE_ARCHITECTURE.md](./AVL_FX_WEBSITE_ARCHITECTURE.md) | Website infrastructure, 3-system diagram | New (Stage 11) |
| [CUSTOMER_ONBOARDING_AND_DELIVERY.md](./CUSTOMER_ONBOARDING_AND_DELIVERY.md) | Customer journey, delivery, MT5 verification | New (Stage 11) |
| [WEBSITE_CMS_ARCHITECTURE.md](./WEBSITE_CMS_ARCHITECTURE.md) | CMS design, Console→Website content flow | New (Stage 11) |
| [WHITE_LABEL_BRANDING.md](./WHITE_LABEL_BRANDING.md) | White label configuration per customer | New (Stage 11) |
| [CONTRACT_AND_PAYMENT_ARCHITECTURE.md](./CONTRACT_AND_PAYMENT_ARCHITECTURE.md) | Contract, e-signature, Stripe billing | New (Stage 11) |

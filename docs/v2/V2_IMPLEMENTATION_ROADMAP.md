# AVL-FX V2 — Implementation Roadmap

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Revised:** 2026-09-26 — Roadmap rebased; Stage 10-C requirements migrated to V2 Final Gate  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Roadmap Rebase Summary

### 1-1. V1 Stage Completion Record

| Stage | Status | Notes |
|-------|--------|-------|
| Stage 1 | ✅ COMPLETE / FROZEN | P0 Safety / Security — Codex final remediation |
| Stage 2 | ✅ COMPLETE / FROZEN | Database Schema completion |
| Stage 3 | ✅ COMPLETE / FROZEN | Console Knowledge → TV routing |
| Stage 4 | ✅ COMPLETE / FROZEN | CORE RUNTIME — Local Production-path verified |
| Stage 5 | ✅ COMPLETE / FROZEN | Order expiry, SL sync, favorable direction |
| Stage 6 | ✅ COMPLETE / FROZEN | Gateway account isolation — Two-customer verified |
| Stage 7 | ✅ COMPLETE / FROZEN | AI Trader integrated verification |
| Stage 8 | ✅ COMPLETE / FROZEN | Console Business Infrastructure (8A〜8G) |
| Stage 9 | ✅ COMPLETE / FROZEN | Trading View feature complete |
| Stage 10-A | ✅ COMPLETE / FROZEN | Production infrastructure verified |
| Stage 10-B | ✅ COMPLETE / FROZEN | DEMO runtime pre-flight verified |
| Stage 10-C | **SUSPENDED** | SUPERSEDED BY V2 FINAL CUSTOMER SELF-CONTAINED E2E |

### 1-2. Why Stage 10-C is Superseded

Stage 10-C was waiting for a Natural Entry Candidate on V1 architecture. However:
1. POST-V1 architecture changed to Customer Self-Contained (new Market Data, Knowledge, Bridge)
2. Running Stage 10-C on V1 architecture, then rebuilding V2, then re-running E2E = duplicate work
3. All Stage 10-C requirements migrated to V2 Final Gate (enhanced with V2 requirements)

**Stage 10-C requirements are NOT abandoned. They are migrated and enhanced.**

### 1-3. V1 Safety Baseline Inheritance

V1 Stage 1〜10-B safety properties are inherited by V2. They are not re-invented:

```
Inherited from V1 (confirmed working):
  ✓ fail closed semantics
  ✓ authenticated bridge connection
  ✓ customer/connection/owner isolation
  ✓ command expiry (UTC absolute)
  ✓ idempotency keys
  ✓ duplicate prevention
  ✓ Hard Broker SL (EA-side)
  ✓ favorable SL direction enforcement
  ✓ Risk Engine (full 16-check pipeline)
  ✓ minimum RR enforcement
  ✓ max positions enforcement
  ✓ Kill Switch
  ✓ Manual Approval atomicity/correlation
  ✓ broker-confirmed FILLED required
  ✓ broker-confirmed CLOSE required
  ✓ complete snapshot reconciliation
  ✓ AI Log full decision timeline
  ✓ Trade Review durable delivery
  ✓ Knowledge fail closed
```

---

## 2. Pre-conditions for V2 Start

```
[x] V1 Stage 1〜10-B COMPLETE / FROZEN
[x] Stage 10-C SUSPENDED (no V1 natural trade wait)
[x] Architecture design approved (docs/v2/ document set)
[ ] Production secret rotation (Supabase service-role keys — after V1 freeze)
[ ] V2 Architecture Freeze (Stage 0 gate)
```

**V2 implementation starts now. Stage 10-C natural trade wait is no longer a blocking condition.**

---

## 3. V2 Stage Roadmap

```
V2 Stage 0   — Architecture / Migration Freeze
V2 Stage 0.5 — AVL Development Orchestrator (optional — automation tooling)
V2 Stage 1   — Customer Market Data Persistence
V2 Stage 2   — Historical Backfill / Recovery
V2 Stage 3   — Unified MT5 Bridge EA
V2 Stage 4   — Customer Knowledge Localization
V2 Stage 5   — AI Trader Profile / Builder Localization
V2 Stage 6   — Dynamic Position Sizing (user-configurable risk %)
V2 Stage 7   — Console Business / Infrastructure Redesign
V2 Stage 8   — LINE Notification Service
V2 Stage 9   — Customer Self-Contained Runtime Cutover
V2 Stage 10  — Customer Self-Contained Integration Verification
V2 Final     — Controlled Customer DEMO E2E (migrated from Stage 10-C)
```

---

## 4. V2 Stage Details

### V2 Stage 0 — Architecture / Migration Freeze

**Objective:** Formally freeze and approve the Customer Self-Contained Architecture before any implementation.

```
Deliverables:
  - All docs/v2/ documents reviewed and accepted
  - CURRENT V1 vs TARGET V2 separation confirmed in all documents
  - V1 Safety Baseline inheritance documented (see Section 1-3)
  - V2 Final Gate requirements confirmed (V2_FINAL_E2E_GATE.md)
  - Migration boundary confirmed (what stays in V1, what moves to V2)

Human Gate:
  - Product owner approves architecture documents
  - Legal/compliance review scope defined (COMPLIANCE REVIEW REQUIRED)
  - V2 start authorized (Stage 10-C suspended confirmation)

V1 Safety:
  - ZERO code changes
  - ZERO DB changes
  - Stage 10-C runtime untouched (just documentation status change)

Codex Review:
  - Architecture consistency audit
  - CURRENT V1 vs TARGET V2 separation clean
  - No contradictions across docs/v2/
```

### V2 Stage 0.5 — AVL Development Orchestrator (optional)

**Objective:** Build Claude Code ↔ Codex automated review pipeline.

```
Deliverables:
  - STATE.json initial structure
  - HANDOFF.md template
  - reports/ directory structure
  - /codex:review mechanism (CLI script or MCP — per chosen option)
  - /avl:resume mechanism
  - Structured review result schema (from AVL_DEVELOPMENT_ORCHESTRATOR.md)
  - Test pipeline standardization

Human Gate:
  - Approve automation mechanism choice

V1 Safety:
  - ZERO code changes
```

See: [AVL_DEVELOPMENT_ORCHESTRATOR.md](./AVL_DEVELOPMENT_ORCHESTRATOR.md)

### V2 Stage 1 — Customer Market Data Persistence

**Objective:** Customer MT5 OHLC bars persisted to Customer Supabase `customer_bar_data`.

```
Deliverables:
  - customer_bar_data table migration (not applied to Production until Human Gate)
  - Customer Gateway bar ingestion endpoints:
      POST /market-data/bars       (single and batch)
      POST /market-data/backfill   (recovery source)
      GET  /market-data/last-bar   (gap detection)
  - Idempotent upsert: UNIQUE (connection_id, canonical_symbol, timeframe, time_utc)
  - UTC timestamp normalization (broker server UTC offset)
  - Symbol canonicalization (GOLD# → GOLD, XAUUSD → GOLD)
  - Data validation: reject bars with open=0, high < low, future timestamp
  - Integration tests: ingestion, deduplication, normalization, isolation

Test types: unit + integration (deterministic, no real MT5)

Human Gate:
  - Approve schema migration to Production

Codex Review:
  - Idempotency correctness
  - UTC normalization correctness
  - Customer isolation (RLS, connection-scoped)
  - No cross-customer data leakage

V1 Safety:
  - Additive new table only
  - V1 execution paths unchanged
  - V1 chart continues using V1 mechanism until Stage 9
```

See: [CUSTOMER_MARKET_DATA_ARCHITECTURE.md](./CUSTOMER_MARKET_DATA_ARCHITECTURE.md)

### V2 Stage 2 — Historical Backfill / Recovery

**Objective:** Bridge EA reconnect automatically backfills missing bars from MT5 history.

```
Deliverables:
  - GET /market-data/last-bar: returns MAX(time_utc) per connection+symbol+tf
  - Gap detection: compare Supabase last_bar vs current time
  - Backfill batch processing: CopyRates-equivalent, ≤500 bars/batch
  - Idempotent batch upsert (ON CONFLICT DO NOTHING for confirmed bars)
  - Out-of-order batch handling
  - Partial batch retry (entire batch on failure — idempotent)
  - Completeness verification post-backfill
  - Data quality validation per bar
  - Monitoring: backfill_summary log
  - Tests: gap detection, backfill correctness, idempotency, large-gap scenario

Human Gate:
  - Review backfill correctness test results before Production migration

Codex Review:
  - Idempotency of backfill upserts
  - Timestamp correctness and UTC normalization
  - No false success on partial failure
  - Memory safety (no unbounded batch accumulation)
```

See: [CUSTOMER_MARKET_DATA_ARCHITECTURE.md](./CUSTOMER_MARKET_DATA_ARCHITECTURE.md) Section 6

### V2 Stage 3 — Unified MT5 Bridge EA

**Objective:** Consolidate V1's two Bridge EAs into one unified EA. Execution Safety fully preserved.

```
Deliverables:
  - AVL_FX_Bridge.ex5 (unified) with all 8 modules:
      Connection / Market Data / Historical Data / Symbol Spec /
      Account / Position / Deal / Execution
  - All V1 Execution Safety checks preserved in Execution Module (16 checks)
  - Module independence: Market Data failure ≠ Execution failure
  - Updated deployment guide
  - Parallel test: unified EA alongside V1 EAs on test customer system
  - Verification: all safety checks pass

Human Gate:
  - Approve unified EA deployment on test customer MT5 account
  - Customer notification of EA update process
  - Only switch after complete verification

Codex Review:
  - CRITICAL: all 16 Risk Engine / EA execution safety checks present
  - Module separation verified: Execution does not depend on Market Data module
  - No hardcoded secrets or connection tokens
  - Connection token passed at runtime, not compiled into EA
  - Command validation: all original checks preserved

V1 Safety:
  - V1 EAs continue in parallel during test
  - Rollback: customer reverts to V1 EAs if needed
  - API contract: V1 Gateway endpoints remain compatible during transition
```

See: [UNIFIED_MT5_BRIDGE.md](./UNIFIED_MT5_BRIDGE.md)

### V2 Stage 4 — Customer Knowledge Localization

**Objective:** AI Trader reads knowledge from Customer Supabase. Zero runtime dependency on Console.

```
Deliverables:
  - customer_knowledge table migration
  - Knowledge Package builder in Console (compiles + deploys packages)
  - selectKnowledgeForTrader() updated:
      Primary: reads from customer_knowledge (local)
      Fallback: existing V1 Console fetch (transitional — removed in Stage 9)
  - knowledge_snapshot in ai_analysis_logs references customer_knowledge.id
  - Content hash verification (SHA-256 integrity check)
  - Tests:
      local knowledge read (no Console call)
      Console offline → customer AI Trader continues
      knowledge_snapshot traceability
      package integrity (hash check)

Human Gate:
  - Approve Knowledge Package deployment to Production customer systems
  - Verify knowledge content integrity before cutover

Codex Review:
  - Console offline → customer AI Trader still runs (zero runtime dependency)
  - knowledge_snapshot traceability preserved
  - No chain-of-thought storage (V1 policy maintained)
  - customer_knowledge RLS correct (user_id isolation)

V1 Safety:
  - Fallback to V1 Console fetch during transition (removed in Stage 9)
  - V1 execution paths unchanged
```

See: [CUSTOMER_KNOWLEDGE_ARCHITECTURE.md](./CUSTOMER_KNOWLEDGE_ARCHITECTURE.md)

### V2 Stage 5 — Customer AI Trader Profile / Configuration Localization

**Objective:** All AI Trader configuration (timeframe profiles, risk profiles) stored in Customer Supabase. Console provides admin provisioning UI only — Customer System owns the runtime data.

**Architecture invariant:** Customer AI Trader reads ALL configuration from Customer Supabase at runtime. Console API is never called during trading.

```
Deliverables:
  Customer Supabase (canonical config location):
  - ai_trader_timeframe_profiles table migration
  - ai_trader_risk_profiles table migration (or ai_trader_versions extension)
  - ai_trader_notification_profiles table migration
  - Default DAY_TRADING profile for existing ai_traders (V1 backward compat)

  Console (admin provisioning tool — not runtime):
  - Customer AI Trader Builder: full provisioning UI with /deploy endpoint
  - Profile delivery to Customer Supabase at provisioning time
  - Console does NOT serve AI Trader configuration at runtime

  Customer Trading View:
  - Reads all AI Trader config from Customer Supabase (no Console call)
  - Risk Profile settings page (customer customization within limits)
  - Tests: profile-driven runtime behavior, backward compatibility

Human Gate:
  - Approve schema migrations to Production
  - Verify existing V1 traders work with default DAY_TRADING profile

Codex Review:
  - Backward compatibility: existing V1 traders unchanged (default H1+M5 profile)
  - Customer isolation: one customer cannot see another's profiles
  - Hard caps enforced on risk_per_trade_percent

V1 Safety:
  - Default profile = V1 H1/M5 behavior (additive, no V1 code changed)
  - V1 execution path unchanged
```

See: [AI_TRADER_PROFILE.md](./AI_TRADER_PROFILE.md), [AI_TRADER_BUILDER.md](./AI_TRADER_BUILDER.md)

### V2 Stage 6 — Dynamic Position Sizing

**Objective:** Customer-configurable risk_per_trade_percent. Risk Engine calculates lot from Customer MT5 equity and symbol specs.

```
Deliverables:
  - risk_per_trade_percent field in ai_trader_risk_profiles
  - Risk Engine: new checks added (reads risk_per_trade_percent + price translation)
  - System hard caps: SYSTEM_MAX_RISK_PERCENT, SYSTEM_MAX_VOLUME_PER_TRADE, etc.
  - Price translation step before lot calculation
  - Trading View UI: Risk % setting with current equity display
  - Owner Approval UI: shows Lot, Risk %, Max Loss, R:R before approval
  - Tests:
      lot calculation correctness
      price translation (reference → executable price)
      hard cap enforcement
      volume_step rounding (always floor, never ceil)
      edge cases: equity=0, missing symbol_specs, risk%=0

Human Gate:
  - Approve Risk Engine changes to Production
  - Review lot calculation test coverage

Codex Review:
  - Lot calculation formula correctness
  - Hard caps cannot be bypassed by customer configuration
  - No V1 safety checks removed or weakened
  - volume_step rounding is always floor (safe direction)

V1 Safety:
  - Default behavior preserved (existing max_risk_per_trade as fallback)
  - V1 execution path preserved during transition
```

See: [DYNAMIC_POSITION_SIZING.md](./DYNAMIC_POSITION_SIZING.md)

### V2 Stage 7 — Console Business / Infrastructure Redesign

**Objective:** Console role formally aligned to Business & Infrastructure Console only. Console is NOT a trading runtime. V1 legacy market-data code/EA formally marked as NOT PART OF V2 TARGET RUNTIME (physical removal is a separate operational decision).

**Architecture invariant confirmed in this stage:**
- Console does NOT collect market prices, OHLC, or ticks for Customer AI Trader use
- Console does NOT run Customer AI Trader runtime
- V1 Console DataManager EA and Console bar_data table are V1 LEGACY — NOT V2 TARGET

```
Deliverables:
  - Customer management dashboard (contract, revenue, payment, MRR)
  - System infrastructure metadata (Vercel, Railway, Supabase, domain)
  - Deployment management (history, pending, rollback)
  - System health monitoring UI
    (receives operational metadata ONLY: heartbeat status, EA version, broker/account ID)
    (does NOT display or store market prices, OHLC, or tick data)
  - LINE notification management UI
  - EA Registry administrative UI
  - Console V1 legacy market-data code:
    - Mark AVL_Console_DataManager EA as LEGACY / NOT V2 TARGET
    - Mark Console bar_data, Research API as V1 LEGACY
    - Do NOT physically remove yet (transitional — removed when Customer systems verified self-contained)
    - Document clearly: "Not part of V2 Customer Trading System Runtime"

Human Gate:
  - Approve Console UI changes before deployment

Codex Review:
  - No customer trading data leakage across accounts
  - Admin-only access on all management endpoints
  - Console does NOT have new routes that fetch market prices for Customer AI Trader use

V1 Safety:
  - V1 Console DataManager EA: untouched (operational decision to decommission separately)
  - Console Research API: retained as V1 LEGACY (removed when customer_bar_data verified sufficient)
  - Customer Trading View V1 runtime: still works
```

See: [AVL_CONSOLE_TARGET.md](./AVL_CONSOLE_TARGET.md)

### V2 Stage 8 — LINE Notification Service

**Objective:** Customer Trading View sends notification events to Console Notification Service → LINE.

```
Deliverables:
  - customer_line_links table migration
  - notification_preferences table migration
  - notification_events table migration
  - notification_deliveries table migration
  - LINE linking flow (state token mechanism — see LINE_NOTIFICATION_ARCHITECTURE.md)
  - LINE channel adapter (calls LINE Messaging API)
  - Notification Event Service: dedup, preferences, state-transition gating
  - Customer Trading View: LINE settings page (link/unlink, preferences)
  - Webhook endpoint + signature verification (MANDATORY)
  - Tests:
      linking flow correctness
      delivery correctness
      failure isolation (LINE failure → trading unaffected)
      deduplication
      state-transition gating (WAIT→WAIT = no notification)
      webhook signature verification

Human Gate:
  - Approve LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET setup in Console Production env
  - Test in staging before Production deployment
  - Approve notification message templates

Codex Review:
  - CRITICAL: Webhook signature verification is mandatory (not optional)
  - CRITICAL: LINE_CHANNEL_ACCESS_TOKEN NEVER in Trading View or Customer Gateway
  - LINE failure does NOT block trading (isolation confirmed)
  - Customer LINE User ID never sent to browser
  - Customer isolation in notification routing

V1 Safety:
  - LINE delivery completely additive
  - No V1 execution path modified
```

See: [LINE_NOTIFICATION_ARCHITECTURE.md](./LINE_NOTIFICATION_ARCHITECTURE.md)

### V2 Stage 9 — Customer Self-Contained Runtime Cutover

**Objective:** Remove all runtime dependencies on Console Market Data and Console Knowledge API.

```
Deliverables:
  - Verify: customer_bar_data has sufficient history for all AI Trader operations
    (minimum: 90 days of confirmed bars for primary timeframes)
  - Verify: customer_knowledge packages deployed and complete (all ACTIVE traders)
  - Remove: Console fetch fallback from selectKnowledgeForTrader()
  - Remove: Console Research API dependency from Customer Trading View server
  - Remove: V1 bar_data dependency for chart (replaced by customer_bar_data)
  - Feature flag cleanup: all transitional fallbacks removed
  - Tests:
      Console offline → customer AI Trader operates normally
      customer_bar_data used for Chart/Indicators/AI (same source)
      No Console API calls in production Trading View runtime
      All failure paths tested

Human Gate:
  - CRITICAL: Approve removal of Console dependency from customer runtime
  - Verify at minimum 90 days of customer_bar_data before removing fallback
  - Run parallel verification for minimum 30 days
  - Console Research API officially deprecated

Codex Review:
  - No remaining Console API calls in Customer Trading View runtime path
  - All failure scenarios tested (not just happy path)
  - Chart + Indicators + AI all using same customer_bar_data confirmed

V1 Safety:
  - Do NOT remove Console dependency until Customer system is verified self-contained
  - Console Research API: mark deprecated but keep endpoint running for Research use
```

### V2 Stage 10 — Customer Self-Contained Integration Verification

**Objective:** Verify full integration of Customer Self-Contained system. No natural trade forced yet.

```
Deliverables:
  - Integration test: full data pipeline (MT5 → Bridge → Gateway → Supabase → Chart → AI)
  - Integration test: execution boundary (AI decision → Risk Engine → Gateway API)
  - Verification: no Console API calls during normal AI Trader operation
  - Verification: unified Bridge EA serving both market data and execution
  - Verification: customer_knowledge used for AI analysis
  - Verification: dynamic lot calculation with customer MT5 equity
  - Verification: Owner Approval flow end-to-end (with test decision)
  - Verification: LINE notification delivered for test events
  - Multiple customer isolation test
  - Performance test: bar ingestion under load (simulated)

IMPORTANT:
  - Do NOT insert fake bar data
  - Do NOT force ENTER with synthetic market data
  - Integration verification uses real MT5 connection (can use live market data)
  - But execution stops at approval boundary — no actual MT5 orders
  - Real-money and DEMO orders require Final Gate

Human Gate:
  - Approve all integration test results
  - Confirm system is ready for Final Gate
  - Approve Final Gate execution plan

Codex Review:
  - Integration test correctness and coverage
  - Customer isolation verified under concurrent scenarios
  - Safety baseline: all V1-inherited safety checks still pass
  - No regression on any V1 Stages 1-7 safety properties
```

### V2 Final Gate — Controlled Customer DEMO E2E

**Migrated from:** V1 Stage 10-C (SUSPENDED)

**Objective:** Natural lifecycle E2E with real Customer MT5 DEMO account. Zero shortcuts.

```
Rules (non-negotiable):
  ✗ Do NOT force ENTER
  ✗ Do NOT modify strategy for more frequent entries
  ✗ Do NOT relax risk parameters
  ✗ Do NOT insert fake bar data
  ✗ Do NOT directly insert scenario or decision
  ✗ Do NOT bypass Owner Approval
  ✗ Do NOT bypass Risk Engine
  ✗ Do NOT use mock fills

  Wait for NATURAL market conditions.
  Only proceed when a NATURAL Entry Candidate appears.
  Owner MUST approve in Trading View before any order.
```

```
Full requirements: docs/v2/V2_FINAL_E2E_GATE.md

Minimum lifecycle to complete:
  Natural H1 Scenario
  → Natural M5 Entry Candidate
  → Dynamic Lot Calculation display
  → Owner Manual Approval in Trading View
  → Risk Engine PASS
  → Unified Bridge EA execution
  → Customer MT5 DEMO FILLED (broker confirmed)
  → Position Management (at least one HOLD cycle)
  → Controlled Close
  → Broker-confirmed OUT Deal
  → Trade Review created
  → Full Reconciliation PASS
  → LINE notification delivered

Human Gate:
  - MANDATORY: Owner approves each execution in Trading View (no auto-approve)
  - MANDATORY: Verify DEMO account before any order
  - MANDATORY: Codex Final Independent Audit passes before declaring COMPLETE

Codex Review (Final):
  - Independent audit of entire V2 implementation
  - Security audit: secrets, isolation, authentication
  - Architecture compliance: matches docs/v2/ specifications
  - V1 safety properties: all inherited checks still pass
  - E2E report: trade lifecycle evidence documented
  - PASS required before V2 PRODUCTION COMPLETE declaration
```

---

## 5. V2 Stage Gate Protocol (Claude/Codex)

Each stage follows the AVL Development Orchestrator protocol:

```
Orchestrator
    ↓
Claude Code (Builder)
    ↓ implements + self-tests
Unit → Integration → Security/Safety regression → Typecheck → Build
    ↓ tests pass
Git commit (immutable SHA)
    ↓
HANDOFF.md updated (STATE.json updated)
    ↓
Codex (Independent Reviewer)
    ↓ reads: AGENTS.md + MASTER_SPEC + STATE.json + HANDOFF.md + git diff
Independent review: architecture, security, regression, safety
    ↓
Structured result: { status: PASS | FAIL, p0, p1, p2, p3, ... }
    ↓
PASS → Stage FREEZE → Human Gate (if required) → Next Stage
FAIL → Findings to Claude → Fix → New commit → Codex re-review
     → MAX_REVIEW_CYCLES=3 exceeded → HUMAN_REVIEW_REQUIRED
```

**Codex is REVIEWER, not Builder. Claude is Builder, not final approver of own work.**

---

## 6. Human Gate Summary

The following always require explicit Human approval:

```
Production DB destructive migration
Production customer data deletion
Production secrets creation or rotation
Production ENV mutation
DEMO MT5 order (at V2 Final Gate — Owner Approval required in Trading View)
LIVE MT5 order (permanently prohibited without separate authorization)
Real money movement
Irreversible infrastructure deletion
Repository or project deletion
```

---

## 7. Natural Trade Timing

```
V2 Stage 0〜10: deterministic tests, integration tests, safe simulation
  No natural entry candidate waiting required
  Real MT5 connection can be used for data verification (no orders)

V2 Final Gate only: natural market + DEMO orders
  Wait for natural Entry Candidate
  No forced ENTER
  Owner Approval MANDATORY
  First (and only) natural DEMO lifecycle
```

---

## 8. V2 Definition of Done (Production Complete)

```
V2 PRODUCTION COMPLETE requires ALL of the following:

Architecture Stage 0:          PASS
Market Data Stage 1:           PASS
Historical Backfill Stage 2:   PASS
Unified Bridge Stage 3:        PASS
Customer Knowledge Stage 4:    PASS
AI Trader Profile Stage 5:     PASS
Dynamic Position Sizing Stage 6: PASS
Console Redesign Stage 7:      PASS
LINE Notification Stage 8:     PASS
Runtime Cutover Stage 9:       PASS
Integration Verification Stage 10: PASS
Customer Isolation:            PASS
Broker Independence:           PASS
Security:                      PASS
Full Regression (V1 Safety):   PASS
Natural Customer DEMO E2E:     PASS (V2 Final Gate)
Broker FILLED:                 PASS
Broker CLOSE:                  PASS
Trade History:                 PASS
AI Log:                        PASS
Trade Review:                  PASS
Reconciliation:                PASS
Codex Final Independent Audit: PASS
```

---

## 9. Dependency Graph

```
Stage 0 (Architecture Freeze)
      ↓
Stage 0.5 (Orchestrator — optional, can run parallel)
      ↓
Stage 1 (Market Data Persistence)
      ↓
Stage 2 (Historical Backfill)
      ↓
Stage 3 (Unified Bridge) ←── requires Stage 1+2 working
      ↓
Stage 4 (Knowledge Localization) ←── independent, can start after Stage 0
      ↓
Stage 5 (Profile/Builder) ←── independent after Stage 0
      ↓
Stage 6 (Dynamic Position Sizing) ←── requires Stage 5
      ↓
Stage 7 (Console Redesign) ←── largely independent, can start after Stage 0
      ↓
Stage 8 (LINE Notification) ←── requires Stage 5 (notification_profiles)
      ↓
Stage 3 + Stage 4 + Stage 5 + Stage 6 + Stage 8 complete
      ↓
Stage 9 (Runtime Cutover) ←── requires all above
      ↓
Stage 10 (Integration Verification)
      ↓
V2 Final Gate (Natural DEMO E2E)
      ↓
Stage 11 (Website / Customer Acquisition / Onboarding) ←── starts AFTER Final Gate PASS
```

Stage 7 (Console Redesign) can proceed in parallel with Stages 1–6.  
Stage 11 requires V2 Final Gate PASS. It is independent of Trading System stages and does not block or depend on them except for the Final Gate completion.

---

## 10. V2 Stage 11 — AVL FX Website / Customer Acquisition & Onboarding

> **Stage 11 begins AFTER V2 Final Gate PASS.**  
> The Website does NOT affect V2 Stage 10 Trading System completion.  
> Stage 11 introduces the commercial customer acquisition layer.

### Stage 11 Overview

```
Stage 11 Goal:
  A customer discovers AVL FX on the Website
  → completes application + contract + initial payment
  → AVL delivers their custom Trading View system
  → customer installs EA, verifies MT5 connection
  → Managed Service billing begins
  = Full commercial lifecycle operational
```

### Stage 11 Pre-conditions

```
[x] V2 Stage 10 Final Gate PASS (Trading System Production Qualified)
[ ] Website architecture freeze (Stage 11A)
[ ] Legal review of contract documents
[ ] Stripe Japan account confirmed
[ ] Domain strategy confirmed
[ ] E-signature approach decided
```

### Stage 11 Substages

**Stage 11A — Website Architecture Freeze**

```
Deliverables:
  - Stage 11 architecture documents reviewed and approved
  - Technology stack confirmed (Next.js, Vercel, Supabase, Stripe)
  - CMS source of truth confirmed (Option A vs Option B)
  - E-signature approach confirmed
  - Contract documents legal review completed
  - Stripe account setup confirmed
  - Domain strategy confirmed

Human Gate:
  - Legal/compliance review of contract documents
  - Approve e-signature mechanism
  - Approve Stripe setup

V2 Safety:
  - ZERO changes to Trading View
  - ZERO changes to Customer Supabase
  - ZERO changes to Console existing functionality
```

**Stage 11B — Website Infrastructure**

```
Deliverables:
  - New GitHub repository: AVL_FX_Website
  - New Vercel Project: AVL FX Website
  - New Supabase Project: AVL FX Website
  - Domain configured
  - Basic Next.js application deployed
  - Website Supabase schema initialized

Human Gate:
  - Approve new infrastructure creation
  - Approve domain DNS changes
```

**Stage 11C — Public Website / CMS Read**

```
Deliverables:
  - Public Website pages: Home, About, Pricing (static or CMS-driven)
  - Console CMS API endpoint (public-safe content read)
  - Website reads content from Console CMS API
  - Edge cache for CMS responses
  - SEO / OGP metadata
  - Legal document pages (Terms, Privacy, Risk Disclosure)

Codex Review:
  - No CMS write credential in Website code
  - XSS sanitization on all CMS-sourced content
  - Legal document version shown correctly
```

**Stage 11D — Console Website CMS**

```
Deliverables:
  - Console website_content table migration
  - Console CMS admin UI (all manageable fields)
  - Image upload to Console Supabase Storage
  - Content versioning and draft/publish workflow
  - Legal document version management
  - Preview mode

Codex Review:
  - Admin-only write access
  - No CMS write endpoint accessible from Website
  - Content sanitization
  - Audit log for content changes
```

**Stage 11E — Application Workflow**

```
Deliverables:
  - Application form (customer info + system requirements + branding)
  - Application saved to Website Supabase
  - Console receives new application notification
  - application.status state machine
  - Input validation and sanitization
  - File upload (logo, brand assets) with validation

Codex Review:
  - All inputs server-side validated
  - No PII leaked in logs
  - File upload type/size validation
  - Rate limiting on submission
```

**Stage 11F — Contract / E-Signature**

```
Deliverables:
  - Contract presentation (all required documents)
  - Consent checkboxes with document hash
  - E-signature mechanism (per Stage 11A decision)
  - contract_acceptances record created on acceptance
  - Document version + hash stored at acceptance time
  - Acceptance metadata recorded (timestamp, IP, user agent)

Codex Review:
  - Document version and hash correctly captured
  - Acceptance cannot be bypassed
  - No repudiation risk in implementation
```

**Stage 11G — Stripe Initial Payment**

```
Deliverables:
  - Stripe Payment Intent creation (server-side)
  - Stripe Elements or Checkout integration
  - Stripe webhook: payment_intent.succeeded
  - Webhook signature verification (mandatory)
  - application.status = PAID on confirmed payment
  - Console: new paid order notification
  - Idempotency: Stripe event ID deduplication

Codex Review:
  - STRIPE_SECRET_KEY never in browser
  - Webhook signature verification mandatory
  - Idempotency key on all payment intents
  - No double-charging on webhook replay
```

**Stage 11H — Console Order Intake**

```
Deliverables:
  - Console shows new paid applications
  - Console CRM: customer lifecycle state machine
  - Console: development assignment tracking
  - Console: customer detail view (full lifecycle)
  - Console: billing section with Stripe subscription management

Codex Review:
  - Cross-customer data isolation
  - Admin-only access to sensitive customer data
```

**Stage 11I — White Label Provisioning**

```
Deliverables:
  - customer_branding table in Customer Supabase
  - Console provisioning: create branding record from application data
  - Trading View reads customer_branding at request time
  - Logo/favicon upload and storage in Customer Supabase Storage
  - Custom domain configuration procedure
  - White label applied to all Trading View pages

Codex Review:
  - No source fork per customer
  - Branding update does not require re-deployment
  - Default fallback if branding config missing
```

**Stage 11J — Delivery / Secure Setup**

```
Deliverables:
  - Delivery token generation (one-time, time-limited, hash-stored)
  - Delivery email with secure onboarding link
  - Secure onboarding page (authenticated, guided setup)
  - EA download link (time-limited)
  - Console: READY_FOR_DELIVERY status management

Codex Review:
  - No credentials in email body
  - Delivery token single-use and time-limited
  - Token hash stored (not raw)
```

**Stage 11K — MT5 Connection Verification**

```
Deliverables:
  - "MT5接続を確認する" page in Website/Trading View
  - Server-side verification: all 10 checks (see CUSTOMER_ONBOARDING_AND_DELIVERY.md)
  - verification_logs table
  - MT5_CONNECTED status set only on PASS
  - Error display with specific resolution guidance
  - Console: delivery confirmation on MT5_CONNECTED

Codex Review:
  - All 10 verification checks implemented (fail closed)
  - Customer self-report alone insufficient
  - No MT5_CONNECTED on partial verification
```

**Stage 11L — Managed Service Subscription**

```
Deliverables:
  - Stripe subscription creation after DELIVERED
  - Recurring billing setup
  - Invoice webhook handling
  - PAYMENT_FAILED handling
  - Console: billing status tracking
  - LINE: BILLING_NOTICE notification

Codex Review:
  - No double-subscription
  - Payment failure does not immediately lock Trading View
  - Human Gate required for service suspension decisions
```

**Stage 11M — LINE Business Notifications**

```
Deliverables:
  - Business notification event types (APPLICATION_RECEIVED, PAYMENT_CONFIRMED, etc.)
  - source = 'business' in notification_events
  - Separation from trading runtime notifications
  - Business notifications delivered via existing LINE infrastructure

Codex Review:
  - Business notifications do not interfere with trading notifications
  - LINE cannot be used for trade approval or execution
```

**Stage 11N — Stage 11 E2E**

```
Deliverables:
  - Full Stage 11 lifecycle test:
      Application → Contract → Payment → Development → Delivery
      → MT5 Verification → MT5_CONNECTED → Managed Service Active
  - White label displayed correctly for test customer
  - LINE notifications delivered at each business event
  - Console shows complete customer lifecycle
  - No Trading System regression

Human Gate:
  - Approve all E2E test results
  - Confirm Stage 11 production readiness

Codex Review (Final for Stage 11):
  - Independent security audit of Website
  - Stripe integration security
  - Contract workflow non-repudiation
  - Customer data isolation
  - No credential leakage anywhere in the flow
```

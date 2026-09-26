// stage-defs.mjs — Stage Definition of Done and review context
// Source of truth: docs/v2/V2_IMPLEMENTATION_ROADMAP.md
// This file provides the structured review context sent to Codex for each stage.

// Commit SHA just before V2 Stage 1 started (last V1 commit).
// Used as --base for cumulative stage review.
export const V2_STAGE_BASELINES = {
  "V2-Stage-1": "f530d5e",
  "V2-Stage-2": "9b3e77c",  // last commit of Stage 1 FROZEN
  "V2-Stage-3": "1ab0f0f",  // last commit of Stage 2 FROZEN
  // Stage 4+ baselines: set to last_builder_commit of previous stage after PASS
  // "V2-Stage-3": "<Stage-2-frozen-commit>",  // set after Stage 2 PASS
  // "V2-Stage-4": "<Stage-3-frozen-commit>",
  // "V2-Stage-5": "<Stage-4-frozen-commit>",
  // "V2-Stage-6": "<Stage-5-frozen-commit>",
  // "V2-Stage-7": "<Stage-6-frozen-commit>",
  // "V2-Stage-8": "<Stage-7-frozen-commit>",
  // "V2-Stage-9": "<Stage-8-frozen-commit>",
  // "V2-Stage-10": "<Stage-9-frozen-commit>",
  // "V2-Final":   "<Stage-10-frozen-commit>",
};

export const STAGE_DEFINITIONS = {
  "V2-Stage-1": {
    name:    "Customer Market Data Persistence",
    doc:     "docs/v2/CUSTOMER_MARKET_DATA_ARCHITECTURE.md",
    summary: "Customer MT5 OHLC bars persisted to Customer Supabase customer_bar_data table.",
    files_changed: [
      "supabase/migrations/035_customer_bar_data.sql",
      "gateway/src/customerBarDataStore.ts",
      "gateway/src/customer-bar-data.test.ts",
      "gateway/src/index.ts (new /market-data/* routes)",
      "gateway/package.json",
    ],
    dod: [
      "customer_bar_data table migration is additive (new table only, V1 bar_data untouched)",
      "POST /market-data/bars: realtime bar ingestion, authenticated via verifyBridgeAuth",
      "POST /market-data/backfill: recovery bar ingestion, authenticated",
      "GET /market-data/last-bar: returns MAX(time_utc) per connection+symbol+tf for gap detection",
      "Idempotent upsert: UNIQUE (connection_id, canonical_symbol, timeframe, time_utc)",
      "UTC normalization: broker server time + utc_offset_hours → UTC",
      "Symbol canonicalization: GOLD#→GOLD, XAUUSD→GOLD",
      "Data validation: reject bars with open=0, high<low, future timestamp, unknown timeframe",
      "Batch limit: 500 bars max per request",
      "RLS: authenticated users read only their own connection's bars",
      "23 unit tests PASS (no mocked Supabase — pure function tests)",
      "Typecheck PASS",
      "Build PASS",
    ],
    security_checklist: [
      "Bridge auth required for all /market-data/* endpoints (verifyBridgeAuth, not just gateway SECRET)",
      "No cross-customer data leakage (RLS enforced)",
      "No secret values in migration SQL or gateway source",
      "connection_id scope: user can only read/write their own connection's bars",
      "No SQL injection vectors (using Supabase client with parameterized queries)",
    ],
    v1_safety: [
      "V1 bar_data table: NOT modified (no ALTER TABLE, no DROP)",
      "V1 execution paths: NOT changed (/bar, /bars/bulk, /bridge/bars, /bridge/bars/bulk routes)",
      "Migration 035 is additive ONLY (new table, new indexes, new RLS policies)",
    ],
    codex_focus: [
      "Idempotency: does ON CONFLICT correctly prevent duplicates?",
      "UTC conversion: is `broker_time_sec - utc_offset * 3600` correct direction?",
      "RLS: can Customer A read Customer B's bars?",
      "Auth: are endpoints properly authenticated? Is gateway SECRET alone sufficient? (Should NOT be)",
      "Validation: are all invalid bar cases rejected?",
      "V1 regression: are any V1 paths affected?",
      "Test adequacy: do 23 tests cover the key requirements?",
    ],
  },

  "V2-Stage-2": {
    name:    "Historical Backfill / Recovery",
    doc:     "docs/v2/CUSTOMER_MARKET_DATA_ARCHITECTURE.md#6-historical-backfill--recovery",
    summary: "Bridge EA reconnect automatically backfills missing bars from MT5 history.",
    files_changed: [
      "supabase/migrations/036_customer_backfill_logs.sql",
      "gateway/src/customerBarDataStore.ts (conflict resolution, countBarsInRange, logBackfill)",
      "gateway/src/customer-backfill.test.ts",
      "gateway/src/index.ts (GET /market-data/bar-count, POST /market-data/backfill/complete)",
    ],
    dod: [
      "GET /market-data/last-bar returns MAX(time_utc) per connection+symbol+tf (Stage 1 carries forward)",
      "Conflict resolution: bridge_recovery/backfill → ignoreDuplicates=true (never overwrite realtime)",
      "GET /market-data/bar-count: returns count of bars in a time range for completeness verification",
      "POST /market-data/backfill/complete: EA signals completion, Gateway logs backfill_summary",
      "customer_backfill_logs table (migration 036, additive)",
      "countCustomerBarsInRange() for completeness verification",
      "logCustomerBackfill() writes summary to customer_backfill_logs",
      "All three endpoints authenticated via verifyBridgeAuth",
      "25 unit tests: gap detection, idempotency, out-of-order, conflict resolution, large-gap, partial retry, completeness, memory safety",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "All /market-data/* endpoints require verifyBridgeAuth (not just gateway SECRET)",
      "No cross-customer data leakage in bar-count query (connection_id scoped)",
      "backfill_logs RLS: authenticated users see only their own logs",
    ],
    v1_safety: [
      "Migration 036 is additive (new table only)",
      "No V1 execution path modified",
      "No changes to Stage 1 features",
    ],
    codex_focus: [
      "Idempotency: does ignoreDuplicates=true correctly prevent realtime bar overwrite?",
      "Completeness: does bar-count use correct connection_id scope?",
      "Authentication: are bar-count and backfill/complete using verifyBridgeAuth?",
      "No false success on partial failure (error propagation)",
      "Memory safety: no unbounded batch accumulation",
      "UTC normalization: is timestamp handling consistent with Stage 1?",
    ],
  },


  // ── Stage 3 ──────────────────────────────────────────────────
  "V2-Stage-3": {
    name:    "Unified MT5 Bridge EA",
    owner:   "Customer Trading System",
    doc:     "docs/v2/UNIFIED_MT5_BRIDGE.md",
    summary: "Consolidate Market Data Bridge and Execution Bridge into one EA (AVL_FX_Bridge.ex5) with internal module separation. All V1 execution safety checks preserved.",
    files_changed: [
      "ea/AVL_FX_Bridge.mq5 (unified: Connection + Market Data + Historical + Symbol Spec + Account + Position + Deal + Execution modules)",
      "gateway/src/index.ts (unified endpoint compatibility for new EA)",
      "gateway/src/*.test.ts (bridge integration tests)",
    ],
    dod: [
      "Single AVL_FX_Bridge.ex5 replaces separate market/execution EAs",
      "Connection Module: authentication, reconnect with exponential backoff, heartbeat",
      "Market Data Module: OnTick (bid/ask/spread), OnBarClose per configured timeframe → POST /market-data/bars",
      "Historical Data Module: reconnect triggers GET /market-data/last-bar + CopyRates backfill → POST /market-data/backfill",
      "Symbol Specification Module: SymbolInfoDouble/Integer → POST /symbol-spec on connect + refresh",
      "Account Module: equity/balance/margin/account_type/account_mode → POST /heartbeat/account",
      "Position Module: position snapshot → POST /positions/snapshot",
      "Deal Module: new deal detection → POST /deals",
      "Execution Module: polls GET /execution/pending-commands, validates, calls OrderSend, reports fill",
      "Module independence: Market Data failure does NOT disable Execution Module",
      "Execution Module: all 16 V1 safety checks preserved (command_id unique, token match, expiry, symbol, volume, SL direction, stops_level, account_type DEMO, account_mode)",
      "Market data flows to Customer Supabase customer_bar_data (NOT to Console)",
      "No Console market-data EA role in this EA",
      "Connection token passed as EA input parameter — NOT hardcoded",
      "Typecheck: EA compiles without errors (or: static analysis passes on all module interfaces)",
      "Integration test: market data module sends to /market-data/bars and Gateway stores correctly",
      "Integration test: execution module receives command → validates → reports fill",
      "Regression: Stage 1+2 market data persistence unaffected",
    ],
    security_checklist: [
      "No credentials hardcoded in EA source",
      "Connection token is input parameter only",
      "Execution Module does not depend on Market Data Module state",
      "All commands require connection_token_hash match before execution",
      "Market Data Module: sends to Customer Gateway only (NOT to Console)",
      "No LIVE account order placement in automated tests",
      "EA source contains no actual broker credentials, passwords, or server URLs",
    ],
    v1_safety: [
      "All 16 Risk Engine / Execution safety checks preserved in Execution Module",
      "V1 Gateway execution endpoints (/bridge/execute, /bridge/close etc.) remain compatible during transition",
      "Stage 1+2 customer_bar_data write paths unaffected",
      "No V1 execution safety check weakened",
    ],
    codex_focus: [
      "Execution safety: are all 16 checks preserved? Any removed or weakened?",
      "Module independence: can Market Data fail without disabling Execution?",
      "No Console market-data transmission: does EA send anywhere other than Customer Gateway?",
      "Connection token: is it hardcoded anywhere? (should be input parameter only)",
      "AI direct MT5 access: does any path allow AI to bypass Gateway → Bridge → MT5 chain?",
      "Test adequacy: do tests cover module independence and safety check preservation?",
    ],
    human_gate: [
      "Production MT5 EA deployment (customer's live or demo MT5)",
      "Production Gateway changes",
      "Production deployment of unified EA to any customer system",
      "LIVE account order (absolutely prohibited — demo only for any order tests)",
    ],
    forbidden_actions: [
      "Do NOT transmit market data to Console",
      "Do NOT remove any V1 execution safety check",
      "Do NOT allow AI to directly access MT5",
      "Do NOT deploy to production customer MT5 without Human Gate",
      "Do NOT run LIVE account order in any test",
    ],
  },

  // ── Stage 4 ──────────────────────────────────────────────────
  "V2-Stage-4": {
    name:    "Customer Knowledge Localization",
    owner:   "Customer Trading System",
    doc:     "docs/v2/CUSTOMER_KNOWLEDGE_ARCHITECTURE.md",
    summary: "AI Trader reads knowledge from Customer Supabase (customer_knowledge table). Zero runtime dependency on Console Knowledge API after deployment.",
    files_changed: [
      "supabase/migrations/037_customer_knowledge.sql (new table)",
      "src/lib/ai-trader/knowledge/trading-knowledge.ts (updated selectKnowledgeForTrader — local read primary, Console fetch fallback)",
      "src/infrastructure/ai/knowledge/*.test.ts",
    ],
    dod: [
      "customer_knowledge table migration (additive, Customer Supabase)",
      "customer_knowledge schema: user_id, ai_trader_id, package_version, source_knowledge_id, content_hash, title, category, content, ai_usage, summary, market, timeframes, status",
      "selectKnowledgeForTrader(): reads from customer_knowledge first (local), falls back to V1 Console fetch only if customer_knowledge is empty",
      "Console offline scenario: customer_knowledge populated → AI Trader analysis runs (no Console dependency)",
      "knowledge_snapshot in ai_analysis_logs: references customer_knowledge.id (local UUID)",
      "content_hash stored at package installation time (SHA-256 integrity)",
      "RLS: authenticated users read only their own customer_knowledge (user_id isolation)",
      "Fallback behavior: if customer_knowledge table empty → existing V1 Console fetch (transitional)",
      "Tests: local read path, Console-offline simulation, knowledge_snapshot traceability, hash integrity, RLS isolation",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "customer_knowledge RLS: user_id = auth.uid() enforced",
      "No Console API credentials in Customer Trading View client code",
      "knowledge_snapshot: customer_knowledge.id (local) — not Console knowledge UUID exposed to browser",
      "content_hash: not used for auth, used for integrity only",
      "Chain-of-thought NOT stored (V1 policy maintained)",
    ],
    v1_safety: [
      "V1 Console Knowledge fetch path preserved as fallback (not removed in this stage)",
      "ai_analysis_logs.knowledge_snapshot format backward compatible",
      "V1 execution paths unchanged",
      "Migration 037 is additive only",
    ],
    codex_focus: [
      "Console-offline: does the system correctly fail closed if customer_knowledge is empty?",
      "Fallback: is the V1 Console fetch fallback correctly conditional (only if customer_knowledge empty)?",
      "RLS: can Customer A read Customer B's knowledge?",
      "knowledge_snapshot: is source_knowledge_id traceability preserved?",
      "Chain-of-thought: is it absent from all storage paths?",
    ],
    human_gate: [
      "Production Customer Supabase migration apply (migration 037)",
      "Production Knowledge Package deployment to any customer system",
    ],
    forbidden_actions: [
      "Do NOT remove V1 Console Knowledge fetch fallback in this stage (removed in Stage 9)",
      "Do NOT store chain-of-thought",
      "Do NOT share customer_knowledge records across customers",
    ],
  },

  // ── Stage 5 ──────────────────────────────────────────────────
  "V2-Stage-5": {
    name:    "Customer AI Trader Profile / Configuration",
    owner:   "Customer Trading System",
    doc:     "docs/v2/AI_TRADER_PROFILE.md",
    summary: "All AI Trader configuration (timeframe profiles, risk profiles) stored in Customer Supabase. Customer Trading View provides configuration UI. Console is admin provisioning tool only — NOT runtime owner.",
    files_changed: [
      "supabase/migrations/038_ai_trader_timeframe_profiles.sql",
      "supabase/migrations/039_ai_trader_risk_profiles.sql",
      "supabase/migrations/040_ai_trader_notification_profiles.sql",
      "src/app/api/traders/*/profile/route.ts (profile CRUD in Customer Trading View)",
      "src/lib/ai-trader/profile-resolver.ts",
      "src/infrastructure/trading/__tests__/stage5-profile.test.ts",
    ],
    dod: [
      "ai_trader_timeframe_profiles table: ai_trader_version_id, timeframe_style (SCALPING/DAY_TRADING/SWING), macro/trend/setup/entry/management timeframes[], monitor_interval_minutes",
      "ai_trader_risk_profiles table: ai_trader_version_id, risk_per_trade_percent, minimum_rr, max_positions, execution_policy",
      "ai_trader_notification_profiles table: ai_trader_version_id, per-event-type ON/OFF flags",
      "All profile tables stored in Customer Supabase (NOT Console Supabase)",
      "Default DAY_TRADING timeframe profile auto-created for existing ai_traders (V1 backward compat)",
      "Default profile = H1/M5 behavior (no runtime behavior change for existing traders)",
      "Customer Trading View: profile editing UI reads/writes to Customer Supabase directly",
      "Profile resolution: profileResolver reads from Customer Supabase (no Console API call)",
      "RLS: profiles isolated by user_id chain (ai_trader ownership)",
      "Tests: profile creation, default profile backward compat, profile-driven runtime behavior",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "All profile data in Customer Supabase (NOT Console Supabase)",
      "No Console API called for AI Trader profile at runtime",
      "RLS: Customer A cannot read Customer B's profiles",
      "Hard cap enforcement: risk_per_trade_percent ≤ system maximum",
      "execution_policy: AUTONOMOUS only permitted for DEMO accounts (enforced in Stage 6)",
    ],
    v1_safety: [
      "Default profile preserves V1 H1+M5 behavior",
      "Existing ai_trader_versions untouched (additive new tables)",
      "V1 execution paths unchanged",
    ],
    codex_focus: [
      "Customer System ownership: does any profile data get stored in Console Supabase?",
      "Console runtime dependency: does profileResolver call any Console API?",
      "Default profile: do existing V1 traders get H1+M5 compatible profile automatically?",
      "RLS: cross-customer isolation on all three new tables",
      "Hard caps: is risk_per_trade_percent bounded server-side?",
    ],
    human_gate: [
      "Production Customer Supabase migration apply (migrations 038-040)",
    ],
    forbidden_actions: [
      "Do NOT store AI Trader configuration in Console Supabase as runtime source",
      "Do NOT make Console a runtime owner of AI Trader profiles",
      "Do NOT remove V1 ai_trader_versions columns",
      "Do NOT enable AUTONOMOUS execution mode for LIVE accounts",
    ],
  },

  // ── Stage 6 ──────────────────────────────────────────────────
  "V2-Stage-6": {
    name:    "Dynamic Position Sizing / Risk Engine Extension",
    owner:   "Customer Trading System",
    doc:     "docs/v2/DYNAMIC_POSITION_SIZING.md",
    summary: "Customer configures risk_per_trade_percent in AI Trader Risk Profile. Risk Engine calculates authoritative lot from Customer MT5 equity and symbol specs. AI cannot arbitrarily set lot size.",
    files_changed: [
      "src/lib/ai-trader/risk-engine.ts (read risk_per_trade_percent + price translation + hard caps)",
      "src/app/api/traders/[id]/decide/route.ts (Approval UI shows lot/risk%/maxLoss/RR)",
      "src/infrastructure/trading/__tests__/stage6-dynamic-sizing.test.ts",
    ],
    dod: [
      "Risk Engine reads risk_per_trade_percent from ai_trader_risk_profiles",
      "Lot calculation: risk_amount = equity × risk% → volume = risk_amount / (sl_distance/tick_size × tick_value)",
      "Lot uses Customer MT5 symbol_specs: tick_size, tick_value, contract_size, volume_min, volume_max, volume_step",
      "Lot rounded DOWN to volume_step (safe direction — never round up)",
      "Price translation: reference SL/TP (from AI analysis) translated to customer-executable prices before lot calc",
      "BUY: uses customer MT5 ASK. SELL: uses customer MT5 BID",
      "Hard system caps enforced: SYSTEM_MAX_RISK_PERCENT, SYSTEM_MAX_VOLUME_PER_TRADE",
      "Edge cases handled: equity=0 → DENIED, symbol_specs missing → DENIED, risk%=0 → DENIED",
      "Calculated volume < volume_min → DENIED (not rounded up to min)",
      "Owner Approval UI displays: Entry, SL, TP, Lot, Risk%, Max Loss amount, R:R ratio",
      "All existing V1 Risk Engine checks (16 checks) preserved — new checks added, none removed",
      "Tests: lot calculation, price translation, hard cap enforcement, edge cases, volume_step rounding",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "Hard caps enforced server-side (not customer-bypassable via API)",
      "AI cannot set lot directly — all lot determination goes through Risk Engine",
      "Execution prices (ASK/BID) come from Customer MT5 (not central market data)",
      "No LIVE account execution in tests",
    ],
    v1_safety: [
      "All 16 existing V1 Risk Engine safety checks preserved (none removed)",
      "V1 default behavior if risk_per_trade_percent is null: existing max_risk_per_trade fallback",
      "V1 execution paths unchanged",
    ],
    codex_focus: [
      "Lot formula: is risk_amount / loss_per_lot_at_stop mathematically correct?",
      "Volume rounding: is it always floor (never ceil)?",
      "Price translation: does SL distance preservation work correctly for BUY and SELL?",
      "Hard caps: can a customer bypass SYSTEM_MAX_RISK_PERCENT via API manipulation?",
      "V1 regression: are all 16 existing checks still present?",
      "Edge cases: equity=0, missing symbol_specs, volume < volume_min — all DENIED?",
    ],
    human_gate: [
      "Production Risk Engine deployment (affects all customer execution paths)",
      "LIVE account execution enable (permanently prohibited without separate authorization)",
    ],
    forbidden_actions: [
      "Do NOT allow AI to set lot size directly",
      "Do NOT remove any existing V1 Risk Engine safety check",
      "Do NOT use central market data prices for lot calculation (Customer MT5 only)",
      "Do NOT round lot UP (always floor to volume_step)",
      "Do NOT enable LIVE account execution",
    ],
  },

  // ── Stage 7 ──────────────────────────────────────────────────
  "V2-Stage-7": {
    name:    "Console Business / Infrastructure Redesign",
    owner:   "AVL FX Console",
    doc:     "docs/v2/AVL_CONSOLE_TARGET.md",
    summary: "Console role formally aligned to Business & Infrastructure only. V1 legacy market-data code formally marked LEGACY/DEPRECATED in codebase. Console does NOT collect market prices or run trading runtime.",
    files_changed: [
      "AVL-FX console/src/app/* (CRM, billing, system inventory UI)",
      "AVL-FX console/src/app/api/* (business management endpoints)",
      "Legacy market-data code: add DEPRECATED comments / disable collection routes (do NOT delete yet)",
      "AVL-FX console/src/lib/*.ts (business logic for CRM, billing)",
    ],
    dod: [
      "Console CRM UI: Customer list with status, contract, billing, MRR",
      "Console System Inventory: Vercel/Railway/Supabase/domain per customer (metadata only)",
      "Console Health Dashboard: MT5 heartbeat status, EA version, bridge online/offline (operational metadata only — NOT market prices)",
      "Console V1 legacy market-data routes: marked as LEGACY, collection disabled or removed from active paths",
      "AVL_Console_DataManager EA: marked as LEGACY in documentation and codebase comments (not physically deleted)",
      "Console bar_data table: marked as LEGACY (no new writes from V2 architecture)",
      "Console Research API: retained as read-only legacy (not called by Customer AI Trader runtime in V2)",
      "Console does NOT add any new route that collects market prices for Customer AI Trader",
      "Console LINE administration UI (basic: linked status, last notification, delivery log)",
      "Tests: admin-only access, no cross-customer data leakage, Console health data format",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "Console does not have new market price collection endpoints",
      "Admin-only access enforced on all management endpoints",
      "No customer trade data (positions, execution) accessible cross-customer in Console",
      "Console LINE admin: line_user_id not exposed to browser",
      "V1 legacy code disabled — not actively collecting data — but not deleted",
    ],
    v1_safety: [
      "V1 Console DataManager EA: code preserved but marked LEGACY (do NOT delete in this stage)",
      "V1 Console bar_data table: preserved but marked LEGACY (not written to in V2)",
      "V1 Console Research API: preserved as read-only legacy",
      "Customer Trading View V1 runtime: unaffected",
    ],
    codex_focus: [
      "No new market price collection: does Console add any new OHLC/tick collection routes?",
      "Legacy marking: is V1 market-data code properly marked DEPRECATED without deletion?",
      "Admin isolation: can Customer A access Customer B's business data through Console?",
      "Health data boundary: does Console health UI only show operational metadata (no market prices)?",
      "LINE admin: is line_user_id protected (service_role only)?",
    ],
    human_gate: [
      "Production Console deployment",
      "Production V1 legacy code physical deletion (separate operational decision, NOT this stage)",
      "Production Console ENV changes",
    ],
    forbidden_actions: [
      "Do NOT physically delete V1 legacy market-data code in this stage (deprecate only)",
      "Do NOT add new market price collection to Console",
      "Do NOT make Console a runtime dependency for Customer AI Trader",
      "Do NOT apply Production Console migrations without Human Gate",
    ],
  },

  // ── Stage 8 ──────────────────────────────────────────────────
  "V2-Stage-8": {
    name:    "LINE Notification Service",
    owner:   "Console (routing) + Customer System (event emission)",
    doc:     "docs/v2/LINE_NOTIFICATION_ARCHITECTURE.md",
    summary: "Customer Trading View emits notification events. Console Notification Service routes to LINE AVL AI. LINE failure never blocks trading safety.",
    files_changed: [
      "supabase/migrations/041_customer_line_links.sql",
      "supabase/migrations/042_notification_preferences.sql",
      "supabase/migrations/043_notification_events.sql",
      "supabase/migrations/044_notification_deliveries.sql",
      "AVL-FX console/src/app/api/notifications/* (LINE adapter, webhook, delivery service)",
      "src/lib/notifications/notification-emitter.ts (Customer TV event emission)",
      "src/app/settings/notifications/* (LINE link/unlink UI)",
    ],
    dod: [
      "customer_line_links table: user_id, line_user_id, status (PENDING/ACTIVE/REVOKED), linked_at, revoked_at",
      "notification_preferences table: per-user, per-event-type ON/OFF",
      "notification_events table: event_id (idempotency key), event_type, customer_id, payload, emitted_at",
      "notification_deliveries table: event_id, channel, status (PENDING/DELIVERED/FAILED/SKIPPED), delivery log",
      "LINE linking flow: state token mechanism (32-byte random, 15-min TTL, single-use, hash stored)",
      "LINE channel adapter: LINE Messaging API push message",
      "Webhook endpoint: X-Line-Signature verification MANDATORY (HMAC-SHA256 timing-safe)",
      "Notification Event Service: deduplication (idempotency_key), state-transition gating (WAIT→WAIT = no notify)",
      "LINE failure: delivery marked FAILED, trading runtime UNAFFECTED",
      "LINE_CHANNEL_ACCESS_TOKEN: Console server env only (NEVER in Trading View or browser)",
      "Customer LINE settings page: link/unlink UI",
      "Tests: linking flow, webhook signature verification, delivery, failure isolation, deduplication",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "LINE_CHANNEL_ACCESS_TOKEN: NEVER in Trading View, NEVER in browser, NEVER in NEXT_PUBLIC_*",
      "Webhook: X-Line-Signature verified on EVERY inbound request (not optional)",
      "State token: hash stored (not raw), single-use, 15-min TTL",
      "line_user_id: service_role only in DB; never sent to browser",
      "LINE notification failure: does NOT propagate to Risk Engine or trading runtime",
      "Customer isolation: Customer A cannot receive Customer B's notifications",
    ],
    v1_safety: [
      "LINE delivery fully additive — no V1 execution path modified",
      "Trading Safety: LINE service outage never blocks Risk Engine or execution",
      "V1 customer_bar_data and knowledge tables unaffected",
    ],
    codex_focus: [
      "CRITICAL: Is webhook signature verification present and mandatory? Any bypass path?",
      "CRITICAL: Is LINE_CHANNEL_ACCESS_TOKEN absent from all Trading View code?",
      "Failure isolation: if LINE Messaging API returns 500, does trading continue normally?",
      "State-transition gating: is WAIT→WAIT correctly filtered out?",
      "line_user_id: is it ever sent to browser or logged?",
      "Idempotency: are duplicate notification_events correctly deduplicated?",
    ],
    human_gate: [
      "Production LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET setup in Console Vercel env",
      "Production webhook URL registration in LINE Developers Console",
      "Enabling notifications for real customers",
      "Production Customer Supabase migrations (041-044)",
    ],
    forbidden_actions: [
      "Do NOT store LINE_CHANNEL_ACCESS_TOKEN in Trading View env",
      "Do NOT skip webhook signature verification",
      "Do NOT allow LINE to trigger trade execution",
      "Do NOT make trading runtime depend on LINE availability",
    ],
  },

  // ── Stage 9 ──────────────────────────────────────────────────
  "V2-Stage-9": {
    name:    "Customer Self-Contained Runtime Cutover",
    owner:   "Customer Trading System",
    doc:     "docs/v2/V2_ARCHITECTURE.md",
    summary: "Remove all runtime dependencies on Console from Customer AI Trader. Customer Supabase (customer_bar_data + customer_knowledge + profiles) is the sole runtime data source. Console API is never called during trading.",
    files_changed: [
      "src/lib/ai-trader/knowledge/trading-knowledge.ts (remove V1 Console fetch fallback)",
      "src/infrastructure/ai/knowledge/init/route.ts (or equivalent — remove Console proxy)",
      "src/app/api/knowledge/route.ts (deprecate or redirect)",
      "Verify: no remaining console-fetch calls in AI Trader runtime paths",
    ],
    dod: [
      "selectKnowledgeForTrader(): V1 Console fetch fallback REMOVED — fails closed if customer_knowledge empty",
      "Customer AI Trader analysis: zero Console API calls in the critical path",
      "Customer chart: reads from customer_bar_data only (not Console bar_data / Research API)",
      "Profile resolution: reads from Customer Supabase only (no Console API)",
      "Console offline simulation test: Customer AI Trader runs analysis successfully",
      "Console offline simulation test: Chart renders from customer_bar_data",
      "No remaining /api/knowledge proxy that calls Console at runtime",
      "V2 minimum data verification: customer_bar_data has ≥ 90 days of H1+M5 bars before cutover",
      "Regression: all V2 Stage 1-8 features still working",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "No Console API credentials in Customer Trading View production runtime",
      "KNOWLEDGE_API_SECRET: removed from Customer Trading View runtime path (or kept only for legacy admin)",
      "Console offline test: no hard failures or uncaught errors when Console unreachable",
    ],
    v1_safety: [
      "V1 Console Knowledge path: removed from runtime (intentional — this is the cutover stage)",
      "Existing V1 execution safety (Risk Engine, Bridge, Gateway) unaffected",
      "customer_bar_data verified sufficient before removing bar_data dependency",
    ],
    codex_focus: [
      "Zero Console calls: grep for any remaining Console API calls in runtime paths",
      "Fail closed: if customer_knowledge is empty, does analysis fail closed (not silently degrade)?",
      "Console offline test: is it a real test (not mocked Console returning success)?",
      "Minimum data gate: is the 90-day bar verification enforced before cutover?",
      "Regression: are Stage 1-8 features confirmed working after Console dependency removal?",
    ],
    human_gate: [
      "Approve removal of Console Knowledge API dependency from Production",
      "Verify ≥ 90 days of customer_bar_data in Production before removing bar_data dependency",
      "Run parallel verification for ≥ 30 days before cutover",
      "Production Customer Supabase changes",
    ],
    forbidden_actions: [
      "Do NOT remove Console dependency until ≥ 90 days of customer_bar_data verified",
      "Do NOT run parallel verification for less than 30 days before cutover",
      "Do NOT skip the Console offline simulation test",
    ],
  },

  // ── Stage 10 ─────────────────────────────────────────────────
  "V2-Stage-10": {
    name:    "Customer Self-Contained Integration Verification",
    owner:   "Full System",
    doc:     "docs/v2/V2_IMPLEMENTATION_ROADMAP.md",
    summary: "Full integration verification of Customer Self-Contained system. No natural DEMO trade yet. All components tested together: MT5 → Bridge → Gateway → Supabase → AI → Risk → Approval boundary.",
    files_changed: [
      "src/infrastructure/trading/__tests__/stage10-integration.test.ts",
      "gateway/src/*.integration.test.ts",
      "docs/v2/V2_FINAL_E2E_GATE.md (verification checklist updated with actual results)",
    ],
    dod: [
      "Integration test: market data pipeline (MT5 → Bridge → Gateway → customer_bar_data → Chart)",
      "Integration test: AI analysis uses customer_knowledge (no Console call)",
      "Integration test: profile-driven runtime (timeframe profile drives analysis TF, not hardcoded H1/M5)",
      "Integration test: dynamic lot calculation (equity × risk% → correct volume)",
      "Integration test: Owner Approval flow (decision → approval → Risk Engine → command created)",
      "Integration test: execution boundary (command → Gateway → Bridge API — no actual MT5 order in this stage)",
      "Integration test: LINE notification delivery for ENTRY_CANDIDATE event",
      "Verification: Console offline → Customer AI Trader pipeline runs normally",
      "Verification: Customer A cannot access Customer B's data in any component",
      "Failure semantics: missing symbol_specs → execution DENIED (not degraded)",
      "Failure semantics: customer_bar_data gap → AI analysis fail closed",
      "Failure semantics: LINE unavailable → trading unaffected",
      "All V2 Stage 1-9 regression tests pass",
      "Typecheck PASS, Build PASS",
    ],
    security_checklist: [
      "Cross-customer isolation verified across all components",
      "No Console API calls in Customer Trading System runtime",
      "LINE_CHANNEL_ACCESS_TOKEN not in Customer Trading View",
      "All failure semantics confirmed fail-closed (not fail-open)",
    ],
    v1_safety: [
      "All V1 inherited safety checks still pass (16 Risk Engine checks, bridge safety, command idempotency)",
      "No V1 execution path regressed",
    ],
    codex_focus: [
      "Coverage: do integration tests cover all V2 features (Stages 1-9)?",
      "Customer isolation: is cross-customer data access impossible across all components?",
      "Failure semantics: are all DENIED cases actually DENIED (not silently degraded)?",
      "Console independence: is the Console offline test a true isolation test?",
      "Safety regression: are all 16 V1 execution safety checks still present and passing?",
    ],
    human_gate: [
      "Approve Final Gate execution plan (next step after this stage)",
      "Confirm all integration tests reviewed and understood before Final Gate",
      "Production deployments of verified V2 system",
    ],
    forbidden_actions: [
      "Do NOT issue real MT5 orders in integration tests",
      "Do NOT mark this stage COMPLETE if any cross-customer isolation test fails",
      "Do NOT advance to Final Gate without Human Gate approval",
      "Do NOT use LIVE account for any test in this stage",
    ],
  },

  // ── Final Gate ───────────────────────────────────────────────
  "V2-Final": {
    name:    "Natural Customer DEMO E2E — Trading System Production Qualification",
    owner:   "Full System — Human Gate MANDATORY",
    doc:     "docs/v2/V2_FINAL_E2E_GATE.md",
    summary: "Complete natural lifecycle with real Customer MT5 DEMO account and natural market conditions. Owner manually approves each execution. Broker-confirmed fills required. This is the V2 Trading System Production Qualification gate.",
    files_changed: [
      "reports/orchestrator/final-gate-report.json (verification report)",
      "docs/v2/V2_FINAL_E2E_GATE.md (checklist updated with actual evidence)",
    ],
    dod: [
      "HUMAN GATE: Owner has explicitly confirmed: account_type=DEMO, non-live, real_money=false",
      "Market data: customer_bar_data persisting correctly during test period",
      "Market data: Bridge reconnect backfill verified (EA restart → gap filled)",
      "Natural H1 Scenario generated from Customer MT5 data (no fake scenario injection)",
      "Natural Entry Candidate generated by AI (no forced ENTER)",
      "Dynamic lot calculation shown in Owner Approval UI",
      "Owner manually approves in Customer Trading View (NOT via LINE, NOT auto-approved)",
      "Risk Engine: all 16 checks PASS (verified in approval flow)",
      "execution_command created after approval",
      "Unified Bridge sends OrderSend() to Customer MT5 DEMO",
      "Broker-confirmed FILL received (actual broker position ticket)",
      "ai_positions status = OPEN with actual fill price",
      "Hard Broker SL confirmed (broker-side SL order active)",
      "Position management: at least one management cycle (HOLD or SL/TP check)",
      "Controlled close: either TP hit, SL hit, or manual close",
      "Broker-confirmed OUT deal received",
      "ai_positions status = CLOSED",
      "Trade Review created",
      "AI Log: complete decision timeline from scenario → close",
      "Reconciliation: ai_positions matches live_positions, no orphans",
      "LINE notification delivered for: OWNER_APPROVAL_REQUIRED, ORDER_FILLED, POSITION_CLOSED",
      "Customer isolation: test customer data not visible to other customers",
    ],
    security_checklist: [
      "DEMO account confirmed before any order (account_type=DEMO, not LIVE)",
      "Owner manually approved — no auto-approval bypass",
      "No LIVE money involved",
      "All customer data isolated (test customer only)",
    ],
    v1_safety: [
      "All V1 Safety Baseline properties confirmed working in natural lifecycle",
      "Hard Broker SL: active and not overridden",
      "Risk Engine: all checks confirmed in execution path",
    ],
    codex_focus: [
      "Evidence completeness: is each DoD item confirmed with evidence (not just asserted)?",
      "DEMO verification: is there evidence of account_type=DEMO from actual MT5 response?",
      "Owner Approval: is there evidence that human approval was required (not bypassed)?",
      "Broker FILLED: is there an actual position_ticket from the broker?",
      "Broker CLOSED: is there an actual deal_ticket from the broker?",
      "Reconciliation: are ai_positions and live_positions reconciled with no orphans?",
      "Trade Review: does it contain accurate analysis (not fabricated)?",
    ],
    human_gate: [
      "MANDATORY: Owner must confirm account_type=DEMO before any order",
      "MANDATORY: Owner manually approves each execution in Customer Trading View",
      "MANDATORY: Codex Final Independent Audit must PASS",
      "MANDATORY: All 23 DoD items must have evidence in final-gate-report.json",
      "ABSOLUTELY FORBIDDEN: LIVE account order",
      "ABSOLUTELY FORBIDDEN: Real money movement",
    ],
    forbidden_actions: [
      "Do NOT issue any LIVE account order",
      "Do NOT auto-approve the Owner Approval step",
      "Do NOT inject fake market data, fake scenario, or fake decisions",
      "Do NOT mark as COMPLETE without all 23 DoD items verified with evidence",
      "Do NOT advance without Codex Final Independent Audit PASS",
    ],
  },

};

/**
 * Get the review prompt for a given stage and commit.
 * This is sent to Codex as the review instruction.
 */
export function buildReviewPrompt(stageName, commitSha, reviewCycle, baseCommit) {
  const def = STAGE_DEFINITIONS[stageName];
  if (!def) {
    throw new Error(`No stage definition found for: ${stageName}`);
  }

  const dodList      = def.dod.map((d, i) => `  ${i + 1}. ${d}`).join("\n");
  const secList      = def.security_checklist.map(s => `  - ${s}`).join("\n");
  const v1List       = def.v1_safety.map(s => `  - ${s}`).join("\n");
  const focusList    = def.codex_focus.map(f => `  - ${f}`).join("\n");
  const filesList    = def.files_changed.map(f => `  - ${f}`).join("\n");
  const forbidList   = (def.forbidden_actions ?? []).map(f => `  ✗ ${f}`).join("\n");
  const humanGateList = (def.human_gate ?? []).map(h => `  ⚠ ${h}`).join("\n");
  const ownerLine    = def.owner ? `Owner: ${def.owner}` : "";
  const resolvedBase = baseCommit ?? (V2_STAGE_BASELINES[stageName] ?? "HEAD~10");
  const gitRangeInstructions = `
HOW TO FIND THE STAGE CHANGES (SCOPED to ${stageName}):
  IMPORTANT: Only review the files listed in the stage DoD below.
  Do NOT review pre-existing V1 code or unrelated infrastructure changes.

  To see the stage-specific changes:
  Run: git log ${resolvedBase}..HEAD --oneline
  Then for each DoD file, run: git diff ${resolvedBase} HEAD -- <file>

SCOPE RESTRICTION: Only review files explicitly listed in the CHANGED FILES section.
DO NOT flag issues in pre-existing V1 routes unless they were modified by this stage.
Pre-existing V1 code outside stage scope should not produce findings.`;

  return `You are Codex, an INDEPENDENT code reviewer for the AVL-FX trading system.

ROLE: REVIEWER ONLY. Do NOT modify any files. Do NOT write code. Only read and review.
${gitRangeInstructions}

═══════════════════════════════════════════════════
REVIEW TARGET
  Stage:        ${stageName} — ${def.name}
  ${ownerLine}
  Commit SHA:   ${commitSha}
  Review Cycle: ${reviewCycle}
═══════════════════════════════════════════════════

CHANGED FILES (read these via git diff of commit ${commitSha}):
${filesList}

═══════════════════════════════════════════════════
DEFINITION OF DONE (verify each):
${dodList}

═══════════════════════════════════════════════════
SECURITY CHECKLIST:
${secList}

═══════════════════════════════════════════════════
V1 SAFETY BASELINE (must not be broken):
${v1List}

═══════════════════════════════════════════════════
FOCUS AREAS:
${focusList}
${forbidList ? `\n═══════════════════════════════════════════════════\nFORBIDDEN ACTIONS (if any of these are present, it is P0):\n${forbidList}` : ""}
${humanGateList ? `\n═══════════════════════════════════════════════════\nHUMAN GATE REQUIREMENTS (flag if automated test bypasses these):\n${humanGateList}` : ""}

═══════════════════════════════════════════════════
SEVERITY DEFINITIONS:
  P0 = Blocking: security holes, data loss, V1 execution path broken
  P1 = Must fix before production: correctness bugs, safety violations
  P2 = Should fix: missing tests, maintainability issues
  P3 = Optional: style, minor improvements

PASS = p0 is empty AND p1 is empty
FAIL = p0 OR p1 has items

═══════════════════════════════════════════════════
OUTPUT REQUIREMENT:
Respond with ONLY a valid JSON object. No other text before or after.
No markdown code blocks. Raw JSON only.

{
  "stage": "${stageName}",
  "reviewed_commit": "${commitSha}",
  "review_cycle": ${reviewCycle},
  "status": "PASS",
  "findings": {
    "p0": [],
    "p1": [],
    "p2": [],
    "p3": []
  },
  "checks": {
    "idempotency_correct": true,
    "utc_normalization_correct": true,
    "customer_isolation_correct": true,
    "authentication_correct": true,
    "validation_correct": true,
    "v1_regression_clean": true,
    "security_clean": true,
    "test_adequate": true,
    "migration_safe": true,
    "dod_satisfied": true
  },
  "next_action": "PROCEED_TO_NEXT_STAGE",
  "reviewer_notes": "..."
}
`;
}

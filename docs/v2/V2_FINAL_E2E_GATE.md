# AVL-FX V2 Final Gate — Customer Self-Contained Controlled DEMO E2E

**Document type:** POST-V1 Target Architecture — Final Production Gate  
**Status:** DESIGN — requirements migrated from V1 Stage 10-C  
**Created:** 2026-09-26  
**Migrated from:** V1 Stage 10-C (SUSPENDED — SUPERSEDED BY V2 FINAL)  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Migration from V1 Stage 10-C

V1 Stage 10-C was defined as: Natural Entry Candidate → Risk Engine → Owner Approval → Execution → MT5 DEMO Fill → Position Management → Close → Trade Review → Reconciliation.

Stage 10-C was **SUSPENDED** because:
1. POST-V1 Architecture changed to Customer Self-Contained (new Market Data, Knowledge, Bridge architecture)
2. Running Stage 10-C on V1 architecture and then rebuilding V2 architecture and re-running E2E would be duplicate work
3. All Stage 10-C requirements are migrated here to V2 Final Gate

**Stage 10-C requirements are NOT abandoned. They are migrated and enhanced.**

---

## 2. V2 Final Gate — Definition

The V2 Final Gate is the **last and highest-confidence gate** in AVL-FX development.

**Purpose:** Prove that the complete V2 Customer Self-Contained system works end-to-end with a real Customer MT5 DEMO account, natural market conditions, and zero shortcuts.

**When:** After all V2 Stages 0–10 are complete and verified.

**What it proves:**
- Customer MT5 is the canonical market data and execution price source
- Unified Bridge EA delivers market data and executes safely
- Customer Supabase holds historical bar data and knowledge
- AI Trader operates without any Console runtime dependency
- Risk Engine calculates lot from Customer MT5 equity and symbol specs
- Owner Manual Approval is required before any real order
- Natural lifecycle completes from scenario → fill → position → close → review
- LINE notification delivers trade events

---

## 3. Fundamental Rules (Non-Negotiable)

```
✗ Do NOT force ENTER
✗ Do NOT modify strategy to increase entry frequency
✗ Do NOT relax risk parameters
✗ Do NOT insert fake bar data
✗ Do NOT directly insert scenario into DB
✗ Do NOT directly insert decision into DB
✗ Do NOT bypass Owner Approval
✗ Do NOT bypass Risk Engine
✗ Do NOT bypass Unified Bridge execution path
✗ Do NOT use mock MT5 fills

Wait for NATURAL market conditions.
Only proceed when a NATURAL Entry Candidate appears.
```

---

## 4. Complete V2 Final Gate Requirements

### 4-1. Market Data Prerequisites (NEW in V2 — from P1-01/P1-02)

```
[  ] Customer MT5 connected and Unified Bridge EA running
[  ] OHLC bars persisting to customer_bar_data (M5, H1 minimum)
[  ] Realtime chart updating from customer_bar_data + WebSocket
[  ] customer_bar_data: no duplicates, correct timestamps, UTC canonical
[  ] customer_bar_data: Customer A / Customer B data completely isolated
[  ] MT5 restart → Bridge reconnect → missing bars backfilled
[  ] AI Trader and Chart reading from same customer_bar_data
[  ] broker_symbol canonicalized correctly (e.g., GOLD# → GOLD)
[  ] broker server UTC offset confirmed and applied
```

### 4-2. DEMO Account Verification

```
[  ] account_type = DEMO (verified from Customer MT5)
[  ] account_mode = HEDGING (verified from Customer MT5)
[  ] Risk Engine DEMO guard: LIVE execution prohibited in DEMO mode
[  ] execution_mode = DEMO_AUTONOMOUS or MANUAL_APPROVAL_DEMO
[  ] DEMO proof displayed in Owner Approval UI
[  ] actual broker name confirmed
[  ] actual broker symbol confirmed (e.g., XM GOLD#)
```

### 4-3. Symbol Specification

```
[  ] symbol_specs populated from Customer MT5 (via Unified Bridge)
[  ] tick_size correct for Customer broker (not assumed)
[  ] tick_value correct for Customer broker (not assumed)
[  ] contract_size correct for Customer broker (not assumed)
[  ] volume_min, volume_max, volume_step correct
[  ] stops_level correct (minimum SL distance)
```

### 4-4. Customer Knowledge (NEW in V2 — from P1-03)

```
[  ] customer_knowledge table populated (Knowledge Package installed)
[  ] AI Trader reads from customer_knowledge (no Console fetch at runtime)
[  ] Console offline scenario tested: AI Trader continues operating
[  ] knowledge_snapshot in ai_analysis_logs references customer_knowledge.id
```

### 4-5. Natural Market Data Flow

```
[  ] Customer MT5 generating M5 bars
[  ] Customer MT5 generating H1 bars (profile-defined timeframes)
[  ] bars delivered to Customer Gateway
[  ] bars upserted to customer_bar_data (confirmed)
[  ] no broker timestamp errors
[  ] no missing bar detection events
[  ] Chart displaying accurate data matching MT5 charting platform
```

### 4-6. Natural H1 Scenario

```
[  ] H1 cron triggers correctly (per timeframe profile — not hardcoded)
[  ] AI analysis runs with customer_knowledge (not Console fetch)
[  ] H1 Scenario created in ai_trader_scenarios
[  ] Scenario direction confirmed (BULLISH / BEARISH / NEUTRAL / WAIT)
[  ] knowledge_snapshot stored
[  ] No fake scenario inserted
```

### 4-7. Natural M5 Watcher

```
[  ] M5 watcher activates based on H1 Scenario (WATCH state)
[  ] M5 bar close triggers watcher evaluation
[  ] Entry condition evaluation uses customer_bar_data
[  ] AI re-evaluation with customer_knowledge
```

### 4-8. Natural Entry Candidate

```
[  ] ENTER_LONG or ENTER_SHORT generated by AI
[  ] Entry direction matches H1 Scenario
[  ] Entry, SL, TP suggested by AI (reference from customer MT5 prices)
[  ] Decision created in trade_decisions
[  ] No manual decision injection
```

### 4-9. Dynamic Position Sizing (NEW in V2 — from P1-04)

```
[  ] equity read from mt5_connections (Customer MT5, via Bridge heartbeat)
[  ] risk_per_trade_percent read from ai_trader_risk_profiles
[  ] lot calculated: risk_amount = equity × risk% → volume from SL distance
[  ] lot uses tick_value, tick_size, contract_size from symbol_specs
[  ] lot rounded down to volume_step
[  ] lot within volume_min / volume_max
[  ] hard system caps enforced
```

### 4-10. Owner Approval UI

```
[  ] Approval request displayed in Customer Trading View
[  ] Owner sees: Trader name, Direction, Entry price, SL price, TP price
[  ] Owner sees: Lot, Risk/Reward ratio, Risk %, Maximum Loss amount
[  ] Owner sees: Decision ID, Scenario ID
[  ] Owner sees: DEMO account proof (account type, broker)
[  ] Owner sees: Customer MT5 account identifier
[  ] Owner explicitly approves in Trading View (not via LINE)
[  ] Approval is atomic (duplicate approval prevented)
[  ] Rejection path works correctly
```

### 4-11. Risk Engine

```
[  ] execution_mode check
[  ] Kill Switch check
[  ] DEMO account guard
[  ] HEDGING mode check
[  ] account snapshot freshness check
[  ] symbol specification present
[  ] daily risk limits check
[  ] duplicate open position check
[  ] live quote freshness check
[  ] spread guard
[  ] decision expiry check
[  ] lot calculation (tick-value based, using Customer MT5 symbol specs)
[  ] stop level validation (Customer broker stops_level)
[  ] margin check (Customer MT5 free_margin)
[  ] total exposure check
[  ] minimum RR check (from ai_trader_risk_profiles)
[  ] max positions check (from ai_trader_risk_profiles)
```

### 4-12. Execution Command

```
[  ] execution_command created after Risk Engine PASS + Owner Approval
[  ] command_id unique
[  ] connection_id correct (this customer's connection only)
[  ] expires_at set (UTC absolute)
[  ] symbol is broker_symbol (e.g., GOLD# for XM)
[  ] direction: BUY or SELL
[  ] volume: lot calculated by Risk Engine
[  ] sl_price: Customer broker-executable price
[  ] tp_price: Customer broker-executable price
```

### 4-13. Customer Gateway → Unified Bridge

```
[  ] Unified Bridge Execution Module polls for pending commands
[  ] EA validates: command_id unique, token match, not expired, symbol valid
[  ] EA validates: volume in [volume_min, volume_max], volume_step aligned
[  ] EA validates: SL in favorable direction
[  ] EA validates: SL distance ≥ stops_level
[  ] EA validates: account_type DEMO
```

### 4-14. MT5 Order Submission

```
[  ] OrderSend() called with correct parameters
[  ] BUY or SELL at market (or limit as designed)
[  ] SL and TP set at order time
[  ] Magic number set
[  ] Order accepted by broker
```

### 4-15. Broker-Confirmed FILLED

```
[  ] Bridge receives fill confirmation from MT5
[  ] fill_price reported by broker
[  ] position_ticket (actual MT5 ticket) received
[  ] POST /execution/fill-result sent to Customer Gateway
[  ] execution_command status updated to FILLED
[  ] ai_positions created/updated to OPEN
[  ] live_positions synchronized
[  ] NO false fill accepted (broker confirmation required)
```

### 4-16. Position State

```
[  ] ai_positions.status = OPEN
[  ] position_ticket stored
[  ] entry_price = actual fill price (not expected price)
[  ] SL price stored (actual broker SL)
[  ] TP price stored (actual broker TP)
[  ] position visible in Trading View UI
[  ] Broker SL order confirmed (hard protection active)
```

### 4-17. Position Management

```
[  ] Management timeframe monitoring active (per timeframe profile)
[  ] TP_RECHECK triggered when price approaches TP
[  ] SL_RECHECK triggered when price approaches SL
[  ] HOLD decision generates no command (correct)
[  ] MODIFY_SL generates command when required
[  ] MODIFY_TP generates command when appropriate
[  ] Position management does NOT weaken Hard Broker SL
[  ] Management idempotency key prevents duplicate management commands
```

### 4-18. Controlled Close

```
[  ] Close decision generated by AI or manual action
[  ] Close command sent via Risk Engine path (or manual close)
[  ] Bridge closes position on MT5
[  ] Broker confirms position closed (OUT deal)
[  ] ai_positions.status = CLOSED
[  ] close_price stored (actual broker close price)
[  ] P&L stored
```

### 4-19. Broker-Confirmed OUT Deal

```
[  ] Bridge receives close confirmation from MT5
[  ] deal_ticket (actual MT5 deal ticket) received
[  ] live_deals synchronized
[  ] trade_history updated
[  ] NO false close accepted (broker OUT deal required)
```

### 4-20. Trade Review

```
[  ] Trade Review created after close
[  ] Trade Review includes: entry, SL, TP, close, lot, P&L, duration
[  ] Trade Review includes: AI analysis that led to entry
[  ] Trade Review includes: knowledge_snapshot
[  ] Trade Review includes: Risk Engine decision
[  ] trade_outcomes record created
[  ] AI Log complete: scenario → decision → approval → fill → management events → close
```

### 4-21. Data Reconciliation

```
[  ] ai_positions matches live_positions (no orphan positions)
[  ] execution_commands all in terminal state (no orphan commands)
[  ] live_deals match trade_history
[  ] customer_bar_data: no gaps during trade lifecycle
[  ] customer_bar_data: OHLC matches MT5 charting platform data
[  ] No cross-customer data contamination
```

### 4-22. LINE Notification (NEW in V2 — from P1-07)

```
[  ] customer_line_links: customer has active LINE link
[  ] ENTRY_WATCH_STARTED notification delivered to customer LINE
[  ] OWNER_APPROVAL_REQUIRED notification delivered to customer LINE
[  ] ORDER_FILLED notification delivered to customer LINE
[  ] POSITION_CLOSED notification delivered to customer LINE
[  ] notification_events records created
[  ] notification_deliveries records: status DELIVERED
[  ] LINE notification failure does NOT block any trading operation
```

### 4-23. Idempotency and Safety

```
[  ] Kill Switch tested: triggers correctly, stops new entries
[  ] Duplicate command prevention: second identical command rejected
[  ] Expired command rejection: command past expires_at rejected
[  ] Orphan prevention: no orphan positions without DB record
[  ] False fill prevention: fill without broker confirmation rejected
[  ] False close prevention: close without broker OUT deal rejected
[  ] Customer isolation: customer B's data not affected by customer A's trade
[  ] Fail closed: Risk Engine denial produces no order
```

---

## 5. V2 Final Gate Verification Report Template

After completing the Final Gate:

```
V2 FINAL GATE VERIFICATION REPORT
Date: YYYY-MM-DD
Customer: Customer 001 (anonymized for docs)
Broker: [broker name]
Account type: DEMO
Account mode: HEDGING
MT5 broker symbol: [e.g., GOLD#]
Canonical symbol: GOLD

Market Data:
  customer_bar_data rows during test: [count]
  backfill test: [PASS/FAIL]
  Chart/AI data consistency: [PASS/FAIL]
  Customer isolation: [PASS/FAIL]

AI Analysis:
  H1 Scenarios generated: [count]
  Entry Candidates generated: [count]
  knowledge_source: customer_knowledge (no Console fetch)

Trade:
  Direction: [LONG/SHORT]
  Entry: [price]
  SL: [price]
  TP: [price]
  Lot: [volume]
  Risk %: [%]
  Max Loss: [amount]

Execution:
  Owner Approval: MANUAL — [timestamp]
  Risk Engine: PASS
  Bridge command: [command_id]
  MT5 OrderSend: [ticket]
  Broker FILLED: CONFIRMED — [fill_price] — [timestamp]

Position:
  ai_positions status: OPEN
  position_ticket: [ticket]
  Hard Broker SL: CONFIRMED

Close:
  Trigger: [TP_HIT / SL_HIT / MANUAL]
  Close price: [price]
  Broker OUT: CONFIRMED — [deal_ticket]
  P&L: [amount]
  Duration: [hours:minutes]

Reconciliation:
  ai_positions: CLOSED ✓
  live_positions: reconciled ✓
  live_deals: reconciled ✓
  No orphans: ✓

LINE Notifications delivered:
  ENTRY_WATCH_STARTED: [timestamp]
  OWNER_APPROVAL_REQUIRED: [timestamp]
  ORDER_FILLED: [timestamp]
  POSITION_CLOSED: [timestamp]

Safety checks all PASS: ✓
Idempotency verified: ✓
Customer isolation verified: ✓

RESULT: V2 FINAL GATE — PASS
```

---

## 6. Definition of V2 Production Complete

```
AVL-FX V2 PRODUCTION COMPLETE
=
All of the following PASS:

Architecture:             [  ] PASS
Customer Market Data:     [  ] PASS
Historical Persistence:   [  ] PASS
Backfill/Recovery:        [  ] PASS
Unified Bridge:           [  ] PASS
Customer Knowledge:       [  ] PASS
AI Trader:                [  ] PASS
Dynamic Position Sizing:  [  ] PASS
Console Business/Infra:   [  ] PASS
LINE Notification:        [  ] PASS
Customer Isolation:       [  ] PASS
Broker Independence Arch: [  ] PASS
Security:                 [  ] PASS
Safety:                   [  ] PASS
Full Regression:          [  ] PASS
Natural Customer DEMO E2E:[  ] PASS
Broker FILLED:            [  ] PASS
Broker CLOSE:             [  ] PASS
Trade History:            [  ] PASS
AI Log:                   [  ] PASS
Trade Review:             [  ] PASS
Reconciliation:           [  ] PASS
Codex Final Audit:        [  ] PASS
```

---

## 7. Stage 10-C Recovered Outcomes (V1 Pre-Work)

The following was verified during V1 Stage 10-C pre-work (preserved, not repeated):

```
✓ DEMO authoritative proof methodology
✓ Manual Approval path — owner verification flow
✓ Knowledge fail closed — analysis blocked without Knowledge
✓ Knowledge secret recovery — KNOWLEDGE_API_SECRET procedure
✓ Gateway /bridge/account compatibility — account data flow
✓ epoch timestamp normalization — UTC canonical procedure
✓ EA heartbeat recovery — reconnect behavior verified
✓ Risk Engine DEMO/HEDGING validation — guard behavior confirmed
✓ orphan reconciliation — position/command state recovery
✓ watcher/H1 runtime verification — cron + M5 event flow
```

These outcomes are inherited by V2. They do not need to be re-proved from scratch in V2 Stages 0–10. They are re-verified in the Final Gate E2E.

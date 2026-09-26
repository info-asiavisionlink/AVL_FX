# AVL-FX V2 — LINE Notification Infrastructure

**Document type:** V2 Planned Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

> LINE public API specifications change. This document defines the design intent.  
> Implementation must re-verify LINE Messaging API and LINE Login specifications  
> against official LINE documentation at time of implementation.

---

## 1. Core Design Principles

1. **One LINE Official Account**: AVL AI — used for all customers. No per-customer LINE accounts.
2. **Server-side authority**: `customer_line_links` mapping is the authority. LINE User ID is not an auth credential.
3. **Secret isolation**: LINE Channel Access Token and Channel Secret are server-only. Never in browser. Never in `NEXT_PUBLIC_` prefix. Never in customer Trading View app.
4. **Notification-only (V2 initial)**: LINE sends notifications and navigation deep links. No trade execution from LINE.
5. **Trading safety independence**: LINE failure must never affect Risk Engine or execution safety.

---

## 2. Customer ↔ LINE Canonical Data Model

### 2-1. customer_line_links table

```sql
-- Proposed: Customer Trading View Supabase
-- (customer's personal LINE link — part of their account)

CREATE TABLE customer_line_links (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- LINE User ID (from LINE platform, PII — handle carefully)
  line_user_id          TEXT NOT NULL,

  -- Linking status
  status                TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),

  linked_at             TIMESTAMPTZ,
  verified_at           TIMESTAMPTZ,
  last_notification_at  TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,

  -- Linking metadata (no PII)
  link_initiated_from   TEXT,        -- 'settings' | 'onboarding'
  link_method           TEXT,        -- 'liff' | 'oauth' | 'webhook'

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id),           -- one LINE link per Trading View account
  UNIQUE (line_user_id)       -- one Trading View account per LINE user
);
```

### 2-2. notification_preferences table

```sql
-- Proposed: Customer Trading View Supabase

CREATE TABLE notification_preferences (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id                   UUID REFERENCES ai_traders(id) ON DELETE CASCADE,
  -- NULL trader_id = account-level default

  -- Notification type toggles
  notify_h1_scenario          BOOLEAN NOT NULL DEFAULT true,
  notify_ai_analysis_changed  BOOLEAN NOT NULL DEFAULT true,
  notify_entry_watch          BOOLEAN NOT NULL DEFAULT true,
  notify_entry_candidate      BOOLEAN NOT NULL DEFAULT true,
  notify_owner_approval       BOOLEAN NOT NULL DEFAULT true,
  notify_order_filled         BOOLEAN NOT NULL DEFAULT true,
  notify_position_updated     BOOLEAN NOT NULL DEFAULT false,
  notify_sl_modified          BOOLEAN NOT NULL DEFAULT true,
  notify_tp_modified          BOOLEAN NOT NULL DEFAULT true,
  notify_position_closed      BOOLEAN NOT NULL DEFAULT true,
  notify_trade_review         BOOLEAN NOT NULL DEFAULT false,
  notify_system_warning       BOOLEAN NOT NULL DEFAULT true,

  -- Quiet hours (optional, UTC)
  quiet_hours_enabled         BOOLEAN NOT NULL DEFAULT false,
  quiet_hours_start_utc       TIME,
  quiet_hours_end_utc         TIME,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2-3. notification_events table

```sql
-- Proposed: Customer Trading View Supabase (or Console if centralized)

CREATE TABLE notification_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  trader_id       UUID,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  emitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT NOT NULL,  -- 'runtime' | 'watcher' | 'execution' | 'management'
  idempotency_key TEXT NOT NULL UNIQUE  -- prevent duplicate events
);
```

### 2-4. notification_deliveries table

```sql
-- Proposed: Customer Trading View Supabase (or Console if centralized)

CREATE TABLE notification_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES notification_events(id),
  channel         TEXT NOT NULL DEFAULT 'LINE',
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED')),
  attempted_at    TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  error_message   TEXT,         -- no LINE payload data in errors
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 3. LINE Linking Flow Design

### 3-1. Security Requirements

- AVL password must NOT be entered in LINE chat
- LINE User ID must not be used as authentication credential
- Linking state token must be time-limited and single-use
- Linking must be initiated from authenticated Trading View session (server knows user_id)

### 3-2. Recommended Flow: State Token + LINE Messaging API Webhook

```
[Customer in Trading View — authenticated]
     ↓
"LINEと連携する" button clicked
     ↓
Trading View server generates:
  link_state_token = cryptographically random (32 bytes hex)
  stored in DB: pending_line_links { user_id, token, expires_at (15 min) }
     ↓
Customer instructed to send specific message to LINE AVL AI:
  e.g., customer sends "LINK-{link_state_token}" to LINE AVL AI
  (or: QR code scan opens LINE chat with pre-filled message)
     ↓
LINE Messaging API Webhook receives message from customer LINE
     ↓
Server extracts token from message
  → lookup pending_line_links by token
  → verify not expired, not used
  → create customer_line_links { user_id, line_user_id, status: ACTIVE }
  → delete pending_line_links record
  → LINE reply: "連携が完了しました"
  → Trading View UI updates (polling or SSE)
     ↓
Linking complete — server-side mapping established
```

### 3-3. Alternative Flow: LIFF (LINE Front-end Framework)

```
Customer clicks "LINEと連携する"
  → Opens LIFF URL in LINE app
  → LIFF provides LINE User ID via liff.getProfile()
  → LIFF sends user_id + line_user_id + signed state to Trading View server
  → Server validates signed state, stores mapping

Note: LIFF requires LINE Login Channel (separate from Messaging API Channel)
Requires: LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET (server-only)
```

**Implementation note:** The exact linking mechanism (state token message vs LIFF vs LINE Login OAuth) must be chosen and verified against current LINE platform capabilities at implementation time. Both are valid architectures. The state token approach requires no additional LINE channel.

---

## 4. Notification Delivery Flow

```
Trading Runtime emits event:
  NotificationEvent {
    event_type:     "ORDER_FILLED",
    customer_id:    "user-uuid",
    trader_id:      "trader-uuid",
    idempotency_key: "fill-{command_id}",
    payload:        { symbol, direction, volume, fill_price, ... }
  }
        ↓
Notification Event Service:
  1. Deduplication check (idempotency_key already processed? skip)
  2. State transition gate (is this a material change?)
  3. customer_line_links lookup → line_user_id (status ACTIVE?)
  4. notification_preferences check (notify_order_filled enabled?)
  5. Quiet hours check
  6. If all pass: create notification_deliveries record (PENDING)
        ↓
LINE Channel Adapter (async — does NOT block runtime):
  7. Format LINE message (template + payload variables)
  8. POST to LINE Messaging API /message/push
     Authorization: Bearer {LINE_CHANNEL_ACCESS_TOKEN}
  9. On success: update notification_deliveries (DELIVERED)
     On failure: retry (transient) or mark FAILED (permanent)
     NEVER throw to trading runtime
```

---

## 5. State-Transition Notification Gate

To prevent notification spam, events are gated by state transitions:

```
Lifecycle state machine transitions that trigger notifications:

WAIT → WATCH                → ENTRY_WATCH_STARTED
WATCH → ENTER_LONG/SHORT    → ENTRY_CANDIDATE
ENTER → pending approval    → OWNER_APPROVAL_REQUIRED (MANUAL mode)
Approval → submission       → ORDER_SUBMITTED
Submission → FILLED         → ORDER_FILLED
OPEN → SL modified          → SL_MODIFIED
OPEN → TP modified          → TP_MODIFIED
OPEN → CLOSED               → POSITION_CLOSED
any → SYSTEM_WARNING        → SYSTEM_WARNING (not deduplicated by default)

NOT triggered (same state repeats):
WAIT → WAIT
HOLD → HOLD (monitoring with no action)
WATCH → WATCH (repeated watcher check with no new entry)
```

H1_SCENARIO_UPDATED is triggered once per H1 bar per trader (idempotency key includes trader_id + bar timestamp).

---

## 6. LINE → Trading View Deep Links

When LINE notification tapped, customer is directed to:

```
Notification Type           → Deep Link Target
ORDER_FILLED                → /traders/{trader_id}/positions
OWNER_APPROVAL_REQUIRED     → /traders/{trader_id}/approval
POSITION_CLOSED             → /traders/{trader_id}/history
TRADE_REVIEW_READY          → /traders/{trader_id}/review/{review_id}
SYSTEM_WARNING              → /traders/{trader_id}/status
H1_SCENARIO_UPDATED         → /traders/{trader_id}/chart
```

Deep links require customer to be authenticated in Trading View.  
If not authenticated: redirect to login, then to target.  
Deep link URL format: to be defined at implementation.

---

## 7. LINE Unlinking

```
Trading View Settings → Notifications → LINE → "LINE連携を解除"
        ↓
Server-side:
  1. customer_line_links.status = 'REVOKED'
  2. customer_line_links.revoked_at = now()
  3. Optional: LINE API call to unfollow (or just stop sending)
  4. Existing pending notification_deliveries marked SKIPPED
  5. Future notifications: line_user_id lookup returns no ACTIVE record → skip

LINE cannot be used to trigger unlinking of Trading View account.
Only Trading View authenticated session can revoke the link.
```

---

## 8. Environment Variables

### 8-1. Variable Classification

| Variable | Type | Location | Notes |
|---------|------|---------|-------|
| `LINE_CHANNEL_ACCESS_TOKEN` | server-only | Console `.env.local` / Vercel server-only | Messaging API channel long-lived token |
| `LINE_CHANNEL_SECRET` | server-only | Console `.env.local` / Vercel server-only | Webhook signature verification |
| `LINE_LOGIN_CHANNEL_ID` | server-only | Console `.env.local` / Vercel server-only | Required only if using LIFF/LINE Login |
| `LINE_LOGIN_CHANNEL_SECRET` | server-only | Console `.env.local` / Vercel server-only | Required only if using LIFF/LINE Login |
| `LINE_WEBHOOK_PATH` | server-only | Console `.env.local` | Optional: custom webhook path |

**NEVER:**
- `NEXT_PUBLIC_LINE_*` — Line secrets must never be browser-accessible
- Trading View `.env.local` must NOT contain any LINE token or secret
- Customer Gateway must NOT contain any LINE token or secret

### 8-2. Why Console, not Trading View

LINE Channel Access Token lives in Console because:
1. The Notification Delivery Service is a Console server-side module (V2 initial design)
2. Console is AVL-owned, centrally managed infrastructure
3. Customer Trading View is per-customer deployed — LINE secret must not be replicated to each customer deployment
4. Trading View server cannot call LINE Messaging API (it doesn't hold the secret)

**Flow:** Trading View emits notification event → Console Notification Service receives it → Console calls LINE API.

### 8-3. .env.example additions

Console `.env.example` (placeholder only, no actual values):
```
# ==================================================
# V2: LINE Notification (AVL AI Official Account)
# Server-only — NEVER expose to browser or client
# See docs/v2/LINE_NOTIFICATION_ARCHITECTURE.md
# ==================================================
# LINE_CHANNEL_ACCESS_TOKEN=
# LINE_CHANNEL_SECRET=
# LINE_LOGIN_CHANNEL_ID=        (optional: only if using LIFF/LINE Login)
# LINE_LOGIN_CHANNEL_SECRET=    (optional: only if using LIFF/LINE Login)
```

Trading View `.env.example` — no LINE variables added.

---

## 9. Security Controls

| Control | Implementation |
|---------|--------------|
| Webhook signature verification | Verify X-Line-Signature header with LINE_CHANNEL_SECRET on every inbound webhook |
| Replay protection | Include nonce/timestamp in webhook validation; reject replays |
| State token expiry | Linking state tokens expire in 15 minutes, single-use |
| LINE User ID isolation | line_user_id never returned to browser; used server-side only |
| Notification deduplication | idempotency_key prevents duplicate deliveries |
| Rate limiting | Per-user notification rate limit to prevent LINE API quota exhaustion |
| Token rotation | LINE Channel Access Token rotation procedure documented; no auto-rotation |
| Secret redaction | Delivery error logs must not include LINE token values or full payloads |
| Audit | notification_events + notification_deliveries provide full audit trail |

---

## 10. Failure Semantics

```
LINE API unavailable:
  → notification_deliveries.status = FAILED
  → retry queue for transient failures
  → permanent failure logged
  → trading runtime: UNAFFECTED
  → Risk Engine: UNAFFECTED
  → existing broker-side SL protection: UNAFFECTED

LINE linking service unavailable:
  → customer cannot initiate new link
  → existing links and notifications: continue working
  → trading: UNAFFECTED

Customer LINE account blocked/unfollowed:
  → LINE API returns error for that line_user_id
  → notification_deliveries.status = FAILED
  → trading: UNAFFECTED

Notification Event Service unavailable:
  → events may queue or be lost (depending on implementation)
  → trading operations: UNAFFECTED
  → this is acceptable: notifications are informational, not operational
```

---

## 11. Customer Data and Privacy

- `line_user_id` is PII (LINE platform identifier)
- Store in `customer_line_links` with RLS: only service_role can read, authenticated user can read own row
- Customer deletion: `customer_line_links` deleted via CASCADE from `auth.users`
- LINE does not receive Trading View user_id, email, or any account credentials
- Notification payloads sent to LINE must not include: account numbers, balance amounts, broker credentials, execution secrets

---

## 12. Implementation Notes

> These notes are for the implementation team at V2 implementation time.

1. Re-verify LINE Messaging API endpoint and authentication format against current LINE official docs.
2. LINE Push Message API (direct user push) requires Channel Access Token with sufficient quota.
3. LINE Webhook must be HTTPS with valid TLS certificate (Vercel handles this).
4. LINE LIFF apps require separate LIFF app registration in LINE Developers Console.
5. Test with LINE Official Account in development mode before production.
6. LINE API has rate limits — implement exponential backoff for retry.
7. Consider queuing (Vercel Queues or equivalent) for high-volume notification scenarios.

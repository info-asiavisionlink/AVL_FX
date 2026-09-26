# AVL-FX — Security & Failure Semantics

**Document type:** POST-V1 Target Architecture — NOT implemented  
**Status:** DESIGN PHASE  
**Created:** 2026-09-26  
**Revised:** 2026-09-26 — Updated for Customer Self-Contained Architecture  
**Parent:** [V2_ARCHITECTURE.md](./V2_ARCHITECTURE.md)

---

## 1. Core Security Invariants

These invariants apply to V2 and must not be violated:

1. **Trading safety is independent of notification infrastructure.** LINE failure, webhook failure, or notification service crash must never affect Risk Engine decisions or execution safety.

2. **Execution source authority.** Only Customer MT5 (via Bridge EA) is the authority for execution prices and account state. Central market data is for analysis only.

3. **Server-side mapping authority.** LINE User ID is not a trust credential. `customer_line_links` server-side mapping is the authority for who receives notifications.

4. **Secret isolation.** LINE Channel secrets, Supabase service role keys, gateway secrets, and knowledge API secrets are server-only. No secret reaches the browser.

5. **Customer isolation.** Customer A cannot access Customer B's positions, notifications, or line links. RLS enforced at DB level.

6. **Fail closed.** When in doubt, deny. Missing data → deny execution. Stale data → deny execution. Missing secrets → deny knowledge access.

---

## 2. Secret Classification

### 2-1. Server-Only Secrets (never in browser, never in NEXT_PUBLIC_)

| Secret | Location | Usage |
|--------|---------|-------|
| `SUPABASE_SERVICE_ROLE_KEY` | Console & TV server env | Server-side DB operations |
| `LINE_CHANNEL_ACCESS_TOKEN` | Console server env only | LINE Messaging API calls |
| `LINE_CHANNEL_SECRET` | Console server env only | Webhook signature verification |
| `LINE_LOGIN_CHANNEL_SECRET` | Console server env only | (if LIFF) OAuth verification |
| `KNOWLEDGE_API_SECRET` | Console + TV server env | Console→TV knowledge auth |
| `MT5_GATEWAY_SECRET` | TV server env | TV→Gateway auth |
| `CONSOLE_GATEWAY_SECRET` | Console server env | Console→Gateway auth |
| `RESEND_API_KEY` | Console/TV server env | Email (if used) |

### 2-2. Public-Safe Values (safe in NEXT_PUBLIC_)

| Variable | Usage |
|---------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase client initialization |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon key (RLS enforces access) |
| `NEXT_PUBLIC_MT5_GATEWAY_HTTP_URL` | Gateway connection URL |
| `NEXT_PUBLIC_MT5_GATEWAY_WS_URL` | Gateway WebSocket URL |

### 2-3. Explicitly Forbidden Patterns

```
❌  NEXT_PUBLIC_LINE_CHANNEL_ACCESS_TOKEN
❌  NEXT_PUBLIC_LINE_CHANNEL_SECRET
❌  NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
❌  LINE secrets in Trading View .env.local (any format)
❌  LINE secrets in Customer Gateway .env
❌  Any secret value in: git-tracked files, logs, HANDOFF.md, reports/
```

---

## 3. LINE Security Controls

### 3-1. Webhook Signature Verification

Every LINE Messaging API webhook must verify the `X-Line-Signature` header:

```
Expected header: X-Line-Signature: base64(HMAC-SHA256(body, LINE_CHANNEL_SECRET))

Implementation:
  1. Read raw request body (before JSON parsing)
  2. Compute HMAC-SHA256 of body using LINE_CHANNEL_SECRET
  3. Base64-encode the result
  4. Timing-safe comparison with X-Line-Signature header value
  5. If mismatch: return 400, log (no payload content in log), terminate
```

### 3-2. Replay Protection

```
Include timestamp validation in webhook processing:
  - LINE webhook events include a timestamp
  - Reject events older than 5 minutes
  - Maintain processed event ID set (or use DB idempotency key)
  - Duplicate event_id = skip (already processed)
```

### 3-3. LINE Linking State Token Security

```
Token generation:
  - Cryptographically random: 32 bytes → hex string (64 chars)
  - Single-use (deleted on successful link or expiry)
  - TTL: 15 minutes
  - Server-side storage: pending_line_links { user_id, token_hash, expires_at }
  - Store token_hash (SHA-256 of token), not raw token

Token validation:
  1. Hash inbound token
  2. Lookup by token_hash
  3. Check expires_at > now()
  4. Delete record (consumed)
  5. Create customer_line_links
```

### 3-4. LINE User ID Isolation

```
line_user_id:
  - Never sent to browser (never in API response to client)
  - Never logged (treat as PII)
  - Stored only in customer_line_links (service_role access only)
  - Trading View server can look up "does user X have active LINE link?" 
    without exposing line_user_id to the client
  - Notification Delivery Service uses line_user_id internally only
```

### 3-5. Notification Payload Security

```
LINE notification content must NOT include:
  - Account numbers or broker login credentials
  - Full account balance/equity amounts (consider relative % or category)
  - Execution secrets or gateway tokens
  - Customer email or personal identifying information
  - Internal user UUIDs

LINE notification content OK:
  - "GOLD position opened (0.1 lot)"
  - "Stop loss modified"
  - "Trade review ready"
  - Deep link URL to Trading View
```

---

## 4. Customer Isolation

### 4-1. Database-Level RLS

All V2 tables follow V1 RLS patterns:

```sql
-- Pattern: user_id = auth.uid() for direct tables
-- Pattern: parent chain for joined tables
-- Pattern: service_role bypass for server-side operations

-- customer_line_links:
CREATE POLICY "own_link_select" ON customer_line_links
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "own_link_service" ON customer_line_links
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- service_role is the only role that can read line_user_id
```

### 4-2. API-Level Customer Isolation

```
Every API endpoint that touches customer data:
  1. Verify authenticated session
  2. Extract user_id from session
  3. Filter all queries by user_id
  4. Never accept user_id from request body/query parameter as trust basis
  5. Trading View server: verify trader belongs to authenticated user
     before processing any operation on it
```

### 4-3. Notification Isolation

```
Notification Service must verify before delivery:
  customer_id matches line_user_id in customer_line_links
  customer_line_links.user_id = the notification's customer_id
  No cross-customer notification delivery
```

---

## 5. Token and Secret Management

### 5-1. LINE Channel Access Token Rotation

LINE long-lived channel access tokens can be rotated.

Procedure (manual, not automated):
1. Issue new token from LINE Developers Console
2. Update Console server env (Vercel server-only variable)
3. Re-deploy Console (new env takes effect)
4. Verify notification delivery working
5. Revoke old token in LINE Developers Console

Do not automate token rotation in V2 initial. Rotation triggers a manual deployment.

### 5-2. Production Supabase Service Role Key Hygiene

**Known finding from V1:** Supabase service-role credential was exposed in terminal/chat output during V1 development (around Stage 10-C pre-work).

Recommended action (before V2 Stage 0 implementation begins):
- Rotate Console Production Supabase service-role key
- Rotate Customer Trading View Production Supabase service-role key
- Verify .gitignore covers all .env.local files
- Audit git log for any accidentally committed secret values

Stage 10-C is now SUSPENDED. Secret rotation should happen before V2 Stage 0 implementation starts, not waiting for Stage 10-C completion.

---

## 6. Failure Semantics

### 6-1. Line of Descent: What Must Never Fail Silently

```
TRADING SAFETY INVARIANTS (fail closed, never silently pass):
  - Equity stale or unavailable → DENIED
  - Symbol specs missing → DENIED
  - Risk Engine check failure → DENIED
  - Knowledge unavailable → analysis BLOCKED (KNOWLEDGE_UNAVAILABLE)
  - Bridge EA disconnected → execution BLOCKED

NOTIFICATION INVARIANTS (fail gracefully, never block trading):
  - LINE API unavailable → delivery marked FAILED, trading unaffected
  - Notification Event Service crash → events lost or queued, trading unaffected
  - LINE linking flow unavailable → customer cannot link, existing links work
  - notification_preferences unreadable → use default deny-all (no spam)
```

### 6-2. Component Failure Matrix (POST-V1)

| Component | Trading Blocked? | Notification Blocked? | Customer Impact |
|-----------|-----------------|----------------------|----------------|
| LINE service down | NO | YES (queued/failed) | No notifications temporarily |
| ~~Central Market Data down~~ | ~~N/A (POST-V1)~~ | — | Removed from TARGET architecture |
| Customer MT5 down | YES (execution DENIED, analysis paused) | Possible (system warning) | Cannot trade, no new analysis |
| Customer Gateway down | YES (execution DENIED) | Possible (system warning) | Cannot trade |
| Customer Bridge EA down | YES (execution DENIED) | Possible (system warning) | Cannot trade |
| Console down (POST-V1 target) | NO (knowledge localized) | YES (LINE delivery down) | No notifications; trading continues |
| Console down (V1 current) | Partial (knowledge unavailable) | YES (delivery service down) | Analysis paused |
| Customer Supabase down | YES (bar data unavailable, knowledge unavailable) | Possible | Cannot analyze or trade |
| Knowledge unavailable | YES (KNOWLEDGE_UNAVAILABLE) | NO (event still fired) | Analysis blocked |
| Risk Engine internal error | YES (DENIED) | Possible (system warning) | Execution blocked |
| customer_bar_data gap | YES (if gap in analysis window) | NO | Analysis paused until backfill |

**Note:** "Console down" has two rows because:
- V1 CURRENT: Console down → knowledge unavailable → analysis blocked
- POST-V1 TARGET: Console down → zero effect on customer AI Trader runtime (knowledge localized)

### 6-3. Existing Broker-Side Protection

The following safety nets are independent of V2 features and must not be weakened:

```
Broker-side SL:
  - Physical SL order placed at broker upon position open
  - Activated at fill time by Bridge EA
  - Independent of server connection
  - Cannot be disabled by server failure
  - V2 does not change this behavior

Bridge EA hard limits:
  - Volume limits enforced in EA code
  - SL distance minimum enforced in EA code
  - EA rejects invalid commands regardless of server state
  - V2 does not weaken EA safety checks
```

---

## 7. Audit Trail

### 7-1. V1 Existing (preserved in V2)

```
trade_audit_log     — operational decisions (V1 existing)
ai_analysis_logs    — analysis journal with knowledge_snapshot (V1 existing)
execution_commands  — sole MT5 command contract (V1 existing)
ai_positions        — position lifecycle (V1 existing)
```

### 7-2. V2 New Audit Tables

```
notification_events    — all events emitted by trading runtime
notification_deliveries — all LINE delivery attempts + results
customer_line_links    — link/unlink history (status + timestamps)
```

### 7-3. Audit Queries (Examples)

```
"What notifications did customer X receive this week?"
  → SELECT * FROM notification_deliveries WHERE event_id IN (
      SELECT id FROM notification_events WHERE customer_id = X
      AND emitted_at > now() - interval '7 days'
    ) AND status = 'DELIVERED';

"What knowledge was used for this trade decision?"
  → SELECT knowledge_snapshot FROM ai_analysis_logs WHERE decision_id = {id};

"Did notification failure affect this trade?"
  → Check: notification_deliveries.status for the trade event
           Check: execution_commands.created_at vs notification delivery timing
           Verify: no causal relationship (trading doesn't wait for notifications)
```

---

## 8. V2 Pre-Implementation Security Checklist

Before V2 implementation begins:

- [ ] Rotate any Production secrets exposed during V1 development (before V2 Stage 0 — Stage 10-C is SUSPENDED)
- [ ] Verify all V2 new tables have RLS enabled from migration
- [ ] Verify LINE_CHANNEL_ACCESS_TOKEN is never added to Trading View env
- [ ] Verify Trading View .env.example contains no LINE variables
- [ ] Verify Console .env.local is in .gitignore (confirmed: yes in V1)
- [ ] Run `git grep` to check no JWT or real secrets in tracked files
- [ ] Verify webhook signature verification is mandatory (not optional)
- [ ] Verify notification delivery failure path does not propagate to Risk Engine

---

## 9. LINE Unlink and Account Deletion

### 9-1. Customer-Initiated Unlink

```
Trading View: Settings → Notifications → LINE → "LINE連携を解除"
  → customer_line_links.status = 'REVOKED'
  → customer_line_links.revoked_at = now()
  → Pending notification_deliveries: status = 'SKIPPED'
  → Future notifications: no ACTIVE link found → delivery skipped

LINE cannot trigger unlink. Only authenticated Trading View session can.
```

### 9-2. Customer Account Deletion

```
If customer deletes Trading View account:
  auth.users DELETE CASCADE → customer_line_links deleted
  All notification_events for customer_id: retained for audit (configurable retention)
  ai_positions, execution_commands: follow existing V1 deletion policy

LINE User ID: no notification sent to LINE about deletion
  (LINE platform has its own user block/unfollow mechanism)
```

### 9-3. LINE Account Block/Unfollow

```
If customer blocks AVL AI LINE account:
  LINE webhook: "unfollow" event received
  Server: customer_line_links.status = 'REVOKED'
  Future notifications: skipped
  Trading: unaffected
```

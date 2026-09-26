# Runbook — Production Supabase service_role rotation (+ CRON/WATCHER)

Date: 2026-09-27 · Author: Claude Opus 5.5 · Project: `bsmofroshpmomjwfxigh` (Production)
Status: **ROTATION_PENDING_HUMAN_ACTION**. Blocked at step 1 (key creation needs the Supabase Dashboard; the local `SUPABASE_PAT` is rejected with 401 and no Supabase CLI session exists).
No secret value appears here. Never paste a secret into a chat or terminal command line. Use an editor to write it into a git-ignored file.

## A. Authoritative consumer map (privileged Supabase key)

| Consumer | Environment | Variable | Access method | Deployment target | Restart needed | Validation |
|---|---|---|---|---|---|---|
| Trading View app | Vercel `avl-fx` **Production** (live deployment `dpl_HEr6xsJCbMXj9BcEFqxykFN4BqvQ`, CLI source, supabase-js 2.112.0) | `SUPABASE_SERVICE_ROLE_KEY` | supabase-js `createAdminClient()` (`src/infrastructure/supabase/admin.ts`) + raw REST `apikey`+`Bearer` in `cron/h1-strategy`, `traders/[id]/analyze`, `traders/[id]/walk-forward` (same pattern in HEAD and in the deployed source) | Vercel redeploy of the **same** deployment (`vercel redeploy`), no new code | yes | prod-health-check; next scheduled cron 200 in Vercel logs; trader page loads |
| Trading View app (unused) | Vercel `avl-fx` Production + Preview | `TV_SUPABASE_SERVICE_ROLE_KEY` | **not referenced** by deployed or HEAD code | — | — | remove the variable during rotation |
| Console | Vercel `avl-fx-console` Development / Preview / Production (prod deployment `avl-fx-console-39vdtdjnq…`, supabase-js 2.116.0) | `TV_SUPABASE_SERVICE_ROLE_KEY` | supabase-js `createClient` → `auth.admin.listUsers`, table reads (`customers/[id]` page, `customers/[id]/setup` route) | Vercel redeploy of its current production deployment | yes | Console login → a customer detail page shows TV user status |
| Trading Gateway | Railway `remarkable-cooperation` (production, last deploy 2026-09-25T19:44Z) | `SUPABASE_SERVICE_KEY` (**equal to the exposed value**) | supabase-js 2.109 (bar/execution/sync-job stores) + raw REST `apikey`+`Bearer` (`gateway/src/index.ts:2271`) | Railway variable update → redeploy (same image) | yes — **MT5 bridges reconnect** | `/health` 200; `mt5_connections.last_heartbeat_at` fresh for all active connections |
| Local dev / scripts | `.env.local`, `gateway/.env` | `SUPABASE_SERVICE_ROLE_KEY` | — | — | — | replace with the DEV key once a DEV project exists; until then the new Production key should **not** be placed there |

Legacy **anon** JWT: used nowhere. HEAD, the deployed Vercel source (303 files scanned), Console and the env lists all use `sb_publishable_` or the service key. So "Disable JWT-based API keys" only affects the consumers above.

## B. Key-model compatibility (measured 2026-09-27, read-only GETs)

| Request | Result |
|---|---|
| new-model key (`sb_publishable_`, proxy for `sb_secret_`): `apikey` only | 200 |
| new-model key: `apikey` + `Authorization: Bearer <same key>` | **200** (the gateway accepts a same-value Bearer) |
| legacy service JWT: `apikey` + `Bearer` (current code) | 200, privileged rows visible |
| legacy service JWT: `apikey` only | 200, **0 rows (downgraded to anon)** |

Conclusion:
- The existing raw-REST pattern (`apikey` + `Bearer` with the same key) is the one pattern that works for both models. Changing it to "apikey only" would **break** the current legacy key.
- **No application code change is required.**
- The final proof that an `sb_secret_` key yields service privileges through this pattern, supabase-js and Auth admin is step 2 below. It runs `scripts/rotation/verify-supabase-key.ts`, already validated with the legacy key: all 5 checks pass.

## C. Procedure

### 1. Owner — create the new key (Dashboard only)
1. Supabase Dashboard → project **AVL_FX** (`bsmofroshpmomjwfxigh`) → Project Settings → **API Keys**.
2. Tab "Publishable and secret API keys" → **Secret keys** → "Add new secret key" → name `avl-fx-prod-2026-09`.
3. Reveal and copy it. In an editor (not in a terminal or chat), create `…/AVL_FX　trading view/.env.rotation` containing one line:
   `CANDIDATE_SUPABASE_SECRET_KEY=<paste>`
   (`.env.*` is git-ignored; verified.)
4. Do **not** touch "Legacy API keys" yet.

### 2. Compatibility proof (read-only; Claude can run it)
`npx tsx --env-file=.env.rotation scripts/rotation/verify-supabase-key.ts CANDIDATE_SUPABASE_SECRET_KEY`
It must print `RESULT: COMPATIBLE`. If not, stop; nothing has changed yet.

### 3. CRON / WATCHER values (same window, optional but recommended)
`openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48` twice, written with an editor into `.env.rotation` as `NEXT_CRON_SECRET=` / `NEXT_WATCHER_SECRET=`.
Both sides are known in code:
- CRON: Vercel Cron and internal app calls (consumers: Vercel `avl-fx` Production + Preview); Railway holds `CRON_SECRET`.
- WATCHER: Railway Gateway → `/api/watcher/m5-close` and app `watch-traders`; Vercel Production + Preview.

The deployed Railway source is not retrievable. Updating Railway's `CRON_SECRET` at the same time covers any use there.

### 4. Update consumers (values read from the file via stdin; never on a command line, never echoed)
CLI flags verified 2026-09-27: `vercel env add --force --sensitive`, `railway variable set KEY --stdin --skip-deploys`.
```
V() { grep -E "^$1=" .env.rotation | cut -d= -f2- | tr -d '\n'; }   # prints to a pipe only
# Vercel avl-fx
V CANDIDATE_SUPABASE_SECRET_KEY | vercel env add SUPABASE_SERVICE_ROLE_KEY production --sensitive --force
vercel env rm TV_SUPABASE_SERVICE_ROLE_KEY production -y; vercel env rm TV_SUPABASE_SERVICE_ROLE_KEY preview -y   # unused by code
for E in production preview; do
  V NEXT_CRON_SECRET    | vercel env add CRON_SECRET    $E --sensitive --force
  V NEXT_WATCHER_SECRET | vercel env add WATCHER_SECRET $E --sensitive --force
done
# Vercel avl-fx-console
( cd ~/Desktop/"AVL-FX console" && for E in production preview development; do
  V() { grep -E "^$1=" "/Users/tanakayoshiki/Desktop/AVL_FX　trading view/.env.rotation" | cut -d= -f2- | tr -d '\n'; }
  V CANDIDATE_SUPABASE_SECRET_KEY | vercel env add TV_SUPABASE_SERVICE_ROLE_KEY $E --sensitive --force; done )
# Railway gateway: stage all three without deploying
V CANDIDATE_SUPABASE_SECRET_KEY | railway variable set SUPABASE_SERVICE_KEY --stdin --skip-deploys
V NEXT_CRON_SECRET              | railway variable set CRON_SECRET          --stdin --skip-deploys
V NEXT_WATCHER_SECRET           | railway variable set WATCHER_SECRET       --stdin --skip-deploys
```
The running deployments keep their old values until they are redeployed. Nothing breaks during this step.

### 5. Redeploy / restart the same code (no new code, no migrations, no EA)
1. Railway first: `railway redeploy -y`. The MT5 bridges reconnect. Watch `/health` and heartbeats.
2. Vercel TV: `vercel redeploy dpl_HEr6xsJCbMXj9BcEFqxykFN4BqvQ --target production`. Record the new deployment id.
3. Vercel Console: `vercel redeploy <current console prod deployment> --target production`.

Between steps 1 and 2 the Gateway → app watcher calls use the new WATCHER value, which the old app rejects (401, fail closed). Keep the gap to minutes. Alternatively do step 2 first; then the old Gateway's calls are rejected for the same short gap.

### 6. Health before revocation (all must pass; otherwise roll back step 4 values and redeploy)
- `npx tsx scripts/rotation/prod-health-check.ts` → ALL PASS
- `npx tsx --env-file=.env.rotation scripts/rotation/verify-supabase-key.ts CANDIDATE_SUPABASE_SECRET_KEY` → COMPATIBLE
- Vercel logs: next scheduled `/api/cron/*` returns 200; `/api/watcher/m5-close` 200 from the Gateway
- Console customer page renders TV status
- Every active `mt5_connections.last_heartbeat_at` updated after the restart
- No MT5 order, no execution command created by the check

### 7. Owner — revoke the exposed legacy key
Dashboard → Project Settings → API Keys → **Legacy API keys** → "Disable JWT-based API keys".
- This disables legacy anon + service_role together. Legacy anon is unused (section A).
- User sessions are **not** affected: they use the JWT signing key, which is not rotated.
- **Do not** use "Generate new JWT secret". It logs every user out and is not needed.

### 8. Verify again
- `npx tsx --env-file=.env.local scripts/rotation/verify-supabase-key.ts SUPABASE_SERVICE_ROLE_KEY --expect-rejected` → `OLD KEY REJECTED`
- Repeat step 6.
- Then delete `.env.rotation`. Replace the Production keys in `.env.local` / `gateway/.env` with DEV keys when the DEV project exists.

### Rollback
Until step 7, rollback = restore the previous variable values (Vercel keeps them in the old deployments; Railway variable history) and redeploy. After step 7 the legacy key cannot be re-enabled safely. Only proceed after step 6 passes.

## D. MT5_GATEWAY_SECRET — separate migration plan (not executed)

Findings (code, 2026-09-27):
- **Customer EA `AVL_FX_Bridge` (v4 distributed and v5 source) does not use it.** It authenticates with a per-connection `X-Connection-Id` / `X-Connection-Token`, verified by `verifyBridgeAuth`. Rotating the global secret does not touch customer terminals.
- Users of the global secret:
  - Gateway `auth()` (validator).
  - Vercel `avl-fx` server routes (22 files; Production, Preview, Development).
  - Console `MT5_GATEWAY_SECRET` (Development, Preview, Production).
  - The legacy `AVL_ExecutionBridge` EA input `InpGatewaySecret`, compiled 2026-09-21/22 in the Owner's own terminal. This is not a customer download.
- The Railway value (64 chars) appears 34× in AI transcripts. The local 7-char value is different and also exposed.

Zero-downtime plan:
1. Gateway code change: accept `MT5_GATEWAY_SECRET` **or** `MT5_GATEWAY_SECRET_NEXT` in `auth()` and `enforceConnectionAuth()` (constant-time compare). Log which one matched, without the value. This needs a Gateway deploy. The deployed Gateway source differs from HEAD (the V2 `/market-data/*` routes are absent in Production), so the patch must be applied to the **deployed** revision or shipped with the V2 Gateway release. It is blocked until the Owner decides which.
2. Set `MT5_GATEWAY_SECRET_NEXT` on Railway and deploy. Old callers keep working.
3. Switch the callers to the new value: Vercel `avl-fx`, Console, and the Owner's `AVL_ExecutionBridge` input (only if it is still attached; demo account). Redeploy the Vercel projects.
4. Watch the Gateway log until 0 requests match the old secret for ≥24 h.
5. Promote NEXT → `MT5_GATEWAY_SECRET`, remove NEXT and deploy. Verify the old value returns 401.

Status: MT5_GATEWAY_ROTATION = PLANNED / NOT STARTED (no zero-downtime deploy path exists today without shipping unrelated Gateway code).

## E. Cutover log — 2026-09-27 (Owner Decision A approved; CRON/WATCHER unchanged)

The new `sb_secret_` key was read from `.env.local` `CANDIDATE_SUPABASE_SECRET_KEY` and piped via stdin. It was never printed. Its compatibility was proven first: 5/5 access patterns passed.

| Phase | Change | Deployment | Verification |
|---|---|---|---|
| 1 Railway | `SUPABASE_SERVICE_KEY` (production, `remarkable-cooperation`) → new key; the other variables are untouched. Value equality was confirmed in-process. | redeploy `fdc53900-…` (same source; previous `c2ecae2a-…`) SUCCESS 2026-09-26T17:11:53Z | `/health` ok (uptime reset, eaConnected). Logs: `executionStore Supabase接続 OK`, bar_data restore 20/50/100 rows, 0 auth errors. MT5 connection `a7bb2d9b` heartbeat refreshed after the restart (written by the Gateway via Supabase). `[M5Restore] Node 20 WebSocket` message is pre-existing (present in `c2ecae2a`). |
| 2 Vercel `avl-fx` | Production `SUPABASE_SERVICE_ROLE_KEY` → new key (updatedAt 17:14:03Z). The unused `TV_SUPABASE_SERVICE_ROLE_KEY` was left as is (not in scope). | `vercel redeploy dpl_HEr6xs…` → **`dpl_8To1goeSZsYTYCo9oS7b3L1iXBbu`**, aliased `avl-fx.vercel.app` | health 7/7. Real customer `GET /api/traders` 200 (auth user, then `createAdminClient()` reads `ai_traders`). Gateway → `/api/watcher/m5-close` 200. 0 Supabase/auth error logs. |
| 3 Vercel `avl-fx-console` | `TV_SUPABASE_SERVICE_ROLE_KEY` → new key in Production/Preview (sensitive) and Development (encrypted), same entries (3), no new variables. The Development value was verified equal. | `vercel redeploy dpl_7ZcwF2eY…` → **`dpl_DmTVKboeJ9tkzdsp7Sb5mVvw8GYw`**, aliased `avl-fx-console.vercel.app` | `/login` 200, 0 error logs. The TV-Supabase paths (customer page, setup) require an admin session, so runtime use is verified by the key probe (Auth admin + table reads) plus config. **An Owner click-through is recommended before disabling legacy.** |

- The legacy service_role JWT is **still active** (not disabled; Owner action).
- No MT5 order or execution test; `execution_commands` created in the window: 0. No DB writes by the operator. CRON/WATCHER/MT5/OpenAI/other credentials unchanged. No migration, no EA change, no push.

Rollback (until legacy is disabled):
- Railway: set `SUPABASE_SERVICE_KEY` back from `.env.local` `SUPABASE_SERVICE_ROLE_KEY` via stdin, then redeploy.
- Vercel: promote `dpl_HEr6xs…` (TV) / `dpl_7ZcwF2eY…` (Console); they carry the old env.

## F. Closure — 2026-09-27

- **Transient P0 (resolved):** The first "Disable JWT-based API keys" was applied to **AVL_FX console** (`ghufhqodgrkftmhjozhj`) instead of Trading View. The Console's own Vercel app and Railway Gateway use legacy service_role JWTs for that project, so they got 401 (seen at 17:24–17:26Z). The Owner re-enabled Console legacy keys; the Console Railway key returned 200 again at 17:27:52Z. No Console error logs were found afterwards.
- The Owner then disabled legacy keys on **AVL_FX trading view** (`bsmofroshpmomjwfxigh`): the Management API reports `enabled: false`. The exposed old key was rejected (401) from 17:28:06Z on REST, apikey-only and Auth admin.
- The new `sb_secret_` key passes 5/5 access patterns.
- Health check 7/7. Gateway ok (eaConnected), MT5 `a7bb2d9b` heartbeat 0 s. TV / Console / Gateway: 0 Supabase-auth errors. Console customer pages 200.
- `execution_commands` and `ai_positions` changed in the last 30 min: 0 / 0.
- **SERVICE_ROLE_ROTATION = COMPLETE · SERVICE_ROLE_EXPOSURE = REMEDIATED · P1_SERVICE_ROLE = CLOSED.**
- Follow-ups:
  - Local `.env.local` / `gateway/.env` still hold the now-dead legacy key.
  - The Console project still runs on legacy JWT keys (its own rotation is separate).
  - A valid account PAT is stored in `gateway/.env` and `gateway/.env 2.example` (git-ignored).

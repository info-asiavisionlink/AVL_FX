# AVL-FX Secret Rotation Inventory

Date: 2026-09-27 · Author: Claude Opus 5.5 · **No secret value appears in this document.**
Status: **CREDENTIAL_ROTATION = ROTATION_PENDING_HUMAN_ACTION**. Nothing was rotated or revoked.

## How exposure was measured

For each value in the local `.env.local`, the value itself was searched for inside `~/.claude/projects/*AVL-FX*` (Claude Code session transcripts). Only counts were recorded. The Railway production values were read with `railway variables --json` and compared in-process (equal / not equal).

Vercel stores these variables as *Sensitive*, and `vercel env pull` returns a mask for them, so the Vercel production values could not be compared. They are therefore **UNKNOWN**.

## Why nothing was rotated automatically

Every secret in scope has a production consumer that only picks up a new value after a **Vercel redeploy** or a **Railway restart/redeploy**. This task forbids deploying. Several secrets also need dashboard-only actions (Supabase keys, OpenAI, Google), or reach customer MT5 terminals (`MT5_GATEWAY_SECRET`). The execution policy says to stop in exactly these cases. The safe order below is always:

> NEW secret → update all consumers → redeploy/restart → health check → revoke OLD

## Inventory

| # | Secret | System | Consumers found | Exposure | Rotation method | Expected downtime | Validation | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | **Supabase service_role key** (legacy JWT, issued 2026-08-03, exp 2036) | Supabase `bsmofroshpmomjwfxigh` | Vercel `avl-fx` Production: `SUPABASE_SERVICE_ROLE_KEY`, `TV_SUPABASE_SERVICE_ROLE_KEY` (+Preview). Vercel `avl-fx-console` Dev/Preview/Prod: `TV_SUPABASE_SERVICE_ROLE_KEY`. Railway `remarkable-cooperation`: `SUPABASE_SERVICE_KEY` (**= exposed value**). Local `.env.local`, `gateway/.env`. Code: 51 files (routes, Gateway stores, 4 raw REST calls that send the key as `Authorization: Bearer`). | **248 hits / 12 transcripts** | Dashboard → API Keys: create a **new secret key** (`sb_secret_…`); update every consumer; redeploy; verify; then **disable legacy JWT keys**. Do NOT use "rotate JWT secret" — it invalidates anon + service_role everywhere at once and logs out users. | 0 if done in order; outage if legacy is disabled first | `/health` on Gateway, H1/M5 cron 200, login, a read on each consumer | PENDING_HUMAN — **P1, highest priority**. Prerequisite: the 4 raw REST call sites (`gateway/src/index.ts:2271`, `src/app/api/cron/h1-strategy/route.ts:125`, `traders/[id]/analyze:50`, `traders/[id]/walk-forward:102`) must be verified with an `sb_secret_` key (send `apikey` only) before cut-over. |
| 2 | `SUPABASE_PAT` (Management API token) | Supabase account | Local `.env.local` only | 107 hits / 11 transcripts | Already **rejected (HTTP 401)** by the API on 2026-09-27 — revoked or expired | none | Owner confirms it is deleted in Dashboard → Account → Access Tokens; remove the line from `.env.local` | EFFECTIVELY_REVOKED — Owner to confirm |
| 3 | `OPENAI_API_KEY` | OpenAI | Vercel `avl-fx` Production; local | 23 hits / 8 transcripts (local value); Vercel value UNKNOWN | platform.openai.com: new project key → Vercel env → redeploy → verify → revoke old | 0 | One AI analysis request (Stage 7 AI path) | PENDING_HUMAN |
| 4 | `CRON_SECRET` | App ↔ Vercel Cron ↔ Gateway | Vercel `avl-fx` Production + Preview (Vercel Cron sends it); Railway (**= exposed value**); local | 46 hits / 4 transcripts | Generate new value; set it in Vercel and Railway in the same window; redeploy both | Cron calls between update and redeploy return 401 (fail closed, ≤1 cron cycle) | `/api/cron/*` 200 in Vercel logs | PENDING_HUMAN |
| 5 | `WATCHER_SECRET` | Gateway → `/api/watcher/m5-close` | Vercel Production + Preview; Railway (**= exposed value**); local | 50 hits / 5 transcripts | Same as CRON_SECRET (same window) | M5 watcher 401 for ≤1 cycle | m5-close 200 | PENDING_HUMAN |
| 6 | `MT5_GATEWAY_SECRET` | Gateway auth, **EA input `InpGatewaySecret`** on customer MT5 | Railway (64 chars; **34 transcript hits**); Vercel Prod/Preview/Dev; `avl-fx-console` Vercel; EA inputs on every connected terminal; local value differs (7 chars, also exposed) | 34 / 39 hits | Needs a **dual-secret window**: the Gateway must accept old+new first (code change + deploy), then update the Vercel/Console env and every EA input, then remove the old. | **MT5 disconnect** for any terminal not updated | Heartbeats from all connections | PENDING_HUMAN — MT5 impact, Owner + customer coordination |
| 7 | `EA_REGISTRY_SECRET` | TV → Console strategy registration | Vercel `avl-fx` Production; Console side (verifier); local | 26 hits / 6 transcripts | Set the new value in the Console verifier and TV together; redeploy both | Share-code registration fails during the window | Create a strategy → Console registration 200 | PENDING_HUMAN |
| 8 | `GOOGLE_CLIENT_SECRET` | Google OAuth (Supabase Auth provider) | Local; Supabase Auth provider settings (not readable here) | 24 hits / 8 transcripts | Google Cloud Console: new client secret → Supabase Auth → Google provider → delete the old | Google sign-in fails if the order is wrong | Google login | PENDING_HUMAN |
| 9 | `RESEND_API_KEY` | Resend (contact form) | Vercel Production; local | 26 hits / 8 transcripts | Resend dashboard: new key → Vercel → redeploy → revoke | none | Contact form test | PENDING_HUMAN (low) |
| 10 | `TWELVE_DATA_API_KEY` | Twelve Data | Vercel Production; local | 24 hits / 8 transcripts | Provider dashboard | none | `/api/market/external` | PENDING_HUMAN (low) |
| 11 | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase (public by design) | Browser bundle | public | No rotation needed (publishable) | — | — | NOT_SECRET |
| 12 | `VERCEL_OIDC_TOKEN` | Vercel (local pull token) | `.env.local` | 25 hits | Short-lived (~12 h); already expired | — | — | EXPIRED |
| 13 | `STRIPE_*` | Stripe | `.env.local` holds the `.env.example` **placeholders** | — | none | — | — | NOT_REAL |
| 14 | `KNOWLEDGE_API_SECRET`, `CONSOLE_SYSTEM_TOKEN`, `CONSOLE_GATEWAY_SECRET` | Console ↔ TV | Vercel `avl-fx` (Sensitive), Railway (`CONSOLE_SYSTEM_TOKEN`, 0 transcript hits) | not found in transcripts (Vercel values unreadable) | Rotate with the Console project if Owner wants defence in depth | — | — | NOT_EXPOSED_EVIDENCE |

The Console repository's `.env.local` (ref `ghufhqodgrkftmhjozhj`) was not in scope. Its transcripts were included in the counts above, but its secrets need their own inventory.

## Recommended Owner sequence (one maintenance window, demo-only terminals first)

1. Supabase: create a new `sb_secret_` key (do not touch legacy yet). Test the 4 raw REST call sites against it on a Preview deployment.
2. Update `SUPABASE_SERVICE_ROLE_KEY` and `TV_SUPABASE_SERVICE_ROLE_KEY` (avl-fx Prod + Preview), `TV_SUPABASE_SERVICE_ROLE_KEY` (avl-fx-console Dev/Preview/Prod), Railway `SUPABASE_SERVICE_KEY`, and local files. Generate new `CRON_SECRET` / `WATCHER_SECRET` and set them in Vercel + Railway at the same time.
3. Redeploy Railway, then Vercel (`avl-fx`, `avl-fx-console`). Check health, cron and watcher.
4. Disable the legacy JWT service_role key in Supabase (keep the publishable key).
5. OpenAI, Resend, Twelve Data, Google: new key → Vercel/Supabase → redeploy → revoke the old.
6. `MT5_GATEWAY_SECRET`: separate change with a dual-secret Gateway release and per-terminal EA update.
7. Remove `SUPABASE_PAT` from `.env.local`. Stop pasting or printing env files into AI sessions. Consider deleting old transcripts under `~/.claude/projects/*AVL-FX*` after rotation.

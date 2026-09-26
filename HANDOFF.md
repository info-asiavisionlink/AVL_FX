# AVL-FX V2 — Handoff Document

**Stage:** V2-Stage-5 — Customer AI Trader Profile / Configuration
**Status:** COMPLETE / FROZEN (self-review PASS, P0=0, P1=0) — awaiting Owner confirmation before Stage 6
**Reviewer:** Claude Opus 5.5 (recovery re-audit after an interrupted session)
**Updated:** 2026-09-27

---

## Commits

| Role | SHA |
|------|-----|
| Implementation baseline | `8b24d6a` |
| Final reviewed code | `09a974f` |
| Report / STATE / HANDOFF | commit following `09a974f` (docs only) |

Report: `reports/builder/V2-Stage-5-self-review-2026-09-26.json`

## What Stage 5 delivers

- Customer Trading View owns AI Trader creation/configuration (`POST /api/traders`, `AITraderBuilder.tsx`, `import-by-id`).
- Customer Supabase is the only config source: `ai_traders` → active `ai_trader_versions` (incl. risk limits) → `ai_trader_timeframe_profiles`.
- `loadCustomerAITraderConfig()` is the canonical runtime loader, strictly fail-closed
  (`NOT_FOUND`, `OWNER_MISMATCH`, `NO_ACTIVE_VERSION`, `NO_TIMEFRAME_PROFILE`, `INVALID_PROFILE`, `SERVER_ERROR`, `CONFIG_ERROR`).
- H1 strategy, M5 entry recheck and position review read config / knowledge only from Customer Supabase. No Console runtime dependency.

## Recovery audit (this session)

The previous session stopped mid self-review. The stash it created had already been popped (nothing lost).
Its draft report claimed PASS, but the re-audit found and fixed 6 P1 defects in `09a974f`:
missing risk columns selected by the loader, silent unsafe defaults, H1 prompt ignoring trader config,
Builder UI 422 on every save (`knowledge_ids`), a Stage 4 smoke regression masked by a 401, and a
Console Knowledge runtime call in position review. Details are in the report.

## Human Gate (REQUIRED — not bypassed)

Migration `038_customer_ai_trader_profile.sql`: **IMPLEMENTED / VERIFIED LOCALLY / NOT APPLIED TO PRODUCTION**.

1. Apply 035–038 to Production Customer Supabase (Owner action).
2. Only then deploy the Stage 5 application code. Deploying code first makes every trader fail closed with `config_error` (safe, but analysis stops).
3. Update `STATE.json` `production_state.db_migration_applied`.

## Blocker to resolve before any git-based deploy (pre-existing, not Stage 5)

A clean checkout does not build: `tsconfig.json`, `next.config.ts` and ~71 `src/` files
(`runtime-service.ts`, `risk-engine.ts`, `execution-service.ts`, …) are untracked, alongside
Finder-style `* 2.ts` duplicates. Same at `847d8ed` (before Stage 5). Owner decision needed on
which files to commit and which duplicates to delete.

## How to run the tests

```
npx tsc --noEmit
npx tsx --test src/lib/ai-trader/__tests__/*.test.ts src/lib/knowledge/__tests__/*.test.ts \
  src/infrastructure/trading/__tests__/*.test.ts src/infrastructure/supabase/__tests__/*.test.ts src/lib/__tests__/*.test.ts
(cd gateway && npm test)
npm run build
```

The Stage 4 smoke test needs the local Postgres on `127.0.0.1:55435`.

## Next action

Owner reviews the Stage 5 final report → Human Gate for migrations → decide on the untracked-files blocker → start Stage 6.
Codex audit: DEFERRED / OPTIONAL. A future Codex P0/P1 reopens Stage 5.

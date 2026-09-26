# AVL-FX Development Environment Separation Plan

Date: 2026-09-27 · Author: Claude Opus 5.5 · Status: PLAN (no project was created)

## Problem

`.env.local` was produced by `vercel env pull`, which pulls the Vercel **Development** environment. It points at the **Production** Supabase `bsmofroshpmomjwfxigh` and the production Railway Gateway, while `NODE_ENV=development`. Consequences:

- Every local run, script and test that reads `.env.local` acts on Production. This caused the 2026-09-27 incident.
- Safety checks keyed on `NODE_ENV` (e.g. `dev-create-test-command.ts`) never fire.
- Production credentials sit on developer disks and flow into tool/AI transcripts.

## Target

```
LOCAL DEV / scripts / integration tests ─▶ AVL-FX DEV Supabase (new ref)   ─▶ local or DEV Gateway
Vercel Preview                          ─▶ AVL-FX DEV Supabase (or a PREVIEW project)
Vercel Production / Railway production  ─▶ AVL-FX PRODUCTION Supabase bsmofroshpmomjwfxigh
Unit tests (npm test)                   ─▶ no network (mocks, local throwaway Postgres only)
```

## Environment matrix

| Context | Env source | Supabase | Gateway | Service-role present? |
|---|---|---|---|---|
| Local app (`next dev`) | `.env.local` (DEV values only) | DEV ref | local `gateway` or DEV Railway service | DEV key only |
| Unit / regression tests | none (tests set fake values; network blocked) | none / `127.0.0.1:55435` throwaway | fake `.test` hosts | no |
| `.env.test` (new, committed template-free) | fake values | none | none | no |
| Live integration tests | explicit `--env-file=.env.dev` + `AVL_ALLOW_LIVE_DB_INTEGRATION=1` | DEV ref only | — | DEV key |
| Ops scripts (`scripts/*`) | explicit `--env-file` + `AVL_ALLOW_LIVE_SCRIPT=1`; Production additionally `AVL_ACK_PRODUCTION_MUTATION=<ref>` | DEV by default | — | per target |
| Vercel Development env (what `vercel env pull` fetches) | Vercel | **DEV ref** (today: Production — must change) | DEV | DEV key |
| Vercel Preview | Vercel | DEV/PREVIEW ref | DEV | DEV key |
| Vercel Production | Vercel | PROD `bsmofroshpmomjwfxigh` | Railway production | PROD key |
| Railway production | Railway | PROD | — | PROD key |

`.env.example` keeps placeholders only and documents that `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` must be the DEV project.

## Guards (defence in depth)

1. **Already implemented (code, repository-local):**
   - `src/lib/safety/live-target-guard.ts` with `PRODUCTION_SUPABASE_REFS`. Scripts need `AVL_ALLOW_LIVE_SCRIPT=1`; live integration tests need `AVL_ALLOW_LIVE_DB_INTEGRATION=1`. A Production (or undeterminable) target also needs `AVL_ACK_PRODUCTION_MUTATION=<ref>`.
   - Test helpers overwrite secrets with fake values.
2. **Proposed next, after the DEV project exists** (not implemented now — it would stop local development today, because the only project is Production):
   - Dev-runtime guard in `createAdminClient()`: if `process.env.VERCEL_ENV` is unset (local) or `development`, **and** the Supabase ref is in `PRODUCTION_SUPABASE_REFS`, throw unless `AVL_ACK_PRODUCTION_MUTATION` matches. The deployed Production runtime (`VERCEL_ENV=production`) and Railway are unaffected.
   - The same check in `gateway/src` when `RAILWAY_ENVIRONMENT_NAME` is not `production`.
   - A CI check that `.env.example` and the repository contain no production ref outside `live-target-guard.ts`, docs and reports.

## Migration steps (Owner)

1. Create Supabase project `AVL-FX-DEV` (same region). Apply migrations 001–038 to it. This is also the rehearsal for the Production 035–038 Human Gate.
2. Seed with synthetic data only (no customer copies).
3. Vercel `avl-fx`: set the **Development** and **Preview** environment variables to the DEV project and a DEV Gateway. Keep Production unchanged.
4. Optionally create a Railway `development` environment for the Gateway pointing at DEV.
5. Re-run `vercel env pull` → `.env.local` now targets DEV. Delete the old `.env.local` and `gateway/.env` copies that hold Production keys.
6. Enable the dev-runtime guard (step 2 above) and add the DEV ref to documentation.
7. After Production secret rotation, never place Production secrets on developer machines. Use `vercel env` / Railway for Production changes only.

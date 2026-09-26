# AVL-FX Git Reproducibility — Final Report

Date: 2026-09-27 · Builder + Reviewer: Claude Opus 5.5 · Codex: DEFERRED / OPTIONAL_AUDIT

| | SHA |
|---|---|
| Initial HEAD / recovery base | `2520b68` |
| Recovery commit | `9bfcc21` chore(repo): restore reproducible AVL-FX source tree |
| Test-safety commit | `eae59d8` test(backtest): require explicit opt-in before the live-Supabase integration test |
| Clean-checkout proof run on | `eae59d8` |

## Status

**IN_PROGRESS — technically reproducible, blocked on one P1 incident for Owner review.**
Every repository criterion passes, but the pass condition "Production was not modified" cannot be confirmed: see *Incident*.

## Clean checkout proof (`git worktree add --detach … eae59d8`)

No file copied in, no `node_modules`/`.next`/`dist` reused (deleted before install), env emptied (`env -i PATH HOME`), no `.env.local`.

| Step | Result |
|---|---|
| `npm ci` (root) | PASS (633 packages; EBADENGINE warnings for Node 20) |
| `npm run typecheck` | PASS |
| `npm run build` | PASS (63/63 pages) |
| gateway `npm ci` / `npm run build` / `npm test` | PASS / PASS / 111/111 |
| All 51 `src/**/*.test.ts` files | 235 pass, 0 fail (backtest `integration.test.ts` = SKIP, counted by node:test as 1 pass) |
| Stage-related suite (same 23 files as Stage 5) | 207/207 |
| Stage 5 loader | 68/68 · Customer Knowledge 14/14 · Stage 4 smoke 6/6 |

ENV_DEPENDENT_TEST: Stage 4 smoke #1/#3 need the local throwaway Postgres on `127.0.0.1:55435`; backtest `integration.test.ts` needs `AVL_ALLOW_LIVE_DB_INTEGRATION=1` and a non-production Supabase.

## Incident (P1, open — Owner Human Gate)

While comparing a clean-checkout failure, `src/infrastructure/backtest/__tests__/integration.test.ts` was run once in the original directory **without first reading it**. It loads `.env.local` and runs a real backtest with the service-role key against that Supabase project (the one the app's `.env.local` uses; **proven Production** in `reports/security/AVL-FX-supabase-test-write-incident-2026-09-27.md`).

Rows written at 2026-09-26T15:27:46–48Z (= 2026-09-27 00:27 JST), identified by read-only queries:

- `backtest_jobs` 1 row: `e007b9f3-67ff-4d96-aa0f-3ae3d4e759a2` (COMPLETED)
- `backtest_results` 1 row, `backtest_trades` 51 rows (`job_id` = above)
- `strategy_registry` `4582c579-8990-4790-a000-e33b2f68acbb` ("GOLD Day H4 MACD RSI30 LDN-NY"): `backtest_status` set to PASSED (previous job 2026-09-19 was also PASSED, so the value is most likely unchanged), `updated_at` changed.

Nothing was deleted or reverted. No MT5, order or real-money path was involved.
Prevention: `eae59d8` makes the test skip unless explicitly enabled.
Owner decisions: (1) confirm whether this project is Production; (2) whether to delete the 53 test rows for that job.

## Root causes

1. Monorepo → flat restructure (Console split to its own repo, `apps/trading-view` → root) done on disk, never committed.
2. Root configs (`tsconfig.json`, `next.config.ts`, eslint, postcss, `components.json`, `public/*`) were only in git under `apps/trading-view/`.
3. V1 Stage 1–7 runtime and test files created after the flatten were never added (12 missing modules on clean checkout).
4. The 33 modified files were the working code of Stages 1–5, never committed.
5. `~/Desktop` is iCloud-synced (`FXICloudDriveDesktop=1`) → `* 2.*` conflict copies (untracked and 4 tracked), also inside `.next/`.
6. The uncommitted `.gitignore` rewrite had dropped the `.env.*`/`*.pem` protections and introduced an unanchored `build/` that ignored `src/app/api/**/build/` source routes.

## Secret audit

- Staged/added/modified files: no findings (JWT, OpenAI/Stripe/GitHub/Slack keys, private keys, DB URLs with passwords, `sb_secret_`, `*_SECRET/_KEY/_TOKEN=` values). `.env.example` files contain placeholders only.
- Tracked tree at `eae59d8`: no findings. No `.env*` other than the two templates, no `node_modules`/`.next`/`dist`.
- History: two pattern hits, both false positives (zod test-fixture JWT in `apps/console/node_modules`, supabase-js `startsWith("sb_secret_")` literal in `.next` chunks) — no real credential in git history.
- Local ignored files hold live credentials: `.env.local` (service_role JWT, OpenAI key) and `gateway/.env` (service_role JWT of the **same** Production project — corrected 2026-09-27; the earlier "second project" came from mixing in the Console repo's env). Correctly ignored.
- **SECURITY FOLLOW-UP REQUIRED — ROTATE CREDENTIAL**: a Supabase service-role JWT was previously exposed in development output; which project it belonged to is not known here. Rotate under Owner Human Gate. Nothing was rotated.

## Remaining in the original working directory

| Paths | Count | Why | Blocks deploy? |
|---|---|---|---|
| `AVLFXドキュメント/**`, `AVL-FX document/…` deleted | 52 | Deleted locally only, intent unknown; kept in git | No — Owner decides (restore locally or commit deletion) |
| `* 2.*` iCloud copies | 79 untracked | Sync-conflict copies; not ignored on purpose | No — delete after moving the repo out of iCloud |
| Ignored local files | — | `.env.local`, `gateway/.env`, `node_modules`, `.next`, `.next-stale-8c/`, `gateway/data/`, `ea/*.ex5` | No |

32 iCloud copies inside `.next/` (generated cache) were deleted because they broke local `tsc`.

## Deployability (nothing deployed)

| Target | Source complete in git? | Notes |
|---|---|---|
| GitHub checkout / new machine | YES | Proven by clean worktree. Local `main` is ahead of `origin/main` (`f530d5e`); nothing pushed. |
| Vercel | YES (source) | Must build from repo root. Local `.vercel/project.json` has no root-directory setting; confirm the Vercel project is not still set to `apps/trading-view`. |
| Railway Gateway | YES | `gateway/Dockerfile` + lockfile + src in git; the stale `index 2.ts` no longer compiles into `dist`. Docker not available locally, so the image build itself was not run. |
| Supabase migrations | YES | `001…038` in git (40 files; `014`, `015` numbers duplicated since 2026-08 — pre-existing). |

## Findings

- P0: 0
- P1: 1 open — the live-DB test-write incident above (repository cause fixed in `eae59d8`; data/production confirmation pending Owner).
- P2: repo inside iCloud Desktop (ongoing duplicate generation); customer download `public/ea/AVL_FX_Bridge.ex5` is the 2026-09-11 build while `ea/AVL_FX_Bridge.mq5` changed 2026-09-26 (possible stale EA binary); service-role rotation follow-up; Vercel root-directory confirmation.
- P3: duplicate migration numbers 014/015; gateway Dockerfile uses `npm install` not `npm ci`; Node 20 is deprecated by supabase-js (EBADENGINE warnings); 3 historical `reports/orchestrator/review-error-*.json` remain tracked while new ones are ignored.

## Human Gate / Production

- Production changes by this task: none intended; see the incident for the unconfirmed data write.
- Migrations 035–038: NOT APPLIED TO PRODUCTION.
- Stage 6: NOT STARTED.

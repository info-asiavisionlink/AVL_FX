# AVL-FX Git Reproducibility — Preflight Forensic Snapshot

Date: 2026-09-27 · Auditor: Claude Opus 5.5 · Mode: READ-ONLY (written before any repository change)

## Repository

| Item | Value |
|---|---|
| Root | `/Users/tanakayoshiki/Desktop/AVL_FX　trading view` |
| Branch | `main` |
| HEAD | `2520b68bacf28c28d7d390ab9800c74b6beb3262` (Stage 5 final) |
| origin/main | `f530d5e` (local main is ahead; nothing pushed by this task) |
| Remote | `git@github.com:info-asiavisionlink/AVL_FX.git` |
| Stash | empty |
| Index (staged) | empty |
| Tracked files | 1520 |
| `git status --short` lines | 1264 |

## Dirty-tree counts

| Kind | Count |
|---|---|
| Modified (` M`) | 33 |
| Deleted (` D`) | 1096 |
| Added / Renamed (staged) | 0 / 0 |
| Untracked (`??`, collapsed dirs) | 135 → 207 individual files |
| Ignored (`!!`, collapsed) | 19 |

## Ignore rules

- `.git/info/exclude`: no active rules. Nested `.gitignore`: `apps/console/.gitignore` (tracked, deleted locally).
- **Committed** `.gitignore` ignores `.env*` (catch-all), `*.pem`, the local "OPEN AI API*" secret folders and all of `gateway/data/`.
- **Working-tree** `.gitignore` (uncommitted) drops `.env*`, `*.pem` and the secret-folder rules, and narrows `gateway/data/` to `bars.json`. Committing it as-is would **weaken secret protection** (e.g. `.env.production` would no longer be ignored).
- Ignored now (correctly): `.env.local`, `gateway/.env`, `node_modules/`, `.next/`, `gateway/dist/`, `gateway/data/`, `.vercel/`, `ea/*.ex5`, `*.tsbuildinfo`, `next-env.d.ts`, `.DS_Store`.

## Root causes (established in the read-only audit)

1. **Uncommitted monorepo → flat restructure.** The repo was a monorepo (`apps/console`, `apps/trading-view`, `services/gateway`). The Console was split into its own repo and Trading View was flattened to the root, but the removals/moves were never committed.
   - `apps/console/**` 617 deleted (596 of them are `node_modules` wrongly committed in `6805e63`; 21 Console files now live in the separate Console repo).
   - `apps/trading-view/**` 311 deleted: 195 identical at root, 55 differ (root is newer: root `src` edited through 2026-09-27, `apps/trading-view` last touched 2026-09-11), 61 absent at root (retired Stripe/pricing/AI-brain/3D UI; unreferenced — root builds without them).
   - `services/gateway/**` 110 deleted: superseded by tracked `gateway/` (100 are `node_modules`, 2 `dist`).
2. **Root config never added.** `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json`, `public/*` existed in git only under `apps/trading-view/` → untracked at root. A clean checkout of HEAD has no `tsconfig.json`/`next.config.ts`.
3. **V1 Stage 1–7 runtime files never added.** `src/lib/ai-trader/{runtime-service,risk-engine,execution-service,core-runtime,…}.ts`, several API routes and ~20 test files were created after the flatten and never staged, while tracked routes import them (12 "Cannot find module" errors on clean checkout).
4. **33 modified files** are V1/V2 work on the canonical root tree (execution pipeline, decide/manage-positions, watcher, UI, EA, lockfile, vercel cron offset) — the code that Stage 1–5 tests ran against, never committed.
5. **iCloud Desktop sync duplicates.** `~/Desktop` is iCloud-synced (`FXICloudDriveDesktop=1`). 91 untracked `* 2.*` files (83 identical to the original, 8 older snapshots) plus 4 tracked stale duplicates (`.gitignore 2`, `package-lock 2.json`, `gateway/package-lock 2.json`, `gateway/src/index 2.ts` from 2026-08-23) are sync-conflict copies.
6. Other deletions: `AVLFXドキュメント/**` (51) and `AVL-FX document/` (1) — docs deleted locally, not found anywhere on disk, intent unknown; `mt5/data-manager/*` + `ea/AVL_DataManager_v2.mq5` — Data Manager EA moved to Console (intentional); `.claude/.claire` worktree entries — agent artifacts (intentional).

## Initial risk assessment

| Risk | Level |
|---|---|
| Clean checkout cannot build (HEAD not reproducible) | **P1** — blocks any git-based deploy |
| Working-tree `.gitignore` weakens secret ignores if committed blindly | **P1 if committed as-is** |
| `git add -A` would commit 91 duplicate files and a stale `.next-stale-8c/` cache | P2 |
| Secrets: none in candidate files or tracked tree; history hits are false positives (zod test fixture JWT, supabase-js `sb_secret_` string literal) | none found |
| Repo lives in an iCloud-synced folder (duplicates, possible eviction/conflicts inside `.git`) | P2 (Owner action) |
| Local `main` ahead of `origin/main` (`f530d5e`) — Vercel/GitHub do not see Stage 1–5 | informational |

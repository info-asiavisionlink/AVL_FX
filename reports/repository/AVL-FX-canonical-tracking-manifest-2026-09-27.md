# AVL-FX Trading View — Canonical Tracking Manifest

Date: 2026-09-27 · Author: Claude Opus 5.5 · Companion: `AVL-FX-git-reproducibility-preflight-2026-09-27.md`, `AVL-FX-deletion-manifest-2026-09-27.tsv` (one row per deleted path)

Repository scope after the Console split: **Trading View only**, flat layout (root = Next.js app, `gateway/` = Trading Gateway, `ea/` = customer EAs). The Console lives in its own repository.

## MUST be tracked

| Area | Paths | Class |
|---|---|---|
| App source | `src/**` (excluding `* 2.*` sync copies) | A REQUIRED_SOURCE |
| Gateway source | `gateway/src/**`, `gateway/package.json`, `gateway/package-lock.json`, `gateway/tsconfig.json`, `gateway/Dockerfile`, `gateway/.dockerignore` | A / B |
| EA source | `ea/*.mq5` | A |
| Customer EA download | `public/ea/AVL_FX_Bridge.ex5` (served via `/ea/`, allowed in `src/middleware.ts`; previously tracked as `apps/trading-view/public/ea/…`) | A (runtime asset) |
| Public assets | `public/*.svg` | A |
| Root config | `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json`, `vercel.json`, `.gitignore` | B REQUIRED_CONFIG |
| Env templates | `.env.example`, `gateway/.env.example` (placeholders only — verified) | B |
| Migrations | `supabase/migrations/001…038` | C REQUIRED_MIGRATION |
| Tests | `src/**/__tests__/**`, `gateway/src/*.test.ts` | D REQUIRED_TEST |
| Orchestrator | `scripts/**`, `STATE.json`, `HANDOFF.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` | A / E |
| Docs | `docs/*.md`, `docs/v2/*.md` | E REQUIRED_DOCUMENTATION |
| Reports | `reports/builder/**`, `reports/codex/*.json`, `reports/repository/**` | E |

## MUST NOT be tracked

| Class | Paths | Rule |
|---|---|---|
| I SECRET_OR_ENV | `.env`, `.env.*` (anywhere) except the two templates; `*.pem`, `*.key`, `*.p12`, `*.pfx`; local "OPEN AI API*" folders | `.gitignore` catch-all + explicit `!/.env.example`, `!/gateway/.env.example` |
| G DEPENDENCY | `node_modules/` (any depth) | ignored |
| F GENERATED | `.next/`, `.next-stale-*/`, `/out/`, `/build/` (root only), `gateway/dist/`, `*.tsbuildinfo`, `next-env.d.ts`, `ea/*.ex5`, `mt5/**/*.ex5` | ignored |
| H CACHE | `/coverage/`, `.vercel` | ignored |
| J LOCAL_RUNTIME_DATA | `gateway/data/` (15 MB `bars.json`), `reports/orchestrator/review-error-*.json`, `*.log` | ignored |
| K IDE/OS | `.DS_Store`, `.claude/settings.local.json`, `.claude/worktrees/`, `.claire/` | ignored |
| K sync duplicates | `* 2.*`, `* 2/` (iCloud Desktop conflict copies) | not ignored on purpose (a broad pattern could hide real files) — Owner deletes them after moving the repo out of iCloud |

## `.gitignore` changes (vs committed HEAD)

- Adopted the working-tree layout, then **restored** the secret protections it had dropped: `.env.*` catch-all (now also `**/.env*`), `*.pem`, secret-folder rules, plus `*.key/*.p12/*.pfx`.
- Narrow re-allow only for `/.env.example` and `/gateway/.env.example`.
- **Fixed** `build/` → `/build/` (and `/out/`, `/coverage/`): the unanchored `build/` ignored source route dirs `src/app/api/ai/{trader,strategy}/build/`.
- `gateway/data/` fully ignored again (working tree had narrowed it to `bars.json`).
- Added `.next-stale-*/`, `.claude/worktrees/`, `.claire/`, `.claude/settings.local.json`, `reports/orchestrator/review-error-*.json`.

## Git actions for the recovery commit

1. Add 105 untracked canonical files (list = untracked minus sync copies, `.next-stale-8c/`, orchestrator error dumps).
2. Stage the 33 modified files and the repaired `.gitignore`.
3. Stage 1044 reviewed deletions (see TSV: 698 node_modules/dist debt, 311 flattened `apps/trading-view`, 21 Console files, 8 old `services/gateway` sources, 4 Data-Manager EA files, 2 agent worktree entries).
4. Remove 4 tracked stale sync copies from the index (`git rm --cached`, local files kept): `.gitignore 2`, `package-lock 2.json`, `gateway/package-lock 2.json`, `gateway/src/index 2.ts` (2026-08-23 snapshot compiled into the gateway build).
5. **Not staged:** 52 deletions under `AVLFXドキュメント/` and `AVL-FX document/` (intent unknown; they stay in Git — Owner decision).

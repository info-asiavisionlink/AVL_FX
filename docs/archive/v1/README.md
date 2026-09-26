# ARCHIVED — HISTORICAL — NOT CURRENT V2 CANONICAL SPEC

This folder preserves AVL-FX **V1-era** documentation (last edited 2026-08-22 … 2026-09-10) that was removed from the repository root during the Console / Trading View separation. It is kept for history and audit only.

**Do not use these files as requirements, design or operational instructions.**
Current canonical documentation:

- V2 architecture and requirements: `docs/v2/`
- Current system and development log: `docs/*.md`
- Stage status: `STATE.json`, `HANDOFF.md`, `reports/`

Many statements here are superseded. Examples: V1 had a single shared Supabase/Gateway; "Trading View holds no service_role"; V1 EA versions; Stripe billing; V1 research phases.

## Contents

| Folder | Content |
|---|---|
| `AVLFXドキュメント/00_MASTER` | V1 master plan, roadmap, product vision, architecture |
| `AVLFXドキュメント/01_CURRENT_SYSTEM` | V1 snapshots of AI, backend, DB, frontend, gateway, MT5, research engine |
| `AVLFXドキュメント/02_DEVELOPMENT_LOG` | V1 stage logs (2026-08-22 … 2026-09-10) |
| `AVLFXドキュメント/03_PRODUCTION` | V1 production notes (execution, env variable names, safety) |
| `AVLFXドキュメント/04_WORKFLOW`, `05_UI_UX`, `06_RESEARCH_HISTORY`, `99_ARCHIVE` | V1 workflows, UI specs, research results |
| `AVL-FX document/AVL-FX_システム仕様書.md` | V1 system specification |

`MANIFEST.tsv` lists every file with its original path, SHA-256 (identical to the git blob at `4106312`), size and last commit. Paths are preserved one-to-one under this folder, so no filename collisions occur. A secret scan found no credential values; only variable names are mentioned.

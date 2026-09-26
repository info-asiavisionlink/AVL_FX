# AVL_FX_Bridge — Build Verification

Date: 2026-09-27 · Builder: Claude Opus 5.5 · No MT5 install, restart, chart change or execution was performed.

## Build record

| Item | Value |
|---|---|
| Source | `ea/AVL_FX_Bridge.mq5` — `#property version "5.00"`, `BRIDGE_VERSION "5.0"` |
| Source SHA-256 | `c7def89afb9887a0df8859c926cfebb15eec4784a0372ce965579bb96f957579` |
| Source last commit | `df8a9ba` (2026-09-26 19:36 JST, V2 Stage 3 Codex cycle 11) |
| Repository HEAD at build | `84aa70645aed9f9f63ee1a628381e51209bcb0ef` (source clean, identical to HEAD) |
| Compiler | MetaEditor64.exe FileVersion **5.0.0.6230**, MetaTrader 5.app (wine prefix `net.metaquotes.wine.metatrader5`), `cpu='X64 Regular'` |
| Build method | CLI `/compile` on a **copy** in a scratch directory outside the terminal's `MQL5/Experts` (the running `terminal64.exe` was not touched); `/include` = read-only copy of the terminal's `MQL5/Include` |
| Compile window (UTC) | 2026-09-26T16:07:06Z – 16:07:10Z |
| Result | **0 errors, 1 warning**, 1902 ms |
| Log | `reports/ea/AVL_FX_Bridge-v5.00-compile.log` |
| Binary | `ea/dist/AVL_FX_Bridge-v5.00-src-c7def89a.ex5` |
| Binary SHA-256 | `b7f5b9f79aee8cee7e98c794044ec4abbdea86746d6d94c8fd8198202d355274` (86 710 bytes) |

### Warning review

`(791,28) warning 89: 'POSITION_COMMISSION' is deprecated`: the positions report sends `PositionGetDouble(POSITION_COMMISSION)`, which newer terminals always return as 0. It is informational only (commission shows 0 in position snapshots) and has no effect on order placement, SL/TP or risk. **P3**. A future fix would read commission from deals (`DEAL_COMMISSION`).

## Distributed binary vs source

| File | SHA-256 (first 12) | Built | Version |
|---|---|---|---|
| `public/ea/AVL_FX_Bridge.ex5` (customer download, tracked) | `26e217deb025` | 2026-09-11 02:32 JST | v4.x |
| `ea/AVL_FX_Bridge.ex5` (local, git-ignored) | `26e217deb025` | same file | v4.x |
| Terminal `MQL5/Experts/AVL_FX_Bridge.ex5` | `874a8a86e0f3` | 2026-09-22 04:52 JST, from a 09-22 source (`497b7fe7…`, not the current source) | intermediate |
| **New verified build** `ea/dist/…v5.00…ex5` | `b7f5b9f79aee` | 2026-09-27 01:07 JST from current source | **v5.0** |

- EA_SOURCE_CURRENT = YES
- EA_BINARY_PROVEN_FROM_CURRENT_SOURCE = YES for the new `ea/dist` build; **NO** for the distributed `public/ea` binary
- MQL5_COMPILE = **VERIFIED (0 errors, 1 reviewed warning)**

## Why `public/ea/AVL_FX_Bridge.ex5` was NOT replaced

The v5.0 EA calls V2 Gateway endpoints: `/market-data/bars`, `/market-data/backfill`, `/market-data/backfill/complete`, `/market-data/last-bar`, `/market-data/tick`, `/bridge/symbol-spec`. These write to `customer_bar_data` / backfill tables from migrations 035–036.

The production Gateway (`remarkable-cooperation-production-7341.up.railway.app`, last deployed 2026-09-25T19:44Z) answers `GET /market-data/last-bar` and `GET /market-data/bar-count` with **404**. Both are authenticated GET routes, so a deployed route would answer 401. An older `/market-data/status` answers 200. So the V2 Gateway routes are **not in production**, and migrations 035–038 are not applied.

Distributing v5.0 now would give customers an EA whose market-data path fails against Production. The swap therefore belongs to the V2 deployment and must go in this order:

1. Migrations 035–038 (Human Gate)
2. V2 Gateway on Railway
3. App on Vercel
4. Replace `public/ea/AVL_FX_Bridge.ex5` with `ea/dist/AVL_FX_Bridge-v5.00-src-c7def89a.ex5` (verify SHA-256 `b7f5b9f7…`)
5. Customer EA re-install on demo terminals first

EA_REBUILD_REQUIRED = NO (the verified build exists). EA_DISTRIBUTION = PENDING V2 DEPLOYMENT (P2).

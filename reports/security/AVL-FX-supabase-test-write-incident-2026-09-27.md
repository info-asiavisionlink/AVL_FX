# Incident — Integration test wrote to the Production Supabase

Date: 2026-09-27 · Author: Claude Opus 5.5 (the agent that caused it) · Severity: P1 · Status: OPEN — Owner decisions pending
No secret values appear in this report.

## 1. Summary

During repository recovery the agent ran `src/infrastructure/backtest/__tests__/integration.test.ts` once, in the original working directory, **without reading it first**. The test loads `.env.local`, which points at the **Production** Trading View Supabase. With the service-role key it ran one real backtest job, which inserted 53 rows and updated one `strategy_registry` row. No MT5, execution-command, Gateway or money path was involved.

## 2. Timeline (JST)

| Time | Event |
|---|---|
| 2026-09-27 00:25 | Recovery commit `9bfcc21`; clean-checkout test sweep shows `integration.test.ts` failing (no env) |
| 00:27:46–48 | Agent re-runs the same file in the original directory to compare → the test writes to Production |
| ~00:30 | Agent notices "strategy_registry.backtest_status updated" in the output, stops, scopes impact read-only |
| 00:35 | Guard commit `eae59d8`: the test skips unless `AVL_ALLOW_LIVE_DB_INTEGRATION=1` |
| 00:40–01:30 | This response: project classification, read-only verification, scope proof, cleanup plan, guard hardening |

## 3. Affected project — PRODUCTION (proven)

- `.env.local` and `gateway/.env` both point at Supabase ref `bsmofroshpmomjwfxigh`; the service-role JWT's `ref` claim is the same project.
- The **live production site** `https://avl-fx.vercel.app` (Vercel project `avl-fx`, production alias of the current Ready production deployment) ships `https://bsmofroshpmomjwfxigh.supabase.co` in its public client bundle (fetched anonymously, 2026-09-27).
- `AVL-FX console/docs/AVLFX_CONSOLE_ROADMAP.md` maps Trading View → Supabase `bsmofroshpmomjwfxigh`, Railway `remarkable-cooperation` (the Gateway URL in `.env.local`).
- `supabase/.temp/linked-project.json` (tracked) names the linked project "AVL_FX" with this ref. The repo docs record that migration 034 was applied to "the approved Production Supabase project". `STATE.json` records 001–034 as Production-applied.
- `.env.local` says `NODE_ENV=development` and `APP_URL=https://avl-fx.vercel.app`. Local development runs directly against Production; there is no separate dev project.

## 4. Verified incident rows (read-only HTTP GET, 2026-09-27)

| Table | Operation | Expected | Actual | Identifier |
|---|---|---|---|---|
| `backtest_jobs` | INSERT, then 2× UPDATE (RUNNING → COMPLETED) | 1 | **1** | `e007b9f3-67ff-4d96-aa0f-3ae3d4e759a2`, created 2026-09-26T15:27:46.004Z, COMPLETED, `bar_count` 1026, period AVAILABLE |
| `backtest_results` | INSERT | 1 | **1** | `681f708d-ab22-48fe-ac52-e45053f1b420` (verdict PASSED) |
| `backtest_trades` | INSERT | 51 | **51** | `job_id = e007b9f3…`, all `strategy_id = 4582c579…`, created 15:27:47.554Z |
| `strategy_registry` | UPDATE `backtest_status`, `updated_at` | 1 | **1** | `4582c579-8990-4790-a000-e33b2f68acbb` "GOLD Day H4 MACD RSI30 LDN-NY": now `backtest_status=PASSED`, `updated_at=2026-09-26T15:27:47.885Z`, `status=DRAFT`, `user_id=NULL` |
| `bar_data` | SELECT only | 0 writes | 0 | — |

**Other tables:** a scan of all 42 PostgREST tables for rows created or updated between 15:27:30 and 15:28:30Z found only the four tables above. `ai_traders`, `ai_trader_versions`, `customer_knowledge`, `execution_commands`, `ai_positions`, `mt5_connections`, `bar_data` and the audit/event tables have 0 rows in that window. No other row references the strategy or the job: `strategy_ai_analyses`, `strategy_versions.best_job_id` and the optimization tables all return 0.

**Code proof:** the test's import closure is 14 modules. Only `BacktestService.runBacktestJob` writes, and it touches exactly `backtest_jobs`, `backtest_trades`, `backtest_results` and `strategy_registry`. Its only external package with I/O is `@supabase/supabase-js`. The repo migrations define no triggers on these tables.

## 5. MT5 / money / customer impact

- **MT5_EXECUTION_IMPACT = NONE_PROVEN.** The closure contains no Gateway, execution-service, Unified Bridge, `execution_commands`, order, position or `fetch` code. The backtest engine is pure in-memory simulation. DB evidence: 0 `execution_commands` and 0 `ai_positions` rows in the window.
- **Real-money impact:** none.
- **Customer data impact:** none. The affected strategy has `user_id = NULL` (a system/curated strategy, status DRAFT), and no customer-owned table changed.
- **Data-integrity impact:** one extra backtest run is visible in that strategy's history, and `strategy_registry.updated_at` changed.

## 6. strategy_registry — previous state

| Field | Classification |
|---|---|
| `backtest_status` before the incident | **UNKNOWN_PREVIOUS_VALUE**. The **INFERRED** value is `PASSED`. |
| `updated_at` before the incident | **UNKNOWN_PREVIOUS_VALUE** |

Why the value is inferred, not proven:
- The strategy was created 2026-09-19T14:56:07Z together with job `5edaa25b` (verdict PASSED).
- No versions, optimizations or AI analyses reference it. These are the code paths that reset the status to `NOT_TESTED`.
- There is no audit/history table for `strategy_registry`, and a direct SQL edit cannot be ruled out.
- Proof would require Supabase PITR or Postgres logs (Owner/dashboard only).

## 7. Proposed cleanup (NOT EXECUTED)

`reports/security/AVL-FX-incident-cleanup-PROPOSED-NOT-EXECUTED-2026-09-27.sql`:

- One transaction. It verifies the job by identity and time window, the result id, trades = 51, and that the other FK children (`strategy_ai_analyses`, `strategy_versions.best_job_id`) are empty. Any mismatch raises and aborts.
- It deletes the 51 trades, then the 1 result, then the 1 job, checking `ROW_COUNT` after each. It does not rely on CASCADE.
- It post-verifies that the original 2026-09-19 job remains.
- It ends in `ROLLBACK` by default. The operator reviews the output and commits manually.
- `strategy_registry` is **not** modified. After cleanup, the only remaining backtest evidence is the 09-19 PASSED result, which is consistent with the current `PASSED`. `updated_at` stays as the incident timestamp unless the Owner recovers the old value via PITR/logs.
- Validated on the local throwaway Postgres with a fixture: the exact match deletes only the incident rows and keeps the original job, result and 225 trades; a mismatch (50 trades) aborts.

## 8. Credential exposure assessment

| Check | Result |
|---|---|
| Current Production service-role key in git history (all objects) | 0 |
| In tracked files | 0 |
| In Claude session transcripts on this Mac (`~/.claude/projects/*AVL-FX*`) | **present** — 12 prior sessions (2026-09-01 … 2026-09-26 23:54), not this session. The same transcripts also contain `SUPABASE_PAT`, the OpenAI key, the cron/watcher secrets and the Stripe values. |
| Historical exposed key vs current key | The key that appears in those transcripts is the **current** Production key (issued 2026-08-03 UTC, expires 2036-08-03). It has not been rotated since, so any earlier exposure in development output is still live. |

**SERVICE_ROLE_ROTATION_REQUIRED = YES** (HUMAN GATE — not rotated).
Also recommended under the same gate: rotate `SUPABASE_PAT` (Management API, can run SQL), the OpenAI key, `CRON_SECRET`, `WATCHER_SECRET`, `MT5_GATEWAY_SECRET` and `EA_REGISTRY_SECRET`. The Stripe values in `.env.local` are the `.env.example` placeholders.

## 9. Prevention added (code only, no infrastructure change)

1. `eae59d8`: `integration.test.ts` skips unless `AVL_ALLOW_LIVE_DB_INTEGRATION=1`, and only then loads `.env.local`.
2. `scripts/lib/live-guard.ts`, imported first by the 23 scripts that can write to Supabase or the Management API. They refuse (exit 2) unless `AVL_ALLOW_LIVE_SCRIPT=1`. `dev-create-test-command.ts` is included: its only guard was `NODE_ENV=production`, which the Production-pointing `.env.local` (`NODE_ENV=development`) never triggers, so it could create real `execution_commands`.
3. The test helpers now **overwrite** the Gateway URL/secret and the watcher/cron secrets with test values. Previously they used `||=`, so a developer shell or `--env-file` could inject Production values.
4. Proof: every test and guarded script was run under an in-process network blocker (non-loopback connect/fetch refused and logged):
   - 51 test files, plain env: 235 pass / 0 fail, 0 external attempts.
   - Same with `--env-file=.env.local` (worst case): 235 / 0, 0 external attempts.
   - 23 guarded scripts × 2 modes: 46 / 46 REFUSED, 0 external attempts.

## 10. Remaining Human Gates

- **B.** Cleanup of the 53 incident rows (SQL above).
- **C.** Credential rotation (service role + items in §8).
- Optional: PITR/log lookup for the previous `strategy_registry.updated_at` / `backtest_status`.
- Structural: create a separate non-production Supabase for development/testing. Today local dev = Production.

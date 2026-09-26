# AVL-FX Trading View Database Schema — Stage 2

This document describes the Customer Trading View Supabase database. AVL-FX
Console has a separate Supabase project and its tables are intentionally not
recreated here.

## Rebuild status — VERIFIED

The migration chain contains 42 `CREATE TABLE` declarations, 6 SQL functions,
and 100 explicit indexes (including corrective and partial indexes). The
Stage 2 schema tests inspect the repository migration set; no production
database was queried or changed.

| Object | Type | Runtime use | Migration status | Ownership/RLS |
|---|---|---|---|---|
| `ai_traders` | table | trader CRUD, watcher | complete | customer-owned |
| `ai_trader_versions` | table | versioned profile/risk | complete | parent-owned |
| `ai_trader_knowledge` | table | knowledge correlation | complete | parent-owned |
| `ai_trader_scenarios` | table | H1/M5 scenario memory | completed in `029` | customer-owned, versioned |
| `ai_analysis_logs` | table | analysis telemetry/journal | added in `029` | customer-owned |
| `trade_decisions` | table | approval/entry decision | complete | customer-owned |
| `ai_positions` | table | position lifecycle | complete | customer-owned |
| `execution_commands` | table | sole MT5 command contract | complete | customer-owned |
| `trade_outcomes` / `trade_reviews` / `experience_memories` | tables | learning/review | complete | customer-owned |
| `mt5_connections` | table | connection/token hash | complete | customer-owned |
| `symbol_specs` | table | broker risk constraints | complete | connection-owned |
| `live_positions` / `live_deals` | tables | MT5 live sync | complete | connection-owned |
| `trade_history` | table | legacy/history repository | added before `015` | customer/user nullable for legacy rows |
| `economic_events` / `news_items` | tables | calendar/news repository | added before `015` | shared market data |
| `trade_audit_log` | table | operational decision audit | added in `029` | service writes, own-row reads |
| `get_bar_data_status()` | function | TV historical health/status | canonical | migration `002` |
| `get_bar_stats()` | function | Console historical UI name | not part of TV DB | Console boundary |
| `ea_registry` | table | Console EA registry | not part of TV DB | Console boundary |

## Ownership and correlation

Customer rows carry `user_id` directly or reach it through `ai_traders` and
`mt5_connections`. Core records retain the following chain where applicable:

`ai_trader` → `ai_trader_version` → `scenario` → `analysis log` →
`trade_decision` → `execution_command` → `ai_position` → outcome/review.

`scenario_version` is backfilled deterministically by migration `029` before
its per-trader unique index is created. Existing rows remain valid and no
history is deleted. `ai_analysis_logs` stores operational telemetry and
user-facing rationale; it deliberately has no raw chain-of-thought field.

RLS is enabled for customer-facing tables with authenticated own-row policies
and service-role policies for server-side operations. Shared `bar_data`,
`economic_events`, and `news_items` remain shared market-data namespaces and
do not contain customer trade state.

Connection tokens are represented only by `connection_token_hash`; plaintext
MT5 passwords or connection tokens are not schema fields.

## Migration strategy

`006_shared_runtime_tables.sql` is intentionally ordered before the historical
`015_user_isolation_rls.sql`, which alters those tables. `029_stage2_schema_completion.sql`
is additive and handles existing data before adding constraints/indexes. Older
migrations were not rewritten. Production application requires a backup,
schema snapshot, dry run, compatibility check, controlled maintenance window,
post-migration verification, and a rollback decision; that procedure was not
executed against production. A complete temporary local PostgreSQL cluster was
used for verification: all 31 repository migrations applied from an empty
database, and a separate pre-Stage-2 database upgraded through migration 029.

## Legacy classification

The strategy/backtest/optimization/walk-forward tables are retained as
`LEGACY` or `ACTIVE` according to their current callers. They were not dropped
or repurposed. Console-owned tables such as `ea_registry` and Console RPCs are
`OUT OF SCOPE`, not silently duplicated in the Customer database.

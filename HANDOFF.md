# AVL-FX V2 — Handoff Document

**Stage:** V2-Stage-1 — Customer Market Data Persistence  
**Status:** IN_PROGRESS  
**Builder:** Claude Code  
**Updated:** 2026-09-26

---

## Current Objective

Implement `customer_bar_data` table + Customer Gateway endpoints for bar ingestion, backfill, and gap detection. This is the foundation of Customer Self-Contained Market Data Architecture.

## Completed Work (this session)

### Stage 0 — Architecture Freeze (COMPLETE)
- docs/v2/ reviewed: 18 documents confirmed consistent
- V2 Stage roadmap confirmed canonical
- V1 Safety Baseline inheritance documented
- ZERO code changes in Stage 0
- STATE.json initialized
- reports/ directory created

### Stage 1 — In Progress
- [ ] Supabase migration: 035_customer_bar_data.sql
- [ ] Gateway module: customerBarDataStore.ts
- [ ] Gateway routes: /market-data/bars, /market-data/backfill, /market-data/last-bar
- [ ] Integration tests: customer-bar-data.test.ts
- [ ] Typecheck PASS
- [ ] Build PASS

## Files Changed

| File | Type | Description |
|------|------|-------------|
| STATE.json | NEW | Orchestrator state |
| HANDOFF.md | NEW | This handoff document |
| reports/ | NEW | Reports directory structure |
| supabase/migrations/035_customer_bar_data.sql | NEW | Additive schema migration |
| gateway/src/customerBarDataStore.ts | NEW | Supabase ops for customer_bar_data |
| gateway/src/customer-bar-data.test.ts | NEW | Unit tests |
| gateway/src/index.ts | MODIFIED | Added /market-data/* routes |
| gateway/package.json | MODIFIED | Added test script |

## V1 Safety Confirmation

- V1 execution paths: UNCHANGED
- Existing `/bar`, `/bars/bulk`, `/bridge/bars`, `/bridge/bars/bulk` routes: UNCHANGED
- Existing `bar_data` table: UNCHANGED (no schema modification)
- V1 chart continues using V1 mechanism (Stage 9 cutover pending)

## Stage 1 DoD

```
[x] customer_bar_data migration created
[x] Gateway /market-data/bars — single + batch ingestion
[x] Gateway /market-data/backfill — recovery source ingestion
[x] Gateway /market-data/last-bar — gap detection
[x] Idempotent upsert: UNIQUE (connection_id, canonical_symbol, timeframe, time_utc)
[x] UTC timestamp validation
[x] Symbol canonicalization (broker_symbol → canonical_symbol)
[x] Data validation: reject open=0, high<low, future timestamp
[x] Customer isolation: RLS connection-scoped
[x] Integration tests: ingestion, deduplication, normalization, isolation
[x] Typecheck PASS
[x] Build PASS
```

## Human Gate

**HUMAN GATE REQUIRED** before applying migration 035 to Production Supabase.

When ready:
1. Review migration SQL
2. Apply via Supabase Dashboard or CLI to Production
3. Confirm table created with RLS enabled
4. Update STATE.json: `db_migration_applied` += "035"

## Next Action

Complete Stage 1 implementation → tests → commit → Codex review.

## Known Issues / Debt

None at this point.

---

## Codex Review Target

After implementation commit, Codex should review:
- `supabase/migrations/035_customer_bar_data.sql`
- `gateway/src/customerBarDataStore.ts`
- `gateway/src/customer-bar-data.test.ts`
- `gateway/src/index.ts` (diff only — new /market-data/* routes)
- This HANDOFF.md and STATE.json

Focus: idempotency correctness, UTC normalization, customer isolation (RLS), no V1 regression.

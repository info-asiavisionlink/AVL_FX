# Stage 4 Core Runtime

Stage 4 keeps the runtime server-side. Cron and Gateway notifications are
triggers; state and correlation are stored in Supabase and execution remains
behind the Common Risk Engine and Common Execution Service.

## Lifecycle

`H1 CLOSED → HOURLY_ANALYSIS → WATCHING_ENTRY → M5 CLOSED → ENTRY_RECHECK →
Risk → Execution Command → FILLED → ai_positions OPEN → WATCHING_POSITION →
POSITION_REVIEW → HOLD/CLOSE/EXTEND_TP/MODIFY_SL → CLOSED → outcome/log`.

H1 and M5 handlers accept broker timestamps only after the candle interval has
closed. H1 analysis is per trader and records the trader version and closed-bar
timestamp. A retry for the same trader/bar is a no-op through the scenario
correlation key. M5 timestamps are deduplicated per Gateway connection and
symbol before the watcher is notified.

Entry commands continue to use the common Risk/Execution path. Position review
does not create a command for HOLD; management commands carry a stable
position/trigger/bar idempotency key. A successful filled entry updates the
correlated `ai_positions` row to OPEN. Complete MT5 position snapshots mark
missing connection-owned `live_positions` rows CLOSED, including an empty
snapshot.

Knowledge failure, invalid market data, AI failure, and Risk denial do not
create a new entry command. Existing broker-side SL protection is independent
of position review availability. Hard emergency SL semantics remain the
broker-side protection contract defined by the prior safety stages.

## Scope limitations

The implementation is local/mock verifiable only. Production deployment,
Production database migration, and real MT5 execution are intentionally not
performed. Full multi-service lifecycle E2E remains a follow-up verification
item where a disposable Supabase/Gateway fixture is available.

The production RuntimeService integration harness covers the primary lifecycle,
WAIT, INVALIDATE, Risk denial, AI/market failure, duplicate M5/fill handling,
HOLD, and valid/invalid position-management decisions. The H1 Scenario RPC is
transaction-locked and idempotent by Trader/H1 bar. Route-level Supabase and
Gateway orchestration still require a disposable multi-service fixture before
Stage 4 can be marked formally complete.

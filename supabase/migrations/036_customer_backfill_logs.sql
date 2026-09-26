-- V2 Stage 2: Historical Backfill / Recovery — Monitoring Table
-- Additive migration: new table only.
-- Production Human Gate required before applying.

CREATE TABLE IF NOT EXISTS public.customer_backfill_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership and isolation
  user_id          UUID        NOT NULL REFERENCES auth.users(id),
  connection_id    UUID        NOT NULL REFERENCES public.mt5_connections(id) ON DELETE CASCADE,

  -- What was backfilled
  canonical_symbol TEXT        NOT NULL,
  timeframe        TEXT        NOT NULL,
  from_utc         TIMESTAMPTZ,             -- start of requested gap range (nullable: unknown on EA side)
  to_utc           TIMESTAMPTZ,             -- end of requested gap range

  -- Results
  bars_sent        INTEGER     NOT NULL DEFAULT 0,  -- bars EA reported sending
  bars_accepted    INTEGER     NOT NULL DEFAULT 0,  -- bars accepted by Gateway (post-validation)
  bars_verified    INTEGER,                         -- bars confirmed in DB after completion
  gap_remaining    BOOLEAN     NOT NULL DEFAULT false,

  -- Metadata
  source           TEXT        NOT NULL DEFAULT 'bridge_recovery'
    CHECK (source IN ('bridge_recovery', 'bridge_backfill')),
  completed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT backfill_log_reasonable_bars CHECK (bars_sent >= 0 AND bars_accepted >= 0)
);

CREATE INDEX IF NOT EXISTS idx_backfill_logs_conn_sym_tf
  ON public.customer_backfill_logs (connection_id, canonical_symbol, timeframe, completed_at DESC);

-- RLS: authenticated users see only their own connection's logs
ALTER TABLE public.customer_backfill_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "backfill_logs_select_own"
  ON public.customer_backfill_logs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.mt5_connections c
      WHERE c.id = customer_backfill_logs.connection_id
        AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "backfill_logs_service_role"
  ON public.customer_backfill_logs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.customer_backfill_logs IS
  'V2 Stage 2: Audit log for each backfill/recovery operation. Tracks gap coverage and data quality.';

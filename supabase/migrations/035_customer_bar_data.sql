-- V2 Stage 1: Customer Market Data Persistence
-- Additive migration: new table only. V1 bar_data table is not modified.
-- Production Human Gate required before applying.

CREATE TABLE IF NOT EXISTS public.customer_bar_data (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership and isolation
  user_id          UUID        NOT NULL REFERENCES auth.users(id),
  connection_id    UUID        NOT NULL REFERENCES public.mt5_connections(id) ON DELETE CASCADE,

  -- Symbol identification
  canonical_symbol TEXT        NOT NULL,
  broker_symbol    TEXT        NOT NULL,
  broker           TEXT,
  broker_server    TEXT,

  -- Timeframe
  timeframe        TEXT        NOT NULL
    CHECK (timeframe IN ('M1','M5','M15','M30','H1','H4','D1','W1','MN1')),

  -- Bar identity (canonical key)
  time_utc         TIMESTAMPTZ NOT NULL,

  -- OHLCV
  open             NUMERIC(18,5) NOT NULL,
  high             NUMERIC(18,5) NOT NULL,
  low              NUMERIC(18,5) NOT NULL,
  close            NUMERIC(18,5) NOT NULL,
  tick_volume      BIGINT,
  spread           INTEGER,

  -- Data quality metadata
  source           TEXT        NOT NULL DEFAULT 'bridge_realtime'
    CHECK (source IN ('bridge_realtime','bridge_backfill','bridge_recovery')),
  is_confirmed     BOOLEAN     NOT NULL DEFAULT true,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Canonical bar identity
  CONSTRAINT customer_bar_data_unique
    UNIQUE (connection_id, canonical_symbol, timeframe, time_utc)
);

-- Primary query: N bars for chart/analysis
CREATE INDEX IF NOT EXISTS idx_cbar_conn_sym_tf_time
  ON public.customer_bar_data (connection_id, canonical_symbol, timeframe, time_utc DESC);

-- Gap detection / backfill recovery queries
CREATE INDEX IF NOT EXISTS idx_cbar_source_time
  ON public.customer_bar_data (connection_id, canonical_symbol, timeframe, source, time_utc DESC);

-- ----------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------

ALTER TABLE public.customer_bar_data ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read only their own connection's bars
CREATE POLICY "cbar_select_own_connection"
  ON public.customer_bar_data FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.mt5_connections c
      WHERE c.id = customer_bar_data.connection_id
        AND c.user_id = auth.uid()
    )
  );

-- Service role has full access (Gateway uses service role key)
CREATE POLICY "cbar_service_role_all"
  ON public.customer_bar_data FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.customer_bar_data IS
  'V2: Customer-specific OHLC bars from Customer MT5 broker. Source of truth for that customer. Not shared across customers.';

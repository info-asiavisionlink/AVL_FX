-- Stage 6F: connection-scoped persistent broker bars.
-- Existing rows cannot be assigned to a connection without evidence, so
-- connection_id remains nullable for ambiguous legacy/shared rows. Customer
-- runtime readers must never use those NULL rows.

ALTER TABLE public.bar_data
  ADD COLUMN IF NOT EXISTS connection_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bar_data_connection_id_fkey'
      AND conrelid = 'public.bar_data'::regclass
  ) THEN
    ALTER TABLE public.bar_data
      ADD CONSTRAINT bar_data_connection_id_fkey
      FOREIGN KEY (connection_id)
      REFERENCES public.mt5_connections(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- The historical primary key cannot coexist with two connections carrying the
-- same symbol/timeframe/timestamp. Replace it with a nullable-safe scoped
-- unique constraint; NULL legacy rows remain distinguishable as ambiguous.
ALTER TABLE public.bar_data DROP CONSTRAINT IF EXISTS bar_data_pkey;
ALTER TABLE public.bar_data
  ADD CONSTRAINT bar_data_connection_unique
  UNIQUE (connection_id, symbol, timeframe, time_utc);

CREATE INDEX IF NOT EXISTS idx_bar_data_connection_lookup
  ON public.bar_data (connection_id, symbol, timeframe, time_utc DESC);

DROP POLICY IF EXISTS "bar_data_select" ON public.bar_data;
DROP POLICY IF EXISTS "bar_data_read" ON public.bar_data;
DROP POLICY IF EXISTS "bar_data_insert" ON public.bar_data;
DROP POLICY IF EXISTS "bar_data_update" ON public.bar_data;
DROP POLICY IF EXISTS "bar_data_service_role" ON public.bar_data;

ALTER TABLE public.bar_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bar_data_select_owned_connection"
  ON public.bar_data FOR SELECT TO authenticated
  USING (
    connection_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.mt5_connections c
      WHERE c.id = bar_data.connection_id
        AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "bar_data_service_role"
  ON public.bar_data FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON COLUMN public.bar_data.connection_id IS
  'Owning MT5 connection for customer broker bars. NULL means ambiguous legacy data and is excluded from customer runtime reads.';

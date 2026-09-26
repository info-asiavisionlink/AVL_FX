-- Stage 4: Customer Knowledge Localization
-- Customer AI Trader reads knowledge from Customer Supabase (no runtime Console dependency).
--
-- Design:
--   - Each row is one knowledge item delivered to a specific AI Trader.
--   - Knowledge is versioned via package_version (e.g. "2026-09-26-v1").
--   - Old versions are marked SUPERSEDED (not deleted) for audit trail.
--   - content is copied from Console at package time — Console is NOT read at runtime.
--   - RLS: customers can only read their own trader's knowledge.
--   - service_role: package deployment writes (HUMAN GATE — not performed at runtime).

CREATE TABLE IF NOT EXISTS public.customer_knowledge (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES auth.users(id),
  ai_trader_id          UUID        NOT NULL REFERENCES public.ai_traders(id) ON DELETE CASCADE,

  -- Package version (e.g. "2026-09-26-v1") — identifies the deployment batch
  package_version       TEXT        NOT NULL,
  installed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Provenance: reference back to Console source (NOT a live FK — Console is a separate DB)
  source_knowledge_id   UUID,           -- Console trading_knowledge.id at time of packaging
  source_version        INTEGER,        -- Console knowledge version at time of packaging

  -- Integrity
  content_hash          TEXT,           -- SHA-256 of content at packaging time

  -- Knowledge content (copied from Console at package time — immutable after packaging)
  title                 TEXT        NOT NULL,
  category              TEXT        NOT NULL,
  content               TEXT        NOT NULL,
  ai_usage              TEXT,
  summary               TEXT,
  market                TEXT[]      NOT NULL DEFAULT '{}',
  timeframes            TEXT[]      NOT NULL DEFAULT '{}',
  tags                  TEXT[]      NOT NULL DEFAULT '{}',
  source_type           TEXT        NOT NULL DEFAULT 'PACKAGED'
                        CHECK (source_type IN ('PACKAGED', 'CUSTOM', 'FIXTURE')),

  -- Status: ACTIVE = current, SUPERSEDED = replaced by newer package, REMOVED = explicitly removed
  status                TEXT        NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REMOVED')),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index: primary runtime query (all ACTIVE knowledge for a trader)
CREATE INDEX IF NOT EXISTS idx_customer_knowledge_trader_status
  ON public.customer_knowledge (ai_trader_id, status);

-- Index: category-priority selection
CREATE INDEX IF NOT EXISTS idx_customer_knowledge_trader_category
  ON public.customer_knowledge (ai_trader_id, category, status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_customer_knowledge_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_customer_knowledge_updated_at ON public.customer_knowledge;
CREATE TRIGGER trg_customer_knowledge_updated_at
  BEFORE UPDATE ON public.customer_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.set_customer_knowledge_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.customer_knowledge ENABLE ROW LEVEL SECURITY;

-- Authenticated users can only read knowledge for their own traders
CREATE POLICY "customer_knowledge_select"
  ON public.customer_knowledge FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.ai_traders t
      WHERE t.id = ai_trader_id
        AND t.user_id = auth.uid()
    )
  );

-- service_role bypasses RLS for package deployment (HUMAN GATE operation)
CREATE POLICY "customer_knowledge_service_role"
  ON public.customer_knowledge FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.customer_knowledge IS
  'Customer AI Trader knowledge packages. Content copied from Console at deployment time. '
  'Customers read from here at runtime — no Console API call needed. '
  'package_version groups items from the same deployment batch. '
  'Old packages are SUPERSEDED (not deleted) for auditability.';

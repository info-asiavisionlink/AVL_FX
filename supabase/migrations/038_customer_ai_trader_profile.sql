-- Stage 5: Customer AI Trader Profile / Configuration
-- Adds timeframe profile support and formalises knowledge reference.
--
-- Additive migration — zero existing columns removed or renamed.
-- All new tables follow existing ownership chain:
--   ai_trader_timeframe_profiles → ai_trader_versions → ai_traders → auth.users
--
-- Human Gate required for Production apply.

-- ── 1. knowledge_package_version on ai_trader_versions ──────────────
-- Allows each AI Trader Version to explicitly reference which
-- Customer Knowledge package was active when the version was created.
-- NULL = pre-Stage-4 trader (no package tracking).
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS knowledge_package_version TEXT;

COMMENT ON COLUMN public.ai_trader_versions.knowledge_package_version IS
  'Stage 4 knowledge package version deployed to customer_knowledge for this trader. '
  'Used for audit: which knowledge package was active when this version was configured.';

-- ── 1b. Canonical risk-limit columns on ai_trader_versions ───────────
-- The runtime Risk Engine (m5-close entry recheck, execute, dry-run) reads
-- these three limits, but no earlier migration created them.  They become
-- part of the Customer Supabase canonical risk config here.  Defaults are the
-- conservative values of buildDefaultRiskEngineProfile().
-- max_spread_points = 0 means "use the symbol spec spread limit".
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS account_data_max_age_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (account_data_max_age_seconds BETWEEN 1 AND 3600);
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS tick_data_max_age_seconds INTEGER NOT NULL DEFAULT 10
    CHECK (tick_data_max_age_seconds BETWEEN 1 AND 3600);
ALTER TABLE public.ai_trader_versions
  ADD COLUMN IF NOT EXISTS max_spread_points INTEGER NOT NULL DEFAULT 0
    CHECK (max_spread_points >= 0);

-- ── 2. ai_trader_timeframe_profiles ─────────────────────────────────
-- Role-based timeframe profile for each AI Trader Version.
-- Replaces the implicit H1 + M5 hardcoding in V1 runtime.
-- ONE profile per version (UNIQUE constraint).
CREATE TABLE IF NOT EXISTS public.ai_trader_timeframe_profiles (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_trader_version_id     UUID        NOT NULL UNIQUE
                           REFERENCES public.ai_trader_versions(id) ON DELETE CASCADE,

  -- High-level style (determines WHEN to trade)
  timeframe_style          TEXT        NOT NULL DEFAULT 'DAY_TRADING'
                           CHECK (timeframe_style IN ('SCALPING', 'DAY_TRADING', 'SWING')),

  -- Role-based timeframe arrays (M1..MN1 enforced here and in the app layer)
  macro_context_timeframes TEXT[]      NOT NULL DEFAULT '{}',
  trend_context_timeframes TEXT[]      NOT NULL DEFAULT '{}',
  setup_timeframes         TEXT[]      NOT NULL DEFAULT '{}',
  entry_timeframes         TEXT[]      NOT NULL DEFAULT '{}',
  management_timeframes    TEXT[]      NOT NULL DEFAULT '{}',

  -- Monitoring cadence (minutes between watcher ticks)
  monitor_interval_minutes INTEGER     NOT NULL DEFAULT 5
                           CHECK (monitor_interval_minutes BETWEEN 1 AND 60),

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Require at least one trend-context and one entry timeframe.
  -- cardinality() (not array_length) so '{}' evaluates to 0 → FALSE, not NULL.
  CONSTRAINT valid_required_timeframes CHECK (
    cardinality(trend_context_timeframes) > 0 AND
    cardinality(entry_timeframes) > 0
  ),
  CONSTRAINT valid_timeframe_values CHECK (
    macro_context_timeframes <@ ARRAY['M1','M5','M15','M30','H1','H4','D1','W1','MN1']::TEXT[] AND
    trend_context_timeframes <@ ARRAY['M1','M5','M15','M30','H1','H4','D1','W1','MN1']::TEXT[] AND
    setup_timeframes         <@ ARRAY['M1','M5','M15','M30','H1','H4','D1','W1','MN1']::TEXT[] AND
    entry_timeframes         <@ ARRAY['M1','M5','M15','M30','H1','H4','D1','W1','MN1']::TEXT[] AND
    management_timeframes    <@ ARRAY['M1','M5','M15','M30','H1','H4','D1','W1','MN1']::TEXT[]
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_trader_tf_profiles_version
  ON public.ai_trader_timeframe_profiles (ai_trader_version_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_ai_trader_tf_profile_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_ai_trader_tf_profile_updated_at
  ON public.ai_trader_timeframe_profiles;
CREATE TRIGGER trg_ai_trader_tf_profile_updated_at
  BEFORE UPDATE ON public.ai_trader_timeframe_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_ai_trader_tf_profile_updated_at();

-- ── 3. RLS ───────────────────────────────────────────────────────────
ALTER TABLE public.ai_trader_timeframe_profiles ENABLE ROW LEVEL SECURITY;

-- Read-only for customers; all writes go through server-side routes that
-- verify ownership first (no INSERT/UPDATE/DELETE policy for authenticated).
DROP POLICY IF EXISTS "ai_trader_tf_profiles_select" ON public.ai_trader_timeframe_profiles;
CREATE POLICY "ai_trader_tf_profiles_select"
  ON public.ai_trader_timeframe_profiles FOR SELECT TO authenticated
  USING (
    ai_trader_version_id IN (
      SELECT v.id FROM public.ai_trader_versions v
      JOIN  public.ai_traders t ON t.id = v.ai_trader_id
      WHERE t.user_id = auth.uid()
    )
  );

-- service_role bypasses RLS for config deployment and runtime reads
DROP POLICY IF EXISTS "ai_trader_tf_profiles_service_role" ON public.ai_trader_timeframe_profiles;
CREATE POLICY "ai_trader_tf_profiles_service_role"
  ON public.ai_trader_timeframe_profiles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── 4. Default DAY_TRADING profiles for existing ai_trader_versions ──
-- Existing V1 traders used H1 (scenario) + M5 (entry) implicitly.
-- DAY_TRADING with H4+H1 trend context, M15+M5 setup, M5 entry keeps the
-- V1 H1 scenario + M5 entry cadence.  Note: the H1 analysis bar set changes
-- from V1's hardcoded H4/H1/M30/M15 to H4/H1/M15/M5 (M30 → M5).
-- The runtime fails closed on a missing profile, so this backfill must run
-- before (or together with) the Stage 5 application deploy.
--
-- ON CONFLICT DO NOTHING: idempotent re-run safety.
INSERT INTO public.ai_trader_timeframe_profiles (
  ai_trader_version_id,
  timeframe_style,
  macro_context_timeframes,
  trend_context_timeframes,
  setup_timeframes,
  entry_timeframes,
  management_timeframes,
  monitor_interval_minutes
)
SELECT
  v.id,
  'DAY_TRADING',
  ARRAY['H4']::TEXT[],
  ARRAY['H4', 'H1']::TEXT[],
  ARRAY['M15', 'M5']::TEXT[],
  ARRAY['M5']::TEXT[],
  ARRAY['M15']::TEXT[],
  5
FROM public.ai_trader_versions v
ON CONFLICT (ai_trader_version_id) DO NOTHING;

COMMENT ON TABLE public.ai_trader_timeframe_profiles IS
  'Role-based timeframe profile per AI Trader Version. '
  'Replaces hardcoded H1+M5 in V1 runtime. '
  'timeframe_style: SCALPING|DAY_TRADING|SWING. '
  'Default: DAY_TRADING (H4+H1 context, M5 entry) for V1 backward compat.';

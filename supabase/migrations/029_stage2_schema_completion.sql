-- AVL-FX Stage 2: complete the Trading View database schema.
-- This is additive and safe for an existing database. No production database
-- is touched by repository changes.

-- Scenario fields used by current analyze/H1 routes and immutable versioning.
ALTER TABLE public.ai_trader_scenarios
  ADD COLUMN IF NOT EXISTS scenario_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ai_trader_version_id UUID REFERENCES public.ai_trader_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recheck_triggers_v2 JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS market_view TEXT,
  ADD COLUMN IF NOT EXISTS risk_context TEXT,
  ADD COLUMN IF NOT EXISTS reasoning_summary TEXT,
  ADD COLUMN IF NOT EXISTS trigger_type TEXT,
  ADD COLUMN IF NOT EXISTS entry_side TEXT,
  ADD COLUMN IF NOT EXISTS entry_price_low NUMERIC,
  ADD COLUMN IF NOT EXISTS entry_price_high NUMERIC,
  ADD COLUMN IF NOT EXISTS suggested_sl NUMERIC,
  ADD COLUMN IF NOT EXISTS suggested_tp NUMERIC,
  ADD COLUMN IF NOT EXISTS suggested_volume NUMERIC,
  ADD COLUMN IF NOT EXISTS h1_bar_time BIGINT,
  ADD COLUMN IF NOT EXISTS m5_bar_time BIGINT,
  ADD COLUMN IF NOT EXISTS key_levels JSONB,
  ADD COLUMN IF NOT EXISTS fundamental_notes TEXT,
  ADD COLUMN IF NOT EXISTS next_30min_outlook TEXT,
  ADD COLUMN IF NOT EXISTS applied_knowledge JSONB;

ALTER TABLE public.ai_trader_scenarios
  DROP CONSTRAINT IF EXISTS ai_trader_scenarios_state_check;
ALTER TABLE public.ai_trader_scenarios
  ADD CONSTRAINT ai_trader_scenarios_state_check CHECK
    (state IN ('WAITING','WATCHING','CONSIDERING','DECIDED','INVALID','INVALIDATED'));

-- Existing rows created before versioning all carry the default 1. Backfill a
-- deterministic per-trader sequence before adding the uniqueness constraint.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY ai_trader_id ORDER BY created_at ASC, id ASC
  )::INTEGER AS version_no
  FROM public.ai_trader_scenarios
)
UPDATE public.ai_trader_scenarios s
SET scenario_version = ranked.version_no
FROM ranked
WHERE s.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_trader_scenarios_active_version
  ON public.ai_trader_scenarios (ai_trader_id, scenario_version);
CREATE INDEX IF NOT EXISTS idx_ai_trader_scenarios_trigger_time
  ON public.ai_trader_scenarios (ai_trader_id, trigger_type, created_at DESC);

-- AI analysis telemetry/journal. Only rationale and operational metadata are
-- persisted; raw chain-of-thought is intentionally not a schema field.
CREATE TABLE IF NOT EXISTS public.ai_analysis_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  trader_id UUID NOT NULL REFERENCES public.ai_traders(id) ON DELETE RESTRICT,
  ai_trader_version_id UUID REFERENCES public.ai_trader_versions(id) ON DELETE SET NULL,
  scenario_id UUID REFERENCES public.ai_trader_scenarios(id) ON DELETE SET NULL,
  position_id UUID REFERENCES public.ai_positions(id) ON DELETE SET NULL,
  command_id UUID REFERENCES public.execution_commands(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL DEFAULT 'MANUAL',
  analysis_type TEXT,
  decision TEXT,
  confidence NUMERIC,
  market_timestamp TIMESTAMPTZ,
  current_price NUMERIC,
  bid NUMERIC,
  ask NUMERIC,
  market_context JSONB,
  reasoning_summary TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_logs_owner_time
  ON public.ai_analysis_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_logs_trader_time
  ON public.ai_analysis_logs (trader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_logs_scenario
  ON public.ai_analysis_logs (scenario_id);

ALTER TABLE public.ai_analysis_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_analysis_logs_own" ON public.ai_analysis_logs;
CREATE POLICY "ai_analysis_logs_own" ON public.ai_analysis_logs
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "ai_analysis_logs_service_role" ON public.ai_analysis_logs;
CREATE POLICY "ai_analysis_logs_service_role" ON public.ai_analysis_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Durable decision audit rows used by TradeAuditLogger.
CREATE TABLE IF NOT EXISTS public.trade_audit_log (
  id UUID PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  snapshot_id TEXT,
  ai_model TEXT,
  decision TEXT,
  confidence NUMERIC,
  entry NUMERIC,
  sl NUMERIC,
  tp NUMERIC,
  rr NUMERIC,
  expected_value NUMERIC,
  lot NUMERIC,
  risk_pct NUMERIC,
  risk_status TEXT,
  rejection_reason TEXT,
  order_ticket BIGINT,
  execution_price NUMERIC,
  slippage_pips NUMERIC,
  result_pnl NUMERIC,
  live_trading BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_trade_audit_log_ts ON public.trade_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_trade_audit_log_symbol_ts ON public.trade_audit_log (symbol, ts DESC);
ALTER TABLE public.trade_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trade_audit_log_own" ON public.trade_audit_log;
CREATE POLICY "trade_audit_log_own" ON public.trade_audit_log
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "trade_audit_log_service_role" ON public.trade_audit_log;
CREATE POLICY "trade_audit_log_service_role" ON public.trade_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Correlation indexes required by current execution and position queries.
CREATE INDEX IF NOT EXISTS idx_trade_decisions_scenario
  ON public.trade_decisions (scenario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_decisions_command
  ON public.trade_decisions (command_id);
CREATE INDEX IF NOT EXISTS idx_ai_positions_user_status
  ON public.ai_positions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_commands_correlation
  ON public.execution_commands (user_id, ai_trader_id, created_at DESC);

COMMENT ON TABLE public.ai_analysis_logs IS
  'AI Trading Journal telemetry and user-facing rationale; raw chain-of-thought is not stored.';
COMMENT ON TABLE public.trade_audit_log IS
  'Operational decision audit records. Service role writes; customer reads own rows.';

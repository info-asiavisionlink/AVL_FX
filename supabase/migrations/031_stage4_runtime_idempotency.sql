-- Stage 4 runtime idempotency and lifecycle correlation.
-- Additive only; no production migration is applied by this change.

ALTER TABLE public.ai_trader_scenarios
  ADD COLUMN IF NOT EXISTS h1_bar_time BIGINT,
  ADD COLUMN IF NOT EXISTS ai_trader_version_id UUID REFERENCES public.ai_trader_versions(id),
  ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE public.ai_positions
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.mt5_connections(id) ON DELETE RESTRICT;

ALTER TABLE public.ai_positions DROP CONSTRAINT IF EXISTS ai_positions_status_check;
ALTER TABLE public.ai_positions ADD CONSTRAINT ai_positions_status_check
  CHECK (status IN ('PENDING_OPEN', 'OPEN', 'CLOSED', 'ERROR'));

CREATE INDEX IF NOT EXISTS idx_ai_positions_connection_status
  ON public.ai_positions (connection_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_trader_scenarios_h1_bar_once
  ON public.ai_trader_scenarios (ai_trader_id, h1_bar_time)
  WHERE h1_bar_time IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_positions_command_once
  ON public.ai_positions (execution_command_id)
  WHERE execution_command_id IS NOT NULL;

ALTER TABLE public.execution_commands
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_commands_idempotency_key
  ON public.execution_commands (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_outcomes_position_once
  ON public.trade_outcomes (ai_trader_id, broker_ticket)
  WHERE broker_ticket IS NOT NULL;

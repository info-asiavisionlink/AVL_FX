CREATE TABLE IF NOT EXISTS public.runtime_idempotency_claims (
  idempotency_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.runtime_idempotency_claims ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'runtime_idempotency_claims' AND policyname = 'runtime_idempotency_service_role') THEN
    CREATE POLICY "runtime_idempotency_service_role" ON public.runtime_idempotency_claims FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE public.ai_traders DROP CONSTRAINT IF EXISTS ai_traders_watcher_state_check;
ALTER TABLE public.ai_traders ADD CONSTRAINT ai_traders_watcher_state_check CHECK (watcher_state IN (
  'SLEEPING','WATCHING','TRIGGERED','ANALYZING','RISK_CHECK','EXECUTING','POSITION','REVIEWING','ERROR',
  'FLAT','WATCHING_ENTRY','ENTRY_RECHECK','ENTERING','WATCHING_POSITION','POSITION_REVIEW','CLOSING','CLOSED'
));

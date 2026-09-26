-- Stage 3: immutable metadata snapshot for each AI analysis.
ALTER TABLE public.ai_analysis_logs
  ADD COLUMN IF NOT EXISTS knowledge_snapshot JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_ai_analysis_logs_knowledge_snapshot
  ON public.ai_analysis_logs USING GIN (knowledge_snapshot);

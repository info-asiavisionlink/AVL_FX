-- =================================================================
-- 009_strategy_versions.sql
-- Strategy Version Management
--
-- Phase 3-C: AI Improvement Proposal → Apply → New Version → Backtest
--
-- 設計原則:
--   - 履歴を書き換えない（削除・上書き禁止）
--   - Rollback は新しい Version として作成
--   - AIはVersionを直接作成できない（Human Approval必須）
--   - backtest失敗でもVersionは保持する
-- =================================================================

CREATE TABLE IF NOT EXISTS public.strategy_versions (
  id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id     UUID          NOT NULL
                  REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  version         INTEGER       NOT NULL CHECK (version >= 1),

  -- 完全な StrategySpec スナップショット
  spec_snapshot   JSONB         NOT NULL,

  -- 作成者
  created_by      TEXT          NOT NULL
                  CHECK (created_by IN ('user', 'ai_improvement')),

  -- 派生元 Version 番号（初期は null）
  parent_version  INTEGER,

  -- このVersionに対応するImprovement（ai_improvementの場合のみ）
  improvement_id  UUID
                  REFERENCES public.strategy_improvements(id),

  -- このVersionに対してBacktestしたJobのうち最新
  best_job_id     UUID
                  REFERENCES public.backtest_jobs(id),

  -- 変更内容の要約（人間可読）
  change_summary  TEXT,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- 同一Strategy内でVersionは一意
  UNIQUE(strategy_id, version)
);

CREATE INDEX IF NOT EXISTS idx_strategy_versions_strategy
  ON public.strategy_versions (strategy_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_versions_improvement
  ON public.strategy_versions (improvement_id)
  WHERE improvement_id IS NOT NULL;

COMMENT ON TABLE public.strategy_versions IS
  'Phase 3-C: Strategy の完全な変更履歴。'
  'Version は削除・上書き禁止。Rollback は新しい Version として作成する。'
  'AIはVersionを直接作成できない（Apply/Restore は Human Action 必須）。';

COMMENT ON COLUMN public.strategy_versions.spec_snapshot IS
  '変更時点の StrategySpec 完全スナップショット（StrategySpecSchema 検証済み）。';

COMMENT ON COLUMN public.strategy_versions.best_job_id IS
  'このVersionに対する最新の COMPLETED Backtest Job。'
  'Backtest失敗でもVersionは保持される。';

COMMENT ON COLUMN public.strategy_versions.parent_version IS
  'Rollbackの場合: 元のVersion番号を記録。例: v4 = v1のRestore → parent_version = 1。';

-- ------------------------------------------------------------------
-- 既存 Strategy の初期 Version (v1) 自動生成
--
-- migration実行時に、v1が存在しないStrategyへ自動でv1を作成する。
-- 既存Strategyを破壊しない。
-- ------------------------------------------------------------------

INSERT INTO public.strategy_versions (
  strategy_id,
  version,
  spec_snapshot,
  created_by,
  change_summary,
  created_at
)
SELECT
  sr.id,
  1,
  jsonb_build_object(
    'name',             sr.name,
    'strategy_type',    sr.strategy_type,
    'description',      sr.description,
    'symbols',          sr.symbols,
    'timeframes',       sr.timeframes,
    'entry_conditions', sr.entry_conditions,
    'exit_conditions',  sr.exit_conditions,
    'filters',          sr.filters,
    'risk',             sr.risk
  ),
  'user',
  'Initial version (auto-migrated)',
  sr.created_at
FROM public.strategy_registry sr
WHERE NOT EXISTS (
  SELECT 1
  FROM public.strategy_versions sv
  WHERE sv.strategy_id = sr.id
)
ON CONFLICT (strategy_id, version) DO NOTHING;

-- RLS: Phase 3-C では service_role のみ書き込み可。READ は全ユーザー許可。

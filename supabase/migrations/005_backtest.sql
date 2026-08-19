-- =================================================================
-- 005_backtest.sql
-- Backtest Job / Result / Trade 永続化
--
-- Phase 2-D: Statistics & Persistence
-- Phase 2-C で生成された BacktestTrade[] を保存し、
-- BacktestReporter の統計結果を記録する。
-- =================================================================

-- ------------------------------------------------------------------
-- backtest_jobs — Backtest 実行ジョブ管理
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backtest_jobs (
  id             UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id    UUID          NOT NULL
                 REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  status         TEXT          NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),

  period_label   TEXT          NOT NULL DEFAULT 'AVAILABLE'
                 CHECK (period_label IN ('AVAILABLE', '1M', '3M', '6M', '1Y')),

  data_from      TIMESTAMPTZ,
  data_to        TIMESTAMPTZ,
  bar_count      INTEGER,

  progress_pct   NUMERIC(5, 2) DEFAULT 0,

  error_message  TEXT,

  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,

  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_jobs_strategy
  ON public.backtest_jobs (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backtest_jobs_status
  ON public.backtest_jobs (status, created_at DESC);

COMMENT ON TABLE public.backtest_jobs IS
  'Backtest 実行ジョブ。Phase 2-D は同期実行。将来は Railway Worker で非同期化可能。';

-- ------------------------------------------------------------------
-- backtest_results — Backtest 統計結果
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backtest_results (
  id             UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  job_id         UUID          NOT NULL
                 REFERENCES public.backtest_jobs(id) ON DELETE CASCADE,

  strategy_id    UUID          NOT NULL
                 REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  -- Period
  period_label   TEXT          NOT NULL,
  data_from      TIMESTAMPTZ,
  data_to        TIMESTAMPTZ,
  data_source    TEXT          NOT NULL DEFAULT 'bar_data',
  bar_count_used INTEGER,
  data_coverage_days NUMERIC(8, 2),

  -- Trade counts
  total_trades   INTEGER       NOT NULL DEFAULT 0,
  wins           INTEGER       NOT NULL DEFAULT 0,
  losses         INTEGER       NOT NULL DEFAULT 0,
  breakevens     INTEGER       NOT NULL DEFAULT 0,

  -- Win rate (%)
  win_rate       NUMERIC(6, 2) NOT NULL DEFAULT 0,

  -- Pips
  total_pips     NUMERIC(10, 2) NOT NULL DEFAULT 0,
  avg_pips       NUMERIC(8, 2)  NOT NULL DEFAULT 0,

  -- Money (account currency)
  gross_profit   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  gross_loss     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- NULL = infinite (no losing trades with profits present)
  profit_factor  NUMERIC(10, 4),

  -- Drawdown
  max_drawdown      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  max_drawdown_pct  NUMERIC(6, 2)  NOT NULL DEFAULT 0,
  max_drawdown_pips NUMERIC(10, 2) NOT NULL DEFAULT 0,

  -- Streaks
  max_cons_wins   INTEGER NOT NULL DEFAULT 0,
  max_cons_losses INTEGER NOT NULL DEFAULT 0,

  -- Duration
  avg_duration_min NUMERIC(8, 2) NOT NULL DEFAULT 0,

  -- Session breakdown (JSONB)
  session_stats  JSONB,
  best_session   TEXT,
  worst_session  TEXT,

  -- Quality signals
  sample_size_warning    BOOLEAN NOT NULL DEFAULT false,
  min_recommended_trades INTEGER NOT NULL DEFAULT 30,

  -- Verdict
  verdict        TEXT          NOT NULL
                 CHECK (verdict IN ('PASSED', 'CONDITIONAL', 'FAILED')),
  verdict_reason TEXT,

  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_results_job
  ON public.backtest_results (job_id);

CREATE INDEX IF NOT EXISTS idx_backtest_results_strategy
  ON public.backtest_results (strategy_id, created_at DESC);

COMMENT ON TABLE public.backtest_results IS
  'BacktestReporter が生成する統計サマリー。1 job に 1 result。';

COMMENT ON COLUMN public.backtest_results.profit_factor IS
  'NULL = infinite (grossProfit > 0 かつ grossLoss = 0)。Infinity / NaN を保存しない。';

-- ------------------------------------------------------------------
-- backtest_trades — 個別取引レコード
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backtest_trades (
  id             UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  job_id         UUID          NOT NULL
                 REFERENCES public.backtest_jobs(id) ON DELETE CASCADE,

  strategy_id    UUID          NOT NULL
                 REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  symbol         TEXT          NOT NULL,
  entry_tf       TEXT          NOT NULL,
  direction      TEXT          NOT NULL CHECK (direction IN ('BUY', 'SELL')),

  entry_time     TIMESTAMPTZ   NOT NULL,
  entry_price    NUMERIC(12, 5) NOT NULL,

  exit_time      TIMESTAMPTZ,
  exit_price     NUMERIC(12, 5),

  sl             NUMERIC(12, 5),
  tp             NUMERIC(12, 5),

  lot            NUMERIC(10, 4),
  pips           NUMERIC(10, 2),

  result         TEXT
                 CHECK (result IN ('WIN', 'LOSS', 'BREAKEVEN', 'END_OF_DATA')),

  exit_reason    TEXT
                 CHECK (exit_reason IN ('TP', 'SL', 'END_OF_DATA')),

  duration_min   NUMERIC(10, 2),

  session        TEXT,
  spread_pips    NUMERIC(8, 2),
  slippage_pips  NUMERIC(8, 2),

  entry_bar_idx  INTEGER,
  exit_bar_idx   INTEGER,

  -- 将来: indicator snapshot (Phase 2-E 以降)
  indicator_snapshot JSONB,

  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_trades_job
  ON public.backtest_trades (job_id, entry_time);

CREATE INDEX IF NOT EXISTS idx_backtest_trades_strategy
  ON public.backtest_trades (strategy_id, entry_time DESC);

COMMENT ON TABLE public.backtest_trades IS
  'Phase 2-C BacktestTrade[] を永続化。Batch INSERT (500件) で保存。';

-- ------------------------------------------------------------------
-- RLS: Phase 2 では service_role のみ書き込み可。
-- SELECT は全ユーザーに開放（strategy_registry と同方針）。
-- ------------------------------------------------------------------
-- Phase 2 では認証機能未実装のため RLS 無効のまま。
-- Phase 3 でユーザー認証導入時に有効化する。

-- =================================================================
-- 010_optimization.sql
-- Parameter Optimization Job / Candidate 永続化
--
-- Phase 4-A: Deterministic Parameter Optimization
--
-- 設計原則:
--   - BacktestEngine は変更せず既存 backtest_jobs を再利用しない
--     (optimization_candidates が独自のメトリクスを保持)
--   - 循環FK回避: optimization_jobs は optimization_candidates を参照しない
--     (ランク1の候補は optimization_candidates.rank = 1 で取得)
--   - OOS データを探索に使用した記録を残す:
--     in_sample_from / in_sample_to / out_sample_from / out_sample_to を保存
--   - 採用（APPLY）は必ずユーザーアクション経由:
--     optimization_candidates.adopted = true で記録
-- =================================================================

-- ------------------------------------------------------------------
-- optimization_jobs — Optimization 実行ジョブ管理
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.optimization_jobs (
  id                  UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id         UUID          NOT NULL
                      REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  status              TEXT          NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),

  -- Algorithm (Phase 4-A は GRID のみ)
  algorithm           TEXT          NOT NULL DEFAULT 'GRID'
                      CHECK (algorithm IN ('GRID')),

  -- 探索した Parameter Range の定義 (ParameterRange[])
  -- [{field, min, max, step, paramType}]
  parameter_ranges    JSONB         NOT NULL DEFAULT '[]',

  -- IS / OOS 分割設定
  in_sample_ratio     NUMERIC(4,2)  NOT NULL DEFAULT 0.80
                      CHECK (in_sample_ratio > 0 AND in_sample_ratio < 1),

  -- IS / OOS の実際の時系列範囲 (cutoffTime から逆算)
  in_sample_from      TIMESTAMPTZ,
  in_sample_to        TIMESTAMPTZ,    -- cutoffTime 直前 bar の時刻
  out_sample_from     TIMESTAMPTZ,    -- cutoffTime = 最初の OOS bar 開始時刻
  out_sample_to       TIMESTAMPTZ,

  -- Bar 数
  in_sample_bars      INTEGER,
  out_sample_bars     INTEGER,

  -- Grid 実行統計
  total_combinations  INTEGER,

  -- Summary (OptimizationSummary)
  -- {totalCombinations, stableZoneCount, robustCount, cutoffTime, inSampleRatio}
  summary             JSONB,

  -- Error
  error_message       TEXT,

  -- Timing
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_optimization_jobs_strategy
  ON public.optimization_jobs (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_optimization_jobs_status
  ON public.optimization_jobs (status, created_at DESC);

COMMENT ON TABLE public.optimization_jobs IS
  'Phase 4-A: Parameter Optimization の実行ジョブ。'
  'optimization_candidates への循環FKを避けるため、'
  'best_candidate_id カラムは持たない。Rank1 = best candidate。';

COMMENT ON COLUMN public.optimization_jobs.parameter_ranges IS
  'ParameterRange[] JSONB: [{field, min, max, step, paramType}]。'
  'Whitelist: entry_conditions.conditions[N].threshold/period, '
  'exit_conditions.stop_loss.multiplier/pips, '
  'exit_conditions.take_profit.rr_ratio/pips, '
  'filters.max_spread_pips, filters.min_adx のみ。';

COMMENT ON COLUMN public.optimization_jobs.in_sample_ratio IS
  'IS/OOS 分割比率 (例: 0.80 = 前80%がIS、後20%がOOS)。'
  'OOS は探索に使用しない。最終検証のみ。';

COMMENT ON COLUMN public.optimization_jobs.out_sample_from IS
  '最初の OOS バー開始時刻 (cutoffTime)。'
  'この値から IS/OOS 分割を再現可能。';

-- ------------------------------------------------------------------
-- optimization_candidates — 各 ParameterSet の評価結果
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.optimization_candidates (
  id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  job_id          UUID          NOT NULL
                  REFERENCES public.optimization_jobs(id) ON DELETE CASCADE,

  strategy_id     UUID          NOT NULL
                  REFERENCES public.strategy_registry(id),

  -- グリッド内のインデックス (0-based, 決定論的順序)
  grid_index      INTEGER       NOT NULL,

  -- このParameterSetが採用したランク (1 = best)
  rank            INTEGER,

  -- Parameter の組み合わせ (field → value)
  param_set       JSONB         NOT NULL,

  -- In-Sample メトリクス
  is_total_trades  INTEGER       NOT NULL DEFAULT 0,
  is_win_rate      NUMERIC(6,2)  NOT NULL DEFAULT 0,
  is_profit_factor NUMERIC(10,4),         -- NULL = infinite
  is_total_pips    NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_max_dd_pct    NUMERIC(6,2)  NOT NULL DEFAULT 0,

  -- Out-of-Sample メトリクス (最終検証、Optimization には使用しない)
  oos_total_trades  INTEGER       NOT NULL DEFAULT 0,
  oos_win_rate      NUMERIC(6,2)  NOT NULL DEFAULT 0,
  oos_profit_factor NUMERIC(10,4),        -- NULL = infinite
  oos_total_pips    NUMERIC(10,2) NOT NULL DEFAULT 0,
  oos_max_dd_pct    NUMERIC(6,2)  NOT NULL DEFAULT 0,

  -- 品質評価
  stability_score   NUMERIC(5,3)  NOT NULL DEFAULT 0,
  degradation_ratio NUMERIC(8,4),         -- NULL = IS pips = 0
  sample_status     TEXT          NOT NULL DEFAULT 'INSUFFICIENT'
                    CHECK (sample_status IN ('NORMAL', 'LOW_SAMPLE', 'INSUFFICIENT')),

  -- ユーザーによる採用フラグ (APPLY 押下時に true)
  adopted         BOOLEAN       NOT NULL DEFAULT false,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- 同一 job 内でグリッドインデックスは一意
  UNIQUE(job_id, grid_index)
);

CREATE INDEX IF NOT EXISTS idx_optimization_candidates_job
  ON public.optimization_candidates (job_id, rank NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_optimization_candidates_rank
  ON public.optimization_candidates (job_id, rank)
  WHERE rank IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_optimization_candidates_adopted
  ON public.optimization_candidates (strategy_id, adopted)
  WHERE adopted = true;

COMMENT ON TABLE public.optimization_candidates IS
  'Phase 4-A: Optimization Grid の各候補の評価結果。'
  'IS メトリクスは Optimization の Ranking に使用。'
  'OOS メトリクスは最終検証のみに使用し、探索には使用しない。'
  'adopted=true はユーザーによる明示的な APPLY 操作が必要。';

COMMENT ON COLUMN public.optimization_candidates.grid_index IS
  'generateGrid() の出力順序に対応する 0-based インデックス。'
  '同一入力から同一順序が保証される (deterministic)。';

COMMENT ON COLUMN public.optimization_candidates.sample_status IS
  'OOS trade 数に基づくサンプル品質分類:'
  '  NORMAL:       OOS trades >= 30'
  '  LOW_SAMPLE:   OOS trades 15-29'
  '  INSUFFICIENT: OOS trades < 15  → Rank 上位に自動昇格させない';

COMMENT ON COLUMN public.optimization_candidates.stability_score IS
  '近傍 Parameter の IS パフォーマンス安定性 (0.0-1.0)。'
  '他の Parameter を固定した各次元で評価し平均。'
  '>= 0.6 を "安定ゾーン" とする。';

COMMENT ON COLUMN public.optimization_candidates.degradation_ratio IS
  'OOS totalPips / IS totalPips。'
  'NULL = IS pips がゼロ。'
  '1.0 = IS と OOS で同等、0.5 = OOS は IS の半分、負値 = OOS 損失。';

-- RLS: Phase 4-A では service_role のみ書き込み可。READ は全ユーザー許可。

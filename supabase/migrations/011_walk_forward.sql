-- =================================================================
-- 011_walk_forward.sql
-- Walk Forward Validation Job 永続化
--
-- Phase 4-B: Walk Forward Validation
--
-- 設計原則:
--   - walk_forward_jobs 1テーブルのみ (windows JSONB)
--   - optimization_jobsを参照しない (parameterRangesを直接持つ)
--   - 自動採用禁止: verdictがROBUSTでもUser Approvalが必要
--   - Data Leakage防止の記録:
--     windows JSONBに各WindowのTRAIN境界を保存
--     in_sample_ratio (TRAIN内IS/OOS比率) を保存
-- =================================================================

CREATE TABLE IF NOT EXISTS public.walk_forward_jobs (
  id                    UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id           UUID          NOT NULL
                        REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  -- 探索 Parameter Range (OptimizationEngineのParameterRange[])
  parameter_ranges      JSONB         NOT NULL DEFAULT '[]',

  -- Walk Forward 設定
  train_months          INTEGER       NOT NULL CHECK (train_months BETWEEN 1 AND 24),
  test_months           INTEGER       NOT NULL CHECK (test_months  BETWEEN 1 AND 12),
  step_months           INTEGER       NOT NULL CHECK (step_months  BETWEEN 1 AND 12),

  -- TRAIN内 IS/OOS 分割比率 (Phase 4-Aと同じ default=0.80)
  in_sample_ratio       NUMERIC(4,2)  NOT NULL DEFAULT 0.80
                        CHECK (in_sample_ratio > 0 AND in_sample_ratio < 1),

  -- 実行状態
  status                TEXT          NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),

  -- データ実際の期間
  data_from             TIMESTAMPTZ,
  data_to               TIMESTAMPTZ,

  -- Window数
  window_count          INTEGER       NOT NULL DEFAULT 0,

  -- 全Window詳細 (WalkForwardWindowResult[])
  -- [{windowIndex, trainFrom, trainTo, testFrom, testTo,
  --   bestParamSet, trainOOSRank1OK,
  --   trainISMetrics, trainOOSMetrics, testMetrics,
  --   trainBarsCount, testBarsCount, warmupUsed,
  --   sampleStatus, trainOOSStatus, windowPassed, skipped}]
  windows               JSONB,

  -- 集計結果
  consistency_score     NUMERIC(5,3),              -- NULL = INCONCLUSIVE
  parameter_stability   JSONB,                      -- {field: 0.0-1.0}
  recommended_params    JSONB,                      -- ParameterSet | null
  -- UIでの "RSI=29 (3/5 windows)" 表示用
  recommended_param_freq JSONB,                     -- {field: [{value, windowCount}[]]}

  -- Window分類カウント
  valid_window_count    INTEGER       NOT NULL DEFAULT 0,
  normal_window_count   INTEGER       NOT NULL DEFAULT 0,
  positive_window_count INTEGER       NOT NULL DEFAULT 0,
  skipped_window_count  INTEGER       NOT NULL DEFAULT 0,

  -- Verdict
  verdict               TEXT
                        CHECK (verdict IN ('ROBUST', 'CONDITIONAL', 'OVERFIT', 'INCONCLUSIVE')),

  -- エラー
  error_message         TEXT,

  -- タイミング
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_walk_forward_jobs_strategy
  ON public.walk_forward_jobs (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_walk_forward_jobs_status
  ON public.walk_forward_jobs (status, created_at DESC);

COMMENT ON TABLE public.walk_forward_jobs IS
  'Phase 4-B: Walk Forward Validation 実行ジョブ。'
  '各WindowのTRAIN/TEST境界とメトリクスをwindows JSONBに保存。'
  '子Tableは不要 (最大30 windows × ~800bytes = ~24KB)。'
  'verdictがROBUSTでも自動Version作成しない。User Approvalが必須。';

COMMENT ON COLUMN public.walk_forward_jobs.parameter_ranges IS
  'OptimizationEngineのParameterRange[] JSONB。'
  'Walk ForwardはOptimization Jobを参照せず自分でparameterRangesを持つ。'
  'Walk Forward専用上限: WF_MAX_COMBINATIONS=200 (Phase 4-Aの5000より厳格)。';

COMMENT ON COLUMN public.walk_forward_jobs.in_sample_ratio IS
  'TRAIN期間内のIS/OOS分割比率 (0.8 = 前80%がIS)。'
  'Phase 4-AのrankCandidates()基準と同一: TRAIN-OOS(後20%)でRanking。';

COMMENT ON COLUMN public.walk_forward_jobs.windows IS
  'WalkForwardWindowResult[] JSONB。'
  '各Windowのbest candidate、TRAIN IS/OOS/TEST metrics、sampleStatus等を含む。'
  'skipped=true = TRAIN-OOS INSUFFICIENT → TESTをスキップ (IS Fallback禁止)。';

COMMENT ON COLUMN public.walk_forward_jobs.consistency_score IS
  '有効Window(非skip, TEST!=INSUFFICIENT)のうちwindowPassed=trueの加重割合。'
  '重み: NORMAL=1.0, LOW_SAMPLE=0.5。'
  'NULL = 有効Windowなし (全INCONCLUSIVE)。';

COMMENT ON COLUMN public.walk_forward_jobs.recommended_params IS
  '各fieldのMode値(最頻値)の組み合わせ。'
  'GridはCartesian Productなのでこの組み合わせは常にGrid内に存在する。'
  'ただしどこかのWindowのbestParamSetとは限らない。';

COMMENT ON COLUMN public.walk_forward_jobs.verdict IS
  'ROBUST:      consistencyScore>=0.7 AND paramStabilityAvg>=0.7 AND validWindows>=3 AND normalWindows>=1'
  'CONDITIONAL: consistencyScore>=0.5 AND validWindows>=2'
  'OVERFIT:     consistencyScore<0.5 AND validWindows>=2'
  'INCONCLUSIVE: データ不足 (validWindows<2 or consistencyScore=null)';

-- RLS: Phase 4-B では service_role のみ書き込み可。READ は全ユーザー許可。

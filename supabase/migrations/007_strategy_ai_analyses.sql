-- =================================================================
-- 007_strategy_ai_analyses.sql
-- AI Analysis of Backtest Results
--
-- Phase 3-A: Backtest 結果を OpenAI で分析し、
-- Facts / Observations / Hypotheses / Weaknesses / Strengths /
-- Session Analysis / Risk Analysis / Recommendations を保存。
--
-- 設計原則:
--   - strategy_registry / backtest_jobs には手を加えない
--   - facts は JSONB 配列（statement / source / value）
--   - input_snapshot に AI に渡したコンテキストを完全記録
--   - version カラムで将来の再分析に備える
-- =================================================================

CREATE TABLE IF NOT EXISTS public.strategy_ai_analyses (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id      UUID          NOT NULL
                   REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  job_id           UUID          NOT NULL
                   REFERENCES public.backtest_jobs(id) ON DELETE CASCADE,

  -- 再分析ごとに +1 (同一 job_id で複数バージョンを許容)
  version          INTEGER       NOT NULL DEFAULT 1,

  -- AI に渡した統計コンテキスト全体を保存（再現性・監査用）
  input_snapshot   JSONB         NOT NULL DEFAULT '{}',

  -- 使用モデル名
  model            TEXT          NOT NULL,

  -- 総括文 (1-3 sentences)
  summary          TEXT          NOT NULL DEFAULT '',

  -- FACT: Backtestデータから直接確認できる事実
  -- [{statement: string, source: string, value: string|number|null}]
  facts            JSONB         NOT NULL DEFAULT '[]',

  -- OBSERVATION: FACTから観察されるパターン
  -- [{observation: string, basis: string, confidence: "HIGH"|"MEDIUM"|"LOW"}]
  observations     JSONB         NOT NULL DEFAULT '[]',

  -- HYPOTHESIS: 原因の仮説（確定ではない）
  -- [{hypothesis: string, rationale: string, confidence: "HIGH"|"MEDIUM"|"LOW"}]
  hypotheses       JSONB         NOT NULL DEFAULT '[]',

  -- WEAKNESS: 弱点
  -- [{point: string, detail: string|null}]
  weaknesses       JSONB         NOT NULL DEFAULT '[]',

  -- STRENGTH: 強み
  -- [{point: string, detail: string|null}]
  strengths        JSONB         NOT NULL DEFAULT '[]',

  -- SESSION ANALYSIS: セッション別分析
  -- [{session: string, observation: string, recommendation: string|null}]
  session_analysis JSONB         NOT NULL DEFAULT '[]',

  -- RISK ANALYSIS: リスク評価
  -- {drawdown_assessment, sl_tp_assessment, consistency_assessment, overall}
  risk_analysis    JSONB         NOT NULL DEFAULT '{}',

  -- RECOMMENDATION: 改善提案
  -- [{action: string, rationale: string|null, priority: "HIGH"|"MEDIUM"|"LOW"}]
  recommendations  JSONB         NOT NULL DEFAULT '[]',

  -- AI の自己評価 (0-100)
  confidence       NUMERIC(5, 2) NOT NULL DEFAULT 0
                   CHECK (confidence BETWEEN 0 AND 100),

  -- データ品質注記
  data_quality_note TEXT         NOT NULL DEFAULT '',

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- 1 Strategy の分析履歴を作成日時降順で取得
CREATE INDEX IF NOT EXISTS idx_strategy_ai_analyses_strategy
  ON public.strategy_ai_analyses (strategy_id, created_at DESC);

-- job_id から分析を逆引き
CREATE INDEX IF NOT EXISTS idx_strategy_ai_analyses_job
  ON public.strategy_ai_analyses (job_id);

COMMENT ON TABLE public.strategy_ai_analyses IS
  'Phase 3-A: Backtest 結果の AI 分析記録。'
  '同一 job_id でも再分析を許容（version で管理）。'
  'Strategy Spec 変更・Improvement は Phase 3-B 以降。';

COMMENT ON COLUMN public.strategy_ai_analyses.input_snapshot IS
  'AI に渡した統計コンテキスト全体。再現性・Fact Integrity 検証用。';

COMMENT ON COLUMN public.strategy_ai_analyses.facts IS
  'JSONB 配列。{statement: string, source: string, value: string|number|null}[]'
  'Backtestデータから直接確認できる事実のみ。数値はinput_snapshotと照合済み。';

COMMENT ON COLUMN public.strategy_ai_analyses.hypotheses IS
  '確定原因ではなく仮説。confidence="HIGH" でも確定ではない。Phase 3-B の改善提案の起点。';

COMMENT ON COLUMN public.strategy_ai_analyses.version IS
  '同一 job_id に対する再分析カウント。INSERT 前に MAX(version)+1 で採番。';

-- RLS: Phase 3-A では service_role のみ書き込み可。READ は全ユーザー許可。
-- Phase 3 でユーザー認証導入時に有効化する。

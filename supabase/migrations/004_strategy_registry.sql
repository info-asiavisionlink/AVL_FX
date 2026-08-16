-- =================================================================
-- 004_strategy_registry.sql
-- AI EA Builder — Strategy Registry
--
-- Phase 1: 自然言語 → Strategy Specification → 保存
-- Phase 2 以降でバックテスト結果・Executor EA 連携を追加予定
-- =================================================================

CREATE TABLE IF NOT EXISTS public.strategy_registry (
  id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT          NOT NULL CHECK (length(name) BETWEEN 3 AND 50),
  strategy_type   TEXT          NOT NULL CHECK (strategy_type IN ('SCALPING', 'DAY_TRADE', 'SWING')),
  description     TEXT,
  symbols         TEXT[]        NOT NULL DEFAULT '{}',
  timeframes      TEXT[]        NOT NULL DEFAULT '{}',
  entry_conditions JSONB        NOT NULL DEFAULT '{}',
  exit_conditions  JSONB        DEFAULT NULL,
  filters          JSONB        DEFAULT NULL,
  risk             JSONB        NOT NULL DEFAULT '{"risk_per_trade": 0.25}',

  -- MT5 Executor EA 連携用 (Phase 3 で使用)
  magic_number    INTEGER       UNIQUE,

  -- ライフサイクル
  enabled         BOOLEAN       NOT NULL DEFAULT false,
  status          TEXT          NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED')),
  backtest_status TEXT          NOT NULL DEFAULT 'NOT_TESTED'
                  CHECK (backtest_status IN ('NOT_TESTED', 'TESTING', 'PASSED', 'FAILED')),

  -- AI 評価 (Phase 2 で使用)
  ai_score        INTEGER       CHECK (ai_score BETWEEN 0 AND 100),
  ai_verdict      TEXT,

  -- プロンプト原文（デバッグ・再生成用）
  raw_prompt      TEXT,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_strategy_registry_type
  ON public.strategy_registry (strategy_type);

CREATE INDEX IF NOT EXISTS idx_strategy_registry_status
  ON public.strategy_registry (status, enabled);

CREATE INDEX IF NOT EXISTS idx_strategy_registry_created
  ON public.strategy_registry (created_at DESC);

-- updated_at 自動更新（トリガー不使用: API 側で管理）

-- コメント
COMMENT ON TABLE public.strategy_registry IS
  'AI EA Builder で生成・保存された EA Strategy の登録テーブル。'
  'Phase 1: DRAFT / NOT_TESTED 状態で保存のみ。'
  'Phase 2: backtest_results テーブルと連携。'
  'Phase 3: MT5 Executor EA + magic_number で連携。';

COMMENT ON COLUMN public.strategy_registry.magic_number IS
  'MT5 EA の MagicNumber。20001 から連番。Phase 3 で Executor EA が参照する。';

COMMENT ON COLUMN public.strategy_registry.raw_prompt IS
  'ユーザーが入力した自然言語プロンプトの原文。再生成・デバッグ用。';

-- RLS 無効（認証済みユーザーが自分のStrategyを管理する設計は Phase 3 以降）
-- Phase 1 では RLS なしで全ユーザーが読み書き可能

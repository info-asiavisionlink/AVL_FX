-- =================================================================
-- 008_strategy_improvements.sql
-- AI Strategy Improvement Proposals
--
-- Phase 3-B: Phase 3-A の AI Analysis を元に
-- 変更提案（Proposal）を生成・保存する。
--
-- 設計原則:
--   - AI は proposed_spec を直接生成しない
--   - Changes → Whitelist → from値検証 → Server-side Patch の経路のみ
--   - Phase 3-B では Apply 機能なし (status='PROPOSED' のみ)
--   - Phase 3-C で APPLIED / REJECTED への更新と Version 管理を追加
-- =================================================================

CREATE TABLE IF NOT EXISTS public.strategy_improvements (
  id               UUID          DEFAULT gen_random_uuid() PRIMARY KEY,

  strategy_id      UUID          NOT NULL
                   REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  analysis_id      UUID          NOT NULL
                   REFERENCES public.strategy_ai_analyses(id),

  -- 改善対象のStrategy版 (Phase 3-C でバージョン管理導入まで常に1)
  from_version     INTEGER       NOT NULL DEFAULT 1,

  -- ChangeItem[] — 最大3件
  -- [{field, type, from, to, reason, confidence, fact_basis}]
  changes          JSONB         NOT NULL DEFAULT '[]',

  -- 期待効果
  -- {hypothesis: string, metric_targets: {win_rate?, profit_factor?, total_pips?, max_drawdown_pct?}}
  expected_effects JSONB         NOT NULL DEFAULT '{}',

  -- リスク文字列配列
  risks            JSONB         NOT NULL DEFAULT '[]',

  -- Server-side Patch で生成した変更後の完全 StrategySpec
  -- AIは直接生成しない
  proposed_spec    JSONB         NOT NULL,

  -- AI 自己評価 (0-100)
  confidence       NUMERIC(5,2)  NOT NULL DEFAULT 0
                   CHECK (confidence BETWEEN 0 AND 100),

  -- サンプル不足フラグ (Phase 3-A の sampleSizeWarning から連動)
  requires_more_data BOOLEAN     NOT NULL DEFAULT false,

  -- PROPOSED / APPLIED / REJECTED
  -- Phase 3-B では PROPOSED のみ使用
  -- APPLIED: Phase 3-C で strategy_registry を更新し Version を生成した場合
  -- REJECTED: ユーザーが明示的に棄却した場合
  status           TEXT          NOT NULL DEFAULT 'PROPOSED'
                   CHECK (status IN ('PROPOSED', 'APPLIED', 'REJECTED')),

  -- 使用モデル名
  model            TEXT          NOT NULL,

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Strategy の改善提案履歴を新しい順に取得
CREATE INDEX IF NOT EXISTS idx_strategy_improvements_strategy
  ON public.strategy_improvements (strategy_id, created_at DESC);

-- analysis_id から逆引き（Phase 3-C での追跡用）
CREATE INDEX IF NOT EXISTS idx_strategy_improvements_analysis
  ON public.strategy_improvements (analysis_id);

-- PROPOSED 状態の提案を素早く取得
CREATE INDEX IF NOT EXISTS idx_strategy_improvements_status
  ON public.strategy_improvements (status, created_at DESC);

COMMENT ON TABLE public.strategy_improvements IS
  'Phase 3-B: AI Backtest Analysis を元にした Strategy 改善提案。'
  'AIが直接 proposed_spec を生成することは禁止。'
  'Changes → Whitelist → from値検証 → Server-side Patch の経路のみ。'
  'Apply処理は Phase 3-C で実装。';

COMMENT ON COLUMN public.strategy_improvements.changes IS
  'ChangeItem[] JSONB。'
  '[{field, type:"modify"|"add", from, to, reason, confidence:0-1, fact_basis}]。'
  '最大3件。add_condition は最大1件。';

COMMENT ON COLUMN public.strategy_improvements.proposed_spec IS
  'Current StrategySpec に changes を Server-side Patch で適用した結果。'
  'StrategySpecSchema で再バリデーション済み。AIによる自由生成ではない。';

COMMENT ON COLUMN public.strategy_improvements.from_version IS
  'Phase 3-C で strategy_versions テーブル導入後に使用。現在は常に1。';

-- RLS: Phase 3-B では service_role のみ書き込み可。READ は全ユーザー許可。

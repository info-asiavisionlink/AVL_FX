-- =================================================================
-- 019: Strategy Runtime State
--
-- strategy_registry.status との責務分離:
--
--   strategy_registry.status:
--     Strategy lifecycle（DRAFT/ACTIVE/PAUSED/ARCHIVED）
--     ユーザーが意図的に設定する状態
--
--   strategy_runtime_state.runtime_status:
--     現在のLive execution状態（STOPPED/RUNNING/ERROR等）
--     Runtime Engineが自動的に更新する状態
--
-- Strategyが ACTIVE でも Runtime が STOPPED の状態はありえる。
-- （例: 接続切れ、EAクラッシュ、manual pause）
-- =================================================================

CREATE TABLE IF NOT EXISTS public.strategy_runtime_state (
  -- strategyごとに1行（PK = strategy_id）
  strategy_id           UUID          PRIMARY KEY
                        REFERENCES public.strategy_registry(id) ON DELETE CASCADE,

  -- どのMT5接続で動作しているか
  connection_id         UUID          REFERENCES public.mt5_connections(id) ON DELETE SET NULL,

  -- Runtime状態
  runtime_status        TEXT          NOT NULL DEFAULT 'STOPPED'
                        CHECK (runtime_status IN (
                          'STOPPED',    -- 停止中
                          'STARTING',   -- 起動処理中
                          'RUNNING',    -- 稼働中（Signalを生成できる状態）
                          'PAUSING',    -- 停止処理中
                          'PAUSED',     -- 一時停止（新規Signalを生成しない）
                          'ERROR'       -- エラーで停止
                        )),

  -- タイムスタンプ
  started_at            TIMESTAMPTZ,
  stopped_at            TIMESTAMPTZ,
  last_evaluated_at     TIMESTAMPTZ,  -- 最後にStrategyEvaluatorを実行した時刻
  last_signal_at        TIMESTAMPTZ,  -- 最後にSignalを生成した時刻
  last_bar_time         TIMESTAMPTZ,  -- 最後に処理したBarの時刻

  -- エラー情報
  last_error            TEXT,

  -- Runtime Version（設定変更時にインクリメント）
  runtime_version       INTEGER       NOT NULL DEFAULT 1,

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_state_connection_id
  ON public.strategy_runtime_state (connection_id);

CREATE INDEX IF NOT EXISTS idx_strategy_runtime_state_runtime_status
  ON public.strategy_runtime_state (runtime_status);

-- RLS
ALTER TABLE public.strategy_runtime_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "strategy_runtime_state_select_own"
  ON public.strategy_runtime_state FOR SELECT
  TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM public.strategy_registry WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "strategy_runtime_state_service_role"
  ON public.strategy_runtime_state FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.strategy_runtime_state IS
  'Strategy Runtimeの現在の実行状態。strategy_registry.statusとは分離。'
  'Runtime Engineが自動更新。Strategy ACTIVE ≠ Runtime RUNNING。';
